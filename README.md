# atlas

A multi-tenant RAG platform. Each tenant uploads PDFs and asks questions about them. Uploads are chunked and embedded by background workers that survive crashes and share time fairly between tenants. Answers come from an LLM gateway with per-tenant quotas, caching and failover. Every tenant's data, rate limits, quotas and cache are isolated from every other tenant's.

It's built almost entirely from four earlier projects, reusing patterns that were already proven there:

| Piece | Comes from |
|---|---|
| LLM calls: circuit-breaker failover, per-tenant quotas, fair queueing, response cache | [forge](https://github.com/harshit-ojha0324/forge), run as a service |
| App layout, token-bucket rate limiting, Redis Streams worker with effectively-once processing | [shrtr](https://github.com/harshit-ojha0324/shrtr) |
| PDF parsing, semantic chunking, prompt templates, PII/injection security layer, eval set | [Gemini-Powered-RAG-System](https://github.com/harshit-ojha0324/Gemini-Powered-RAG-System) |
| MCP server pattern (Phase 5) | [smart-city-navigator](https://github.com/harshit-ojha0324/smart-city-navigator) |

The only new concept is pgvector: one column type, one distance operator.

## Architecture

```
                         ┌────────────────────────── atlas API (FastAPI) ──────────────────────────┐
 POST /documents  ──────▶│ API key → tenant → upload token bucket → store PDF as `pending` row     │
                         │   → XADD to the tenant's own stream ingest:<tenant_id>  → 202           │
                         │                                                                         │
 POST /search     ──────▶│ query token bucket → embed query → nearest chunks WHERE tenant_id = …   │
                         │                                                                         │
 POST /ask        ──────▶│ query token bucket → redact PII → injection check → (rewrite follow-up) │
                         │   → retrieve → drop passages with planted instructions → relevance floor│
                         │   → forge, as this tenant, temperature 0 → mask credentials → answer    │
                         └───────┬───────────────────────────┬─────────────────────────┬───────────┘
                                 │                           │                         │
                     Postgres + pgvector              Redis (db 0)           forge gateway (Redis db 1)
                 tenants, api_keys, documents,   token buckets, per-tenant   per-tenant quotas, fair
                 chunks (vector(384))            ingest streams, DLQ         queueing, cache, breaker
                                 ▲                           │                   │            │
                                 │                           ▼                   ▼            ▼
                         ┌───────┴─────────────────── ingestion worker(s) ───┐  primary     fallback
                         │ round-robin across tenant streams → count attempt │  (vLLM)      (Gemini)
                         │ → parse → semantic-chunk → embed (MiniLM, CPU)    │
                         │ → commit chunks + `ready` in one transaction → ACK│
                         └───────────────────────────────────────────────────┘
```

## Run it

Needs Docker, and a checkout of forge next to this repo (or `FORGE_DIR=/path/to/forge` in `.env`).

```bash
make up
curl localhost:8000/readyz   # {"redis":"ok","postgres":"ok","forge":"ok"}
```

| Service | Host port | Why that port |
|---|---|---|
| atlas API | 8000 | |
| forge gateway | 8081 | forge's own standalone stack uses 8080 |
| Postgres | 5433 (localhost only) | for the tests; shrtr uses 5432 |

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
| `POST /documents` | Upload a PDF (max 10 MB). Returns 202 with `status: pending`; a worker chunks and embeds it. 200 if the same bytes are already indexed or queued under that name. Changed bytes under the same name replace the old version once the new one is ready. |
| `GET /documents/{id}` | Poll until `status` is `ready` or `failed` (with `error`). |
| `GET /documents` | This tenant's documents, every version. |
| `DELETE /documents/{id}` | Delete one; another tenant's id gets the same 404 as a missing one. |
| `POST /search` | The `k` nearest chunks (default 4, max 20) from this tenant's documents, with page and cosine score. |
| `POST /ask` | Answer `question` from this tenant's documents, with sources and `security_warnings`. Optional `history` (`[{role, content}]`) makes it a follow-up. `forge_backend` says which model answered: `vllm`, `gemini` or `cache`. |
| `GET /healthz`, `GET /readyz`, `GET /metrics` | Liveness, readiness, Prometheus. |

| Make target | What it does |
|---|---|
| `make up` / `down` / `clean` | Start the stack / stop it / stop it and wipe Postgres |
| `make tenant NAME=…` | Create a tenant, its atlas key (printed once) and its forge key |
| `make test` | All tests (`pip install -e '.[dev]'` first) |
| `make drill` | Kill-the-worker drill (needs the stack) |
| `make drill-fairness` | Noisy-neighbour drill (needs the stack) |
| `make logs` / `ps` / `lint` | Logs of api, worker and forge / container status / ruff |

The local stack runs forge with mock models, so answers are placeholder text. To get real answers, point forge's fallback at a real model (`FORGE_FALLBACK_BASE_URL`, `FORGE_FALLBACK_API_KEY`, `FORGE_FALLBACK_MODEL` on the `forge` service).

## How it works

### Why Postgres + pgvector, not Chroma

A document's chunks and its `ready` status must commit in one transaction. That's what lets the ingestion worker reuse shrtr's guarantee: commit, then acknowledge the stream message, so a crash in between causes a redelivery that changes nothing. With vectors in Chroma and status in Postgres, the two can't commit together. Postgres also makes tenant isolation a `WHERE tenant_id = …` on every search, and lets the API and several workers share one store.

Every chunk row carries its own `tenant_id`, so retrieval filters the chunks table directly and never relies on a join being written correctly. `tenant_id` is a required argument of `retrieve()`, so no caller can forget the filter.

There's no vector index yet. Each search scans one tenant's chunks through the `tenant_id` index, which is exact. An HNSW index filters *after* its approximate search and can return fewer than k rows for a small tenant; it waits until benchmarks show the scan is too slow.

### Chunking and embedding

- **Chunker:** the RAG app's semantic chunker, ported without LangChain. It splits pages into sentences, embeds each one, and starts a new chunk where the distance between neighbouring sentences is in the top 10% (a topic shift). Chunks are 250–1,000 characters, because MiniLM only reads about the first 1,000 characters of a text.
- **Fallback splitter:** when semantic chunking doesn't apply, it falls back to plain word packing with no overlap. The RAG app used LangChain's splitter with 200 characters of overlap; bring that back if evals show answers cut off at chunk edges.
- **Model:** `all-MiniLM-L6-v2` on CPU, with the same normalisation as the RAG app's local option, so its eval set carries over. A model of the wrong size fails at startup, not on the first insert.
- **Docker image:** about 2.2 GB, mostly CPU-only torch; plain `pip install torch` on x86 would pull the multi-GB CUDA build. The model is baked into the image and the Hugging Face hub is offline at runtime. The startup warning "Could not reach the Hub" is expected.

### Ingestion worker

Uploads go onto Redis Streams, and `app/worker.py` (a consumer group, ported from shrtr's analytics worker) does the parsing, chunking and embedding.

- **Fair across tenants.** Each tenant has its own stream (`ingest:<tenant_id>`), listed in a Redis set that the upload adds to in the same transaction. A worker takes its next document from the first tenant after the last one it served that has work waiting. One tenant's backlog therefore delays another tenant by at most one document per worker. It's forge's per-tenant queueing, in plain round-robin, and fair by document rather than by work: one huge PDF still holds a worker until it finishes.
- **Effectively once.** A document's chunks and its `ready` status commit in one transaction, under a row lock that backs off unless the row is still `pending`. The worker acknowledges the stream entry only after that commit, so a crash in between redelivers an entry that is then skipped.
- **Crash recovery.** A restarted worker comes back as the same consumer (same container hostname, pid 1) and resumes the entries it held. Entries held by a worker that never comes back are claimed by another worker after 2 minutes idle.
- **Re-uploads.** The previous ready version stays searchable until the new one commits. If uploads finish out of order, the older one is discarded. At most one ready version per name is enforced by a partial unique index.
- **Bad documents:**
  - A bad PDF (unreadable, no text, over 2,000 chunks) is marked `failed` with the reason.
  - An unexpected error while Postgres is up is marked `failed` and dead-lettered to `ingest:dlq`. While Postgres is down, nothing is dead-lettered; entries wait.
  - A document that kills the worker outright (OOM, segfault) raises nothing to catch. Each attempt is committed to `documents.attempts` *before* any work, so after 3 attempts that never finished, the next delivery dead-letters it. Redis's own delivery count can't do this job: it also climbs during a Postgres outage, which is the lesson from shrtr. This counter can't, since bumping it needs Postgres.
- **Redis down at upload:** the upload returns 503 and its row is deleted, so no document is left that nothing will ever process.

### Answers through forge

Every LLM call goes through forge with the asking tenant's own forge key. `make tenant` creates that key, stores it on the tenant, and appends the tenant to forge's tenants file. The file is `deploy/forge-tenants.yaml`, a gitignored copy of the `.example` file, and forge re-reads it every 30s. Because forge sees each atlas tenant as its own tenant:

- **Quotas and fair queueing are per tenant.** One tenant flooding `/ask` is shed by forge without slowing the others. forge's 429 is passed on with its `Retry-After`.
- **The cache is per tenant.** Calls use temperature 0, so forge caches answers. Its cache key includes the tenant and the whole prompt, retrieved context included. A re-indexed document therefore never gets a stale answer, and one tenant's question never hits another's cached answer.
- **Failover is free.** If the primary model dies, forge's circuit breaker sends calls to the fallback and `/ask` keeps answering.

A follow-up question (`history` given) is first rewritten into a standalone question, which is then used for both retrieval and the answer. That's two forge calls, as the RAG app's LangChain chain did. Prompts are the RAG app's: system rules above delimited, untrusted context. Each passage is labelled with its document and page so the model can cite it.

**Relevance floor.** If the best passage scores below 0.25 (`ASK_MIN_SCORE`), `/ask` answers "not in your documents" without calling forge. On the RAG app's gold set, answerable questions scored 0.42–0.72 and unanswerable ones 0.04–0.16. Off-topic questions therefore cost no tokens, and the model never gets unrelated text to guess from. That set is only 12 questions, so 0.25 is a starting value, not a tuned one.

forge errors: 429 passes through with `Retry-After`; an unknown key (a tenant forge hasn't reloaded yet) is 503; anything else is 502.

### Rate limits

Every tenant has two token buckets, using shrtr's Lua limiter (refill and take are atomic inside Redis):
- **uploads:** 10, refilling at 12 a minute
- **queries** (`/search` and `/ask`): 30, refilling at 1 a second

Limited responses carry `X-RateLimit-*` headers; refusals are 429 with `Retry-After`. If Redis is down, uploads return 503 (they need Redis to be queued anyway) and queries go through unlimited.

### Security layer on `/ask`

Ported from the RAG app:
- **PII:** emails, phone numbers, SSNs and card numbers are redacted from the question, the history and the rewritten follow-up before anything reaches forge. Names are kept, since they're what people ask their documents about.
- **Injection:** a question that looks like a prompt injection gets a 400. A history turn that does is dropped from the history instead, so one blocked question doesn't block the rest of the conversation.
- **Planted instructions:** retrieved passages containing instructions aimed at the model (indirect injection through an uploaded document) are left out of the prompt. The RAG app never checked documents. Four extra passages are fetched, so a withheld one doesn't shrink the answer's context.
- **Credentials:** API keys, passwords and tokens in the answer are masked.

One injection pattern covers questions, history and passages, and it only matches text aimed at the model ("ignore all previous instructions", "system prompt", "you are now DAN"). The RAG app's broader question patterns refused ordinary questions such as "What are the new rules for expenses?" or anything mentioning someone named Dan.

Each action is reported in the response's `security_warnings` and counted in `security_events_total`; the raw text is never logged. The patterns are regex only. The RAG app also ran Presidio (spaCy's ~600 MB model) first; it's left out to keep the image smaller and can be swapped in behind `redact_pii`.

### Readiness

`/readyz` returns 503 when Postgres or Redis is down. forge is reported but never fails readiness: without it, questions fail, but uploads and listing still work.

## How it's proven

60 tests (`make test`). Most run against real Postgres + pgvector in a separate `atlas_test` database, with fakeredis and the worker run in-process. A fake embedder maps identical text to identical vectors, so a query equal to a chunk's text is that chunk's exact nearest neighbour.

| Test file | What it proves |
|---|---|
| `test_isolation.py` | A tenant never sees another tenant's chunks, even when the other tenant holds the exact nearest neighbour. Listing, getting and deleting are tenant-scoped. Re-uploads are idempotent, and the old version stays searchable until the new one is ready. |
| `test_worker.py` | A redelivery after commit changes nothing. A restarted worker resumes the document it died holding. A document that keeps killing workers is dead-lettered. A bad PDF fails without being dead-lettered. An unexpected error is dead-lettered. An older upload finishing last is discarded. Redis down at upload leaves no orphan. One tenant's backlog doesn't delay another tenant's document. |
| `test_ask.py` | forge gets the tenant's own key, temperature 0 and only that tenant's context. Follow-ups are rewritten, then retrieved. No documents or no relevant passage means no forge call. forge failures map to honest statuses. PII never reaches forge. Injected questions are refused, and injected history turns dropped. Planted passages are left out. Credentials in answers are masked. |
| `test_ratelimit.py` | Buckets are per tenant and per kind (upload vs query); Redis down pauses uploads, not queries. |
| `test_security.py` | The ported patterns, including the ordinary questions and policy text they must *not* flag. |
| `test_chunking.py`, `test_health.py` | Fallback splitter limits; readiness gates on Postgres and Redis, not forge. |

Three tests were checked by breaking the code on purpose:
- **Isolation:** removing the tenant filter from retrieval makes the isolation test fail.
- **Fairness:** first-come, first-served order makes the fairness test fail (tenant B lands sixth, not second).
- **Redelivery:** the redelivery test asserts the attempt count, so reprocessing a finished document fails it.

### Drills (live stack)

**`make drill`** SIGKILLs the worker mid-document, restarts it, and checks the document lands exactly once against an undisturbed control run of the same PDF. If the document finished before the kill landed, it reports "inconclusive" instead of passing. Latest run:

| | |
|---|---|
| Control run | 300 pages → 562 chunks in 21.9s |
| Killed at | about a third of the way in, status `pending`, 1 attempt |
| Recovery | restarted worker resumed by itself; `ready` 24.4s later (includes reloading the model) |
| Checks | same chunk count as control; chunk rows match; no duplicates; 2 attempts; nothing pending; nothing dead-lettered |

**`make drill-fairness`**: tenant A queues six large PDFs, then tenant B uploads one page. B must wait about one of A's documents, not all of them.

| | B's one-page upload waited | A's backlog took |
|---|---|---|
| One shared stream (before) | **44.2s**, behind all five queued | 55s |
| Per-tenant streams (now) | **6.8s**, just for A's document in progress | 59s |

## Build log

What each phase built, the decisions that shaped it, and what was measured live.

### Phase 0: skeleton
- **Built:** a FastAPI app, settings, async SQLAlchemy, Alembic and latency metrics carried over from shrtr. One compose stack: pgvector, Redis, the API, and forge with its two mock models, built from the sibling forge checkout.
- **Decisions:**
  - forge shares atlas's Redis on db 1 (one Redis to run, separate keyspaces).
  - Only the API and forge are published, on localhost only.
  - `/readyz` reports forge but doesn't gate on it.
- **Verified live:** readiness OK; pgvector 0.8.7 installed by the first migration; forge answered through its own key; forge down → still ready; Redis down → 503.

### Phase 1: tenants and tenant-scoped retrieval
- **Built:**
  - Tenants, API keys stored as SHA-256 hashes, documents, and chunks with `vector(384)`.
  - Synchronous upload, with parsing and embedding run off the event loop. The RAG app's handler blocked it.
  - List, delete and search, all tenant-scoped.
  - `make tenant`.
- **New limits the RAG app declared but never enforced:** 10 MB per upload, 2,000 chunks per document.
- **Verified live** (Northwind handbook, 10 pages, real MiniLM):
  - On 9 answerable questions, the right passage came first 8 times and was in the top 4 every time.
  - 0 chunks leaked between two tenants holding rival vacation policies.
  - Upload took 0.3s.

### Phase 2: background ingestion
- **Built:**
  - Upload stores the PDF as a `pending` row and queues it, returning 202.
  - The Redis Streams worker, the dead-letter queue, and the attempts counter for crashes.
  - Re-uploads that keep the old version searchable.
  - The kill drill.
- **Verified live:** first drill run: 560 chunks in 13.1s undisturbed; killed about 4s in; recovered in 25.2s; every check passed.

### Phase 3: answers through forge
- **Built:** `/ask`, per-tenant forge keys (`make tenant` provisions forge too), temperature 0, follow-up rewriting, and labelled context for citations.
- **Verified live:**
  - forge accepted a new tenant about 16s after creation, with no restart.
  - The same question twice: cache miss, then cache hit.
  - The identical question from another tenant: a miss, answered from that tenant's own document.
  - Primary model stopped: answers came from the fallback with no errors.
  - forge metered the two tenants separately (2,452 vs 329 tokens).

### Phase 4: rate limits and security
- **Built:** shrtr's token buckets for uploads and queries, and the RAG app's security layer, plus the new screen for planted instructions in documents.
- **Verified live:**
  - The email in a question was redacted before reaching forge.
  - A page with planted instructions was left out of the prompt.
  - An injected question was refused with a 400.
  - Uploads 10–12 of a burst got 429.
  - Rate-limit headers and both new metrics appeared.

### Ponytail audit
A repo-wide pass for code that does nothing or repeats itself. It found 7 cuts, all applied:

| Cut | Replaced with |
|---|---|
| Dedupe between the worker's pending sweep and new reads | Nothing: `XREADGROUP >` only returns never-delivered entries, so they can't overlap |
| `HitOut` response model, a field-for-field copy of `Hit` | `Hit` is the response model |
| `app/core/queue.py`, one 3-line function with one caller | Inlined in the upload route |
| Hand-rolled cosine similarity | `math.sumprod`, since both embedders return unit vectors (Python 3.12) |
| Two injection pattern lists | One model-directed pattern (also a bug fix, see below) |
| An `Embedder` parameter and two `create_tenant` env vars nobody set | Constants |

The repo went from 2,258 to 2,228 lines while gaining features. The `sumprod` switch drops a normalisation step, and the rounding difference moved two borderline chunk breaks: the drill PDF went from 560 to 562 chunks. That's deterministic and harmless.

### Design review
A pass over every design decision so far, asking whether something could work better:

1. **Bug: ordinary questions were refused.** The question-injection patterns ported from the RAG app returned 400 for "What are the new rules for expense reports?", "Can managers override the default settings?", "Do I need to forget the old travel rules?" and "What did Dan say about Q3?". All four are now regression tests, and live, the same questions get answered.
2. **Relevance floor:** off-topic questions no longer call the LLM. The threshold was chosen from measured scores (see *Answers through forge*). Live, "Who won the 2018 World Cup?" made no forge call.
3. **Over-fetch before the security screen:** a document with planted text no longer shrinks the answer's context below k.
4. **Fair ingestion:** all tenants shared one first-come, first-served stream, so one tenant's big uploads delayed everyone. The drill was written first and failed on the old worker (44.2s). Per-tenant streams with round-robin took it to 6.8s.

## Known limits and open items

| Area | Limit | When it matters / what to do |
|---|---|---|
| Answers | The local stack's models are mocks, so answer quality and follow-up rewriting are unjudged | Point forge's fallback at Gemini, then run the RAG app's eval set |
| Ingestion | Each document is embedded twice: per sentence for chunking, then per chunk | About 2× ingestion CPU; use cheaper chunking if it becomes the bottleneck |
| Ingestion | Fair by document, not by size | Split very large PDFs, or weight by page count |
| Ingestion | A brand-new tenant's first upload can wait one worker poll (up to 5s) when idle | Fine; the worker notices new streams once per poll |
| Ingestion | Pending sweeps cost 2 Redis calls per tenant every 10th loop | Pipeline them at thousands of tenants |
| Ingestion | PDF bytes are kept in Postgres until processed | Object storage at larger scale |
| Not yet tested | Entries waiting through a Postgres outage; several workers at once (only one has run live) | Phase 6 drills; `docker compose up --scale worker=2` |
| Retrieval | No vector index (exact per-tenant scan) | Add HNSW with iterative scan when benchmarks show it's needed |
| `/ask` | No streaming | forge supports it; the navigator's SSE pattern fits |
| Security | Regex only; a 10-digit number like an order id is redacted as a phone number | Swap Presidio in behind `redact_pii` if precision matters |
| Tenants | forge keys stored in plain text (forge's file has them in plain text too); no delete-tenant command, so a deleted tenant's forge key would stay in forge's file | Add `make delete-tenant`; on GKE, forge's tenants come from a Secret |
| API | A missing API key returns 422 (shrtr behaves the same), not 401 | Make the header optional and return 401 |
| Auth | A deleted key keeps working for up to 60s per API replica (key cache) | Fine until keys can be revoked |

## Repository layout

```
app/
  main.py                 app wiring (lifespan: Postgres, Redis, forge client, embedder, limiter)
  config.py               settings from env; stream naming
  worker.py               ingestion worker: fairness, delivery guarantees, bad-document handling
  api/
    deps.py               API key → tenant, token-bucket dependencies
    routes_documents.py   upload, list, get, delete, search
    routes_ask.py         /ask and the security layer around it
    routes_health.py      healthz, readyz
  core/
    chunking.py           PDF → pages → semantic chunks → embeddings
    embeddings.py         MiniLM on CPU
    retrieval.py          tenant-scoped nearest-chunk search
    answer.py             prompts and the forge call
    ratelimit.py          shrtr's Lua token bucket
    security.py           PII, injection, credential patterns
  models/__init__.py      SQLAlchemy models
  observability/metrics.py
  scripts/create_tenant.py
migrations/versions/      0001 pgvector · 0002 tables · 0003 async ingestion · 0004 forge keys
scripts/                  drill_kill_worker.py, drill_noisy_neighbour.py
tests/                    see "How it's proven"
deploy/forge-tenants.example.yaml
docker/Dockerfile, docker-compose.yml, Makefile
```

## Roadmap

- [x] **Phase 0:** skeleton: API, pgvector, Redis, forge + mock models in one compose stack
- [x] **Phase 1:** tenants, API keys, chunks table; tenant-scoped upload and retrieval
- [x] **Phase 2:** background ingestion over Redis Streams (worker, dead-letter queue, kill-the-worker drill)
- [x] **Phase 3:** all LLM calls through forge, one forge key per tenant
- [x] **Phase 4:** token-bucket rate limits and the security layer
- [x] **Audit and design review:** ponytail cuts, injection false positives, relevance floor, fair ingestion
- [ ] **Phase 5:** MCP server (`search_documents`, `ask`, `list_documents`)
- [ ] **Phase 6:** evals, failure drills and benchmarks gated in CI
