"""#4764: an item the deploy-failure WATCHER filed closes on a green run of the
workflow it was filed about -- and on nothing else.

`.github/scripts/deploy-notify-failure.mjs` files `deploy: <workflow> is
failing` and comments at every further failure, each record naming the failed
run. Before #4764 the only `deploy-run` producer was `loom-roll-and-validate`,
so the receipt each of these issues names as its own close condition was
refused. Measured 2026-09-29 on #4448 (`deploy-fiab-commercial`), #4424
(`gov-console-roll`) and #4390 (`loom-dataplane-roll`).

EVERY FIXTURE BELOW IS A REAL SHAPE, transcribed rather than invented:

- the LEDGER item is #4390 as `tools/drain/state.json` held it on 2026-09-29
  (title, stream, lane, size). That file is untracked, so it cannot be read at
  test time; the transcription is the fixture.
- the ISSUE is #4390 as `gh issue view --json author,title,body,comments,
  createdAt,url` returned it: the author spelled `app/github-actions`, comment
  authors spelled `github-actions`, the `- run: <url>` lines.
- the RUNS are 35492055049 (the newest failure #4390 records) and 36522575982
  (the green run the operator tried to record), as `gh run view --json` returned
  them -- including the DISPLAY NAME `Loom data-plane roll (unity / iceberg /
  trino)` that is not the `loom-dataplane-roll` in the title, and the workflow
  id 330241565 both share.

Every test states the value that would make it fail. The refusal tests are
built so the check they name is the ONLY one that refuses: each fixture is the
accepted positive with exactly one field moved, and the positive is asserted
separately, so no refusal here can be satisfied by a verifier that refuses
everything.
"""
from __future__ import annotations

import copy
import json
import os
import pathlib
import re
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import tick
from ledger import CLOSED, READY, Ledger

import gates

POLICY = gates.load_policy(os.path.join(os.path.dirname(__file__), "..", "policy.json"))
REPO = "fgarofalo56/csa-inabox"

#: #4390 in `tools/drain/state.json`, 2026-09-29. TRANSCRIBED (see module doc).
LEDGER_4390 = {
    "number": 4390,
    "title": "deploy: loom-dataplane-roll is failing",
    "stream": "W1-deploy",
    "lane": "lane:ci",
    "size": 3,
}

DATAPLANE_ID = 330241565
DATAPLANE_NAME = "Loom data-plane roll (unity / iceberg / trino)"
NEWEST_FAILURE = "35492055049"
NEWEST_RECORDED_AT = "2026-09-20T05:41:10Z"
GREEN_RUN = "36522575982"


def _record(workflow: str, run_id: str) -> str:
    """A watcher record, in `buildIssueBody`'s own line order."""
    return (
        f"**{workflow}** failed.\n\n"
        f"- run: https://github.com/{REPO}/actions/runs/{run_id}\n"
        "- commit: `a0f7c0f23f29b99935e3519bd993f4c395949dea`\n\n"
        "**No classification was captured for this failure.**\n\n---\n"
        "Per `deploy-integrity.md` R1 a broken deploy path is P0 and preempts "
        "feature work. Close this issue only once the path has run GREEN - not "
        "on a merge (R2)."
    )


def _issue_4390() -> dict:
    """#4390 on GitHub: body plus its six watcher comments, newest LAST."""
    comments = [
        ("2026-09-18T15:59:20Z", "35365275534"),
        ("2026-09-18T22:20:16Z", "35400657545"),
        ("2026-09-20T01:18:17Z", "35480832849"),
        ("2026-09-20T02:15:32Z", "35483206320"),
        ("2026-09-20T03:28:00Z", "35486448802"),
        (NEWEST_RECORDED_AT, NEWEST_FAILURE),
    ]
    return {
        "author": {"login": "app/github-actions"},
        "title": LEDGER_4390["title"],
        "createdAt": "2026-09-08T01:36:08Z",
        "url": f"https://github.com/{REPO}/issues/4390",
        "body": _record("loom-dataplane-roll", "34175684740"),
        "comments": [
            {"author": {"login": "github-actions"}, "createdAt": at,
             "body": _record("loom-dataplane-roll", run_id)}
            for at, run_id in comments
        ],
    }


#: The step that failed in 35492055049, read off the run on 2026-09-29.
ROLL_STEP = "Wait for revision health"
CHECKOUT = "Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
LOGIN = "Azure login (Commercial)"


def _job(name: str, conclusion: str, *, work: bool = True, step: str = ROLL_STEP,
         step_conclusion: str | None = None) -> dict:
    """A job as `gh run view --json jobs` reports it, trimmed to the steps
    that matter: bookkeeping, checkout and login (which ran in the dry run as
    well as the real one), and `step`, the one that failed in the recorded
    failure. `step_conclusion` defaults to the job's own conclusion.

    `work=False` gives a job GitHub ran whose every `if:` said no: bookkeeping
    only. A `skipped` job has no steps at all, as GitHub reports it.
    """
    if conclusion == "skipped":
        return {"name": name, "conclusion": "skipped", "steps": []}
    if not work:
        return {"name": name, "conclusion": conclusion, "steps": [
            {"name": "Set up job", "conclusion": "success"},
            {"name": f"Post {CHECKOUT}", "conclusion": "success"},
            {"name": "Complete job", "conclusion": "success"}]}
    return {"name": name, "conclusion": conclusion, "steps": [
        {"name": "Set up job", "conclusion": "success"},
        {"name": CHECKOUT, "conclusion": "success"},
        {"name": LOGIN, "conclusion": "success"},
        # Skipped in the failed run AND the green one, as on 35492055049 and
        # 36522575982: a step skipped in the FAILURE did not fail, so a check
        # that counted it (arm WR36) would demand it green and refuse the
        # real receipt.
        {"name": "Azure login (Gov)", "conclusion": "skipped"},
        {"name": step, "conclusion": step_conclusion or conclusion},
        {"name": f"Post {CHECKOUT}", "conclusion": "success"},
        {"name": "Complete job", "conclusion": "success"}]}


def _failure(**over) -> dict:
    """35492055049: the newest failure #4390 records. `headSha` and
    `displayTitle` are what `gh run view` reported on 2026-09-29."""
    run = {
        "databaseId": int(NEWEST_FAILURE),
        "workflowName": DATAPLANE_NAME,
        "workflowDatabaseId": DATAPLANE_ID,
        "headBranch": "main",
        "event": "workflow_run",
        "displayTitle": "Roll all → 1c5b177738b2131dae5a09308150c476652a71ee on commercial",
        "createdAt": "2026-09-20T05:35:14Z",
        "status": "completed",
        "conclusion": "failure",
        "headSha": "1c5b177738b2131dae5a09308150c476652a71ee",
        "url": f"https://github.com/{REPO}/actions/runs/{NEWEST_FAILURE}",
        "jobs": [_job("Roll all on commercial", "failure")],
    }
    run.update(over)
    return run


