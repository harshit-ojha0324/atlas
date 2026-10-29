"""Kill-the-worker drill.

SIGKILL the ingestion worker while it is mid-document, restart it, and check
the document still lands exactly once: status ready, the same chunk count as an
undisturbed control run of the same PDF, no duplicate chunks, nothing left
pending, nothing dead-lettered.

Needs the stack up (`make up`) and the real embedder. Run: make drill
"""

import sys
import time

from stack import big_pdf, compose, create_tenant, delete_tenants, psql, redis, wait_for


def main() -> None:
    tenant = create_tenant("drill")
    data = big_pdf()
    dlq_before = int(redis("XLEN", "ingest:dlq"))

    def pending_entries() -> int:
        return int(redis("XPENDING", tenant.stream, "ingesters").splitlines()[0])

    try:
        # 1. control: the same PDF, undisturbed
        t0 = time.monotonic()
        control = tenant.wait_ready(tenant.upload("control.pdf", data)["id"], 300)
        control_s = time.monotonic() - t0
        print(f"control: {control['chunk_count']} chunks from {control['pages']} pages in {control_s:.1f}s")
        if control_s < 3:
            sys.exit("INCONCLUSIVE: ingest is too fast to kill mid-document; raise big_pdf(pages=...)")

        # 2. the drill document: wait until the worker holds it, then kill it mid-ingest
        doc = tenant.upload("drill.pdf", data)
        wait_for(lambda: pending_entries() == 1, 30, "the worker to take the entry")
        time.sleep(control_s / 3)
        compose("kill", "-s", "SIGKILL", "worker")
        killed = tenant.status(doc["id"])
        if killed["status"] != "pending":
            sys.exit(f"INCONCLUSIVE: the document was already {killed['status']} when the worker died")
        attempts = psql(f"SELECT attempts FROM documents WHERE id = {doc['id']}")
        print(
            f"killed worker mid-ingest: status pending, attempts {attempts},"
            f" {pending_entries()} entry pending"
        )

        # 3. restart: the same container comes back as the same consumer and resumes its entry
        t1 = time.monotonic()
        compose("start", "worker")
        done = tenant.wait_ready(doc["id"], 300)
        print(f"restarted: {done['status']} after {time.monotonic() - t1:.1f}s")

        # 4. exactly once
        rows, distinct_idx = psql(
            f"SELECT count(*), count(DISTINCT idx) FROM chunks WHERE document_id = {doc['id']}"
        ).split("|")
        attempts = psql(f"SELECT attempts FROM documents WHERE id = {doc['id']}")
        checks = {
            "status is ready": done["status"] == "ready",
            "chunk_count matches the control": done["chunk_count"] == control["chunk_count"],
            "chunk rows match chunk_count": int(rows) == done["chunk_count"],
            "no duplicate chunks": int(distinct_idx) == int(rows),
            "two attempts recorded (killed + finished)": attempts == "2",
            "nothing left pending": pending_entries() == 0,
            "nothing dead-lettered": int(redis("XLEN", "ingest:dlq")) == dlq_before,
        }
        for check, ok in checks.items():
            print(f"  {'PASS' if ok else 'FAIL'}  {check}")
        if not all(checks.values()):
            sys.exit(1)
        print("drill passed")
    finally:
        compose("start", "worker")  # never leave the stack without a worker
        delete_tenants(tenant)


if __name__ == "__main__":
    main()
