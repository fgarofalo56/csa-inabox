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
from types import SimpleNamespace

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
            # A DECLARED close, because that is the canonical drain PR: it
            # closes the issue it was scheduled for and says so. It also has to
            # be, for gate 3b -- a bare `Refs #N` is an ASIDE and no longer
            # resolves the stream, so a mention-only fixture is a
            # stream-unknown PR and escalates. The clean-PR control has to be a
            # PR that is genuinely clean.
            "body": "Closes #4468",
            "commits": [{"messageHeadline": "feat: a change",
                         "messageBody": "Closes #4468"}],
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
        "changed_files": ["domains/sales/models/x.sql"],
        "required": list(REQUIRED),
    }
    for key, value in over.items():
        if key in ("body", "commits", "statusCheckRollup", "mergeable", "mergeStateStatus",
                   "closingIssuesReferences"):
            data["pr"][key] = value
        else:
            data[key] = value
    return data


#: A ledger for gate 3b's STREAM lookup, written once per session.
#:
#: It MUST be injected. Without `state_path` these tests read the developer's
#: real `tools/drain/state.json` -- which is gitignored, so its contents differ
#: per machine and per hour, and the fixture body "Closes #4468" resolved to a
#: live W6-ci item and escalated. A hermetic test that silently consults live
#: state is the same defect class as a gate that reads a stale ledger.
_LEDGER: dict[str, str] = {}


def _ledger_path() -> str:
    if "path" not in _LEDGER:
        import tempfile

        from ledger import Ledger

        path = os.path.join(tempfile.mkdtemp(), "state.json")
        led = Ledger(path, receipts=POLICY["receipts"])
        # #4468 is the number every closing-scan fixture uses. W9-rest does NOT
        # escalate by stream, so the control PRs stay one-reviewer and the
        # escalation tests below have to name their own stream.
        led.upsert(4468, "a fixture item", "W9-rest", lane="lane:docs", size=1)
        led.save()
        _LEDGER["path"] = path
    return _LEDGER["path"]


def _run(**over):
    state_path = over.pop("state_path", None) or _ledger_path()
    # The default fixture DECLARES its close, so the default `allow_close`
    # declares it too -- otherwise every test would be measuring gate 6's
    # undeclared-close refusal instead of the thing it names.
    allow_close = over.pop("allow_close", None)
    if allow_close is None:
        allow_close = [4468]
    return merge_gate.run_gates(
        _data(**over), POLICY, allow_close, state_path=state_path
    )


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
    # `state_path` is NOT optional here. This was the one `run_gates` call in
    # the file that skipped it, so a tracked test's outcome depended on the
    # developer's untracked `state.json` -- pointed at a truncated one, it died
    # with `JSONDecodeError` instead of asserting anything about a stale base.
    result = merge_gate.run_gates(_data(base_sha="c" * 40), POLICY,
                                  state_path=_ledger_path())
    assert result["verdict"] == "NO-GO"
    assert not _gate(result, "1 ")["ok"]


# THE COMPOSED VERDICT IS NO LONGER A DISCRIMINATOR FOR GATE 2+3.
#
# Once a blocking verdict also RAISES the reviewer count, gate 3b blocks on the
# same fixtures gate 2+3 does -- so `verdict == "NO-GO"` stays true even with
# 2+3 forced to GO, and arm MG3 ("the verdict gate always records GO") went from
# KILLED to SURVIVED on a suite that had not changed. A coupling between two
# controls makes each one's test pass for the other's reason. The assertions
# below are on the GATE's own `ok`, which is what MG3 actually mutates.
def test_negative_control_no_review_blocks():
    result = _run(comments=[])
    assert result["verdict"] == "NO-GO"
    assert not _gate(result, "2+3")["ok"]
    assert "no live APPROVE" in _gate(result, "2+3")["detail"]


def test_negative_control_a_live_block_is_not_discharged_by_a_later_approve():
    result = _run(comments=[
        {"id": 1, "body": "## Independent review - REQUEST-CHANGES\n\nno.",
         "created_at": "2026-09-11T11:00:00Z"},
        {"id": 2, "body": "## Independent re-review - APPROVE\n\nfixed.",
         "created_at": "2026-09-11T12:00:00Z"},
    ])
    assert result["verdict"] == "NO-GO"
    assert not _gate(result, "2+3")["ok"]
    assert "REQUEST-CHANGES" in _gate(result, "2+3")["detail"]


