"""Tenant isolation, end to end through the API and the worker.

Tenant B holds a chunk that is the exact nearest neighbour of the query (see
FakeEmbedder); tenant A must still never see it.
"""

from sqlalchemy import func, select

from app.models import Chunk

ALPHA = "Alpha budget report for the river restoration project."
ZEBRA = "Zebra migration patterns across the Serengeti in the dry season."


async def test_search_never_returns_another_tenants_chunks(env):
    assert (await env.upload("a", "alpha.pdf", [ALPHA])).status_code == 202
    assert (await env.upload("b", "zebra.pdf", [ZEBRA])).status_code == 202
    await env.drain()

    # sanity: this query is an exact match for B's chunk
    hits = (await env.client.post("/search", headers=env.as_tenant("b"), json={"query": ZEBRA})).json()
    assert hits[0]["document"] == "zebra.pdf" and hits[0]["score"] > 0.99

    hits = (
        await env.client.post("/search", headers=env.as_tenant("a"), json={"query": ZEBRA, "k": 20})
    ).json()
    assert hits, "A should still get its own chunks back"
    assert {h["document"] for h in hits} == {"alpha.pdf"}
    assert all(ZEBRA not in h["text"] for h in hits)


async def test_listing_getting_and_deleting_are_tenant_scoped(env):
    doc = (await env.upload("a", "alpha.pdf", [ALPHA])).json()
    await env.drain()

    assert (await env.client.get("/documents", headers=env.as_tenant("b"))).json() == []
    assert (await env.client.get(f"/documents/{doc['id']}", headers=env.as_tenant("b"))).status_code == 404
    assert (await env.client.delete(f"/documents/{doc['id']}", headers=env.as_tenant("b"))).status_code == 404
    got = (await env.client.get(f"/documents/{doc['id']}", headers=env.as_tenant("a"))).json()
    assert got["status"] == "ready" and got["chunk_count"] == 1

    assert (await env.client.delete(f"/documents/{doc['id']}", headers=env.as_tenant("a"))).status_code == 204
    assert (await env.client.get("/documents", headers=env.as_tenant("a"))).json() == []


async def test_unknown_or_missing_key_is_rejected(env):
    assert (await env.client.get("/documents", headers={"X-API-Key": "nope"})).status_code == 401
    assert (await env.client.post("/search", json={"query": "x"})).status_code == 422


async def test_reupload_is_idempotent_and_replaces_on_change(env):
    first = await env.upload("a", "report.pdf", [ALPHA, "Page two of the report."])
    assert first.status_code == 202
    same_while_pending = await env.upload("a", "report.pdf", [ALPHA, "Page two of the report."])
    assert same_while_pending.status_code == 200 and same_while_pending.json()["id"] == first.json()["id"]
    await env.drain()
    same = await env.upload("a", "report.pdf", [ALPHA, "Page two of the report."])
    assert same.status_code == 200 and same.json()["pages"] == 2

    changed = await env.upload("a", "report.pdf", ["A revised single page."])
    assert changed.status_code == 202 and changed.json()["id"] != first.json()["id"]

    # until the new version is ready, the old one is still listed and searchable
    listed = (await env.client.get("/documents", headers=env.as_tenant("a"))).json()
    assert [d["status"] for d in listed] == ["ready", "pending"]
    hits = (await env.client.post("/search", headers=env.as_tenant("a"), json={"query": ALPHA})).json()
    assert hits[0]["text"] == ALPHA

    await env.drain()
    listed = (await env.client.get("/documents", headers=env.as_tenant("a"))).json()
    assert [(d["id"], d["status"]) for d in listed] == [(changed.json()["id"], "ready")]
    async with env.sessions() as session:
        assert (await session.execute(select(Chunk.text))).scalars().all() == ["A revised single page."]
        assert await session.scalar(select(func.count()).select_from(Chunk)) == 1


async def test_rejects_what_is_not_a_pdf(env):
    r = await env.client.post(
        "/documents", headers=env.as_tenant("a"), files={"file": ("notes.txt", b"hi", "text/plain")}
    )
    assert r.status_code == 400
    assert (await env.upload("a", "fake.pdf", data=b"not a pdf at all")).status_code == 400
