"""Structured configuration from environment variables (12-factor style)."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Core services
    database_url: str = "postgresql+asyncpg://atlas:atlas@localhost:5432/atlas"
    redis_url: str = "redis://localhost:6379/0"
    # forge: the LLM gateway every answer goes through (OpenAI-compatible)
    forge_base_url: str = "http://localhost:8080"
    forge_model: str = "forge-default"  # forge's public model alias
    # above forge's own 60s upstream timeout + 10s queue wait, so forge's
    # answer (or its error) always arrives before atlas gives up
    forge_timeout_s: float = 90.0
    # /ask answers only when the best passage scores at least this (cosine).
    # On the RAG app's gold set, answerable questions scored 0.42-0.72 and
    # unanswerable ones 0.04-0.16; 0.25 sits in the gap.
    ask_min_score: float = 0.25

    # Redis connection pool (API): blocking pool so bursts queue briefly
    # instead of erroring when all connections are checked out
    redis_max_connections: int = 200
    redis_pool_timeout_s: float = 2.0

    # Token buckets per tenant (shrtr's limiter). Uploads are expensive (CPU on
    # the worker); queries cover /search and /ask, whose LLM tokens forge meters too.
    rate_upload_capacity: int = 10
    rate_upload_refill_per_s: float = 0.2  # 12 a minute sustained
    rate_query_capacity: int = 30
    rate_query_refill_per_s: float = 1.0

    # DB pool
    db_pool_size: int = 10

    # Ingestion over Redis Streams (see app/worker.py): one stream per tenant,
    # ingest:<tenant_id>, and a set of the tenants that have one
    stream_key: str = "ingest"
    stream_group: str = "ingesters"
    stream_maxlen: int = 100_000
    dlq_key: str = "ingest:dlq"
    dlq_maxlen: int = 10_000
    worker_block_ms: int = 5000
    # longer than the slowest legitimate ingest (capped at 2,000 chunks), so a
    # live worker's document isn't reclaimed and processed twice
    worker_reclaim_min_idle_ms: int = 120_000
    # attempts that died without finishing (crash, OOM, kill) before giving up
    worker_max_attempts: int = 3
    worker_metrics_port: int = 9100

    def tenant_stream(self, tenant_id: int | str) -> str:
        return f"{self.stream_key}:{tenant_id}"

    @property
    def tenants_key(self) -> str:
        return f"{self.stream_key}:tenants"


@lru_cache
def get_settings() -> Settings:
    return Settings()
