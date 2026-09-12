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
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
#: What an arm may MUTATE. Also the tree the run digests, so "tracked tree
#: untouched" is asserted over exactly the files an arm could have written to.
SOURCES = ["gates.py", "ledger.py", "tick.py", "merge_gate.py", "build_inventory.py",
           "policy.json"]

#: What the sandbox COPIES, which is wider. This module is copied but NOT
#: mutable: `__tests__/test_mutate_gates.py` imports it -- the runner is the one
#: gate the matrix cannot point an arm at, since an arm mutates a sandbox copy
#: and re-runs the suite, so mutating the runner would mutate the thing doing
#: the mutating. Its scoring rule gets ordinary tests instead. Leaving it out of
#: the copy made the CONTROL fail to collect, which is the instrument working:
#: rc=2 before any arm ran, and the run refused rather than scoring 128 arms
#: against a suite that was not there.
COPIED = [*SOURCES, "mutate_gates.py"]

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
        # The next line comes along: `for comment in comments:` now appears in
        # BOTH `parse_verdicts` and `worst_verdict_in_history`, and an ambiguous
        # anchor is a mutation aimed at whichever function is higher in the file.
        '    for comment in comments:\n        body = comment.get("body") or ""',
        ("    for comment in sorted(comments, key=lambda c: c.get('created_at', ''))[-1:]:"
         '\n        body = comment.get("body") or ""'),
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
        "            if was_state in TERMINAL:",
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
        "    if not live_numbers and believed_open:",
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
        "        overlap = len(known & candidates) / len(candidates)",
        "        overlap = len(believed_open & candidates) / len(candidates)",
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
        "        not undeclared and not poached,",
        "        True,",
    ),
    (
        "MG5 gate 0 stops blocking at all",
        "merge_gate.py",
        '        mergeable == "MERGEABLE",',
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
        "L11 a class DOWNGRADE carries the held receipt over (R2 by a label edit)",
        "ledger.py",
        "            if now_class != was_class:",
        "            if False:",
    ),
    (
        "L12 the reclassification guard only fires when the receipt becomes INVALID",
        "ledger.py",
        "            if now_class != was_class:",
        ("            if (now_class != was_class\n"
         "                    and self.receipts.get(now_class) != existing.receipt_kind):"),
    ),
    (
        "L13 a FALSY stream wipes the class to the weakest",
        "ledger.py",
        "            if stream:\n                existing.stream = stream",
        "            existing.stream = stream",
    ),
    (
        "L14 the stream change is made but never RECORDED",
        "ledger.py",
        ('                existing.history.append(\n'
         '                    f"{_now()} stream {was_stream} -> {existing.stream}"\n'
         '                )'),
        "                pass",
    ),
    (
        ("L15 the class is re-gated on STREAM, so a LANE removal escapes -- the "
         "door the comment it replaced named as the attack"),
        "ledger.py",
        "            if now_class != was_class:",
        "            if now_class != was_class and existing.stream != was_stream:",
    ),
    (
        "L16 `now_class` is read BEFORE the writes, so it can never differ",
        "ledger.py",
        "            now_class = existing.effective_receipt_class",
        "            now_class = was_class",
    ),
    (
        "L17 the LANE change is made but never RECORDED",
        "ledger.py",
        ('                existing.history.append('
         'f"{_now()} lane {was_lane} -> {existing.lane}")'),
        "                pass",
    ),
    (
        ("L18 the class is re-gated on the two LABEL inputs, so the kwargs route "
         "-- an explicit receipt_class, which outranks both -- escapes"),
        "ledger.py",
        "            if now_class != was_class:",
        ("            if now_class != was_class and (\n"
         "                existing.lane != was_lane or existing.stream != was_stream\n"
         "            ):"),
    ),
    (
        "L19 a MID-WORK reclassification is logged but the lane is never told",
        "ledger.py",
        "                if was_state in (IN_FLIGHT, IN_REVIEW, AWAITING_RECEIPT):",
        "                if False:",
    ),
    (
        ("L20 the READY carve-out is removed, so a reclassification strands a "
         "departed item (the round-3 behaviour, which survived 262/262)"),
        "ledger.py",
        "                if was_state in (IN_FLIGHT, IN_REVIEW, AWAITING_RECEIPT):",
        "                if was_state in (IN_FLIGHT, IN_REVIEW, AWAITING_RECEIPT, READY):",
    ),
    (
        ("L21 the audit routing reads the POST-write state, so a `state=` kwarg "
         "suppresses it"),
        "ledger.py",
        "                if was_state in (IN_FLIGHT, IN_REVIEW, AWAITING_RECEIPT):",
        ("                if existing.state in (IN_FLIGHT, IN_REVIEW, "
         "AWAITING_RECEIPT):"),
    ),
    (
        ("L22 a REOPEN keeps the receipt that closed it, so the disputed close "
         "re-closes on zero new evidence"),
        "ledger.py",
        "                receipt_is_the_thing_in_dispute = bool(existing.receipt_kind)",
        "                receipt_is_the_thing_in_dispute = False",
    ),
    (
        ("L23 the receipt carries no stamp of the class it was taken under, so "
         "the invariant has nothing to compare (kills in the SAFE direction -- "
         "it over-refuses; L24 is the dangerous one)"),
        "ledger.py",
        "        item.receipt_taken_under = item.effective_receipt_class",
        "        item.receipt_taken_under = None",
    ),
    (
        ("L24 the stamp is recorded but never CHECKED at the decision -- an "
         "invariant nobody evaluates is a field"),
        "ledger.py",
        "        if item.receipt_taken_under != item.effective_receipt_class:",
        "        if False:",
    ),
    (
        "L6 `declined` needs no recorded decision (a backlog declines itself drained)",
        "ledger.py",
        "        if state == DECLINED and not (why and why.strip()):",
        "        if False:",
    ),
    (
        "L7 a transient departure never returns to the queue (needs-audit is one-way)",
        "ledger.py",
        "            elif was_state == NEEDS_AUDIT and existing.audit_reason == AUDIT_DEPARTED:",
        "            elif False:",
    ),
    (
        "L8 a DISPUTED close is swept back to ready by the departure rescue",
        "ledger.py",
        "            elif was_state == NEEDS_AUDIT and existing.audit_reason == AUDIT_DEPARTED:",
        "            elif was_state == NEEDS_AUDIT:",
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
        "    saw_template = _saw_template(head)",
        ("    return next((t for t in VERDICT_TOKENS if t in head), None), _saw_template(head)\n"
         "    saw_template = _saw_template(head)"),
    ),
    # -- round 3: the regressions two independent reviewers found -----------
    (
        # NOT `head.splitlines()` -> `body_unused.splitlines()`: that raises
        # NameError, and a mutant killed by a NameError proves only that the
        # tests run Python. Pass the WHOLE body where the window belongs --
        # in scope, valid, and exactly the defect.
        "G4 the WINDOW stops bounding what counts as a verdict token",
        "gates.py",
        "        head = body[:window]",
        "        head = body",
    ),
    (
        "G5 a QUOTED verdict counts as a decision",
        "gates.py",
        "            and not _is_quoted(line)",
        "            and True",
    ),
    (
        "G6 a line that MENTIONS a marker counts as one that announces it",
        "gates.py",
        '    return any(line.lstrip("#*_ \\t").startswith(m) for m in MARKERS)',
        "    return any(m in line for m in MARKERS)",
    ),
    (
        "G7 SKIPPED ties with SUCCESS, so a green twin hides a run that measured nothing",
        "gates.py",
        '    if verdict == "SKIPPED":\n        return 2',
        "    if False:\n        return 2",
    ),
    (
        "G8 a token in the window with no marker line is dropped silently",
        "gates.py",
        "            elif mentions_token:",
        "            elif False:",
    ),
    (
        "T10 the guard floor is keyed to the OPEN set, so it goes quiet in the end-game",
        "tick.py",
        "    if len(known) < GUARD_FLOOR:",
        "    if len(believed_open) < GUARD_FLOOR:",
    ),
    (
        "T11 the OVERLAP denominator becomes the ledger (bricks a mostly-terminal run)",
        "tick.py",
        "        overlap = len(known & candidates) / len(candidates)",
        "        overlap = len(known & candidates) / len(known)",
    ),
    (
        "T12 only a READY item is audited when it departs",
        "tick.py",
        ("        if number not in live_numbers and item.state not in TERMINAL "
         "and item.state != NEEDS_AUDIT:"),
        "        if number not in live_numbers and item.state == READY:",
    ),
    (
        "L9 the receipt refusal exempts one stream (the narrow bypass)",
        "ledger.py",
        "        if state == CLOSED:",
        '        if state == CLOSED and item.stream != "W9-rest":',
    ),
    (
        "L10 the decline refusal exempts one stream",
        "ledger.py",
        "        if state == DECLINED and not (why and why.strip()):",
        '        if state == DECLINED and item.stream != "W9-rest" and not (why and why.strip()):',
    ),
    (
        "MG8 gate 6 SUBTRACTS closingIssuesReferences (the field that is not an oracle)",
        "merge_gate.py",
        "    will_close = sorted(set(scan.hard) | set(api_says))",
        "    will_close = sorted(set(scan.hard) - set(api_says))",
    ),
    (
        "MG9 gate 0 becomes a deny-list again, so UNKNOWN passes",
        "merge_gate.py",
        '        mergeable == "MERGEABLE",',
        '        mergeable != "CONFLICTING",',
    ),
    (
        "P1 a policy key with no implementation stops being an error",
        "gates.py",
        "    if missing:\n        raise ValueError",
        "    if False:\n        raise ValueError",
    ),
    # -- round 4: every idiom that marks text as NOT PROSE -------------------
    (
        "C1 the announcing line no longer has to be the comment's FIRST line",
        "gates.py",
        "        return [line] if _announces(line) else []",
        "        if _announces(line):\n            return [line]",
    ),
    (
        "C2 an INDENTED (code-block) verdict header counts as a decision",
        "gates.py",
        '        if line[:1] in (" ", "\\t"):',
        "        if False:",
    ),
    (
        "C2b the indent is measured in SPACES only, so a TAB smuggles a citation",
        "gates.py",
        '        indent = len(line.expandtabs(4)) - len(line.expandtabs(4).lstrip(" "))',
        '        indent = len(line) - len(line.lstrip(" "))',
    ),
    (
        "C2c a nested fence delimiter flips the state back to prose",
        "gates.py",
        "            closes = bare and set(bare) == {char} and len(bare) >= len(fence)",
        "            closes = any(bare.startswith(f) for f in FENCES)",
    ),
    (
        "C2d a one-line <details>...</details> leaves the depth counter open",
        "gates.py",
        '            if "</details" not in lowered:\n                details += 1',
        "            details += 1",
    ),
    (
        "C2e a BLOCKING token is only counted in prose, so formatting reduces a block",
        "gates.py",
        "        blocking_mention = any(\n            any(t in ln for t in BLOCKING_TOKENS)",
        "        blocking_mention = any(\n            False and any(t in ln for t in BLOCKING_TOKENS)",
    ),
    (
        "C2f the blocking mention is reported AFTER the citation, so a citation suppresses it",
        "gates.py",
        "            elif blocking_mention:",
        "            elif blocking_mention and not cited:",
    ),
    (
        "C3 a verdict header inside <details> counts as a decision",
        "gates.py",
        "            and details == 0",
        "            and True",
    ),
    (
        "C4 a verdict header inside an HTML comment counts as a decision",
        "gates.py",
        "            not in_comment\n            and details == 0",
        "            details == 0",
    ),
    (
        "C5 a cited verdict vanishes without a trace again",
        "gates.py",
        "            elif cited:",
        "            elif False:",
    ),
    (
        "C6 a verdict below the window vanishes without a trace",
        "gates.py",
        "            elif out_of_window:",
        "            elif False:",
    ),
    (
        "C7 a CITED verdict starts blocking (a citation decides by another door)",
        "gates.py",
        "                             NEAR_CITED, blocks=False)",
        "                             NEAR_CITED, blocks=True)",
    ),
    (
        "T13 new ARRIVALS are counted as foreign (halts a nearly drained run)",
        "tick.py",
        "    arrivals = {n for n in live_numbers if n > ceiling}",
        "    arrivals = set()",
    ),
    (
        "T14 the HARD retention floor becomes suppressible by --allow-shrink",
        "tick.py",
        "    if retained < MIN_RETAINED_HARD:",
        "    if retained < MIN_RETAINED_HARD and not allow_shrink:",
    ),
    (
        "MGA --allow-close passes when there is no ledger to check",
        "merge_gate.py",
        # The anchor carries the NEXT line too: `ledger_stream` added a second
        # `if not os.path.exists(path):` and the ambiguity guard correctly
        # refused to pick one. A short needle is a mutation aimed at whichever
        # function happens to come first in the file.
        "    if led is None:\n        return False, (",
        "    if False:\n        return False, (",
    ),
    (
        ("MGE the STREAM lookup passes on a missing ledger, so a PR it cannot "
        "classify falls through to one reviewer"),
        "merge_gate.py",
        '        return None, f"{why}, so the stream cannot be resolved"',
        '        return "W9-rest", "no ledger"',
    ),
    (
        "MGB --allow-close skips the receipt-KIND check",
        "merge_gate.py",
        "    return led.receipt_ok(item)",
        '    return True, "declared"',
    ),
    (
        "MGC main() stops cross-checking --allow-close against the ledger",
        "merge_gate.py",
        "    for number in allow_close:\n        ok, why = ledger_receipt_ready(number, policy)",
        "    for number in []:\n        ok, why = ledger_receipt_ready(number, policy)",
    ),
    (
        "MGD the before-file's PR number is no longer validated",
        "merge_gate.py",
        '        if before.get("pr") != args.audit_close:',
        "        if False:",
    ),
    (
        "G9 a backtick enters the strip set, so a FENCED first line announces",
        "gates.py",
        '    return any(line.lstrip("#*_ \\t").startswith(m) for m in MARKERS)',
        '    return any(line.lstrip("#*_ \\t`~><").startswith(m) for m in MARKERS)',
    ),
    (
        "T15 a FLOOD of arrivals is ingested (a drained ledger meets a foreign repo)",
        "tick.py",
        "    if len(arrivals) > max(GUARD_FLOOR, len(known)):",
        "    if False:",
    ),
    (
        "R1 a guard/deploy/console diff stops escalating to a second reviewer",
        "gates.py",
        "    for path in changed_paths or []:",
        "    for path in []:",
    ),
    (
        "R1b the brief passes the LANE NAME where a PATH belongs, so nothing escalates",
        "tick.py",
        '    lane_path = gates.LANE_PATHS.get(item.lane or "")',
        '    lane_path = item.lane or ""',
    ),
    (
        "R2 a REQUEST-CHANGES from the first reviewer stops escalating",
        "gates.py",
        '    if review.get("escalate_on_blocking_first_verdict", True) and prior_verdict:',
        "    if False:",
    ),
    (
        # NOT `_ = (gates.review_requirement,` spliced before the original call
        # -- that leaves a keyword argument inside a tuple display, so the arm
        # died of a SyntaxError at collection (rc=2, zero FAILED lines). A
        # mutant killed by a crash measures nothing about the suite, and the
        # runner scored it alongside the genuine kills. Both reviewers caught
        # it. Anchor the WHOLE call and replace it with something that parses.
        "R3 the brief stops telling the lane its review requirement",
        "tick.py",
        ("    reviewers, why_reviewers = gates.review_requirement(\n"
         "        policy,\n"
         "        changed_paths=[lane_path] if lane_path else [],\n"
         "        stream=item.stream,\n"
         "        footprint_known=bool(lane_path),\n"
         "    )"),
        '    reviewers, why_reviewers = (1, "default for an ordinary lane")',
    ),
    (
        "R4 the escalation list stops being READ from the authority",
        "gates.py",
        '    return tuple(policy.get("review", {}).get("escalate_to_two_when_path_contains", ()))',
        ('    _ = policy\n'
         '    return ("tools/drain", "scripts/ci", ".github/workflows",\n'
         '            "platform/fiab/bicep", "apps/fiab-console", "deploy/")'),
    ),
    (
        "R5 an unknown file footprint falls OPEN to the default again",
        "gates.py",
        '    if not footprint_known and review.get("escalate_when_footprint_unknown", True):',
        "    if False:",
    ),
    (
        "R6 the STREAM stops escalating, so an unlaned W0/W1 item gets one reviewer",
        "gates.py",
        "    if stream and stream in escalation_streams(policy):",
        "    if False:",
    ),
    (
        "R10 W6-ci drops out of the escalating streams (the GUARD stream)",
        "policy.json",
        '      "W6-ci",\n      "W7-bicep"',
        '      "W7-bicep"',
    ),
    (
        ("R12 `.gitignore` drops out of the escalating paths -- #4468's ENTIRE "
         "THESIS, since an entry in it is what hid the merge gate"),
        "policy.json",
        '      ".gitignore",\n',
        "",
    ),
    (
        "R13 `.github/CODEOWNERS` drops out -- the file that decides who reviews",
        "policy.json",
        '      ".github/CODEOWNERS",\n',
        "",
    ),
    (
        "R14 `Makefile` drops out -- the `make validate` entry point",
        "policy.json",
        '      "Makefile",\n',
        "",
    ),
    (
        "R15 `pyproject.toml` drops out -- the ruff/mypy config every guard runs under",
        "policy.json",
        '      "pyproject.toml",\n',
        "",
    ),
    (
        ("R16 `portal/` drops out -- the OTHER front-end, and ux-baseline scopes "
         "EVERY Loom surface, not only apps/fiab-console"),
        "policy.json",
        '      "portal/"\n',
        '      "apps/fiab-console"\n',
    ),
    # R6 and R9 mutate `gates.py` and die on `test_policy.py` calling
    # `review_requirement` DIRECTLY -- so they prove the FUNCTION honours the
    # triggers and prove nothing about the caller feeding them. Both were inert
    # at the enforcement point for three rounds under a green matrix. These are
    # pointed at the call in `merge_gate`. Same boundary, other side.
    (
        ("MG16 the verdict history reduces by TIME again, so whichever of two "
         "parallel reviewers posts first decides the count"),
        "gates.py",
        "    live, near = parse_verdicts(pinned_in, earliest, window)",
        ("    pinned_in = sorted(pinned_in, key=lambda c: c.get('created_at', ''))[:1]\n"
         "    live, near = parse_verdicts(pinned_in, earliest, window)"),
    ),
    (
        ("MG17 the verdict history re-parses the comments ITSELF, stricter than "
         "the gate it feeds, so four block shapes go unseen"),
        "gates.py",
        "    blocked = next((n for n in near if n.blocks), None)",
        "    blocked = None",
    ),
    (
        ("MG27 the history scan requires a well-formed MARKER, so a misspelled "
         "header or a block below a preamble stops raising the count"),
        "gates.py",
        "    live, near = parse_verdicts(pinned_in, earliest, window)",
        ("    pinned_in = [c for c in pinned_in\n"
         "                 if _marker_lines((c.get('body') or '')[:window])]\n"
         "    live, near = parse_verdicts(pinned_in, earliest, window)"),
    ),
    (
        ("MG28 the history scan PINS to the latest comment instead of the "
         "earliest, so a push voids the escalation after all"),
        "gates.py",
        '    earliest = min((s for s in stamped if s), default="") or "0000-01-01T00:00:00Z"',
        '    earliest = max((s for s in stamped if s), default="") or "9999-01-01T00:00:00Z"',
    ),
    (
        ("MG30 a comment with NO timestamp is treated as PREDATING rather than "
         "unpinnable, so its block is silently dropped"),
        "gates.py",
        '        c if s else {**c, "created_at": earliest}',
        "        c",
    ),
    (
        ("MG32 every unannounced block gets the no-marker sentence, so the two "
         "kinds it is untrue for are reported as something they are not"),
        "gates.py",
        ("                    f\"{UNANNOUNCED_REASON_BY_KIND.get("
         "_unannounced_kind(prior_verdict), UNANNOUNCED_REASON_UNKNOWN)}\""),
        ("                    f\"{UNANNOUNCED_REASON_BY_KIND[NEAR_NO_MARKER]}\""),
    ),
    (
        ("MG33 the near-miss KIND is dropped from the tag, so the reason cannot "
         "be worded from it and every block reads the same"),
        "gates.py",
        ('        return f"{UNANNOUNCED_BLOCK} ({blocked.kind}, '
         'comment {blocked.comment_id})"'),
        '        return f"{UNANNOUNCED_BLOCK} (comment {blocked.comment_id})"',
    ),
    (
        ("MG34 the stale branch claims a BINDING that does not exist, so every "
         "real input reads 'bound to PR None'"),
        "merge_gate.py",
        '            + (f", bound to PR {item.pr}" if item.pr is not None else "")',
        '            + f", bound to PR {item.pr}"',
    ),
    (
        ("MG35 the corroborated branch says 'in flight' whichever arm matched, "
         "so a BINDING-corroborated terminal item is described as live work"),
        "merge_gate.py",
        ('            f"the ledger binds {bound_here} to this PR" if bound_here\n'
         '            else "it is work the harness has in flight"'),
        '            "it is work the harness has in flight"',
    ),
    (
        ("MG31 an UNANNOUNCED block is reported as a reviewer's decision, which "
         "is false about a comment that announces nothing"),
        "gates.py",
        "            if prior_verdict.startswith(UNANNOUNCED_BLOCK):",
        "            if False:",
    ),
    (
        ("MG18 the bare-reference scan loosens back to `#\\d+`, so a hex colour "
         "and a heading anchor resolve as issue numbers"),
        "gates.py",
        r'    r"(?<![0-9A-Za-z-])(?:\#|GH-)(?P<num>\d+)(?![0-9A-Za-z-])", re.IGNORECASE',
        r'    r"(?:\#|GH-)(?P<num>\d+)", re.IGNORECASE',
    ),
    (
        ("MG19 a QUALIFIED reference is accepted whatever repo it names, so "
         "another repo's numbers are resolved against THIS ledger"),
        "gates.py",
        '        if repo and match.group("slug").lower() == repo.lower():',
        "        if True:",
    ),
    (
        ("MG20 the ledger load stops being caught, so a corrupt per-machine "
         "scratch file ends the program that decides every merge on a traceback"),
        "merge_gate.py",
        ("        except Exception as exc:\n"
        "            # ENUMERATING THE TYPES WAS THE NARROWER-ENUMERATION SHAPE AGAIN."),
        ("        except json.JSONDecodeError as exc:\n"
        "            # narrowed"),
    ),
    (
        ("MG21 a worktree stops falling back to the primary checkout, so the "
         "stream never resolves and EVERY PR escalates"),
        "merge_gate.py",
        "        found.append(candidate)",
        "        pass",
    ),
    (
        ("MG29 the fallback checks that a policy.json is PRESENT rather than "
         "that it names the SAME REPO, so a vendored copy resolves foreign "
         "issue numbers"),
        "merge_gate.py",
        "            return json.load(handle).get(\"repo\") == repo",
        "            return bool(json.load(handle))",
    ),
    (
        ("MG22 a bare MENTION explains a non-escalating stream again, so a stale "
         "copy-pasted `#N` buys a WEAKER gate than referencing nothing"),
        "merge_gate.py",
        "        n for n in closing\n        if n in led.items and (",
        "        n for n in every\n        if n in led.items and (",
    ),
    (
        ("MG25 a DECLARED close corroborates on the author's word alone, so an "
         "unrelated already-finished item resolves the stream"),
        "merge_gate.py",
        ("            led.items[n].pr == pr if led.items[n].pr is not None\n"
         "            else led.items[n].state in SCHEDULED_STATES"),
        "            True",
    ),
    (
        ("MG26 a close of an item bound to ANOTHER PR stops being refused, so "
         "the copy-paste across invocations is silent again"),
        "merge_gate.py",
        "        if n in led.items and led.items[n].pr not in (None, pr)",
        "        if False",
    ),
    (
        ("MG23 a mention of an ESCALATING item stops escalating, which is the "
         "hole the whole stream trigger was added to close"),
        "merge_gate.py",
        ("    hit = next((led.items[n].stream for n in every\n"
        "                if n in led.items and led.items[n].stream in escalating), None)"),
        ("    hit = next((led.items[n].stream for n in closing\n"
        "                if n in led.items and led.items[n].stream in escalating), None)"),
    ),
    (
        ("MG24 the reference alphabet loses IGNORECASE, so `gh-4487` resolves "
         "nothing while `GH-4487` resolves"),
        "gates.py",
        r'r"(?<![0-9A-Za-z-])(?:\#|GH-)(?P<num>\d+)(?![0-9A-Za-z-])", re.IGNORECASE',
        r'r"(?<![0-9A-Za-z-])(?:\#|GH-)(?P<num>\d+)(?![0-9A-Za-z-])"',
    ),
    (
        ("L25 a receipt with NO stamp is reported as a reclassification, sending "
         "the reader after a class change that never happened"),
        "ledger.py",
        "        if not item.receipt_taken_under:",
        "        if False:",
    ),
    (
        ("MG14 the merge gate stops passing the FIRST verdict, so a block before "
        "a push no longer raises the count"),
        "merge_gate.py",
        "        prior_verdict=prior_verdict,",
        "        prior_verdict=None,",
    ),
    (
        ("MG15 the merge gate stops passing the STREAM, so a W1-deploy PR outside "
        "the twelve paths merges on one approval"),
        "merge_gate.py",
        "        stream=stream,",
        "        stream=None,",
    ),
    (
        "MG10 an unresolvable stream falls OPEN to the default instead of closed",
        "merge_gate.py",
        "        stream_known=stream is not None,",
        "        stream_known=True,",
    ),
    (
        ("MG11 the stream lookup reuses the VERB-ANCHORED closing scan, so a bare "
        "`Refs #N` resolves nothing and every such PR escalates for the wrong reason"),
        "merge_gate.py",
        ("    mentioned = gates.referenced_issues(pr.get(\"body\") or \"\", messages,\n"
         "                                        repo=policy.get(\"repo\"))"),
        "    mentioned = list(scan.near)",
    ),
    (
        ("MG12 the CALLER pins the verdict history to the head, so the push that "
        "voids the block also voids the escalation"),
        "merge_gate.py",
        # Pointed at the CALLER now. The function itself no longer has a line
        # that could be mutated into pinning -- it simply does not pin -- and
        # the defect this arm names is the head filter arriving from anywhere.
        "        data[\"comments\"], policy[\"verdict_parsing\"][\"token_window_chars\"]",
        ("        [c for c in data[\"comments\"]\n"
         "         if c.get(\"created_at\", \"\") >= data[\"head_date\"]],\n"
         "        policy[\"verdict_parsing\"][\"token_window_chars\"]"),
    ),
    (
        ("MG13 the strongest stream stops winning, so the answer depends on "
        "issue-number order"),
        "merge_gate.py",
        ("    hit = next((led.items[n].stream for n in every\n"
         "                if n in led.items and led.items[n].stream in escalating), None)"),
        "    hit = None",
    ),
    (
        "R11 an EMPTY changed-file list is treated as a known footprint",
        "merge_gate.py",
        "        footprint_known=bool(changed),",
        "        footprint_known=True,",
    ),
    (
        "R7 the reviewer COUNT stops being enforced at the merge gate",
        "merge_gate.py",
        "        len(approvals) >= needed,",
        "        True,",
    ),
    (
        "R8 the merge gate counts reviewers from a LANE GUESS, not the real diff",
        "merge_gate.py",
        "        changed_paths=changed,",
        "        changed_paths=[],",
    ),
    (
        "R9 a blocking first verdict is matched by EXACT TOKEN, so a spelling reduces it",
        "gates.py",
        '        if any(t in upper for t in BLOCKING_TOKENS) or "CHANGES REQUIRED" in upper:',
        "        if prior_verdict in BLOCKING_TOKENS:",
    ),
    (
        "B1 #4487 falls through to W4-receipts on its TITLE, demanding an estate receipt",
        "build_inventory.py",
        "HARNESS = {4466, 4467, 4468, 4469, 4485, 4487}",
        "HARNESS = {4466, 4467, 4468, 4469}",
    ),
    (
        "P11 a policy read via a LOCAL ALIAS is invisible to the allow-list scan",
        "gates.py",
        "            if re.search(alias, sources):",
        "            if False:",
    ),
    (
        "P10 the section half of the policy-read scan rejects `.get(` again",
        "gates.py",
        '            pattern = (r"(?:\\[|\\.get\\()\\s*[\\"\']" + re.escape(section)',
        '            pattern = (r"\\[\\s*[\\"\']" + re.escape(section)',
    ),
    (
        "G11 the below-window scan takes a PREFIX CUT, losing a straddling token",
        "gates.py",
        "                for ln in body.splitlines()",
        "                for ln in body[window:].splitlines()",
    ),
    (
        # NOT a `(?!x)` prefix on the regex -- that always succeeds against
        # `policy`, so the arm was a no-op and survived on that alone. Skip the
        # bare-key branch entirely, which is the hole as it actually was.
        "P9 the allow-list scan skips BARE keys again, so `repo` can be moved out",
        # The anchor carries the NEXT line's comment, because the bare
        # `partition(".")` + `if sub:` shape now occurs TWICE in this file and
        # `replace(old, new, 1)` took the first -- so the arm mutated a
        # different function and SURVIVED. An ambiguous anchor is a mutation
        # aimed somewhere other than where it reads.
        "gates.py",
        ('        section, _, sub = dotted.partition(".")\n        if sub:\n'
         "            # A SECTIONED key is read as"),
        ('        section, _, sub = dotted.partition(".")\n        if not sub:\n'
         "            continue\n        if sub:\n"
         "            # A SECTIONED key is read as"),
    ),
    (
        "G10 a blocking token below the window is dropped in silence again",
        "gates.py",
        "            elif blocking_below:",
        "            elif False:",
    ),
    (
        "P8 moving a control onto the operator-documentation list stops being caught",
        "gates.py",
        "    read = sorted(_documentation_keys_that_are_actually_read())",
        "    read = []",
    ),
    (
        "P5 the operator-documentation allow-list becomes an OFF SWITCH",
        "gates.py",
        "    both = sorted(set(OTHER_IMPLEMENTED_BY) & OPERATOR_DOCUMENTATION)",
        "    both = []",
    ),
    (
        "P6 the third mapping is exempt from resolution again",
        "gates.py",
        '        ("other", OTHER_IMPLEMENTED_BY),',
        "",
    ),
    (
        "P7 the resolver stops walking dotted attribute paths",
        "gates.py",
        "    for part in parts[1:]:\n        target = getattr(target, part, None)",
        "    for part in parts[1:2]:\n        target = getattr(target, part, None)",
    ),
    (
        "P3 the WIP hard ceiling stops being enforced",
        "tick.py",
        "    if cap > ceiling:",
        "    if False:",
    ),
    (
        "P4 the policy contract covers only the two gate sections again",
        "gates.py",
        "        if key in OTHER_IMPLEMENTED_BY or key in OPERATOR_DOCUMENTATION:\n            continue",
        "        continue",
    ),
    (
        "P2 the policy mapping accepts a name that resolves to nothing",
        "gates.py",
        "            unresolved = _unresolved(where)",
        "            unresolved = None",
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


#: pytest's own summary vocabulary. A kill must be a TEST that failed, not any
#: non-zero exit -- see the comment at the scoring branch.
_FAILURE_MARKERS = ("FAILED", " failed", "failed,", "AssertionError")


def _reports_a_failure(stdout: str) -> bool:
    return any(marker in stdout for marker in _FAILURE_MARKERS)


_PASSED_RE = re.compile(r"(\d+) passed")


def _passed_count(stdout: str) -> int:
    """How many tests pytest reported passing. -1 when it did not say.

    Used only to prove the `--deselect` took effect. -1 rather than 0 so a
    missing summary can never satisfy an equality check by accident.
    """
    match = _PASSED_RE.search(stdout)
    return int(match.group(1)) if match else -1


def main() -> int:
    before = digest_tree(HERE)

    # The sandbox lives OUTSIDE the repo. A SIGKILL mid-arm therefore cannot
    # leave a weakened gate in a checkout that four lanes share -- the worst
    # possible outcome for the one file whose purpose is to be trustworthy.
    sandbox = Path(tempfile.mkdtemp(prefix="drain-mutate-"))
    try:
        for name in COPIED:
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
        # EVERY source, not only the `.py` ones. `policy.json` is now the
        # authority that `escalation_paths()` reads, so an arm must be able to
        # weaken the POLICY FILE and see the suite go red -- that is what proves
        # the authority has a blast radius rather than being prose. Restricted
        # to `.py`, the first such arm died with `KeyError: 'policy.json'`.
        originals = {}
        for name in SOURCES:
            text = (sandbox / name).read_text(encoding="utf-8", newline="").replace("\r\n", "\n")
            (sandbox / name).write_text(text, encoding="utf-8", newline="")
            originals[name] = text
        # THE ANCHOR META-TEST CANNOT BE IN THE SANDBOX'S DECISION PATH.
        #
        # It asserts every arm's needle appears exactly once in the CURRENT
        # sources -- and inside the sandbox, "current" means the MUTATED copy,
        # where the running arm has just removed its own needle. So it failed on
        # every arm, `_reports_a_failure` saw FAILED, and every arm scored
        # KILLED whether or not any behavioural test noticed. "141 KILLED / 0
        # survived" became a tautology: the one instrument this package offers
        # as evidence its suite is not blind could no longer report a survivor,
        # and it was already hiding one (MG24). Measured by a reviewer who
        # disabled the test and re-ran: 138 killed, 1 SURVIVED.
        #
        # Deselected by NODEID rather than skipped by an env flag: a flag read
        # inside the suite is itself a control nobody can point an arm at, and
        # this file exists because of exactly that. The CONTROL step below
        # asserts the deselect actually removed a test, because a mistyped
        # nodeid is silently accepted by pytest and would restore the defect.
        deselect = (
            "__tests__/test_mutate_gates.py::"
            "test_every_arm_anchor_is_present_and_unique_in_the_current_source"
        )
        cmd = [sys.executable, "-m", "pytest", str(sandbox / "__tests__"), "-q",
               "-p", "no:cacheprovider", "--deselect", deselect]

        # CONTROL FIRST. If the unmutated suite is not green in the sandbox,
        # every red below is noise and the run proves nothing.
        control = subprocess.run(cmd, capture_output=True, text=True, cwd=sandbox)
        tail = (control.stdout.strip().splitlines() or [""])[-1]
        print(f"CONTROL rc={control.returncode}  {tail[:70]}")
        if control.returncode != 0:
            print("REFUSING -- control is not green; nothing below would mean anything")
            print(control.stdout[-3000:])
            return 2
        # ...and the DESELECT must have removed exactly one test. pytest accepts
        # a nodeid that matches nothing in silence, so a typo here would put the
        # meta-test back in the decision path and every arm would score KILLED
        # on it -- which is the defect this deselect exists to repair, restored
        # by a spelling. Compared against a run WITHOUT the deselect, because a
        # count parsed out of `-q` output is a number this file would be
        # trusting rather than measuring.
        with_meta = subprocess.run(
            [c for c in cmd if c not in ("--deselect", deselect)],
            capture_output=True, text=True, cwd=sandbox,
        )
        selected_with = _passed_count(with_meta.stdout)
        selected_without = _passed_count(control.stdout)
        print(f"DESELECT  {selected_with} -> {selected_without} tests "
              f"(the anchor meta-test must not decide an arm)")
        # TWO CONDITIONS, TWO DIAGNOSES. They were one message, and it named
        # the WRONG cause for the commoner of the two: a BROKEN ANCHOR -- the
        # ordinary event on a refactor, which this package records happening
        # four times in one commit -- makes the with-meta run RED, and the run
        # then announced "the nodeid is wrong" about a nodeid that was correct,
        # while discarding the one output carrying the real answer. R7, in the
        # file whose sibling declares "never discarding stderr".
        if with_meta.returncode != 0:
            print("REFUSING -- the unmutated suite is RED with the anchor "
                  "meta-test SELECTED. An arm's needle no longer matches the "
                  "source; the nodeid is not implicated. The failure names the "
                  "arm:")
            print(with_meta.stdout[-2000:])
            return 2
        if selected_with != selected_without + 1:
            print("REFUSING -- the deselect did not remove exactly one passing test, "
                  f"so the nodeid is wrong: {deselect}")
            return 2

        killed = survived = skipped = errored = 0
        for name, filename, old, new in ARMS:
            source = originals[filename]
            if old not in source:
                print(f"  SKIP     {name:<72} anchor not found in {filename}")
                skipped += 1
                continue
            # AN AMBIGUOUS ANCHOR IS A MUTATION AIMED SOMEWHERE ELSE.
            # `replace(old, new, 1)` takes the FIRST occurrence, so when a
            # refactor made one arm's needle match twice, the arm silently
            # mutated a different function and reported SURVIVED -- a blind spot
            # that was really a misfire. A reviewer audits for this by hand
            # every round; the runner should not need one.
            if source.count(old) > 1:
                print(f"  SKIP     {name:<72} anchor matches {source.count(old)}x "
                      f"in {filename} - AMBIGUOUS, would mutate the first")
                skipped += 1
                continue
            (sandbox / filename).write_text(source.replace(old, new, 1),
                                            encoding="utf-8", newline="")
            run = subprocess.run(cmd, capture_output=True, text=True, cwd=sandbox)
            (sandbox / filename).write_text(source, encoding="utf-8", newline="")
            # A NON-ZERO rc IS NOT A KILL. It was scored as one, and R3's own
            # comment records the consequence: a mutation that was a
            # `SyntaxError` exited 2 at COLLECTION and printed KILLED beside 106
            # real kills. Nothing had been measured -- the suite never ran -- and
            # the repair was made to that arm rather than to the scorer, so the
            # next arm of that shape would have read the same way. Arms that
            # edit `policy.json` are the likeliest to reproduce it: a malformed
            # edit raises inside `load_policy` at import time.
            #
            # A kill is rc=1 AND a pytest failure line in the output. Anything
            # else is its own bucket and fails the run for a DIFFERENT reason,
            # because "the mutation was never evaluated" and "the suite is
            # blind" need different fixes.
            failed_a_test = run.returncode == 1 and _reports_a_failure(run.stdout)
            if failed_a_test:
                print(f"  KILLED   {name:<72} rc={run.returncode}")
                killed += 1
            elif run.returncode == 0:
                print(f"  SURVIVED {name:<72} rc=0  <-- BLIND SPOT")
                survived += 1
            else:
                # "NOT A KILL" is all this branch knows. It does NOT know the
                # suite failed to run: rc=2 is a collection error, where that is
                # true, but rc=1 with `1 error` and no `failed` is a fixture
                # raising at RUNTIME, where the suite did run. Asserting the
                # stronger claim would be the R7 error this package spends its
                # budget on.
                tail = (run.stdout.strip().splitlines() or [""])[-1]
                print(f"  ERROR    {name:<72} rc={run.returncode}  <-- NOT A KILL: "
                      f"exited non-zero with no pytest failure line: {tail[:60]}")
                errored += 1
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)

    after = digest_tree(HERE)
    print()
    print(f"tracked tree untouched: {before == after}")
    print(f"killed={killed} survived={survived} skipped={skipped} errored={errored} "
          f"of {len(ARMS)} arms")
    return 1 if (survived or skipped or errored or before != after) else 0


if __name__ == "__main__":
    raise SystemExit(main())
