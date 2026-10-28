"""Per-tenant token buckets on uploads and queries, and their Redis-down policy."""

import fakeredis

from app.core.ratelimit import RateLimiter


def slow_buckets(env, capacity: int = 2) -> None:
    for bucket in ("upload", "query"):
        setattr(env.settings, f"rate_{bucket}_capacity", capacity)
        setattr(env.settings, f"rate_{bucket}_refill_per_s", 0.001)


async def test_uploads_beyond_the_bucket_get_429_for_that_tenant_only(env):
    slow_buckets(env)
    assert (await env.upload("a", "1.pdf", ["one"])).status_code == 202
    r = await env.upload("a", "2.pdf", ["two"])
    assert r.status_code == 202 and r.headers["x-ratelimit-remaining"] == "0"
    r = await env.upload("a", "3.pdf", ["three"])
    assert r.status_code == 429 and int(r.headers["retry-after"]) > 0
    assert (await env.upload("b", "1.pdf", ["one"])).status_code == 202  # B's bucket is its own


async def test_queries_have_their_own_bucket(env):
    slow_buckets(env)
    await env.upload("a", "1.pdf", ["one"])
    await env.upload("a", "2.pdf", ["two"])  # upload bucket now empty
    for _ in range(2):
        assert (
            await env.client.post("/search", headers=env.as_tenant("a"), json={"query": "x"})
        ).status_code == 200
    assert (
        await env.client.post("/search", headers=env.as_tenant("a"), json={"query": "x"})
    ).status_code == 429


async def test_redis_down_pauses_uploads_but_not_queries(env):
    env.client._transport.app.state.rate_limiter = RateLimiter(fakeredis.FakeAsyncRedis(connected=False))
    assert (await env.upload("a", "1.pdf", ["one"])).status_code == 503
    assert (
        await env.client.post("/search", headers=env.as_tenant("a"), json={"query": "x"})
    ).status_code == 200