def _green(**over) -> dict:
    """36522575982: the green run the operator tried to record against #4390.
    `headSha` is what GitHub reports for the RUN (a7eadda1...); the
    `7db4c44a...` in its title is the TAG it rolled, which is a different fact."""
    run = {
        "databaseId": int(GREEN_RUN),
        "workflowName": DATAPLANE_NAME,
        "workflowDatabaseId": DATAPLANE_ID,
        "headBranch": "main",
        "event": "workflow_run",
        "displayTitle": "Roll all → 7db4c44afe5e56938f1b0906900af8a5f1cfda25 on commercial",
        "createdAt": "2026-09-29T04:39:13Z",
        "status": "completed",
        "conclusion": "success",
        "headSha": "a7eadda1293339f95b90921dde350a010e4e1f61",
        "url": f"https://github.com/{REPO}/actions/runs/{GREEN_RUN}",
        "jobs": [_job("Roll all on commercial", "success")],
    }
    run.update(over)
    return run


def _filing(**over) -> tick.WatcherFiling:
    base = {
        "workflow_in_title": "loom-dataplane-roll",
        "failure_run_id": NEWEST_FAILURE,
        "recorded_at": tick._parse_time(NEWEST_RECORDED_AT, "t"),
        "records": 7,
    }
    base.update(over)
    return tick.WatcherFiling(**base)


def _gh(issue: dict | None, runs: dict, *, default_branch: str = "main",
        later: list | None = None, list_rc: int = 0):
    """Answer the four reads the watcher route makes, and nothing else.

    Anything else is rc=1, so a test that silently depends on another `gh`
    call fails loudly rather than reading an empty string as an answer.
    `issue=None` answers the issue read with rc=1 too; `later` is what
    `gh run list` returns, `list_rc` its exit code.
    """
    calls: list[list[str]] = []

    def sh(args, **_kwargs):
        calls.append(list(args))
        if args[:3] == ["gh", "issue", "view"] and issue is not None:
            return 0, json.dumps(issue), ""
        if args[:3] == ["gh", "run", "view"] and str(args[3]) in runs:
            return 0, json.dumps(runs[str(args[3])]), ""
        if args[:3] == ["gh", "run", "list"]:
            if list_rc:
                return list_rc, "", "HTTP 502: bad gateway"
            return 0, json.dumps(later or []), ""
        if args[:3] == ["gh", "repo", "view"]:
            return 0, json.dumps({"defaultBranchRef": {"name": default_branch}}), ""
        return 1, "", f"test stub: unexpected gh call {args!r}"

    sh.calls = calls
    return sh


def _ledger(tmp_path, **over) -> tuple[Ledger, object]:
    fields = {**LEDGER_4390, **over}
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(fields["number"], fields["title"], fields["stream"],
                      lane=fields["lane"], size=fields["size"])
    return led, item


def _closer(seen: dict):
    def close(_policy, _repo, _number, _state, detail, kind, issue_class, binding):
        seen.update(detail=detail, kind=kind, issue_class=issue_class, binding=binding)
        return "closed (test stub)"
    return close


# --------------------------------------------------------------------------
# THE SEAM: `record_receipt_from_evidence`, end to end, on #4390's real shape.
# --------------------------------------------------------------------------

def test_watcher_seam_accepts_the_real_4390_shape(tmp_path, monkeypatch):
    """THE POSITIVE, and the one the issue exists for.

    WHAT VALUE WOULD MAKE THIS FAIL:
    - the watcher route bypassed at the call site (arm WR19): the item takes
      the policy route, whose producer is `loom-roll-and-validate`, and this
      run is REFUSED as "a green run of a different workflow";
    - the binding left at `BINDING_POLICY` (arm WR18): `seen["binding"]`;
    - matching by display name against the title (the defect's shape): the
      title says `loom-dataplane-roll`, the run says `Loom data-plane roll
      (...)`, and only the workflow ID agrees;
    - reading the OLDEST record instead of the newest (arm WR5):
      `detail` would name 34175684740, not 35492055049;
    - `re.MULTILINE` dropped from the run-line pattern (arm WR21): no record
      matches and the item refuses.
    """
    led, item = _ledger(tmp_path)
    assert item.effective_receipt_class == "deploy-path", "this test needs a deploy-run item"
    runs = {GREEN_RUN: _green(), NEWEST_FAILURE: _failure()}
    monkeypatch.setattr(tick, "sh", _gh(_issue_4390(), runs))
    seen: dict = {}
    monkeypatch.setattr(tick, "close_issue_on_github", _closer(seen))

    out = tick.record_receipt_from_evidence(
        led, POLICY, REPO, 4390, from_pr=None, from_run=GREEN_RUN)

    assert item.state == CLOSED, item.state
    assert item.receipt_kind == "deploy-run", item.receipt_kind
    assert seen["binding"] == tick.BINDING_WATCHER_WORKFLOW, seen["binding"]
    assert f"workflow id {DATAPLANE_ID}" in seen["detail"], seen["detail"]
    assert f"run {NEWEST_FAILURE}" in seen["detail"], seen["detail"]
    assert "34175684740" not in seen["detail"], "the OLDEST record was used"
    assert "not from the title" in seen["detail"], seen["detail"]
    # The published detail NAMES what recovered -- the only cloud binding this
    # route has (review B-1) -- and says CREATED, not "concluded at" (B-4).
    assert f"job 'Roll all on commercial' step(s) '{ROLL_STEP}'" in seen["detail"], seen["detail"]
    assert "created 2026-09-29T04:39:13Z" in seen["detail"], seen["detail"]
    assert "on commercial" in seen["detail"], "the run's own title must be published"
    assert GREEN_RUN in out.summary


def test_watcher_seam_the_4448_shape_accepts_a_legitimately_skipped_sibling_job(
        tmp_path, monkeypatch):
    """#4448's real job shape: `deploy-fiab-commercial` skips `Post-deploy
    bootstrap (Commercial)` at 0 steps on its GREEN runs too (36568209612), and
    on its failed ones (35852726537).

    WHAT VALUE WOULD MAKE THIS FAIL: requiring EVERY job to have run, rather
    than every job that FAILED -- the stricter rule would refuse every real
    receipt for this workflow. Also the `skipped` exclusion dropped from the
    failed-jobs filter, which makes the skipped sibling a "failed" job that the
    green run then did not run.
    """
    deploy, bootstrap = ("Deploy + validate CSA Loom in Commercial",
                         "Post-deploy bootstrap (Commercial)")
    provision = "Provision (idempotent)"  # the step that failed in 35852726537
    issue = _issue_4390()
    issue["title"] = "deploy: deploy-fiab-commercial is failing"
    led, _item = _ledger(tmp_path, number=4448, title=issue["title"], lane="lane:bicep")
    fail = _failure(workflowName="deploy-fiab-commercial", workflowDatabaseId=281877765,
                    jobs=[_job(deploy, "failure", step=provision), _job(bootstrap, "skipped")])
    green = _green(workflowName="deploy-fiab-commercial", workflowDatabaseId=281877765,
                   event="schedule",
                   jobs=[_job(deploy, "success", step=provision), _job(bootstrap, "skipped")])
    monkeypatch.setattr(tick, "sh", _gh(issue, {GREEN_RUN: green, NEWEST_FAILURE: fail}))
    seen: dict = {}
    monkeypatch.setattr(tick, "close_issue_on_github", _closer(seen))

    tick.record_receipt_from_evidence(led, POLICY, REPO, 4448, from_pr=None, from_run=GREEN_RUN)
    assert seen["binding"] == tick.BINDING_WATCHER_WORKFLOW


