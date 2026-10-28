"""Kill-the-worker drill.

SIGKILL the ingestion worker while it is mid-document, restart it, and check
the document still lands exactly once: status ready, the same chunk count as an
undisturbed control run of the same PDF, no duplicate chunks, nothing left
pending, nothing dead-lettered.

Needs the stack up (`make up`) and the real embedder. Run: make drill
"""

import subprocess
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))
from helpers import make_pdf  # noqa: E402

API = "http://localhost:8000"
TOPICS = ["pump maintenance", "budget review", "safety audit", "staff rota", "water quality", "grid load"]


def compose(*args: str) -> str:
    return subprocess.run(["docker", "compose", *args], check=True, capture_output=True, text=True).stdout


def psql(sql: str) -> str:
    return compose("exec", "-T", "postgres", "psql", "-U", "atlas", "-tAc", sql).strip()


def redis(*args: str) -> str:
    return compose("exec", "-T", "redis", "redis-cli", *args).strip()


def pending_entries(stream: str) -> int:
    return int(redis("XPENDING", stream, "ingesters").splitlines()[0])


def wait_for(predicate, timeout_s: float, what: str):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if result := predicate():
            return result
        time.sleep(0.2)
    sys.exit(f"FAIL: timed out after {timeout_s}s waiting for {what}")


def big_pdf(pages: int = 300) -> bytes:
    """Enough sentences that semantic chunking + embedding takes several seconds."""
    return make_pdf(
        [
            " ".join(
                f"Section {p}.{s} covers {TOPICS[(p + s) % len(TOPICS)]} at site {p * 7 % 13}. "
                f"The team logged {p * 31 % 97 + s} items and flagged {s % 4} issues for follow-up."
                for s in range(6)
            )
            for p in range(1, pages + 1)
        ]
    )


def main() -> None:
    name = f"drill-{int(time.time())}"
    out = compose("run", "--rm", "--no-deps", "api", "python", "-m", "app.scripts.create_tenant", name)
    key = out.split("(shown once): ")[1].strip()
    stream = f"ingest:{out.split('(id ')[1].split(')')[0]}"  # the tenant's own ingestion stream
    client = httpx.Client(base_url=API, headers={"X-API-Key": key}, timeout=60)
    data = big_pdf()
    dlq_before = int(redis("XLEN", "ingest:dlq"))

    def status(doc_id: int) -> dict:
        return client.get(f"/documents/{doc_id}").json()

    try:
        # 1. control: the same PDF, undisturbed
        t0 = time.monotonic()
        control = client.post("/documents", files={"file": ("control.pdf", data, "application/pdf")}).json()
        control = wait_for(
            lambda: (s := status(control["id"]))["status"] == "ready" and s, 300, "control ingest"
        )
        control_s = time.monotonic() - t0
        print(f"control: {control['chunk_count']} chunks from {control['pages']} pages in {control_s:.1f}s")
        if control_s < 3:
            sys.exit("INCONCLUSIVE: ingest is too fast to kill mid-document; raise big_pdf(pages=...)")

        # 2. the drill document: wait until the worker holds it, then kill it mid-ingest
        doc = client.post("/documents", files={"file": ("drill.pdf", data, "application/pdf")}).json()
        wait_for(lambda: pending_entries(stream) == 1, 30, "the worker to take the entry")
        time.sleep(control_s / 3)
        compose("kill", "-s", "SIGKILL", "worker")
        killed = status(doc["id"])
        if killed["status"] != "pending":
            sys.exit(f"INCONCLUSIVE: the document was already {killed['status']} when the worker died")
        attempts = psql(f"SELECT attempts FROM documents WHERE id = {doc['id']}")
        print(
            f"killed worker mid-ingest: status pending, attempts {attempts},"
            f" {pending_entries(stream)} entry pending"
        )

        # 3. restart: the same container comes back as the same consumer and resumes its entry
        t1 = time.monotonic()
        compose("start", "worker")
        done = wait_for(lambda: (s := status(doc["id"]))["status"] != "pending" and s, 300, "recovery")
        print(f"restarted: {done['status']} after {time.monotonic() - t1:.1f}s")

        # 4. exactly once
        rows, distinct_idx = psql(
            f"SELECT count(*), count(DISTINCT idx) FROM chunks WHERE document_id = {doc['id']}"
        ).split("|")
        checks = {
            "status is ready": done["status"] == "ready",
            "chunk_count matches the control": done["chunk_count"] == control["chunk_count"],
            "chunk rows match chunk_count": int(rows) == done["chunk_count"],
            "no duplicate chunks": int(distinct_idx) == int(rows),
            "two attempts recorded (killed + finished)": psql(
                f"SELECT attempts FROM documents WHERE id = {doc['id']}"
            )
            == "2",
            "nothing left pending": pending_entries(stream) == 0,
            "nothing dead-lettered": int(redis("XLEN", "ingest:dlq")) == dlq_before,
        }
        for check, ok in checks.items():
            print(f"  {'PASS' if ok else 'FAIL'}  {check}")
        if not all(checks.values()):
            sys.exit(1)
        print("drill passed")
    finally:
        compose("start", "worker")  # never leave the stack without a worker
        psql(f"DELETE FROM tenants WHERE name = '{name}'")


if __name__ == "__main__":
    main()
