from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.responses import PlainTextResponse
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from redis.asyncio import BlockingConnectionPool, Redis

from app.api import routes_health
from app.config import get_settings
from app.db.session import make_engine, make_sessionmaker
from app.observability.metrics import latency_middleware


def create_app() -> FastAPI:
    settings = get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = settings
        app.state.engine = make_engine(settings)
        app.state.sessionmaker = make_sessionmaker(app.state.engine)
        app.state.redis = Redis(
            connection_pool=BlockingConnectionPool.from_url(
                settings.redis_url,
                max_connections=settings.redis_max_connections,
                timeout=settings.redis_pool_timeout_s,
                decode_responses=True,
            )
        )
        # one shared client for every forge call, like forge's own gateway
        app.state.forge = httpx.AsyncClient(base_url=settings.forge_base_url, timeout=60.0)
        yield
        await app.state.forge.aclose()
        await app.state.redis.aclose()
        await app.state.engine.dispose()

    app = FastAPI(title="atlas", version="0.1.0", lifespan=lifespan)
    app.middleware("http")(latency_middleware)

    @app.get("/metrics", include_in_schema=False)
    async def metrics() -> PlainTextResponse:
        return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)

    app.include_router(routes_health.router)
    return app


app = create_app()