def test_watcher_seam_a_policy_producer_run_cannot_close_a_watcher_item(tmp_path, monkeypatch):
    """A green `loom-roll-and-validate` -- the POLICY producer, every required
    step green -- must not close an item filed about `loom-dataplane-roll`.

    WHAT VALUE WOULD MAKE THIS FAIL: the identity comparison deleted (arm WR1).
    The offered run is otherwise indistinguishable from the accepted one: same
    branch, after the failure, and it carries a green `Roll all on commercial`
    job with a work step, so NOTHING BUT the workflow id refuses it.

    This is the #4709 protection carried onto the watcher route: a watcher
    item about a Gov workflow cannot close on a Commercial roll either.
    """
    led, item = _ledger(tmp_path)
    steps = POLICY["receipt_required_steps"]["deploy-run"]
    roll = _green(workflowName="loom-roll-and-validate", workflowDatabaseId=111111111)
    roll["jobs"].append({"name": "roll", "conclusion": "success",
                         "steps": [{"name": s, "conclusion": "success"} for s in steps]})
    monkeypatch.setattr(tick, "sh", _gh(_issue_4390(), {GREEN_RUN: roll, NEWEST_FAILURE: _failure()}))

    with pytest.raises(tick.ReceiptRefusedError) as exc:
        tick.record_receipt_from_evidence(
            led, POLICY, REPO, 4390, from_pr=None, from_run=GREEN_RUN)
    msg = str(exc.value)
    assert "loom-roll-and-validate" in msg, msg
    assert str(DATAPLANE_ID) in msg, msg
    assert item.state == READY
    assert item.receipt_kind is None


def test_watcher_seam_needs_a_run(tmp_path, monkeypatch):
    """WHAT VALUE WOULD MAKE THIS FAIL: the `if not from_run` guard in
    `_watcher_run_receipt` deleted -- `_watcher_run_evidence(repo, None)` then
    asks `gh` about run `None`, the stub answers rc=1, and the refusal names an
    unreadable run instead of the missing flag."""
    led, _item = _ledger(tmp_path)
    monkeypatch.setattr(tick, "sh", _gh(_issue_4390(), {}))
    with pytest.raises(tick.ReceiptRefusedError, match="pass --from-run"):
        tick.record_receipt_from_evidence(led, POLICY, REPO, 4390, from_pr=None, from_run=None)


def test_watcher_seam_an_unreadable_issue_refuses_rather_than_changing_route(
        tmp_path, monkeypatch):
    """R7: "I could not read the issue" is not "the watcher did not file it".

    WHAT VALUE WOULD MAKE THIS FAIL: the rc != 0 branch returning None (arm
    WR17). The item would then take the POLICY route -- chosen by a network
    blip -- and, under conftest's Commercial boundary stub, be checked against
    `loom-roll-and-validate`, giving a DIFFERENT refusal. The match pins which.
    """
    led, _item = _ledger(tmp_path)
    monkeypatch.setattr(tick, "sh", _gh(None, {GREEN_RUN: _green()}))
    with pytest.raises(tick.ReceiptRefusedError, match="establish whether the deploy-failure watcher"):
        tick.record_receipt_from_evidence(
            led, POLICY, REPO, 4390, from_pr=None, from_run=GREEN_RUN)


def test_watcher_seam_a_human_filed_look_alike_takes_the_policy_route(tmp_path, monkeypatch):
    """The TITLE alone does not route an item. A human who files
    `deploy: loom-dataplane-roll is failing` gets the policy route, exactly as
    before #4764.

    WHAT VALUE WOULD MAKE THIS FAIL: the issue-author check dropped (arm WR7).
    The item would then take the watcher route and ACCEPT the green dataplane
    run; on the policy route that run is refused, because the policy producer
    is `loom-roll-and-validate`. The conftest boundary stub resolves
    Commercial, so the refusal is the producer check and nothing earlier.
    """
    led, item = _ledger(tmp_path)
    issue = _issue_4390()
    issue["author"] = {"login": "fgarofalo56"}
    runs = {GREEN_RUN: _green(), NEWEST_FAILURE: _failure()}
    monkeypatch.setattr(tick, "sh", _gh(issue, runs))
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _green())
    with pytest.raises(tick.ReceiptRefusedError, match="only produced by 'loom-roll-and-validate'"):
        tick.record_receipt_from_evidence(
            led, POLICY, REPO, 4390, from_pr=None, from_run=GREEN_RUN)
    assert item.state == READY


def test_watcher_seam_a_non_deploy_class_never_takes_the_watcher_route(tmp_path, monkeypatch):
    """A watcher-titled item in the CONSOLE lane resolves to `ui-surface` ->
    `g1-browser`. A green deploy run is not a browser walk, whatever filed it.

    WHAT VALUE WOULD MAKE THIS FAIL: the `kind == "deploy-run"` gate on the
    watcher route removed (arm WR25). The item would then close on the green
    dataplane run. On the policy route it is refused: the g1 producer is
    `loom-ui-verify`.
    """
    led, item = _ledger(tmp_path, lane="lane:console")
    assert item.effective_receipt_class == "ui-surface"
    runs = {GREEN_RUN: _green(), NEWEST_FAILURE: _failure()}
    monkeypatch.setattr(tick, "sh", _gh(_issue_4390(), runs))
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _green())
    monkeypatch.setattr(tick, "close_issue_on_github", _closer({}))
    with pytest.raises(tick.ReceiptRefusedError, match="loom-ui-verify"):
        tick.record_receipt_from_evidence(
            led, POLICY, REPO, 4390, from_pr=None, from_run=GREEN_RUN)
    assert item.state == READY


# --------------------------------------------------------------------------
# `watcher_filing`: what the watcher's own records establish.
# --------------------------------------------------------------------------

def test_the_newest_record_is_the_one_read(monkeypatch):
    """WHAT VALUE WOULD MAKE THIS FAIL: `min` for `max` (arm WR5) -- the
    filing would name 34175684740 at 2026-09-08."""
    monkeypatch.setattr(tick, "sh", _gh(_issue_4390(), {}))
    filing = tick.watcher_filing(REPO, 4390)
    assert filing is not None
    assert filing.failure_run_id == NEWEST_FAILURE, filing
    assert filing.recorded_at == tick._parse_time(NEWEST_RECORDED_AT, "t"), filing
    assert filing.records == 7, filing
    assert filing.workflow_in_title == "loom-dataplane-roll"


