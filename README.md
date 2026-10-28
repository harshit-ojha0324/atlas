# atlas

A multi-tenant RAG platform built from four earlier projects:

| Piece | Comes from |
|---|---|
| LLM calls: circuit-breaker failover, per-tenant quotas, fair queueing, response cache | [forge](https://github.com/harshit-ojha0324/forge), run as a service |
| App layout, token-bucket rate limiting, Redis Streams worker with effectively-once processing | [shrtr](https://github.com/harshit-ojha0324/shrtr) |
| PDF parsing, semantic chunking, prompt templates, PII/injection security layer, eval harness | [Gemini-Powered-RAG-System](https://github.com/harshit-ojha0324/Gemini-Powered-RAG-System) |
| MCP server pattern | [smart-city-navigator](https://github.com/harshit-ojha0324/smart-city-navigator) |

## Run it

Needs Docker, and a checkout of forge next to this repo (or `FORGE_DIR=/path/to/forge` in `.env`).

```bash
make up
curl localhost:8000/readyz   # {"redis":"ok","postgres":"ok","forge":"ok"}
```

| Service | Host port |
|---|---|
| atlas API | 8000 |
| forge gateway | 8081 |

Create a tenant (the API key is printed once), then upload and search:

```bash
make tenant NAME=acme
curl -H "X-API-Key: $KEY" -F file=@handbook.pdf localhost:8000/documents
curl -H "X-API-Key: $KEY" localhost:8000/documents
curl -H "X-API-Key: $KEY" -H 'content-type: application/json' \
     -d '{"query": "how many vacation days?", "k": 4}' localhost:8000/search
```

| Endpoint | What it does |
|---|---|
| `POST /documents` | Upload a PDF (max 10 MB). Returns 202 with `status: pending`; the worker chunks and embeds it. 200 if the same bytes are already indexed or queued under that name. Changed bytes under the same name replace the old version once the new one is ready. |
| `GET /documents/{id}` | Poll until `status` is `ready` or `failed` (with `error`). |
| `GET /documents` | This tenant's documents, every version. |
| `DELETE /documents/{id}` | Delete one; another tenant's id gets the same 404 as a missing one. |
| `POST /search` | The `k` nearest chunks (default 4, max 20) from this tenant's documents, with page and cosine score. |

Tests: `pip install -e '.[dev]' && make test`. The tenant-isolation tests run against the stack's Postgres (published on `127.0.0.1:5433`) in a separate `atlas_test` database, and skip if it isn't up.

## Why Postgres + pgvector, not Chroma

A document's chunks and its `ready` status must commit in one transaction. That's what lets the ingestion worker reuse shrtr's guarantee: commit, then acknowledge the stream message, so a crash in between causes a redelivery that changes nothing. With vectors in Chroma and status in Postgres, the two can't commit together. Postgres also makes tenant isolation a `WHERE tenant_id = …` on every search, and lets the API and several workers share one store.

## Ingestion worker

Uploads go onto a Redis Stream; `app/worker.py` (a consumer group, ported from shrtr's analytics worker) does the parsing, chunking and embedding.

- **Effectively once.** A document's chunks and its `ready` status commit in one transaction, under a row lock that backs off unless the row is still `pending`. The worker acknowledges the stream entry only after that commit, so a crash in between redelivers an entry that is then skipped.
- **Crash recovery.** A restarted worker comes back as the same consumer and resumes the entries it held. Entries held by a worker that never comes back are claimed by another worker after 2 minutes idle.
- **Re-uploads.** The previous ready version stays searchable until the new one commits. If uploads finish out of order, the older one is discarded.
- **Poison:**
  - A bad PDF (unreadable, no text, over 2,000 chunks) is marked `failed` with the reason.
  - An unexpected error while Postgres is up is marked `failed` and dead-lettered to `ingest:dlq`. While Postgres is down, nothing is dead-lettered; entries wait.
  - A document that kills the worker outright (OOM, segfault) raises nothing to catch. Each attempt is committed to `documents.attempts` *before* any work, so after 3 attempts that never finished, the next delivery dead-letters it. Redis's own delivery count can't do this: it also climbs during a Postgres outage. This counter can't, since bumping it needs Postgres.

`make drill` proves the crash path on the live stack. It SIGKILLs the worker mid-document, restarts it, and checks the document lands exactly once. Last run: 300 pages, 560 chunks; the restarted worker finished in 25s; no duplicates; 2 attempts recorded; nothing left pending or dead-lettered.

## Readiness

`/readyz` returns 503 when Postgres or Redis is down. forge is reported but never fails readiness: without it, questions fail, but uploads and listing still work.

## Roadmap

- [x] **Phase 0:** skeleton: API, pgvector, Redis, forge + mock models in one compose stack
- [x] **Phase 1:** tenants, API keys, chunks table; synchronous upload and tenant-scoped retrieval
- [x] **Phase 2:** background ingestion over Redis Streams (worker, dead-letter queue, kill-the-worker drill)
- [ ] **Phase 3:** all LLM calls through forge, one forge key per tenant
- [ ] **Phase 4:** token-bucket rate limits and the security layer
- [ ] **Phase 5:** MCP server (`search_documents`, `ask`, `list_documents`)
- [ ] **Phase 6:** evals, failure drills and benchmarks gated in CI
