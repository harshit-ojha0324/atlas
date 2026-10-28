# Multi-stage build shared by the API and (from Phase 2) the worker.
FROM python:3.12-slim AS builder
WORKDIR /build
COPY pyproject.toml ./
COPY app ./app
RUN pip install --no-cache-dir --prefix=/install .

FROM python:3.12-slim
RUN useradd --create-home --uid 10001 atlas
WORKDIR /app
COPY --from=builder /install /usr/local
COPY app ./app
COPY migrations ./migrations
COPY alembic.ini ./alembic.ini
USER atlas
EXPOSE 8000
# single worker per container: prometheus_client registries are per-process,
# so scale with container replicas instead of uvicorn --workers
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
