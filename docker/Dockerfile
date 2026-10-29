# Multi-stage build shared by the API and the worker (compose overrides the command).

# The web UI, served by the API from frontend/dist
FROM node:20-alpine AS ui
WORKDIR /ui
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend ./
RUN npm run build

FROM python:3.12-slim AS builder
RUN python -m venv /venv
ENV PATH=/venv/bin:$PATH
# CPU-only torch first: plain `pip install torch` on x86 pulls the CUDA build (GBs)
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
WORKDIR /build
COPY pyproject.toml ./
COPY app ./app
RUN pip install --no-cache-dir .

FROM python:3.12-slim
RUN useradd --create-home --uid 10001 atlas
COPY --from=builder /venv /venv
ENV PATH=/venv/bin:$PATH HF_HOME=/opt/hf
# Bake the embedding model into the image so startup never downloads it.
RUN python -c "from sentence_transformers import SentenceTransformer; \
SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')"
ENV HF_HUB_OFFLINE=1
WORKDIR /app
COPY app ./app
COPY --from=ui /ui/dist ./frontend/dist
COPY migrations ./migrations
COPY alembic.ini ./alembic.ini
USER atlas
EXPOSE 8000
# single worker per container: prometheus_client registries are per-process,
# so scale with container replicas instead of uvicorn --workers
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
