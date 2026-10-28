"""Ingestion queue producer (Redis Streams). The consumer is app/worker.py."""

from redis.asyncio import Redis

from app.config import Settings


async def enqueue(redis: Redis, settings: Settings, doc_id: int) -> None:
    """Raises RedisError when Redis is down; the caller undoes the upload."""
    await redis.xadd(
        settings.stream_key, {"doc_id": str(doc_id)}, maxlen=settings.stream_maxlen, approximate=True
    )
