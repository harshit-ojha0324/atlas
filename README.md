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

Create a tenant (the API key is printed once; forge accepts the tenant within 30s), then upload, search and ask:

```bash
make tenant NAME=acme
curl -H "X-API-Key: $KEY" -F file=@handbook.pdf localhost:8000/documents
curl -H "X-API-Key: $KEY" localhost:8000/documents
curl -H "X-API-Key: $KEY" -H 'content-type: application/json' \
     -d '{"query": "how many vacation days?", "k": 4}' localhost:8000/search
curl -H "X-API-Key: $KEY" -H 'content-type: application/json' \
     -d '{"question": "how many vacation days?"}' localhost:8000/ask
```

| Endpoint | What it does |
|---|---|
| `POST /documents` | Upload a PDF (max 10 MB). Returns 202 with `status: pending`; the worker chunks and embeds it. 200 if the same bytes are already indexed or queued under that name. Changed bytes under the same name replace the old version once the new one is ready. |
| `GET /documents/{id}` | Poll until `status` is `ready` or `failed` (with `error`). |
| `GET /documents` | This tenant's documents, every version. |
| `DELETE /documents/{id}` | Delete one; another tenant's id gets the same 404 as a missing one. |
| `POST /search` | The `k` nearest chunks (default 4, max 20) from this tenant's documents, with page and cosine score. |
| `POST /ask` | Answer `question` from this tenant's documents, with sources. Optional `history` (`[{role, content}]`) makes it a follow-up. The response says which model answered (`forge_backend`: `vllm`, `gemini` or `cache`). |

The local stack runs forge with mock models, so answers are placeholder text. Point forge's fallback at a real model (`FORGE_FALLBACK_BASE_URL`, `FORGE_FALLBACK_API_KEY`, `FORGE_FALLBACK_MODEL` on the `forge` service) to get real ones.

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

## Answers through forge

Every LLM call goes through forge using the asking tenant's own forge key. `make tenant` creates that key and appends the tenant to forge's tenants file (`deploy/forge-tenants.yaml`, a gitignored copy of the `.example`), which forge re-reads every 30s. Because forge sees each atlas tenant as its own tenant:

- **Quotas and fair queueing are per tenant.** One tenant flooding `/ask` is shed by forge without slowing the others. forge's 429 is passed on with its `Retry-After`.
- **The cache is per tenant.** Calls use temperature 0, so forge caches answers. Its cache key includes the tenant and the whole prompt (retrieved context included), so a re-indexed document never gets a stale answer, and one tenant's question never hits another's cached answer.
- **Failover is free.** If the primary model dies, forge's circuit breaker sends calls to the fallback and `/ask` keeps answering.

A follow-up question (`history` given) is first rewritten into a standalone question, which is then used for both retrieval and the answer: two forge calls, as the RAG app's LangChain chain did. Prompts are the RAG app's: system rules above delimited, untrusted context. If nothing relevant is found, `/ask` says so without calling forge at all. "Relevant" means the best passage scores at least 0.25 (`ASK_MIN_SCORE`). On the RAG app's gold set, answerable questions scored 0.42–0.72 and unanswerable ones 0.04–0.16, so off-topic questions cost no tokens, and the model never gets unrelated text to guess from.

## Rate limits and the security layer

**Rate limits.** Every tenant has two token buckets, using shrtr's Lua limiter:
- **uploads:** 10, refilling at 12 a minute
- **queries** (`/search` and `/ask`): 30, refilling at 1 a second

Limited responses carry `X-RateLimit-*` headers; refusals are 429 with `Retry-After`. If Redis is down, uploads return 503 (they need Redis to be queued anyway) and queries go through unlimited.

**Security layer on `/ask`**, ported from the RAG app:
- **PII:** emails, phone numbers, SSNs and card numbers are redacted from the question and the history before anything reaches forge. Names are kept, since they're what people ask about.
- **Injection:** a question that looks like a prompt injection gets a 400. A history turn that does is dropped from the history instead, so one blocked question doesn't block the conversation.
- **Planted instructions:** retrieved passages containing instructions aimed at the model (indirect injection through an uploaded document) are left out of the prompt. A few extra passages are fetched, so a withheld one doesn't shrink the answer's context.

One injection pattern covers questions, history and passages, and it only matches text aimed at the model ("ignore all previous instructions", "system prompt", "you are now DAN"). The RAG app's broader question patterns refused ordinary questions such as "What are the new rules for expenses?" or anything mentioning someone named Dan.
- **Credentials:** API keys, passwords and tokens in the answer are masked.

Each action is reported in the response's `security_warnings` and counted in `security_events_total`. The raw text is never logged. The patterns are regex only; the RAG app also ran Presidio (spaCy's ~600 MB model), left out here to keep the image smaller.

## Readiness

`/readyz` returns 503 when Postgres or Redis is down. forge is reported but never fails readiness: without it, questions fail, but uploads and listing still work.

## Roadmap

- [x] **Phase 0:** skeleton: API, pgvector, Redis, forge + mock models in one compose stack
- [x] **Phase 1:** tenants, API keys, chunks table; synchronous upload and tenant-scoped retrieval
- [x] **Phase 2:** background ingestion over Redis Streams (worker, dead-letter queue, kill-the-worker drill)
- [x] **Phase 3:** all LLM calls through forge, one forge key per tenant
- [x] **Phase 4:** token-bucket rate limits and the security layer
- [ ] **Phase 5:** MCP server (`search_documents`, `ask`, `list_documents`)
- [ ] **Phase 6:** evals, failure drills and benchmarks gated in CI
