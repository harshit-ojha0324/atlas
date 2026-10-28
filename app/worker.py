"""Ingestion worker (Redis Streams consumer group), ported from shrtr's analytics worker.

Fairness: every tenant has its own stream (ingest:<tenant_id>). A worker takes
the next document from the first tenant after the last one it served that has
work waiting, so a tenant's backlog delays another tenant by at most one
document per worker, not by the whole backlog (forge's per-tenant queues, in
plain round-robin). Fair by document, not by work: one huge PDF still holds a
worker until it's done, as forge's fairness is by slots, not tokens.

Guarantees:
- at-least-once delivery: an entry stays in the group's pending list until XACK.
  Every 10th loop a worker retries its own pending entries (so a restarted
  worker resumes what it held when it died) and XAUTOCLAIMs those of workers
  idle past worker_reclaim_min_idle_ms (ones that never came back).
- effectively-once ingestion: a document's chunks and status='ready' commit in
  one transaction, under a row lock that backs off unless the row is still
  pending; XACK only after that commit. A crash between commit and XACK
  redelivers an entry that is then skipped.
- three kinds of poison:
  * a bad PDF (unreadable, no text, too many chunks): status=failed with the
    reason, acked. That's the uploader's error, not the queue's.
  * processing raised with PostgreSQL reachable: dead-lettered, status=failed.
    With PostgreSQL down nothing is dead-lettered: entries stay pending.
  * the worker died mid-document (OOM, segfault, kill -9), which raises
    nothing. Each attempt is counted in PostgreSQL *before* any work, so a
    document that has died worker_max_attempts times is dead-lettered on its
    next delivery. Redis's delivery count can't do this job: it also climbs
    while PostgreSQL is down (shrtr's lesson). This counter can't, because
    bumping it needs PostgreSQL.

Run: python -m app.worker  (WORKER_NAME env overrides the consumer name)
"""

import asyncio
import logging
import os
import signal
import socket
import time

from prometheus_client import Counter, Gauge, Histogram, start_http_server
from redis.asyncio import Redis
from redis.exceptions import RedisError, ResponseError
from sqlalchemy import delete, func, insert, select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.config import Settings, get_settings
from app.core.chunking import DocumentTooLarge, build_chunks, extract_pages
from app.db.session import make_engine, make_sessionmaker
from app.models import Chunk, Document

log = logging.getLogger("worker.ingest")

OUTCOMES = Counter("ingest_outcomes_total", "Stream entries by outcome", ["outcome"])
INGEST_SECONDS = Histogram(
    "ingest_duration_seconds",
    "Parse + chunk + embed + commit, per document",
    buckets=[0.5, 1, 2, 5, 10, 30, 60, 120],
)
STREAM_PENDING = Gauge("stream_pending_entries", "Entries pending (unacked) in the consumer group")

STALE_CONSUMER_MS = 3_600_000  # live workers poll every worker_block_ms, so 1h idle = gone