def test_a_human_comment_is_not_a_failure_record(monkeypatch):
    """#4424's shape: the watcher's body records one failure (2026-09-09), and
    a HUMAN triage comment (2026-09-18) quotes a notice of its own -- run line
    AND closing line, as a pasted notice would -- so the notice MARKER cannot
    exclude it and only the author filter does.

    WHAT VALUE WOULD MAKE THIS FAIL: the comment-author filter dropped (arm
    WR6). The human comment then becomes the newest "record", the filing names
    run 99999999999 recorded 2026-09-18, and both assertions move. (Round 2:
    before the pasted closing line was added, the marker filter excluded this
    comment on its own and WR6 SURVIVED -- measured, then fixed here.)
    """
    issue = {
        "author": {"login": "app/github-actions"},
        "title": "deploy: gov-console-roll is failing",
        "createdAt": "2026-09-09T02:46:56Z",
        "url": f"https://github.com/{REPO}/issues/4424",
        "body": _record("gov-console-roll", "34302925611"),
        "comments": [{
            "author": {"login": "fgarofalo56"},
            "createdAt": "2026-09-18T17:05:40Z",
            "body": "TRIAGE 2026-09-18: ALREADY-FIXED. Quoting the notice:\n"
                    + _record("gov-console-roll", "99999999999"),
        }],
    }
    assert tick.WATCHER_CLOSE_MARKER in issue["comments"][0]["body"], (
        "the premise: the human comment carries the marker too")
    monkeypatch.setattr(tick, "sh", _gh(issue, {}))
    filing = tick.watcher_filing(REPO, 4424)
    assert filing is not None
    assert filing.failure_run_id == "34302925611", filing
    assert filing.recorded_at == tick._parse_time("2026-09-09T02:46:56Z", "t"), filing
    assert filing.records == 1, filing


def test_an_issue_the_watcher_did_not_open_is_not_a_watcher_filing(monkeypatch):
    """WHAT VALUE WOULD MAKE THIS FAIL: the issue-author check dropped (arm
    WR7), which returns a filing. Paired with `test_the_newest_record_is_the_one_read`,
    where the same issue authored by the watcher DOES return one."""
    issue = _issue_4390()
    issue["author"] = {"login": "fgarofalo56"}
    monkeypatch.setattr(tick, "sh", _gh(issue, {}))
    assert tick.watcher_filing(REPO, 4390) is None


def test_a_newest_record_naming_no_run_refuses(monkeypatch):
    """The workflow comes from the failed run, so a newest record with no run
    line leaves nothing to read it from -- and this refuses rather than falling
    back to the title.

    WHAT VALUE WOULD MAKE THIS FAIL: the `if not runs:` guard removed (arm
    WR24) -- `ids[0]` then raises IndexError, not a refusal.
    """
    issue = _issue_4390()
    # A real NOTICE (it carries the closing marker) whose run line is gone, so
    # the record is found and then refuses for naming no run.
    body = _record("loom-dataplane-roll", NEWEST_FAILURE)
    issue["comments"][-1]["body"] = "\n".join(
        line for line in body.splitlines() if not line.startswith("- run:"))
    assert tick.WATCHER_CLOSE_MARKER in issue["comments"][-1]["body"]
    monkeypatch.setattr(tick, "sh", _gh(issue, {}))
    with pytest.raises(tick.ReceiptRefusedError, match="names no failed run"):
        tick.watcher_filing(REPO, 4390)


def test_a_record_naming_two_runs_refuses(tmp_path, monkeypatch):
    """WHAT VALUE WOULD MAKE THIS FAIL: the ambiguity guard removed (arm
    WR23). Both runs are stubbed as valid failures of the right workflow, so
    with the guard gone the seam picks one and the item CLOSES."""
    led, item = _ledger(tmp_path)
    issue = _issue_4390()
    issue["comments"][-1]["body"] += (
        f"\n- run: https://github.com/{REPO}/actions/runs/35400000000\n")
    runs = {GREEN_RUN: _green(), NEWEST_FAILURE: _failure(), "35400000000": _failure()}
    monkeypatch.setattr(tick, "sh", _gh(issue, runs))
    monkeypatch.setattr(tick, "close_issue_on_github", _closer({}))
    with pytest.raises(tick.ReceiptRefusedError, match="ambiguous"):
        tick.record_receipt_from_evidence(
            led, POLICY, REPO, 4390, from_pr=None, from_run=GREEN_RUN)
    assert item.state == READY


def test_a_record_naming_a_run_in_another_repository_refuses(tmp_path, monkeypatch):
    """WHAT VALUE WOULD MAKE THIS FAIL: the foreign-repo guard removed (arm
    WR22). The run id is stubbed as a valid failure IN THIS REPO, so with the
    guard gone the seam reads it here and the item CLOSES."""
    led, item = _ledger(tmp_path)
    issue = _issue_4390()
    issue["comments"][-1]["body"] = issue["comments"][-1]["body"].replace(
        f"github.com/{REPO}/", "github.com/other-org/other-repo/")
    runs = {GREEN_RUN: _green(), NEWEST_FAILURE: _failure()}
    monkeypatch.setattr(tick, "sh", _gh(issue, runs))
    monkeypatch.setattr(tick, "close_issue_on_github", _closer({}))
    with pytest.raises(tick.ReceiptRefusedError, match="another repository"):
        tick.record_receipt_from_evidence(
            led, POLICY, REPO, 4390, from_pr=None, from_run=GREEN_RUN)
    assert item.state == READY


@pytest.mark.parametrize(("title", "expected"), [
    ("deploy: loom-dataplane-roll is failing", "loom-dataplane-roll"),
    ("deploy: Loom data-plane roll (unity / iceberg / trino) is failing",
     "Loom data-plane roll (unity / iceberg / trino)"),
    ("deploy:  is failing", None),
    ("deploy: loom-dataplane-roll is failing again", None),
    ("deploy-fiab-gcch: scheduled runs have been QUEUED", None),
])
def test_the_title_prefilter(title, expected):
    """Each row names its breaking value: a prefix-only test accepts row 4, an
    unguarded slice accepts row 3 as `""`, and a word-only token rejects row 2
    -- which is the title `GITHUB_WORKFLOW` would produce when the watcher is
    called without `--workflow`."""
    assert tick.watcher_workflow_in_title(title) == expected


@pytest.mark.parametrize(("author", "is_watcher"), [
    ({"login": "app/github-actions"}, True),
    ({"login": "github-actions"}, True),
    ({"login": "github-actions[bot]"}, True),
    ({"login": "github-actions-fan"}, False),
    ({"login": "fgarofalo56"}, False),
    (None, False),
])
def test_the_watcher_login_folds_its_three_spellings_and_nothing_else(author, is_watcher):
    """WHAT VALUE WOULD MAKE THIS FAIL: a prefix test (`startswith`) accepts
    row 4; dropping either fold rejects row 1 or row 3."""
    assert (tick._login(author) == tick.WATCHER_LOGIN) is is_watcher