def test_negative_control_a_guard_diff_needs_two_approvals():
    """The reviewer count ENFORCED, not described. Stated in a brief and
    enforced nowhere, it was the shape this module exists to end: a `tools/drain`
    PR that `review_requirement` says needs two reviewers merged GO on one
    APPROVE. And here the diff EXISTS, so the decision is made on the real
    changed files rather than on a lane-to-path guess."""
    one = _run(changed_files=["tools/drain/gates.py"])
    assert one["verdict"] == "NO-GO"
    assert not _gate(one, "3b")["ok"]
    assert "1 live APPROVE of 2 required" in _gate(one, "3b")["detail"]

    two = _run(changed_files=["tools/drain/gates.py"], comments=[
        APPROVAL,
        {"id": 2, "body": "## Independent re-review - APPROVE\n\nsecond pair of eyes.",
         "created_at": "2026-09-11T12:00:00Z"},
    ])
    assert two["verdict"] == "GO", two["blocking"]


def test_negative_control_an_empty_changed_file_list_fails_closed():
    """A failing `gh pr diff` raises in `collect`, but an EMPTY list would
    otherwise be indistinguishable from "an ordinary diff touching nothing that
    escalates" -- same boundary, other side."""
    result = _run(changed_files=[])
    assert result["verdict"] == "NO-GO"
    assert "not known" in _gate(result, "3b")["detail"]


def test_the_approval_gate_does_not_claim_to_measure_independence():
    """It counts APPROVE comments and cannot tell two reviewers from one
    reviewer posting twice: `collect` drops `user.login` before the parser sees
    it, and on this repo every agent verdict posts under one login anyway. A
    gate NAMED for a property it does not establish is an R7 error in its own
    label -- so it is named for what it measures, and says so."""
    result = _run()
    gate = _gate(result, "3b")
    assert gate["gate"] == "3b approval count"
    assert "independence is enforced by tool access, not measured here" in gate["detail"]


def test_an_ordinary_diff_merges_on_one_approval():
    """The control. Without it the rule above could simply be "always two", and
    at ~296 issues that dominates the run."""
    result = _run(changed_files=["domains/sales/models/x.sql"])
    assert result["verdict"] == "GO", result["blocking"]
    assert _gate(result, "3b")["ok"]


def test_negative_control_the_count_is_taken_from_the_real_changed_files():
    """Not from a lane guess. A console diff filed under any lane still needs
    two, because here `gh pr diff --name-only` has already answered the question
    the brief could only guess at."""
    for path in ("apps/fiab-console/app/page.tsx", "platform/fiab/bicep/main.bicep",
                 ".github/workflows/deploy-fiab-commercial.yml", "scripts/ci/check-x.mjs",
                 "dev-loop/gates/validate-all.ps1", "deploy/main.bicep"):
        result = _run(changed_files=[path])
        assert result["verdict"] == "NO-GO", f"{path} merged on one approval"
        # ...on 3b's own `ok`, not on the composed verdict. It discriminates
        # today -- 3b is the only failing gate on these fixtures -- but the
        # composed verdict is the form that let MG3 go from KILLED to SURVIVED
        # once two gates started blocking on the same input.
        assert not _gate(result, "3b")["ok"], path


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
    result = _run(body="Closes #4468", allow_close=[])
    assert result["verdict"] == "NO-GO"
    assert not _gate(result, "6 ")["ok"]
    assert result["will_close"] == [4468]


def test_negative_control_the_api_field_never_narrows_the_scan():
    """`closingIssuesReferences` is reported beside the scan, never subtracted
    from it. Using the API field to filter the population re-introduces the
    exact silent close this gate exists for: it read EMPTY while a squash commit
    closed an issue. The UNION is the answer, never the intersection."""
    result = _run(body="Closes #4468", closingIssuesReferences=[], allow_close=[])
    assert result["verdict"] == "NO-GO"
    assert result["will_close"] == [4468]


