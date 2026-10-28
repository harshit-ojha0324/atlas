"""readyz: Postgres and Redis gate readiness; forge is reported, never gating."""

import fakeredis
import httpx
import pytest
import respx
from sqlalchemy.ext.asyncio import create_async_engine

from app.main import create_app

FORGE = "http://forge.test"


@pytest.fixture
async def client():
    app = create_app()  # no lifespan under ASGITransport: wire state by hand
    app.state.engine = create_async_engine("sqlite+aiosqlite://")
    app.state.redis = fakeredis.FakeAsyncRedis()
    app.state.forge = httpx.AsyncClient(base_url=FORGE)
    # only forge's URL is mocked; the ASGI test client must pass through
    with respx.mock(base_url=FORGE, assert_all_called=False) as forge:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            yield app, c, forge
    await app.state.forge.aclose()
    await app.state.engine.dispose()


async def test_ready_when_all_up(client):
    _, c, forge = client
    forge.get("/healthz").respond(200, json={"status": "ok"})
    r = await c.get("/readyz")
    assert r.status_code == 200
    assert r.json() == {"redis": "ok", "postgres": "ok", "forge": "ok"}


async def test_forge_down_does_not_fail_readiness(client):
    _, c, forge = client
    forge.get("/healthz").mock(side_effect=httpx.ConnectError("refused"))
    r = await c.get("/readyz")
    assert r.status_code == 200
    assert r.json()["forge"] == "down"


async def test_redis_down_fails_readiness(client):
    app, c, forge = client
    forge.get("/healthz").respond(200)
    app.state.redis = fakeredis.FakeAsyncRedis(connected=False)
    r = await c.get("/readyz")
    assert r.status_code == 503
    assert r.json()["redis"] == "down"