# --------------------------------------------------------------------------
# `verify_watcher_run_receipt`: each refusal, with the accepted positive.
# --------------------------------------------------------------------------

def _verify(run=None, failure=None, filing=None, branch="main", later=None):
    """The two checks in the order `_watcher_run_receipt` runs them."""
    run = run or _green()
    ref = tick.verify_watcher_run_receipt(
        4390, filing or _filing(), failure or _failure(), run, branch)
    tick.refuse_if_red_since(run, later if later is not None else [], branch)
    return ref


def test_the_positive_is_accepted():
    """The control every refusal below is one field away from. WHAT VALUE
    WOULD MAKE THIS FAIL: any check below becoming unconditional."""
    ref = _verify()
    assert GREEN_RUN in ref, ref
    assert "a7eadda1" in ref, ref


def test_a_different_workflow_with_the_same_display_name_is_refused():
    """Identity is the workflow ID, not the name.

    WHAT VALUE WOULD MAKE THIS FAIL: comparing `workflowName` (arm WR2) --
    both runs say `Loom data-plane roll (...)` here and only the id differs.
    """
    with pytest.raises(tick.ReceiptRefusedError, match="different workflow"):
        _verify(run=_green(workflowDatabaseId=999999999))


def test_the_same_workflow_renamed_is_still_accepted():
    """The mirror: a workflow whose `name:` changed between the failure and
    the green run is still the same workflow. WHAT VALUE WOULD MAKE THIS FAIL:
    requiring the names to agree as well as the ids."""
    _verify(run=_green(workflowName="Loom data-plane roll (renamed)"))


def test_a_failure_run_with_no_workflow_id_refuses_even_against_a_run_with_none():
    """`None == None`. WHAT VALUE WOULD MAKE THIS FAIL: the `if not expected`
    guard removed (arm WR16) -- both ids are None, the identity comparison
    passes, and the run is accepted as a receipt for an unknown workflow."""
    with pytest.raises(tick.ReceiptRefusedError, match="reports no workflow id"):
        _verify(run=_green(workflowDatabaseId=None), failure=_failure(workflowDatabaseId=None))


def test_an_unfinished_run_is_refused_even_with_a_stale_success():
    """GitHub reports a previous attempt's `conclusion` while a re-run is in
    progress. WHAT VALUE WOULD MAKE THIS FAIL: the status check removed (arm
    WR9) -- the conclusion here IS success, so nothing else refuses."""
    with pytest.raises(tick.ReceiptRefusedError, match="has not finished"):
        _verify(run=_green(status="in_progress"))


def test_a_completed_failed_run_is_refused():
    """WHAT VALUE WOULD MAKE THIS FAIL: the conclusion check removed (arm
    WR10). The job is left green so the job check does not refuse first --
    a workflow can conclude `failure` on a job outside the failed set."""
    with pytest.raises(tick.ReceiptRefusedError, match="not success"):
        _verify(run=_green(conclusion="failure"))


def test_a_green_run_on_another_branch_is_refused():
    """WHAT VALUE WOULD MAKE THIS FAIL: the branch check removed (arm WR8)."""
    with pytest.raises(tick.ReceiptRefusedError, match="not the default branch"):
        _verify(run=_green(headBranch="feat/4764"))


def test_the_default_branch_is_the_one_read_not_main():
    """WHAT VALUE WOULD MAKE THIS FAIL: comparing against a literal `main`."""
    _verify(run=_green(headBranch="trunk"), branch="trunk")
    with pytest.raises(tick.ReceiptRefusedError, match="not the default branch"):
        _verify(run=_green(headBranch="main"), branch="trunk")


@pytest.mark.parametrize("created", [
    "2026-09-20T05:40:00Z",   # after the failed run STARTED, before it was recorded
    NEWEST_RECORDED_AT,        # the same second
    "2026-09-19T00:00:00Z",   # after the body, before the newest record
])
def test_a_run_not_after_the_newest_recorded_failure_is_refused(created):
    """WHAT VALUE WOULD MAKE THIS FAIL: the time bound removed (arm WR3)
    reds every row; `<` for `<=` (arm WR4) reds the equal-second row."""
    with pytest.raises(tick.ReceiptRefusedError, match="not after the newest failure"):
        _verify(run=_green(createdAt=created))


def test_a_run_one_second_after_the_newest_recorded_failure_is_accepted():
    """The boundary's other side. WHAT VALUE WOULD MAKE THIS FAIL: a bound
    that refuses the whole second after, or compares against a later time."""
    _verify(run=_green(createdAt="2026-09-20T05:41:11Z"))


def test_the_time_bound_compares_times_not_strings():
    """`2026-09-20T05:41:10.500Z` is AFTER the record; as strings it sorts
    BEFORE `2026-09-20T05:41:10Z` (`.` < `Z`). WHAT VALUE WOULD MAKE THIS
    FAIL: comparing the raw strings."""
    _verify(run=_green(createdAt="2026-09-20T05:41:10.500Z"))


def test_an_unreadable_run_time_refuses():
    """WHAT VALUE WOULD MAKE THIS FAIL: skipping the bound when the time is
    missing, rather than refusing."""
    with pytest.raises(tick.ReceiptRefusedError, match="cannot read the run's creation time"):
        _verify(run=_green(createdAt=None))


def test_a_run_whose_every_job_skipped_is_refused():
    """`cloud-parity.md`: a green run whose deploy job was skipped at 0 steps
    is not a receipt. WHAT VALUE WOULD MAKE THIS FAIL: the job-conclusion
    check removed (arm WR11) -- and then `_job_did_work` still refuses, which
    is why the next test exists: this row pins the MESSAGE of the first check,
    not the outcome."""
    with pytest.raises(tick.ReceiptRefusedError, match="concluded 'skipped', not success"):
        _verify(run=_green(jobs=[_job("Roll all on commercial", "skipped")]))


def test_a_job_that_ran_only_bookkeeping_is_refused():
    """A job can conclude success with every `if:` false: GitHub still runs
    `Set up job`, the post hooks and `Complete job`. WHAT VALUE WOULD MAKE
    THIS FAIL: the did-work check removed (arm WR12), or the bookkeeping
    exclusion dropped (arm WR13) so `Set up job` counts as work."""
    job = _job("Roll all on commercial", "success", work=False)
    assert [s["name"] for s in job["steps"]] == [
        "Set up job", f"Post {CHECKOUT}", "Complete job"], job
    with pytest.raises(tick.ReceiptRefusedError, match="executed no work step"):
        _verify(run=_green(jobs=[job]))


def test_a_run_missing_the_job_that_failed_is_refused():
    """WHAT VALUE WOULD MAKE THIS FAIL: the missing-job guard removed (arm
    WR15) -- the loop then iterates nothing for that name and accepts."""
    with pytest.raises(tick.ReceiptRefusedError, match="has no job 'Roll all on commercial'"):
        _verify(run=_green(jobs=[_job("Roll unity on commercial", "success")]))


