"""Mutation-test the drain harness: does the suite actually kill a real defect?

    python tools/drain/mutate_gates.py

A green suite is AMBIGUOUS -- it means either the tests discriminate or they are
blind, and nothing in a passing run tells you which. So each arm below
reintroduces a defect that actually HAPPENED, and the suite must go red on every
one. If an arm SURVIVES, the suite has a blind spot and the harness is not
trustworthy to merge anything. Fix the test before trusting the gate.

TWO LESSONS FROM THIS FILE'S OWN FIRST REVIEW, both recorded because a green
matrix is exactly what they looked like:

1. **An author mutates what they just fixed.** The first six arms all weakened a
   CHECK. An independent reviewer wrote eight more, and six survived -- because
   the ones that work narrow the POPULATION instead: parse only the newest
   comment, scan only the last commit, scan only the first line, exempt fenced
   code, take a `startswith` fast path. A filter placed INSIDE the predicate
   beats a contract written about the predicate. Arms N* below are those.

2. **Never mutate the tracked file.** This harness used to write the mutation
   into `tools/drain/gates.py` and restore it in a `finally`. `finally` does not
   run on SIGKILL, this host memory-kills processes, and up to four lanes share
   that checkout -- so a kill mid-arm left a WEAKENED merge gate on disk, in the
   one file whose whole purpose is to be trustworthy. The sandbox below is a
   copy outside the repo; the tracked tree is never written to, and the run
   asserts that.
"""
from __future__ import annotations

import hashlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SOURCES = ["gates.py", "ledger.py", "tick.py", "merge_gate.py", "build_inventory.py",
           "policy.json"]

