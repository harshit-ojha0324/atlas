"""GET /gateway and GET /system: what the web UI's Gateway and System pages show.

Everything here is either scoped to the asking tenant or says nothing about
other tenants (a service's health, how many workers are alive). Each part reads
independently and is null if its source is unavailable, so one service being
down doesn't take the page with it, and a null is never dressed up as a zero.
"""

import json
import logging
import re
import time
from functools import lru_cache
from pathlib import Path
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from redis.exceptions import RedisError, ResponseError
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError

from app.api.deps import require_tenant
from app.models import Document
from app.observability import tenant_stats

log = logging.getLogger("atlas.system")

router = APIRouter(tags=["system"])

FORGE_STATUS_TIMEOUT_S = 2.0
BREAKER_STATES = {"0": "closed", "1": "half_open", "2": "open"}
SECURITY_KINDS = (
    "pii_redacted",
    "injection_blocked",
    "history_turn_dropped",
    "chunk_dropped",
    "output_filtered",
)
VERIFICATION = Path(__file__).resolve().parents[1] / "observability" / "verification.json"


class Quota(BaseModel):
    used_tokens: int
    daily_token_quota: int
    remaining_tokens: int


class Bucket(BaseModel):
    capacity: int
    refill_per_s: float
    available: float


class Answers(BaseModel):
    window_days: int
    by_backend: dict[str, int]  # vllm | gemini | cache
    declined: int  # nothing relevant in the documents, so no model was called
    failed: int  # forge couldn't answer


class Latency(BaseModel):
    samples: int
    p50_ms: int
    p95_ms: int


class GatewayOut(BaseModel):
    quota: Quota | None
    breaker: Literal["closed", "half_open", "open"] | None  # on forge's primary model
    rate_limits: dict[str, Bucket] | None
    answers: Answers | None
    latency: Latency | None


class Ingest(BaseModel):
    waiting: int  # in this tenant's stream, not yet picked up
    in_progress: int  # picked up by a worker, not yet finished


class Documents(BaseModel):
    ready: int
    pending: int
    failed: int
    pages: int
    passages: int


class Security(BaseModel):
    window_days: int
    pii_redacted: int
    injection_blocked: int
    history_turn_dropped: int
    chunk_dropped: int
    output_filtered: int


class Verification(BaseModel):
    id: str
    label: str
    passed: bool
    detail: str
    date: str
    commit: str


class SystemOut(BaseModel):
    workers_live: int | None
    ingest: Ingest | None
    documents: Documents | None
    security: Security | None
    verification: list[Verification]  # recorded by scripts/verify.py, not live


async def _quota(request: Request, tenant_id: int) -> Quota | None:
    state = request.app.state
    try:
        r = await state.forge.get(
            "/v1/usage",
            headers={
                "Authorization": f"Bearer {state.settings.forge_api_key}",
                "X-Forge-Subtenant": str(tenant_id),
            },
            timeout=FORGE_STATUS_TIMEOUT_S,
        )
        r.raise_for_status()
        return Quota(**r.json())
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("couldn't read usage from forge: %r", exc)
        return None


async def _breaker(request: Request) -> str | None:
    try:
        r = await request.app.state.forge.get("/metrics", timeout=FORGE_STATUS_TIMEOUT_S)
        r.raise_for_status()
    except httpx.HTTPError as exc:
        log.warning("couldn't read metrics from forge: %r", exc)
        return None
    # ponytail: with several forge replicas this is whichever one answered; a
    # scrape of all of them is Prometheus's job.
    found = re.search(r"^forge_breaker_state (\d)", r.text, re.MULTILINE)
    return BREAKER_STATES.get(found.group(1)) if found else None


async def _rate_limits(request: Request, tenant_id: int) -> dict[str, Bucket] | None:
    state = request.app.state
    buckets = {}
    try:
        for bucket in ("query", "upload"):
            capacity = getattr(state.settings, f"rate_{bucket}_capacity")
            refill = getattr(state.settings, f"rate_{bucket}_refill_per_s")
            available = await state.rate_limiter.peek(f"{tenant_id}:{bucket}", capacity, refill)
            buckets[bucket] = Bucket(capacity=capacity, refill_per_s=refill, available=available)
    except (RedisError, OSError) as exc:
        log.warning("couldn't read rate limits: %r", exc)
        return None
    return buckets