def test_the_api_field_adds_to_the_scan_when_the_text_is_clean():
    """And the other direction: a linked issue with no keyword in the text still
    counts. Neither oracle is complete, so both are consulted."""
    result = _run(body="no keywords here", commits=[], allow_close=[],
                  closingIssuesReferences=[{"number": 4469}])
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
    result = _run(body="a change", allow_close=[], commits=[
        {"messageHeadline": "feat: a change", "messageBody": "fixed: #4361"},
        {"messageHeadline": "test: cover it", "messageBody": ""},
    ])
    assert result["verdict"] == "NO-GO"
    assert result["will_close"] == [4361]


def test_a_declared_auto_close_is_allowed():
    result = _run(body="Closes #4468", allow_close=[4468])
    assert result["verdict"] == "GO", result["blocking"]


def test_negative_control_3b_escalates_on_a_blocking_first_verdict():
    """The block-push-reapprove rhythm, which is the ordinary shape of a review
    round here -- this PR went through it five times.

    A reviewer blocks; the author pushes; the block is correctly no longer LIVE,
    because a verdict is pinned to the head it measured. Nothing then raised the
    count, so one approval merged what a reviewer had just rejected. The
    HISTORY question and the CURRENT-STATE question are different questions,
    and `first_verdict_token` deliberately does not pin.

    Kills MG14 and MG12. (Not MG8, as an earlier draft claimed: under MG8 this
    fixture has api_says=[] and scan.hard=[], so will_close is [] either way and
    gate 6 stays green -- the test would have passed on 3b alone.)"""
    blocked_then_approved = [
        {"id": 1, "body": "## Independent review - REQUEST-CHANGES\n\nthe guard is open.",
         "created_at": "2026-09-11T09:00:00Z"},           # before the push
        {"id": 2, "body": "## Independent re-review - APPROVE\n\nfixed.",
         "created_at": "2026-09-11T11:00:00Z"},           # after it
    ]
    result = _run(comments=blocked_then_approved)
    gate = _gate(result, "3b")
    assert not gate["ok"], gate["detail"]
    assert "REQUEST-CHANGES" in gate["detail"]
    # ...and the 2+3 gate still reads the block as NOT live, which is correct
    # and is exactly why 3b has to ask the other question.
    assert _gate(result, "2+3")["ok"]


def test_negative_control_3b_fails_closed_when_the_stream_cannot_be_resolved(tmp_path):
    """Three ways it fails, one meaning: the harness cannot place the work.

    Every sibling control in this package fails closed. This one is the merge
    gate's half of `escalate_when_footprint_unknown` -- at brief time the stream
    is the fact and the paths are the guess; here it is the other way round.

    Kills MGE and MG10. (Not MG9, as an earlier draft claimed: this fixture
    leaves mergeable=MERGEABLE, so gate 0 passes under MG9 too.)"""
    empty = str(tmp_path / "nothing.json")
    no_ref = _run(body="a change with no issue reference", commits=[])
    assert not _gate(no_ref, "3b")["ok"]
    assert "no issue" in _gate(no_ref, "3b")["detail"]

    no_ledger = _run(state_path=empty)
    assert not _gate(no_ledger, "3b")["ok"]
    assert "no ledger" in _gate(no_ledger, "3b")["detail"]

    unknown = _ledger_with(tmp_path, 999, stream="W9-rest", lane="lane:docs")
    assert not _gate(_run(state_path=unknown), "3b")["ok"]


def test_negative_control_a_bare_refs_resolves_the_stream(tmp_path):
    """`Refs #N` carries no closing verb, so the closing scan sees it in
    NEITHER `hard` nor `near` -- and `Refs #N` is how nearly every PR in this
    repo names the item it is work on, this one included. Reusing the closing
    scan for the stream lookup would have read "references no issue" on most
    PRs and escalated all of them for the wrong reason. A control that fires on
    everything teaches the reader to skim it."""
    w1 = _ledger_with(tmp_path, 4468, stream="W1-deploy", lane="lane:docs")
    result = _run(body="Refs #4468 - stays open pending its receipt.",
                  commits=[], allow_close=[], state_path=w1)
    gate = _gate(result, "3b")
    assert not gate["ok"]
    assert "W1-deploy" in gate["detail"]
    assert result["will_close"] == [], "a bare Refs must NOT read as a close"


