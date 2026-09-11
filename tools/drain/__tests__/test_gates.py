"""Unit tests for the drain gates, each with a NEGATIVE CONTROL.

A gate that has never been observed failing is not known to watch anything.
#4451 is the standing example: the roll's UAT gate printed "UAT-verified roll"
over `pass=4 fail=4`, measured four separate times, with no observed input for
which it returned anything else.

So every test here comes in pairs: one input the gate must accept, and one it
must REFUSE. A file of only-passing assertions would reproduce the bug it exists
to prevent.

Run:  python -m pytest tools/drain/__tests__/test_gates.py -q
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import gates

# ---------------------------------------------------------------------------
# Closing-keyword scan
# ---------------------------------------------------------------------------


def test_clean_text_is_safe():
    scan = gates.scan_closing_keywords("Refs #4361. See #4362 for the remaining work.")
    assert scan.safe
    assert scan.hard == []


def test_negative_control_plural_keyword_is_caught():
    """The spelling everyone types."""
    scan = gates.scan_closing_keywords("Closes #1470")
    assert not scan.safe
    assert scan.hard == [1470]


def test_negative_control_singular_keyword_is_caught():
    """`close #3933` -- SINGULAR. A `closes #|fixes #|resolves #` grep returns
    zero on this, and #3933 auto-closed on a merge cleared by that grep."""
    scan = gates.scan_closing_keywords("close #3933")
    assert not scan.safe
    assert scan.hard == [3933]


def test_negative_control_past_tense_with_colon_is_caught():
    """`fixed: #4361` -- the exact string that closed #4361 on 2026-09-11 while
    `closingIssuesReferences` read EMPTY."""
    scan = gates.scan_closing_keywords("fixed: #4361")
    assert not scan.safe
    assert scan.hard == [4361]


def test_negative_control_negation_is_still_caught():
    """The parser has NO notion of negation. A sentence whose whole purpose is
    to keep an issue open closes it."""
    scan = gates.scan_closing_keywords("Does not close #3549 - it remains open.")
    assert not scan.safe
    assert scan.hard == [3549]


def test_negative_control_backticks_do_not_protect():
    """True of a PR body's markdown; NOT true of a commit message, which is
    plain text. The gate must not be fooled either way."""
    scan = gates.scan_closing_keywords("the trailer still carries `Closes #4059`")
    assert not scan.safe


def test_near_miss_is_reported_but_not_fatal():
    """`fixed in #4396` -- a word intervenes, so GitHub does not act, but it is
    one edit from doing so. Reported, not refused."""
    scan = gates.scan_closing_keywords("recorded here rather than fixed in #4396")
    assert scan.safe
    assert scan.near == [4396]


def test_commit_trail_is_scanned_not_only_the_body():
    """The #4361 incident in one assertion: clean body, poisoned commit."""
    scan = gates.merge_is_close_safe(
        body="Refs #4361 - stays open pending its receipt.",
        commit_messages=["docs: re-grade the parity rows", "chore: fixed: #4361"],
    )
    assert not scan.safe
    assert 4361 in scan.hard


# ---------------------------------------------------------------------------
# Verdict parsing
# ---------------------------------------------------------------------------

HEAD = "2026-09-11T10:00:00Z"


def _c(cid, body, when):
    return {"id": cid, "body": body, "created_at": when}


def test_well_formed_approve_registers():
    live, near = gates.parse_verdicts(
        [_c(1, "## Independent review - APPROVE\n\nHead `abc`.", "2026-09-11T11:00:00Z")],
        HEAD,
    )
    assert [v.token for v in live] == ["APPROVE"]
    assert near == []


def test_negative_control_missing_marker_is_reported_not_silent():
    """A sound APPROVE headed "Re-review" was discarded for exactly this, and
    the gate said only "no live APPROVE" -- three runs to diagnose."""
    live, near = gates.parse_verdicts(
        [_c(2, "## Re-review - APPROVE\n\nHead `abc`.", "2026-09-11T11:00:00Z")], HEAD
    )
    assert live == []
    assert len(near) == 1
    assert "no marker" in near[0].reason


