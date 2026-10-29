# atlas

[![ci](https://github.com/harshit-ojha0324/atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/harshit-ojha0324/atlas/actions/workflows/ci.yml)

atlas is a multi-tenant retrieval-augmented generation (RAG) service. Tenants upload PDFs and ask questions about them over a REST API or as MCP tools. Background workers parse, chunk and embed documents into Postgres with pgvector. Answers are generated through [forge](https://github.com/harshit-ojha0324/forge), an LLM gateway that provides per-tenant quotas, response caching and failover between models.

- Tenant isolation. Every query, rate limit, model quota and cached answer is scoped to the tenant.
- Fair ingestion. Each tenant has its own queue, so one tenant's backlog doesn't delay another's documents.
- Exactly-once indexing. A worker crash at any point leaves each document indexed once, never twice.
- Defensive answering. PII is redacted, prompt-injection attempts are blocked (including instructions planted in uploaded documents), credentials are masked in answers, and questions the documents can't answer are declined without calling the model.

## Architecture

```
 Client ── REST ──▶ API (FastAPI) ─────────────────────────────▶ forge ──▶ primary model
   │                 │  auth · rate limits · security layer         │       (fallback on failure)
 MCP client          │  retrieval                                  │
   └─▶ MCP server ───┘                                             cache, quotas, fair queueing
       (one tenant)  │
                     ├──▶ Postgres + pgvector   tenants, documents, chunks
                     └──▶ Redis                 rate limits, one ingest stream per tenant
                                │
                                ▼
                     Ingestion worker(s)        round-robin across tenants:
                                                parse → chunk → embed → commit → ack
```

| Component | Technology |
|---|---|
| API, worker | Python 3.12, FastAPI, SQLAlchemy (async), Alembic |
| Storage | PostgreSQL 16 with pgvector |
| Queueing, rate limits | Redis 7: Streams and a Lua token bucket |
| Embeddings | `all-MiniLM-L6-v2` (sentence-transformers, CPU) |
| Generation | forge (OpenAI-compatible gateway) |
| Agent interface | MCP (`mcp` SDK, streamable HTTP or stdio) |

## Quick start

Requirements: Docker, and a checkout of [forge](https://github.com/harshit-ojha0324/forge) next to this repository (or `FORGE_DIR=/path/to/forge` in `.env`).

```bash
make up                      # api, worker, postgres, redis, forge with mock models
make tenant NAME=acme        # prints the tenant's API key once
```

```bash
curl -H "X-API-Key: $KEY" -F file=@handbook.pdf localhost:8000/documents
curl -H "X-API-Key: $KEY" localhost:8000/documents/1
curl -H "X-API-Key: $KEY" -H 'content-type: application/json' \
     -d '{"question": "How many vacation days do employees get?"}' localhost:8000/ask
```

A new tenant can upload immediately; forge picks up its key within 30 seconds. By default forge serves mock models, so answers are placeholder text. To use Gemini, copy `.env.example` to `.env` and add an API key. Gemini is configured as forge's fallback, which serves only when the primary fails, so either stop the mock primary (`docker compose stop mock-vllm`) or set the `FORGE_PRIMARY_*` variables instead.

| Service | Port |
|---|---|
| API | 8000 |
| forge | 8081 |
| MCP server (`make mcp`) | 8090 |
| Postgres (tests) | 5433 |

All ports are bound to localhost.

## API

All endpoints except health checks require an `X-API-Key` header.

| Method and path | Description |
|---|---|
| `POST /documents` | Upload a PDF (up to 10 MB). Returns `202` with `status: pending`. Uploading identical content under the same name returns the existing document. New content under an existing name replaces the previous version once the new one is indexed. |
| `GET /documents/{id}` | Document status: `pending`, `ready`, or `failed` with an `error`. |
| `GET /documents` | All of the tenant's documents. |
| `DELETE /documents/{id}` | Delete a document and its chunks. |
| `POST /search` | `{query, k}`: the `k` nearest passages (default 4, max 20) with document, page and similarity score. |
| `POST /ask` | `{question, history?, k?}`: an answer with cited sources. With `history`, the question is treated as a follow-up. The response includes `security_warnings` and `forge_backend` (the model that answered, or `cache`). |
| `GET /healthz`, `/readyz`, `/metrics` | Liveness, readiness (Postgres and Redis), Prometheus metrics. |

Rate-limited responses return `429` with `Retry-After`.

## MCP server

`app/mcp_server.py` exposes one tenant's documents to MCP clients. It's a client of the REST API, so the same isolation, limits and security checks apply. API errors are returned as tool errors with the API's reason, so the calling model can act on them.

| Tool | Description |
|---|---|
| `list_documents()` | The tenant's documents and their status |
| `search_documents(query, k=4)` | Nearest passages |
| `ask(question)` | Answer with sources; pass a standalone question |

```bash
make mcp KEY=atlas_...                                             # http://localhost:8090/mcp
claude mcp add --transport http atlas http://localhost:8090/mcp    # Claude Code
```

For clients that launch servers over stdio:

```json
{"mcpServers": {"atlas": {
  "command": "/path/to/atlas/.venv/bin/python",
  "args": ["-m", "app.mcp_server", "--stdio"],
  "env": {"ATLAS_API_KEY": "atlas_...", "ATLAS_API_URL": "http://localhost:8000"}}}}
```

The server has no authentication of its own: anyone who can reach it acts as its tenant. Keep it on localhost.

## Design

### Storage

Chunks and their embeddings live in Postgres rather than a separate vector database. A document's chunks and its `ready` status are committed in one transaction, which is what makes indexing exactly-once (see below). Every chunk row carries its `tenant_id`, and the retrieval function requires one, so a query can't cross tenants by omission. Search is currently an exact scan of the tenant's chunks; an HNSW index can be added when volume requires it.

### Ingestion

An upload stores the PDF as a `pending` row and appends its id to the tenant's Redis stream (`ingest:<tenant_id>`). Workers form a consumer group across all tenant streams:

- **Fairness.** A worker takes the next document from the next tenant with queued work, round-robin. A tenant's backlog delays other tenants by at most one document per worker. Fairness is per document, not per page.
- **Exactly once.** Chunks and the `ready` status commit in one transaction, under a row lock that only proceeds if the document is still `pending`. The stream entry is acknowledged after the commit, so a redelivery after a crash is a no-op.
- **Recovery.** A restarted worker resumes the entries it held. Entries held by a worker that doesn't return are claimed by another after two minutes.
- **Failures.** Unreadable or empty PDFs, and documents over 2,000 chunks, are marked `failed` with a reason. Unexpected errors are marked `failed` and sent to a dead-letter stream (`ingest:dlq`). A document that repeatedly crashes the worker (for example, out of memory) is dead-lettered after three attempts. Attempts are counted in Postgres before work begins, so a database outage doesn't count against a document.

Documents are split into semantic chunks: sentences are embedded, and a new chunk starts at large shifts in meaning (250–1,000 characters).

### Answering

`/ask` calls forge with the tenant's own forge key at temperature 0. forge therefore applies quotas, fair queueing and caching per tenant. The cache key covers the full prompt, including retrieved passages, so re-indexing a document invalidates cached answers. Follow-up questions are first rewritten into standalone questions.

If the best passage scores below 0.25 cosine similarity (`ASK_MIN_SCORE`), atlas answers that the documents don't cover the question without calling the model. The threshold sits between the scores of answerable (0.42–0.72) and unanswerable (0.04–0.16) questions in the evaluation set.

### Security

On `/ask`:

- PII. Email addresses, phone numbers, SSNs and card numbers are redacted from the question and history before they reach the model.
- Injection. Questions that look like prompt-injection attempts are rejected with `400`. Such turns in the history are dropped instead.
- Planted instructions. Retrieved passages containing instructions aimed at the model are excluded from the prompt (indirect injection through uploaded documents). Extra passages are retrieved so the context isn't reduced.
- Credentials. API keys, passwords and tokens in answers are masked.

Each action is reported in `security_warnings` and counted in the `security_events_total` metric. Raw text is never logged. Detection is pattern-based; see [Limitations](#limitations).

### Rate limits

Each tenant has two token buckets, enforced atomically in Redis:
- Uploads: 10, refilling at 12 per minute
- Queries (`/search`, `/ask`): 30, refilling at 1 per second

If Redis is unavailable, uploads return `503` (they can't be queued anyway) and queries are allowed.

## Configuration

Settings are read from the environment (see `app/config.py`). The most relevant:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql+asyncpg://atlas:atlas@localhost:5432/atlas` | Postgres connection |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis connection |
| `FORGE_BASE_URL` | `http://localhost:8080` | forge gateway |
| `ASK_MIN_SCORE` | `0.25` | Minimum passage score for `/ask` to call the model |
| `RATE_UPLOAD_CAPACITY`, `RATE_UPLOAD_REFILL_PER_S` | `10`, `0.2` | Upload bucket |
| `RATE_QUERY_CAPACITY`, `RATE_QUERY_REFILL_PER_S` | `30`, `1.0` | Query bucket |
| `WORKER_MAX_ATTEMPTS` | `3` | Crashed attempts before a document is dead-lettered |
| `WORKER_RECLAIM_MIN_IDLE_MS` | `120000` | Idle time before another worker claims an entry |

## Testing and verification

```bash
pip install -e '.[dev]'    # with the stack running for the database tests
make test                  # 64 tests
make eval                  # retrieval and grounding evaluation
make drill                 # crash recovery
make drill-fairness        # cross-tenant fairness
make bench                 # load test
```

| Check | What it verifies | Latest result |
|---|---|---|
| Tests | Tenant isolation, worker delivery guarantees, fairness, `/ask` and its security layer, rate limits, MCP tools | 64 passing |
| `make eval` | 12 questions over a 10-page handbook, end to end: retrieval of the right page, answers grounded in it, and declining out-of-scope questions. Gate: 85%. | 100% relevance (hit@4), 100% grounded, hit@1 8/9 |
| `make eval` with `--judge-answers`, on Gemini | As above, and each answer must state the gold fact. Needs a real model (see Quick start); not run in CI. | 9/9 answers correct, each citing the right page; 3/3 out-of-scope declined without a model call |
| `make drill` | Kills the worker mid-document with `SIGKILL`, restarts it, and compares the result with an undisturbed run | Indexed once: same 562 chunks, no duplicates |
| `make drill-fairness` | A one-page upload from tenant B while tenant A has six large documents queued | B waited 6.8s (44.2s with a single shared queue) |
| `make bench` | 50 searches and 10 questions per second for 60s. Gate: under 1% errors, p95 under 250 ms and 500 ms. | 0 errors in 3,599 requests; p95 24 ms (`/search`), 31 ms (`/ask`). See [benchmarks/2026-10-28](benchmarks/2026-10-28). |

Database tests run against a real pgvector instance. CI runs lint and tests, then starts the full stack and gates on the evaluation, both drills and the benchmark.

## Limitations

- CI runs against mock models, so it gates retrieval and grounding but not answer content. Answer content is checked with `--judge-answers` against a real model, run manually (last result: 9/9 on `gemini-flash-lite-latest`). The evaluation set is 12 questions over one short document.
- Each document is embedded twice during ingestion (per sentence for chunking, then per chunk).
- Fair scheduling is per document; a very large PDF occupies a worker until it finishes.
- PII and injection detection are pattern-based. Ten-digit numbers such as order IDs are redacted as phone numbers.
- `/ask` does not stream responses.
- There is no command to delete a tenant. forge keys are stored in plain text, as they are in forge's own configuration.
- A missing API key returns `422` rather than `401`.

## Repository layout

```
app/
  main.py                 application setup
  config.py               settings
  worker.py               ingestion worker
  mcp_server.py           MCP server
  api/                    routes and dependencies (auth, rate limits)
  core/                   chunking, embeddings, retrieval, answering, security, rate limiter
  models/                 database models
  scripts/create_tenant.py
migrations/               Alembic migrations
scripts/                  evaluation, drills, benchmark, shared helpers
bench/                    k6 load test
benchmarks/               recorded benchmark results
tests/
deploy/                   forge tenant configuration (example)
```

## Acknowledgements

atlas reuses components from earlier projects: the gateway from [forge](https://github.com/harshit-ojha0324/forge); the Redis Streams worker and token-bucket limiter from [shrtr](https://github.com/harshit-ojha0324/shrtr); the chunker, prompts, security patterns and evaluation set from [Gemini-Powered-RAG-System](https://github.com/harshit-ojha0324/Gemini-Powered-RAG-System); and the MCP server structure from [smart-city-navigator](https://github.com/harshit-ojha0324/smart-city-navigator).