def test_a_recorded_failure_with_no_failed_job_refuses():
    """Nothing to key the "did it run" check on. WHAT VALUE WOULD MAKE THIS
    FAIL: the empty-set guard removed (arm WR14) -- the loop then checks
    nothing and ANY green run of the workflow is accepted."""
    with pytest.raises(tick.ReceiptRefusedError, match="has no failed job"):
        _verify(failure=_failure(jobs=[_job("Roll all on commercial", "success")]))


# --------------------------------------------------------------------------
# Round 2: the STEP key, "not red since", the event, the record marker.
# --------------------------------------------------------------------------

DEPLOY_JOB = "Deploy + validate CSA Loom in Commercial"
PROVISION = "Provision (idempotent)"


def test_a_dry_run_that_skipped_the_failed_step_is_refused():
    """REVIEW A's MEASURED BLOCKER, in its live shape: failure 34217993648
    (`Provision (idempotent)` = failure) against the `whatif-only` dry run
    34262376463, whose job is green because checkout and login ran while
    `Provision (idempotent)` was SKIPPED. Round 1 ACCEPTED this.

    WHAT VALUE WOULD MAKE THIS FAIL: the step-conclusion check deleted (arm
    WR26). Nothing else refuses it: the job concluded success and did work
    (checkout, login), which is exactly why the job-level check was not enough.
    """
    fail = _failure(jobs=[_job(DEPLOY_JOB, "failure", step=PROVISION)])
    dry = _green(event="workflow_dispatch",
                 displayTitle="deploy-fiab-commercial — DRY RUN (whatif-only, applies nothing)",
                 jobs=[_job(DEPLOY_JOB, "success", step=PROVISION, step_conclusion="skipped")])
    assert tick._job_did_work(dry["jobs"][0]), "the premise: the job DID do work"
    with pytest.raises(tick.ReceiptRefusedError, match=r"concluded 'skipped', not success - it failed"):
        _verify(run=dry, failure=fail)
    # THE POSITIVE PAIR: the same job with the step green is accepted.
    _verify(run=_green(jobs=[_job(DEPLOY_JOB, "success", step=PROVISION)]), failure=fail)


def test_a_run_whose_job_lacks_the_failed_step_is_refused():
    """WHAT VALUE WOULD MAKE THIS FAIL: the missing-step guard deleted (arm
    WR27) -- the loop over same-named steps then iterates nothing and accepts."""
    job = _job("Roll all on commercial", "success", step="Roll the Container Apps")
    with pytest.raises(tick.ReceiptRefusedError, match=f"has no step '{ROLL_STEP}'"):
        _verify(run=_green(jobs=[job]))


def test_a_failed_job_with_no_failed_step_refuses():
    """A job can fail with no failed step (a runner assignment failure reports
    `steps: []`). WHAT VALUE WOULD MAKE THIS FAIL: the guard deleted (arm
    WR28) -- the step loop then checks nothing and the job-level green passes."""
    fail = _failure(jobs=[{"name": "Roll all on commercial", "conclusion": "failure", "steps": []}])
    with pytest.raises(tick.ReceiptRefusedError, match="with no failed STEP recorded"):
        _verify(failure=fail)


def test_a_bookkeeping_step_failure_still_needs_the_job_to_do_work():
    """The case `_job_did_work` exists for now that steps are keyed: the
    failed step is `Set up job` itself, so "that step is green now" is true of
    a job whose every `if:` said no. WHAT VALUE WOULD MAKE THIS FAIL: the
    did-work check deleted (arm WR12) or `Set up job` counted as work (arm
    WR13) -- the step loop passes on its own here, so this is an OUTCOME kill
    for both, where `test_a_job_that_ran_only_bookkeeping_is_refused` is a
    MESSAGE kill."""
    fail = _failure(jobs=[{"name": "Roll all on commercial", "conclusion": "failure",
                           "steps": [{"name": "Set up job", "conclusion": "failure"}]}])
    idle = _job("Roll all on commercial", "success", work=False)
    with pytest.raises(tick.ReceiptRefusedError, match="executed no work step"):
        _verify(run=_green(jobs=[idle]), failure=fail)


OFFERED = "2026-09-29T04:39:13Z"  # 36522575982's createdAt, the `_green()` default


def _listed(run_id, conclusion, created, updated):
    """A `gh run list --json databaseId,conclusion,createdAt,updatedAt,event`
    row. `updated` is when a completed run last changed: its completion."""
    return {"databaseId": run_id, "conclusion": conclusion, "createdAt": created,
            "updatedAt": updated, "event": "workflow_run"}


@pytest.mark.parametrize("conclusion", ["failure", "cancelled", "timed_out", "skipped"])
def test_a_completed_run_red_since_the_offered_one_refuses(conclusion):
    """"Has run GREEN" means green and not red again (review A-2). A failure
    whose notice was never posted is exactly this. `cancelled` and `skipped`
    count (review A-3, disclosed in the comment): the rule is "did not
    succeed", and a refusal costs only offering the newer green run.

    WHAT VALUE WOULD MAKE THIS FAIL: the red-since check deleted (arm WR29).
    """
    later = [_listed(36609548942, conclusion, "2026-09-29T18:05:20Z", "2026-09-29T18:51:10Z")]
    with pytest.raises(tick.ReceiptRefusedError, match="did not succeed"):
        _verify(later=later)


def test_a_run_created_before_but_finished_red_after_the_offered_one_refuses():
    """REVIEW B, ROUND 3: the round-2 check listed only runs CREATED after the
    offered one, while the published text claimed nothing finished red after
    it. `deploy-fiab-commercial` has no workflow-level concurrency group, so a
    schedule run and a dispatch run overlap. This run began nine minutes BEFORE
    the offered run and finished red thirty-one minutes AFTER it.

    WHAT VALUE WOULD MAKE THIS FAIL: the finished-after clause dropped (arm
    WR37) -- the run was created before the offered one, so a created-only
    test does not see it.
    """
    later = [_listed(36522000000, "failure", "2026-09-29T04:30:00Z", "2026-09-29T05:10:00Z")]
    with pytest.raises(tick.ReceiptRefusedError, match="created or finished"):
        _verify(later=later)


def test_a_later_green_run_and_an_earlier_red_one_do_not_refuse():
    """The mirror. #4390's live list after 36522575982 held a green run; a red
    run the WINDOW returns that both began and FINISHED before the offered run
    was created must not count -- it is history, not "red since".

    WHAT VALUE WOULD MAKE THIS FAIL: the created-or-finished filter removed
    (arm WR30) refuses on the earlier red run; a check that refuses on ANY
    listed run refuses on the green one.
    """
    later = [
        _listed(36615042913, "success", "2026-09-29T18:51:25Z", "2026-09-29T18:59:47Z"),
        _listed(36500000000, "failure", "2026-09-29T01:00:00Z", "2026-09-29T01:30:00Z"),
    ]
    _verify(later=later)


