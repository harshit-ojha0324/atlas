"""Load benchmark: k6 (bench/search_ask.js) against /search and /ask on the live stack.

Restarts the API with the query bucket effectively unlimited for the run (a
benchmark through a 30-request bucket would measure the bucket), and restores
the defaults afterwards. k6's thresholds are the gate: under 1% errors, and p95
latencies under --search-p95-ms and --ask-p95-ms. Exit code 99 means a
threshold was crossed.

Needs the stack up (`make up`). Run: make bench
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

from eval_set import CORPUS, GOLD
from stack import AS_HOST_USER, compose, create_tenant, delete_tenants, make_pdf, wait_for_forge

K6_IMAGE = "grafana/k6:2.3.0"
ROOT = Path(__file__).resolve().parents[1]
UNLIMITED = {"RATE_QUERY_CAPACITY": "1000000", "RATE_QUERY_REFILL_PER_S": "1000000"}
DEFAULT_LIMITS = {"RATE_QUERY_CAPACITY": "30", "RATE_QUERY_REFILL_PER_S": "1.0"}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--duration", default="60s")
    ap.add_argument("--search-rps", type=int, default=50)
    ap.add_argument("--ask-rps", type=int, default=10)
    ap.add_argument("--search-p95-ms", type=int, default=250)
    ap.add_argument("--ask-p95-ms", type=int, default=500)
    ap.add_argument("--out", default="benchmarks/latest", help="where k6's summary JSON goes")
    args = ap.parse_args()
    out = ROOT / args.out
    out.mkdir(parents=True, exist_ok=True)

    compose("up", "-d", "--wait", "api", env=UNLIMITED)
    tenant = create_tenant("bench")
    try:
        doc = tenant.upload("handbook.pdf", make_pdf([p["text"] for p in CORPUS]))
        tenant.wait_ready(doc["id"])
        questions = [g["question"] for g in GOLD if g["answerable"]]
        wait_for_forge(tenant, questions[0])
        # Warm forge's cache: a cold call to the mock model is its simulated
        # generation time (80 tokens/s), which says nothing about atlas.
        for q in questions:
            tenant.call("POST", "/ask", json={"question": q})

        k6 = subprocess.run(
            [
                "docker", "run", "--rm",
                # on the stack's own network: the API's published port is
                # 127.0.0.1-only, which a container can't reach on Linux
                "--network", "atlas_default",
                # k6's image runs as its own user, which can't write a folder the
                # host user owns on Linux; write the summary as the host user
                *AS_HOST_USER,
                "-v", f"{ROOT / 'bench'}:/bench:ro", "-v", f"{out}:/out",
                K6_IMAGE, "run", "--quiet",
                "--summary-export", "/out/k6-summary.json",
                "--summary-trend-stats", "avg,med,p(95),p(99),max",
                "-e", "BASE_URL=http://api:8000",
                "-e", f"API_KEY={tenant.key}",
                "-e", f"QUESTIONS={json.dumps(questions)}",
                "-e", f"DURATION={args.duration}",
                "-e", f"SEARCH_RPS={args.search_rps}", "-e", f"ASK_RPS={args.ask_rps}",
                "-e", f"SEARCH_P95_MS={args.search_p95_ms}", "-e", f"ASK_P95_MS={args.ask_p95_ms}",
                "/bench/search_ask.js",
            ],
        )  # fmt: skip
    finally:
        delete_tenants(tenant)
        compose("up", "-d", "--wait", "api", env=DEFAULT_LIMITS)

    summary = json.loads((out / "k6-summary.json").read_text())["metrics"]
    print(f"\n{'':8} {'requests':>9} {'med ms':>8} {'p95 ms':>8} {'p99 ms':>8} {'max ms':>8}")
    for name in ("search", "ask"):
        d = summary[f"http_req_duration{{scenario:{name}}}"]
        reqs = summary.get(f"http_reqs{{scenario:{name}}}", {}).get("count", "")
        print(f"{name:8} {reqs:>9} {d['med']:8.1f} {d['p(95)']:8.1f} {d['p(99)']:8.1f} {d['max']:8.1f}")
    failed = summary["http_req_failed"]
    error_rate = failed.get("value", failed.get("rate", 0))
    print(f"errors: {error_rate:.2%} of {summary['http_reqs']['count']} requests")
    print(f"summary: {out / 'k6-summary.json'}")
    if k6.returncode:
        sys.exit(f"FAIL: k6 exited {k6.returncode} (99 = a threshold was crossed)")
    print("benchmark passed")


if __name__ == "__main__":
    main()
