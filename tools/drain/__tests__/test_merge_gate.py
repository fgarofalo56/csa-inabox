"""Unit tests for the COMPOSED merge gate, each with a NEGATIVE CONTROL.

`gates.py` holds the decisions; `merge_gate.run_gates()` is what actually
decides a merge. Until this file existed only the first of those was tested --
so the fix for "the gates have no production caller" recreated the same defect
one level up. Three arms an independent reviewer wrote against the caller
survived the entire 106-test suite and a 26-arm mutation matrix:

    SURVIVED  gate 4 always records GO
    SURVIVED  the verdicts gate always records GO
    SURVIVED  NO-GO is computed over an empty finding set

The third is a one-token edit (`blocking = []`) that turns the program deciding
every merge into a rubber stamp. `run_gates()` is pure over a `data` dict, so
none of this needs the network; the reduction now lives inside it, where these
fixtures can reach it.

Run:  python -m pytest tools/drain/__tests__/ -q
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import merge_gate

import gates

POLICY = gates.load_policy(os.path.join(os.path.dirname(__file__), "..", "policy.json"))
HEAD = "a" * 40
HEAD_DATE = "2026-09-11T10:00:00Z"
REQUIRED = ["Python Lint", "vitest (node 20)", "guardrails"]
APPROVAL = {
    "id": 1,
    "body": "## Independent review - APPROVE\n\nlooks right.",
    "created_at": "2026-09-11T11:00:00Z",
}


def _data(**over) -> dict:
    """A PR that passes every gate. Each test breaks exactly one thing."""
    data = {
        "pr": {
            "number": 1,
            "title": "a change",
            "baseRefName": "main",
            "headRefOid": HEAD,
            "mergeable": "MERGEABLE",
            "mergeStateStatus": "BLOCKED",
            "body": "Refs #4468 - stays open pending its receipt.",
            "commits": [{"messageHeadline": "feat: a change", "messageBody": "Refs #4468"}],
            "statusCheckRollup": [
                {"name": n, "status": "COMPLETED", "conclusion": "SUCCESS"} for n in REQUIRED
            ],
            "closingIssuesReferences": [],
        },
        "head": HEAD,
        "head_date": HEAD_DATE,
        "comments": [APPROVAL],
        "base_sha": "b" * 40,
        "origin_main_sha": "b" * 40,
        "open_issues": [1, 2, 3],
        "head_runs": {"n": 12, "waiting": 0},
        "required": list(REQUIRED),
    }
    for key, value in over.items():
        if key in ("body", "commits", "statusCheckRollup", "mergeable", "mergeStateStatus"):
            data["pr"][key] = value
        else:
            data[key] = value
    return data


def _run(**over):
    return merge_gate.run_gates(_data(**over), POLICY, over.pop("allow_close", None))


def _gate(result, prefix):
    return next(f for f in result["findings"] if f["gate"].startswith(prefix))


# ---------------------------------------------------------------------------
# The control: a clean PR is GO. Without it every NO-GO below is vacuous.
# ---------------------------------------------------------------------------


def test_a_clean_pr_is_go():
    result = _run()
    assert result["verdict"] == "GO", result["findings"]
    assert result["blocking"] == []


# ---------------------------------------------------------------------------
# Each gate, observed FAILING
# ---------------------------------------------------------------------------


def test_negative_control_a_conflicting_pr_blocks():
    """A commit pushed while the PR reads CONFLICTING gets zero check-runs,
    permanently -- and clearing the conflict afterwards does not create them."""
    result = _run(mergeable="CONFLICTING")
    assert result["verdict"] == "NO-GO"
    assert not _gate(result, "0 ")["ok"]


def test_negative_control_a_stale_base_blocks():
    result = merge_gate.run_gates(_data(base_sha="c" * 40), POLICY)
    assert result["verdict"] == "NO-GO"
    assert not _gate(result, "1 ")["ok"]


def test_negative_control_no_review_blocks():
    result = _run(comments=[])
    assert result["verdict"] == "NO-GO"
    assert "no live APPROVE" in _gate(result, "2+3")["detail"]


def test_negative_control_a_live_block_is_not_discharged_by_a_later_approve():
    result = _run(comments=[
        {"id": 1, "body": "## Independent review - REQUEST-CHANGES\n\nno.",
         "created_at": "2026-09-11T11:00:00Z"},
        {"id": 2, "body": "## Independent re-review - APPROVE\n\nfixed.",
         "created_at": "2026-09-11T12:00:00Z"},
    ])
    assert result["verdict"] == "NO-GO"
    assert "REQUEST-CHANGES" in _gate(result, "2+3")["detail"]


def test_negative_control_a_red_required_context_blocks():
    rollup = [{"name": n, "status": "COMPLETED", "conclusion": "SUCCESS"} for n in REQUIRED]
    rollup[1]["conclusion"] = "FAILURE"
    result = _run(statusCheckRollup=rollup)
    assert result["verdict"] == "NO-GO"
    assert not _gate(result, "4 ")["ok"]


def test_negative_control_an_incomplete_required_context_blocks():
    rollup = [{"name": n, "status": "COMPLETED", "conclusion": "SUCCESS"} for n in REQUIRED]
    rollup[0] = {"name": "Python Lint", "status": "IN_PROGRESS", "conclusion": None}
    result = _run(statusCheckRollup=rollup)
    assert result["verdict"] == "NO-GO"
    assert "INCOMPLETE" in _gate(result, "4 ")["detail"]


def test_negative_control_a_missing_context_names_the_right_remedy():
    """never-created and parked look identical and have OPPOSITE remedies. The
    discriminator is check-runs ON THE COMMIT, not the rollup length and not
    `mergeStateStatus == BLOCKED`, which is true for nearly every blocked PR."""
    rollup = [{"name": "Python Lint", "status": "COMPLETED", "conclusion": "SUCCESS"}]
    never = _run(statusCheckRollup=rollup, head_runs={"n": 0, "waiting": 0})
    assert "never-created" in _gate(never, "4b")["detail"]
    parked = _run(statusCheckRollup=rollup, head_runs={"n": 9, "waiting": 2})
    assert "parked" in _gate(parked, "4b")["detail"]


def test_negative_control_a_skipped_required_context_blocks():
    rollup = [{"name": n, "status": "COMPLETED", "conclusion": "SUCCESS"} for n in REQUIRED]
    rollup[2]["conclusion"] = "SKIPPED"
    result = _run(statusCheckRollup=rollup)
    assert result["verdict"] == "NO-GO"
    assert not _gate(result, "5 ")["ok"]


def test_the_hollow_gate_states_what_it_cannot_see():
    """statusCheckRollup publishes no per-check population, so a green-over-zero
    check is invisible here. Saying so is the R7-honest answer; claiming the
    measurement would be the defect this gate was written to end."""
    detail = _gate(_run(), "5 ")["detail"]
    assert "no per-check population" in detail


def test_negative_control_an_undeclared_auto_close_blocks():
    """An auto-close bypasses the ledger: the item never gets the receipt its
    class requires. This gate recorded `True` unconditionally -- a gate that
    could not fail, inside the composed caller."""
    result = _run(body="Closes #4468")
    assert result["verdict"] == "NO-GO"
    assert not _gate(result, "6 ")["ok"]
    assert result["will_close"] == [4468]


def test_negative_control_the_commit_trail_blocks_too():
    """A squash publishes the whole trail, and `closingIssuesReferences` read
    EMPTY while a squash commit closed an issue."""
    result = _run(commits=[
        {"messageHeadline": "feat: a change", "messageBody": "fixed: #4361"},
        {"messageHeadline": "test: cover it", "messageBody": ""},
    ])
    assert result["verdict"] == "NO-GO"
    assert result["will_close"] == [4361]


def test_a_declared_auto_close_is_allowed():
    result = merge_gate.run_gates(_data(body="Closes #4468"), POLICY, allow_close=[4468])
    assert result["verdict"] == "GO", result["blocking"]


def test_negative_control_declaring_one_does_not_allow_another():
    result = merge_gate.run_gates(
        _data(body="Closes #4468 and closes #4469"), POLICY, allow_close=[4468]
    )
    assert result["verdict"] == "NO-GO"
    assert "4469" in _gate(result, "6 ")["detail"]


def test_the_verdict_is_the_conjunction_of_every_gate():
    """Not of the last one, and not of a hand-picked subset."""
    result = _run(mergeable="CONFLICTING", comments=[])
    assert result["verdict"] == "NO-GO"
    assert len(result["blocking"]) >= 2
    assert all(f in result["findings"] for f in result["blocking"])


def test_every_gate_of_the_spec_is_present():
    """A gate silently dropped from the composition is a gate that stopped
    watching -- and the finding list is the only place that would show it."""
    gate_names = [f["gate"] for f in _run()["findings"]]
    for prefix in ("0 ", "1 ", "2+3", "4 ", "5 ", "6 "):
        assert any(g.startswith(prefix) for g in gate_names), f"gate {prefix} missing"


# ---------------------------------------------------------------------------
# Gate 7 -- the post-merge audit, on SETS
# ---------------------------------------------------------------------------


def test_the_audit_passes_on_exactly_the_intended_set():
    ok, why = gates.issue_set_audit([1, 2, 3], [1, 2], [3])
    assert ok, why


def test_negative_control_a_set_swap_is_caught():
    """THE reason the count version is not enough: the intended issue closed,
    another closed silently, and a third opened concurrently. The delta is 1,
    the intended count is 1, and the count audit reports OK over a silent
    close. On this repo concurrent movement is the normal case."""
    ok_count, _ = gates.issue_count_audit(3, 2, [3])
    assert ok_count, "the count version passes the swap - that is the premise"
    ok, why = gates.issue_set_audit([1, 2, 3], [1, 4], [3])
    assert not ok
    assert "nobody chose" in why
    assert "2" in why


def test_negative_control_an_issue_that_did_not_close_is_a_finding():
    ok, why = gates.issue_set_audit([1, 2, 3], [1, 2, 3], [3])
    assert not ok
    assert "did not" in why


def test_a_concurrent_open_alone_is_not_a_finding():
    """release-please opens issues while a merge lands. That is not a false
    close, and a gate that cries about it gets ignored."""
    ok, why = gates.issue_set_audit([1, 2, 3], [1, 2, 9], [3])
    assert ok, why
    assert "concurrently" in why