@pytest.mark.parametrize("event", ["pull_request", "pull_request_target", None])
def test_a_pull_request_run_is_refused(event):
    """For a `pull_request*` run `headBranch` is the PR's branch, so a fork
    branch named `main` passes the branch check. WHAT VALUE WOULD MAKE THIS
    FAIL: the event check deleted (arm WR32). `None` pins that an ABSENT event
    refuses rather than passing."""
    with pytest.raises(tick.ReceiptRefusedError, match="triggered by"):
        _verify(run=_green(event=event))


def test_the_later_runs_read_fails_closed(monkeypatch):
    """WHAT VALUE WOULD MAKE THIS FAIL: a read error returning `[]` -- "could
    not look" read as "nothing red since" -- or the full-page guard deleted
    (arm WR31)."""
    since = tick._parse_time(OFFERED, "t")
    monkeypatch.setattr(tick, "sh", _gh(None, {}, list_rc=1))
    with pytest.raises(tick.ReceiptRefusedError, match="502"):
        tick._later_runs(REPO, DATAPLANE_ID, "main", since)
    full = [_listed(i, "success", "2026-09-29T05:00:00Z", "2026-09-29T05:10:00Z")
            for i in range(tick._LATER_RUNS_LIMIT)]
    monkeypatch.setattr(tick, "sh", _gh(None, {}, later=full))
    with pytest.raises(tick.ReceiptRefusedError, match="may be incomplete"):
        tick._later_runs(REPO, DATAPLANE_ID, "main", since)
    # POSITIVE: one short of the page is read as complete.
    monkeypatch.setattr(tick, "sh", _gh(None, {}, later=full[:-1]))
    assert len(tick._later_runs(REPO, DATAPLANE_ID, "main", since)) == tick._LATER_RUNS_LIMIT - 1


def test_the_later_runs_query_names_the_workflow_branch_and_window(monkeypatch):
    """The query is the only thing binding "later" to THIS workflow on THIS
    branch, and its `--created` bound reaches 72 h BEFORE the offered run so a
    run that began earlier is in the list at all.

    WHAT VALUE WOULD MAKE THIS FAIL: dropping `--workflow`, `--branch`,
    `--status completed` or `--created` from the argv; bounding `--created` at
    the offered run itself (arm WR38), which reads `>=2026-09-29T04:39:13Z`;
    or dropping `updatedAt` from the fields, which leaves the finished-after
    test with nothing to read and REFUSES on every listed run that did not
    succeed, even one that finished long before.
    """
    stub = _gh(None, {})
    monkeypatch.setattr(tick, "sh", stub)
    tick._later_runs(REPO, DATAPLANE_ID, "main", tick._parse_time(OFFERED, "t"))
    argv = stub.calls[-1]
    for flag, value in (("--workflow", str(DATAPLANE_ID)), ("--branch", "main"),
                        ("--status", "completed"), ("--created", ">=2026-09-26T04:39:13Z")):
        assert argv[argv.index(flag) + 1] == value, (flag, argv)
    assert "updatedAt" in argv[argv.index("--json") + 1].split(","), argv


def test_a_malformed_offered_run_is_refused_for_its_own_defect_before_listing(
        tmp_path, monkeypatch):
    """REVIEW B NIT, ROUND 3: the run is checked BEFORE the red-since listing,
    so a run of the wrong workflow is refused for that -- not for a listing
    that failed because it was built from the wrong workflow id.

    WHAT VALUE WOULD MAKE THIS FAIL: listing first (arm WR39) -- the list read
    fails (rc=1 here) and the refusal names the listing.
    """
    led, _item = _ledger(tmp_path)
    runs = {GREEN_RUN: _green(workflowDatabaseId=999999999), NEWEST_FAILURE: _failure()}
    stub = _gh(_issue_4390(), runs, list_rc=1)
    monkeypatch.setattr(tick, "sh", stub)
    with pytest.raises(tick.ReceiptRefusedError, match="different workflow"):
        tick.record_receipt_from_evidence(
            led, POLICY, REPO, 4390, from_pr=None, from_run=GREEN_RUN)
    assert not any(c[:3] == ["gh", "run", "list"] for c in stub.calls), stub.calls


def test_a_watcher_login_post_without_the_notice_marker_is_not_a_record(monkeypatch):
    """Any workflow with `issues: write` posts as `github-actions`. A newer
    such post that is not a failure notice (`copilot-auto-fix.yml`'s
    acknowledgement is the measured candidate) must be skipped, not read as the
    newest failure.

    WHAT VALUE WOULD MAKE THIS FAIL: the marker filter removed (arm WR33) --
    the acknowledgement becomes the newest record, names no run, and the
    filing REFUSES instead of naming 35492055049.
    """
    issue = _issue_4390()
    issue["comments"].append({"author": {"login": "github-actions"},
                              "createdAt": "2026-09-21T00:00:00Z",
                              "body": "Copilot is taking a look at this issue."})
    monkeypatch.setattr(tick, "sh", _gh(issue, {}))
    filing = tick.watcher_filing(REPO, 4390)
    assert filing is not None
    assert filing.failure_run_id == NEWEST_FAILURE, filing
    assert filing.records == 7, "the acknowledgement was counted as a record"


def test_an_issue_with_no_notice_at_all_refuses(monkeypatch):
    """WHAT VALUE WOULD MAKE THIS FAIL: the empty-records guard deleted (arm
    WR34) -- `max([])` then raises ValueError, not a refusal. Killed by a
    crash, disclosed."""
    issue = _issue_4390()
    issue["body"], issue["comments"] = "hand-written body", []
    monkeypatch.setattr(tick, "sh", _gh(issue, {}))
    with pytest.raises(tick.ReceiptRefusedError, match="no record on it carries"):
        tick.watcher_filing(REPO, 4390)


def test_watcher_seam_refuses_when_the_path_went_red_again(tmp_path, monkeypatch):
    """The red-since check at the SEAM: `_watcher_run_receipt` must pass what
    `gh run list` returned into the verifier. WHAT VALUE WOULD MAKE THIS FAIL:
    the call site passing `[]` instead of the list it read."""
    led, item = _ledger(tmp_path)
    runs = {GREEN_RUN: _green(), NEWEST_FAILURE: _failure()}
    later = [_listed(36609548942, "failure", "2026-09-29T18:05:20Z", "2026-09-29T18:51:10Z")]
    monkeypatch.setattr(tick, "sh", _gh(_issue_4390(), runs, later=later))
    with pytest.raises(tick.ReceiptRefusedError, match="did not succeed"):
        tick.record_receipt_from_evidence(
            led, POLICY, REPO, 4390, from_pr=None, from_run=GREEN_RUN)
    assert item.state == READY


# --------------------------------------------------------------------------
# The PUBLIC COMMENT the watcher route posts.
# --------------------------------------------------------------------------