# (name, file, needle, replacement) -- each needle is a defect that shipped, or
# one an independent reviewer demonstrated the suite could not see.
ARMS: list[tuple[str, str, str, str]] = [
    # -- the check weakened ------------------------------------------------
    (
        "M1 plural-only keyword regex (the grep that let `close #3933` through)",
        "gates.py",
        '_VERB = r"(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)"',
        '_VERB = r"(?:closes|fixes|resolves)"',
    ),
    (
        "M2 drop the optional colon (lets `fixed: #4361` through)",
        "gates.py",
        r'r"\b" + _VERB + r"\s*:?\s*" + _REF',
        r'r"\b" + _VERB + r"\s+" + _REF',
    ),
    (
        "M3 the reference half becomes a spelling list again (bare # only)",
        "gates.py",
        # The WHOLE alternation, not just one branch of it. An earlier version of
        # this arm replaced only the `#N` line and left the other three in place,
        # so it SURVIVED -- and a survivor is ambiguous between a blind suite and
        # a mutation that changed nothing. Mutate the whole construct.
        ('    r"|GH-"                                                  # GH-N\n'
         '    r"|[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\\#"                    # owner/repo#N\n'
         '    r"|https?://github\\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/issues/"  # full URL\n'),
        "",
    ),
    (
        "M4 scan only the body, not the commit trail",
        "gates.py",
        "    for message in commit_messages:",
        "    for message in []:",
    ),
    (
        "M5 reduce by RECENCY instead of conjunction",
        "gates.py",
        'if any(v.token == "REQUEST-CHANGES" for v in live):',
        'if live and live[-1].token == "REQUEST-CHANGES":',
    ),
    (
        "M6 treat an unknown action as permitted (fail OPEN)",
        "gates.py",
        'return False, "not in permitted_unattended',
        'return True, "not in permitted_unattended',
    ),
    (
        "M7 collapse never-created into parked",
        "gates.py",
        "    if total_count == 0:",
        "    if False:",
    ),
    # -- the population narrowed (the six that SURVIVED the first matrix) ---
    (
        "N1 parse only the NEWEST comment (recency, reinstated upstream of the reducer)",
        "gates.py",
        "    for comment in comments:",
        "    for comment in sorted(comments, key=lambda c: c.get('created_at', ''))[-1:]:",
    ),
    (
        "N2 scan only the LAST commit message of the trail",
        "gates.py",
        "    for message in commit_messages:",
        "    for message in commit_messages[-1:]:",
    ),
    (
        "N3 scan only the FIRST LINE of the artifact",
        "gates.py",
        '    hard = [int(m.group("num")) for m in CLOSING_RE.finditer(text)]',
        ('    text = text.splitlines()[0] if text else text\n'
         '    hard = [int(m.group("num")) for m in CLOSING_RE.finditer(text)]'),
    ),
    (
        "N4 exempt fenced code blocks (a filter INSIDE the predicate)",
        "gates.py",
        '    hard = [int(m.group("num")) for m in CLOSING_RE.finditer(text)]',
        ('    text = re.sub(r"```.*?```", "", text, flags=re.S)\n'
         '    hard = [int(m.group("num")) for m in CLOSING_RE.finditer(text)]'),
    ),
    (
        "N5 a startswith fast path turns one permission into a family",
        "gates.py",
        '    if action in policy.get("never", []):',
        ('    if action.startswith("merge"):\n        return True, "permitted unattended"\n'
         '    if action in policy.get("never", []):'),
    ),
    (
        "N6 CANNOT-ASSESS stops blocking",
        "gates.py",
        'if any(v.token == "CANNOT-ASSESS" for v in live):',
        "if False:",
    ),
    (
        "N7 near-misses are reported but never consulted (the original defect)",
        "gates.py",
        "    blocking_near = [n for n in (near or []) if n.blocks]",
        "    blocking_near = []",
    ),
    (
        "N8 head pinning applies only when more than one comment exists",
        "gates.py",
        "        postdates = bool(head_date) and when >= head_date",
        "        postdates = (bool(head_date) and when >= head_date) or len(comments) == 1",
    ),
    # -- the ledger: R2 in code -------------------------------------------
    (
        "L1 close on a receipt's PRESENCE rather than its KIND (closed on 'merged')",
        "ledger.py",
        "        if item.receipt_kind != want:",
        "        if False:",
    ),
    (
        "L2 an empty ledger reports DRAINED (`all([])` is True)",
        "ledger.py",
        "        return bool(self.items) and all(i.state in TERMINAL for i in self.items.values())",
        "        return all(i.state in TERMINAL for i in self.items.values())",
    ),
    (
        "L3 a park needs a blocker OR an owner, not both",
        "ledger.py",
        "if state == PARKED and not (item.blocker and item.owner):",
        "if state == PARKED and not (item.blocker or item.owner):",
    ),
    (
        "L4 a refreshed label never clears a stale lane",
        "ledger.py",
        "            existing.lane = lane\n            existing.size = size",
        ("            existing.lane = lane or existing.lane\n"
         "            existing.size = size or existing.size"),
    ),
    (
        "L5 a reopened item stays terminal (a false close can never be disputed)",
        "ledger.py",
        "            if existing.state in TERMINAL:",
        "            if False:",
    ),
    # -- the cycle ---------------------------------------------------------
    (
        "T1 the refresh invents a receipt and closes what left GitHub",
        "tick.py",
        "            led.transition(\n                number, NEEDS_AUDIT,",
        ("            item.receipt_kind = item.receipt_kind or 'closed-externally'\n"
         "            item.receipt_ref = item.receipt_ref or 'not open at refresh'\n"
         "            led.transition(\n                number, 'closed',"),
    ),
    (
        "T2 the refresh guard checks SIZE but not OVERLAP (the wrong-repo read)",
        "tick.py",
        "    if overlap < MIN_OVERLAP:",
        "    if False:",
    ),
    (
        "T3 an empty live set is treated as everything having closed",
        "tick.py",
        "    if not live_numbers:",
        "    if False:",
    ),
    (
        "T4 the brief keys its receipt off the console lane again",
        "tick.py",
        "    receipt_class = item.effective_receipt_class",
        ("    receipt_class = 'ui-surface' if item.lane == 'lane:console' "
         "else 'guard-or-test-only'"),
    ),
    (
        "T5b the stream map is required, so a clean checkout files everything into W9",
        "tick.py",
        '        stream = streams.get(number) or stream_for(number, issue["title"], labels)',
        '        stream = streams.get(number, "W9-rest")',
    ),
    (
        "T5 an unlaned item becomes schedulable",
        "tick.py",
        "            if item.state != READY or not item.schedulable:",
        "            if item.state != READY:",
    ),
    (
        "T6 the OVERLAP denominator drops terminal items (a park bricks the run)",
        "tick.py",
        "    overlap = len(known & live_numbers) / len(live_numbers)",
        "    overlap = len(believed_open & live_numbers) / len(live_numbers)",
    ),
    (
        "T7 --allow-shrink switches off the whole guard, not just the retention clause",
        "tick.py",
        "    guard_refresh(led, live, allow_shrink=args.allow_shrink)",
        "    if not args.allow_shrink:\n        guard_refresh(led, live)",
    ),
    (
        "T8 the reaper returns TERMINAL items to ready, undoing every receipt",
        "tick.py",
        "        if item.state == IN_FLIGHT:",
        "        if item.state != READY:",
    ),
    (
        "T9 main() stops calling the refresh guard at all",
        "tick.py",
        "    guard_refresh(led, live, allow_shrink=args.allow_shrink)",
        "    pass  # guard_refresh(led, live, allow_shrink=args.allow_shrink)",
    ),
    # -- the composed caller: the file that actually decides a merge -------
    (
        "MG1 the verdict is reduced over an EMPTY finding set (the rubber stamp)",
        "merge_gate.py",
        '    blocking = [f for f in findings if not f["ok"]]',
        "    blocking = []",
    ),
    (
        "MG2 gate 4 always records GO - required contexts stop blocking",
        "merge_gate.py",
        '    ok, reasons = gates.classify_checks(rollup, data["required"])',
        '    _, reasons = gates.classify_checks(rollup, data["required"])\n    ok = True',
    ),
    (
        "MG3 the verdict gate always records GO - review stops blocking",
        "merge_gate.py",
        "    ok, why = gates.reduce_verdicts(live, near)",
        "    _, why = gates.reduce_verdicts(live, near)\n    ok = True",
    ),
    (
        "MG4 gate 6 is informational again - an undeclared auto-close stops blocking",
        "merge_gate.py",
        "        not undeclared,",
        "        True,",
    ),
    (
        "MG5 a CONFLICTING PR stops being NO-GO",
        "merge_gate.py",
        '        mergeable != "CONFLICTING",',
        "        True,",
    ),
    (
        "MG6 gate 5 stops blocking on a required context that ran nothing",
        "merge_gate.py",
        '    ok, hollow = gates.required_measured_nothing(rollup, data["required"])',
        '    _, hollow = gates.required_measured_nothing(rollup, data["required"])\n    ok = True',
    ),
    (
        "MG7 the post-merge audit compares COUNTS again (a set swap reads clean)",
        "gates.py",
        "    before_set, after_set, want = set(before), set(after), set(intended)",
        ("    before_set = after_set = want = set()\n"
         "    return len(before) - len(after) == len(intended), 'delta matches'"),
    ),
    # -- the ledger's third terminal state ---------------------------------
    (
        "L6 `declined` needs no recorded decision (a backlog declines itself drained)",
        "ledger.py",
        "        if state == DECLINED and not (why and why.strip()):",
        "        if False:",
    ),
    (
        "L7 a transient departure never returns to the queue (needs-audit is one-way)",
        "ledger.py",
        "            elif existing.state == NEEDS_AUDIT and existing.audit_reason == AUDIT_DEPARTED:",
        "            elif False:",
    ),
    (
        "L8 a DISPUTED close is swept back to ready by the departure rescue",
        "ledger.py",
        "            elif existing.state == NEEDS_AUDIT and existing.audit_reason == AUDIT_DEPARTED:",
        "            elif existing.state == NEEDS_AUDIT:",
    ),
    # -- the vocabularies, and the inventory -------------------------------
    (
        "G1 the StatusContext vocabulary is dropped from the INCOMPLETE test",
        "gates.py",
        "        elif not verdict or verdict in INCOMPLETE_STATUSES or status in INCOMPLETE_STATUSES:",
        "        elif not verdict or status in INCOMPLETE_STATUSES:",
    ),
    (
        "G2 a blocking near-miss stops being pinned to head (stale text blocks forever)",
        "gates.py",
        "        postdates = bool(head_date) and when >= head_date",
        "        postdates = True",
    ),
    (
        "G3 the verdict token is read in list order over the FLAT window again",
        "gates.py",
        ("    saw_template = False\n"
         "    marker_lines = [ln for ln in body.splitlines() if any(m in ln for m in MARKERS)]"),
        ("    return next((t for t in VERDICT_TOKENS if t in head), None), False\n"
         "    saw_template = False\n"
         "    marker_lines = [ln for ln in body.splitlines() if any(m in ln for m in MARKERS)]"),
    ),
    (
        "BI1 the inventory stops refusing a partition that loses an issue",
        "build_inventory.py",
        "    if lost or dupes or len(placed) != len(want):",
        "    if False:",
    ),
    (
        "BI2 the totality check counts instead of comparing sets (a swap reads clean)",
        "build_inventory.py",
        "    if lost or dupes or len(placed) != len(want):",
        "    if len(placed) != len(want):",
    ),
]


