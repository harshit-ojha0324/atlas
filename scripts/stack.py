"""Helpers for the scripts that run against the live stack: drills, eval, benchmark.

Run them from the repo root with the stack up (`make up`).
"""

import os
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))
from helpers import make_pdf  # noqa: E402

API = "http://localhost:8000"
# create_tenant appends to the bind-mounted forge tenants file. On Linux the
# container's own user (uid 10001) can't write a file the host user owns, so it
# runs as the host user (Docker Desktop ignores ownership, so it worked there).
AS_HOST_USER = ("--user", f"{os.getuid()}:{os.getgid()}")
FORGE_TENANTS_FILE = Path("deploy/forge-tenants.yaml")
TOPICS = ["pump maintenance", "budget review", "safety audit", "staff rota", "water quality", "grid load"]


def compose(*args: str, env: dict | None = None) -> str:
    r = subprocess.run(
        ["docker", "compose", *args], capture_output=True, text=True, env={**os.environ, **(env or {})}
    )
    if r.returncode:
        sys.exit(f"FAIL: docker compose {' '.join(args)} exited {r.returncode}:\n{r.stderr or r.stdout}")
    return r.stdout


def psql(sql: str) -> str:
    return compose("exec", "-T", "postgres", "psql", "-U", "atlas", "-tAc", sql).strip()


def redis(*args: str) -> str:
    return compose("exec", "-T", "redis", "redis-cli", *args).strip()


def wait_for(predicate, timeout_s: float, what: str, every_s: float = 0.2):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if result := predicate():
            return result
        time.sleep(every_s)
    sys.exit(f"FAIL: timed out after {timeout_s}s waiting for {what}")


@dataclass
class Tenant:
    name: str
    id: int
    key: str
    client: httpx.Client

    @property
    def stream(self) -> str:
        return f"ingest:{self.id}"

    def call(self, method: str, path: str, **kwargs) -> httpx.Response:
        """A request that waits out the tenant's rate limit instead of failing on it."""
        while (r := self.client.request(method, path, **kwargs)).status_code == 429:
            time.sleep(int(r.headers.get("retry-after", "1")))
        return r

    def upload(self, name: str, data: bytes) -> dict:
        r = self.call("POST", "/documents", files={"file": (name, data, "application/pdf")})
        r.raise_for_status()
        return r.json()

    def status(self, doc_id: int) -> dict:
        return self.call("GET", f"/documents/{doc_id}").json()

    def wait_ready(self, doc_id: int, timeout_s: float = 600) -> dict:
        def done():
            s = self.status(doc_id)
            return s if s["status"] != "pending" else None

        return wait_for(done, timeout_s, f"document {doc_id}")


def create_tenant(prefix: str) -> Tenant:
    name = f"{prefix}-{int(time.time() * 1000)}"
    out = compose(
        "run", "--rm", "--no-deps", *AS_HOST_USER, "api", "python", "-m", "app.scripts.create_tenant", name
    )
    key = out.split("(shown once): ")[1].strip()
    tenant_id = int(out.split("(id ")[1].split(")")[0])
    client = httpx.Client(base_url=API, headers={"X-API-Key": key}, timeout=120)
    return Tenant(name, tenant_id, key, client)


def wait_for_forge(tenant: Tenant, question: str) -> None:
    """forge re-reads its tenants file every 30s; until then /ask is 503 for a new tenant.
    `question` must match the tenant's documents, or /ask never reaches forge."""
    wait_for(
        lambda: tenant.call("POST", "/ask", json={"question": question}).status_code != 503,
        60,
        "forge to accept the tenant",
        every_s=2,
    )


def delete_tenants(*tenants: Tenant) -> None:
    """Delete the tenants and their forge keys. The forge file is rewritten in
    place, keeping its inode, so forge's bind mount keeps seeing it."""
    psql("DELETE FROM tenants WHERE name IN (" + ", ".join(f"'{t.name}'" for t in tenants) + ")")
    drop = {f"  - name: atlas-{t.name}" for t in tenants}
    lines = FORGE_TENANTS_FILE.read_text().splitlines(keepends=True)
    kept, skip = [], 0
    for line in lines:
        if line.rstrip("\n") in drop:
            skip = 3  # the entry's name, api_key and daily_token_quota lines
        if skip:
            skip -= 1
            continue
        kept.append(line)
    with FORGE_TENANTS_FILE.open("r+") as f:
        f.write("".join(kept))
        f.truncate()


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
