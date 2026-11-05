"""API key -> tenant -> rate limit. Every tenant-scoped route depends on require_tenant.

Rate-limit failure policy when Redis is down (shrtr's, by bucket):
- uploads fail CLOSED (503): an upload needs Redis to be queued anyway
- queries (/search, /ask) fail OPEN: answering without a limit beats not answering
"""

import hashlib

from fastapi import Depends, Header, HTTPException, Request, Response
from redis.exceptions import RedisError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ApiKey
from app.observability.metrics import RATE_LIMIT_DECISIONS


def hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


async def get_session(request: Request) -> AsyncSession:
    async with request.app.state.sessionmaker() as session:
        yield session


async def require_tenant(
    request: Request,
    x_api_key: str = Header(..., description="Raw API key; only its SHA-256 is stored server-side"),
) -> int:
    async with request.app.state.sessionmaker() as session:
        tenant_id = (
            await session.execute(select(ApiKey.tenant_id).where(ApiKey.key_hash == hash_key(x_api_key)))
        ).scalar_one_or_none()
    if tenant_id is None:
        raise HTTPException(status_code=401, detail="invalid API key")
    return tenant_id


def rate_limited(bucket: str, fail_open: bool):
    """A dependency: the caller's tenant id, after taking a token from its `bucket`."""

    async def take(request: Request, response: Response, tenant_id: int = Depends(require_tenant)) -> int:
        settings = request.app.state.settings
        capacity = getattr(settings, f"rate_{bucket}_capacity")
        refill = getattr(settings, f"rate_{bucket}_refill_per_s")
        try:
            decision = await request.app.state.rate_limiter.take(f"{tenant_id}:{bucket}", capacity, refill)
        except RedisError:
            if fail_open:
                return tenant_id
            raise HTTPException(status_code=503, detail="rate limiter unavailable; uploads are paused")
        RATE_LIMIT_DECISIONS.labels(bucket=bucket, allowed=str(decision.allowed).lower()).inc()
        headers = {
            "X-RateLimit-Limit": str(decision.capacity),
            "X-RateLimit-Remaining": str(max(0, int(decision.remaining))),
        }
        if not decision.allowed:
            headers["Retry-After"] = str(decision.retry_after_s)
            raise HTTPException(status_code=429, detail=f"{bucket} rate limit exceeded", headers=headers)
        response.headers.update(headers)  # FastAPI merges dependency headers into the reply
        return tenant_id

    return take


limit_uploads = rate_limited("upload", fail_open=False)
limit_queries = rate_limited("query", fail_open=True)
