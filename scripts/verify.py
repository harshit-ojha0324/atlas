"""Run the project's checks and record the results for the System page.

The results go in app/observability/verification.json, which is committed and
built into the image. They're a record of real runs, with the date and commit
of each, and the page says so: nothing here is live. A check that isn't run
keeps its last recorded result.

Needs the stack up (`make up`). Run: make verify
  --ui     also the interface smoke test (needs Vite running, and Playwright on NODE_PATH)
  --judge  also judge answer content (needs a real model; see the README's Quick start)
"""

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RECORD = ROOT / "app" / "observability" / "verification.json"
PY = sys.executable

# id, label, command, and the patterns that pull the summary out of its output
CHECKS = {
    "tests": ("Backend tests", [PY, "-m", "pytest", "-q"], [r"(\d+ passed)"]),
    "eval": (
        "Retrieval evaluation",
        [PY, "scripts/run_eval.py"],
        [r"context relevance[^:]*: (\d+%)", r"grounded-response rate\s*: (\d+%)"],
    ),
    "drill": (
        "Worker killed mid-document",
        [PY, "scripts/drill_kill_worker.py"],
        [r"(\d+/\d+ checks? pass\w*)"],
    ),
    "fairness": (
        "Noisy neighbour",
        [PY, "scripts/drill_noisy_neighbour.py"],
        [r"(tenant B waited [\d.]+ ?s[^\n]*)"],
    ),
}
UI_CHECK = ("Interface smoke test", ["node", "frontend/tests/ui-smoke.cjs"], [r"(\d+ checks passed)"])
JUDGE_CHECK = (
    "Answer content, judged on a real model",
    [PY, "scripts/run_eval.py", "--judge-answers"],
    [r"(\d+/\d+ answers[^\n]*)"],
)


def summarize(output: str, patterns: list[str]) -> str:
    found = [m.group(1).strip() for p in patterns if (m := re.search(p, output))]
    return ", ".join(found) if found else output.strip().splitlines()[-1][:120] if output.strip() else ""


def demo() -> None:
    assert summarize("12 passed in 3s\n", [r"(\d+ passed)"]) == "12 passed"
    assert summarize("a\nlast line\n", [r"(nope)"]) == "last line"
    assert summarize("", [r"(nope)"]) == ""


def main() -> None:
    demo()
    parser = argparse.ArgumentParser()
    parser.add_argument("--ui", action="store_true")
    parser.add_argument("--judge", action="store_true")
    args = parser.parse_args()

    checks = dict(CHECKS)
    if args.ui:
        checks["ui"] = UI_CHECK
    if args.judge:
        checks["eval-judged"] = JUDGE_CHECK

    commit = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True).strip()
    record = {entry["id"]: entry for entry in json.loads(RECORD.read_text())} if RECORD.exists() else {}
    failed = []
    for check_id, (label, command, patterns) in checks.items():
        print(f"--- {label}", flush=True)
        run = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
        passed = run.returncode == 0
        record[check_id] = {
            "id": check_id,
            "label": label,
            "passed": passed,
            "detail": summarize(run.stdout + run.stderr, patterns),
            "date": dt.date.today().isoformat(),
            "commit": commit,
        }
        print(("PASS " if passed else "FAIL ") + record[check_id]["detail"], flush=True)
        if not passed:
            failed.append(label)
            print((run.stdout + run.stderr)[-2000:])

    order = [*CHECKS, "ui", "eval-judged"]
    entries = sorted(record.values(), key=lambda e: order.index(e["id"]))
    RECORD.write_text(json.dumps(entries, indent=2) + "\n")
    if failed:
        sys.exit(f"FAILED: {', '.join(failed)}")


if __name__ == "__main__":
    main()
