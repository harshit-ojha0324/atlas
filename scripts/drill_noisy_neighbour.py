"""Noisy-neighbour drill.

Tenant A queues several large PDFs, then tenant B uploads one small one. With
fair ingestion, B waits for at most about one of A's documents per worker,
not for A's whole backlog.

Needs the stack up (`make up`) with one worker. Run: make drill-fairness
"""

import subprocess
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))
from drill_kill_worker import big_pdf  # noqa: E402
from helpers import make_pdf  # noqa: E402

API = "http://localhost:8000"
BACKLOG = 6


def compose(*args: str) -> str:
    return subprocess.run(["docker", "compose", *args], check=True, capture_output=True, text=True).stdout


def create_tenant(name: str) -> httpx.Client:
    out = compose("run", "--rm", "--no-deps", "api", "python", "-m", "app.scripts.create_tenant", name)
    key = out.split("(shown once): ")[1].strip()
    return httpx.Client(base_url=API, headers={"X-API-Key": key}, timeout=60)


def wait_ready(client: httpx.Client, doc_id: int, timeout_s: float = 600) -> float:
    start = time.monotonic()
    while time.monotonic() - start < timeout_s:
        if client.get(f"/documents/{doc_id}").json()["status"] != "pending":
            return time.monotonic() - start
        time.sleep(0.2)
    sys.exit(f"FAIL: document {doc_id} still pending after {timeout_s}s")


def main() -> None:
    stamp = int(time.time())
    a, b = create_tenant(f"noisy-{stamp}"), create_tenant(f"quiet-{stamp}")
    try:
        # A's documents differ by a page, so none is skipped as a duplicate
        big = [big_pdf(pages=150 + i) for i in range(BACKLOG)]
        t0 = time.monotonic()
        first = a.post("/documents", files={"file": ("a0.pdf", big[0], "application/pdf")}).json()
        one_doc_s = wait_ready(a, first["id"])
        print(f"one of A's documents alone: {one_doc_s:.1f}s")

        a_docs = [
            a.post("/documents", files={"file": (f"a{i}.pdf", pdf, "application/pdf")}).json()
            for i, pdf in enumerate(big[1:], 1)
        ]
        time.sleep(1)  # the worker is now busy with A's backlog
        quiet = b.post(
            "/documents", files={"file": ("b.pdf", make_pdf(["One short page."]), "application/pdf")}
        )
        b_wait = wait_ready(b, quiet.json()["id"])
        print(f"B's one-page document waited {b_wait:.1f}s behind A's backlog of {len(a_docs)}")
        for d in a_docs:
            wait_ready(a, d["id"])
        print(f"A's backlog finished {time.monotonic() - t0:.1f}s after A's first upload")

        limit = 2.5 * one_doc_s  # about one of A's documents, plus slack
        ok = b_wait <= limit
        print(
            f"  {'PASS' if ok else 'FAIL'}  B waited about one of A's documents at most"
            f" ({b_wait:.1f}s <= {limit:.1f}s)"
        )
        if not ok:
            sys.exit(1)
        print("drill passed")
    finally:
        compose(
            "exec",
            "-T",
            "postgres",
            "psql",
            "-U",
            "atlas",
            "-qc",
            f"DELETE FROM tenants WHERE name IN ('noisy-{stamp}', 'quiet-{stamp}')",
        )


if __name__ == "__main__":
    main()
