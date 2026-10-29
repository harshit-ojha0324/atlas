"""Retrieval and grounding eval, end to end through the running stack.

The RAG app's eval set (scripts/eval_set.py), run against the real pipeline.
The RAG app's own eval embedded pre-split passages in memory and skipped PDF
parsing, chunking, the vector store and the chain; here the handbook goes in as
a PDF (one passage per page), through the worker's parsing, semantic chunking
and embedding, into pgvector, and every question goes through /search and /ask.

Gated (exit 1 below --threshold):
- context relevance: for answerable questions, the page holding the answer is
  in /search's top k (hit@k; hit@1 is reported too).
- grounded-response rate: an answerable question gets an answer (not "not in
  your documents") citing the right page, with the gold fact in the retrieved
  text; an out-of-scope question is declined without an LLM call (the relevance
  floor). With --judge-answers, the answer itself must contain the gold fact:
  use it only when forge has a real model behind it, not the mocks.

Needs the stack up (`make up`). Run: make eval
"""

import argparse
import sys
import time

from eval_set import CORPUS, GOLD
from stack import create_tenant, delete_tenants, make_pdf, wait_for_forge

PAGE_OF = {passage["id"]: page for page, passage in enumerate(CORPUS, 1)}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--k", type=int, default=4)
    # one miss of 9 (or 12) passes, two fail; the pipeline is deterministic, so a miss is a real regression
    ap.add_argument("--threshold", type=float, default=0.85)
    ap.add_argument("--judge-answers", action="store_true", help="needs a real model behind forge")
    args = ap.parse_args()

    tenant = create_tenant("eval")
    try:
        t0 = time.monotonic()
        doc = tenant.wait_ready(tenant.upload("handbook.pdf", make_pdf([p["text"] for p in CORPUS]))["id"])
        took = time.monotonic() - t0
        print(f"handbook: {doc['pages']} pages -> {doc['chunk_count']} chunks in {took:.1f}s")
        wait_for_forge(tenant, GOLD[0]["question"])

        rows, hits_at_1, hits_at_k, grounded = [], 0, 0, 0
        answerable = [g for g in GOLD if g["answerable"]]
        for g in GOLD:
            results = tenant.call("POST", "/search", json={"query": g["question"], "k": args.k}).json()
            r = tenant.call("POST", "/ask", json={"question": g["question"], "k": args.k})
            r.raise_for_status()
            out = r.json()
            declined = out["forge_backend"] is None and not out["sources"]
            top = results[0]["score"] if results else 0.0
            if g["answerable"]:
                want = {PAGE_OF[i] for i in g["relevant_ids"]}
                pages = [h["page"] for h in results]
                hit1, hitk = pages[:1] and pages[0] in want, bool(want & set(pages))
                hits_at_1 += bool(hit1)
                hits_at_k += hitk
                fact = g["answer_substring"].lower()
                ok = (
                    not declined
                    and bool(want & {s["page"] for s in out["sources"]})
                    and any(fact in h["text"].lower() for h in results)
                    and (not args.judge_answers or fact in out["answer"].lower())
                )
                kind = f"ANSW hit@1={int(bool(hit1))} hit@{args.k}={int(hitk)}"
            else:
                ok = declined
                kind = "OOS  declined" if declined else "OOS  ANSWERED"
            grounded += ok
            rows.append(f"  [{'PASS' if ok else 'FAIL'}] {kind:<18} top={top:.2f}  {g['question'][:52]}")
    finally:
        delete_tenants(tenant)

    relevance = hits_at_k / len(answerable)
    rate = grounded / len(GOLD)
    print(f"\nRetrieval & grounding eval, end to end (k={args.k}, {len(GOLD)} questions)")
    print("-" * 86)
    print("\n".join(rows))
    print("-" * 86)
    print(f"  context relevance (answerable hit@{args.k}) : {relevance:.0%}")
    print(f"  answerable hit@1                     : {hits_at_1}/{len(answerable)}")
    print(f"  grounded-response rate               : {rate:.0%}")
    if relevance < args.threshold or rate < args.threshold:
        sys.exit(f"FAIL: below {args.threshold:.0%}")
    print(f"PASS (threshold {args.threshold:.0%})")


if __name__ == "__main__":
    main()
