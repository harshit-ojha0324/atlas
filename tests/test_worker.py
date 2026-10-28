"""The ingestion worker's delivery guarantees and poison handling."""

import fakeredis
from sqlalchemy import func, select, update
from sqlalchemy.orm import undefer

from app.models import Chunk, Document

PAGE = "Quarterly maintenance schedule for the north pumping station."


async def doc(env, doc_id: int) -> Document:
    async with env.sessions() as session:
        return await session.get(Document, doc_id, options=[undefer(Document.content)])


async def chunk_count(env, doc_id: int) -> int:
    async with env.sessions() as session:
        return await session.scalar(
            select(func.count()).select_from(Chunk).where(Chunk.document_id == doc_id)
        )


async def dlq(env) -> list:
    return await env.redis.xrange(env.settings.dlq_key)


async def test_redelivery_after_commit_changes_nothing(env):
    doc_id = (await env.upload("a", "p.pdf", [PAGE])).json()["id"]
    await env.drain()
    assert (await doc(env, doc_id)).status == "ready" and await chunk_count(env, doc_id) == 1

    # a crash between COMMIT and XACK redelivers the entry
    await env.worker().handle(env.stream("a"), "1-0", {"doc_id": str(doc_id)})
    d = await doc(env, doc_id)
    assert d.status == "ready" and d.attempts == 1 and await chunk_count(env, doc_id) == 1


async def test_restarted_worker_resumes_the_document_it_died_holding(env):
    doc_id = (await env.upload("a", "p.pdf", [PAGE])).json()["id"]
    first = env.worker(name="w1")
    await first.streams()
    # w1 takes the entry, counts its attempt, then dies before finishing
    await env.redis.xreadgroup(env.settings.stream_group, "w1", {env.stream("a"): ">"}, count=1)
    await first.claim(doc_id)
    assert await env.pending() == 1

    await env.drain(env.worker(name="w1"))  # same consumer name, as a restarted container has
    d = await doc(env, doc_id)
    assert d.status == "ready" and d.attempts == 2 and d.chunk_count == await chunk_count(env, doc_id) == 1
    assert await env.pending() == 0


async def test_document_that_keeps_killing_workers_is_dead_lettered(env):
    doc_id = (await env.upload("a", "p.pdf", [PAGE])).json()["id"]
    async with env.sessions.begin() as session:  # as if it had died mid-processing max_attempts times
        await session.execute(
            update(Document).where(Document.id == doc_id).values(attempts=env.settings.worker_max_attempts)
        )
    await env.drain()
    d = await doc(env, doc_id)
    assert d.status == "failed" and d.error.startswith("gave up") and d.content is None
    assert [e[1]["reason"] for e in await dlq(env)] == ["max_attempts"]
    assert await env.pending() == 0


async def test_unreadable_pdf_fails_without_dead_lettering(env):
    doc_id = (await env.upload("a", "broken.pdf", data=b"%PDF-1.4 this is not really a pdf")).json()["id"]
    await env.drain()
    d = await doc(env, doc_id)
    assert d.status == "failed" and d.error == "could not read the PDF"
    assert await dlq(env) == [] and await env.pending() == 0


async def test_unexpected_error_with_database_up_is_dead_lettered(env):
    class BrokenEmbedder:
        def embed_documents(self, texts):
            raise RuntimeError("model blew up")

    doc_id = (await env.upload("a", "p.pdf", [PAGE])).json()["id"]
    await env.drain(env.worker(embedder=BrokenEmbedder()))
    d = await doc(env, doc_id)
    assert d.status == "failed" and "internal error" in d.error
    assert [e[1]["reason"] for e in await dlq(env)] == ["processing_error"]


async def test_older_version_finishing_last_is_discarded(env):
    old_id = (await env.upload("a", "r.pdf", ["Version one."])).json()["id"]
    new_id = (await env.upload("a", "r.pdf", ["Version two."])).json()["id"]
    w = env.worker()
    await w.streams()
    ((_, entries),) = await env.redis.xreadgroup(
        env.settings.stream_group, w.name, {env.stream("a"): ">"}, count=2
    )
    for entry_id, fields in reversed(entries):  # the newer upload finishes first
        await w.handle(env.stream("a"), entry_id, fields)

    assert await doc(env, old_id) is None
    assert (await doc(env, new_id)).status == "ready"
    async with env.sessions() as session:
        assert (await session.execute(select(Chunk.text))).scalars().all() == ["Version two."]


async def test_upload_with_redis_down_leaves_no_orphan(env, monkeypatch):
    env.client._transport.app.state.redis = fakeredis.FakeAsyncRedis(connected=False)
    r = await env.upload("a", "p.pdf", [PAGE])
    assert r.status_code == 503
    async with env.sessions() as session:
        assert await session.scalar(select(func.count()).select_from(Document)) == 0


async def test_one_tenants_backlog_doesnt_delay_another_tenants_document(env):
    a_ids = [(await env.upload("a", f"a{i}.pdf", [f"Tenant A page {i}."])).json()["id"] for i in range(5)]
    b_id = (await env.upload("b", "b.pdf", ["Tenant B's only page."])).json()["id"]
    w = env.worker()
    order = []
    ingest = w.ingest

    async def record(doc_id):
        order.append(doc_id)
        return await ingest(doc_id)

    w.ingest = record
    await env.drain(w)
    # B's document goes second, right after A's first, not behind all five
    assert order == [a_ids[0], b_id, *a_ids[1:]]