@router.get("/gateway")
async def gateway(request: Request, tenant_id: int = Depends(require_tenant)) -> GatewayOut:
    redis = request.app.state.redis
    answers = latency = None
    try:
        counts = await tenant_stats.totals(redis, tenant_id)
        answers = Answers(
            window_days=tenant_stats.WINDOW_DAYS,
            by_backend={k.removeprefix("backend:"): v for k, v in counts.items() if k.startswith("backend:")},
            declined=counts.get("declined", 0),
            failed=counts.get("failed", 0),
        )
        found = await tenant_stats.latency(redis, tenant_id)
        latency = Latency(**found) if found else None
    except (RedisError, OSError) as exc:
        log.warning("couldn't read tenant stats: %r", exc)
    return GatewayOut(
        quota=await _quota(request, tenant_id),
        breaker=await _breaker(request),
        rate_limits=await _rate_limits(request, tenant_id),
        answers=answers,
        latency=latency,
    )


async def _workers_live(request: Request) -> int | None:
    state = request.app.state
    since = time.time() - state.settings.worker_heartbeat_ttl_s
    try:
        return await state.redis.zcount(state.settings.workers_key, since, "+inf")
    except (RedisError, OSError) as exc:
        log.warning("couldn't read worker heartbeats: %r", exc)
        return None


async def _ingest(request: Request, tenant_id: int) -> Ingest | None:
    state = request.app.state
    try:
        groups = await state.redis.xinfo_groups(state.settings.tenant_stream(tenant_id))
    except ResponseError:  # no stream until this tenant's first upload
        return Ingest(waiting=0, in_progress=0)
    except (RedisError, OSError) as exc:
        log.warning("couldn't read the ingest stream: %r", exc)
        return None
    group = next((g for g in groups if g["name"] == state.settings.stream_group), None)
    if group is None:  # the stream exists, but no worker has seen it yet
        length = await state.redis.xlen(state.settings.tenant_stream(tenant_id))
        return Ingest(waiting=length, in_progress=0)
    return Ingest(waiting=group.get("lag") or 0, in_progress=group["pending"])


async def _documents(request: Request, tenant_id: int) -> Documents | None:
    try:
        async with request.app.state.sessionmaker() as session:
            rows = await session.execute(
                select(
                    Document.status,
                    func.count(),
                    func.coalesce(func.sum(Document.pages), 0),
                    func.coalesce(func.sum(Document.chunk_count), 0),
                )
                .where(Document.tenant_id == tenant_id)
                .group_by(Document.status)
            )
    except (SQLAlchemyError, OSError) as exc:
        log.warning("couldn't count documents: %r", exc)
        return None
    by_status = {status: (count, pages, chunks) for status, count, pages, chunks in rows}
    return Documents(
        ready=by_status.get("ready", (0,))[0],
        pending=by_status.get("pending", (0,))[0],
        failed=by_status.get("failed", (0,))[0],
        pages=sum(v[1] for v in by_status.values()),
        passages=sum(v[2] for v in by_status.values()),
    )


async def _security(request: Request, tenant_id: int) -> Security | None:
    try:
        counts = await tenant_stats.totals(request.app.state.redis, tenant_id)
    except (RedisError, OSError) as exc:
        log.warning("couldn't read tenant stats: %r", exc)
        return None
    return Security(
        window_days=tenant_stats.WINDOW_DAYS, **{k: counts.get(f"event:{k}", 0) for k in SECURITY_KINDS}
    )


@lru_cache
def _verification() -> list[Verification]:
    return [Verification(**entry) for entry in json.loads(VERIFICATION.read_text())]


@router.get("/system")
async def system(request: Request, tenant_id: int = Depends(require_tenant)) -> SystemOut:
    return SystemOut(
        workers_live=await _workers_live(request),
        ingest=await _ingest(request, tenant_id),
        documents=await _documents(request, tenant_id),
        security=await _security(request, tenant_id),
        verification=_verification(),
    )
