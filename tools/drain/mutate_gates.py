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
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    # LINE BUFFERED, not block buffered. Round 14: redirected to a file this
    # wrote NOTHING until ~8KB had accumulated, so a run that died partway --
    # and several did, to memory pressure -- left a zero-byte log and an
    # unexplainable exit code. A 30-minute instrument whose progress is
    # invisible until it finishes cannot be diagnosed when it does not.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
#: What an arm may MUTATE. Also the tree the run digests, so "tracked tree
#: untouched" is asserted over exactly the files an arm could have written to.
#:
#: `README.md` JOINED THIS LIST IN #4702 AND HAD TO. `_published_surfaces()`
#: now reads it, because the README carried the same false-universal claim
#: class as the posted bodies and no instrument read it. A read of a file the
#: sandbox does not carry raises `FileNotFoundError` in EVERY arm -- the
#: tautological-kill shape `COPIED`'s own note records for
#: `required_contexts.json`, which is how this was caught before it shipped.
#: Being in SOURCES as well as COPIED is deliberate: it makes the README
#: mutable (UP20 poisons it, which is the only thing that witnesses the new
#: read) and puts it inside the untouched-tree digest.
SOURCES = ["gates.py", "ledger.py", "tick.py", "merge_gate.py", "build_inventory.py",
           "operating_point.py", "policy.json", "README.md"]

