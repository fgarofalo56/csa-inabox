"""Link Check must never report a timeout as an ambiguous non-result (#4425).

`.github/workflows/link-check.yml` swept `docs/**` on every docs PR against a
``timeout-minutes: 10`` budget. Measured on #4369 (branch ``drain/h-docs-4``),
all 7 Link Check runs, job durations from the jobs API: 605s, 616s, 110s, 116s,
616s, 194s, 615s — 4 killed at the budget, 3 finishing under 3m15s. The sweep
was therefore INTERMITTENTLY over budget, not structurally over it; what the
corpus sweep did was make a run capable of exceeding the budget at all, and
whether it did depended on how many external hosts were slow that day.

The worse half was the *conclusion*. A GitHub JOB timeout surfaces as
``cancelled``, which is indistinguishable from "superseded by a newer push".
Our merge preflight read that as an advisory RED and blocked the merge — on
evidence that does not exist, because the check was killed BEFORE emitting any
verdict. A run that established nothing must never read as a run that found
nothing (R7). Every docs PR was blocked behind that ambiguity.

The workflow now scopes PR runs to the diff and classifies its own outcome.
This module drives BOTH shipped shell steps — extracted from the workflow file,
never a copy, because a copy drifts from what actually runs.

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
6. ``test_scope_*`` — the runtime fix, driven BEHAVIOURALLY against throwaway
   git repositories rather than asserted by substring. Substring assertions on
   this step were measured to be vacuous: deleting the PR narrowing outright,
   neutering the argv guard, and raising the 300-file budget to 999999 all left
   a green suite, because the literal strings they matched survived elsewhere in
   the step. Each ``test_scope_*`` case below runs the shipped script and reads
   its real ``$GITHUB_OUTPUT``.
7. ``test_scope_never_narrows_silently`` — the invariant the step's own comment
   states. Every exit from the narrowing path must widen to the full sweep; a
   path that is neither checked nor reported is the R7 shape this file exists
   to remove, and two of them shipped in the first draft (a rename OUT of
   ``docs/``, and a non-ASCII filename dropped by ``core.quotepath``).
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

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


def _workflow() -> dict[str, Any]:
    loaded = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    assert isinstance(loaded, dict), f"{WORKFLOW.name} did not parse as a mapping"
    return loaded


def _step(step_id: str) -> dict[str, Any]:
    steps: list[dict[str, Any]] = _workflow()["jobs"]["check"]["steps"]
    matches = [s for s in steps if s.get("id") == step_id]
    assert matches, f"no step with id {step_id!r} in {WORKFLOW.name}"
    return matches[0]


def _run_classifier(
    script: str, age_seconds: int = 3, lychee_out: str | None = None, **overrides: str
) -> tuple[str, int, str]:
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

        if lychee_out is not None:
            out_dir = Path(td) / "lychee"
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / "out.md").write_text(lychee_out, encoding="utf-8")

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
    # A failed `Select scope` leaves COUNT empty. Defaulting that to "0" would
    # print "nothing was checked, and nothing needed to be" over a run that
    # never established what it needed to check — the R7 shape this file exists
    # to remove, in the file that removes it.
    ("scope step failed", {"COUNT": ""}, 3, "SCOPE_FAILED", 1),
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
    case: str, overrides: dict[str, str], age: int, expected_status: str, expected_rc: int
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
    """The runtime fix: PR cost tracks the diff, not the corpus.

    Structural only. This asserts the wiring exists; ``test_scope_*`` below
    proves it BEHAVES, which substring checks here were measured not to do.
    """
    scope = _step("scope")["run"]
    assert "pull_request" in scope
    assert "--diff-filter" in scope
    # A deletion or rename can break inbound links from files the PR never
    # touched, so those PRs must widen back to the full sweep.
    assert "--diff-filter=DR" in scope, "deleted/renamed docs must force a full sweep"
    assert _step("lychee").get("if"), "the check must be skippable when nothing is in scope"


# ---------------------------------------------------------------------------
# Behavioural coverage for the `scope` step.
#
# The step is a shell script, so it is driven as one: a throwaway git repo per
# case, the SHIPPED script, and its real $GITHUB_OUTPUT read back. Substring
# assertions were measured to be vacuous here — deleting the PR narrowing
# outright left the suite green because the literal token it matched survived in
# the fallback REASON text.
# ---------------------------------------------------------------------------


def _git(repo: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, check=True
    )
    return proc.stdout.strip()


def _init_repo(repo: Path) -> None:
    repo.mkdir(parents=True, exist_ok=True)
    _git(repo, "init", "-q", "-b", "main", ".")
    _git(repo, "config", "user.email", "harness@example.invalid")
    _git(repo, "config", "user.name", "harness")
    # Keep line endings out of it; these fixtures only ever read --name-only.
    _git(repo, "config", "core.autocrlf", "false")


def _write(repo: Path, rel: str, text: str = "no links here\n") -> None:
    target = repo / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")


def _commit(repo: Path, message: str) -> str:
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", message)
    return _git(repo, "rev-parse", "HEAD")


def _base_repo(repo: Path) -> str:
    """A repo with a few docs already committed. Returns the base sha."""
    _init_repo(repo)
    _write(repo, "docs/top.md")
    _write(repo, "docs/guide/deep.md")
    _write(repo, "docs/guide/other.md")
    _write(repo, "src/app.py", "x = 1\n")
    return _commit(repo, "base")


def _run_scope(
    repo: Path,
    *,
    base_sha: str,
    event: str = "pull_request",
    script: str | None = None,
) -> dict[str, str]:
    """Run the shipped `scope` step in `repo` and return its $GITHUB_OUTPUT."""
    step_script = _step("scope")["run"] if script is None else script
    env = dict(os.environ)
    env.update({"EVENT": event, "BASE_SHA": base_sha})

    with tempfile.TemporaryDirectory() as td:
        out_path = Path(td) / "out"
        out_path.touch()
        env["GITHUB_OUTPUT"] = str(out_path)
        script_path = Path(td) / "scope.sh"
        script_path.write_text(step_script, encoding="utf-8")

        proc = subprocess.run(
            [_bash(), str(script_path)],
            cwd=repo,
            env=env,
            capture_output=True,
            text=True,
        )
        outputs: dict[str, str] = {}
        for line in out_path.read_text(encoding="utf-8").splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                outputs[key] = value

    outputs["_rc"] = str(proc.returncode)
    outputs["_stderr"] = proc.stderr
    return outputs


def test_scope_narrows_to_changed_docs(tmp_path: Path) -> None:
    """The fix itself: a PR touching 2 docs checks exactly those 2."""
    repo = tmp_path / "r"
    base = _base_repo(repo)
    _write(repo, "docs/top.md", "changed\n")
    _write(repo, "docs/guide/deep.md", "changed\n")
    _commit(repo, "touch two docs")

    out = _run_scope(repo, base_sha=base)
    assert out["scope"] == "changed", out
    assert out["count"] == "2", out
    assert "docs/top.md" in out["targets"]
    assert "docs/guide/deep.md" in out["targets"]
    # The doc it did NOT touch must not be checked — that is the whole point.
    assert "docs/guide/other.md" not in out["targets"]


def test_scope_skips_when_no_docs_changed(tmp_path: Path) -> None:
    """A PR touching no docs checks nothing, and says so with count=0."""
    repo = tmp_path / "r"
    base = _base_repo(repo)
    _write(repo, "src/app.py", "x = 2\n")
    _commit(repo, "code only")

    out = _run_scope(repo, base_sha=base)
    assert out["count"] == "0", out


# (case, mutate, expected fragment of the widen REASON)
# Every one of these is a way OUT of the narrowing path, and every one must land
# on the full sweep. A case that narrows instead is a silent under-check.
WIDEN_CASES = [
    ("deleted-doc", "delete"),
    ("renamed-within-docs", "rename-in"),
    ("renamed-out-of-docs", "rename-out"),
    ("non-ascii-doc", "non-ascii"),
    ("space-in-name", "space"),
    ("dollar-in-name", "dollar"),
    ("backtick-in-name", "backtick"),
    ("over-argv-budget", "many"),
]


@pytest.mark.parametrize(("case", "kind"), WIDEN_CASES, ids=[c[0] for c in WIDEN_CASES])
def test_scope_never_narrows_silently(case: str, kind: str, tmp_path: Path) -> None:
    """Every exit from the narrowing path widens to the full sweep.

    The step's own comment states this as an invariant. Two counterexamples
    shipped in the first draft of #4426 and are pinned here:

    * ``rename-out`` — ``--name-only`` prints only a rename's POST-image, so
      moving a doc OUT of ``docs/`` emitted no docs path, the DR widen never
      fired, and the run reported "nothing needed to be checked" over a PR that
      could have broken inbound internal links. Fixed with ``--no-renames``.
    * ``non-ascii`` — ``core.quotepath`` (default true) C-quotes a non-ASCII
      path, so the line began with ``"``, failed the ``^docs/`` test, and was
      DROPPED before any guard saw it. Fixed with ``core.quotepath=false``.
    """
    repo = tmp_path / "r"
    base = _base_repo(repo)

    if kind == "delete":
        (repo / "docs" / "guide" / "other.md").unlink()
    elif kind == "rename-in":
        _git(repo, "mv", "docs/guide/other.md", "docs/guide/renamed.md")
    elif kind == "rename-out":
        _write(repo, "moved/placeholder.txt", "x\n")
        _git(repo, "mv", "docs/guide/other.md", "moved/other.md")
    elif kind == "non-ascii":
        _write(repo, "docs/café.md")
    elif kind == "space":
        _write(repo, "docs/with space.md")
    elif kind == "dollar":
        _write(repo, "docs/with$dollar.md")
    elif kind == "backtick":
        _write(repo, "docs/with`tick.md")
    elif kind == "many":
        for i in range(301):
            _write(repo, f"docs/bulk/f{i}.md")
    else:  # pragma: no cover - guards the table above
        raise AssertionError(f"unhandled fixture kind {kind!r}")

    _commit(repo, case)
    out = _run_scope(repo, base_sha=base)

    assert out["scope"] == "full", (
        f"{case}: narrowed to {out.get('scope')!r} instead of widening. "
        f"reason={out.get('reason')!r} count={out.get('count')!r}"
    )
    # Widening must also be EXPLAINED — a silent widen is how the next person
    # fails to notice the narrowing stopped working.
    assert out["reason"], f"{case}: widened with no reason"


def test_scope_widens_when_base_sha_is_missing_or_bogus(tmp_path: Path) -> None:
    """No base sha, and an absent base sha, both widen rather than guess."""
    repo = tmp_path / "r"
    _base_repo(repo)
    _write(repo, "docs/top.md", "changed\n")
    _commit(repo, "touch")

    missing = _run_scope(repo, base_sha="")
    assert missing["scope"] == "full"
    assert "no base sha" in missing["reason"]

    bogus = _run_scope(repo, base_sha="0" * 40)
    assert bogus["scope"] == "full"
    assert "absent" in bogus["reason"]


def test_scope_is_full_off_the_pull_request_path(tmp_path: Path) -> None:
    """The scheduled sweep is not narrowed by anything."""
    repo = tmp_path / "r"
    base = _base_repo(repo)
    _write(repo, "docs/top.md", "changed\n")
    _commit(repo, "touch")

    out = _run_scope(repo, base_sha=base, event="schedule")
    assert out["scope"] == "full"
    assert out["targets"] == "'docs/**/*.md'"


def test_scope_quoted_path_guard_is_independently_load_bearing(tmp_path: Path) -> None:
    """The two defences against a dropped path are independent, not one fix twice.

    ``core.quotepath=false`` stops git escaping non-ASCII, and a separate guard
    refuses any diff containing a path git still had to C-quote. A path with an
    embedded quote or backslash cannot be committed on Windows at all (git
    rejects it as an invalid path), so the second guard is exercised here by
    removing the FIRST one and re-running the non-ASCII fixture: the line then
    arrives quoted, and the run must still widen instead of dropping it.
    """
    repo = tmp_path / "r"
    base = _base_repo(repo)
    _write(repo, "docs/café.md")
    _commit(repo, "non-ascii doc")

    shipped = _step("scope")["run"]
    without_quotepath = shipped.replace("git -c core.quotepath=false diff", "git diff")
    assert without_quotepath != shipped, "the quotepath flag was not found to remove"

    out = _run_scope(repo, base_sha=base, script=without_quotepath)
    assert out["scope"] == "full", (
        "with quotepath escaping restored the path arrives as \"docs/caf\\303\\251.md\"; "
        f"it must widen, not vanish. got reason={out.get('reason')!r}"
    )
    assert "quote" in out["reason"].lower(), out["reason"]


# (label, mutation applied to the shipped script, fixture kind it must break)
# SILENCE controls. Each mutation reintroduces a real defect; if the suite stays
# green under it, the corresponding test is measuring nothing. All three of
# these survived the substring-only version of this module.
SCOPE_MUTATIONS = [
    (
        "PR narrowing deleted",
        ('if [ "$EVENT" = "pull_request" ]', 'if [ "$EVENT" = "__never__" ]'),
    ),
    (
        "argv-safety guard neutered",
        ("*[!A-Za-z0-9/._-]*)", "*__never_matches__*)"),
    ),
    (
        "argv budget raised past any diff",
        ('if [ "$N" -gt 300 ]', 'if [ "$N" -gt 999999 ]'),
    ),
    (
        "rename detection restored (finding 1a)",
        ("--name-only --no-renames --diff-filter=DR", "--name-only --diff-filter=DR"),
    ),
]


@pytest.mark.parametrize(
    ("label", "mutation"), SCOPE_MUTATIONS, ids=[m[0].replace(" ", "-") for m in SCOPE_MUTATIONS]
)
def test_a_broken_scope_step_is_caught(
    label: str, mutation: tuple[str, str], tmp_path: Path
) -> None:
    """ANTI-VACUITY: the scope harness must be able to go RED on its own target."""
    old, new = mutation
    shipped = _step("scope")["run"]
    assert old in shipped, f"{label}: mutation anchor {old!r} not found in the shipped step"
    mutated = shipped.replace(old, new)
    assert mutated != shipped

    repo = tmp_path / "r"
    base = _base_repo(repo)

    if label.startswith("PR narrowing"):
        _write(repo, "docs/top.md", "changed\n")
        _commit(repo, "touch")
        healthy = _run_scope(repo, base_sha=base)
        broken = _run_scope(repo, base_sha=base, script=mutated)
        assert healthy["scope"] == "changed", "precondition: the shipped step narrows"
        assert broken["scope"] == "full", "precondition: the mutation stops it narrowing"
        assert healthy["scope"] != broken["scope"], label
        return

    if label.startswith("argv-safety"):
        _write(repo, "docs/with space.md")
    elif label.startswith("argv budget"):
        for i in range(301):
            _write(repo, f"docs/bulk/f{i}.md")
    else:  # rename detection restored
        _write(repo, "moved/placeholder.txt", "x\n")
        _git(repo, "mv", "docs/guide/other.md", "moved/other.md")
    _commit(repo, label)

    healthy = _run_scope(repo, base_sha=base)
    broken = _run_scope(repo, base_sha=base, script=mutated)

    assert healthy["scope"] == "full", f"{label}: precondition — the shipped step widens"
    assert broken["scope"] != "full", (
        f"{label}: the mutated step still widened, so this case proves nothing. "
        f"reason={broken.get('reason')!r}"
    )


def test_budget_backstop_has_a_floor() -> None:
    """The budget is read from the workflow, so nothing else guards its VALUE.

    Reading `timeout-minutes` rather than restating it is the right
    single-source-of-truth trade, but it also means dropping the backstop back
    to 10 minutes leaves every other test in this module green. This is the one
    assertion that would notice.
    """
    assert _BUDGET_SECONDS >= 30 * 60, (
        f"the Link Check backstop is {_BUDGET_SECONDS // 60}m; below ~30m the full "
        "sweep can be killed again, which is the #4425 defect"
    )


def test_full_sweep_glob_is_quoted() -> None:
    """A BARE docs/**/*.md silently checks a sixth of the corpus.

    lychee-action ``eval``s its args, and that bash runs with globstar OFF, where
    ``**`` degrades to ``*``. Measured on this tree: bare expands to 421 paths
    (identical to ``docs/*/*.md``) against 2548 tracked docs .md files. Quoting
    hands the literal pattern to lychee, whose glob crate honours ``**``.

    This is a regression guard on a one-character mistake that produces no error
    and no visible symptom — just six sevenths of the docs going unchecked.
    """
    scope = _step("scope")["run"]
    assert "TARGETS=\"'docs/**/*.md'\"" in scope, (
        "the full-sweep pattern must be quoted so lychee globs it, not bash"
    )


def test_detail_reports_lychees_own_total_not_a_predicted_count() -> None:
    """R7: the marker may only cite a number the run actually established.

    The file count handed to lychee is a prediction; on the full sweep it can
    differ from reality several-fold. Only lychee knows what it checked, so the
    detail line must quote lychee's summary and never the predicted count.
    """
    script = _step("classify")["run"]
    summary = "| Status | Count |\n|---|---|\n| Total | 3539 |\n| OK | 3500 |\n"

    status, rc, job_summary = _run_classifier(
        script, lychee_out=summary, COUNT="2520", LYCHEE_OUTCOME="success", LYCHEE_EXIT="0"
    )
    assert (status, rc) == ("OK", 0)
    assert "3539" in job_summary, "the measured total must reach the operator"
    assert "checked 2520" not in job_summary, (
        "the predicted file count must not be asserted as what was checked"
    )

    # And when lychee emitted no summary, the marker says so rather than
    # substituting the prediction.
    status2, _, summary2 = _run_classifier(
        script, lychee_out=None, COUNT="2520", LYCHEE_OUTCOME="success", LYCHEE_EXIT="0"
    )
    assert status2 == "OK"
    assert "unknown" in summary2.lower()
    assert "checked 2520" not in summary2