class IngestWorker:
    def __init__(
        self, settings: Settings, redis: Redis, sessions: async_sessionmaker, embedder, name: str = ""
    ):
        self.settings = settings
        self.redis = redis
        self.sessions = sessions
        self.embedder = embedder
        # hostname (container ID under compose) + pid. A restarted container
        # keeps both (pid 1), so it comes back as the same consumer and its
        # pending entries are its own again.
        self.name = name or os.environ.get("WORKER_NAME") or f"{socket.gethostname()}-{os.getpid()}"
        self.shutting_down = False
        self.ready_streams: set[str] = set()  # streams whose consumer group this worker has ensured
        self.last_served = ""  # the stream the last new entry came from

    # --- stream plumbing (from shrtr) ---

    async def streams(self) -> list[str]:
        """Every tenant stream, in tenant order, each with its consumer group."""
        group = self.settings.stream_group
        tenant_ids = sorted(int(t) for t in await self.redis.smembers(self.settings.tenants_key))
        streams = [self.settings.tenant_stream(t) for t in tenant_ids]
        for key in streams:
            if key in self.ready_streams:
                continue
            try:
                await self.redis.xgroup_create(key, group, id="0", mkstream=True)
            except ResponseError as exc:
                if "BUSYGROUP" not in str(exc):
                    raise
            # recreated containers leave consumers behind: drop idle ones holding nothing
            for c in await self.redis.xinfo_consumers(key, group):
                if c["pending"] == 0 and c["idle"] > STALE_CONSUMER_MS:
                    await self.redis.xgroup_delconsumer(key, group, c["name"])
            self.ready_streams.add(key)
        return streams

    async def ack(self, stream: str, entry_id: str) -> None:
        await self.redis.xack(stream, self.settings.stream_group, entry_id)

    async def dlq(self, stream: str, entry_id: str, fields: dict, reason: str) -> None:
        await self.redis.xadd(
            self.settings.dlq_key,
            {
                "stream": stream,
                "original_id": entry_id,
                "reason": reason,
                **{k: str(v) for k, v in fields.items()},
            },
            maxlen=self.settings.dlq_maxlen,  # bounded: a poison flood can't grow Redis forever
            approximate=True,
        )
        await self.ack(stream, entry_id)
        OUTCOMES.labels(outcome="dlq").inc()

    async def db_reachable(self) -> bool:
        try:
            async with self.sessions() as session:
                await session.execute(text("SELECT 1"))
            return True
        except Exception:
            return False

    # --- one entry ---

    async def handle(self, stream: str, entry_id: str, fields: dict | None) -> None:
        if not fields:  # trimmed from the stream while pending: nothing to process
            await self.ack(stream, entry_id)
            return
        try:
            doc_id = int(fields["doc_id"])
        except (KeyError, ValueError):
            await self.dlq(stream, entry_id, fields, "parse_error")
            return
        try:
            dead_letter_reason = await self.ingest(doc_id)
        except RedisError:
            raise
        except Exception:
            if not await self.db_reachable():
                raise  # outage: leave it pending, retry later
            log.exception("ingesting document %s failed with PostgreSQL reachable", doc_id)
            await self.mark_failed(doc_id, "internal error while processing; try uploading again")
            dead_letter_reason = "processing_error"
        if dead_letter_reason:
            await self.dlq(stream, entry_id, fields, dead_letter_reason)
        else:
            await self.ack(stream, entry_id)

    async def ingest(self, doc_id: int) -> str | None:
        """Process one document. Returns a dead-letter reason, or None to ack."""
        claimed = await self.claim(doc_id)
        if claimed is None:
            OUTCOMES.labels(outcome="skipped").inc()  # already done, superseded or deleted
            return None
        tenant_id, name, content, attempts = claimed
        if attempts > self.settings.worker_max_attempts:
            await self.mark_failed(
                doc_id, f"gave up: {attempts - 1} processing attempts died before finishing"
            )
            return "max_attempts"

        start = time.perf_counter()
        try:
            pages = await asyncio.to_thread(extract_pages, content)
        except Exception:
            await self.mark_failed(doc_id, "could not read the PDF")
            return None
        try:
            chunks = await asyncio.to_thread(build_chunks, pages, self.embedder)
        except DocumentTooLarge as e:
            await self.mark_failed(doc_id, str(e))
            return None
        if not chunks:
            await self.mark_failed(doc_id, "the PDF has no extractable text")
            return None

        outcome = await self.commit(doc_id, tenant_id, name, len(pages), chunks)
        OUTCOMES.labels(outcome=outcome).inc()
        INGEST_SECONDS.observe(time.perf_counter() - start)
        log.info("document %s: %s (%d chunks)", doc_id, outcome, len(chunks))
        return None

    async def claim(self, doc_id: int):
        """Count this attempt, committed before any work, and load the document.
        None when it's no longer pending."""
        async with self.sessions.begin() as session:
            return (
                await session.execute(
                    update(Document)
                    .where(Document.id == doc_id, Document.status == "pending")
                    .values(attempts=Document.attempts + 1)
                    .returning(Document.tenant_id, Document.name, Document.content, Document.attempts)
                )
            ).one_or_none()

    async def commit(self, doc_id: int, tenant_id: int, name: str, pages: int, chunks: list) -> str:
        async with self.sessions.begin() as session:
            # Row lock: a second worker holding the same entry (reclaimed while
            # this one was slow) waits here, then sees 'ready' and backs off.
            status = await session.scalar(
                select(Document.status).where(Document.id == doc_id).with_for_update()
            )
            if status != "pending":
                return "skipped"
            same_name = (Document.tenant_id == tenant_id) & (Document.name == name)
            # a newer upload of this name is coming: this version is stale
            newer = await session.scalar(
                select(func.count()).where(same_name, Document.id > doc_id, Document.status != "failed")
            )
            if newer:
                await session.execute(delete(Document).where(Document.id == doc_id))
                return "superseded"
            # older versions go only now, so the previous one stayed searchable until this commit
            await session.execute(delete(Document).where(same_name, Document.id < doc_id))
            await session.execute(
                insert(Chunk),
                [
                    {
                        "document_id": doc_id,
                        "tenant_id": tenant_id,
                        "idx": i,
                        "page": p,
                        "text": t,
                        "embedding": v,
                    }
                    for i, (p, t, v) in enumerate(chunks)
                ],
            )
            await session.execute(
                update(Document)
                .where(Document.id == doc_id)
                .values(status="ready", pages=pages, chunk_count=len(chunks), content=None, error=None)
            )
        return "ready"

    async def mark_failed(self, doc_id: int, error: str) -> None:
        async with self.sessions.begin() as session:
            await session.execute(
                update(Document)
                .where(Document.id == doc_id, Document.status == "pending")
                .values(status="failed", error=error, content=None)
            )
        OUTCOMES.labels(outcome="failed").inc()

    # --- the loop ---

    async def retry_pending(self, streams: list[str]) -> list[tuple[str, str, dict]]:
        """My own pending entries, then other consumers' stalled ones, from every stream.

        ponytail: two Redis calls per tenant stream every 10th loop; batch them
        in a pipeline if tenants number in the thousands.
        """
        group = self.settings.stream_group
        entries, pending = [], 0
        for key in streams:
            mine = await self.redis.xreadgroup(group, self.name, {key: "0"}, count=10)
            entries += [(key, *e) for e in (mine[0][1] if mine else [])]
            try:
                res = await self.redis.xautoclaim(
                    key,
                    group,
                    self.name,
                    min_idle_time=self.settings.worker_reclaim_min_idle_ms,
                    start_id="0-0",
                    count=10,
                )
                entries += [(key, *e) for e in res[1]]
            except ResponseError:
                pass
            summary = await self.redis.xpending(key, group)
            pending += summary.get("pending", 0) if isinstance(summary, dict) else 0
        STREAM_PENDING.set(pending)
        return entries

    async def take_next(self, streams: list[str], block_ms: int | None) -> list[tuple[str, str, dict]]:
        """A new entry from the first tenant after the last one served that has work waiting."""
        group = self.settings.stream_group
        after = streams.index(self.last_served) + 1 if self.last_served in streams else 0
        for key in streams[after:] + streams[:after]:
            # count=1: documents are heavy, so a reclaim never steals a queue of them
            resp = await self.redis.xreadgroup(group, self.name, {key: ">"}, count=1)
            if resp:
                self.last_served = key
                return [(key, *resp[0][1][0])]
        if not block_ms:
            return []
        if not streams:  # no tenant has uploaded yet
            await asyncio.sleep(block_ms / 1000)
            return []
        # Nothing queued anywhere: wait on every stream. A tenant's first-ever
        # stream joins on the next loop, so its first upload can wait one block.
        resp = await self.redis.xreadgroup(
            group, self.name, {k: ">" for k in streams}, count=1, block=block_ms
        )
        return [(key, *e) for key, batch in resp or [] for e in batch]

    async def step(self, sweep: bool, block_ms: int | None) -> int:
        """One loop iteration; returns how many entries it handled."""
        streams = await self.streams()
        entries = await self.retry_pending(streams) if sweep else []
        # ">" returns only never-delivered entries, so none repeat the sweep's
        entries += await self.take_next(streams, None if entries else block_ms)
        for stream, entry_id, fields in entries:
            await self.handle(stream, entry_id, fields)
        return len(entries)

    async def run(self) -> None:
        log.info(
            "worker %s consuming %s:* / %s", self.name, self.settings.stream_key, self.settings.stream_group
        )
        loop_n = 0
        while not self.shutting_down:
            try:
                await self.step(sweep=loop_n % 10 == 0, block_ms=self.settings.worker_block_ms)
            except RedisError as exc:
                log.warning("redis error, backing off: %s", exc)
                await asyncio.sleep(2)
            except Exception:
                # not acked -> stays pending -> retried by the next sweep
                log.exception("entry failed; left pending for retry")
                await asyncio.sleep(2)
            loop_n += 1
        log.info("graceful shutdown complete")

    def request_shutdown(self, *_):
        # finish the current document, then exit (clean compose/K8s rollouts)
        self.shutting_down = True


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    from app.core.embeddings import Embedder  # loads torch; not needed by tests

    settings = get_settings()
    # socket_timeout above the XREADGROUP block, or every idle poll times out (shrtr's lesson)
    redis = Redis.from_url(
        settings.redis_url, decode_responses=True, socket_timeout=settings.worker_block_ms / 1000 + 5
    )
    engine = make_engine(settings)
    worker = IngestWorker(settings, redis, make_sessionmaker(engine), Embedder())
    start_http_server(settings.worker_metrics_port)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, worker.request_shutdown)
    try:
        await worker.run()
    finally:
        await redis.aclose()
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
