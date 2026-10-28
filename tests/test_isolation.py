"""Tenant isolation against real Postgres + pgvector (needs `make up`).

The embedder is a fake that maps identical text to identical vectors, so a
query equal to a chunk's text is that chunk's exact nearest neighbour. Tenant
B holds that chunk; tenant A must still never see it.
"""

import asyncio
import hashlib
import math
import os
import random
import subprocess
import sys
from pathlib import Path

import fakeredis
import httpx
import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import create_async_engine

from app.api import deps
from app.db.session import make_sessionmaker
from app.main import create_app
from app.models import EMBEDDING_DIM, ApiKey, Chunk, Tenant

ROOT = Path(__file__).resolve().parents[1]
TEST_DB = os.environ.get("TEST_DATABASE_URL", "postgresql+asyncpg://atlas:atlas@127.0.0.1:5433/atlas_test")


class FakeEmbedder:
    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self.embed_query(t) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        rng = random.Random(hashlib.sha256(text.encode()).digest())
        v = [rng.gauss(0, 1) for _ in range(EMBEDDING_DIM)]
        norm = math.sqrt(sum(x * x for x in v))
        return [x / norm for x in v]


def make_pdf(pages: list[str]) -> bytes:
    """A minimal valid PDF, one line of Helvetica text per page."""
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for line in pages:
        esc = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        stream = f"BT /F1 12 Tf 72 720 Td ({esc}) Tj ET"
        objs.append(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")
        objs.append(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {len(objs)} 0 R >>"
        )
        kids.append(f"{len(objs)} 0 R")
    objs[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(kids)} >>"
    out, offsets = b"%PDF-1.4\n", []
    for i, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{obj}\nendobj\n".encode()
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{off:010d} 00000 n \n".encode() for off in offsets)
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out


@pytest.fixture(scope="module", autouse=True)
def database():
    async def create_test_db():
        admin = create_async_engine(TEST_DB.rsplit("/", 1)[0] + "/atlas", isolation_level="AUTOCOMMIT")
        try:
            async with admin.connect() as conn:
                if not await conn.scalar(text("SELECT 1 FROM pg_database WHERE datname = 'atlas_test'")):
                    await conn.execute(text("CREATE DATABASE atlas_test"))
        finally:
            await admin.dispose()

    try:
        asyncio.run(create_test_db())
    except OSError as e:
        pytest.skip(f"isolation tests need Postgres at {TEST_DB} (run `make up`): {e}")
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=ROOT,
        env={**os.environ, "DATABASE_URL": TEST_DB},
        check=True,
        capture_output=True,
    )


@pytest.fixture
async def env():
    engine = create_async_engine(TEST_DB)
    sessions = make_sessionmaker(engine)
    async with engine.begin() as conn:
        await conn.execute(text("TRUNCATE tenants RESTART IDENTITY CASCADE"))
    deps._KEY_CACHE.clear()  # ids restart, so cached key -> tenant mappings would be stale
    keys = {}
    async with sessions() as session:
        for name in ("a", "b"):
            tenant = Tenant(name=name)
            session.add(tenant)
            await session.flush()
            keys[name] = f"key-{name}"
            session.add(ApiKey(tenant_id=tenant.id, key_hash=deps.hash_key(keys[name]), name="test"))
        await session.commit()

    app = create_app()  # no lifespan under ASGITransport: wire state by hand
    app.state.engine = engine
    app.state.sessionmaker = sessions
    app.state.embedder = FakeEmbedder()
    app.state.redis = fakeredis.FakeAsyncRedis()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as client:

        def as_tenant(name: str) -> dict:
            return {"X-API-Key": keys[name]}

        yield client, as_tenant, sessions
    await engine.dispose()


async def upload(client, headers, name: str, pages: list[str]) -> httpx.Response:
    return await client.post(
        "/documents", headers=headers, files={"file": (name, make_pdf(pages), "application/pdf")}
    )


ALPHA = "Alpha budget report for the river restoration project."
ZEBRA = "Zebra migration patterns across the Serengeti in the dry season."


async def test_search_never_returns_another_tenants_chunks(env):
    client, as_tenant, _ = env
    assert (await upload(client, as_tenant("a"), "alpha.pdf", [ALPHA])).status_code == 201
    assert (await upload(client, as_tenant("b"), "zebra.pdf", [ZEBRA])).status_code == 201

    # sanity: this query is an exact match for B's chunk
    hits = (await client.post("/search", headers=as_tenant("b"), json={"query": ZEBRA})).json()
    assert hits[0]["document"] == "zebra.pdf" and hits[0]["score"] > 0.99

    hits = (await client.post("/search", headers=as_tenant("a"), json={"query": ZEBRA, "k": 20})).json()
    assert hits, "A should still get its own chunks back"
    assert {h["document"] for h in hits} == {"alpha.pdf"}
    assert all(ZEBRA not in h["text"] for h in hits)


async def test_listing_and_deleting_are_tenant_scoped(env):
    client, as_tenant, _ = env
    doc = (await upload(client, as_tenant("a"), "alpha.pdf", [ALPHA])).json()

    assert (await client.get("/documents", headers=as_tenant("b"))).json() == []
    assert (await client.delete(f"/documents/{doc['id']}", headers=as_tenant("b"))).status_code == 404
    assert [d["id"] for d in (await client.get("/documents", headers=as_tenant("a"))).json()] == [doc["id"]]

    assert (await client.delete(f"/documents/{doc['id']}", headers=as_tenant("a"))).status_code == 204
    assert (await client.get("/documents", headers=as_tenant("a"))).json() == []


async def test_unknown_or_missing_key_is_rejected(env):
    client, _, _ = env
    assert (await client.get("/documents", headers={"X-API-Key": "nope"})).status_code == 401
    assert (await client.post("/search", json={"query": "x"})).status_code == 422


async def test_reupload_is_idempotent_and_replaces_on_change(env):
    client, as_tenant, sessions = env
    first = await upload(client, as_tenant("a"), "report.pdf", [ALPHA, "Page two of the report."])
    assert first.status_code == 201 and first.json()["pages"] == 2

    same = await upload(client, as_tenant("a"), "report.pdf", [ALPHA, "Page two of the report."])
    assert same.status_code == 200 and same.json()["id"] == first.json()["id"]

    changed = await upload(client, as_tenant("a"), "report.pdf", ["A revised single page."])
    assert changed.status_code == 201 and changed.json()["id"] != first.json()["id"]
    async with sessions() as session:
        texts = (await session.execute(select(Chunk.text))).scalars().all()
        assert texts == ["A revised single page."]  # old version's chunks went with it
        assert await session.scalar(select(func.count()).select_from(Chunk)) == 1


async def test_rejects_non_pdf_and_unreadable_pdf(env):
    client, as_tenant, _ = env
    r = await client.post(
        "/documents", headers=as_tenant("a"), files={"file": ("notes.txt", b"hi", "text/plain")}
    )
    assert r.status_code == 400
    r = await client.post(
        "/documents", headers=as_tenant("a"), files={"file": ("broken.pdf", b"not a pdf", "application/pdf")}
    )
    assert r.status_code == 422