def test_negative_control_a_corrupt_ledger_fails_closed_instead_of_raising(tmp_path):
    """Gate 3b put new filesystem I/O on the merge path, over an UNTRACKED,
    per-machine scratch file. A reviewer measured both ways it ended the
    program: a corrupt `state.json` raised `JSONDecodeError` and a schema
    mismatch raised `SystemExit`, neither caught. deploy-integrity R6 -- "a
    failure whose only output is a stack trace" -- in the program that decides
    every merge. Kills MG20."""
    corrupt = tmp_path / "corrupt.json"
    corrupt.write_text("{not json", encoding="utf-8")
    result = _run(state_path=str(corrupt))
    assert result["verdict"] == "NO-GO"
    detail = _gate(result, "3b")["detail"]
    assert "unreadable" in detail
    assert "JSONDecodeError" in detail

    wrong_schema = tmp_path / "schema.json"
    wrong_schema.write_text(json.dumps({"schema": 99, "items": {}}), encoding="utf-8")
    result = _run(state_path=str(wrong_schema))
    assert result["verdict"] == "NO-GO"
    assert "refused to load" in _gate(result, "3b")["detail"]


def test_a_worktree_falls_back_to_the_primary_checkouts_ledger(monkeypatch, tmp_path):
    """`state.json` is gitignored, so it exists in the primary checkout and in
    NO worktree -- measured 371 worktrees on this machine, 1 with a ledger. A
    lane runs the gate from its own worktree, which is what the brief instructs
    and what file-partitioned parallelism requires. Resolving only against
    `HERE` meant the stream never resolved, and since that fails closed, EVERY
    PR asked for two reviewers -- reinstating wholesale the "a control that
    fires on everything teaches the reader to skim it" defect that
    `referenced_issues` exists to avoid. Kills MG21."""
    primary = tmp_path / "primary"
    (primary / "tools" / "drain").mkdir(parents=True)
    (primary / ".git").mkdir()
    worktree_drain = tmp_path / "wt" / "tools" / "drain"
    worktree_drain.mkdir(parents=True)

    monkeypatch.setattr(merge_gate, "HERE", str(worktree_drain))
    monkeypatch.setattr(merge_gate, "REPO_ROOT", str(tmp_path / "wt"))
    def fake_git(*_a, **_k):
        return SimpleNamespace(returncode=0, stdout=str(primary / ".git") + "\n",
                               stderr="")

    monkeypatch.setattr(merge_gate.subprocess, "run", fake_git)
    found = merge_gate.ledger_candidates()
    assert len(found) == 2, found
    assert os.path.abspath(found[1]) == os.path.abspath(
        str(primary / "tools" / "drain" / "state.json")
    )
    # An explicit path short-circuits it -- otherwise every test would depend on
    # whatever git says about the machine it runs on.
    assert merge_gate.ledger_candidates("/x/state.json") == ["/x/state.json"]


def test_the_strongest_stream_wins_when_a_pr_references_several(tmp_path):
    """Conjunction, the same reduction `reduce_verdicts` uses. A PR touching a
    W9-rest item and a W1-deploy item is a W1-deploy change; taking the first
    one found would make the answer depend on issue-number order."""
    from ledger import Ledger

    path = str(tmp_path / "state.json")
    led = Ledger(path, receipts=POLICY["receipts"])
    led.upsert(4468, "x", "W9-rest", lane="lane:docs", size=1)
    led.upsert(4487, "x", "W1-deploy", lane="lane:docs", size=1)
    led.save()
    stream, why = merge_gate.ledger_stream([], [4468, 4487], POLICY, path)
    assert stream == "W1-deploy", why


