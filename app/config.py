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

    # Redis connection pool (API): blocking pool so bursts queue briefly
    # instead of erroring when all connections are checked out
    redis_max_connections: int = 200
    redis_pool_timeout_s: float = 2.0

    # DB pool
    db_pool_size: int = 10

    # Ingestion over Redis Streams (see app/worker.py)
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


@lru_cache
def get_settings() -> Settings:
    return Settings()
