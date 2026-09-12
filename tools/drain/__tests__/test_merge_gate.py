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

import json
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
        if key in ("body", "commits", "statusCheckRollup", "mergeable", "mergeStateStatus",
                   "closingIssuesReferences"):
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


def test_negative_control_the_api_field_never_narrows_the_scan():
    """`closingIssuesReferences` is reported beside the scan, never subtracted
    from it. Using the API field to filter the population re-introduces the
    exact silent close this gate exists for: it read EMPTY while a squash commit
    closed an issue. The UNION is the answer, never the intersection."""
    result = _run(body="Closes #4468", closingIssuesReferences=[])
    assert result["verdict"] == "NO-GO"
    assert result["will_close"] == [4468]


def test_the_api_field_adds_to_the_scan_when_the_text_is_clean():
    """And the other direction: a linked issue with no keyword in the text still
    counts. Neither oracle is complete, so both are consulted."""
    result = _run(body="no keywords here", closingIssuesReferences=[{"number": 4469}])
    assert result["verdict"] == "NO-GO"
    assert result["will_close"] == [4469]


def test_negative_control_an_unknown_mergeability_is_not_a_pass():
    """A deny-list on CONFLICTING passes GitHub's async UNKNOWN -- the state
    every PR sits in for a few seconds after a push, and precisely what precedes
    the hazard this gate names. "I do not know yet" is not a pass."""
    for value in ("UNKNOWN", "", None):
        result = _run(mergeable=value)
        assert result["verdict"] == "NO-GO", value
        assert not _gate(result, "0 ")["ok"]


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
# `--allow-close` is checked against the LEDGER, not taken on a lane's word
# ---------------------------------------------------------------------------


def _ledger_with(tmp_path, number, stream="W6-ci", lane="lane:ci", receipt=None):
    from ledger import Ledger

    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    led.upsert(number, "x", stream, lane=lane, size=1)
    if receipt:
        led.record_receipt(number, receipt, "evidence")
    led.save()
    return str(tmp_path / "state.json")


def test_a_declared_close_is_allowed_when_the_ledger_holds_the_receipt(tmp_path):
    path = _ledger_with(tmp_path, 4468, receipt="ci-green")
    ok, why = merge_gate.ledger_receipt_ready(4468, POLICY, path)
    assert ok, why


def test_negative_control_a_declared_close_with_no_ledger_fails_closed(tmp_path):
    """Declaring an auto-close does not GIVE the item a receipt. If you cannot
    show the receipt, you cannot declare the close -- otherwise the flag is just
    a way to switch gate 6 off. All three branches of this function shipped
    uncovered and three reviewer mutations survived the whole suite."""
    ok, why = merge_gate.ledger_receipt_ready(4468, POLICY, str(tmp_path / "nope.json"))
    assert not ok
    assert "no ledger" in why


def test_negative_control_a_declared_close_for_an_unknown_issue_is_refused(tmp_path):
    path = _ledger_with(tmp_path, 4468, receipt="ci-green")
    ok, why = merge_gate.ledger_receipt_ready(9999, POLICY, path)
    assert not ok
    assert "not in the ledger" in why


def test_negative_control_a_declared_close_with_no_receipt_is_refused(tmp_path):
    path = _ledger_with(tmp_path, 4468)
    ok, why = merge_gate.ledger_receipt_ready(4468, POLICY, path)
    assert not ok
    assert "without a receipt" in why


def test_negative_control_a_declared_close_with_the_wrong_receipt_kind_is_refused(tmp_path):
    """The KIND, not the presence -- the same rule the ledger enforces, reached
    through the same code path rather than re-implemented beside it."""
    path = _ledger_with(tmp_path, 4468, stream="W5-console", lane="lane:console",
                        receipt="ci-green")
    ok, why = merge_gate.ledger_receipt_ready(4468, POLICY, path)
    assert not ok
    assert "g1-browser" in why


def test_the_ledger_check_applies_to_every_stream(tmp_path):
    """Population contract, because a stream exemption is the narrow bypass that
    survived two rounds on the ledger's own refusal."""
    import build_inventory

    for i, stream in enumerate(build_inventory.ORDER):
        path = _ledger_with(tmp_path / f"s{i}", 4468, stream=stream)
        ok, _ = merge_gate.ledger_receipt_ready(4468, POLICY, path)
        assert not ok, f"{stream} must not be exempt"


# ---------------------------------------------------------------------------
# WIRING -- main(). A check main() does not call is a check that does not run.
# ---------------------------------------------------------------------------


def _main_over(monkeypatch, tmp_path, argv, data=None, after=None):
    """Drive `merge_gate.main()` with every network read stubbed."""
    monkeypatch.setattr(merge_gate, "HERE", str(tmp_path))
    monkeypatch.setattr(merge_gate, "REPO_ROOT", str(tmp_path))
    monkeypatch.setattr(merge_gate, "collect", lambda _repo, _n: data or _data())
    monkeypatch.setattr(merge_gate, "gh_json", lambda _args, _what: after or [1, 2])
    monkeypatch.setattr(sys, "argv", ["merge_gate.py", *argv])
    return merge_gate.main()


def test_negative_control_main_cross_checks_allow_close_against_the_ledger(
    monkeypatch, tmp_path
):
    """Unit-testing `ledger_receipt_ready` says nothing about whether anything
    CALLS it. That gap is the exact shape of the defect this whole harness
    exists to end, and it has now produced a regression in three consecutive
    rounds."""
    assert _main_over(monkeypatch, tmp_path, ["1", "--allow-close", "4468"]) == 2


def test_main_accepts_a_declared_close_the_ledger_backs(monkeypatch, tmp_path):
    """The control. Without it the refusal above could come from anywhere."""
    _ledger_with(tmp_path, 4468, receipt="ci-green")
    data = _data(body="Closes #4468")
    assert _main_over(monkeypatch, tmp_path, ["1", "--allow-close", "4468"], data) == 0


def test_negative_control_main_refuses_a_before_file_from_another_pr(monkeypatch, tmp_path):
    """Auditing #4483 against #4400's baseline prints AUDIT OK or AUDIT FAILED
    with equal confidence, and neither answer is about anything."""
    before = tmp_path / "before-4400.json"
    before.write_text(json.dumps({"pr": 4400, "open_issues": [1, 2, 3]}), encoding="utf-8")
    rc = _main_over(
        monkeypatch, tmp_path,
        ["--audit-close", "4483", "--before-file", str(before), "--intended", "3"],
    )
    assert rc == 2


def test_main_audits_against_its_own_before_file(monkeypatch, tmp_path):
    before = tmp_path / "before-4483.json"
    before.write_text(json.dumps({"pr": 4483, "open_issues": [1, 2, 3]}), encoding="utf-8")
    rc = _main_over(
        monkeypatch, tmp_path,
        ["--audit-close", "4483", "--before-file", str(before), "--intended", "3"],
        after=[1, 2],
    )
    assert rc == 0


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
