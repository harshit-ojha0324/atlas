# Benchmark, 2026-10-28

`make bench`: k6 2.3.0 at a constant arrival rate for 60s, 50 req/s on `POST /search` and 10 req/s on `POST /ask`, against the full local stack. Raw numbers are in [`k6-summary.json`](k6-summary.json).

**Setup**
- Apple M3 Pro. Docker Desktop VM: 11 CPUs, 8 GB.
- One API container (single uvicorn process) and one worker.
- forge runs with its mock models.
- One tenant, with the 10-page eval handbook indexed (10 chunks).

**Conditions**
- **Query rate limit lifted for the run.** Otherwise the benchmark would measure the 30-request bucket, not the service.
- **forge's cache warmed first.** A cold `/ask` call to the mock model is its simulated generation time (80 tokens/s), which says nothing about atlas. So `/ask` here measures atlas's own path: security layer, query embedding, retrieval, and a forge cache hit.

## Result

| Endpoint | Requests | Median | p95 | p99 | Max | Errors |
|---|---|---|---|---|---|---|
| `/search` | 2,998 | 14.0 ms | 24.3 ms | 274.7 ms | 493 ms | 0 |
| `/ask` | 601 | 18.9 ms | 31.3 ms | 301.2 ms | 467 ms | 0 |

The CI gate is under 1% errors, p95 under 250 ms (`/search`) and under 500 ms (`/ask`).

## Single-threaded query embedding

By default torch gives every call all the cores, so concurrent query embeddings in the API compete for them. With `torch.set_num_threads(1)` in the API (the worker keeps the default), the same load gave:

| `/search` | Median | p95 |
|---|---|---|
| torch default (one run) | 18.7 ms | 82.1 ms |
| one thread per query (five runs) | 11.9–14.0 ms | 16.4–24.3 ms |

p99 is not comparable between runs. At 60s it rests on the slowest ~30 requests, and on a laptop it ranged from 25 ms to 275 ms across otherwise identical runs. Setting `OMP_NUM_THREADS=1` before torch loads made no repeatable difference beyond `set_num_threads`, so it was not kept.