#: What the sandbox COPIES, which is wider. This module is copied but NOT
#: mutable: `__tests__/test_mutate_gates.py` imports it -- the runner is the one
#: gate the matrix cannot point an arm at, since an arm mutates a sandbox copy
#: and re-runs the suite, so mutating the runner would mutate the thing doing
#: the mutating. Its scoring rule gets ordinary tests instead. Leaving it out of
#: the copy made the CONTROL fail to collect, which is the instrument working:
#: rc=2 before any arm ran, and the run refused rather than scoring 128 arms
#: against a suite that was not there.
#:
#: `required_contexts.json` is here for the same reason and was learned the same
#: way: without it three tests raised `FileNotFoundError` in EVERY arm, so every
#: arm scored KILLED on a failure that had nothing to do with the mutation. A
#: kill that does not depend on the arm is a tautology, not evidence -- the
#: shape recorded in `csa_loom_a_meta_test_inside_the_mutation_sandbox_makes_killed_a_tautology`.
COPIED = [*SOURCES, "mutate_gates.py", "required_contexts.json"]

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
        # The condition grew an `and v.comment_id not in discharged` clause
        # (#4704). The ARM is unchanged in intent -- replace the conjunction
        # over the whole live set with "whatever landed last" -- but the needle
        # has to track the line it aims at or it silently SKIPs.
        'if any(v.token == "REQUEST-CHANGES" and v.comment_id not in discharged for v in live):',
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
        # Same needle drift as M5 -- see the note there (#4704).
        'if any(v.token == "CANNOT-ASSESS" and v.comment_id not in discharged for v in live):',
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
        "            if was_state in REOPEN_DISPUTES:",
        "            if False:",
    ),
    # -- #4535: WHICH terminal states a reopen disputes --------------------
    #
    # L5 above asks whether the branch fires at all. These four ask whether it
    # fires on the RIGHT POPULATION, which is the question that shipped wrong:
    # keyed on TERMINAL, every refresh demoted every park, so `drained()` was
    # unreachable for anything blocked. Three of the four narrow or widen the
    # population rather than weakening a check, per this file's own lesson.
    (
        ("L26 the reopen branch goes back to TERMINAL wholesale, so a PARK -- "
         "which is SUPPOSED to be open on GitHub -- is demoted every refresh"),
        "ledger.py",
        "REOPEN_DISPUTES = (CLOSED, DECLINED)",
        "REOPEN_DISPUTES = (CLOSED, PARKED, DECLINED)",
    ),
    (
        ("L27 the population narrows the other way: `declined` drops out, so a "
         "decline that never reached GitHub is never questioned"),
        "ledger.py",
        "REOPEN_DISPUTES = (CLOSED, DECLINED)",
        "REOPEN_DISPUTES = (CLOSED,)",
    ),
    (
        ("L28 the VOID line hard-codes `closed` again, so the history asserts a "
         "close that never happened for a declined item (R7)"),
        "ledger.py",
        'f"{was_state} holding it and is open again, so that receipt "',
        '"closed holding it and is open again, so that receipt "',
    ),
    (
        ("L29 a FILTER inside the predicate: only a terminal item HOLDING a "
         "receipt is disputed, so a decline (which needs none) is never audited"),
        "ledger.py",
        "            if was_state in REOPEN_DISPUTES:",
        "            if was_state in REOPEN_DISPUTES and existing.receipt_kind:",
    ),
    (
        ("L30 a TERMINAL item keeps its stale audit reason, so the ledger reads "
         "`state=closed reason='departed'` and a cold reader cannot tell that "
         "label from a live one. Pre-existing, and it becomes the COMMON shape "
         "once recovering an audited item by re-taking its receipt is the "
         "normal path (#4545) rather than a curiosity"),
        "ledger.py",
        "        if state in TERMINAL:\n            item.audit_reason = None\n",
        "",
    ),
    # -- #4677: the two terminal states no program could reach --------------
    #
    # `ledger.transition()` already refuses a park without both fields and a
    # decline without a decision (arms L3, L6, L10 above), so deleting a CLI
    # check changes NO LEDGER OUTCOME -- every one of these three mutants still
    # ends in a refusal. What it changes is WHEN: `_dispose` posts the
    # disposition comment before it transitions, so a check deleted here lets a
    # park or a decline be PUBLISHED on a public issue and then refused, and no
    # re-run removes the comment.
    #
    # That is why the tests that kill these assert `calls == []` rather than
    # only the exception. An assertion that watched the exception alone would be
    # satisfied by the ledger's own refusal and would witness nothing -- the
    # could-not-fail shape `assertion-design.md` is about.
    (
        ("DP1 the CLI park check drops the BLOCKER half, so a blocker-less park "
         "is published on the issue before the ledger refuses it"),
        "tick.py",
        "    if not blocker or not blocker.strip():",
        "    if False:",
    ),
    (
        ("DP2 the CLI park check drops the OWNER half -- a separate arm because "
         "it is a separate check, and `transition` can only say that ONE of the "
         "two is missing"),
        "tick.py",
        "    if not owner or not owner.strip():",
        "    if False:",
    ),
    (
        ("DP3 the CLI decline check drops the recorded DECISION, so a decline "
         "with no reason is published before the ledger refuses it"),
        "tick.py",
        "    if not decision or not decision.strip():",
        "    if False:",
    ),
    # -- #4677 round 2: the three findings an independent review raised --------
    (
        ("DP4 the park body stops REPORTING the state it read and goes back to "
         "ASSERTING the issue is open - a claim about a state the code did not "
         "establish. Reachable on exactly the population the verb serves: "
         "`_dispose` admits a needs-audit/departed item and the refresh matrix "
         "carries `parked | departed -> survives parked`, so the ledger "
         "contemplates a parked item whose issue is CLOSED. Measured "
         "2026-09-24: of the four items #4677 names, #2958 is OPEN and "
         "#4534/#4582/#4664 are CLOSED (R7, on an unrevisable artifact). 366 "
         "arms missed it because NO TEST RENDERED A BODY FOR A DEPARTED ITEM - "
         "a missing case, not a weak arm"),
        "tick.py",
        'f"{observed} The park stands either way, and the two cells of the "',
        '"THIS ISSUE STAYS OPEN, DELIBERATELY. The two cells of the "',
    ),
    (
        ("DP8 the MIRROR of DP4, on the DECLINE body. A separate arm because "
         "DP4 mutates only the park branch, so on its own it closes the finding "
         "by its LABEL rather than at its SITE - the same reason L27 exists "
         "beside L26. A reviewer built this one by hand and it killed; "
         "promoting it means the next reader does not have to"),
        "tick.py",
        'f"{observed} Unlike a park, the decline\'s fate DOES depend on which "',
        '"THIS ISSUE IS STILL OPEN. The decline\'s fate depends on which "',
    ),
    (
        ("DP5 the AUTHORITY bar is removed, so two terminal-state capabilities "
         "run with no entry in policy.json at all - the emergent-behaviour "
         "shape `action_is_permitted` fails closed to prevent"),
        "tick.py",
        "    permitted, permit_note = gates.action_is_permitted(action, policy)",
        '    permitted, permit_note = True, "not asked"',
    ),
    (
        ("DP6 policy.json REVOKES `park-item` and the verb must stop working. "
         "This is the arm that proves the authority has a BLAST RADIUS rather "
         "than being prose - the marker_any_of defect this file records finding "
         "in itself twice, asked of the new grant"),
        "policy.json",
        '    "park-item",\n',
        "",
    ),
    (
        ("DP7 `--status` stops refusing a write verb passed beside it, so "
         "`--status --park N ...` prints the counts and exits 0 having parked "
         "NOTHING - the silent-drop defect through a third door"),
        "tick.py",
        "    if args.status and named:",
        "    if False:",
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
    # -- #4545: the ledger close must REACH GITHUB -------------------------
    #
    # The defect: `tools/drain/` contained no `gh issue close` at all, so a
    # ledger close was invisible upstream and the next refresh read the
    # harness's OWN close as a reopen -- demoting the item and VOIDING the
    # receipt. Measured on #4535, the first item the harness ever closed on its
    # own evidence; it bounced on the next cycle.
    #
    # Per this file's own lesson, the arms that matter are not the ones that
    # weaken a check. GH2 narrows the POPULATION to one of the two routes, GH3
    # widens the STATE set so a park is dragged along (#4535 from the other
    # side), GH4 narrows it to nothing, and GH9 swaps the ORDER of the two
    # writes -- which is the mutation that reproduces the original defect
    # exactly, because a ledger-first pair whose second half fails IS #4545.
    #
    # ONE MUTANT IN THIS AREA IS NOT IN THIS LIST, and the next person reading
    # `killed=N of N` needs to know before they trust it. A reviewer moved
    # `if item.state in TERMINAL: raise` from above the evidence branches to
    # BELOW the GitHub close -- the terminal refusal firing too late, so a
    # second `--record-receipt` on an already-closed item reaches GitHub. That
    # is a DELETE-HERE / INSERT-THERE edit, and the `(name, file, old, new)`
    # shape cannot express it without an anchor that swallows the whole
    # function body. Generalising the arm form inside a P0 pre-flight fix is
    # the worse trade, so it was not generalised.
    #
    # What pins it instead: `test_an_already_terminal_item_is_not_re_receipted`
    # asserts on the READ COUNT -- 2 `gh issue view` at head, 3 under that
    # mutant, the numbers in the assertion message -- because the CLOSE count
    # cannot see it (a closer meeting an already-closed issue short-circuits
    # and issues no close). It was proven RED against the mutant ONCE, BY HAND,
    # in a sandbox copy, by two people independently. That is a test with a
    # named discriminator, not a standing arm, and this matrix's totals must
    # not be read as claiming otherwise.
    (
        "GH1 the ledger closes and GitHub never hears (#4545 verbatim)",
        "tick.py",
        ("    close_note = close_issue_on_github(\n"
         "        policy, repo, number, CLOSED, detail, kind, issue_class)"),
        '    close_note = "the ledger is the only record"',
    ),
    (
        ("GH2 the close fires on ONE ROUTE only: ci-green items are closed "
         "upstream and every run-backed item is left open"),
        "tick.py",
        ("    close_note = close_issue_on_github(\n"
         "        policy, repo, number, CLOSED, detail, kind, issue_class)"),
        ("    close_note = (close_issue_on_github(\n"
         "        policy, repo, number, CLOSED, detail, kind, issue_class)\n"
         '                  if from_pr else "run-backed items close quietly")'),
    ),
    (
        ("GH3 the state set widens to every terminal state, so a PARK -- which "
         "is SUPPOSED to stay open on GitHub -- gets closed too (#4535)"),
        "ledger.py",
        "CLOSES_ON_GITHUB = (CLOSED,)",
        "CLOSES_ON_GITHUB = TERMINAL",
    ),
    (
        "GH4 the state set narrows to nothing, so no item ever closes upstream",
        "ledger.py",
        "CLOSES_ON_GITHUB = (CLOSED,)",
        "CLOSES_ON_GITHUB = ()",
    ),
    (
        "GH5 the close's exit code stops being read (the `|| true` shape)",
        "tick.py",
        "        if rc != 0:",
        "        if rc != 0 and False:",
    ),
    (
        ("GH6 rc=0 is trusted instead of reading the state back, so a wrapper "
         "that did nothing reports a close"),
        "tick.py",
        "        after = _read_issue_on_github(repo, number)",
        '        after = _IssueRead("CLOSED", "")',
    ),
    (
        ("GH7 the already-closed short circuit goes, so a human's hand-closed "
         "issue is closed again and re-commented on"),
        "tick.py",
        "        if before.state == \"CLOSED\":",
        "        if False:",
    ),
    (
        "GH8 the autonomy contract stops being consulted before the write",
        "tick.py",
        '    permitted, why = gates.action_is_permitted("close-on-receipt", policy)',
        '    permitted, why = True, "assumed"',
    ),
    (
        ("GH9 the ORDER is reversed -- ledger first, GitHub second -- so a "
         "failed close leaves the item closed here and open there, which is "
         "#4545 reproduced by the fix for it"),
        "tick.py",
        ("    close_note = close_issue_on_github(\n"
         "        policy, repo, number, CLOSED, detail, kind, issue_class)\n"
         "    # EVERY FAILURE FROM HERE ON IS A POST-CLOSE FAILURE"),
        ("    _record_close_in_ledger(\n"
         '        led, item, number, kind, ref, f"receipt verified by tick: {detail}"\n'
         "    )\n"
         "    close_note = close_issue_on_github(\n"
         "        policy, repo, number, CLOSED, detail, kind, issue_class)\n"
         "    # EVERY FAILURE FROM HERE ON IS A POST-CLOSE FAILURE"),
    ),
    (
        ("GH10 a lost CAS after a SUCCESSFUL upstream close is reported as "
         "`RECEIPT NOT RECORDED` -- the words for 'nothing happened', over a "
         "world where the issue IS closed on GitHub (R7, inside the R7 fix)"),
        "tick.py",
        ('            print(f"LEDGER NOT WRITTEN - THE ISSUE IS CLOSED UPSTREAM: "\n'
         '                  f"{type(exc).__name__}: {exc}\\n"'),
        ('            print(f"RECEIPT NOT RECORDED: "\n'
         '                  f"{type(exc).__name__}: {exc}\\n"'),
    ),
    (
        ("GH11 a ledger failure AFTER the close stops being wrapped, so it "
         "escapes as a bare ValueError and `main()` prints RECEIPT REFUSED -- "
         "'your evidence was rejected' -- over a landed GitHub write"),
        "tick.py",
        "    except Exception as exc:\n        raise LedgerWriteAfterCloseError(",
        "    except SystemExit as exc:\n        raise LedgerWriteAfterCloseError(",
    ),
    (
        ("GH14 the close posts NO RECEIPT COMMENT, so a closed issue carries no "
         "trace of which evidence closed it -- 334 issues closed silently, "
         "which is the R2 shape the #4535 hand-close avoided by quoting the "
         "receipt. It SURVIVED 518/518 until the positive assertion existed: "
         "the only test named for the comment asserted its ABSENCE"),
        "tick.py",
        ('            ["gh", "issue", "close", str(number), "--repo", repo,\n'
         '             "--comment", _receipt_comment(kind, issue_class, detail)]'),
        ('            ["gh", "issue", "close", str(number), "--repo", repo,\n'
         "             ]"),
    ),
    (
        ("GH15 the receipt comment goes back to naming neither the KIND nor the "
         "CLASS and citing deploy-integrity R2 on BOTH routes. That is the text "
         "that shipped, and on the ci-green route the evidence IS a merge -- so "
         "it cited 'merged is never done' in support of closing on a merge, on "
         "up to 334 permanent public artifacts, while policy.json carries "
         "`report-a-merge-as-a-fix` in its `never` list. The mutation collapses "
         "the two branches back into the single template, which is the exact "
         "shape of the defect rather than a proxy for it"),
        "tick.py",
        "    head = f\"Drain harness: receipt verified (kind={kind}, class={issue_class}) - {detail}.\"",
        ("    head = f\"Drain harness: receipt verified - {detail}.\"\n"
         "    return head + \" Closing this issue on that evidence (deploy-integrity R2).\""),
    ),
    (
        ("GH16 BOTH ROUTES COLLAPSE INTO THE MERGE TEXT -- the other half of the "
         "GH15 symmetry, and it SURVIVED 519/519. One token: `if kind in "
         "MERGE_BASED_KINDS:` becomes `if True:`. Under it every RUN-BACKED "
         "close publishes, permanently and publicly, that its evidence is 'CI "
         "green at the MERGED sha - a merge, not a deploy', that 'the live "
         "estate was never checked', and -- on a g1-browser receipt taken from a "
         "browser run -- that the reader should go obtain a g1-browser receipt "
         "instead. That is WORSE than the text GH15 models, which at least never "
         "claimed 'not a deploy' over a deploy observation. Nothing killed it "
         "because the only route-sensitive assertion on the run-backed test was "
         "`deploy-integrity R2`, which BOTH templates carry"),
        "tick.py",
        "    if kind in MERGE_BASED_KINDS:",
        "    if True:",
    ),
    (
        ("GH17 `ci-green` IS RECLASSIFIED AS RUN-BACKED, so the merge route "
         "acquires the estate-observing sentence: 'an observation of something "
         "that ran, not a merge' rendered over a merge, citing R2 as SATISFIED "
         "by the one thing R2 forbids. It is the two-declarations hazard written "
         "out -- merge-ness is stated at MERGE_BASED_KINDS and again at `if kind "
         "== \"ci-green\":` in record_receipt_from_evidence -- and it moves BOTH "
         "declarations because moving only the first now hits the round-7 "
         "fail-closed raise instead, which is the point of that raise. It is "
         "also the mutation that finally runs value 3 of the ci-green test's "
         "'FOUR VALUES BREAK THIS' red: GH15 stops at assertion 1, so 3 had "
         "never been exercised by any shipped arm"),
        "tick.py",
        ('RUN_BACKED_KINDS = frozenset({"deploy-run", "estate", "g1-browser"})'),
        ('RUN_BACKED_KINDS = frozenset({"ci-green", "deploy-run", "estate", "g1-browser"})\n'
         'MERGE_BASED_KINDS = frozenset()  # rebound HERE, after the original binding'),
    ),
    (
        ("GH18 the merge text DROPS ITS NON-CLAIM ABOUT THE ESTATE, so a "
         "ci-green close reads as though the live estate were part of the "
         "evidence -- the implication the sentence exists to refuse. Value 4 of "
         "the same 'FOUR VALUES BREAK THIS', also never exercised before round 7"),
        "tick.py",
        ('            "The live estate was never checked and nothing here claims anything "\n'
         '            "about it. "\n'),
        (""),
    ),
    (
        ("GH12 the save arm narrows back to LedgerChangedError, so a NON-CAS "
         "failure after a landed close -- os.replace raising PermissionError -- "
         "ESCAPES main() UNCAUGHT while the issue is closed upstream: #4545 "
         "with extra steps, inside the fix for it. WHAT THE OPERATOR SEES, "
         "measured as a real process rather than under capsys (which is how an "
         "earlier revision of this line came to say 'an EMPTY stderr', and it "
         "was false): exit 1 and ~650 bytes of TRACEBACK naming os.replace and "
         "saying nothing about the upstream close, against ~520 bytes of the "
         "intended message unmutated -- byte totals ENVIRONMENT-DEPENDENT (they "
         "move with sandbox path length and run id; an independent re-measure "
         "on another sandbox read 647/579), so the load-bearing invariant is "
         "the SAME EXIT CODE either way, meaning neither "
         "the status nor the text reports that the two records now disagree"),
        "tick.py",
        "        except Exception as exc:  # the WIDTH is the point, see below",
        "        except LedgerChangedError as exc:",
    ),
    (
        ("GH13 the close-failure headline goes back to claiming the close DID "
         "NOT COMPLETE, which is false when rc=0 and only the read-back failed "
         "-- the close landed and the tool cannot say so"),
        "tick.py",
        'f"GITHUB CLOSE NOT CONFIRMED - NOTHING WRITTEN TO THE LEDGER: {exc}\\n"',
        'f"GITHUB CLOSE DID NOT COMPLETE - NOTHING WRITTEN TO THE LEDGER: {exc}\\n"',
    ),
    (
        ("GH19 THE RUN-BACKED TEXT GOES BACK TO CLAIMING R2 SATISFIED. The "
         "sentence 'an observation of something that ran, not a merge, which is "
         "what deploy-integrity R2 (merged is not done) ASKS OF THIS CLASS' "
         "asserts that the estate was observed carrying this issue's change, "
         "and nothing in the receipt path establishes it: `_run_evidence` never "
         "requests `createdAt` and `verify_run_backed_receipt` compares "
         "`headSha` to nothing. MEASURED rather than argued -- run 33238747458 "
         "(loom-roll-and-validate, 2026-08-29, headSha 70ca3d1) passes every "
         "check today, and 147 of the 351 issues open on 2026-09-18 were filed "
         "AFTER it. The mutation restores the exact shipped sentence, which is "
         "the defect rather than a proxy for it, on an artifact that is public "
         "and unrevisable"),
        "tick.py",
        ('        "observation of something that ran, not a merge, which is why "\n'
         '        f"deploy-integrity R2 (merged is not done) makes the {issue_class} class "\n'
         '        "take a receipt of this shape rather than a CI-green one. "'),
        ('        "observation of something that ran, not a merge, which is what "\n'
         '        "deploy-integrity R2 (merged is not done) asks of this class. "'),
    ),
    (
        ("GH20 THE TIME/SHA DISCLOSURE IS DELETED while the softened R2 line "
         "stays. The one-sided shape this package keeps producing, and the half "
         "a reader cannot detect: the comment still reads correctly, still "
         "cites #4489 for the reference binding, and silently stops saying that "
         "the run is bound to no TIME and no SHA. Told apart from GH19 by "
         "MEASUREMENT, not by construction: each arm was applied to a sandbox "
         "copy and all five predicates of the run-backed test evaluated by "
         "rendering the comment directly, since pytest stops at the first "
         "failing assert and cannot see this. GH19 falsifies predicates 1+2, "
         "GH20 falsifies 3+4, and neither touches 5 -- disjoint, so one arm "
         "cannot pass for the other. GH20 additionally turns "
         "`test_the_run_backed_disclosure_is_still_true_of_the_code_it_describes` "
         "red, which is a second independent killer"),
        "tick.py",
        ('        "binding is #4489 - and it is bound to no TIME and no SHA either: no "\n'
         '        "run date is fetched and no head sha is compared, so a run that "\n'
         '        "PREDATES this issue is accepted exactly as one that postdates it "\n'
         '        "(#4578). Read this as \'the declared producer ran green\', not as \'the "\n'
         '        "estate was observed carrying this change\'. "\n'),
        ('        "binding is #4489. "\n'),
    ),
    (
        ("GH21 the already-closed note reverts to a bare 'left alone', so the "
         "operator is told a receipt was recorded with no hint that NOTHING WAS "
         "PUBLISHED. That route issues `gh issue view` and nothing else, and "
         "`tools/drain/state.json` is untracked, so the receipt's whole "
         "existence is a local gitignored file -- the state all 7 currently "
         "ledger-closed items are in. Posting there is #4579; saying so is the "
         "part that is not deferrable"),
        "tick.py",
        ('            return (\n'
         '                f"#{number} was already closed on GitHub - left alone, so NO "\n'
         '                "receipt comment was posted: on this route the receipt exists "\n'
         '                "only in the local ledger, which is untracked (#4579)"\n'
         '            )'),
        ('            return f"#{number} was already closed on GitHub - left alone"'),
    ),
    # -- round 10: "verified by effect" verified a property of the WORLD ----
    #
    # Nine rounds of this change argued that reading the state back beats
    # trusting rc=0. It does -- and it still cannot tell THIS invocation's
    # effect from a concurrent writer's. close.go v2.100.0 re-fetches at :112
    # and returns at :117-120, ABOVE the comment block at :148, so a lane that
    # loses the race exits 0 having posted nothing while the read-back reads
    # CLOSED. GH23 is that defect verbatim; GH24 is the two-valued classifier
    # that would let a future `gh` rewording restore it from outside this
    # repository; GH22 and GH25 are the two reads the write is justified by.
    (
        ("GH22 the verification READ stops pinning `--repo`, so `gh` resolves "
         "the repository from the working directory. MEASURED AT ROUND 9'S "
         "HEAD: this exact edit survived 527/527 -- the close argv was pinned "
         "and neither read was. The pre-read can then short-circuit on a "
         "FOREIGN repo's closed issue (receipt recorded, nothing closed, "
         "nothing commented) and the read-back can satisfy the verification "
         "vacuously: #4545's failure mode restored through the verification "
         "instead of through the write"),
        "tick.py",
        ('        ["gh", "issue", "view", str(number), "--repo", repo,\n'
         '         "--json", "state,title,url"]'),
        ('        ["gh", "issue", "view", str(number),\n'
         '         "--json", "state,title,url"]'),
    ),
    (
        ("GH23 THE NOTE GOES BACK TO KEYING ON THE READ-BACK ALONE, so a close "
         "performed by a human or by a second lane is reported as this run's "
         "own -- over an issue where `gh` short-circuited above its comment "
         "step and published NOTHING. The false sentence then lands in "
         "`Item.history` permanently. This is the round-9 head, and the whole "
         "PR exists to stop a close being reported that never reached GitHub"),
        "tick.py",
        ("        outcome = _close_outcome(\n"
         "            _without_title_line_breaks(err, before.title, after.title),\n"
         "            repo, number,\n"
         "        )"),
        "        outcome = CLOSE_PERFORMED",
    ),
    (
        ("GH24 the classifier goes TWO-VALUED -- anything that is not the "
         "already-closed sentence is assumed to be our close. Fails OPEN by "
         "construction: a future `gh` that rewords :169, a localised build or "
         "a wrapper silently restores GH23 from OUTSIDE this repository, where "
         "nothing in this suite watches. The third arm is the difference "
         "between failing honest and failing open"),
        "tick.py",
        ("        if _sentence_is(body, performed, _GH_PERFORMED_SUFFIX):\n"
         "            return CLOSE_PERFORMED\n"
         "        if _sentence_is(body, already, _GH_ALREADY_CLOSED_SUFFIX):\n"
         "            return CLOSE_FOUND_ALREADY_CLOSED\n"
         "    return CLOSE_OUTCOME_UNKNOWN"),
        ("        if _sentence_is(body, already, _GH_ALREADY_CLOSED_SUFFIX):\n"
         "            return CLOSE_FOUND_ALREADY_CLOSED\n"
         "    return CLOSE_PERFORMED"),
    ),
    (
        ("GH25 the read stops establishing the object's TYPE, so a number that "
         "resolves to a PULL REQUEST is closed as though it were an issue and "
         "the permanent receipt comment is posted on the PR. `gh issue view` "
         "answers for PRs (measured live on #4552) and close.go :175-177 routes "
         "them to `api.PullRequestClose`. Latent while every number comes from "
         "`gh issue list`, but the read-first is what the write's safety is "
         "argued from, so a read that cannot say what it read is the argument "
         "failing rather than a missing nicety"),
        "tick.py",
        '    url = str((parsed or {}).get("url") or "")',
        '    url = "https://github.com/o/r/issues/0"',
    ),
    # -- round 11: the classifier read by IDIOM, and the TITLE is in the line --
    #
    # close.go interpolates `issue.Title` as the final `%s` of BOTH exit-0
    # sentences (:118, :169). Round 10's classifier asked whether a phrase
    # appeared ANYWHERE in stderr, so an issue's own title could forge the
    # verdict -- measured end to end at f3a2a834460 on a close that was
    # genuinely performed: 1 comment posted, state CLOSED, and a note saying
    # neither happened, written permanently into `Item.history`. GH26 is that
    # defect verbatim; GH29 is the tempting "swap the two ifs", which merely
    # moves the collision onto the dangerous side. A POSITIONAL read survives
    # both -- and NOT, as this comment claimed for a round, "because the title
    # can never start a line". It cannot start a line gh WROTE; it can create
    # one of its own, which is what GH30-GH32 below are about.
    (
        ("GH26 THE CLASSIFIER GOES BACK TO READING BY IDIOM -- a bare substring "
         "over the whole of stderr, already-closed first. This is round 10's "
         "head. `issue.Title` is the last field of both sentences, so a close "
         "this run GENUINELY PERFORMED, on an issue whose title contains `is "
         "already closed`, is reported as somebody else's with its receipt "
         "comment denied -- two false statements of fact on the ORDINARY "
         "SUCCESS PATH, then written into `Item.history`. Latent only because "
         "no current title collides; the population is 334 issues titled by "
         "this lane about issue-closing machinery"),
        "tick.py",
        ("        if _sentence_is(body, performed, _GH_PERFORMED_SUFFIX):\n"
         "            return CLOSE_PERFORMED\n"
         "        if _sentence_is(body, already, _GH_ALREADY_CLOSED_SUFFIX):\n"
         "            return CLOSE_FOUND_ALREADY_CLOSED\n"
         "    return CLOSE_OUTCOME_UNKNOWN"),
        ("        if _GH_ALREADY_CLOSED_SUFFIX in err:\n"
         "            return CLOSE_FOUND_ALREADY_CLOSED\n"
         "        if _GH_PERFORMED_PREFIX in err:\n"
         "            return CLOSE_PERFORMED\n"
         "    return CLOSE_OUTCOME_UNKNOWN"),
    ),
    (
        ("GH29 THE SAME IDIOM WITH THE TWO TESTS SWAPPED -- the fix that looks "
         "like a fix. It cures GH26's direction and creates the worse one: an "
         "already-closed line whose title contains `Closed issue ` now reports "
         "a close this run did NOT perform, which is GH23 restored through the "
         "title field. Told apart from GH26 by which half of "
         "`test_blocker_an_issues_own_title_cannot_forge_the_close_outcome` "
         "goes red -- GH26 fails half one, GH29 fails half two -- so neither "
         "arm can pass for the other"),
        "tick.py",
        ("        body = line.split(\" \", 1)[1] if \" \" in line else line\n"
         "        if _sentence_is(body, performed, _GH_PERFORMED_SUFFIX):"),
        ("        body = line.split(\" \", 1)[1] if \" \" in line else line\n"
         "        if _GH_PERFORMED_PREFIX in err:\n"
         "            return CLOSE_PERFORMED\n"
         "        if _sentence_is(body, performed, _GH_PERFORMED_SUFFIX):"),
    ),
    (
        ("GH27 THE UNKNOWN-OUTCOME NOTE DROPS ITS REMEDIATION, leaving the "
         "operator told only that the tool cannot tell -- from a state it "
         "deliberately refuses to re-enter, because the ledger write below "
         "makes the item terminal and the record route refuses a terminal "
         "item. Honest and unactionable is not R6 satisfied: the note has to "
         "name the one action (read the comments, post the receipt by hand if "
         "none begins `Drain harness: receipt verified`)"),
        "tick.py",
        ('            "so the receipt comment MAY NOT have been posted. DO THIS: read the "\n'
         '            f"issue\'s comments (`gh issue view {number} --repo {repo} --comments`) "\n'
         '            "and, if none begins `Drain harness: receipt verified`, post the "\n'
         '            "receipt by hand - this tool will not re-enter the path, because the "\n'
         '            "ledger write below makes the item terminal and the record route "\n'
         '            "refuses a terminal item (#4579 tracks closing that gap in code)"'),
        '            "so the receipt comment MAY NOT have been posted"',
    ),
    (
        ("GH28 THE READ STOPS ESTABLISHING WHICH REPOSITORY ANSWERED, so a "
         "TRANSFERRED issue -- whose old number stays reachable and resolves "
         "to the NEW repository -- is closed, and permanently commented on, in "
         "a repository this tool was never asked about. The `--repo` pin that "
         "arm GH22 protects was argued from exactly this hazard; without the "
         "comparison it is a hope about `gh` rather than a verified effect, "
         "and the url that settles it is already parsed two lines up"),
        "tick.py",
        ("    answered = _object_repo_from_url(url)\n"
         "    if answered.casefold() != repo.casefold():"),
        ("    answered = _object_repo_from_url(url)\n"
         "    if False:"),
    ),
    # -- round 13: the title did not have to START a line. It CREATED one ----
    #
    # Round 12 fixed the idiom read and claimed the positional result was
    # "title-proof by construction … [the title] can never occupy the start of
    # one [line]". True of a line gh WROTE, and the conclusion does not follow:
    # `str.splitlines()` honours TEN separators against the one `gh` terminates
    # its records with, so a title carrying any of the other nine splits that
    # single-line record into several and hands the classifier a line whose
    # whole content is operator-supplied. Measured at 4ce05224585: all ten
    # forge, in BOTH directions, 20 of 20, with a plain-title control green --
    # and end to end through `_GhSpy` on the raced-close path a U+2028 title
    # returned `#4547 closed on GitHub` over a run that closed nothing and
    # posted no comment, written permanently into `Item.history`.
    #
    # WHY FIVE ARMS AND NOT ONE. The round-12 error was not a missing character
    # in a list; it was fixing the trigger instead of the class. An arm per
    # CONSTRUCT is what makes that visible: the narrow split, the neutraliser,
    # the neutraliser's breadth, the field that feeds it, and the second read
    # that covers an edit inside the close window. The review that found this
    # said it plainly -- `killed=304 of 304` was true and green while the
    # blocker shipped, because no arm pointed at `splitlines()`, at the icon
    # drop, or at the length guard. A complete matrix over an incomplete arm
    # set is the shape this repo keeps paying for.
    (
        ("GH30 THE SPLIT WIDENS BACK TO `str.splitlines()` -- round 12's head "
         "verbatim. Ten separators read back out of a stream joined with one, "
         "so the nine gh never writes delimit nothing it meant and every one "
         "is reachable from the TITLE. Reading with a wider rule than the "
         "writer wrote with is the whole defect; narrowing the trigger "
         "character is what round 12 did instead"),
        "tick.py",
        '    return [line.removesuffix("\\r") for line in err.split("\\n")]',
        "    return err.splitlines()",
    ),
    (
        ("GH38 THE CRLF TERMINATOR STOPS BEING UNDONE -- the OPPOSITE mistake "
         "to GH30, and the one `splitlines()` was rightly chosen over a bare "
         "`split(\"\\\\n\")` to avoid in round 12. A `\\\\r` left glued to the end "
         "of the line fails the already-closed arm's SUFFIX test SILENTLY, so "
         "every raced close on a CRLF stream classifies `unknown`. Narrowing "
         "the split is only correct WITH this, which is why the pair is armed "
         "rather than just the widening "
         "(`csa_loom_js_regex_dot_does_not_match_cr_so_line_guards_noop_on_crlf`)"),
        "tick.py",
        '    return [line.removesuffix("\\r") for line in err.split("\\n")]',
        '    return err.split("\\n")',
    ),
    (
        ("GH31 THE TITLE NEUTRALISATION IS DELETED from the call site, so LF -- "
         "gh's OWN terminator, the one separator a narrower split cannot help "
         "with -- creates a line of pure operator-supplied content again. This "
         "is the half of the fix that does not depend on how the stream is "
         "split, and it is the half that costs nothing: the titles arrive on a "
         "`--json` list the closer was already fetching"),
        "tick.py",
        ("        outcome = _close_outcome(\n"
         "            _without_title_line_breaks(err, before.title, after.title),\n"
         "            repo, number,\n"
         "        )"),
        "        outcome = _close_outcome(err, repo, number)",
    ),
    (
        ("GH32 THE NEUTRALISER IS NARROWED TO ONE CODE POINT -- round 12's "
         "error committed one layer down, and the reason `_has_line_break` "
         "asks the splitter rather than transcribing its documentation. A "
         "hand-written separator list is a probe that can disagree with the "
         "implementation it describes (assertion-design 'done' #3)"),
        "tick.py",
        "        if _has_line_break(title):",
        '        if "\\u2028" in title:',
    ),
    (
        ("GH33 THE LENGTH GUARD IN `_sentence_is` IS DELETED. Disclosed at its "
         "site as an EQUIVALENT MUTANT at the two pairs `_close_outcome` "
         "supplies -- 0 divergent inputs over 200 candidates, positive control "
         "diverging -- and killable at the PREDICATE'S OWN CONTRACT, which is "
         "where it is now pinned. The arm exists because round 12 presented it "
         "as load-bearing with no witness at all; an un-killable construct is "
         "disclosed, not counted, and a disclosed one still gets an arm"),
        "tick.py",
        ("        len(body) >= len(prefix) + len(suffix)\n"
         "        and body[:len(prefix)].casefold() == prefix.casefold()"),
        "        body[:len(prefix)].casefold() == prefix.casefold()",
    ),
    (
        ("GH34 GH'S ICON TOKEN STOPS BEING DROPPED, so the marker is read at "
         "offset 0 and every real line classifies UNKNOWN -- a classifier that "
         "qualifies every outcome, which is how 'fails honest' gets satisfied "
         "by saying nothing. No arm pointed at this construct before round 13 "
         "even though the suite killed it: an arm set that omits a construct "
         "makes a 100%-killed headline a claim about the arms, not the code"),
        "tick.py",
        '        body = line.split(" ", 1)[1] if " " in line else line',
        "        body = line",
    ),
    (
        ("GH35 REPO AND NUMBER ARE DROPPED FROM THE ALREADY-CLOSED PREFIX, so "
         "a short-circuit line about SOMEBODY ELSE'S issue answers for ours. "
         "The positional property claimed both prefixes and only the PERFORMED "
         "half was asserted, so this survived all 531 tests -- naming a value "
         "that does not in fact break the assertion, which is "
         "assertion-design's forbidden case"),
        "tick.py",
        '    already = f"{_GH_ALREADY_CLOSED_PREFIX}{repo}#{number} ("',
        '    already = f"{_GH_ALREADY_CLOSED_PREFIX}"',
    ),
    (
        ("GH36 THE READ STOPS ASKING FOR THE TITLE, so the neutraliser is "
         "handed an empty string and neutralises nothing. Killed "
         "BEHAVIOURALLY, not merely by an argv assertion, because `_GhSpy` "
         "answers only the fields the argv names -- exactly as `gh` does. A "
         "spy that returns every field regardless would let this survive on a "
         "behaviour the real command does not have"),
        "tick.py",
        '         "--json", "state,title,url"]',
        '         "--json", "state,url"]',
    ),
    (
        ("GH37 THE READ-BACK'S TITLE IS DROPPED from the neutralisation set, "
         "leaving only the pre-close read's -- so a title EDITED inside the "
         "close window is rendered by gh and neutralised by nobody. Measured "
         "SURVIVING the suite before its witness existed, which is why the "
         "second title is pinned by a test with a title-change seam rather "
         "than argued for in a docstring"),
        "tick.py",
        "            _without_title_line_breaks(err, before.title, after.title),",
        "            _without_title_line_breaks(err, before.title),",
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
        # ANCHORED TO THE REQUIRED PATH. `classify_advisory_checks` (#4543)
        # reuses the same three-way split, so this line now appears TWICE in
        # `gates.py` -- and `replace(old, new, 1)` takes the first, which would
        # have silently pointed a required-path arm at the advisory one. The
        # preceding RED branch is what distinguishes them; A5 is the advisory
        # twin of this arm.
        ('            reasons.append(f"{name}: RED ({verdict})")\n'
         "        elif not verdict or verdict in INCOMPLETE_STATUSES "
         "or status in INCOMPLETE_STATUSES:"),
        ('            reasons.append(f"{name}: RED ({verdict})")\n'
         "        elif not verdict or status in INCOMPLETE_STATUSES:"),
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
        "        quoted = _is_quoted(line)",
        "        quoted = False",
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
    # -- #4543: the ADVISORY population. Every arm here NARROWS the population
    # back to something smaller than "every check the rollup published", which
    # is the defect being fixed rather than an invented one: gates 4/4b/5 pass
    # `required` and ~25 contexts per PR were invisible to the merge decision.
    # A1 is the exact original; the rest are the neighbouring ways to get the
    # same blindness, plus the two fail-open edges.
    (
        "A1 the advisory arm filters back DOWN to the required contexts (#4543 verbatim)",
        "gates.py",
        "        if name in required_names:\n            continue",
        "        if name not in required_names:\n            continue",
    ),
    (
        "A2 only the first check-run is scanned (the first-N narrowing)",
        "gates.py",
        # Anchored at the GROUPING, which is the single point the whole
        # population passes through -- both "which run is newest" and "was an
        # older run of this name red" read it, so narrowing here narrows both.
        "    groups = _group_by_name(checks)",
        "    groups = _group_by_name(checks[:1])",
    ),
    (
        "A3 a duplicated context is keyed LAST-IN-LIST instead of by max start time",
        "gates.py",
        ("        newest = max(stamps)\n"
         "        out[name] = _worst([r for r, s in zip(runs, stamps, strict=True) "
         "if s == newest])"),
        "        out[name] = runs[-1]",
    ),
    (
        ("A4 an unreadable start time stops falling back to worst-wins, so an "
         "undated red is discarded as superseded"),
        "gates.py",
        # BEHAVIOURAL, not a crash. Deleting the fallback outright would make
        # `max(stamps)` compare None to None and die with a TypeError -- and a
        # mutant killed by a TypeError proves only that the tests run Python
        # (the note on G4 is about the same trap). This substitutes the OTHER
        # plausible rule instead, so the arm is a wrong ANSWER rather than an
        # exception.
        "        if any(stamp is None for stamp in stamps):\n            out[name] = _worst(runs)",
        "        if any(stamp is None for stamp in stamps):\n            out[name] = runs[-1]",
    ),
    (
        "A5 an IN-PROGRESS advisory check reads as RED again (the cry-wolf defect)",
        "gates.py",
        # Disambiguated by the line BELOW it: `classify_checks` opens with the
        # same `if verdict in RED_CONCLUSIONS:` test, and `replace(.., 1)`
        # takes the first -- the G1 collision one function over.
        ("        if verdict in RED_CONCLUSIONS:\n"
         '            red.append(f"{name} ({verdict})")'),
        ("        if verdict in RED_CONCLUSIONS or _is_incomplete(check):\n"
         '            red.append(f"{name} ({verdict})")'),
    ),
    (
        "A6 the empty-rollup guard falls OPEN, so a clean answer over zero checks is a pass",
        "gates.py",
        "    if not checks:\n        return False, (",
        "    if False:\n        return False, (",
    ),
    (
        "A7 the advisory arm stops blocking in the composed caller (report-only)",
        "merge_gate.py",
        "    ok, why = gates.advisory_verdict(",
        "    ok = True\n    _, why = gates.advisory_verdict(",
    ),
    (
        ("A8 the policy flag is read with a permissive default, so deleting the "
         "authority's key leaves the gate silently on"),
        "merge_gate.py",
        'policy["merge_gate"]["advisory_red_is_a_no_go"]',
        'policy["merge_gate"].get("advisory_red_is_a_no_go", True)',
    ),
    (
        ("A9 a re-run in flight over a completed RED collapses back to ADV-WAIT, so "
         "the gate's OWN remedy clears the gate's own block before the re-run answers"),
        "gates.py",
        "            if last_verdict in RED_CONCLUSIONS:",
        "            if False:",
    ),
    (
        ("A9b the SAME site NARROWED rather than disabled -- A9 turns it off entirely, "
         "which any FAILURE-only test kills, so a narrowing that KEEPS FAILURE was "
         "invisible to this registry. An independent reviewer showed "
         "`(\"FAILURE\", \"ERROR\")` survived the whole suite at rc=0; the five other "
         "members of RED_CONCLUSIONS silently fell through to ADV-WAIT and the gate "
         "cleared its own block. A total-disable arm does not witness a partial one"),
        "gates.py",
        "            if last_verdict in RED_CONCLUSIONS:",
        '            if last_verdict in ("FAILURE", "ERROR"):',
    ),
    (
        ("A9c a run that MEASURED NOTHING again discharges an earlier red -- the THIRD "
         "form of the self-clearing block. Once a re-run CONCLUDES SKIPPED it stops "
         "being incomplete, so newest-wins drops it into `clean` and the red vanishes. "
         "Reachable by `rerun-ci`, which is in `permitted_unattended`"),
        "gates.py",
        "        elif verdict in MEASURED_NOTHING:",
        "        elif False:",
    ),
    (
        ("A9d the ADV-RERUN branch counts a SKIPPED as an answer again -- the FOURTH "
         "form, and round 4 CREATED it by fixing only the sibling branch. "
         "`FAILURE, SKIPPED` blocks but `FAILURE, SKIPPED, IN_PROGRESS` clears, so "
         "dispatching the gate's own remedy discharges the block the moment it STARTS. "
         "The mutant is written INLINE rather than calling the old helper, because "
         "round 6 deleted that helper -- a mutant naming a deleted function raises "
         "NameError, which scores NOT-EVALUATED, not KILLED, and would have quietly "
         "retired this arm"),
        "gates.py",
        "            last = _newest_informative_concluded(groups[name])",
        ('            _concl = [r for r in groups[name] if not _is_incomplete(r)]\n'
         '            last = _newest_from_groups({"": _concl})[""] if _concl else None'),
    ),
    (
        ("A9e MEASURED_NOTHING narrowed to SKIPPED alone, so a NEUTRAL re-run "
         "discharges a red. Survived the whole suite before a LITERAL tuple pinned "
         "the set -- a loop derived from the frozenset cannot witness the frozenset"),
        "gates.py",
        'MEASURED_NOTHING = frozenset({"SKIPPED", "NEUTRAL"})',
        'MEASURED_NOTHING = frozenset({"SKIPPED"})',
    ),
    (
        ("A9f the supersession site's RED_CONCLUSIONS read narrowed to two members -- "
         "the FOURTH read of that frozenset, and the third time this PR's own subject "
         "recurred one line below its own fix. CANCELLED is the member that actually "
         "fires here in production"),
        "gates.py",
        "            if prior_verdict in RED_CONCLUSIONS:",
        '            if prior_verdict in ("FAILURE", "ERROR"):',
    ),
    (
        ("A10 the worst-wins fallback returns the FIRST run instead of the worst -- "
         "found by an independent reviewer, who showed it SURVIVED all 521 tests "
         "because both fixtures claiming to pin worst-wins put the red first"),
        "gates.py",
        "    chosen = runs[0]\n    for run in runs[1:]:",
        "    return runs[0]\n    for run in runs[1:]:",
    ),
    (
        ("A11 the informative filter keys on ANY run of the name having concluded RED, "
         "so a check that went red, WAS FIXED and is being re-run again holds the "
         "merge -- the mirror image of the hole the bucket was added to close, and it "
         "SHIPPED in the fix for that hole. RE-ANCHORED in round 6: this arm used to "
         "sit inside `_newest_concluded`, which round 5 orphaned when both callers "
         "moved to `_newest_informative_concluded`. An arm over a function the gate "
         "no longer calls prints KILLED against dead code -- a blind arm inside the "
         "one instrument this package offers as evidence its suite is not blind. "
         "Found by an independent reviewer who applied it and got byte-identical gate "
         "output across 26 constructed rollup shapes"),
        "gates.py",
        "        if not _is_incomplete(run)\n        and _outcome(run)[0] not in MEASURED_NOTHING",
        "        if _outcome(run)[0] in RED_CONCLUSIONS",
    ),
    (
        ("A12 the rerun reason picks by LIST POSITION again, so the same three runs "
         "at one head name CANCELLED or FAILURE depending on the order the API "
         "returned them - a gate claiming a conclusion it never read (R7). "
         "RE-ANCHORED in round 6 onto `_newest_informative_concluded`'s return, for "
         "the same reason as A11: this sat inside `_newest_concluded`, which round 5 "
         "orphaned and round 6 deleted, so it would have scored against dead code"),
        "gates.py",
        '    return _newest_from_groups({"": informative})[""]',
        "    return informative[0]",
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
        ("T16 the departure loop's skip narrows to `closed`, so a PARK whose "
         "issue is closed departs into needs-audit -- the #4535 "
         "unreachable-`drained()` shape re-entered through the other cell"),
        "tick.py",
        ("        if number not in live_numbers and item.state not in TERMINAL "
         "and item.state != NEEDS_AUDIT:"),
        ("        if number not in live_numbers and item.state != CLOSED "
         "and item.state != NEEDS_AUDIT:"),
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
        '                    and f"</{name}" not in lowered\n',
        "                    and True\n",
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
        "C3 a verdict header inside <details> (or any other HTML element) counts as a decision",
        "gates.py",
        "            and not html\n",
        "            and True\n",
    ),
    (
        "C4 a verdict header inside an HTML comment counts as a decision",
        "gates.py",
        "            not in_comment\n            and not html",
        "            not html",
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
    # -- ROUND 14: round 13's fix landed on ONE OF THREE ROUTES --------------
    # An independent reviewer found the SEVENTH and EIGHTH readers of
    # `conclusion` still coercing, and a job-level verdict that only
    # `_renamed_at_merge` had ever read. A receipt is only as good as its
    # least-asked route.
    (
        ("U1 `green-at-merge` stops refusing a job whose work steps have NOT "
         "CONCLUDED, so an in-progress job whose declared step already "
         "succeeded is accepted - and the job join PREFERS that job"),
        "gates.py",
        ("    if unfinished:\n"
         "        return False, (\n"
         '            f"{len(unfinished)} of its work step(s) have NOT CONCLUDED "'),
        ("    if False:\n"
         "        return False, (\n"
         '            f"{len(unfinished)} of its work step(s) have NOT CONCLUDED "'),
    ),
    (
        ("U2 `green-at-merge` stops reading the JOB's own verdict, so a job that "
         "concluded FAILURE is accepted as having executed its declared "
         "substantive step"),
        "gates.py",
        # ANCHORED ON THE MESSAGE, not on the `if`. Finding 5 added the same
        # two refusals to `context_is_accounted_for`, so `if job_verdict !=
        # "success":` now appears TWICE in gates.py and the bare line would
        # mutate whichever came first. The message line is what distinguishes
        # route 1's copy from the all-routes one; `test_every_arm_anchor_is_
        # present_and_unique_in_the_current_source` is what caught it.
        ('    if job_verdict != "success":\n'
         "        return False, (\n"
         '            f"its job concluded {job_verdict!r}, not success - a job that did "'),
        ("    if False:\n"
         "        return False, (\n"
         '            f"its job concluded {job_verdict!r}, not success - a job that did "'),
    ),
    (
        ("U3 the job-level NOT-CONCLUDED refusal collapses, so a job that is "
         "still running answers for a merge"),
        "gates.py",
        # THE SAME WEAK-MUTANT CORRECTION AS F5A2, and this one is older: this
        # arm has had the flaw since it was written, and re-anchoring it for
        # finding 5 cloned the shape before a reviewer measured it. `if False:`
        # on the `is None` branch leaves `job_verdict` as `None` and the
        # `!= "success"` branch below still refuses -- measured `did=False`
        # either way, so the kill was a message substring and the arm's name
        # ("answers for a merge") described an outcome the mutation could not
        # produce.
        #
        # Mapping `None -> "success"` produces it: measured `did=True` with the
        # evidence "executed its declared substantive step(s)" about a job that
        # never concluded, killed by
        # `test_green_at_merge_refuses_a_job_that_is_still_running`.
        #
        # The fixture matters as much as the arm. Route 1 can only ACCEPT a job
        # whose declared work actually ran, so a fixture that skips the work
        # step makes route 1 refuse for an unrelated reason and hides the
        # difference entirely -- which it did, on the first measurement of this.
        ("    job_verdict = step_conclusion(job)\n"
         "    if job_verdict is None:\n"
         "        return False, (\n"
         '            "its job record has not concluded, so it is still running and "'),
        ('    job_verdict = step_conclusion(job) or "success"\n'
         "    if job_verdict is None:\n"
         "        return False, (\n"
         '            "its job record has not concluded, so it is still running and "'),
    ),
    (
        ("U4 `job_executed` -- the SELECTOR that steers the route choice -- "
         "calls a QUEUED step SKIPPED again, which is both R7-false and the "
         "wrong route"),
        "gates.py",
        ("    if unfinished:\n"
         "        names = \", \".join(str(s.get(\"name\") or \"?\") for s in unfinished[:4])"),
        ("    if False:\n"
         "        names = \", \".join(str(s.get(\"name\") or \"?\") for s in unfinished[:4])"),
    ),
    # -- ROUND 13: a step with NO conclusion, and the untested absent-step ----
    # The most reachable defect this issue has produced -- no mutation, no policy
    # edit, live production path. `did_run` folded "has not concluded" into "did
    # not run", so a job with `in_progress` work steps was excused with "no work
    # step in the job ran". Three more readers were uninstrumented, and the
    # absent-gated-step refusal had no test at all.
    (
        ("V1 the NOT-CONCLUDED refusal collapses, so a job whose work steps are "
         "still queued or running is excused with 'nothing for it to do' - the "
         "live fail-open, restored"),
        "gates.py",
        ("    if unfinished:\n"
         "        return False, (\n"
         '            f"{len(unfinished)} work step(s) have NOT CONCLUDED "'),
        ("    if False:\n"
         "        return False, (\n"
         '            f"{len(unfinished)} work step(s) have NOT CONCLUDED "'),
    ),
    (
        ("V2 `step_conclusion` returns '' instead of None for a step that has "
         "not concluded, which is how every reader in this module used to fold "
         "'still running' into 'did not run'"),
        "gates.py",
        "    return text or None",
        "    return text",
    ),
    (
        ("V3 an output may declare a gated step that is ABSENT from the job and "
         "still be excused - the refusal that had no test, and which accepted a "
         "portal-only merge with `Type-check (portal)` missing entirely"),
        "gates.py",
        ("            if not matches:\n"
         "                return None, (\n"
         '                    f"declared output {out!r} of {name!r} claims to gate {wanted!r}, "\n'
         '                    "which is absent from this job - the row cannot say whether that "\n'
         '                    "output\'s work ran"\n'
         "                )"),
        "            if not matches:\n                continue",
    ),
    # -- ROUND 12: the round-11 fix, and two more fail-open survivors --------
    # Both reviewers converged: the round-11 rule was WRONG (one row of a
    # six-row table) and had NO ARM. Mutating its refusal to `elif False:`
    # survived the whole suite. That is the fourth round running where a fix
    # shipped unobserved, so these three exist before anything else does.
    (
        ("W1 the whole-table refusal collapses, so an output whose steps neither "         "all skipped nor all succeeded is EXCLUDED and its scope never asked - "
         "a FAILED portal step then excuses a matching portal scope"),
        "gates.py",
        '        elif outcomes == {"success"}:',
        "        elif True:",
    ),
    (
        ("W2 the `all skipped` arm widens to `any skipped`, so an output with "
         "ONE skipped step among successes is asked as though nothing ran"),
        "gates.py",
        '        if outcomes == {"skipped"}:',
        '        if "skipped" in outcomes:',
    ),
    (
        ("W3 an ABSENT primary stops refusing in `_primary_steps_all_skipped` - "
         "the precondition BOTH routes share, so a declaration naming a step no "
         "longer in the job reads as cleanly hollow"),
        "gates.py",
        '            return False, f"its declared step {wanted!r} is absent from this job"',
        "            continue",
    ),
    (
        ("W4 an AMBIGUOUS primary stops refusing there, which is precisely what "
         "round 11's `steps_named` migration was written to close"),
        "gates.py",
        ("        matches, ambiguous = steps_named(str(wanted), steps)\n"
         "        if matches is None:"),
        ("        matches, ambiguous = steps_named(str(wanted), steps)\n"
         "        if False:"),
    ),
    # -- SIX survivors an independent reviewer found in round 11 -------------
    # Round 10 shipped nine arms and every one pointed at `gates.py`'s scope
    # selection. The reviewer wrote their own arms over `ran_instead` and
    # `_primary_steps_all_skipped` and six survived the 230-arm matrix. Q12 is
    # the sharpest: it reverts round 10's OWN R7 fix -- the "absent" reason going
    # back to the untrue "did not conclude success" -- with the suite green.
    (
        ("Q8 the MIXED-outcome refusal in `ran_instead` is deleted, so an "
         "alternative resolving to steps that disagree counts as having run"),
        "gates.py",
        '        elif "success" in concluded:',
        "        elif False:",
    ),
    (
        ("Q9 `usable` stops filtering runner BOOKKEEPING, so a `Post ...` step "
         "stands in as the declared alternative"),
        "gates.py",
        ('            and not _is_bookkeeping_step(str(s.get("name") or ""))\n'
         "        ]\n        if not usable:"),
        "        ]\n        if not usable:",
    ),
    (
        ("Q11 the ABSENT branch in `ran_instead` is deleted entirely, so an "
         "alternative that is not in the job is indistinguishable from one that "
         "ran and failed"),
        "gates.py",
        ('            not_counted.append(f"{alt_name!r} is absent from this job")\n'
         "            continue"),
        "            continue",
    ),
    (
        ("Q12 the ABSENT reason reverts VERBATIM to the sentence round 10 "
         "removed for being untrue about a step nobody read a conclusion from"),
        "gates.py",
        'not_counted.append(f"{alt_name!r} is absent from this job")',
        'not_counted.append(f"{alt_name!r} did not conclude success")',
    ),
    (
        ("Q13 the only-detector/bookkeeping reason reverts to the generic "
         "sentence, so two different findings read identically"),
        "gates.py",
        ('                f"{alt_name!r} resolved only to the detector or to runner "\n'
         '                "bookkeeping, which is not this job\'s work"'),
        '                f"{alt_name!r} did not conclude success"',
    ),
    (
        ("Q15 the HOLLOW-primary precondition consults only the FIRST resolved "
         "step -- it gates BOTH routes, and `[:1]` is fail-OPEN: a duplicate "
         "primary that RAN reads as cleanly hollow"),
        "gates.py",
        ("        off = [\n"
         '            step_conclusion(s) or "NOT CONCLUDED"\n'
         "            for s in matches"),
        ("        off = [\n"
         '            step_conclusion(s) or "NOT CONCLUDED"\n'
         "            for s in matches[:1]"),
    ),
    # -- the SINGLE RESOLVER, which round 9 added and left unobserved ----------
    # Round 10. An independent reviewer built a sandbox of the same shape as this
    # one and ran three arms over `steps_named`. ALL THREE SURVIVED the 397-test
    # suite: no test named the function, no arm touched it, and the round-9 diff
    # added no regression case for the exploit it was written for. That is the
    # THIRD round running where a fix shipped without an instrument -- round 8
    # fixed the data and built none, round 9 fixed the logic and built none. The
    # bug changes shape each round; the meta-defect did not.
    (
        ("X1 exact-match-wins is DELETED, so a declared name resolves to every "
         "step that merely CONTAINS it again - round 9's blocker verbatim"),
        "gates.py",
        ('    exact = [s for s in steps if str(s.get("name") or "") == wanted]\n'
         "    if exact:\n"
         '        return exact, ""\n'),
        "",
    ),
    (
        ("X2 the ambiguity refusal is DELETED, so several loose matches and no "
         "exact hit silently returns ALL of them - the fail-closed control this "
         "resolver exists to add"),
        "gates.py",
        "    if len(loose) > 1:",
        "    if False:",
    ),
    (
        ("X3 the resolver returns only the FIRST exact match - the `[:1]` "
         "population narrowing this file records twice as the arm shape that "
         "lives, because a one-element slice still answers right whenever the "
         "fixture happens to order the interesting element first"),
        "gates.py",
        "    if exact:\n        return exact, \"\"",
        "    if exact:\n        return exact[:1], \"\"",
    ),
    (
        ("X4 one declared NAME resolving to steps that disagree stops refusing, "
         "so a DUPLICATE step name drops the output from the scope question - "
         "round 8's blocker restored where round 9 closed only the extending name"),
        "gates.py",
        "            if len(mine) > 1:",
        "            if False:",
    ),
    (
        ("X5 an output may declare its own DETECTOR as a gated step, which "
         "always runs - so that output is never 'unrun' and its scope is never "
         "compared, by a one-line policy edit"),
        "gates.py",
        "            if gate_step and gate_step in str(wanted):",
        "            if False:",
    ),
    (
        ("X6 an output may declare runner BOOKKEEPING as a gated step, same "
         "shape, different vocabulary"),
        "gates.py",
        "            if _is_bookkeeping_step(str(wanted)):",
        "            if False:",
    ),
    # -- the DELEGATED infra scope's two guards, added round 8 with no arms ---
    # Round 9. An independent reviewer grepped this file for `resolve_infra_ere`
    # and `top_level_dirs_agree` and found NOTHING: two guards were added to the
    # module the matrix exists to police and neither was mutable. Round 8's own
    # post-mortem lists "no arm had ever touched `receipts.ci_green_rule`" as a
    # reason round 6's hole survived -- and that reason had simply moved one file
    # over. The reviewer then killed the newline half by hand and it SURVIVED,
    # because the only fixture put the diagnostic BEFORE the ERE where the anchor
    # check already refuses it.
    (
        ("E1 the newline half of the ERE shape check drops, so a deriver that "
         "prints the ERE and THEN a warning returns a contaminated string that "
         "compiles, matches nothing, and EXCUSES"),
        "merge_gate.py",
        '    if not ere or "\\n" in ere or not ere.startswith("^("):',
        '    if not ere or not ere.startswith("^("):',
    ),
    (
        ("E2 the ANCHOR half drops, so a single-line diagnostic with no ERE at "
         "all is accepted as the delegated scope"),
        "merge_gate.py",
        '    if not ere or "\\n" in ere or not ere.startswith("^("):',
        '    if not ere or "\\n" in ere:',
    ),
    (
        ("E3 the two-clocks guard is never consulted, so a receipt answers the "
         "merged sha's infra scope from TODAY's possibly-narrower tree"),
        "merge_gate.py",
        "    if merged_sha and not _top_level_dirs_agree(merged_sha):",
        "    if False:",
    ),
    (
        ("E4 the two-clocks guard always AGREES - the shape where a guard is "
         "present, is called, and decides nothing"),
        "merge_gate.py",
        "    return not (at_merge - today)",
        "    return True",
    ),
    (
        ("E5 the two-clocks comparison INVERTS, so it refuses a widening (safe) "
         "and permits a narrowing (the excusing direction)"),
        "merge_gate.py",
        "    return not (at_merge - today)",
        "    return not (today - at_merge)",
    ),
    (
        ("E6 an unlistable merged tree AGREES instead of failing closed - "
         "'cannot be shown to agree' silently becoming 'agree'"),
        "merge_gate.py",
        "    if at_merge is None or today is None:\n        return False",
        "    if at_merge is None or today is None:\n        return True",
    ),
    # ROUND 10: three mutations of these same two guards SURVIVED E1-E6, found
    # by an independent reviewer. All three are an EXIT CODE stopping being read
    # -- the shape where a subprocess that failed is treated as one that answered
    # -- and the second is round 9's own fixture-conflation defect (one fixture
    # satisfying both halves of a check) one function further down, inside the
    # guard round 9 added arms for.
    (
        ("E7 `resolve_infra_ere` stops reading the DERIVER's exit code, so a "
         "crashed deriver's partial stdout becomes the delegated scope"),
        "merge_gate.py",
        "    if out.returncode != 0:\n        return None\n    ere = out.stdout.strip()",
        "    ere = out.stdout.strip()",
    ),
    (
        ("E8 `dirs()` stops reading `git ls-tree`'s exit code, so a failed "
         "listing reads as an EMPTY tree - and an empty `at_merge` subtracts to "
         "nothing, which AGREES"),
        "merge_gate.py",
        ("        if out.returncode != 0:\n            return None\n"
         "        found = {ln.strip() for ln in out.stdout.splitlines() if ln.strip()}"),
        "        found = {ln.strip() for ln in out.stdout.splitlines() if ln.strip()}",
    ),
    (
        ("E9 `dirs()` returns an EMPTY SET instead of None for an empty "
         "listing, so the caller's `is None` check passes and the comparison "
         "runs against nothing"),
        "merge_gate.py",
        "        return found or None",
        "        return found",
    ),
    # Round 8, found by BOTH independent reviewers by different methods. Every
    # policy arm above targets `review.escalate_to_two_when_path_contains`; not
    # one touched `receipts.ci_green_rule`, so `killed=213 survived=0` was
    # silent about the entire round-7 data restructure. Deleting an output is
    # the mutation that reproduces round 6's blocker verbatim, and it left
    # `391 passed` untouched.
    (
        ("R17 the `portal` output drops out of the `next build (node 20)` scope "
         "row -- round 6's blocker verbatim: that job is the portal's ONLY "
         "blocking check, so a portal-only merge whose grep did not fire is "
         "excused with 'there was nothing for it to do'"),
        "policy.json",
        (',\n            {\n              "output": "portal",\n'
         '              "paths": ["portal/react-webapp/**", '
         '".github/workflows/fiab-console-ci.yml"],\n'
         '              "gates": ["Jest (portal)", "Type-check (portal)"]\n'
         "            }"),
        "",
    ),
    (
        ("R18 the `infra` output drops out of the `vitest (node 20)` scope row "
         "-- the COMPUTED shape, whose scope is named in no literal list, so an "
         "under-declared row here is invisible in review as well as in CI"),
        "policy.json",
        (',\n            {\n              "output": "infra",\n'
         '              "paths": "derive-infra-reading-suites.mjs --ere",\n'
         '              "gates": ["Run vitest (infra-reading suites only)"]\n'
         "            }"),
        "",
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
        ("MG36 the UNKNOWN fallback borrows a KNOWN kind's sentence, so round "
         "9's blocker returns for any kind added later"),
        "gates.py",
        "_unannounced_kind(prior_verdict), UNANNOUNCED_REASON_UNKNOWN)}\"",
        ("_unannounced_kind(prior_verdict), "
         "UNANNOUNCED_REASON_BY_KIND[NEAR_NO_MARKER])}\""),
    ),
    # -- the measurement script MODELS the gates. A wrong model is worse than
    # none, and it shipped with ZERO arms and ZERO tests -- which is how both
    # reviewers came to find the same defect in it in the same round.
    (
        ("OP1 the model ANDs the RECEIPT into the stream test again, so it "
         "reports gate 6's answer under gate 3b's name"),
        "operating_point.py",
        "        stream_known = (\n            item.pr == pr if item.pr is not None",
        ("        stream_known = led.receipt_ok(item)[0] and (\n"
         "            item.pr == pr if item.pr is not None"),
    ),
    (
        ("OP2 the model accepts an item bound to ANY PR rather than THIS one, "
         "over-reporting the permissive population in the unsafe direction"),
        "operating_point.py",
        "            item.pr == pr if item.pr is not None",
        "            item.pr is not None if item.pr is not None",
    ),
    (
        ("OP3 the model hardcodes the scheduled states instead of importing "
         "them, so a fourth state diverges it in silence"),
        "operating_point.py",
        "            else item.state in merge_gate.SCHEDULED_STATES",
        '            else item.state in ("in-flight", "in-review")',
    ),
    (
        ("OP4 the receipt count is folded back into the 3b number, so the two "
         "gates are reported as one again"),
        "operating_point.py",
        "        if needed == 1:\n            one_reviewer += 1",
        ("        if needed == 1 and led.receipt_ok(item)[0]:\n"
         "            one_reviewer += 1"),
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
        # Anchored on the CALL SITE, not on the `HARNESS` literal. The literal
        # changes every time a number is pinned, and each such change dragged
        # this file along with it -- which is how the previous description was
        # made false. `if number in HARNESS:` occurs exactly once and does not
        # move when the set does, so the mutation semantics are identical and
        # the coupling is gone.
        #
        # The description deliberately carries NO COUNT and names NO ISSUE. The
        # version this replaced said "every pinned item falls through to
        # W4-receipts on its TITLE"; two of the seven it dropped carried
        # `lane:ci` and fell to W6-ci instead, and the first attempt at THIS
        # description said "the other seven" and was falsified in the same
        # round by adding two more pins. A description that counts the set it
        # mutates rots on the next edit to that set. This one states the RULE
        # and the WITNESS -- the fixtures that catch the arm pass no labels.
        ("B1 the harness pin is narrowed to its first four numbers, so an "
         "UNLABELLED harness item is classified by its TITLE instead and lands "
         "in W4-receipts, demanding an estate receipt it can never obtain"),
        "build_inventory.py",
        "    if number in HARNESS:",
        "    if number in {4466, 4467, 4468, 4469}:",
    ),
    (
        "P11 a policy read via a LOCAL ALIAS is invisible to the allow-list scan",
        "gates.py",
        "            if re.search(alias, flat):",
        "            if False:",
    ),
    (
        "P10 the section half of the policy-read scan rejects `.get(` again",
        "gates.py",
        '            step = r"(?:\\[|\\.get\\()\\s*[\\"\']{}[\\"\']"',
        '            step = r"\\[\\s*[\\"\']{}[\\"\']"',
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
        # The anchor carries the NEXT line's comment, because the depth test now
        # occurs in more than one walker and `replace(old, new, 1)` took the
        # first -- so the arm mutated a different function and SURVIVED. An
        # ambiguous anchor is a mutation aimed somewhere other than where it reads.
        "gates.py",
        ('        parts = dotted.split(".")\n        if len(parts) > 1:\n'
         "            # THE CHAIN, TO ANY DEPTH."),
        ('        parts = dotted.split(".")\n        if len(parts) == 1:\n'
         "            continue\n        if len(parts) > 1:\n"
         "            # THE CHAIN, TO ANY DEPTH."),
    ),
    (
        ("P15 the policy-read scan stops collapsing whitespace, so a chained read "
         "written across LINES - this package's own house style - reads as unread"),
        "gates.py",
        '    flat = re.sub(r"\\s+", " ", sources)',
        "    flat = sources",
    ),
    (
        ("P14 the allow-list scan partitions on the FIRST dot again, so a "
         "THREE-deep control can be moved onto it undetected"),
        "gates.py",
        ("            chain = step.format(re.escape(parts[0])) + \"\".join(\n"
         '                r"[^\\n]{0,20}?" + step.format(re.escape(part)) '
         "for part in parts[1:]\n            )"),
        ('            chain = step.format(re.escape(parts[0])) + r"[^\\n]{0,20}?" '
         '+ step.format(re.escape(".".join(parts[1:])))'),
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
        ("            if dotted not in OTHER_IMPLEMENTED_BY and "
         "dotted not in OPERATOR_DOCUMENTATION:\n                missing.append(dotted)"),
        "            pass",
    ),
    (
        ("P12 a dict-valued key exempts every sub-key under it again, "
         "so an unread `receipts.*` is structurally unreachable"),
        "gates.py",
        "                walk(value, dotted)",
        "                pass",
    ),
    (
        ("P13 the policy-key walk stops at TWO levels again, so a three-deep "
         "unread key is structurally unmissable - the round-4 blocker"),
        "gates.py",
        '            dotted = f"{prefix}.{key}" if prefix else key',
        ('            dotted = f"{prefix}.{key}" if prefix else key\n'
         '            if prefix and "." in prefix:\n                continue'),
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

    # -- the `ci-green` receipt (#4487) -------------------------------------
    #
    # The receipt's whole risk is that it degrades into "absence is excused".
    # The old definition named a measurement the topology cannot produce, which
    # left exactly two outcomes: nothing closes, or somebody quietly accepts
    # 10-of-15. Every arm here re-creates the second one, and the two the issue
    # asked for by name -- the path-filtered case and the renamed-context case
    # -- are CG1 and CG2.
    #
    # CG3/CG9/CG13 are POPULATION-NARROWING, per this file's second lesson:
    # they do not weaken a check, they shrink what the check looks at. Those are
    # the arms that survive an author-written matrix.
    (
        ("CG1 a never-created workflow run excuses the absence WITHOUT consulting "
         "the push trigger (the path-filtered case becomes 'absence is fine')"),
        "gates.py",
        "    if runs:",
        "    if False:",
    ),
    (
        ("CG2 the renamed sibling is accepted whatever its run concluded "
         "(the renamed-context case stops checking the run)"),
        "gates.py",
        'if conclusion != "SUCCESS":',
        "if False:",
    ),
    (
        "CG3 the receipt judges only the FIRST required context",
        "gates.py",
        "    for item in evidence:",
        "    for item in evidence[:1]:",
    ),
    (
        "CG4 a PR-head result stands in for a merged sha over a DIFFERENT tree",
        "gates.py",
        "    if not trees_identical:",
        "    if False:",
    ),
    (
        "CG5 an untraceable producer stops failing closed",
        "gates.py",
        "    if not item.workflow_path:",
        "    if False:",
    ),
    (
        ("CG6 the glob gets fnmatch semantics, so `*` crosses a `/` and a "
         "top-level filter looks like it admitted a nested file"),
        "gates.py",
        'out.append("[^/]*")',
        'out.append(".*")',
    ),
    (
        ("CG7 `**/` must consume at least one segment, so `deploy/**/*.bicep` "
         "stops matching `deploy/x.bicep`"),
        "gates.py",
        'out.append("(?:.*/)?")',
        'out.append(".*/")',
    ),
    (
        ("CG8 the YAML 1.1 `on:`->True key is dropped, so EVERY real workflow "
         "reads as having no push trigger and every absence is excused at once"),
        "gates.py",
        'doc.get("on", doc.get(True))',
        'doc.get("on")',
    ),
    (
        "CG9 the path filter is applied to only the FIRST changed file",
        "gates.py",
        "    files = [f for f in changed_files if f]",
        "    files = [f for f in changed_files if f][:1]",
    ),
    (
        ("CG10 an EMPTY required set is a green receipt (`all([])` is True, one "
         "module along from the `drained: true` over 297 open issues)"),
        "gates.py",
        "    if not contexts:",
        "    if False:",
    ),
    (
        ("CG11 a merged sha with ZERO check-runs stops guarding the receipt, so "
         "every absence is excused one at a time over a commit where nothing ran"),
        "gates.py",
        '    if classify_missing(merged_total_count, waiting=False) == "never-created":',
        "    if False:",
    ),
    (
        ("CG12 an UNMEASURED changed-file set excuses a path filter, so "
         "'it did not run' is inferred from 'I read no files'"),
        "gates.py",
        '        if not files:\n            return True, "no changed files were measured',
        '        if not files:\n            return False, "no changed files were measured',
    ),
    (
        ("CG13 the shared de-duplication takes the FIRST run for a context name, "
         "so a green re-run hides one that measured nothing"),
        "gates.py",
        "        if prior is None or _check_rank(check) > _check_rank(prior):",
        "        if prior is None:",
    ),

    # -- the two blockers from #4491's independent review --------------------
    #
    # Both reviewers returned REQUEST-CHANGES, from different angles, and
    # converged on the same two holes. Reviewer 2 also wrote six arms against
    # the COLLECTOR -- 216 lines with no tests and no arms -- and FIVE SURVIVED
    # the full suite, the worst being `trees_identical = True` hardcoded, the
    # single condition the whole deferral rests on. CG4 killed the consumer in
    # gates.py; nothing mutated the producer. "168/168 KILLED" was true about
    # the pure function and not about the program deciding its inputs.
    #
    # CB* are those arms, now that the producer's decisions live in tested
    # functions rather than inline in the collector.
    (
        ("CB1 a PR-head green that did NOT execute its declared substantive step "
         "is deferrable again (the test.yml pull_request shape)"),
        "gates.py",
        ("    ran, evidence, route = context_is_accounted_for(\n"
         "        item.name, item.head_job, merged_changed_files, policy,\n"
         "        push_trigger=item.push_trigger, infra_ere=infra_ere,\n"
         "        declared_at=declared_at,\n"
         "    )\n    if not ran:"),
        ("    ran, evidence, route = context_is_accounted_for(\n"
         "        item.name, item.head_job, merged_changed_files, policy,\n"
         "        push_trigger=item.push_trigger, infra_ere=infra_ere,\n"
         "        declared_at=declared_at,\n"
         "    )\n    if False:"),
    ),
    (
        ("SC9 an UNREPRESENTABLE pattern in a declared scope propagates out of "
         "the gate instead of failing closed - a crash, not a refusal"),
        "gates.py",
        "    except UnsupportedPatternError as exc:\n        return None, (",
        "    except UnsupportedPatternError as exc:\n        return [], (",
    ),
    (
        ("SC8 a DELEGATED scope resolves to an empty path list instead of failing "
         "closed, so `on.push.paths` excuses every skip under it"),
        "gates.py",
        "        if push_trigger is None or not push_trigger.paths:",
        "        if False:",
    ),
    (
        "CB2 `job_executed` stops fail-closing on absent step data",
        "gates.py",
        ('    if not isinstance(job, dict):\n'
         '        return False, "no job record was read for it, so it cannot be shown to have run"\n'
         '    steps = job.get("steps")\n'
         '    if not isinstance(steps, list) or not steps:\n'
         '        return False, "its job record carries no steps, so it cannot be shown to have run"\n'
         '    substantive = ['),
        ('    if not isinstance(job, dict):\n'
         '        return True, "no job record was read for it, so it cannot be shown to have run"\n'
         '    steps = job.get("steps")\n'
         '    if not isinstance(steps, list) or not steps:\n'
         '        return False, "its job record carries no steps, so it cannot be shown to have run"\n'
         '    substantive = ['),
    ),
    (
        ("CB3 `job_executed` counts runner BOOKKEEPING as work, so a job whose "
         "real steps were all skipped reads as having run"),
        "gates.py",
        "        if isinstance(step, dict) and not _is_bookkeeping_step(str(step.get(\"name\") or \"\"))",
        "        if isinstance(step, dict)",
    ),
    (
        ("CB4 a SKIPPED declared substantive step counts as executed, so the "
         "check that concluded green without doing its work passes"),
        "gates.py",
        '        return step_conclusion(step) != "skipped"',
        "        return True",
    ),
    (
        ("CB4b green-at-merge returns a pass on the check CONCLUSION alone - the "
         "branch that carries 14 of 15 contexts, and the defect both reviewers "
         "found one branch along from the deferral one"),
        "gates.py",
        ("        did_work, evidence, route = context_is_accounted_for(\n"
         "            item.name, item.merged_job, merged_changed_files, policy,\n"
         "            infra_ere=infra_ere, declared_at=declared_at,\n"
         "        )\n        if not did_work:"),
        ("        did_work, evidence, route = context_is_accounted_for(\n"
         "            item.name, item.merged_job, merged_changed_files, policy,\n"
         "            infra_ere=infra_ere, declared_at=declared_at,\n"
         "        )\n        if False:"),
    ),
    (
        ("CB4h green-at-merge falls back to the PR-HEAD job when no merged job "
         "was read - the `pull_request` hollow shape standing in for the merge. "
         "An independent reviewer wrote this arm and it SURVIVED"),
        "gates.py",
        "            item.name, item.merged_job, merged_changed_files, policy",
        "            item.name, item.merged_job or item.head_job, merged_changed_files, policy",
    ),
    (
        ("CB4c an UNDECLARED context stops failing closed, so adding a required "
         "context silently removes it from the receipt"),
        "gates.py",
        "    if not candidates:\n        return False, (\n            f\"no substantive step is DECLARED",
        "    if not candidates:\n        return True, (\n            f\"no substantive step is DECLARED",
    ),
    (
        ("CB4d the declared step is matched but its SKIPPED state is ignored - "
         "presence of the step, rather than its execution, decides"),
        "gates.py",
        "            if len(skipped) == len(matches):\n                hollow.append(wanted)",
        "            if False:\n                hollow.append(wanted)",
    ),
    (
        ("CB4i only the FIRST step matching a declared substring decides, so a "
         "declaration that matches several steps is satisfied by any one of them. "
         "An independent reviewer wrote this arm and it SURVIVED"),
        "gates.py",
        "        skipped = [s for s in matches if not ran(s)]",
        "        skipped = [s for s in matches[:1] if not ran(s)]",
    ),
    (
        ("CB4j the ALL rule inspects only the first 50 work steps, so the "
         "158-step context it was written for is unchecked past step 50. "
         "An independent reviewer wrote this arm and it SURVIVED"),
        "gates.py",
        "        skipped = [s for s in work if not ran(s)]",
        "        skipped = [s for s in work[:50] if not ran(s)]",
    ),
    (
        ("CB4k only the FIRST failing context contributes a reason, so a receipt "
         "under-reports what is wrong with it. An independent reviewer wrote "
         "this arm and it SURVIVED"),
        "gates.py",
        '            reasons.append(f"{result.name}: {result.detail}")',
        '            reasons[:0] = [f"{result.name}: {result.detail}"][: 1 - len(reasons)]',
    ),
    (
        ("CB4e a STALE declaration (step absent from the job) passes instead of "
         "failing closed, so a renamed step silently stops being checked"),
        "gates.py",
        "        if missing:\n            return False, \"missing\", missing",
        "        if False:\n            return False, \"missing\", missing",
    ),
    # -- the declaration resolved AS OF the measured sha (#4676) ------------
    #
    # AS1 is the arm the issue asked for: revert the resolution to HEAD. AS2
    # and AS3 are the ones that matter more, because they NARROW THE POPULATION
    # rather than weaken a check -- the lesson of the N* arms, and the shape an
    # author fixing their own defect does not think to write. AS2 resolves only
    # `substantive_steps` and leaves `alternatives` and `scope_paths` on HEAD's
    # clock; AS3 leaves the producer reading HEAD's blob for every sha, so the
    # consumer is perfect and is fed one answer forever.
    (
        ("AS1 the declaration is resolved at HEAD again, so any step rename "
         "retroactively voids every older PR's receipt (#4676)"),
        "gates.py",
        '    if as_of is None:\n        return policy, DECL_HEAD, ""',
        '    if True:\n        return policy, DECL_HEAD, ""',
    ),
    (
        ("AS2 only `substantive_steps` is resolved as-of; `alternatives` and "
         "`scope_paths` stay on HEAD's clock, so routes 2 and 3 ask a "
         "pre-rename job about a post-rename step"),
        "gates.py",
        ('    receipts = dict(policy.get("receipts", {}))\n'
         '    receipts["ci_green_rule"] = as_of.rule'),
        ('    receipts = dict(policy.get("receipts", {}))\n'
         '    _narrowed = dict(receipts.get("ci_green_rule", {}))\n'
         '    _narrowed["substantive_steps"] = as_of.rule.get("substantive_steps", {})\n'
         '    receipts["ci_green_rule"] = _narrowed'),
    ),
    (
        ("AS3 the PRODUCER reads HEAD's policy blob for every sha, so the "
         "as-of resolution is perfect and is handed one answer forever - the "
         "168/168-KILLED-about-the-pure-function shape"),
        "merge_gate.py",
        '    rc, out, err = sh(["git", "show", f"{sha}:{POLICY_TRACKED_PATH}"])',
        '    rc, out, err = sh(["git", "show", f"HEAD:{POLICY_TRACKED_PATH}"])',
    ),
    (
        ("AS4 the other clock is reached on ANY refusal, not only on ABSENCE, "
         "so a job that SKIPPED the step its sha's declaration names is "
         "re-judged against HEAD's and a hollow check passes"),
        "gates.py",
        '    if kind == "missing" and len(candidates) > 1:',
        "    if len(candidates) > 1:",
    ),
    (
        ("AS5 the second clock's KIND is discarded again, so a step that is "
         "PRESENT and SKIPPED at HEAD is reported as ABSENT - an R7 lie, and "
         "one-sentence-for-two-states inside the fix for one-sentence-for-"
         "two-states"),
        "gates.py",
        "        ok2, other_kind, other_payload = verdict(other_rule)",
        "        ok2, _discarded_kind, other_payload = verdict(other_rule)",
    ),
    (
        ("AS6 a declaration that PREDATES `substantive_steps` is told to fetch "
         "a sha that is already present and readable - the wrong remedy for "
         "every merge older than 2026-09-15"),
        "gates.py",
        # NEWLINE-ANCHORED so the indentation is part of the needle. There are
        # now TWO `if reason == DECL_PREDATES:` sites -- the refusal and
        # `provenance_note` -- and the bare form matches inside the more deeply
        # indented one as a substring.
        "\n        if reason == DECL_PREDATES:",
        "\n        if False:",
    ),
    (
        ("AS9 a pass decided on an UNVERIFIED or PREDATES clock prints no "
         "provenance at all, so a shallow clone silently degrades to pre-PR "
         "behaviour while every pass still reads as verified"),
        "gates.py",
        "        if which == DECL_HEAD_UNVERIFIED:\n            reason =",
        "        if False:\n            reason =",
    ),
    (
        ("AS10 the hollow payload is a finished SENTENCE again, so the "
         "second-clock refusal wraps it as if it were a list and prints the "
         "trailing clause twice"),
        "gates.py",
        '            return False, "hollow", hollow\n',
        ('            return False, "hollow", (\n'
         '                f"its declared substantive step(s) {hollow} were SKIPPED - '
         'the check "\n'
         '                "concluded green having not done the thing it is required '
         'for"\n'
         '            )\n'),
    ),
    (
        ("AS7 HEAD's declaration is substituted UNDISCLOSED when the sha's "
         "declaration carried no row for the context - the row is newer than "
         "the sha, and the pass says nothing about it"),
        "gates.py",
        "            head_which = DECL_HEAD_ROW_NEWER",
        "            head_which = DECL_HEAD",
    ),
    (
        ("AS8 the receipt call is RE-SPLIT into two hand-maintained argument "
         "lists, so `tick` can once again record a receipt "
         "`--ci-green-receipt` would not print"),
        "tick.py",
        "        receipt = merge_gate.receipt_from_evidence(data, policy)",
        ("        receipt = gates.ci_green_receipt(\n"
         "            data[\"evidence\"],\n"
         "            merged_total_count=data[\"merged_total_count\"],\n"
         "            merged_changed_files=data[\"changed_files\"],\n"
         "            merged_branch=data[\"branch\"],\n"
         "            merged_sha=data[\"merged\"],\n"
         "            trees_identical=data[\"trees_identical\"],\n"
         "            policy=policy,\n"
         "            infra_ere=merge_gate.resolve_infra_ere(data[\"merged\"]),\n"
         "        )"),
    ),
    (
        ("CB4f the ALL rule accepts any number of skipped steps, so guardrails "
         "and Repo Hygiene stop being checked at all"),
        "gates.py",
        "            skipped = [s for s in work if not ran(s)]\n            if skipped:",
        "            skipped = [s for s in work if not ran(s)]\n            if False:",
    ),
    (
        ("CB4g the policy contract walks only the first level again, so a "
         "three-deep key the authority does not carry goes unnoticed"),
        "gates.py",
        "            if not isinstance(node, dict) or part not in node:\n                absent.append(dotted)",
        "            if False:\n                absent.append(dotted)",
    ),
    (
        ("CB5 the rename stops requiring the `push` event, so a green cron or "
         "dispatch supplies the evidence for a push that went red"),
        "gates.py",
        '    if event != "push":',
        "    if False:",
    ),
    (
        "CB6 the rename stops requiring the run to be about the merged commit",
        "gates.py",
        "    if not head_sha or (merged_sha and head_sha != merged_sha):",
        "    if False:",
    ),
    (
        "CB7 an EMPTY job list is evidence of a rename again",
        "gates.py",
        "    if not jobs:",
        "    if False:",
    ),
    (
        ("CB8 a run that DOES carry the required context still counts as a "
         "rename, asserting a cause the evidence contradicts"),
        "gates.py",
        "    if item.name in names:",
        "    if False:",
    ),
    (
        ("CB9 the standing-in sibling no longer has to have executed anything, "
         "so the hollow-green hole reopens inside the rename case"),
        "gates.py",
        '        if ok and str(j.get("conclusion") or "").lower() == "success"',
        "        if True",
    ),
    (
        ("CB10 `select_merged_run` takes the NEWEST run of a path regardless of "
         "event - reviewer 2's attack on the collector, at its new home"),
        "gates.py",
        '        and str(run.get("event") or "").lower() == "push"',
        "        and True",
    ),
    (
        "CB11 `select_merged_run` stops pinning to the merged sha",
        "gates.py",
        '        and str(run.get("head_sha") or "") == merged_sha',
        "        and True",
    ),
    (
        ("CB12 the glob silently treats an unrepresentable pattern as a literal, "
         "which UNDER-matches - the direction that EXCUSES an absence"),
        "gates.py",
        "    if _UNSUPPORTED_GLOB.search(pattern):\n        raise UnsupportedPatternError(pattern)",
        "    if False:\n        raise UnsupportedPatternError(pattern)",
    ),
    (
        ("CB13 an unrepresentable pattern in a push trigger resolves to "
         "DID-NOT-RUN instead of RUNS, so it excuses rather than refuses"),
        "gates.py",
        "                return True, (\n                    f\"`{label}` contains {pattern!r}, which this translator cannot \"",
        "                return False, (\n                    f\"`{label}` contains {pattern!r}, which this translator cannot \"",
    ),

    # -----------------------------------------------------------------------
    # SC* -- the SCOPE-UNTOUCHED branch (#4487 round 4).
    #
    # This branch is an EXCUSE, and an excuse is the most dangerous kind of code
    # in this package: every weakening of it turns a check that ran nothing into
    # a green receipt. So it is mutated harder than the rule it excuses.
    # -----------------------------------------------------------------------
    (
        ("SC1 the scope excuse stops reading the merged files, so ANY skip is "
         "excused as 'nothing in scope changed'"),
        "gates.py",
        "    hits = sorted({f for f in files if _any_match(tuple(paths), [f])})",
        "    hits = []",
    ),
    (
        ("SC2 the gate step's own conclusion stops being checked, so a job whose "
         "DETECTOR was itself skipped excuses its skipped work"),
        "gates.py",
        "    if off:\n        return False, (\n            f\"its declared gate step {gate_step!r} matches",
        "    if False:\n        return False, (\n            f\"its declared gate step {gate_step!r} matches",
    ),
    (
        ("SC10 a SIBLING gate step answers for a skipped one - `any()` over a "
         "SUBSTRING-matched population, which is the round-5 blocker and the same "
         "any/all asymmetry context_did_its_work had already fixed"),
        "gates.py",
        ("        for s in detectors\n"
         '        if step_conclusion(s) != "success"'),
        ("        for s in detectors[:0]\n"
         '        if step_conclusion(s) != "success"'),
    ),
    (
        ("SC11 the scope excuse stops asking whether any work step RAN, so "
         '"nothing for it to do" is printed about a job that did work'),
        "gates.py",
        "    if did_run:\n        return False, (",
        "    if False:\n        return False, (",
    ),
    (
        ("SC12 only the FIRST declared scope pattern is applied, so a merge that "
         "matches only the SECOND is excused - the #3783 case, laundered"),
        "gates.py",
        "        hits = sorted({f for f in files if _any_match(tuple(paths), [f])})",
        "        hits = sorted({f for f in files if _any_match(tuple(paths[:1]), [f])})",
    ),
    (
        ("CB4l a declared ALTERNATIVE that was SKIPPED counts as work done, so "
         "the two-output job stops being checked on either half"),
        "gates.py",
        '        if concluded == {"success"}:',
        "        if concluded:",
    ),
    # ROUND 6. Four arms an independent reviewer wrote against round 5's new
    # code, ALL FOUR OF WHICH SURVIVED. The lesson is the one this file records
    # twice already and the author has now failed to apply three rounds running:
    # the author mutates the CHECK, the reviewer narrows the POPULATION, and it
    # is the population narrowing that lives. `[:1]` is the honest shape of an
    # accident where `[:0]` is not, because a one-element slice still reaches
    # the right answer on any fixture that happens to order the interesting
    # element first -- which is exactly why R2A3 survived.
    (
        ("R2A1 only the FIRST declared alternative is consulted, so a job whose "
         "SECOND alternative ran stops being accounted for"),
        "gates.py",
        "    for alt in alternatives:",
        "    for alt in list(alternatives)[:1]:",
    ),
    (
        ("R2A6 alternatives are consulted only when EXACTLY ONE is declared - "
         "i.e. the feature is deleted for half its declared population, and "
         "before round 6 no test named `Jest (portal)` at all"),
        "gates.py",
        "    if not isinstance(alternatives, list) or not alternatives:",
        "    if not isinstance(alternatives, list) or len(alternatives) != 1:",
    ),
    (
        ("R2A3 the gate-step all() reads only the FIRST detector - the honest "
         "narrowing of round 5's own any()->all() blocker fix"),
        "gates.py",
        ('        for s in detectors\n'
         '        if step_conclusion(s) != "success"'),
        ('        for s in detectors[:1]\n'
         '        if step_conclusion(s) != "success"'),
    ),
    (
        ("R2A5 a FAILED work step stops counting as work, so the excuse prints "
         "'nothing for it to do' about a job that ran a step and it failed"),
        "gates.py",
        '        and step_conclusion(s) != "skipped"',
        '        and step_conclusion(s) not in ("skipped", "failure")',
    ),
    (
        ("SC3 a context with no declared scope BORROWS another context's, so the "
         "excuse stops being per-context at all"),
        "gates.py",
        "    return row if isinstance(row, dict) else None",
        ("    return row if isinstance(row, dict) else next(\n"
         "        (r for r in (policy.get(\"receipts\", {}).get(\"ci_green_rule\", {})\n"
         "                     .get(\"scope_paths\", {}) or {}).values()\n"
         "         if isinstance(r, dict)), None)"),
    ),
    (
        ("SC4 an EMPTY merged changed-file list is excused instead of refused, so "
         "an unreadable diff reads as 'nothing in scope changed'"),
        "gates.py",
        '    if not files:\n        return False, (',
        '    if False:\n        return False, (',
    ),
    (
        ("SC5 a declared step that FAILED counts as a scope skip, so a red step "
         "is laundered into an excused one"),
        "gates.py",
        "        if off:\n            return False, (",
        "        if False:\n            return False, (",
    ),
    (
        ("SC6 the gate step's ABSENCE stops failing closed, so a stale "
         "declaration excuses a skip it cannot explain"),
        "gates.py",
        "    if not detectors:\n        return False, (",
        "    if not detectors:\n        return True, (",
    ),
    (
        ('SC7 the scope excuse accepts an "ALL" declaration, for which no single '
         "step can be named as the one that was scope-skipped"),
        "gates.py",
        "    if not isinstance(declared_steps, list) or not declared_steps:\n        return False, (",
        "    if not isinstance(declared_steps, list) or not declared_steps:\n        return True, (",
    ),
    (
        ("CB14 the job join reads only the FIRST workflow run, so a context "
         "published by a second run of the same sha has no steps and the receipt "
         "fails on 'no job record' - or, with a permissive branch, passes on one. "
         "An independent reviewer wrote this arm and it SURVIVED"),
        "merge_gate.py",
        "    for run_id in run_ids:\n        for job in _jobs_of_run(repo, run_id):",
        "    for run_id in list(run_ids)[:1]:\n        for job in _jobs_of_run(repo, run_id):",
    ),
    # -- FINDING 5 (#4518): the job-conclusion check, lifted to ALL THREE -----
    # routes. U2/U3 above cover route 1's own copy, which stays because
    # `context_did_its_work` is a public predicate called directly by the suite
    # (14 direct call sites in `test_ci_green_declared.py`, measured -- an
    # earlier draft of this said 15 without counting).
    #
    # DISCLOSED, because a reviewer measured it and it cuts against keeping the
    # copy: route 1's copy is DEAD IN THE COMPOSED PATH. Deleting it scores
    # identically on all 150 real contexts and all 8 synthetic rows, because the
    # all-routes gate below now refuses first. It is retained only for the
    # standalone predicate, and the two copies have ALREADY diverged in order
    # and message -- the same drift class this change exists to close, one level
    # down. Tracked as #4527 rather than restructured mid-review, because
    # extracting the shared helper deletes the very lines U2/U3 anchor on.
    #
    # These three cover the all-routes gate in `context_is_accounted_
    # for`, and each is killed ONLY by a job that route 1 would never see --
    # one that the scope-skip or alternative route would otherwise accept.
    (
        ("F5A1 the all-routes gate stops fail-closing on an ABSENT job record, "
         "so a context with no job at all is handed to the scope and "
         "alternative routes, which never read a job verdict"),
        "gates.py",
        ("    if not isinstance(job, dict):\n"
         "        return False, (\n"
         '            "no job record was read for it, so nothing about it can be shown - "'),
        ("    if not isinstance(job, dict):\n"
         "        return True, (\n"
         '            "no job record was read for it, so nothing about it can be shown - "'),
    ),
    (
        ("F5A2 the all-routes NOT-CONCLUDED refusal collapses, so a job still "
         "RUNNING is excused by a scope skip or an alternative and answers for "
         "a merge"),
        "gates.py",
        # NOT `if False:` ON THE `is None` BRANCH -- that is a WEAK MUTANT, and
        # an independent reviewer caught the first version of this arm being
        # one. Skipping the branch leaves `job_verdict` as `None`, and
        # `if job_verdict != "success":` on the very next lines still refuses,
        # so the gate does NOT fail open: measured `acct=False route=''`. Only
        # the MESSAGE changes, so the arm would report KILLED while the
        # fail-open its own name promises was never produced -- the receipt
        # would claim the suite catches something it was never shown.
        #
        # Mapping `None -> "success"` produces the real thing: measured
        # `acct=True route='scope-untouched-at-merge'` for a job that never
        # concluded, killed by
        # `test_blocker_a_job_that_has_not_concluded_is_not_excused_by_its_scope`
        # on `assert not acct` rather than on a substring.
        ("    job_verdict = step_conclusion(job)\n"
         "    if job_verdict is None:\n"
         "        return False, (\n"
         '            "its job record has not concluded, so nothing about it can be "'),
        ('    job_verdict = step_conclusion(job) or "success"\n'
         "    if job_verdict is None:\n"
         "        return False, (\n"
         '            "its job record has not concluded, so nothing about it can be "'),
    ),
    (
        ("F5A3 the all-routes FAILURE refusal collapses, so a job that "
         "concluded `failure` is still accounted for by its scope excuse or by "
         "a declared alternative - the exact hole finding 5 names"),
        "gates.py",
        ('    if job_verdict != "success":\n'
         "        return False, (\n"
         '            f"its job concluded {job_verdict!r}, not success - no route can "'),
        ("    if False:\n"
         "        return False, (\n"
         '            f"its job concluded {job_verdict!r}, not success - no route can "'),
    ),
    # -- THE RECEIPT WRITE PATH ----------------------------------------------
    # README recorded this as the gap for as long as the ledger has existed:
    # `record_receipt` had no production caller, so every close was a hand edit
    # to an untracked file and "the write path is outside the instrumented
    # code". These arms are what keeps the new writer instrumented -- each was
    # measured RED against its named test on a sandbox copy before being added.
    (
        ("RW1 a required step that is ABSENT stops being refused, so a green run "
         "that skipped the work - a smoke-only loom-ui-verify, or a roll whose "
         "job was skipped at 0 steps - is accepted as a receipt over nothing"),
        "tick.py",
        "        if not found:\n            raise ReceiptRefusedError(",
        "        if False:\n            raise ReceiptRefusedError(",
    ),
    (
        ("RW1b the required-steps map resolves to nothing, so every run-backed "
         "kind silently degrades to a RUN-LEVEL check - the exact shape that "
         "wired this defect to one of three kinds in the first place"),
        "tick.py",
        '    required_steps = (policy.get("receipt_required_steps", {}) or {}).get(kind)',
        "    required_steps = [] if kind else None",
    ),
    (
        ("RW2 the workflow-identity check collapses, so a green run of ANY "
         "workflow establishes any run-backed receipt - a fact about that "
         "workflow read as a fact about this item"),
        "tick.py",
        '    actual = run.get("workflowName")\n    if actual != expected:',
        '    actual = run.get("workflowName")\n    if False:',
    ),
    (
        ("RW3 an UNDECLARED receipt kind stops failing closed AT THE PRODUCER "
         "CHECK. DISCLOSED AS A MESSAGE ARM, not a behaviour one: `operator` is "
         "still refused downstream because it declares no required steps, so "
         "this mutation changes the stated REASON and not the outcome. That is "
         "defense in depth, and an R7 defect is worth an arm on its own - a "
         "refusal that names the wrong cause sends the reader to the wrong fix. "
         "Named rather than left to look like a behaviour kill, per "
         "assertion-design.md's ban on reporting an arm without saying which it "
         "pins. A reviewer caught the first version claiming more than it did"),
        "tick.py",
        ('    if not expected:\n        raise ReceiptRefusedError(\n'
         '            f"receipt kind {kind!r} has no declared producer'),
        ('    if False:\n        raise ReceiptRefusedError(\n'
         '            f"receipt kind {kind!r} has no declared producer'),
    ),
    (
        ("RW4 an IN-PROGRESS run stops being distinguished from a finished one, "
         "so a run still in flight is read as a verdict. STRONG on the fixture "
         "that matters: GitHub reports a `conclusion` from a previous attempt "
         "while `status` is in_progress, and on that input this check is the "
         "ONLY thing refusing - the first version of the test used "
         "conclusion=None, where the conclusion check refuses anyway and the "
         "arm was therefore weak"),
        "tick.py",
        '    if run.get("status") != "completed":',
        "    if False:",
    ),
    (
        ("RW5 an already-terminal item can be re-receipted, so a second caller's "
         "run silently replaces the evidence the first one closed on"),
        "tick.py",
        "    if item.state in TERMINAL:",
        "    if False:",
    ),
    # THE FOUR SURVIVORS an independent reviewer found. RW1-RW5 covered the
    # run-backed branch and left the ci-green decide path and the entry
    # refusals unwatched -- and the worst of them was the one the PR body
    # offered as its end-to-end proof.
    (
        ("RW6 a NOT-GREEN ci-green receipt closes the item anyway. The reviewer's "
         "measurement: mutated, the suite stayed at 474 passed, so a receipt the "
         "`--ci-green-receipt` report would print as NOT GREEN still closed a "
         "guard-or-test-only item"),
        "tick.py",
        "        if not receipt.ok:",
        "        if False:",
    ),
    (
        ("RW7 the kind stops being DERIVED from the item's class, so an item "
         "whose class names no receipt kind is recorded on whatever evidence "
         "was offered instead of being refused"),
        "tick.py",
        "    if not kind:\n        raise ReceiptRefusedError(",
        "    if False:\n        raise ReceiptRefusedError(",
    ),
    (
        ("RW8 an item the ledger has never seen is no longer refused up front, "
         "so the failure surfaces as a KeyError deep inside record_receipt "
         "rather than as a refusal naming the number"),
        "tick.py",
        "    if item is None:",
        "    if False:",
    ),
    (
        ("RW9 a run-backed item offered NO evidence at all stops being refused, "
         "so `--record-receipt` with neither --from-pr nor --from-run reaches "
         "the run reader with an empty id"),
        "tick.py",
        "        if not from_run:",
        "        if False:",
    ),
    (
        ("RW10 the LOST-UPDATE guard collapses, so a stale writer silently "
         "discards a concurrent lane's verified close - the item reverts to "
         "`ready` with its receipt and history gone, and the next tick "
         "re-selects work that was already done. Reproduced before the guard "
         "existed; `save()` is atomic per FILE and never was per DOCUMENT"),
        "ledger.py",
        "            if current != self.loaded_digest:",
        "            if False:",
    ),
    (
        ("RW11 the BINDING CHECK's call site disappears. The function keeps its "
         "own test and keeps passing - which is the whole point: a reviewer "
         "showed the check was tested as a FUNCTION and never as a CONTROL, so "
         "deleting this line survived the suite until a test drove the record "
         "path with a non-referencing PR"),
        "tick.py",
        "        _pr_references_item(repo, from_pr, number)",
        "        pass",
    ),
    (
        ("RW12 only the FIRST required step is checked, so a roll that rolled "
         "but SKIPPED validation is accepted - `receipt_required_steps` means "
         "ALL of them, and on observed history the two roll steps are always "
         "both green or both absent, so nothing distinguished 2-of-2 from "
         "1-of-2 until a fixture separated them"),
        "tick.py",
        "    for required in required_steps:",
        "    for required in required_steps[:1]:",
    ),
    # THE CALL SITES of the lost-update guard. RW10 arms the COMPARISON inside
    # `Ledger.save`; these arm the three ways a caller can switch it off while
    # the comparison stays perfectly intact -- the same function-versus-control
    # shape a reviewer found in the binding check, one module over.
    (
        ("RW13 the CYCLE stops guarding its save, so a refresh silently writes "
         "over a concurrent lane's verified close. The comparison in "
         "Ledger.save is untouched and RW10 still dies; only the call site "
         "changes"),
        "tick.py",
        "        led.save(if_unchanged=not args.bootstrap)",
        "        led.save()",
    ),
    (
        ("RW14 the RECORD path stops guarding its save, the other half of RW13 "
         "and the one this PR introduced"),
        "tick.py",
        "            led.save(if_unchanged=True)",
        "            led.save()",
    ),
    (
        ("RW15 the cycle SWALLOWS a refused save and reports success, so a "
         "detected lost update is converted back into a silent one - worse "
         "than not detecting it, because the guard now launders the failure"),
        "tick.py",
        ('    except LedgerChangedError as exc:\n'
         '        print(f"CYCLE NOT SAVED: {exc}", file=sys.stderr)\n'
         "        return 1"),
        ('    except LedgerChangedError as exc:\n'
         '        print(f"CYCLE NOT SAVED: {exc}", file=sys.stderr)\n'
         "        return 0"),
    ),
    (
        ("RW16 `_on_disk_digest` returns a constant for a MISSING file, so two "
         "writers racing to create the ledger both see 'unchanged' and the "
         "loser is overwritten - the fresh-clone and deleted-scratch-file case"),
        "ledger.py",
        "        if not os.path.exists(self.path):\n            return None",
        "        if not os.path.exists(self.path):\n            return 'absent'",
    ),
    (
        ("RW17 the post-write digest goes back to RE-READING the file instead of "
         "hashing the bytes just written, re-opening the window between "
         "os.replace and that read: a writer landing there leaves this "
         "transaction holding SOMEONE ELSE'S digest and the next guarded save "
         "sails through. Killed by COUNTING the read-backs (1 at head, 2 "
         "mutated), because the two implementations differ only inside a "
         "microseconds-wide gap and no sequential test can see the difference"),
        "ledger.py",
        "        self.loaded_digest = hashlib.sha256(blob).hexdigest()",
        "        self.loaded_digest = self._on_disk_digest()",
    ),
    (
        ("RW18 the BOOTSTRAP exemption disappears, so `--bootstrap` over an "
         "existing ledger refuses to reseed - the one operation whose purpose "
         "is to replace what is there, and the recovery path for a wiped or "
         "wrong-repo ledger. Fails CLOSED, which is why it survived a suite "
         "that only ever asserted the guard fires"),
        "tick.py",
        "        led.save(if_unchanged=not args.bootstrap)",
        "        led.save(if_unchanged=True)",
    ),
    # -- #4585: gate 1's SECOND arm, the path-intersection relaxation ------
    #
    # AN EMPTY INTERSECTION IS THE ANSWER THAT LETS A MERGE THROUGH, so every
    # arm here is aimed at making the query return empty for a reason that is
    # not "the delta is inert". That is the shape the issue named as the trap
    # and the one a green run cannot distinguish from a correct answer.
    (
        ("BD1 the population is re-derived FROM THE SCOPES, so a caller that "
         "silently drops the one context it could not scope buys a clean "
         "intersection over the remainder. `required` is a separate argument "
         "precisely so the loop cannot be its own witness"),
        "gates.py",
        "    unscoped = sorted(set(required) - set(by_name))",
        "    required = [s.name for s in scopes]\n    unscoped = []",
    ),
    (
        ("BD2 a required context whose producing workflow declares NO push "
         "path filter is SKIPPED instead of refusing - it reads the whole "
         "tree, and skipping it is how five of this repo's seventeen required "
         "contexts would stop being consulted at all"),
        "gates.py",
        "        if scope.paths is None and scope.paths_ignore is None:",
        ("        if scope.paths is None and scope.paths_ignore is None:\n"
         "            continue\n"
         "        if False:"),
    ),
    (
        ("BD3 the intersection is hard-wired EMPTY - the blind query the "
         "positive control exists for. Every refusal that depends on a file "
         "actually matching disappears, and the printed reason is identical"),
        "gates.py",
        "            hits = [f for f in delta_files if filter_admits(scope, f)]",
        "            hits = []",
    ),
    (
        ("BD4 `paths-ignore` loses its negation, so the ignored paths become "
         "the ONLY ones that block - polarity inverted, which reads as a "
         "working filter on any delta that happens to miss both sets"),
        "gates.py",
        "        return not _every_pattern_matched(scope.paths_ignore, path)",
        "        return _every_pattern_matched(scope.paths_ignore, path)",
    ),
    (
        ("BD5 an UNREADABLE delta collapses into a measured EMPTY one, so a "
         "`git diff` that failed reads as 'nothing changed' - the "
         "unanswered-question-as-a-pass shape this package names most often"),
        "gates.py",
        "    if delta_files is None:",
        "    if not delta_files:",
    ),
    (
        ("BD6 an unresolved scope borrows the no-filter sentence, so a producer "
         "that could not be TRACED is reported as one that reads everything. "
         "Same verdict, wrong evidence - and the two have opposite remedies"),
        "gates.py",
        "        if scope.unreadable:\n            return False, (",
        "        if False:\n            return False, (",
    ),
    (
        ("BD7 the composed caller records the second arm UNCONDITIONALLY, so "
         "every stale base passes gate 1. The decision function is untouched "
         "and every gates.py test still passes - the caller-side blind spot "
         "this file was created for"),
        "merge_gate.py",
        "        ok = inert",
        "        ok = True",
    ),
    (
        ("BD8 the second arm is allowed to rescue a PR aimed at a branch that "
         "is NOT main. An intersection over main's delta says nothing about "
         "where that PR merges"),
        "merge_gate.py",
        '            and pr["baseRefName"] == "main"',
        "            and True",
    ),
    (
        ("BD9 the policy key is read with a `.get` default equal to the shipped "
         "value, so DELETING it from the authority is unobservable - measured "
         "twice already in this package"),
        "merge_gate.py",
        '            and policy["merge_gate"]["stale_base_may_pass_on_an_inert_delta"]',
        ('            and policy["merge_gate"].get('
         '"stale_base_may_pass_on_an_inert_delta", True)'),
    ),
    (
        ("BD10 the scope is read at ONE sha, so a workflow whose own path "
         "filter NARROWED inside the base delta is judged by the narrower one "
         "- and a narrower filter excuses more. Two clocks, the shape "
         "`_top_level_dirs_agree` exists for"),
        "merge_gate.py",
        "        if at_base != at_main:",
        "        if False:",
    ),
    (
        ("BD11 only the origin/main read is checked for failure, so a workflow "
         "unreadable at the BASE sha silently resolves to main's filter"),
        "merge_gate.py",
        "        if at_base is None or at_main is None:",
        "        if at_main is None:",
    ),
    (
        ("BD12 an untraceable check-suite falls back to SOME workflow's filter "
         "rather than refusing, so a context is scoped by a producer that is "
         "not its own - a wrong filter reads as an empty intersection"),
        "merge_gate.py",
        "        path = path_by_suite.get(suite) if suite is not None else None",
        ("        path = (path_by_suite.get(suite)\n"
         "                or next(iter(path_by_suite.values()), None))"),
    ),
    (
        ("BD13 the pattern loop SHORT-CIRCUITS again, so an unrepresentable "
         "pattern sitting AFTER a matching one is never evaluated - under "
         "`paths-ignore` that skips a `!` re-include and calls the delta inert"),
        "gates.py",
        "    return any([glob_matches(pattern, path) for pattern in patterns])  # noqa: C419",
        "    return any(glob_matches(pattern, path) for pattern in patterns)",
    ),
    (
        ("BD14 `--no-renames` comes off the delta query, so git's default "
         "rename detection emits ONLY THE DESTINATION path - a file moved OUT "
         "of a context's scope then reads as inert while the thing that "
         "context depends on has left main. Round-1 blocker, reproduced "
         "end-to-end with a plain delete as the control"),
        "merge_gate.py",
        ('    rc, out, err = sh(["git", "diff", "--name-only", "--no-renames",\n'
         "                       base_sha, origin_main_sha])"),
        ('    rc, out, err = sh(["git", "diff", "--name-only",\n'
         "                       base_sha, origin_main_sha])"),
    ),
    (
        ("BD18 `core.quotePath=false` stops being injected, so git's DEFAULT "
         "quoting returns a non-ASCII path C-quoted and octal-escaped. No "
         "literal path comparison recognises it: the base delta reads as "
         "inert, and `push_event_runs` reads as 'no push event', which "
         "EXCUSES. Round-5 blocker - round 4 fixed one call site and left the "
         "excusing sibling blind; round 6 moved this into `git_argv` so the "
         "two `timeout=` callers are covered too"),
        "gates.py",
        ('    if args and args[0] == "git":\n'
         '        return [args[0], "-c", "core.quotePath=false", *args[1:]]\n'
         "    return args"),
        ('    if False:\n'
         '        return [args[0], "-c", "core.quotePath=false", *args[1:]]\n'
         "    return args"),
    ),
    (
        ("BD15 an EMPTY `paths: []` stops being refused, so a workflow "
         "declaring one matches NOTHING and its context excuses every delta - "
         "the fourth ContextScope state, which sails past the no-filter branch "
         "because `paths is None` is False"),
        "gates.py",
        "        if scope.paths == ():",
        "        if False:",
    ),
    (
        ("BD15B the OTHER empty spelling stops being refused. It is a separate "
         "arm because round 2 shipped ONE branch for both and gave them one "
         "(inverted) sentence; a reviewer's own arm narrowed the shared branch "
         "to half and was killed, which is what this pins permanently"),
        "gates.py",
        "        if scope.paths_ignore == ():",
        "        if False:",
    ),
    (
        ("BD16 the GO-path message loses its own limit, so the string printed "
         "BESIDE AN ALLOWED MERGE reads as a claim about what the required "
         "contexts READ - the retracted claim re-entering the permanent record "
         "through the squash, which is the one place it does real damage"),
        "gates.py",
        ('        + ". NOT a claim that no required context READS those files: the "\n'
         '          "filters bound what the trunk RE-RUNS, and the superset precondition "\n'
         '          "is unestablished - see gates.base_delta_is_inert."'),
        "",
    ),
    (
        ("BD17 the gate-1 LABEL goes back to asserting what the contexts READ. "
         "It prints on every stale-base run and is the first thing an operator "
         "sees, and no message-body assertion covers it"),
        "merge_gate.py",
        ('    record("1 base == origin/main (or a delta no required workflow\'s push "\n'
         '           "filter admits)", ok, why)'),
        ('    record("1 base == origin/main (or a delta no required context reads)",\n'
         "           ok, why)"),
    ),
    (
        ("PR1 the Item.pr WRITER is removed, so a bound lane records nothing and "
         "the item is reaped as 'lane never returned' - the #4489 defect exactly, "
         "and the one that cost 46 strandings and duplicate work on #4495/#4619"),
        "tick.py",
        "    item.pr = pr\n",
        "",
    ),
    (
        ("PR2 the bind stops MOVING THE STATE, so the PR is recorded but the item "
         "stays schedulable and the next cycle hands it to a second lane. "
         "Recording without the transition repairs the gate's corroboration and "
         "leaves the pay-for-it-twice defect exactly as it was"),
        "tick.py",
        "        led.transition(number, IN_REVIEW, why=note)",
        "        pass",
    ),
    (
        ("PR3 the bind stops checking the PR NAMES the item, so Item.pr becomes an "
         "integer the caller typed - no stronger than the author's own claim, "
         "which is the weakness #4489 says this binding exists to remove"),
        "tick.py",
        "        _pr_references_item(repo, pr, number)",
        "        pass",
    ),
    (
        ("PR4 the lost-update refusal becomes a plain save, reintroducing the "
         "unlocked read-modify-write two reviewers blocked on the merge_gate "
         "attempt: the loser's transitions do not merge, they vanish"),
        "tick.py",
        "    led.save(if_unchanged=True)  # CAS - refuse a lost update, never overwrite\n",
        "    led.save()\n",
    ),
    # -- #4699: the way OUT of a terminal state ----------------------------
    #
    # APPENDED AT THE END rather than filed next to the DP arms, deliberately:
    # `mutate_gates.py` is edited by several lanes at once and an insertion in
    # the middle of the list conflicts with every one of them. Order carries no
    # meaning here -- `_run_arms` walks the list and each arm is independent.
    #
    # EVERY ANCHOR BELOW IS IN CODE THIS CHANGE ADDED, which is the other half of
    # the same discipline. The one arm that anchors on a pre-existing line (UP8,
    # the reaper) uses a line no other arm touches; and the obvious spelling for
    # UP4's anchor was NOT available, because `permitted, permit_note = ...` is
    # verbatim arm DP5's needle in `_dispose` -- adding a second copy silently
    # re-aims DP5 at whichever is higher in the file. Measured:
    # `test_every_arm_anchor_is_present_and_unique_in_the_current_source` went
    # red with `DP5 -> 2 matches in tick.py`, which is why `_reverse`'s locals
    # are named `reversal_permitted` / `reversal_note`.
    (
        ("UP1 the reversal's REASON check is removed. STRONGER than DP1-DP3: "
         "those three still end in a ledger refusal because `transition` has its "
         "own bar, so deleting them only moves WHEN. `transition(n, READY, why)` "
         "has NO `why` refusal at all, so this mutant lets a reasonless reversal "
         "SUCCEED - and the park's blocker was published verbatim, so the public "
         "record would carry a reversal with no stated grounds"),
        "tick.py",
        "    if not reason or not reason.strip():",
        "    if False:",
    ),
    (
        ("UP2 the STATE GUARD collapses, so `--unpark` reverses a DECLINED item "
         "(or a live in-flight one on a typo'd number) and records "
         "'reversed from parked' in the history of an item that was never "
         "parked - a false line in the only audit trail there is (R7)"),
        "tick.py",
        "    wrong_state = item.state != from_state",
        "    wrong_state = False",
    ),
    (
        ("UP3 the CLOSED-ISSUE refusal is removed. #4699 names this one by "
         "itself: a terminal item whose issue is closed has had something happen "
         "the harness did not record, and re-queueing it papers over that"),
        "tick.py",
        '    if seen.state != "OPEN":',
        "    if False:",
    ),
    (
        ("UP4 the AUTHORITY bar is removed, so returning an item to the "
         "SCHEDULABLE QUEUE happens with no entry in policy.json at all - the "
         "emergent-behaviour shape `action_is_permitted` fails closed to "
         "prevent, and the mirror of DP5 one verb later"),
        "tick.py",
        "    reversal_permitted, reversal_note = gates.action_is_permitted(action, policy)",
        '    reversal_permitted, reversal_note = True, "not asked"',
    ),
    (
        ("UP5 policy.json REVOKES `unpark-item` and the verb must stop working. "
         "The arm that proves the NEW grant has a BLAST RADIUS rather than being "
         "prose - the marker_any_of defect this file records finding in itself "
         "twice, asked of the reversal grant the way DP6 asks it of the park"),
        "policy.json",
        '    "unpark-item",\n',
        "",
    ),
    (
        ("UP6 the READ-BACK COMPARISON collapses, so a mojibaked correction is "
         "accepted and stands permanently on a public issue. `gh` has posted a "
         "UTF-8 body as cp1252 mojibake AT EXIT 0 in this repo, and a reversal's "
         "reason is published verbatim, so a correction whose text arrived "
         "corrupted is worse than none - it reads as authoritative"),
        "tick.py",
        '    if landed.replace("\\r\\n", "\\n") != body.replace("\\r\\n", "\\n"):',
        "    if False:",
    ),
    (
        ("UP7 the STALE BLOCKER survives the reversal, so the ledger reads "
         "`state=ready blocker='no in-VNet runner exists'` and a cold reader "
         "cannot tell that from a live blocker on a schedulable item. Worse, "
         "`transition`'s park bar is only that BOTH fields are truthy, so a "
         "later `--park` with no `--blocker` would be accepted on the stale one. "
         "The `L30` audit_reason defect, one field over"),
        "tick.py",
        "        item.blocker, item.owner = None, None\n",
        "",
    ),
    (
        ("UP8 the REAPER is widened past `in-flight` - the obvious "
         "generalisation - so `--reap` sweeps `parked`, `declined` AND "
         "`in-review` back to `ready`, silently undoing every disposition and "
         "every PR binding in one command that prints only a count. The new verb "
         "must be the ONLY route out of a terminal state; this is the arm that "
         "asks whether a SECOND one opened"),
        "tick.py",
        "        if item.state == IN_FLIGHT:",
        "        if item.state != READY:",
    ),
    (
        ("UP9 the history stops naming the PRIOR STATE, so the round trip is no "
         "longer auditable: `state.json` carries a `ready` item with no record "
         "that it was ever parked, and the public comment is then the only trace "
         "of a disposition the ledger made"),
        "tick.py",
        'f"reversed from {from_state} ({REVERSAL_FLAGS[from_state]}): {reason}",',
        'f"reversed: {reason}",',
    ),
    (
        ("UP10 the PARK COMMENT BODY goes back to naming no mechanism - "
         "'resolve the blocker and say so here', which was true when written and "
         "became false the moment `--unpark` shipped. This is the arm for a "
         "defect class the rest of the matrix cannot see: the mutant changes a "
         "string that is PUBLISHED VERBATIM on a public issue and republished on "
         "every park, so a stale sentence here is R7 on an unrevisable surface "
         "rather than a stale comment. Its sibling defect - the park body citing "
         "#2874 (a Gov bicep-drift ITEM) for a rule that is #4535 - is pinned by "
         "the same test, and the DECLINE branch of the same function already "
         "cited #4535, so the two adjacent branches disagreed.\n"
         "         THE WHOLE BLOCK, NOT ITS FIRST LINE, and that is a correction "
         "measured rather than reasoned. The first version of this arm replaced "
         "only `\"TO UNPARK IT: resolve the blocker, then run \"` -- and Python "
         "concatenates adjacent string literals, so the following six lines "
         "survived and the mutant body STILL contained `--unpark <n>`. It scored "
         "SURVIVED against a test that was working perfectly: a WEAK MUTATION, "
         "not a blind suite, and the two are indistinguishable from the verdict "
         "alone. Same lesson as arm M3 above, in a different syntax"),
        "tick.py",
        ('            "TO UNPARK IT: resolve the blocker, then run "\n'
         '            "`tick.py --unpark <n> --reason \'<why the blocker no longer holds>\'`. "\n'
         '            "That verb is the ONLY route out of `parked` - a refresh and "\n'
         '            "`--reap` both leave a parked item alone, deliberately - and it posts "\n'
         '            "its reason here, so this comment is corrected on the public record "\n'
         '            "rather than only in the ledger (#4699). THAT CLAIM IS ABOUT `parked` "\n'
         '            "AND NOT ABOUT TERMINAL STATES IN GENERAL: a DECLINE seen open is "\n'
         '            "demoted to `needs-audit` by the next refresh, which is a second way "\n'
         '            "out of a terminal state, and the decline\'s own comment says so. "\n'
         '            "Neither body generalises over the other. The harness will not "\n'
         '            "re-select this item until somebody runs it.\\n\\n"\n'),
        ('            "TO UNPARK IT: resolve the blocker and say so here. The park is "\n'
         '            "terminal, so the harness will not re-select this item on its own.\\n\\n"\n'),
    ),
    (
        ("UP11 the DECLINE COMMENT BODY goes back to the sentence the reviewers "
         "caught: a bare 'to reverse this decline, run --undecline' closed by "
         "'An explicit verb is the ONLY route out of a terminal state'. That "
         "claim is FALSE for the one state whose comment carried it -- "
         "`declined` is in `REOPEN_DISPUTES`, `needs-audit` is not in "
         "`TERMINAL`, and one `upsert` over an open issue moves it -- and the "
         "SAME body says so three lines up. It was introduced by the fix for "
         "three sentences of exactly this kind.\n"
         "         WHAT IT ACTUALLY REDS, CORRECTED, because this description "
         "used to say 'the test it reds checks the CLASS' and UP15's -- in "
         "this same file -- states UP11's kill set correctly and differently. "
         "Measured: UP11 does NOT touch the class test at all. Its replacement "
         "is the genuine pre-#4699 text, which carries no `only route out of` "
         "sentence in any form, so the class scan finds nothing to score and "
         "stays green; what reds is "
         "`..._names_the_undecline_window_and_both_refusals` and "
         "`..._names_the_verb_that_reverses_it[declined]`. UP15 is the arm "
         "that reinstates the false universal and reaches the class test from "
         "the decline side. An arm's description naming a kill set it does not "
         "have is the same defect class the arms themselves are about, one "
         "level up, and a reviewer found it by running UP11 rather than "
         "reading it.\n"
         "         WHAT IT STILL IS: UP10'S MIRROR, and its absence was a real "
         "gap -- UP10 mutates the park branch and reds `...[parked]` alone, so "
         "the `[declined]` parameter of the verb-naming test had no arm at all "
         "and its kill power was asserted rather than shown.\n"
         "         ONE MORE THING ITS REPLACEMENT DEMONSTRATES, and it is a "
         "limit on the class scan rather than on this arm: that pre-#4699 text "
         "carries a false universal in a DIFFERENT PHRASING -- 'a demoted "
         "decline has a legal way out and a park has none' -- which the "
         "`only route out of <X>` scan cannot see. A sibling test catches it. "
         "A clean class scan is evidence that ONE phrasing is absent, not that "
         "the class is.\n"
         "         THE NEEDLE IS THE WHOLE BLOCK AND THE REPLACEMENT IS THE "
         "REAL PRE-#4699 TEXT, both measured rather than reasoned about. The "
         "first version of this arm replaced only the block's FIRST THREE LINES "
         "-- and Python concatenates adjacent string literals, so the three "
         "cell bullets and the `--unpark` paragraph survived, the mutant body "
         "still named the window AND `--undecline <n>`, and the arm scored "
         "KILLED on the class test alone while saying NOTHING about the kill "
         "power of the two other tests it claims to cover. Killed for one of "
         "three reasons is a weak mutation wearing a green verdict, which is "
         "arm M3's lesson and UP10's, twice over in one file"),
        "tick.py",
        ('        "That asymmetry is why `declined` and `parked` are treated differently "\n'
         '        "by the REFRESH: a decline seen open is demoted and has a legal way out "\n'
         '        "of that demotion, and a park is never demoted in the first place. "\n'
         '        "NEITHER IS A DEAD END, and for a decline the route back depends on "\n'
         '        "which of the two cells above you are standing in - the verb is not the "\n'
         '        "answer in all of them:\\n"\n'
         '        "- THIS ISSUE STILL OPEN AND THE LEDGER STILL `declined`, which is the "\n'
         '        "window between this comment and the next refresh: run "\n'
         '        "`tick.py --undecline <n> --reason \'<who reversed it, on what grounds>\'`. "\n'
         '        "It posts its reason here, the way this comment did;\\n"\n'
         '        "- ALREADY DEMOTED to `needs-audit` by a refresh: there is nothing to "\n'
         '        "reverse. `needs-audit` is NOT a terminal state - the item is in the "\n'
         '        "audit queue already, which is the whole point of the demotion - and "\n'
         '        "the verb refuses it and says so;\\n"\n'
         '        "- THIS ISSUE CLOSED, the disposal named above: the decline stands on "\n'
         '        "the record and the verb REFUSES it. Re-open the issue first if the "\n'
         '        "judgement is genuinely withdrawn, then reverse it. That refusal is "\n'
         '        "not a ratchet and loosening it would not help: a reversal over a "\n'
         '        "closed issue returns the item to `ready`, and the very next refresh "\n'
         '        "finds it absent from the open set, flags it `departed` and demotes it "\n'
         '        "again - measured. It would buy one cycle, not a route.\\n\\n"\n'
         '        "A park\'s mirror is `--unpark` (#4699), and it has no such window: a "\n'
         '        "park is never demoted, and the harness never closes a park\'s issue, "\n'
         '        "so that verb stays available for as long as the issue stays open - "\n'
         '        "which is a park\'s expected condition. It is refused on a closed "\n'
         '        "issue too, for the same reason this one is.\\n\\n"\n'),
        ('        "That escape is the whole reason `declined` and `parked` are treated "\n'
         '        "differently: a demoted decline has a legal way out and a park has none.\\n\\n"\n'),
    ),
    (
        ("UP12 the unreadable-issue refusal goes back to `.format()` over an "
         "f-string chain. Adjacent literals concatenate BEFORE the method call, "
         "so `.format()` runs over the already-interpolated `{exc}` -- which "
         "carries `gh`'s stderr verbatim. Measured end to end through "
         "`unpark_item`: stderr `HTTP 502: {\"message\":\"Bad gateway\"}` raises "
         "`KeyError: '\"message\"'` and `HTTP 500: {}` raises `IndexError`, the "
         "`ReversalRefusedError` is NEVER CONSTRUCTED, and `main()`'s reversal "
         "branch catches only the four reversal exceptions so the builtin "
         "escapes as a traceback. The covering test could not witness it: the "
         "stub's failed-read stderr was hard-coded BRACE-FREE, which is the "
         "'what result could this instrument not have produced' shape exactly"),
        "tick.py",
        ('            "so it cannot proceed on an unread one either. Nothing was posted and "\n'
         '            f"nothing was written; the item is still {from_state}."\n'),
        ('            "so it cannot proceed on an unread one either. Nothing was posted and "\n'
         '            "nothing was written; the item is still {}.".format(from_state)\n'),
    ),
    (
        ("UP13 `_reverse` VOIDS the receipt on the way back to `ready`, the "
         "obvious symmetry with `upsert`'s reopen branch -- and the wrong one. "
         "A reopen disputes the very claim the receipt closed on; a reversal "
         "disputes the DISPOSITION and says nothing about evidence taken while "
         "the item was still in the queue. `record_receipt_from_evidence` "
         "refuses a terminal item, so any receipt a terminal item holds was "
         "taken validly before it got there, and voiding destroys a run id that "
         "can age out of retention. This arm exists because the choice was "
         "INHERITED rather than made: nothing pinned it in either direction"),
        "tick.py",
        "        item.blocker, item.owner = None, None\n",
        ("        item.blocker, item.owner = None, None\n"
         "        item.receipt_kind = None\n"
         "        item.receipt_ref = None\n"
         "        item.receipt_taken_under = None\n"),
    ),
    (
        ("UP14 `_reversal_comment`'s per-state correction collapses back into "
         "ONE shared paragraph -- the exact text that shipped, in both halves: "
         "*\"The `<state>` comment above this one says the harness will not "
         "re-select this item on its own.\"* Measured: NEITHER disposition body "
         "contains that sentence. The park's was rewritten to 'until somebody "
         "runs it' by this very PR and the decline's never said anything of the "
         "kind, so an `--undecline` attributed to the comment above it a "
         "sentence that is not there -- R7 on an unrevisable surface, inside "
         "the function whose whole job is correcting exactly that. It is the "
         "shared-template hazard `_disposition_comment`'s own docstring argues "
         "against, committed one function over.\n"
         "         IT MUTATES THE JOIN, NOT THE DISPATCH, and that is a "
         "correction. The first version prepended the shared paragraph and "
         "neutered the `if` -- which left the `else` branch free to reassign "
         "`corrects`, so BOTH states received the DECLINE text and only the "
         "`[parked]` parameter went red. An arm that reds one half of a "
         "parametrised pair it claims to cover is reporting on the half it "
         "reached. Assigning AFTER the branch overwrites whatever either arm "
         "computed, so both parameters now red"),
        "tick.py",
        ('    return (\n'
         '        f"{head}\\n\\n"\n'
         '        f"PRIOR STATE: {from_state}\\n"\n'),
        ('    corrects = (\n'
         '        f"WHAT THIS CORRECTS. The `{from_state}` comment above this one says "\n'
         '        "the harness will not re-select this item on its own."\n'
         '    )\n'
         '    return (\n'
         '        f"{head}\\n\\n"\n'
         '        f"PRIOR STATE: {from_state}\\n"\n'),
    ),
    (
        ("UP15 the DECLINE body's closing paragraph goes back to the sentence "
         "the round-1 reviewers caught VERBATIM: *\"An explicit verb is the "
         "only route out of a terminal state\"*. This is NOT a duplicate of "
         "UP11. UP11 reverts the whole block to the genuine PRE-#4699 text, "
         "which carries no such claim at all -- so it reds the window test and "
         "the verb-naming test and says nothing about the class test's DECLINE "
         "half. This arm reinstates the false universal on its own, which is "
         "the only mutation that exercises "
         "`test_no_published_surface_...` from the decline side. Two arms "
         "because the two defects are different: one body said nothing, the "
         "other said something false"),
        "tick.py",
        ('        "A park\'s mirror is `--unpark` (#4699), and it has no such window: a "\n'
         '        "park is never demoted, and the harness never closes a park\'s issue, "\n'
         '        "so that verb stays available for as long as the issue stays open - "\n'
         '        "which is a park\'s expected condition. It is refused on a closed "\n'
         '        "issue too, for the same reason this one is.\\n\\n"\n'),
        ('        "An explicit verb is the only route out of a terminal state, and it "\n'
         '        "posts its reason here.\\n\\n"\n'),
    ),
    (
        ("UP16 the `--unpark` HELP LINE goes back to 'the ONLY route out of a "
         "terminal state'. The help text is a PUBLISHED SURFACE too -- anyone "
         "who types `--help` reads it -- and the round-1 sweep of this claim "
         "swept the two posted bodies and missed it, because a surface is not "
         "a file, it is every SITE within it.\n"
         "         WHAT THIS ARM PROVES, NARROWED, because the claim it "
         "carried was the strongest sentence in the section and was false. It "
         "proves `_published_surfaces()` RENDERS THE `--unpark` HELP LINE. It "
         "does NOT prove that helper enumerates `build_parser()`: when it was "
         "written the helper iterated a literal `(\"unpark\", \"undecline\")` "
         "tuple -- 2 of 18 flags -- and this arm poisons a flag that tuple "
         "already names, so nothing in it varies the listing. A reviewer "
         "demonstrated the gap at runtime with nothing mutated: RED on "
         "`--unpark`, GREEN on `--park`, `--decline`, `--record-receipt` and "
         "`--reap`. UP19 is the arm that witnesses the enumeration; this one "
         "keeps its own narrower witness"),
        "tick.py",
        ('        help="reverse a PARK and return the item to ready (needs --reason). The "\n'
         '             "ONLY route out of `parked` -- a refresh and --reap both leave a "\n'),
        ('        help="reverse a PARK and return the item to ready (needs --reason). The "\n'
         '             "ONLY route out of a terminal state -- a refresh and --reap both leave a "\n'),
    ),
    (
        ("UP17 the RECEIPT PARAGRAPH of the reversal body goes back to the "
         "state-blind text that shipped at round 2, false clause and all: "
         "*\"NONE IS VOIDED ... that is deliberately UNLIKE a reopen, which "
         "voids the receipt because a reopen disputes the very claim that "
         "receipt closed on\"*. `CLOSES_ON_GITHUB` is `(closed,)`, so a "
         "DECLINE never shuts its issue -- for the state that sentence was "
         "published on, nothing ever closed and the clause presupposes an "
         "event that cannot have happened. THE THIRD INSTANCE of the "
         "published-universal-falsified-by-the-sibling-state class on this "
         "branch, committed inside the justification for the fix for the "
         "second, and invisible to the round-2 class scan because that scan "
         "reads `only route out of <X>` and this is a different phrasing.\n"
         "         IT MUTATES THE INTERPOLATION, NOT THE BRANCH, so the "
         "`if/else` above still computes `receipts` and the arm is not "
         "confusable with UP18: this one restores the FALSE CLOSE CLAIM, "
         "UP18 restores the STATE-BLINDNESS without it. Expected reds: "
         "`..._asserts_a_close_that_never_happened[declined]` (the clause) and "
         "`[parked]` (the strong claim goes missing), "
         "`..._a_receipt_survives_a_reversal_and_the_body_says_so`, and "
         "`..._two_routes_out_of_a_reopen_disputed_state_disagree...` on its "
         "published half"),
        "tick.py",
        '        f"was wrong. {receipts}Closing this item "\n',
        ('        "was wrong. NO RECEIPT IS RECORDED BY THIS, AND NONE IS VOIDED: a "\n'
         '        "reversal disputes the DISPOSITION, not evidence taken while the item "\n'
         '        "was still in the queue, so an item that held a valid receipt still "\n'
         '        "holds it and may already satisfy R2. That is deliberately UNLIKE a "\n'
         '        "reopen, which voids the receipt because a reopen disputes the very "\n'
         '        "claim that receipt closed on. Closing this item "\n'),
    ),
    (
        ("UP18 the receipt paragraph's PER-STATE BRANCH is neutered, so both "
         "states receive the PARK text -- which is TRUE of `parked` and FALSE "
         "of `declined`. No false close claim is reinstated; this arm isolates "
         "the STATE-BLINDNESS on its own, which is the defect underneath both "
         "of the two the round-2 fix already repaired: one body's true claim "
         "republished verbatim on its sibling.\n"
         "         WHY IT IS NOT A DUPLICATE OF UP17. UP17 restores a claim "
         "that is false everywhere (nothing was ever closed, for either "
         "state); this restores a claim that is TRUE for `parked` and false "
         "only for `declined`, which is the shape a reviewer cannot catch by "
         "reading one body. It reds `..._asserts_a_close_that_never_happened` "
         "on `[declined]` only, at `strong not in body`, and leaves `[parked]` "
         "GREEN -- an arm that reds both parameters would be reporting on "
         "something other than the sibling-state asymmetry.\n"
         "         THE BRANCH IS FALSIFIED RATHER THAN DELETED so the `else` "
         "body stays exactly as shipped and the mutation is one token wide: an "
         "arm that rewrites both branches is testing its own replacement text"),
        "tick.py",
        "    if from_state in REOPEN_DISPUTES:\n",
        "    if False:  # UP18: both states now get the PARK (strong) text\n",
    ),
    (
        ("UP19 the `--park` HELP LINE gains 'the only route out of a terminal "
         "state'. THIS IS THE ARM UP16 WAS SAID TO BE and is not. "
         "`_published_surfaces()` used to iterate a literal "
         "`(\"unpark\", \"undecline\")` tuple while the PR describing it "
         "claimed a sweep BY CLASS -- 2 of `build_parser()`'s 18 flags. A "
         "reviewer wrapped `build_parser` at runtime, mutated nothing on disk, "
         "and showed the scan RED on `--unpark` and GREEN with the identical "
         "false universal on `--park`, `--decline`, `--record-receipt` and "
         "`--reap`. A hand-maintained list cannot see its own gaps -- the "
         "exact argument this package makes for enumerating the parser in "
         "`test_every_value_flag_the_parser_knows_is_refused_without_its_verb`, "
         "applied there and not here UNTIL THIS ARM FORCED IT. The sibling's "
         "positive control on its own enumeration followed a round later, and "
         "is now at the comprehension in `_published_surfaces()`.\n"
         "         `--park` IS THE RIGHT TARGET because no list named it and "
         "no other test reads its help text, so a surviving mutant here means "
         "the enumeration is gone and nothing else would say so. Reds "
         "`test_no_published_surface_claims_a_verb_is_the_only_route_out_of_a_"
         "state_the_refresh_demotes` at the `in TERMINAL` clause, because "
         "`a` is not a state"),
        "tick.py",
        '        help="record this item as PARKED - genuinely blocked (needs --blocker AND "\n',
        ('        help="record this item as PARKED - the only route out of a terminal "\n'
         '             "state. Genuinely blocked (needs --blocker AND "\n'),
    ),
    (
        ("UP20 the README's `--unpark` paragraph swaps its correctly-scoped "
         "claim for the false universal. `README.md` carries the same claim "
         "class as the posted bodies -- the round-2 sweep fixed its text and "
         "left NO instrument reading it, so the next edit that reintroduced "
         "the sentence would ship green. It is now a surface "
         "`_published_surfaces()` renders, and this is what witnesses that: "
         "without it the README read is an unwitnessed claim and a helper that "
         "silently dropped the file would report the same clean result.\n"
         "         THE README JOINED `SOURCES` AND `COPIED` FOR THIS, and the "
         "second was mandatory rather than incidental: a test reading a file "
         "the sandbox does not carry raises `FileNotFoundError` on EVERY arm, "
         "which scores 200+ tautological kills -- the shape `COPIED`'s own "
         "note records for `required_contexts.json`. Caught before it shipped "
         "by reading that note.\n"
         "         NOT A `.py` FILE, deliberately. `policy.json` was already "
         "in SOURCES, so prose-and-data mutation is an established shape here "
         "and the digest handles bytes rather than syntax"),
        "README.md",
        "that verb is the only route out of `parked`, a claim about `parked` and *not*\n",
        "that verb is the only route out of a terminal state, a claim about `parked` and *not*\n",
    ),
    (
        ("UP21 the reversal stdout's `voided_elsewhere` clause is DELETED, so "
         "the `declined` and `parked` outputs become byte-identical. THIS ARM "
         "SURVIVED when it was first run by a reviewer -- 792 passed with the "
         "whole branch replaced by `\"\"`. It was the one branching published "
         "text in its round with neither an arm nor an assertion behind it: "
         "the only stdout assertion in the file pins `THIS VERB VOIDED NONE`, "
         "which is the SHARED prefix, so nothing could tell the two states "
         "apart.\n"
         "         THE DELETION IS THE RIGHT MUTATION rather than making the "
         "clause unconditional, because deletion is the shape that actually "
         "survived; the unconditional shape is covered by the OTHER half of "
         "the same test's pair, which asserts the clause is ABSENT from the "
         "`parked` output -- on that state the sentence would be false, since "
         "`parked` is not in REOPEN_DISPUTES and has no second route to have "
         "voided anything. Reds "
         "`test_the_reversal_stdout_names_the_other_route_only_where_there_"
         "is_one` on the `declined` assertion"),
        "tick.py",
        ('    voided_elsewhere = (\n'
         '        f" The next refresh over this open issue WOULD have voided it "\n'
         '        f"(`{from_state}` is in REOPEN_DISPUTES); this verb does not."\n'
         '        if from_state in REOPEN_DISPUTES\n'
         '        else ""\n'
         '    )\n'),
        '    voided_elsewhere = ""  # UP21: the per-state clause is gone\n',
    ),
    (
        ("UP22 the NAMED HOLD is deleted from `_reverse`, so a held item "
         "reverses. This is the arm for the whole interlock: with the call "
         "gone, `--unpark 2874` walks the three-verb happy path, the item "
         "reaches `ready` and becomes selectable -- and a green COMMERCIAL "
         "roll is then one `--record-receipt` away from being published as "
         "the verification of a GCC-HIGH item, which is the failure R2 "
         "exists to prevent. The mutation is a DELETION rather than a "
         "weakening because deletion is what an actor lifting a hold would "
         "actually do, and because the call site is one line: anything "
         "subtler would be testing the helper rather than its wiring.\n"
         "         WHAT IT COULD NOT HAVE PRODUCED: a green run. Both the "
         "`calls == []` assertion (the hold sits ABOVE the GitHub read) and "
         "the state assertion fail on the mutant, so a SURVIVED here would "
         "mean the tests never reach the hold at all. Reds "
         "`test_a_reversal_refuses_a_held_item_before_any_github_call` on "
         "both parameters and "
         "`test_the_hold_covers_undecline_too_so_an_item_cannot_walk_out_of_it`"),
        "tick.py",
        "    _refuse_if_held(number, from_state)\n",
        "    # UP22: the named hold is gone\n",
    ),
    (
        ("UP23 the hold's key NORMALISATION is replaced by a bare membership "
         "test, which is the permissive version a reviewer would write. It "
         "lifts a hold SILENTLY on three separate edits -- `{'#2874': ...}`, "
         "`{'2874 ': ...}` and a key that is not an issue number at all -- "
         "because a string key never equals an int `number`, so the lookup "
         "matches nothing and the function returns as though nothing were "
         "held. A hold an actor can switch off with a transcription slip is "
         "not a control, and the silence is the whole defect: the shipped "
         "code REFUSES on an unreadable key rather than skipping it, because "
         "an unreadable hold set is not an empty one (R7).\n"
         "         THE MUTANT STILL HOLDS THE INT KEYS, deliberately: a "
         "mutation that lifted every hold would also red the two arms above "
         "and could not distinguish 'the normalisation is gone' from 'the "
         "hold is gone'. Reds "
         "`test_the_hold_cannot_be_lifted_by_editing_one_field` on the three "
         "string-key parameters and leaves the two blank-reason ones green, "
         "which is the discriminating split"),
        "tick.py",
        ('    normalised: dict[int, object] = {}\n'
         '    for key, why in holds.items():\n'
         '        try:\n'
         '            normalised[int(str(key).strip().lstrip("#").strip())] = why\n'),
        ('    normalised: dict[int, object] = {}\n'
         '    for key, why in holds.items():\n'
         '        try:\n'
         '            normalised[key] = why  # UP23: no normalisation\n'),
    ),
    (
        ("UP24 `REVERSAL_HOLDS` is EMPTIED, which is the edit an actor lifting "
         "a hold without authority would make, and the arm that proves the "
         "test module's autouse `_holds_lifted` fixture is not an OFF SWITCH. "
         "That fixture patches the map empty for every test in the file -- it "
         "has to, because the happy-path fixture number IS #2958 -- so without "
         "an arm aimed at the SHIPPED constant, deleting both entries would "
         "leave the whole suite green. Note the second-order blindness this "
         "kills as well: `test_a_reversal_refuses_a_held_item_before_any_"
         "github_call` is parametrised over `sorted(SHIPPED_HOLDS)`, so an "
         "empty map does not RED it, it collects ZERO cases and the test "
         "silently stops existing. The set-equality assertion in "
         "`test_the_shipped_holds_still_name_both_items` is what turns that "
         "disappearance into a failure, which is why it asserts the SET and "
         "not a count.\n"
         "         WHEN #4709 LANDS this arm is deleted with the entries; it "
         "is not a permanent claim that a hold must exist. Reds "
         "`test_the_shipped_holds_still_name_both_items` and errors "
         "`test_the_hold_covers_undecline_too_so_an_item_cannot_walk_out_of_it`"),
        "tick.py",
        "REVERSAL_HOLDS = {\n",
        "REVERSAL_HOLDS = {}\n_UP24_LIFTED = {\n",
    ),
    # -- verdict SUPERSESSION (#4704, measured on PR #4693) ------------------
    # The discharge that had to exist, and the seven ways it fails OPEN. Every
    # needle below is in `gates.py`, which no other lane is editing this round;
    # the two that had to change in place are M5 and N6, whose anchored
    # condition grew a `discharged` clause -- see the notes at those arms.
    (
        ("SS1 the parsed supersession ids are DROPPED at the parse site, so the "
         "feature is inert and #4693's shape strands again - the exact state "
         "before #4704, which is the one a revert would land back in"),
        "gates.py",
        "                            supersedes=sup_ids, malformed_supersessions=sup_bad))",
        "                            supersedes=(), malformed_supersessions=sup_bad))",
    ),
    (
        ("SS2 the id MATCH is dropped: any supersession discharges EVERY live "
         "block, so a reviewer who addressed one finding silently clears a "
         "second reviewer's unrelated one"),
        "gates.py",
        ("    discharged = {\n"
         "        target\n"
         "        for v in live\n"
         "        if v.token not in BLOCKING_TOKENS\n"
         "        for target in v.supersedes\n"
         "    }\n"),
        ("    discharged = {\n"
         "        v.comment_id\n"
         "        for v in live\n"
         "        if v.token in BLOCKING_TOKENS\n"
         "        if any(w.supersedes for w in live)\n"
         "    }\n"),
    ),
    (
        ("SS3 the refusal is COMPUTED and then not consulted - the reporting-to-"
         "nobody shape N7 records one level up. A supersession naming a missing "
         "id, a near-miss, or nothing at all becomes a silent no-op"),
        "gates.py",
        "    if refusal:\n        return False, refusal\n",
        "    if False:\n        return False, refusal\n",
    ),
    (
        ("SS4 the SUPERSEDED verdict's token is not checked, so an APPROVE can "
         "be superseded - which both legitimises a meaningless discharge and "
         "lets a supersession delete the very approval the gate requires"),
        "gates.py",
        "            elif by_id[target].token not in BLOCKING_TOKENS:",
        "            elif False:",
    ),
    (
        ("SS5 supersession lines are read off RAW lines instead of prose, so a "
         "quoted / fenced / collapsed `SUPERSEDES` from a relayed previous "
         "round discharges a live block - formatting granting what it may only "
         "ever refuse"),
        "gates.py",
        "    for line, prose in classify_lines(body):",
        "    for line, prose in ((ln, True) for ln in body.splitlines()):",
    ),
    (
        ("SS6 the line remainder is MINED FOR DIGITS again rather than required "
         "to be ids only - `SUPERSEDES the round-3 finding` then discharges "
         "whichever verdict happens to be comment 3. Caught by this feature's "
         "own test on its first run"),
        "gates.py",
        ("        rest = bare[len(SUPERSESSION_MARKER):].replace(\",\", \" \").replace(\"#\", \" \")\n"
         "        parts = rest.split()\n"
         "        if parts and all(p.isascii() and p.isdigit() for p in parts):\n"
         "            ids.extend(int(p) for p in parts)\n"),
        ("        found = re.findall(r\"\\d+\", bare[len(SUPERSESSION_MARKER):])\n"
         "        if found:\n"
         "            ids.extend(int(n) for n in found)\n"),
    ),
    (
        ("SS7 the supersession is narrowed to the TOKEN WINDOW, so whether a "
         "discharge works becomes a function of how long the reviewer's header "
         "happened to be - a silent no-op with no diagnosis"),
        "gates.py",
        "        sup_ids, sup_bad = _supersessions(body)",
        "        sup_ids, sup_bad = _supersessions(head)",
    ),
    (
        ("SS8 a SUPERSEDES line on a comment that announces no verdict goes back "
         "to producing no near-miss at all, so an author who believes they "
         "cleared a block meets no contradiction anywhere in the output"),
        "gates.py",
        "            elif sup_ids or sup_bad:",
        "            elif False:",
    ),
    # -- round 2: the discharge is the FIRST place the prose flag GRANTS ------
    # Before #4704 `classify_lines` only ever fed two report-only callers, so a
    # missed idiom under-reported a near-miss. `_supersessions` turned the same
    # flag into a grant, and a reviewer measured six HTML idioms, a blockquote's
    # lazy continuation and a mid-line comment open all discharging a live block
    # they never addressed. Each arm below removes one of those closures.
    (
        ("SS9 the HTML rule goes back to the ENUMERATION it replaced - only "
         "`<details>` - so a SUPERSEDES inside <pre>, <blockquote>, <code>, "
         "<samp>, <kbd> or <q> discharges a live block while GitHub renders it "
         "quoted or literal. The measured round-2 blocker, restored"),
        "gates.py",
        ('_HTML_OPEN = re.compile(r"^<([A-Za-z][A-Za-z0-9-]*)(?=[\\s/>])")\n'
         '_HTML_CLOSE = re.compile(r"^</([A-Za-z][A-Za-z0-9-]*)\\s*>")\n'),
        ('_HTML_OPEN = re.compile(r"^<(details)(?=[\\s/>])")\n'
         '_HTML_CLOSE = re.compile(r"^</(details)\\s*>")\n'),
    ),
    (
        ("SS10 lazy blockquote continuation stops being tracked, so the line "
         "AFTER a `>` line - pure ASCII, the commonest relay shape of all - "
         "reads as prose and discharges, while GitHub renders it inside the "
         "blockquote"),
        "gates.py",
        "        lazy = quoted_para and indent < 4 and _continues_paragraph(bare)",
        "        lazy = False",
    ),
    (
        ("SS11 the `isascii` half of the id test is dropped, which fails BOTH "
         "ways: `SUPERSEDES <U+00B2>` raises ValueError out of parse_verdicts "
         "at two unguarded call sites, and `SUPERSEDES <U+0661>` is silently "
         "HONOURED as id 1"),
        "gates.py",
        "        if parts and all(p.isascii() and p.isdigit() for p in parts):",
        "        if parts and all(p.isdigit() for p in parts):",
    ),
    (
        ("SS12 lines are split with `str.splitlines()` again, which breaks on "
         "eight characters GitHub does not treat as line endings - so a "
         "separator MANUFACTURES an unquoted prose line out of the middle of a "
         "quoted or indented one"),
        "gates.py",
        '    return text.replace("\\r\\n", "\\n").replace("\\r", "\\n").split("\\n")',
        "    return text.splitlines()",
    ),
    (
        ("SS13 an HTML comment is only noticed when it opens at the START of a "
         "line, so `see below <!--` hides a SUPERSEDES that still discharges - "
         "a grant that is INVISIBLE in the rendered comment, which is worse "
         "than a cited one"),
        "gates.py",
        '        opens_comment = "<!--" in bare and "-->" not in bare.rsplit("<!--", 1)[1]',
        '        opens_comment = bare.startswith("<!--") and "-->" not in bare',
    ),
    (
        ("SS14 the VOID-element exemption is dropped, so a `<br>` or a badge "
         "`<img>` in an ordinary review body latches every line below it as "
         "non-prose and a legitimate discharge silently stops working"),
        "gates.py",
        "            if (name not in VOID_HTML\n",
        "            if (name not in frozenset()\n",
    ),
    (
        ("SS15 every line after a quoted one is swept into the blockquote, "
         "not just paragraph continuation - so a heading or a list item that "
         "genuinely INTERRUPTS the quote is misreported as cited"),
        "gates.py",
        "    if not bare or bare[:1] in \"#=\":\n        return False",
        "    if True:\n        return True",
    ),
    (
        ("SS16 a closing HTML tag stops popping the element stack, so the "
         "`</details>` that ends a collapsed previous round never ends it - "
         "every discharge written below ANY collapsed block silently stops "
         "working, which is the no-op this closure exists to avoid causing"),
        "gates.py",
        "            if name in html:\n                while html and html.pop() != name:\n",
        "            if False:\n                while html and html.pop() != name:\n",
    ),
    (
        ("SS17 the printed verdict tuple drops `supersedes` again, so the run "
         "says WHICH block was discharged and never BY WHICH COMMENT - and "
         "nothing else durable records it, since before-*.json holds only "
         "pr/head/open_issues and the squash body is untouched"),
        "merge_gate.py",
        "        f\" | live={[(v.token, v.comment_id, v.supersedes) for v in live]}\"",
        "        f\" | live={[(v.token, v.comment_id) for v in live]}\"",
    ),
    (
        ("SS18 a SELF-CLOSING tag opens a region. Load-bearing only for a "
         "NON-void tag such as `<div/>`: a `<br/>` fixture is caught by "
         "VOID_HTML as well and SURVIVED this arm on a green suite, which is "
         "the fixture-not-arm defect SS5 recorded one round earlier"),
        "gates.py",
        '                    and not bare.endswith("/>")):',
        "                    and True):",
    ),
]


def digest_tree(root: Path) -> str:
    """One digest over every tracked source this harness could possibly touch.

    ROUND 14: this had NO TEST, and `tracked tree untouched: True` -- a line
    quoted as evidence in every round of this issue -- had never been exhibited
    printing False. An independent reviewer showed `sorted(SOURCES)[:0]` or a
    constant return makes the claim vacuous over a real modification of
    `gates.py`, with the suite green.

    It REFUSES an empty population rather than digesting nothing, because a
    digest over zero files is a constant, and a constant compares equal to
    itself for any tree.
    """
    if not SOURCES:
        raise ValueError(
            "digest_tree over an EMPTY source list would be a constant, and a "
            "constant makes `tracked tree untouched` true for every tree"
        )
    sha = hashlib.sha256()
    seen = 0
    for name in sorted(SOURCES):
        sha.update(name.encode("utf-8"))
        sha.update((root / name).read_bytes())
        seen += 1
    if seen != len(SOURCES):  # pragma: no cover - defensive
        raise ValueError(f"digested {seen} of {len(SOURCES)} sources")
    return sha.hexdigest()


#: pytest's summary line, parsed by COUNT rather than searched by substring.
#:
#: ROUND 14, twice. First `_FAILURE_MARKERS` carried the bare string
#: `AssertionError` -- TRACEBACK vocabulary, which a COLLECTION ERROR also
#: prints -- so a run with rc=1, `1 error` and ZERO failed scored KILLED. Then
#: the first fix for that introduced `_ERROR_MARKERS` containing `" error"`,
#: which matched the SUITE'S OWN ASSERTION TEXT (`assert "no error" in why`) and
#: scored three real kills as ERROR. The same defect, inside its own repair.
#:
#: A substring of the whole stdout can never answer this: the suite's output
#: contains the vocabulary it is testing. pytest states its verdict in ONE line,
#: and that line is what gets read.
_SUMMARY_COUNT_RE = re.compile(
    r"(\d+)\s+(failed|passed|error|errors|skipped|deselected|xfailed|xpassed)\b"
)


def _summary_counts(stdout: str) -> dict[str, int]:
    """pytest's own tallies, off its LAST summary line. Empty when it did not say.

    The summary is the last line carrying at least one `<n> <word>` pair from
    pytest's vocabulary -- `-q` prints e.g. `1 failed, 427 passed in 12.34s`, and
    a collection failure prints `1 error in 0.40s`. Reading the last such line
    rather than the whole stream is what stops the suite's own assertion text
    from voting on its own result.
    """
    for line in reversed(stdout.strip().splitlines()):
        pairs = _SUMMARY_COUNT_RE.findall(line)
        if pairs:
            counts: dict[str, int] = {}
            for n, word in pairs:
                key = "error" if word == "errors" else word
                counts[key] = counts.get(key, 0) + int(n)
            return counts
    return {}


def _reports_a_failure(stdout: str) -> bool:
    """Did a TEST fail? Not: did anything anywhere print something alarming."""
    return _summary_counts(stdout).get("failed", 0) > 0


def _reports_an_error(stdout: str) -> bool:
    """Did the suite ERROR rather than fail? Then it did not decide this arm.

    A failure is the suite working; an error is the suite not running. Only the
    first is evidence about a mutation, and a mutant that breaks the instrument
    has not been caught by it.
    """
    counts = _summary_counts(stdout)
    return counts.get("error", 0) > 0 or "INTERNALERROR" in stdout


def _write_lf(path: Path, text: str) -> None:
    """Write with LF endings on every Python this project supports.

    ONLY `read_text`'s `newline` was the portability bug. Measured, not assumed:

        3.11.15   read_text : (self, encoding=None, errors=None)
                  write_text: (self, data, encoding=None, errors=None, newline=None)
        3.13.14   read_text : (self, encoding=None, errors=None, newline=None)

    `write_text(newline=...)` has been there since 3.10 and was never broken --
    a reviewer caught the first draft of this comment claiming otherwise, which
    is a wrong version number inside the comment that exists to record a version
    lesson. Bytes are used on both sides anyway: it is the version-independent
    way to say "these exact characters, no translation", and translation is the
    whole point, because every multi-line anchor below is written with LF while
    `core.autocrlf=true` checks these files out CRLF.
    """
    path.write_bytes(text.encode("utf-8"))


_PASSED_RE = re.compile(r"(\d+) passed")


def _passed_count(stdout: str) -> int:
    """How many tests pytest reported passing. -1 when it did not say.

    Used only to prove the `--deselect` took effect. -1 rather than 0 so a
    missing summary can never satisfy an equality check by accident.
    """
    match = _PASSED_RE.search(stdout)
    return int(match.group(1)) if match else -1


#: The tests that MAY skip inside the sandbox, by nodeid, because they reach
#: outside the copied tree. Both are keyed on `_repo_root()`, which the sandbox
#: deliberately cannot satisfy: one shells out to `node`, the other calls
#: `gh api`. Anything else skipping means a guard stopped guarding -- and a
#: guard that skips where the mutants live cannot kill an arm, so the arms it
#: covers would score KILLED on unrelated tests regardless of their mutation.
EXPECTED_SANDBOX_SKIPS = (
    "test_ci_green_declared.py::test_the_infra_ere_fixture_still_matches_the_deriver",
    "test_ci_green_declared.py::test_the_required_context_snapshot_is_current",
    "test_mutate_gates.py::test_the_population_counter_reads_the_summary_not_the_listing",
    # #4543. Reads `.github/workflows/build-fiab-images-acr-tasks.yml` to pin
    # the invariant gate 4c's scope sentence rests on (`push:` restricted to
    # `branches: [main]`, so the lane never attaches to a PR head). The sandbox
    # copies only `tools/drain`, so that file is absent and the test skips --
    # DECLARED here rather than left to make the skip audit fail, and it kills
    # no arm, which is exactly what this tuple exists to say out loud.
    "test_gates.py::test_the_acr_lane_invariant_the_scope_sentence_rests_on_still_holds",
    # #4585. Both read real workflow files to prove gate 1's path-intersection
    # arm is pointed at something real (and that the five unfiltered required
    # contexts policy.json discloses are still unfiltered). The sandbox copies
    # only `tools/drain`, so `_repo_root()` is None and they skip. DECLARED,
    # and said out loud: neither kills an arm. The arms for
    # `base_delta_is_inert` are killed by the synthetic-fixture tests beside
    # them, which need no checkout.
    "test_gates.py::test_positive_control_the_intersection_query_can_return_non_empty",
    "test_gates.py::test_positive_control_the_real_required_topology_is_measured_not_assumed",
    # #4676. Both read real git history -- the two commits of the vitest step
    # rename -- to keep the transcribed fixture constants honest against the
    # repo. The sandbox copies only `tools/drain`, so there is no repository to
    # read and they skip. DECLARED, and said out loud: NEITHER KILLS AN ARM.
    #
    # That is not a shrug, it is why
    # `test_the_producer_asks_git_for_the_sha_and_for_no_other_ref` exists. The first draft of #4676 had the producer
    # guarded ONLY by these two, so arm AS3 -- the producer reading `HEAD:`'s
    # blob for every sha -- would have SURVIVED the matrix while the real-git
    # test sat green in the repo. The argv-intercepting test needs no checkout
    # and is what actually kills AS3 here.
    "test_ci_green_as_of.py::test_the_producer_reads_the_declaration_at_the_sha_not_off_disk",
    "test_ci_green_as_of.py::test_the_rename_fixture_matches_what_policy_json_actually_carried",
)


#: The environment every pytest subprocess here runs under, with the ambient
#: `PYTEST_ADDOPTS` REMOVED.
#:
#: ROUND 13 BLOCKER, and the reason the round-12 "fix" for this did not fix it.
#: Round 12 made `_collected` read the SELECTED count out of
#: `354/413 tests collected (59 deselected)` and then asserted, in a comment,
#: that the inherited-`PYTEST_ADDOPTS` blind run was closed. An independent
#: reviewer measured it OPEN: the sandbox is a byte copy of this tree running
#: under the SAME environment, so any `-k` moves BOTH numbers together. Reading
#: the selected count changed the printed number and never the verdict --
#: `here_n=360 there_n=360 gate passes: True` while the suite really ran 360 of
#: 419.
#:
#: A comparison cannot detect a variable that perturbs both sides equally. The
#: only fix is to stop inheriting it, so the matrix runs the suite it names.
#: That is the THIRD false "this hole is closed" claim in this file's history,
#: and the note stays because the claim is the defect, not the hole.
def _clean_env() -> dict[str, str]:
    env = dict(os.environ)
    env.pop("PYTEST_ADDOPTS", None)
    env.pop("PYTEST_PLUGINS", None)
    return env


#: HOW EVERY PYTEST SUBPROCESS HERE IS DECODED, and it is not `text=True` alone.
#:
#: `text=True` decodes with the PLATFORM encoding -- cp1252 on the Windows hosts
#: this runs on -- so one non-ASCII byte anywhere in pytest's output raises
#: `UnicodeDecodeError` inside `subprocess`'s reader THREAD. The exception is
#: reported against `threading`, `proc.stdout` comes back as `None`, and the
#: matrix dies mid-arm with a traceback that names neither the arm nor the
#: cause. Measured 2026-09-24 on arm SS11, whose fixture values are non-ASCII
#: digits by construction -- the first test in this repo whose FAILURE output
#: could not be decoded.
#:
#: CI runs under a UTF-8 locale and would never have reproduced it, so the only
#: place this bites is the local run a reviewer does. No arm covers it: `main()`
#: is called by nothing, exactly as this module's own dispatch note records.
_DECODE = {"text": True, "encoding": "utf-8", "errors": "replace"}


def _collected(tests_dir: Path, cwd: Path) -> int | None:
    """How many tests pytest COLLECTS in a tree. None when it cannot say.

    The population check round 11 added. `--collect-only -q` prints one line per
    test and a trailing summary; the summary is parsed rather than the lines, so
    a change in pytest's line format cannot silently under-count.

    `-o addopts=` NEUTRALISES the repo's own pytest config, and that is
    load-bearing rather than tidiness: `pyproject.toml` puts `-q` in `addopts`,
    pytest SUMS verbosity flags, so a second `-q` here nets `-qq` and the summary
    line this parses is never printed. The sandbox has no `pyproject.toml`, so
    without the override the two trees are measured by different rules and the
    repo side silently returns None. An independent reviewer recorded that
    behaviour one round earlier as a false alarm to avoid chasing; it was the
    first thing this hit.
    """
    out = subprocess.run(
        [sys.executable, "-m", "pytest", str(tests_dir), "--collect-only", "-q",
         "-o", "addopts=", "-p", "no:cacheprovider"],
        capture_output=True, **_DECODE, cwd=cwd, env=_clean_env(),
    )
    if out.returncode != 0:
        return None
    m = re.search(r"(?:(\d+)/)?(\d+) tests? collected", out.stdout)
    if m is None:
        return None
    # THE SELECTED COUNT, NOT THE TOTAL. Round 12 BLOCKER: with anything
    # deselected, pytest prints `354/413 tests collected (59 deselected)` and
    # `(\d+) tests? collected` takes the 413. Under an inherited
    # `PYTEST_ADDOPTS='-k "not merge_gate"'` both trees then report 413, the
    # check passes, and the control plus every arm run 354 -- which is the
    # blind-run this check was added to close, and which a comment in `main()`
    # named as closed while it was not. The left-hand number is what will
    # actually execute.
    return int(m.group(1) or m.group(2))


def _skipped_nodeids(sandbox: Path, cmd: list[str]) -> tuple[set[str], int] | None:
    """Which tests SKIPPED in the sandbox and HOW MANY. None if unreadable.

    Returns BOTH the nodeids and pytest's own count, because neither alone is
    sufficient and round 10 proved it:

      - a COUNT alone cannot say WHICH two skipped, so a guard reverting to SKIP
        while another stopped skipping nets to zero. That is why round 9 replaced
        the count with names.
      - NAMES alone cannot see a skip pytest never attributes to a nodeid. An
        independent reviewer module-skipped `test_merge_gate.py`: 56 tests
        vanished, the control stayed rc=0, the deselect delta still held, and
        this returned EXACTLY the expected two -- so the runner printed
        `SKIPS 2 pinned`, a positive claim that was false. A module-level skip is
        reported in the summary and against no test id at all.

    So both are read and the caller checks both. pytest's `-v` line format is
    `<file>::<test> SKIPPED (reason)`; nodeids may contain SPACES when a test is
    parametrised over this receipt's own vocabulary (`Jest (portal)`), which the
    previous `(\\S+)` pattern dropped SILENTLY -- under-reporting, so the wrong
    set could still equal the expected one. Matched non-greedily up to the
    status word instead.

    `-q` IS STRIPPED, not merely overridden: pytest SUMS verbosity flags, so
    `[*cmd, "-v"]` against a cmd already carrying `-q` nets ZERO and prints no
    per-test lines at all. That returned an empty set on its first run and the
    control refused -- correctly, and it is why this reads the flag list rather
    than appending to it.
    """
    verbose = [a for a in cmd if a not in ("-q", "--quiet")] + ["-v", "--no-header"]
    out = subprocess.run(verbose, capture_output=True, **_DECODE, cwd=sandbox,
                         env=_clean_env())
    if out.returncode != 0:
        return None
    ids = set()
    for line in out.stdout.splitlines():
        m = re.match(r"(\S+\.py)::(.+?)\s+SKIPPED", line.rstrip())
        if m:
            ids.add(f"{Path(m.group(1)).name}::{m.group(2).strip()}")
    counted = re.search(r"(\d+) skipped", out.stdout)
    if counted is None:
        # No "N skipped" in the summary means pytest reported none. Zero is a
        # real answer here; an unreadable summary is not, and `-v` always prints
        # one, so the distinction is between "0" and "we could not run".
        return ids, 0
    return ids, int(counted.group(1))


#: ---------------------------------------------------------------------------
#: THE RUNNER'S THREE DECISIONS, EXTRACTED SO THEY CAN BE MEASURED.
#:
#: ROUND 15, from an independent reviewer who built the only instrument that can
#: see this file: a byte copy of `tools/drain` under `temp/`, one hand mutation
#: of THIS module per run, and the ordinary suite over it. Fifteen mutations of
#: the runner; **fourteen SURVIVED**. The one kill was `_clean_env`'s
#: `PYTEST_ADDOPTS` strip -- round 13's own fix, which has a test.
#:
#: That is the whole finding, and it is not about any single line: the runner's
#: HELPERS are instrumented (`_reports_a_failure`, `_collected`,
#: `_skipped_nodeids`, `digest_tree` all have tests) and the runner's DECISIONS
#: are not. `main()` is called by nothing but `__main__`, so every refusal, the
#: scoring conjunction and the exit rule were unreachable from any test. Arms
#: that SURVIVED included "any non-zero rc is a kill", "a survivor is counted as
#: a kill", "no arm is ever run", "the population gate is off" and "exit code
#: always zero" -- i.e. the sentences this package's receipts are quoted on.
#:
#: The fix is not more prose. It is to move each decision OUT of `main()` into a
#: pure function with no I/O, so a test can state the input and read the verdict.
#: `main()` keeps the printing and the subprocesses; these three keep the
#: judgement.


def _score(returncode: int, stdout: str) -> str:
    """One arm's outcome: 'killed', 'survived' or 'not-evaluated'.

    A KILL IS rc=1 **AND** A PYTEST FAILURE LINE **AND** NO ERROR LINE. Each
    conjunct is load-bearing and each was wrong at some point:

    - rc alone scored a `SyntaxError` collection crash (rc=2, suite never ran)
      as a kill, beside 106 real ones;
    - the failure line alone once keyed on the bare string `AssertionError`,
      which is TRACEBACK vocabulary that a collection ERROR prints too, so a
      run with rc=1, `1 error` and ZERO failed read as a kill;
    - dropping the error conjunct re-opens exactly that.

    `rc == 0` is a survivor regardless of what the output says: a suite that
    exited clean did not kill the arm, and no marker changes that.

    Everything else is NOT-EVALUATED, which is deliberately weaker than "the
    suite failed to run" -- rc=2 is a collection error where that is true, but
    rc=1 with `1 error` is a fixture raising at RUNTIME, where the suite did
    run. Asserting the stronger claim is the R7 error this package spends its
    budget on.
    """
    if returncode == 1 and _reports_a_failure(stdout) and not _reports_an_error(stdout):
        return "killed"
    if returncode == 0:
        return "survived"
    return "not-evaluated"


def _exit_code(
    *,
    killed: int,
    survived: int,
    skipped: int,
    errored: int,
    total: int,
    before: str,
    after: str,
) -> tuple[int, str]:
    """The run's exit status, and the sentence that justifies it.

    Ordered most-fundamental first, because each later question is meaningless
    if an earlier one fails. An EMPTY matrix is checked before the partition:
    `ARMS[:0]` produced `killed=0 survived=0 skipped=0 errored=0 of 0 arms` and
    exited 0 -- green over nothing, the `steps=0` shape this repo refuses
    everywhere else.

    `killed != total` is the LAST question and it is asked ONCE. An earlier
    draft asked `survived or skipped or errored` and then `killed != total`
    separately, on a reviewer's wording. Measured: the second was an EQUIVALENT
    MUTANT -- with the partition identity already checked above, `scored ==
    total` and zero survivors together imply `killed == total` arithmetically,
    so disabling it changed no output for any input and no test could kill it.
    An un-killable arm is evidence about the arm. The two are one check now:
    reachable, and killed by a mutation in either direction.

    ROUND 16: this takes the two DIGESTS, not a `tree_intact` bool. It used to
    take the bool, and `main()` computed it inline as `before == after` -- which
    put the comparison in the one function no test calls. A reviewer mutated
    that call site to `tree_intact=True` and NOTHING went red: the sandbox
    escape this whole check exists to catch became invisible, because the
    predicate lived outside the tested surface. Taking the operands instead of
    the verdict moves the comparison in here, where a test can reach it. The
    call site now has no decision left to mutate.
    """
    scored = killed + survived + skipped + errored
    if total == 0:
        return 1, ("the matrix is EMPTY, and an empty matrix cannot be evidence "
                   "about anything")
    if scored != total:
        return 1, (f"scored {scored} arms but the matrix declares {total}. A run "
                   "that did not evaluate every arm is not a run, whatever its "
                   "buckets say.")
    if before != after:
        return 1, ("the TRACKED TREE CHANGED during the run - an arm wrote outside "
                   "its sandbox, so no result from this run can be trusted")
    if killed != total:
        return 1, (f"not every arm died: killed={killed} of {total} "
                   f"(survived={survived} skipped={skipped} errored={errored})")
    return 0, f"all {total} arms KILLED, tracked tree untouched"


def _preamble_verdict(
    *,
    control_rc: int,
    skipped_ids: list[str] | tuple[str, ...] | None,
    skipped_count: int | None,
    here_n: int | None,
    there_n: int | None,
    with_meta_rc: int,
    selected_with: int,
    selected_without: int,
) -> tuple[bool, str]:
    """Do the four preamble gates admit this run? (ok, reason-if-not).

    Every one of these refusals was unreachable from a test: a reviewer turned
    each gate OFF in turn -- skip-names, skip-count, population, control-rc --
    and the suite stayed green on all four. The control-rc gate had no coverage
    of any kind, anywhere.

    `skipped_ids is None` means the skip set could not be READ, which is not the
    same as it being empty, and is refused separately for that reason.

    The with-meta gate carries its own diagnosis rather than folding into the
    deselect one: a BROKEN ANCHOR -- the ordinary event on a refactor -- makes
    the with-meta run RED, and the two were once a single message that named
    "the nodeid is wrong" about a nodeid that was correct.
    """
    if control_rc != 0:
        return False, "control is not green; nothing below would mean anything"
    if skipped_ids is None or skipped_count is None:
        return False, ("could not read the sandbox skip set, so a guard that "
                       "reverted to SKIP would be invisible")
    if sorted(skipped_ids) != sorted(EXPECTED_SANDBOX_SKIPS):
        return False, (f"sandbox skips are {sorted(skipped_ids)}, expected "
                       f"{sorted(EXPECTED_SANDBOX_SKIPS)}. A test that skips here "
                       "cannot kill anything, so every arm it guards would score "
                       "KILLED on the other tests regardless of the mutation.")
    if skipped_count != len(EXPECTED_SANDBOX_SKIPS):
        return False, (f"pytest reports {skipped_count} skipped but only "
                       f"{len(skipped_ids)} are attributable to a test id. The "
                       "difference is a module- or collection-level skip, which "
                       "removes tests from every arm without naming one.")
    if here_n is None or there_n is None:
        return False, ("could not collect one of the two trees, so the sandbox "
                       "population cannot be shown to match the repo's")
    if here_n != there_n:
        return False, (f"the sandbox collects {there_n} tests and this checkout "
                       f"collects {here_n}. Tests that VANISH do not skip, so "
                       "neither the skip names nor the skip count can see them, "
                       "and every arm would then be scored against a smaller suite.")
    if with_meta_rc != 0:
        return False, ("the unmutated suite is RED with the anchor meta-test "
                       "SELECTED. An arm's needle no longer matches the source; "
                       "the nodeid is not implicated.")
    if selected_with != selected_without + 1:
        return False, ("the deselect did not remove exactly one passing test, so "
                       "the nodeid is wrong")
    return True, ""


def _run_arms(
    arms: list[tuple[str, str, str, str]],
    originals: dict[str, str],
    run: Callable[[str, str], tuple[int, str]],
) -> tuple[int, int, int, int]:
    """Dispatch every arm and bucket the outcomes: (killed, survived, skipped, errored).

    ROUND 16, and this extraction is the whole point of the round. Round 15 put
    the three DECISIONS (`_score`, `_exit_code`, `_preamble_verdict`) into pure
    functions and the arm-kill rate went from 1-of-15 to 8-of-10. The nine that
    still survived were every one of them in the DISPATCH -- the loop that
    decides WHICH bucket a decision lands in, and whether the loop reaches the
    decision at all. A reviewer set the score to a constant `"killed"` at the
    call site and the runner printed `all 247 arms KILLED, tracked tree
    untouched` and exited 0 having measured nothing. `_exit_code` cannot see
    that: it is handed the counters, and the counters were consistent. A liar
    that keeps its books balanced is invisible to an auditor who only checks
    the books.

    The dispatch was unobservable because it lived in `main()`, which nothing
    but `__main__` calls -- so there is no input at which a test could watch it.
    The fix is not more assertions; it is giving the loop a seam. `run` does
    every side effect (write the mutant, run the suite, restore the file) and
    returns only `(returncode, stdout)`, so this function is pure over its
    arguments and a fake `run` can drive all four buckets from a test.

    What stays outside: the sandbox, the subprocess, the restore. What moves in:
    the anchor checks, the scoring call, and the counting -- i.e. everything an
    arm could corrupt while leaving the totals self-consistent.
    """
    killed = survived = skipped = errored = 0
    for name, filename, old, new in arms:
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
        returncode, stdout = run(filename, source.replace(old, new, 1))
        # A NON-ZERO rc IS NOT A KILL. It was scored as one, and R3's own
        # comment records the consequence: a mutation that was a
        # `SyntaxError` exited 2 at COLLECTION and printed KILLED beside 106
        # real kills. Nothing had been measured -- the suite never ran -- and
        # the repair was made to that arm rather than to the scorer, so the
        # next arm of that shape would have read the same way. Arms that
        # edit `policy.json` are the likeliest to reproduce it: a malformed
        # edit raises inside `load_policy` at import time.
        #
        # A kill is rc=1 AND a pytest failure line AND no ERROR line.
        #
        # ROUND 14: the last conjunct is new, and it was wrong before it was
        # missing. `_FAILURE_MARKERS` carried the bare string
        # `AssertionError`, which is TRACEBACK vocabulary rather than
        # SUMMARY vocabulary -- so a run with rc=1, `1 error` and ZERO
        # failed scored KILLED on the strength of a traceback from a suite
        # that never decided the arm. An independent reviewer measured it.
        # A mutant that breaks the instrument has not been caught by it.
        errored_out = _reports_an_error(stdout)
        outcome = _score(returncode, stdout)
        if outcome == "killed":
            print(f"  KILLED   {name:<72} rc={returncode}")
            killed += 1
        elif outcome == "survived":
            print(f"  SURVIVED {name:<72} rc=0  <-- BLIND SPOT")
            survived += 1
        else:
            # "NOT A KILL" is all this branch knows. It does NOT know the
            # suite failed to run: rc=2 is a collection error, where that is
            # true, but rc=1 with `1 error` and no `failed` is a fixture
            # raising at RUNTIME, where the suite did run. Asserting the
            # stronger claim would be the R7 error this package spends its
            # budget on.
            tail = (stdout.strip().splitlines() or [""])[-1]
            print(f"  ERROR    {name:<72} rc={returncode}  <-- NOT A KILL: "
                  f"exited non-zero with no pytest failure line: {tail[:60]}"
                  f"{' (an ERROR line was reported)' if errored_out else ''}")
            errored += 1
    return killed, survived, skipped, errored


def _exit_args(
    *,
    counts: tuple[int, int, int, int],
    arms: list[tuple[str, str, str, str]],
    before: str,
    after: str,
) -> dict:
    """The WIRING between the run's results and `_exit_code`, made testable.

    ROUND 19, on a reviewer's measurement and their remedy. Round 16 recorded
    `main()`'s wiring as a known gap and costed closing it at "a full control
    run plus a sandbox build per invocation". That was wrong: the gap is
    argument passing, and argument passing does not need a smoke test, it needs
    to not be inside `main()`.

    It also UNDERSTATED the gap. All four wiring mutations survive, and two are
    not innocuous:

        total=killed     makes BOTH partition refusals vacuously false
        survived=0       hides survivors from the "not every arm died" refusal

    Either one turns the matrix green over a run that found blind spots, which
    is the precise failure this package exists to refuse, reachable by editing
    one keyword in the one function no test calls.

    Taking the COUNTS AS A TUPLE and the ARMS themselves, rather than four
    integers and a length, is what removes the remaining freedom: there is no
    longer a place to pass `killed` where `total` belongs, because `total` is
    derived here from the same list the dispatch consumed. Zero runtime cost.
    """
    killed, survived, skipped, errored = counts
    return {
        "killed": killed,
        "survived": survived,
        "skipped": skipped,
        "errored": errored,
        "total": len(arms),
        "before": before,
        "after": after,
    }


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
        # THE WORKFLOWS THE POLICY ROWS NAME. Round 8: the drift guard that ties
        # `scope_paths` to the producing workflow SKIPPED here, because the
        # sandbox had no `.github/workflows` for it to read. A guard that skips
        # where the mutants live cannot kill anything, so an arm deleting a
        # declared output SURVIVED silently -- and under-declaration is exactly
        # the failure mode that has now shipped twice.
        #
        # Read the row rather than hard-coding two filenames: a new row naming a
        # third workflow must not lose its coverage by omission here, which is
        # the same "a number in prose nothing enforces" defect one level up.
        # NOT `scripts/ci`, deliberately -- `_repo_root()` keys on that too, and
        # supplying it would un-skip the tests that shell out to `node` and
        # `gh api` on all 213 arms.
        wf_dir = sandbox / ".github" / "workflows"
        wf_dir.mkdir(parents=True)
        rows = (json.loads((HERE / "policy.json").read_text(encoding="utf-8"))
                .get("receipts", {}).get("ci_green_rule", {})
                .get("scope_paths", {}))
        wanted = {
            row["workflow"] for name, row in rows.items()
            if not name.startswith("_") and isinstance(row, dict) and row.get("workflow")
        }
        if not wanted:
            print("no scope_paths row names a workflow - the drift guard would "
                  "skip in the sandbox and score every arm KILLED regardless of "
                  "the mutation", file=sys.stderr)
            return 1
        for rel in sorted(wanted):
            src = ROOT / rel
            if not src.is_file():
                print(f"policy.json names {rel}, which does not exist - refusing "
                      "to run a matrix whose drift guard cannot read it",
                      file=sys.stderr)
                return 1
            shutil.copy2(src, wf_dir / Path(rel).name)
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
        # BYTES, not `read_text(newline=...)`. THAT keyword is Python **3.13**
        # (`write_text`'s is 3.10 and was fine -- see `_write_lf`).
        # `pyproject.toml` declares >=3.10 and CI runs 3.10/3.11/3.12, so the
        # first version of this ran green on three 3.13 workstations -- mine and
        # both reviewers' -- and was RED on every CI Python. A local green says
        # nothing about the floor the project declares. Worse, this loop runs
        # BEFORE the arm loop, so on the floor the matrix aborted having scored
        # zero arms: the control that certifies the suite is not blind was
        # itself unobtainable there.
        originals = {}
        for name in SOURCES:
            text = (sandbox / name).read_bytes().decode("utf-8").replace("\r\n", "\n")
            _write_lf(sandbox / name, text)
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
        # `-o addopts=` FOR THE SAME REASON `_collected` CARRIES IT. Round 14:
        # this command lacked it, so an ancestor `pytest.ini` or `tox.ini` above
        # the sandbox would change what the control and EVERY ARM actually run
        # while all four preamble gates read identically -- measured at 365
        # instead of 424, caught only incidentally by the deselect check and
        # then mis-diagnosed. The env is stripped upstream; config above the
        # sandbox is the other half of the same hole.
        cmd = [sys.executable, "-m", "pytest", str(sandbox / "__tests__"), "-q",
               "-o", "addopts=",
               "-p", "no:cacheprovider", "--deselect", deselect]

        # CONTROL FIRST. If the unmutated suite is not green in the sandbox,
        # every red below is noise and the run proves nothing.
        control = subprocess.run(cmd, capture_output=True, **_DECODE, cwd=sandbox,
                                 env=_clean_env())
        tail = (control.stdout.strip().splitlines() or [""])[-1]
        print(f"CONTROL rc={control.returncode}  {tail[:70]}")
        # AND THE SKIP SET IS PINNED. Round 9, found by an independent reviewer:
        # the control asserted rc and the deselect delta and nothing else, so a
        # test that started SKIPPING was invisible -- it is not a failure, and it
        # subtracts equally from both `_passed_count` readings, so the delta
        # still held. That is round 8's OWN defect ("the one test tying rows to
        # workflows skipped by construction inside the sandbox") left with no
        # instrument watching it.
        #
        # TWO skips are expected here and they are named, not counted: the test
        # that shells out to `node` and the one that calls `gh api`, both keyed
        # on `_repo_root()` so they stay offline in the sandbox. A THIRD skip
        # means a guard has silently stopped guarding.
        skips = _skipped_nodeids(sandbox, cmd)
        skipped_ids, skipped_count = skips if skips is not None else (None, None)
        if skipped_ids is not None:
            print(f"SKIPS     {skipped_count} pinned: {', '.join(sorted(skipped_ids))}")
        else:
            print("SKIPS     UNREADABLE")
        # AND THE POPULATION ITSELF. Round 11 BLOCKER: round 10 pinned the SHAPE
        # of a disappearance (a skip) and not the POPULATION. An independent
        # reviewer deleted `__tests__/test_merge_gate.py` from the sandbox copy:
        # the population fell 402 -> 343 and ALL FOUR gates still passed --
        # control rc=0, the names EXACTLY `EXPECTED_SANDBOX_SKIPS`, the count
        # exactly 2, the deselect delta intact -- and `main()` returned 0. A
        # renamed file, `--ignore`, a `collect_ignore`, or an inherited
        # `PYTEST_ADDOPTS=--deselect` all restore round 10's own blocker.
        #
        # ROUND 12 said the `PYTEST_ADDOPTS` case was closed by reading the
        # SELECTED count instead of the total. ROUND 13: it was not, and that
        # was the SECOND false "closed" claim at this spot. Both trees are the
        # same copy under the same environment, so any `-k` moves BOTH numbers
        # together -- reading the selected count changes the printed number and
        # never the verdict. Measured by an independent reviewer at
        # `here_n=360 there_n=360 gate passes: True` while the suite really ran
        # 360 of 419.
        #
        # A comparison cannot detect a variable that perturbs both sides
        # equally. What closes it is `_clean_env()`, which strips the variable
        # from every pytest subprocess so the matrix runs the suite it names.
        # This check catches the tree DIFFERENCES; the env is handled upstream
        # of it, and neither claim covers the other.
        #
        # So the sandbox's collected test count is compared against the REPO's.
        # They must agree: the sandbox is a copy, and a copy that collects fewer
        # tests is not the suite this matrix claims to have run.
        here_n = _collected(HERE / "__tests__", HERE)
        there_n = _collected(sandbox / "__tests__", sandbox)
        # NEUTRAL WORDING. This used to print "matching this checkout" BEFORE the
        # comparison had been made, which is a claim rather than a reading.
        print(f"POPULATION here={here_n} there={there_n}")
        # ...and the DESELECT must have removed exactly one test. pytest accepts
        # a nodeid that matches nothing in silence, so a typo here would put the
        # meta-test back in the decision path and every arm would score KILLED
        # on it -- which is the defect this deselect exists to repair, restored
        # by a spelling. Compared against a run WITHOUT the deselect, because a
        # count parsed out of `-q` output is a number this file would be
        # trusting rather than measuring.
        with_meta = subprocess.run(
            [c for c in cmd if c not in ("--deselect", deselect)],
            capture_output=True, **_DECODE, cwd=sandbox, env=_clean_env(),
        )
        selected_with = _passed_count(with_meta.stdout)
        selected_without = _passed_count(control.stdout)
        print(f"DESELECT  {selected_with} -> {selected_without} tests "
              f"(the anchor meta-test must not decide an arm)")
        # ONE DECISION, IN ONE TESTABLE PLACE. Every refusal above used to be an
        # `if` in `main()`, and `main()` is called by nothing but `__main__` --
        # so a reviewer turned each of the four gates OFF in turn and the suite
        # stayed green on all four. The control-rc gate had no coverage of any
        # kind. The conditions now live in `_preamble_verdict`, which is pure and
        # tested per refusal; what stays here is the I/O and the extra dump.
        #
        # The gathering is no longer short-circuited, so a red control pays for
        # work whose result it will not use. ROUND 16 WROTE THAT COST AS "one
        # extra suite run" AND THAT WAS WRONG TOO -- it was the third estimate
        # in this comment's history, after an unmeasured "~6s" and a reviewer's
        # own first figure of "roughly three runs", which they then corrected by
        # measuring. The COMPOSITION is the durable claim, so it is stated
        # instead of a number:
        #
        #   control            full suite run   ALSO run by the old code - not extra
        #   _skipped_nodeids   full suite run   EXTRA  (`-q` stripped, `-v` added)
        #   _collected(HERE)   collect-only     EXTRA
        #   _collected(sandbox) collect-only    EXTRA
        #   with_meta          full suite run   EXTRA  (the deselect removed)
        #
        # So: TWO extra full executions of the suite plus TWO collect-only
        # passes. Measured once, on the authoring workstation at 51a0ce9d7a1 --
        # 19.24s + 4.07s + 4.06s + 19.56s = 46.93s, against a 20.32s control.
        # Scaling by that control against CI's measured 5.50s per arm puts the
        # extra near 13s on CI; the collect-only passes are import-bound rather
        # than test-bound, so treat 13s as an order of magnitude, not a
        # measurement.
        #
        # DO NOT RE-ESTIMATE THIS FROM THE STRUCTURE. Every previous figure here
        # was derived by reasoning about the code rather than by running it, and
        # all three were wrong. Either re-measure and pin the new number to a
        # named sha, or quote the composition alone -- which is what actually
        # decides whether the trade is worth it, and does not rot when the suite
        # grows (it went 434 -> 452 collected inside this PR).
        #
        # Against a ~22-minute matrix any of these figures is noise, and the
        # trade is the decision living in one tested place instead of four
        # untested ones. The refusal ORDER inside `_preamble_verdict` still
        # reports the control first, so the diagnosis a reader sees is unchanged
        # -- and that clause is EARNED: on a red control `_skipped_nodeids` and
        # `with_meta` are red too, so `skips` comes back None and the run prints
        # `SKIPS UNREADABLE`, which would be a misleading first line if the
        # ordering did not hold. A reviewer drove `_preamble_verdict` with
        # exactly that input and confirmed it still answers "control is not
        # green; nothing below would mean anything".
        ok, why = _preamble_verdict(
            control_rc=control.returncode,
            skipped_ids=skipped_ids,
            skipped_count=skipped_count,
            here_n=here_n,
            there_n=there_n,
            with_meta_rc=with_meta.returncode,
            selected_with=selected_with,
            selected_without=selected_without,
        )
        if not ok:
            print(f"REFUSING -- {why}")
            # The output carrying the real answer, for the two gates that have
            # one. Discarding it was itself an R7 defect in an earlier round.
            if control.returncode != 0:
                print(control.stdout[-3000:])
            elif with_meta.returncode != 0:
                print("The failure names the arm:")
                print(with_meta.stdout[-2000:])
            elif selected_with != selected_without + 1:
                print(f"the deselect nodeid is: {deselect}")
            return 2

        # THE ONLY SIDE EFFECTS IN THE ARM LOOP, isolated so the loop itself is
        # testable. Write the mutant, run the suite, put the file back --
        # unconditionally, so a raising subprocess cannot leave the sandbox
        # holding a mutated source that the NEXT arm would then measure against.
        def _run(filename: str, mutated: str) -> tuple[int, str]:
            _write_lf(sandbox / filename, mutated)
            try:
                proc = subprocess.run(cmd, capture_output=True,
                                      **_DECODE, cwd=sandbox, env=_clean_env())
            finally:
                _write_lf(sandbox / filename, originals[filename])
            return proc.returncode, proc.stdout

        killed, survived, skipped, errored = _run_arms(ARMS, originals, _run)
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)

    after = digest_tree(HERE)
    print()
    print(f"tracked tree untouched: {before == after}")
    print(f"killed={killed} survived={survived} skipped={skipped} errored={errored} "
          f"of {len(ARMS)} arms")
    # WHAT IS STILL UNOBSERVED HERE, restated because round 19 changed it and a
    # reviewer corrected my summary of what it changed.
    #
    # Round 16 recorded this whole block as a known gap. Round 19 extracted
    # `_exit_args`, which moved TWO of the four shapes into a tested function:
    # `total` mis-sourcing and `survived` zeroing both die there now.
    #
    # THE CALL-SITE EXPRESSIONS BELOW ARE UNCHANGED IN KILL POWER. All four
    # wiring mutations still survive AT THIS LINE, because nothing calls
    # `main()`. The accurate statement is narrower than "the wiring is now
    # testable": two shapes moved inward, the expressions here did not. Saying
    # "closed" would make the next reader stop looking, which is the whole
    # failure mode this file is about.
    #
    # Both remaining shapes fail closed in production for an independent
    # reason, so this is disclosure rather than an open defect.
    code, why = _exit_code(**_exit_args(
        counts=(killed, survived, skipped, errored),
        arms=ARMS, before=before, after=after,
    ))
    if code != 0:
        print(f"REFUSING -- {why}")
    return code


if __name__ == "__main__":
    # NO ARGUMENTS, AND SAYING SO IS CHEAPER THAN THE SURPRISE. An independent
    # reviewer typed `mutate_gates.py --list`, which is not a flag, and got a
    # FULL MATRIX -- 361 arms, 66 python processes -- because argv was ignored.
    # They had to kill it by PID (never by name pattern, which would have hit
    # other lanes on this box). A matrix takes hours and writes nothing until
    # the preamble finishes, so an accidental launch reads as a hang.
    if sys.argv[1:]:
        print(
            "mutate_gates.py takes NO arguments and always runs the FULL matrix "
            "({} arms, one full suite execution each -- hours, not minutes).\n"
            "You passed: {}\n"
            "There is no --list and no arm filter. To inspect the arms, import "
            "the module and read `ARMS`; to run a subset, set `mutate_gates.ARMS` "
            "to a filtered list before calling `main()`.".format(
                len(ARMS), " ".join(sys.argv[1:])),
            file=sys.stderr,
        )
        raise SystemExit(2)
    raise SystemExit(main())