def test_negative_control_a_stale_mention_cannot_buy_a_weaker_gate(tmp_path):
    """THE INVERSION, found independently by both reviewers, in the feature the
    same round had just added. Measured at ba62873:

        body "Related to #10 in passing."  (#10 is W9-rest)  -> 1 reviewer
        the SAME diff with NO reference at all               -> 2 reviewers

    Referencing an issue bought a WEAKER gate than referencing nothing, which
    inverts the fail-closed design. Not a malice case: an agent-written PR body
    copy-pasting a stale number is ordinary, and `KICKOFF.md` reuses `#4468` as
    an example number throughout its own text.

    `Closes #N` is an ASSERTION about what this PR is -- and gate 6 refuses it
    unless it is also declared with `--allow-close`, so it is corroborated.
    `Refs #N` is an ASIDE: good enough to raise the requirement, not good enough
    to lower it. Kills MG22, MG23."""
    from ledger import Ledger

    path = str(tmp_path / "state.json")
    led = Ledger(path, receipts=POLICY["receipts"])
    led.upsert(10, "an unrelated triage item", "W9-rest", lane="lane:docs", size=1)
    led.save()

    mention_only = _run(body="Related to #10 in passing.", commits=[],
                        state_path=path)
    gate = _gate(mention_only, "3b")
    assert not gate["ok"], gate["detail"]
    assert "only MENTIONED" in gate["detail"]

    # The floor: no reference at all is ALSO unknown. The two must not disagree,
    # because the whole defect was that one was weaker than the other.
    no_ref = _run(body="a change with no issue reference", commits=[],
                  state_path=path)
    assert not _gate(no_ref, "3b")["ok"]

    # A DECLARED close does resolve it -- otherwise every PR escalates and the
    # control fires on everything.
    declared = _run(body="Closes #10", commits=[], allow_close=[10], state_path=path)
    assert _gate(declared, "3b")["ok"], _gate(declared, "3b")["detail"]
    assert "declared closed" in _gate(declared, "3b")["detail"]


def test_a_mention_of_an_escalating_item_still_escalates(tmp_path):
    """The half that must NOT be lost to the fix above. A mention may only
    raise the requirement -- but it must still raise it, or `Refs #N` on a
    W1-deploy item goes back to one reviewer, which is the hole the whole
    trigger was added to close."""
    from ledger import Ledger

    path = str(tmp_path / "state.json")
    led = Ledger(path, receipts=POLICY["receipts"])
    led.upsert(4487, "a deploy fix", "W1-deploy", lane="lane:docs", size=1)
    led.save()
    result = _run(body="Refs #4487 - the deploy path.", commits=[], state_path=path)
    gate = _gate(result, "3b")
    assert not gate["ok"]
    assert "W1-deploy" in gate["detail"]
    assert result["will_close"] == [], "a bare Refs must not read as a close"


def test_negative_control_declaring_one_does_not_allow_another():
    result = merge_gate.run_gates(
        _data(body="Closes #4468 and closes #4469"), POLICY, allow_close=[4468],
        state_path=_ledger_path(),
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
    """The control. Without it the refusal above could come from anywhere.

    W9-rest, not the helper's W6-ci default: `main()` now resolves the STREAM
    from that same ledger for gate 3b, and W6-ci escalates to two reviewers, so
    the old fixture made this control fail for a reason that had nothing to do
    with what it tests. Named here because it is evidence the wiring is real --
    a stream nobody read could not have changed this test's outcome."""
    _ledger_with(tmp_path, 4468, stream="W9-rest", lane="lane:docs", receipt="ci-green")
    data = _data(body="Closes #4468")
    assert _main_over(monkeypatch, tmp_path, ["1", "--allow-close", "4468"], data) == 0


def test_negative_control_main_escalates_on_the_stream_of_the_issue_it_closes(
    monkeypatch, tmp_path
):
    """The trigger that was inert at the enforcement point for three rounds.

    Same PR, same one approval, same diff -- `domains/sales/models/x.sql`, which
    touches no escalating path. The ONLY difference from the control above is
    the stream the ledger has this issue in. Measured before the fix: GO.

    W1-deploy is the case that matters: R1 makes a broken deploy path preempt
    all feature work, and its fixes routinely land in `azure-functions/`,
    `apps/fiab-*` and `csa_platform/` -- none of which is in the twelve
    fragments, so the path trigger never fired for them either."""
    _ledger_with(tmp_path, 4468, stream="W1-deploy", lane="lane:docs",
                 receipt="deploy-run")
    data = _data(body="Closes #4468")
    assert _main_over(monkeypatch, tmp_path, ["1", "--allow-close", "4468"], data) == 1


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
