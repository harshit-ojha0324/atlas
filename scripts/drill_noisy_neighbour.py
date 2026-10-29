"""Noisy-neighbour drill.

Tenant A queues several large PDFs, then tenant B uploads one small one. With
fair ingestion, B waits for at most about one of A's documents per worker,
not for A's whole backlog.

Needs the stack up (`make up`) with one worker. Run: make drill-fairness
"""

import sys
import time

from stack import big_pdf, create_tenant, delete_tenants, make_pdf

BACKLOG = 6


def main() -> None:
    a, b = create_tenant("noisy"), create_tenant("quiet")
    try:
        # A's documents differ by a page, so none is skipped as a duplicate
        big = [big_pdf(pages=150 + i) for i in range(BACKLOG)]
        t0 = time.monotonic()
        a.wait_ready(a.upload("a0.pdf", big[0])["id"])
        one_doc_s = time.monotonic() - t0
        print(f"one of A's documents alone: {one_doc_s:.1f}s")

        a_docs = [a.upload(f"a{i}.pdf", pdf) for i, pdf in enumerate(big[1:], 1)]
        time.sleep(1)  # the worker is now busy with A's backlog
        t1 = time.monotonic()
        b.wait_ready(b.upload("b.pdf", make_pdf(["One short page."]))["id"])
        b_wait = time.monotonic() - t1
        print(f"B's one-page document waited {b_wait:.1f}s behind A's backlog of {len(a_docs)}")
        for d in a_docs:
            a.wait_ready(d["id"])
        print(f"A's backlog finished {time.monotonic() - t0:.1f}s after A's first upload")

        limit = 2.5 * one_doc_s  # about one of A's documents, plus slack
        ok = b_wait <= limit
        print(f"  {'PASS' if ok else 'FAIL'}  B waited about one of A's documents at most")
        print(f"        ({b_wait:.1f}s <= {limit:.1f}s)")
        if not ok:
            sys.exit(1)
        print("drill passed")
    finally:
        delete_tenants(a, b)


if __name__ == "__main__":
    main()
