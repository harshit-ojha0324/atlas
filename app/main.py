from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from redis.asyncio import BlockingConnectionPool, Redis

from app.api import routes_ask, routes_documents, routes_health
from app.config import get_settings
from app.core.embeddings import Embedder
from app.core.ratelimit import RateLimiter
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
        app.state.rate_limiter = RateLimiter(app.state.redis)
        # one shared client for every forge call, like forge's own gateway
        app.state.forge = httpx.AsyncClient(
            base_url=settings.forge_base_url, timeout=settings.forge_timeout_s
        )
        # One torch thread per query embedding. By default torch gives every
        # call all the cores, so concurrent queries fight over them: under load
        # (make bench, 50 + 10 req/s) /search p95 fell from 82ms to 16-20ms.
        # The worker keeps the default; it embeds one document's batch at a time.
        app.state.embedder = Embedder(threads=1)
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
    app.include_router(routes_documents.router)
    app.include_router(routes_ask.router)

    # The web UI (frontend/, built into the image by the Dockerfile), served from
    # the API's own origin so the browser needs no CORS. Mounted last, so API
    # routes always match first.
    ui = Path(__file__).resolve().parents[1] / "frontend" / "dist"
    if ui.is_dir():
        app.mount("/", StaticFiles(directory=ui, html=True), name="ui")
    return app


app = create_app()