def digest_tree(root: Path) -> str:
    """One digest over every tracked source this harness could possibly touch."""
    sha = hashlib.sha256()
    for name in sorted(SOURCES):
        sha.update(name.encode("utf-8"))
        sha.update((root / name).read_bytes())
    return sha.hexdigest()


def main() -> int:
    before = digest_tree(HERE)

    # The sandbox lives OUTSIDE the repo. A SIGKILL mid-arm therefore cannot
    # leave a weakened gate in a checkout that four lanes share -- the worst
    # possible outcome for the one file whose purpose is to be trustworthy.
    sandbox = Path(tempfile.mkdtemp(prefix="drain-mutate-"))
    try:
        for name in SOURCES:
            shutil.copy2(HERE / name, sandbox / name)
        shutil.copytree(HERE / "__tests__", sandbox / "__tests__",
                        ignore=shutil.ignore_patterns("__pycache__"))
        # NORMALIZE TO LF before matching. `newline=""` preserves whatever the
        # working tree has, `core.autocrlf=true` is set on this machine and no
        # `.gitattributes` rule covers `tools/`, so a fresh clone checks these
        # files out CRLF -- and every MULTI-LINE anchor below is written with
        # LF. Three arms lost their needle that way, including the mass-close
        # one. It fails closed (SKIP -> rc=1), but a matrix that reports
        # "anchor not found" reads as tooling breakage rather than as the
        # guard it is. The sandbox is a copy, so rewriting its line endings
        # costs nothing.
        originals = {}
        for name in SOURCES:
            if not name.endswith(".py"):
                continue
            text = (sandbox / name).read_text(encoding="utf-8", newline="").replace("\r\n", "\n")
            (sandbox / name).write_text(text, encoding="utf-8", newline="")
            originals[name] = text
        cmd = [sys.executable, "-m", "pytest", str(sandbox / "__tests__"), "-q",
               "-p", "no:cacheprovider"]

        # CONTROL FIRST. If the unmutated suite is not green in the sandbox,
        # every red below is noise and the run proves nothing.
        control = subprocess.run(cmd, capture_output=True, text=True, cwd=sandbox)
        tail = (control.stdout.strip().splitlines() or [""])[-1]
        print(f"CONTROL rc={control.returncode}  {tail[:70]}")
        if control.returncode != 0:
            print("REFUSING -- control is not green; nothing below would mean anything")
            print(control.stdout[-3000:])
            return 2

        killed = survived = skipped = 0
        for name, filename, old, new in ARMS:
            source = originals[filename]
            if old not in source:
                print(f"  SKIP     {name:<72} anchor not found in {filename}")
                skipped += 1
                continue
            (sandbox / filename).write_text(source.replace(old, new, 1),
                                            encoding="utf-8", newline="")
            run = subprocess.run(cmd, capture_output=True, text=True, cwd=sandbox)
            (sandbox / filename).write_text(source, encoding="utf-8", newline="")
            if run.returncode != 0:
                print(f"  KILLED   {name:<72} rc={run.returncode}")
                killed += 1
            else:
                print(f"  SURVIVED {name:<72} rc=0  <-- BLIND SPOT")
                survived += 1
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)

    after = digest_tree(HERE)
    print()
    print(f"tracked tree untouched: {before == after}")
    print(f"killed={killed} survived={survived} skipped={skipped} of {len(ARMS)} arms")
    return 1 if (survived or skipped or before != after) else 0


if __name__ == "__main__":
    raise SystemExit(main())
