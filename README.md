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

Unit tests need no Docker: `pip install -e '.[dev]' && make test`.

## Why Postgres + pgvector, not Chroma

A document's chunks and its `ready` status must commit in one transaction. That's what lets the ingestion worker reuse shrtr's guarantee: commit, then acknowledge the stream message, so a crash in between causes a redelivery that changes nothing. With vectors in Chroma and status in Postgres, the two can't commit together. Postgres also makes tenant isolation a `WHERE tenant_id = …` on every search, and lets the API and several workers share one store.

## Readiness

`/readyz` returns 503 when Postgres or Redis is down. forge is reported but never fails readiness: without it, questions fail, but uploads and listing still work.

## Roadmap

- [x] **Phase 0:** skeleton: API, pgvector, Redis, forge + mock models in one compose stack
- [ ] **Phase 1:** tenants, API keys, chunks table; synchronous upload and tenant-scoped retrieval
- [ ] **Phase 2:** background ingestion over Redis Streams (worker, dead-letter queue, kill-the-worker drill)
- [ ] **Phase 3:** all LLM calls through forge, one forge key per tenant
- [ ] **Phase 4:** token-bucket rate limits and the security layer
- [ ] **Phase 5:** MCP server (`search_documents`, `ask`, `list_documents`)
- [ ] **Phase 6:** evals, failure drills and benchmarks gated in CI
