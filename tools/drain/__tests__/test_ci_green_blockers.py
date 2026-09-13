

"""The two blockers from #4491's independent review, as executable attacks.

Separate file, same fixtures. Kept apart from `test_ci_green.py` so it is
obvious which assertions exist because a reviewer DEMONSTRATED a hole rather
than because the author imagined one -- and so a later refactor cannot quietly
drop them into the noise of a large file.

Run:  python -m pytest tools/drain/__tests__/ -q
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
# ...and the test directory itself, so the sibling fixtures import by name.
# `__tests__` is not a package (no `__init__.py`) and pytest's rootdir-based
# insertion covers the rootdir, not this directory.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_ci_green import (
    MERGED_SHA,
    POLICY,
    _ev,
    _green,
    _hollow_job,
    _job,
    _path_filtered,
    _push_run,
    _receipt,
)

import gates

# ---------------------------------------------------------------------------
# The two blockers from independent review (#4491) -- each attack, as a test
# ---------------------------------------------------------------------------
#
# Both reviewers returned REQUEST-CHANGES on the first version of this receipt,
# from different angles, and converged. These are their attacks executed
# against the corrected code. A fix whose own negative control is the
# reviewer's reproduction is the only kind worth trusting here, because the
# standing lesson in this repo is that the blocker is usually in the PREVIOUS
# ROUND'S FIX.


def test_negative_control_a_head_green_that_executed_nothing_is_not_deferrable():
    """BLOCKER 1, measured by reviewer 1 on live PRs #4440 and #4437.

    `test.yml` publishes `Python Tests (3.x)` on BOTH events and, on
    `pull_request`, concludes SUCCESS with `Run pytest with coverage`, `Lint
    with ruff` and `mypy` all `skipped` -- by design, documented in the
    workflow, because the real suite runs on `push`. The first version of this
    receipt asked only `verdict != "SUCCESS"` and therefore deferred a
    path-filtered context to a green that measured nothing. That is "quietly
    accept 10-of-15" with a function wrapped around it.
    """
    receipt = _receipt([
        _path_filtered("Python Tests (3.10)",
                       head_job=_hollow_job("Python Tests (3.10)")),
    ])
    assert not receipt.ok
    assert any("3 of its 3 work step(s) are SKIPPED" in r for r in receipt.reasons)
    assert any("not a result to defer to" in r for r in receipt.reasons)


def test_negative_control_a_change_detection_step_does_not_count_as_having_run():
    """THE DEFECT IN THE FIRST FIX FOR BLOCKER 1, found by running the corrected
    receipt against the reviewer's real PR instead of against a fixture written
    from their description.

    The first correction asked whether ANY substantive step executed. PR
    #4440's `Python Tests (3.10)` head job (run 34483464251) satisfied that
    with exactly ONE step -- `Detect Python-relevant changes` -- which is the
    change-detection gate that then skipped the other ten, including `Run
    pytest with coverage`, `Lint with ruff` and `Typecheck with mypy (strict)`.
    So the receipt still returned GREEN on the very PR the blocker named.

    A predicate a gate step can satisfy is not a predicate.
    """
    gated = {
        "name": "Python Tests (3.10)",
        "conclusion": "success",
        "steps": [
            {"name": "Set up job", "conclusion": "success"},
            {"name": "Run actions/checkout@v4", "conclusion": "success"},
            # The ONE step that ran: the gate that skipped everything else.
            {"name": "Detect Python-relevant changes", "conclusion": "success"},
            *[
                {"name": n, "conclusion": "skipped"}
                for n in ("Set up Python", "Install dependencies", "Lint with ruff",
                          "Security scan with Bandit", "Typecheck with mypy (strict)",
                          "Validate data product contracts",
                          "Check dbt schema drift against contracts",
                          "Run pytest with coverage",
                          "Upload coverage report (xml + html)", "Coverage summary")
            ],
            {"name": "Complete job", "conclusion": "success"},
        ],
    }
    ran, why = gates.job_executed(gated)
    assert not ran
    assert "10 of its 11 work step(s) are SKIPPED" in why
    assert "Run pytest with coverage" in why or "Lint with ruff" in why
    receipt = _receipt([_path_filtered("Python Tests (3.10)", head_job=gated)])
    assert not receipt.ok


def test_the_execution_rule_is_all_not_any_and_the_distribution_says_so():
    """Why "every work step" rather than a ratio: the real distribution is
    BIMODAL WITH NO MIDDLE.

    Measured over the 16 deferrals on PRs #4440 and #4483 -- genuine jobs skip
    ZERO of 2-7 work steps, hollow ones skip 10 of 11. A ratio threshold would
    be an arbitrary number dressed as a measurement; "any skip refuses" costs
    nothing today and fails closed if that ever changes.
    """
    # One skipped step out of many is still a refusal, deliberately.
    nearly = _job("x", steps=("a", "b", "c", "d"), skipped=("d",))
    ran, why = gates.job_executed(nearly)
    assert not ran
    assert "1 of its 4 work step(s) are SKIPPED" in why
    # ...and zero skipped passes.
    assert gates.job_executed(_job("x", steps=("a", "b", "c", "d")))[0]


def test_a_head_green_that_really_ran_is_still_deferrable():
    """The other side of the same boundary, so the fix DISCRIMINATES.

    Reviewer 1's own measurement makes this necessary: `dbt Compile (shared)`
    on the very same run is genuine, 0 of 9 steps skipped. It is 3 of 11
    deferrals that are hollow, not all of them -- so a fix that distrusted
    deferral as a CATEGORY would be the remedy-worse-than-the-defect shape
    this package keeps finding.
    """
    receipt = _receipt([
        _path_filtered("dbt Compile (shared)",
                       head_job=_job("dbt Compile (shared)",
                                     steps=tuple(f"step {i}" for i in range(9)))),
    ])
    assert receipt.ok, receipt.reasons
    assert "executed 9 of 9 work step(s)" in receipt.by_state("deferred-to-head")[0].detail


def test_negative_control_absent_step_data_fails_closed_in_every_shape():
    """`job_executed` answers an unanswered question with NO.

    Four ways the data can be missing, each of which would otherwise read as
    "it ran": no job record at all, a non-dict, no `steps` key, and an empty
    `steps` list. An unanswered question is not evidence.
    """
    for job in (None, "not a dict", {"name": "x"}, {"name": "x", "steps": []}):
        ran, why = gates.job_executed(job)
        assert not ran, job
        assert "cannot be shown to have run" in why


def test_negative_control_a_job_of_only_bookkeeping_steps_did_not_run():
    """`Set up job` / `Complete job` / checkout / `Post ...` run on EVERY job,
    including one whose real steps were all skipped. Counting them as work
    would make the check unfailable."""
    ran, why = gates.job_executed({
        "name": "x",
        "steps": [
            {"name": "Set up job", "conclusion": "success"},
            {"name": "Run actions/checkout@v4", "conclusion": "success"},
            {"name": "Post Run actions/checkout@v4", "conclusion": "success"},
            {"name": "Complete job", "conclusion": "success"},
        ],
    })
    assert not ran
    assert "runner bookkeeping" in why


def test_negative_control_the_rename_must_be_the_push_run_at_this_sha():
    """BLOCKER 2, built by BOTH reviewers independently.

    The first version asked one question -- did some run of this path at the
    merged sha conclude SUCCESS -- and asserted "published under a different
    name", a cause it never established (R7). `commit-message-parses.yml` also
    carries `schedule:` and `workflow_dispatch:`, and its own header says the
    dispatch shape "goes green having judged no commits at all". So a RED push
    run followed by any green cron produced RECEIPT: GREEN.
    """
    for event in ("schedule", "workflow_dispatch", "check_suite", ""):
        receipt = _receipt([
            _ev("changelog parser can read every commit message",
                workflow_path=".github/workflows/commit-message-parses.yml",
                merged_workflow_run=_push_run(event=event),
                merged_workflow_jobs=(_job("changelog parser can read what landed on main"),)),
        ])
        assert not receipt.ok, event
        assert any("not `push`" in r for r in receipt.reasons), event


def test_negative_control_the_rename_run_must_be_about_the_merged_commit():
    """A run of the right workflow on the WRONG sha is evidence about another
    commit. The collector now filters on `head_sha`, but the decision function
    must refuse it too -- a filter in the producer is not a contract in the
    consumer, which is the CG4-vs-collector gap reviewer 2 walked through."""
    for sha in ("SOMETHING-ELSE", ""):
        receipt = _receipt([
            _ev("changelog parser can read every commit message",
                workflow_path=".github/workflows/commit-message-parses.yml",
                merged_workflow_run=_push_run(sha=sha),
                merged_workflow_jobs=(_job("sibling"),)),
        ])
        assert not receipt.ok, sha
        assert any("not the merged sha" in r for r in receipt.reasons), sha


def test_negative_control_an_empty_job_list_is_not_evidence_of_a_rename():
    """Reviewer 2 fed the real function an empty job list and got GREEN.

    With no job list there is nothing distinguishing a RENAME from a job that
    simply did not run.
    """
    receipt = _receipt([
        _ev("changelog parser can read every commit message",
            workflow_path=".github/workflows/commit-message-parses.yml",
            merged_workflow_run=_push_run(),
            merged_workflow_jobs=()),
    ])
    assert not receipt.ok
    assert any("no jobs could be read" in r for r in receipt.reasons)


def test_negative_control_a_run_that_does_carry_the_context_is_not_a_rename():
    """If the required context's own job name is present in that run, the
    context is absent for some OTHER reason. Calling that a rename asserts a
    cause the evidence contradicts."""
    receipt = _receipt([
        _ev("Secret Scan",
            workflow_path=".github/workflows/validate.yml",
            merged_workflow_run=_push_run(),
            merged_workflow_jobs=(_job("Secret Scan"), _job("other"))),
    ])
    assert not receipt.ok
    assert any("is not a rename" in r for r in receipt.reasons)


def test_negative_control_a_rename_whose_sibling_jobs_all_ran_nothing():
    """The sibling that stands in must itself have EXECUTED something.

    Otherwise the rename case becomes the hollow-green hole again, one level
    along -- which is precisely the shape of defect that produced blocker 1.
    """
    receipt = _receipt([
        _ev("changelog parser can read every commit message",
            workflow_path=".github/workflows/commit-message-parses.yml",
            merged_workflow_run=_push_run(),
            merged_workflow_jobs=(_hollow_job("changelog parser can read what landed on main"),)),
    ])
    assert not receipt.ok
    assert any("executed anything" in r for r in receipt.reasons)


def test_negative_control_a_rename_whose_sibling_job_failed():
    receipt = _receipt([
        _ev("changelog parser can read every commit message",
            workflow_path=".github/workflows/commit-message-parses.yml",
            merged_workflow_run=_push_run(),
            merged_workflow_jobs=(_job("sibling", conclusion="failure"),)),
    ])
    assert not receipt.ok
    assert any("executed anything" in r for r in receipt.reasons)


def test_the_rename_message_names_the_sibling_it_actually_observed():
    """R7: the receipt may not assert a cause it did not establish. The old
    message said "published under a different name by X" from a run conclusion
    alone; this one quotes the job it actually found and what that job did."""
    receipt = _receipt([
        _ev("changelog parser can read every commit message",
            workflow_path=".github/workflows/commit-message-parses.yml",
            merged_workflow_run=_push_run(),
            merged_workflow_jobs=(_job("changelog parser can read what landed on main",
                                       steps=("scan the range",)),)),
    ])
    assert receipt.ok, receipt.reasons
    detail = receipt.by_state("renamed-at-merge")[0].detail
    assert "'changelog parser can read what landed on main'" in detail
    assert "executed 1 of 1 work step(s)" in detail
    assert "on `push` at the merged sha" in detail


# ---------------------------------------------------------------------------
# `select_merged_run` -- extracted from the collector so it can be tested
# ---------------------------------------------------------------------------


def _run(path, sha, event, started):
    return {"path": path, "head_sha": sha, "event": event, "run_started_at": started}


def test_select_merged_run_takes_the_push_run_at_this_sha():
    runs = [
        _run(".github/workflows/a.yml", MERGED_SHA, "push", "2026-09-12T10:00:00Z"),
        _run(".github/workflows/a.yml", MERGED_SHA, "push", "2026-09-12T11:00:00Z"),
    ]
    # Newest among GENUINE candidates, so a re-run supersedes the original.
    got = gates.select_merged_run(runs, ".github/workflows/a.yml", MERGED_SHA)
    assert got["run_started_at"] == "2026-09-12T11:00:00Z"


def test_negative_control_a_cron_cannot_supply_the_rename_evidence():
    """Reviewer 2's attack on the collector, now a test of the extracted
    function. Measured: 73 workflow runs at `a02cd41e6d42`, 10 paths carrying
    more than one, across `push`/`schedule`/`check_suite`/`issues`. The old
    inline code took the NEWEST run for a path regardless of event, so a
    later green cron outranked the push run that actually mattered."""
    runs = [
        _run(".github/workflows/a.yml", MERGED_SHA, "push", "2026-09-12T10:00:00Z"),
        _run(".github/workflows/a.yml", MERGED_SHA, "schedule", "2026-09-12T23:00:00Z"),
        _run(".github/workflows/a.yml", MERGED_SHA, "workflow_dispatch", "2026-09-13T01:00:00Z"),
    ]
    got = gates.select_merged_run(runs, ".github/workflows/a.yml", MERGED_SHA)
    assert got["event"] == "push"
    assert got["run_started_at"] == "2026-09-12T10:00:00Z"


def test_negative_control_select_merged_run_refuses_another_sha_or_path():
    runs = [
        _run(".github/workflows/a.yml", "OTHER", "push", "2026-09-12T10:00:00Z"),
        _run(".github/workflows/b.yml", MERGED_SHA, "push", "2026-09-12T10:00:00Z"),
    ]
    assert gates.select_merged_run(runs, ".github/workflows/a.yml", MERGED_SHA) is None
    assert gates.select_merged_run([], ".github/workflows/a.yml", MERGED_SHA) is None


# ---------------------------------------------------------------------------
# The glob refuses what it cannot represent
# ---------------------------------------------------------------------------


def test_negative_control_an_unrepresentable_pattern_is_refused_not_guessed():
    """Reviewer 1, question 2. `!`, `[0-9]`, `+` and `?`-extglob all
    UNDER-match when translated as literals, and under-matching a positive
    `paths:` list is the EXCUSING direction -- the filter looks like it
    admitted nothing, so the absence gets excused. `!` under `paths-ignore:`
    re-includes a path, which is worse.

    Zero workflows in this repo use any of them today, which is exactly why
    refusing is free.
    """
    for pattern in ("!docs/**", "src/[0-9].py", "a+(b).py", "@(x|y).md"):
        try:
            gates.glob_matches(pattern, "anything")
        except gates.UnsupportedPatternError:
            pass
        else:  # pragma: no cover - the assertion is the point
            raise AssertionError(f"{pattern!r} should have been refused")


def test_an_unrepresentable_pattern_makes_the_trigger_answer_it_runs():
    """...and "it runs" is what the receipt turns into a FAILURE. The
    fail-closed direction: an unanswerable filter never excuses an absence."""
    trigger = gates.parse_push_trigger(
        "on:\n  push:\n    paths: ['!docs/**']\njobs: {}\n"
    )
    runs, why = gates.push_event_runs(trigger, "main", ["src/x.py"])
    assert runs
    assert "cannot represent faithfully" in why
    # ...and end to end, that is a refused receipt rather than an excused one.
    receipt = _receipt([
        _ev("Secret Scan",
            workflow_path=".github/workflows/validate.yml",
            head_check=_green("Secret Scan"),
            head_job=_job("Secret Scan"),
            push_trigger=trigger),
    ])
    assert not receipt.ok
    assert any("SHOULD have run" in r for r in receipt.reasons)


def test_the_real_repo_uses_no_unrepresentable_pattern_today():
    """The materiality claim above, asserted rather than asserted-about.

    If someone adds a `!` or a character range to a workflow filter, this goes
    red and tells them the translator has to learn it -- instead of the
    receipt silently under-matching.
    """
    import pathlib

    wf = pathlib.Path(__file__).resolve().parents[3] / ".github" / "workflows"
    if not wf.is_dir():  # a worktree without .github
        return
    offenders = []
    for path in sorted(wf.glob("*.yml")):
        trigger = gates.parse_push_trigger(path.read_text(encoding="utf-8"))
        if trigger is None:
            continue
        for group in (trigger.branches, trigger.branches_ignore,
                      trigger.paths, trigger.paths_ignore):
            for pattern in group or ():
                if gates._UNSUPPORTED_GLOB.search(pattern):
                    offenders.append(f"{path.name}: {pattern}")
    assert offenders == [], offenders


# ---------------------------------------------------------------------------
# The policy contract, re-attacked with reviewer 2's own probe
# ---------------------------------------------------------------------------


def test_negative_control_an_unread_sub_key_under_receipts_is_now_caught():
    """Reviewer 2 planted `receipts.totally_unread_rule`, and
    `assert_policy_matches_code()` passed -- because a dict-valued top-level
    key declared in `OTHER_IMPLEMENTED_BY` short-circuited before the sub-key
    walk. So "a key with no implementation" was STRUCTURALLY UNREACHABLE for
    exactly the section this change had just added a key to: the hole reported
    as closed by the change that widened it.
    """
    import copy

    import pytest

    planted = copy.deepcopy(POLICY)
    planted["receipts"]["totally_unread_rule"] = "nothing reads this"
    missing = gates.policy_keys_without_implementation(planted)
    assert "receipts.totally_unread_rule" in missing
    with pytest.raises(ValueError, match="totally_unread_rule"):
        gates.assert_policy_matches_code(planted)
