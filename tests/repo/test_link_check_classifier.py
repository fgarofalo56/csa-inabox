"""Link Check must never report a timeout as an ambiguous non-result (#4425).

`.github/workflows/link-check.yml` swept the whole `docs/**` corpus on every
docs PR — 2520 files carrying 4650 unique external URLs — against a
``timeout-minutes: 10`` budget. It did not fit: measured on PR #4369, three
consecutive attempts ran 10m15s and were killed mid-flight.

The worse half was the *conclusion*. A GitHub JOB timeout surfaces as
``cancelled``, which is indistinguishable from "superseded by a newer push".
Our merge preflight read that as an advisory RED and blocked the merge — on
evidence that does not exist, because the check was killed BEFORE emitting any
verdict. A run that established nothing must never read as a run that found
nothing (R7). Every docs PR was blocked behind that ambiguity.

The workflow now classifies its own outcome and writes a marker. This module
drives the SHIPPED classifier — extracted from the workflow file, never a copy,
because a copy drifts from what actually runs.

What is asserted
----------------
1. ``test_branch_produces_expected_status`` — the real guard. Every input shape
   the job can produce resolves to a named status with the right exit code.
2. ``test_timeout_and_supersede_are_distinguished`` — the #4425 defect itself.
   The SAME ``cancelled`` outcome must resolve to TIMEOUT at the budget and to
   CANCELLED well inside it. If these ever collapse to one answer, the
   ambiguity is back.
3. ``test_a_broken_classifier_is_caught`` — ANTI-VACUITY / SILENCE. A guard that
   cannot go red on its own target is this repo's most-repeated defect, so the
   harness is run against a deliberately mutated classifier and must fail it.
4. ``test_extracted_script_is_not_trivial`` — ANTI-VACUITY. If extraction ever
   returns nothing, every case above would pass trivially.
5. ``test_fail_if_empty_is_disabled`` — CONTROL on a precondition. ``SETUP_FAILED``
   only means "the checker could not run" because ``failIfEmpty`` is off; with
   the action's default of true, a docs file carrying no links exits 1 and would
   be misread as a setup failure.
6. ``test_pull_requests_are_scoped_to_changed_files`` — the runtime fix. Without
   this the timeout returns as the corpus grows.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import time
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "link-check.yml"

# Plain "bash" resolves to WSL bash under Windows Python, which cannot run a
# Windows-path script and returns 127 for every case.
_BASH_CANDIDATES = (
    r"C:\Program Files\Git\bin\bash.exe",
    r"C:\Program Files\Git\usr\bin\bash.exe",
)


def _bash() -> str:
    for candidate in _BASH_CANDIDATES:
        if os.path.exists(candidate):
            return candidate
    return "bash"


def _workflow() -> dict:
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def _step(step_id: str) -> dict:
    steps = _workflow()["jobs"]["check"]["steps"]
    matches = [s for s in steps if s.get("id") == step_id]
    assert matches, f"no step with id {step_id!r} in {WORKFLOW.name}"
    return matches[0]


def _run_classifier(script: str, age_seconds: int = 3, **overrides) -> tuple[str, int, str]:
    """Run a classifier script and return (status, returncode, job summary)."""
    env = dict(os.environ)
    env.update(
        {
            "SCOPE": "changed",
            "COUNT": "12",
            "REASON": "test",
            "STARTED_AT": str(int(time.time()) - age_seconds),
            "LYCHEE_OUTCOME": "success",
            "LYCHEE_EXIT": "0",
            "GITHUB_SERVER_URL": "https://github.com",
            "GITHUB_REPOSITORY": "o/r",
            "GITHUB_RUN_ID": "1",
        }
    )
    env.update({k: str(v) for k, v in overrides.items()})

    with tempfile.TemporaryDirectory() as td:
        env["GITHUB_OUTPUT"] = os.path.join(td, "out")
        env["GITHUB_STEP_SUMMARY"] = os.path.join(td, "summary")
        Path(env["GITHUB_OUTPUT"]).touch()
        Path(env["GITHUB_STEP_SUMMARY"]).touch()
        script_path = Path(td) / "classify.sh"
        script_path.write_text(script, encoding="utf-8")

        # Run in a sandbox, not the repo: the classifier writes `lychee/` and
        # re-reads the workflow for its budget, so give it a workflow to read
        # rather than letting a test dirty the working tree.
        staged = Path(td) / ".github" / "workflows"
        staged.mkdir(parents=True, exist_ok=True)
        (staged / "link-check.yml").write_text(
            WORKFLOW.read_text(encoding="utf-8"), encoding="utf-8"
        )

        proc = subprocess.run(
            [_bash(), str(script_path)],
            cwd=td,
            env=env,
            capture_output=True,
            text=True,
        )
        status = ""
        for line in Path(env["GITHUB_OUTPUT"]).read_text(encoding="utf-8").splitlines():
            if line.startswith("status="):
                status = line.split("=", 1)[1]
        summary = Path(env["GITHUB_STEP_SUMMARY"]).read_text(encoding="utf-8")

    return status, proc.returncode, summary


# The job's real budget, so the timeout case is pinned to what actually ships.
_BUDGET_SECONDS = int(_workflow()["jobs"]["check"]["timeout-minutes"]) * 60

# (case, env overrides, age, expected status, expected rc)
# rc 1 is reserved for "the checker could not look" — those must fail closed.
# A dead link is advisory and must NOT fail.
BRANCHES = [
    ("no docs in scope", {"COUNT": "0"}, 3, "NO_DOCS_IN_SCOPE", 0),
    ("clean run", {"LYCHEE_OUTCOME": "success", "LYCHEE_EXIT": "0"}, 3, "OK", 0),
    ("dead links", {"LYCHEE_OUTCOME": "success", "LYCHEE_EXIT": "2"}, 3, "DEAD_LINKS", 0),
    ("lychee errored", {"LYCHEE_OUTCOME": "success", "LYCHEE_EXIT": "1"}, 3, "CHECKER_ERROR", 1),
    ("setup failed", {"LYCHEE_OUTCOME": "failure"}, 3, "SETUP_FAILED", 1),
    ("superseded", {"LYCHEE_OUTCOME": "cancelled"}, 5, "CANCELLED", 0),
    ("timed out", {"LYCHEE_OUTCOME": "cancelled"}, _BUDGET_SECONDS - 1, "TIMEOUT", 0),
    ("step never ran", {"LYCHEE_OUTCOME": ""}, _BUDGET_SECONDS - 1, "TIMEOUT", 0),
    ("unrecognised", {"LYCHEE_OUTCOME": "skipped"}, 3, "UNKNOWN", 1),
]


@pytest.mark.parametrize(
    "case,overrides,age,expected_status,expected_rc",
    BRANCHES,
    ids=[b[0].replace(" ", "-") for b in BRANCHES],
)
def test_branch_produces_expected_status(
    case: str, overrides: dict, age: int, expected_status: str, expected_rc: int
) -> None:
    script = _step("classify")["run"]
    status, rc, summary = _run_classifier(script, age_seconds=age, **overrides)

    assert status == expected_status, f"{case}: got {status!r}"
    assert rc == expected_rc, f"{case}: exit {rc}, expected {expected_rc}"
    # The marker has to reach the operator on EVERY path, the failing ones most
    # of all — that is the half of #4425 that made the timeout unreadable.
    assert expected_status in summary, f"{case}: status missing from job summary"


def test_timeout_and_supersede_are_distinguished() -> None:
    """The #4425 defect: one `cancelled` outcome, two different truths."""
    script = _step("classify")["run"]

    timed_out, _, _ = _run_classifier(
        script, age_seconds=_BUDGET_SECONDS - 1, LYCHEE_OUTCOME="cancelled"
    )
    superseded, _, _ = _run_classifier(script, age_seconds=5, LYCHEE_OUTCOME="cancelled")

    assert timed_out == "TIMEOUT"
    assert superseded == "CANCELLED"
    assert timed_out != superseded, (
        "a timeout and a supersede both surface as `cancelled`; collapsing them "
        "is exactly the ambiguity #4425 exists to remove"
    )


