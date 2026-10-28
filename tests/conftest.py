"""Fixtures for tests that run against real Postgres + pgvector (needs `make up`).

Redis is fakeredis; the worker runs in-process via Env.drain().
"""

import asyncio
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import fakeredis
import httpx
import pytest
from helpers import FakeEmbedder, make_pdf
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import deps
from app.config import Settings
from app.db.session import make_sessionmaker
from app.main import create_app
from app.models import ApiKey, Tenant
from app.worker import IngestWorker

ROOT = Path(__file__).resolve().parents[1]
TEST_DB = os.environ.get("TEST_DATABASE_URL", "postgresql+asyncpg://atlas:atlas@127.0.0.1:5433/atlas_test")


@pytest.fixture(scope="session")
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
        pytest.skip(f"needs Postgres at {TEST_DB} (run `make up`): {e}")
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=ROOT,
        env={**os.environ, "DATABASE_URL": TEST_DB},
        check=True,
        capture_output=True,
    )


@dataclass
class Env:
    client: httpx.AsyncClient
    sessions: async_sessionmaker
    redis: fakeredis.FakeAsyncRedis
    settings: Settings
    keys: dict[str, str]

    def as_tenant(self, name: str) -> dict:
        return {"X-API-Key": self.keys[name]}

    def worker(self, name: str = "test-worker", embedder=None) -> IngestWorker:
        return IngestWorker(self.settings, self.redis, self.sessions, embedder or FakeEmbedder(), name=name)

    async def upload(self, tenant: str, name: str, pages: list[str] | None = None, data: bytes = b""):
        body = data or make_pdf(pages or [])
        return await self.client.post(
            "/documents", headers=self.as_tenant(tenant), files={"file": (name, body, "application/pdf")}
        )

    async def drain(self, worker: IngestWorker | None = None) -> None:
        """Run a worker until the stream has nothing left for it."""
        worker = worker or self.worker()
        await worker.ensure_group()
        while await worker.step(sweep=True, block_ms=None):
            pass

    async def pending(self) -> int:
        return (await self.redis.xpending(self.settings.stream_key, self.settings.stream_group))["pending"]


@pytest.fixture
async def env(database):
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

    settings = Settings(worker_reclaim_min_idle_ms=0)
    redis = fakeredis.FakeAsyncRedis(decode_responses=True)
    app = create_app()  # no lifespan under ASGITransport: wire state by hand
    app.state.settings = settings
    app.state.engine = engine
    app.state.sessionmaker = sessions
    app.state.embedder = FakeEmbedder()
    app.state.redis = redis
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as client:
        yield Env(client, sessions, redis, settings, keys)
    await engine.dispose()