def test_the_watcher_comment_claims_only_what_the_route_checked():
    """WHAT VALUE WOULD MAKE THIS FAIL: the watcher branch in `_receipt_comment`
    removed (arm WR20) -- the policy text then says "the only workflow policy
    accepts" and "no run date is fetched", both false on this route. Also a
    reintroduction of the round-1 sentence "the cloud this receipt speaks for
    is the one that workflow deploys to", which is FALSE for
    `loom-dataplane-roll` -- its `boundary` input picks commercial, gcc-high
    or il5 (review B-1).

    The absence assertions are PAIRED with the positive ones above them, so
    they cannot be satisfied by an empty comment.
    """
    text = tick._receipt_comment("deploy-run", "deploy-path", "d",
                                 tick.BINDING_WATCHER_WORKFLOW)
    assert "matched by workflow id" in text, text
    assert "created AFTER the newest failure" in text, text
    assert "every job and every step that failed" in text, text
    assert "the ONLY cloud binding is that the green run contains the same-named" in text, text
    assert "dispatch inputs" in text, text
    # Round 3 (review B): the red-since sentence claims only what the query and
    # the filter establish -- created OR finished after, over a stated window --
    # and the window's gap and the skipped-counts-as-red rule are disclosed.
    assert "that was created or finished after it was created" in text, text
    assert f"looking back {tick._window_hours()} hours" in text, text
    assert f"A run created more than {tick._window_hours()} hours before it" in text, text
    assert "A cancelled or skipped run counts as not succeeding" in text, text
    assert "passes whenever every failed step also ran green in that mode" in text, text
    assert "after which no completed run" not in text, text
    assert "the one that workflow deploys to" not in text, text
    assert "executed work steps" not in text, text
    assert "A failure the watcher did not record is not seen" not in text, text
    assert "the only workflow policy accepts" not in text, text
    assert "no run date is fetched" not in text, text
    policy_text = tick._receipt_comment("deploy-run", "deploy-path", "d", tick.BINDING_POLICY)
    assert "the only workflow policy accepts" in policy_text


def test_an_unknown_binding_refuses():
    """WHAT VALUE WOULD MAKE THIS FAIL: the binding guard removed -- the
    unknown value then falls through to the policy sentence."""
    with pytest.raises(tick.ReceiptRefusedError, match="receipt binding"):
        tick._receipt_comment("deploy-run", "deploy-path", "d", "made-up")


def test_a_merge_receipt_cannot_carry_the_watcher_binding():
    """Unreachable from the record path (the watcher route requires
    `deploy-run`), so DIRECT. WHAT VALUE WOULD MAKE THIS FAIL: the guard in
    the merge branch removed -- a merge would publish under a run binding."""
    with pytest.raises(tick.ReceiptRefusedError, match="is a MERGE"):
        tick._receipt_comment("ci-green", "guard-or-test-only", "d",
                              tick.BINDING_WATCHER_WORKFLOW)
    assert "a merge, not a deploy" in tick._receipt_comment(
        "ci-green", "guard-or-test-only", "d", tick.BINDING_POLICY)


def test_the_signature_requires_a_binding():
    """`close_issue_on_github` and `_receipt_comment` take `binding` with NO
    default. WHAT VALUE WOULD MAKE THIS FAIL: a default added back, under
    which a caller that forgets it publishes the policy sentence silently."""
    import inspect

    for fn in (tick.close_issue_on_github, tick._receipt_comment):
        param = inspect.signature(fn).parameters["binding"]
        assert param.default is inspect.Parameter.empty, fn.__name__


# --------------------------------------------------------------------------
# The shapes are LIFTED from the script that files them, not trusted.
# --------------------------------------------------------------------------

def _repo_root():
    """The full checkout, or None in the mutation sandbox. Same marker pair as
    `test_gates._repo_root`, for the reason its docstring gives."""
    for candidate in pathlib.Path(__file__).resolve().parents:
        if (candidate / ".github" / "workflows").is_dir() and (
                candidate / "scripts" / "ci").is_dir():
            return candidate
    return None


def test_the_watcher_shapes_are_lifted_from_the_script_that_files_them():
    """`WATCHER_TITLE_PREFIX`/`SUFFIX` and `_WATCHER_RUN_LINE` are transcribed
    from `.github/scripts/deploy-notify-failure.mjs`. This reads that file, so
    a change to the template there goes red HERE rather than silently routing
    every new watcher issue to the policy route.

    SKIPS OUT OF TREE, and is declared in `mutate_gates.EXPECTED_SANDBOX_SKIPS`:
    the sandbox copies only `tools/drain`. It kills no arm; the title and
    run-line arms are killed by the fixture tests above.

    WHAT VALUE WOULD MAKE THIS FAIL: `buildIssueTitle` returning anything but
    `deploy: ${workflow} is failing`, or `buildIssueBody` writing the run line
    as anything but `- run: ${runUrl ...}` over a `.../actions/runs/<id>` url.
    """
    root = _repo_root()
    if root is None:
        pytest.skip("out of tree: no .github/workflows + scripts/ci above this file")
    source = (root / ".github" / "scripts" / "deploy-notify-failure.mjs").read_text(
        encoding="utf-8")
    title = re.search(
        r"function buildIssueTitle\(workflow\) \{\s*return `([^`$]*)\$\{workflow\}([^`]*)`;",
        source)
    assert title is not None, "buildIssueTitle's template was not found"
    assert title.group(1) == tick.WATCHER_TITLE_PREFIX, title.group(1)
    assert title.group(2) == tick.WATCHER_TITLE_SUFFIX, title.group(2)

    assert "`- run: ${runUrl ?? `(run ${runId})`}`," in source, (
        "buildIssueBody's run line changed shape")
    assert "runUrl: `${serverUrl}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`," in source, (
        "main()'s runUrl changed shape")
    rendered = f"**x** failed.\n\n- run: https://github.com/{REPO}/actions/runs/123\n- commit: `s`"
    assert tick._WATCHER_RUN_LINE.findall(rendered) == [(REPO, "123")]
    # The notice marker is in the closing line `buildIssueBody` pushes last.
    assert f"'{tick.WATCHER_CLOSE_MARKER} — not on a merge (R2).'" in source, (
        "buildIssueBody's closing line no longer carries WATCHER_CLOSE_MARKER")


def test_policy_is_unchanged_by_the_watcher_route():
    """The watcher route adds NO producer to policy: `deploy-run` still
    declares exactly `loom-roll-and-validate` for Commercial, and nothing for
    any other boundary. WHAT VALUE WOULD MAKE THIS FAIL: implementing #4764 by
    widening `receipt_producers` -- which would make every such workflow a
    producer for EVERY deploy-run item, not only the one filed about it."""
    declared = copy.deepcopy(POLICY["receipt_producers"]["deploy-run"])
    assert declared == {"Commercial": "loom-roll-and-validate"}, declared