def test_a_broken_classifier_is_caught() -> None:
    """SILENCE check: the harness must be able to go RED on its own target.

    Mutate the shipped classifier so its dead-link branch matches the wrong exit
    code, and confirm the observation changes. A harness that reports the same
    answer for a broken classifier is measuring nothing.
    """
    script = _step("classify")["run"]
    healthy, _, _ = _run_classifier(script, LYCHEE_OUTCOME="success", LYCHEE_EXIT="2")
    assert healthy == "DEAD_LINKS", "precondition: the unmutated classifier is correct"

    mutated = script.replace('2) STATUS="DEAD_LINKS"', '9) STATUS="DEAD_LINKS"')
    assert mutated != script, "the mutation did not apply — the branch was not found"

    broken, broken_rc, _ = _run_classifier(mutated, LYCHEE_OUTCOME="success", LYCHEE_EXIT="2")
    assert broken != "DEAD_LINKS", "the mutated classifier still reported DEAD_LINKS"
    assert (broken, broken_rc) == ("CHECKER_ERROR", 1)


def test_extracted_script_is_not_trivial() -> None:
    """ANTI-VACUITY: empty extraction would make every case above pass."""
    script = _step("classify")["run"]
    assert len(script.splitlines()) > 20
    for token in ("TIMEOUT", "CANCELLED", "SETUP_FAILED", "DEAD_LINKS", "GITHUB_STEP_SUMMARY"):
        assert token in script, f"{token} absent from the shipped classifier"


def test_fail_if_empty_is_disabled() -> None:
    """CONTROL on the precondition that gives SETUP_FAILED its meaning.

    With the action's default (`failIfEmpty: true`) a docs file carrying no links
    exits 1, and the classifier would read that as a setup failure and fail the
    workflow closed on a perfectly valid PR.
    """
    lychee = _step("lychee")["with"]
    assert lychee["failIfEmpty"] is False
    assert lychee["fail"] is False, "a dead link must stay advisory"


def test_pull_requests_are_scoped_to_changed_files() -> None:
    """The runtime fix: PR cost tracks the diff, not the corpus."""
    scope = _step("scope")["run"]
    assert "pull_request" in scope
    assert "--diff-filter" in scope
    # A deletion or rename can break inbound links from files the PR never
    # touched, so those PRs must widen back to the full sweep.
    assert "--diff-filter=DR" in scope, "deleted/renamed docs must force a full sweep"
    assert _step("lychee").get("if"), "the check must be skippable when nothing is in scope"