def test_negative_control_wrong_token_spelling_is_reported():
    """"CHANGES REQUIRED" is not the token. Two blocking verdicts were invisible
    to the gate for two full rounds because of this."""
    live, near = gates.parse_verdicts(
        [_c(3, "## Independent review - CHANGES REQUIRED\n\n...", "2026-09-11T11:00:00Z")],
        HEAD,
    )
    assert live == []
    assert "no token" in near[0].reason


def test_negative_control_verdict_predating_head_is_void():
    live, near = gates.parse_verdicts(
        [_c(4, "## Independent review - APPROVE", "2026-09-11T09:00:00Z")], HEAD
    )
    assert live == []
    assert "predates head" in near[0].reason


def test_token_outside_the_window_does_not_register():
    """Only the HEADER carries the verdict. Scanning the whole body would read
    an engaging "the previous REQUEST-CHANGES is addressed" as a fresh block."""
    body = "## Independent review\n\n" + ("x" * 400) + "\nAPPROVE"
    live, near = gates.parse_verdicts([_c(5, body, "2026-09-11T11:00:00Z")], HEAD)
    assert live == []
    assert near
    assert "no token" in near[0].reason


# ---------------------------------------------------------------------------
# Conjunction, not recency
# ---------------------------------------------------------------------------


def test_approve_alone_is_go():
    ok, why = gates.reduce_verdicts([gates.Verdict("APPROVE", "t2", 2)])
    assert ok, why


def test_negative_control_later_approve_does_not_discharge_earlier_block():
    """Reduce by CONJUNCTION. This is the whole rule."""
    ok, why = gates.reduce_verdicts(
        [gates.Verdict("REQUEST-CHANGES", "t1", 1), gates.Verdict("APPROVE", "t2", 2)]
    )
    assert not ok
    assert "REQUEST-CHANGES" in why


def test_negative_control_no_verdict_is_not_go():
    ok, why = gates.reduce_verdicts([])
    assert not ok
    assert "no live APPROVE" in why


# ---------------------------------------------------------------------------
# MISSING: never-created vs parked -- same symptom, opposite remedy
# ---------------------------------------------------------------------------


def test_parked_run_is_distinguishable():
    assert gates.classify_missing(total_count=3, waiting=True) == "parked"


def test_negative_control_conflicting_window_push_has_no_runs():
    """total_count == 0 means no run will EVER exist for that sha. Approving it
    is a no-op and `--admin`-ing past it ships code CI never saw."""
    assert gates.classify_missing(total_count=0, waiting=False) == "never-created"


def test_present_is_neither():
    assert gates.classify_missing(total_count=12, waiting=False) == "present"


# ---------------------------------------------------------------------------
# Autonomy contract -- must FAIL CLOSED
# ---------------------------------------------------------------------------

POLICY = gates.load_policy(
    os.path.join(os.path.dirname(__file__), "..", "policy.json")
)


def test_permitted_action_is_allowed():
    ok, _ = gates.action_is_permitted("merge-on-gate-go", POLICY)
    assert ok


def test_negative_control_stop_and_ask_is_refused():
    ok, why = gates.action_is_permitted("move_live_acr_tags", POLICY)
    assert not ok
    assert "STOP AND ASK" in why


def test_negative_control_never_is_refused():
    ok, why = gates.action_is_permitted("commit-a-secret", POLICY)
    assert not ok
    assert "NEVER" in why


def test_negative_control_unknown_action_fails_closed():
    """An action in neither list is REFUSED. Adding a capability must be a
    deliberate edit to policy.json, never an emergent behaviour."""
    ok, why = gates.action_is_permitted("rewrite-git-history", POLICY)
    assert not ok
    assert "fails closed" in why


def test_receipt_must_match_the_issue_class():
    assert gates.receipt_satisfies("ui-surface", "g1-browser", POLICY)


def test_negative_control_wrong_receipt_does_not_close():
    """`ci-green` does not close a UI surface. Per ux-baseline G1, tsc + vitest
    are not completion evidence -- only the browser catches a dead data path
    AND a frozen renderer."""
    assert not gates.receipt_satisfies("ui-surface", "ci-green", POLICY)
