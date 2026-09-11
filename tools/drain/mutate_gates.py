"""Mutation-test the drain gates: does the suite actually kill a real defect?

    python tools/drain/mutate_gates.py

A green suite is AMBIGUOUS -- it means either the tests discriminate or they are
blind, and nothing in a passing run tells you which. So each arm below
reintroduces a defect that actually HAPPENED in this repo, and the suite must go
red on every one.

If an arm SURVIVES, the suite has a blind spot and `gates.py` is not trustworthy
to merge anything. Fix the test before trusting the gate.

Restores `gates.py` byte-identically afterwards and asserts the restore, because
a mutation harness that leaves the subject modified is worse than none.
"""
from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "tools" / "drain" / "gates.py"
SUITE = "tools/drain/__tests__/test_gates.py"
CMD = [sys.executable, "-m", "pytest", SUITE, "-q"]

# (name, needle, replacement) -- each needle is a defect that shipped.
ARMS: list[tuple[str, str, str]] = [
    (
        "M1 plural-only keyword regex (the grep that let `close #3933` through)",
        r'r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)"',
        r'r"\b(?:closes|fixes|resolves)\s+#(\d+)"',
    ),
    (
        "M2 drop the colon (lets `fixed: #4361` through)",
        r"\s*:?\s*#(\d+)",
        r"\s+#(\d+)",
    ),
    (
        "M3 scan only the body, not the commit trail",
        "    for message in commit_messages:",
        "    for message in []:",
    ),
    (
        "M4 reduce by RECENCY instead of conjunction",
        'if any(v.token == "REQUEST-CHANGES" for v in live):',
        'if live and live[-1].token == "REQUEST-CHANGES":',
    ),
    (
        "M5 treat an unknown action as permitted (fail OPEN)",
        'return False, "not in permitted_unattended',
        'return True, "not in permitted_unattended',
    ),
    (
        "M6 collapse never-created into parked",
        "    if total_count == 0:",
        "    if False:",
    ),
]


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def main() -> int:
    original = TARGET.read_text(encoding="utf-8", newline="")
    before = digest(original)

    # CONTROL FIRST. If the unmutated suite is not green, every red below is
    # noise and the run proves nothing.
    control = subprocess.run(CMD, capture_output=True, text=True, cwd=ROOT)
    tail = (control.stdout.strip().splitlines() or [""])[-1]
    print(f"CONTROL rc={control.returncode}  {tail[:60]}")
    if control.returncode != 0:
        print("REFUSING -- control is not green; nothing below would mean anything")
        return 2

    killed = survived = skipped = 0
    try:
        for name, old, new in ARMS:
            if old not in original:
                print(f"  SKIP     {name:<62} anchor not found")
                skipped += 1
                continue
            TARGET.write_text(original.replace(old, new, 1), encoding="utf-8", newline="")
            run = subprocess.run(CMD, capture_output=True, text=True, cwd=ROOT)
            if run.returncode != 0:
                print(f"  KILLED   {name:<62} rc={run.returncode}")
                killed += 1
            else:
                print(f"  SURVIVED {name:<62} rc=0  <-- BLIND SPOT")
                survived += 1
    finally:
        TARGET.write_text(original, encoding="utf-8", newline="")

    after = digest(TARGET.read_text(encoding="utf-8", newline=""))
    print()
    print(f"restored byte-identical: {before == after}")
    print(f"killed={killed} survived={survived} skipped={skipped}")
    return 1 if (survived or skipped or before != after) else 0


if __name__ == "__main__":
    raise SystemExit(main())
