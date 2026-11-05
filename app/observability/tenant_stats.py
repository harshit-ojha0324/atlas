"""Per-tenant activity, for the Gateway and System pages.

Prometheus counters are process-wide, and tenants mustn't see each other's
activity through them, so what a tenant is shown is counted here, per tenant, in
Redis. It's a convenience: Redis failures are logged and never fail the request
being counted, and the numbers last as long as Redis's data does.
"""

import datetime as dt
import logging
import math

from redis.exceptions import RedisError

log = logging.getLogger("atlas.stats")

WINDOW_DAYS = 7
LATENCY_SAMPLES = 200  # the most recent answers; old ones fall off the end
TTL_S = (WINDOW_DAYS + 1) * 24 * 3600


def _today() -> dt.date:
    return dt.datetime.now(dt.UTC).date()


def _day_key(tenant_id: int, day: dt.date) -> str:
    return f"stats:{tenant_id}:{day:%Y%m%d}"


def _latency_key(tenant_id: int) -> str:
    return f"stats:{tenant_id}:latency"


async def bump(redis, tenant_id: int, field: str) -> None:
    key = _day_key(tenant_id, _today())
    try:
        pipe = redis.pipeline()
        pipe.hincrby(key, field, 1)
        pipe.expire(key, TTL_S)
        await pipe.execute()
    except (RedisError, OSError) as exc:
        log.warning("couldn't record %s for tenant %s: %r", field, tenant_id, exc)


async def record_answer(redis, tenant_id: int, backend: str, seconds: float) -> None:
    await bump(redis, tenant_id, f"backend:{backend}")
    key = _latency_key(tenant_id)
    try:
        pipe = redis.pipeline()
        pipe.lpush(key, round(seconds * 1000))
        pipe.ltrim(key, 0, LATENCY_SAMPLES - 1)
        pipe.expire(key, TTL_S)
        await pipe.execute()
    except (RedisError, OSError) as exc:
        log.warning("couldn't record latency for tenant %s: %r", tenant_id, exc)


async def totals(redis, tenant_id: int) -> dict[str, int]:
    """Every counter summed over the window. Raises if Redis is unavailable: no
    numbers beats made-up zeros."""
    today = _today()
    pipe = redis.pipeline()
    for back in range(WINDOW_DAYS):
        pipe.hgetall(_day_key(tenant_id, today - dt.timedelta(days=back)))
    summed: dict[str, int] = {}
    for day in await pipe.execute():
        for field, count in day.items():
            summed[field] = summed.get(field, 0) + int(count)
    return summed


def percentile(values: list[int], p: float) -> int:
    """Nearest-rank: always a time that a real answer took."""
    ordered = sorted(values)
    return ordered[max(0, math.ceil(p * len(ordered)) - 1)]


async def latency(redis, tenant_id: int) -> dict | None:
    samples = [int(v) for v in await redis.lrange(_latency_key(tenant_id), 0, -1)]
    if not samples:
        return None
    return {"samples": len(samples), "p50_ms": percentile(samples, 0.5), "p95_ms": percentile(samples, 0.95)}
