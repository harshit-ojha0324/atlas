"""API key -> tenant. Every tenant-scoped route depends on require_tenant."""

import hashlib
import time

from fastapi import Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ApiKey

# key hash -> (cached at, tenant id). A deleted key keeps working for up to the
# TTL on each API replica; fine until keys can be revoked.
_KEY_CACHE: dict[str, tuple[float, int]] = {}
_KEY_CACHE_TTL_S = 60.0


def hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


async def get_session(request: Request) -> AsyncSession:
    async with request.app.state.sessionmaker() as session:
        yield session


async def require_tenant(
    request: Request,
    x_api_key: str = Header(..., description="Raw API key; only its SHA-256 is stored server-side"),
) -> int:
    digest = hash_key(x_api_key)
    cached = _KEY_CACHE.get(digest)
    if cached and time.monotonic() - cached[0] < _KEY_CACHE_TTL_S:
        return cached[1]
    async with request.app.state.sessionmaker() as session:
        tenant_id = (
            await session.execute(select(ApiKey.tenant_id).where(ApiKey.key_hash == digest))
        ).scalar_one_or_none()
    if tenant_id is None:
        raise HTTPException(status_code=401, detail="invalid API key")
    _KEY_CACHE[digest] = (time.monotonic(), tenant_id)
    return tenant_id
