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

import json
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


def _run_classifier_full(
    script: str, age_seconds: int = 3, lychee_out: str | None = None, **overrides: str
) -> dict[str, Any]:
    """Run a classifier script and return everything it produced.

    Keys: status, rc, summary, status_json (parsed), status_txt. `status.json`
    is the designated MACHINE surface — a preflight taught to tell a timeout
    from a supersede reads it — so it needs assertions of its own, not just the
    human-readable job summary.
    """
    env = dict(os.environ)
    env.update(
        {
            "SCOPE": "changed",
            "COUNT": "12",
            "REASON": "test",
            "STARTED_AT": str(int(time.time()) - age_seconds),
            "LYCHEE_OUTCOME": "success",
            "LYCHEE_EXIT": "0",
            "OFFLINE": "",
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

        status_json: dict[str, Any] = {}
        json_path = Path(td) / "lychee" / "status.json"
        if json_path.exists():
            status_json = json.loads(json_path.read_text(encoding="utf-8"))
        txt_path = Path(td) / "lychee" / "status.txt"
        status_txt = txt_path.read_text(encoding="utf-8").strip() if txt_path.exists() else ""

    return {
        "status": status,
        "rc": proc.returncode,
        "summary": summary,
        "status_json": status_json,
        "status_txt": status_txt,
    }


def _run_classifier(
    script: str, age_seconds: int = 3, lychee_out: str | None = None, **overrides: str
) -> tuple[str, int, str]:
    """Run a classifier script and return (status, returncode, job summary)."""
    r = _run_classifier_full(script, age_seconds=age_seconds, lychee_out=lychee_out, **overrides)
    return str(r["status"]), int(r["rc"]), str(r["summary"])


# The job's real budget, so the timeout case is pinned to what actually ships.
_BUDGET_SECONDS = int(_workflow()["jobs"]["check"]["timeout-minutes"]) * 60

# The only OBSERVED full-sweep completion. Dispatch run 34402571605 on this
# branch: full online scope over the real 2548-file corpus, cache MISS, `Check
# links` ran 20:42:41Z -> 22:04:39Z. Everything the floor test asserts is
# derived from this one number, so changing the budget cannot quietly outrun it.
_OBSERVED_FULL_SWEEP_SECONDS = 4918

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
    # `success` with NO exit code published. Defaulting that to 0 would print
    # "found no dead links" from a verdict never observed — the same shape as
    # the empty COUNT above, and refused for the same reason.
    ("success but no exit code", {"LYCHEE_OUTCOME": "success", "LYCHEE_EXIT": ""}, 3, "CHECKER_ERROR", 1),
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
    ("case", "overrides", "age", "expected_status", "expected_rc"),
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
    # Pinned, not merely truthy: `if: always()` is also truthy and would run
    # lychee over an empty target list on every skip-worthy PR.
    assert _step("lychee").get("if") == "steps.scope.outputs.count != '0'", (
        "the lychee step's condition must be the count gate, exactly"
    )
    # The --offline decision is made in `scope`; if it is not interpolated into
    # the args it has no effect on anything that runs.
    assert "steps.scope.outputs.offline" in _step("lychee")["with"]["args"], (
        "the offline flag must reach lychee's args or the widen is still online"
    )


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
    # Links at a non-.md asset AND at a target OUTSIDE docs/. Both are real
    # shapes in this repo (551 non-.md files under docs/; 227 link occurrences
    # pointing outside it, 41 of them at README.md), and both were missed by an
    # earlier, narrower widen.
    _write(repo, "docs/guide/other.md", "see ![arch](../img/arch.png) and [readme](../../README.md)\n")
    _write(repo, "docs/img/arch.png", "not really a png\n")
    _write(repo, "docs/_includes/snippet.md", "shared snippet\n")
    _write(repo, "README.md", "root readme\n")
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
    # BLOCKER, round 3: keyed on ^docs/.*\.md$ this did NOT widen. Deleting an
    # asset an unchanged doc links to is exactly the inbound-link breakage the
    # widen exists for; 551 non-.md files live under docs/ and lychee resolves
    # local file: links. It reported "nothing needed to be checked".
    ("deleted-non-md-asset", "delete-asset"),
    # Round-4 review: 227 link occurrences in docs/ point OUTSIDE docs/, 41 of
    # them at README.md. Keyed on ^docs/ the widen missed a deleted OUTBOUND
    # target and reported "nothing needed to be checked".
    ("deleted-outbound-target", "delete-outbound"),
    ("renamed-within-docs", "rename-in"),
    ("renamed-out-of-docs", "rename-out"),
    ("non-ascii-doc", "non-ascii"),
    ("space-in-name", "space"),
    ("dollar-in-name", "dollar"),
    ("backtick-in-name", "backtick"),
    ("over-argv-budget", "many"),
    # The widen the step's comment claimed was covered and was not: a path the
    # diff lists but the checkout does not have.
    ("changed-doc-absent-from-checkout", "absent"),
]


def _apply_widen_fixture(repo: Path, kind: str, label: str) -> None:
    """Build one widen scenario in `repo` and commit it. Shared by both tests."""
    delete_after_commit: str | None = None

    if kind == "delete":
        (repo / "docs" / "guide" / "other.md").unlink()
    elif kind == "delete-asset":
        # docs/guide/other.md links to it, and the PR removes it. Nothing under
        # docs/ that a doc can point at may be deleted without widening.
        (repo / "docs" / "img" / "arch.png").unlink()
    elif kind == "delete-outbound":
        # An OUTBOUND target: docs/guide/other.md links to ../../README.md.
        # The PR deletes it and otherwise touches only an excluded include, so
        # nothing lands in the narrow scope and the widen is the only thing
        # standing between this and a false "nothing needed to be checked".
        (repo / "README.md").unlink()
        _write(repo, "docs/_includes/snippet.md", "touched\n")
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
    elif kind == "absent":
        # Committed, so the diff lists it; then removed from the WORKTREE only,
        # so `[ -f ]` fails. The step must widen, not silently drop the line.
        _write(repo, "docs/ghost.md")
        delete_after_commit = "docs/ghost.md"
    else:  # pragma: no cover - guards the tables above
        raise AssertionError(f"unhandled fixture kind {kind!r}")

    _commit(repo, label)
    if delete_after_commit is not None:
        (repo / delete_after_commit).unlink()


@pytest.mark.parametrize(("case", "kind"), WIDEN_CASES, ids=[c[0] for c in WIDEN_CASES])
def test_scope_never_narrows_silently(case: str, kind: str, tmp_path: Path) -> None:
    """Every exit from the narrowing path widens to the full sweep.

    The step's own comment states this as an invariant. Three counterexamples
    shipped in earlier drafts of #4426 and are pinned here:

    * ``rename-out`` — ``--name-only`` prints only a rename's POST-image, so
      moving a doc OUT of ``docs/`` emitted no docs path, the DR widen never
      fired, and the run reported "nothing needed to be checked" over a PR that
      could have broken inbound internal links. Fixed with ``--no-renames``.
    * ``non-ascii`` — ``core.quotepath`` (default true) C-quotes a non-ASCII
      path, so the line began with ``"``, failed the ``^docs/`` test, and was
      DROPPED before any guard saw it. Fixed with ``core.quotepath=false``.
    * ``delete-non-md-asset`` — the DR widen was keyed on ``^docs/.*\\.md$``, so
      deleting an image an unchanged doc links to did not widen. Fixed by
      keying it on ``^docs/``.
    """
    repo = tmp_path / "r"
    base = _base_repo(repo)
    _apply_widen_fixture(repo, kind, case)
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
    """The scheduled sweep is not narrowed, is not offline, and counts the corpus."""
    repo = tmp_path / "r"
    base = _base_repo(repo)
    _write(repo, "docs/top.md", "changed\n")
    _commit(repo, "touch")

    out = _run_scope(repo, base_sha=base, event="schedule")
    assert out["scope"] == "full"
    assert out["targets"] == "'docs/**/*.md'"
    # Asserting the COUNT is what stops a mutation that forces the full-sweep
    # corpus to 0: `if: steps.scope.outputs.count != '0'` would then skip lychee
    # entirely and the marker would report NO_DOCS_IN_SCOPE over a run that was
    # supposed to sweep everything. Nothing asserted this before.
    assert int(out["count"]) == 4, (
        f"full sweep must count the tracked docs .md corpus, got {out['count']!r}"
    )
    # The weekly sweep is the one that goes to the network.
    assert out["offline"] == "", "the scheduled sweep must NOT be offline"


def test_pr_widen_is_offline_but_the_narrow_path_is_not(tmp_path: Path) -> None:
    """A widen on a PR must be cheap, and must say it only checked local links.

    Every widen exit exists for inbound INTERNAL links, and a deletion cannot
    change whether an external host is up. Running the widen online is what
    would let #4425's timeout back in on the PR path, now over 2548 files
    instead of 421.
    """
    repo = tmp_path / "r"
    base = _base_repo(repo)
    (repo / "docs" / "guide" / "other.md").unlink()
    _commit(repo, "delete a doc")

    widened = _run_scope(repo, base_sha=base)
    assert widened["scope"] == "full"
    assert widened["offline"] == "--offline", (
        "a PR widen must be offline or it re-opens the timeout it just closed"
    )

    # The narrow path still goes to the network: a PR that ADDS an external
    # link is exactly what the check is for.
    repo2 = tmp_path / "r2"
    base2 = _base_repo(repo2)
    _write(repo2, "docs/top.md", "changed\n")
    _commit(repo2, "touch one doc")
    narrowed = _run_scope(repo2, base_sha=base2)
    assert narrowed["scope"] == "changed"
    assert narrowed["offline"] == "", "the narrow PR path must stay online"


def test_excluded_includes_dir_does_not_masquerade_as_a_checked_file(
    tmp_path: Path,
) -> None:
    """docs/_includes is --exclude-path, so it must not count as in-scope.

    Left in scope it produced count=1, ran lychee over a path it was told to
    exclude, and reported "0 link(s) checked, and found no dead links" — a
    clean bill of health for a file nothing looked at.
    """
    repo = tmp_path / "r"
    base = _base_repo(repo)
    _write(repo, "docs/_includes/snippet.md", "changed shared snippet\n")
    _commit(repo, "touch only an excluded include")

    out = _run_scope(repo, base_sha=base)
    assert out["count"] == "0", (
        f"an excluded path must not be counted as in scope, got {out!r}"
    )
    assert "docs/_includes" not in out["targets"]


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


# (label, (old, new), fixture kind the mutation must break)
# SILENCE controls. Each mutation reintroduces a real defect; if the suite stays
# green under it, the corresponding test is measuring nothing. The first three
# survived the substring-only version of this module; `non-md widen` and
# `absent-from-checkout` survived a green suite as recently as round 3.
SCOPE_MUTATIONS = [
    (
        "PR narrowing deleted",
        ('if [ "$EVENT" = "pull_request" ]', 'if [ "$EVENT" = "__never__" ]'),
        "narrow",
    ),
    (
        "argv-safety guard neutered",
        ("*[!A-Za-z0-9/._-]*)", "*__never_matches__*)"),
        "space",
    ),
    (
        "argv budget raised past any diff",
        ('if [ "$N" -gt 300 ]', 'if [ "$N" -gt 999999 ]'),
        "many",
    ),
    (
        "deletion widen re-keyed to docs/*.md (rounds 3+4 blockers)",
        ("elif [ -s gone-all.txt ]; then", "elif grep -qE '^docs/.*[.]md$' gone-all.txt; then"),
        "delete-asset",
    ),
    (
        "deletion widen re-keyed to ^docs/ (round 4 blocker)",
        ("elif [ -s gone-all.txt ]; then", "elif grep -qE '^docs/' gone-all.txt; then"),
        "delete-outbound",
    ),
    (
        "absent-from-checkout widen removed",
        ('WIDEN="changed path \'${f}\' is absent from the checkout"', 'WIDEN=""'),
        "absent",
    ),
]


@pytest.mark.parametrize(
    ("label", "mutation", "kind"),
    SCOPE_MUTATIONS,
    ids=[m[0].replace(" ", "-") for m in SCOPE_MUTATIONS],
)
def test_a_broken_scope_step_is_caught(
    label: str, mutation: tuple[str, str], kind: str, tmp_path: Path
) -> None:
    """ANTI-VACUITY: the scope harness must be able to go RED on its own target."""
    old, new = mutation
    shipped = _step("scope")["run"]
    assert old in shipped, f"{label}: mutation anchor {old!r} not found in the shipped step"
    mutated = shipped.replace(old, new)
    assert mutated != shipped

    repo = tmp_path / "r"
    base = _base_repo(repo)

    if kind == "narrow":
        # The one case whose HEALTHY state is `changed`; the mutation must stop
        # it narrowing at all.
        _write(repo, "docs/top.md", "changed\n")
        _commit(repo, label)
        healthy = _run_scope(repo, base_sha=base)
        broken = _run_scope(repo, base_sha=base, script=mutated)
        assert healthy["scope"] == "changed", "precondition: the shipped step narrows"
        assert broken["scope"] == "full", "precondition: the mutation stops it narrowing"
        assert healthy["scope"] != broken["scope"], label
        return

    _apply_widen_fixture(repo, kind, label)
    healthy = _run_scope(repo, base_sha=base)
    broken = _run_scope(repo, base_sha=base, script=mutated)

    assert healthy["scope"] == "full", f"{label}: precondition — the shipped step widens"
    assert broken["scope"] != "full", (
        f"{label}: the mutated step still widened, so this case proves nothing. "
        f"reason={broken.get('reason')!r}"
    )


def test_a_widen_that_goes_online_is_caught(tmp_path: Path) -> None:
    """SILENCE control on the --offline widen.

    Removing it leaves every widen exit running the full 2548-file sweep on a
    PR, which is #4425 with a bigger corpus. Nothing else in this module would
    notice, because the scope/reason/count outputs are all unchanged.
    """
    repo = tmp_path / "r"
    base = _base_repo(repo)
    _apply_widen_fixture(repo, "delete", "delete a doc")

    shipped = _step("scope")["run"]
    mutated = shipped.replace('OFFLINE="--offline"', 'OFFLINE=""')
    assert mutated != shipped, "the OFFLINE assignment was not found to remove"

    healthy = _run_scope(repo, base_sha=base)
    broken = _run_scope(repo, base_sha=base, script=mutated)
    assert healthy["offline"] == "--offline", "precondition: the shipped widen is offline"
    assert broken["offline"] != "--offline", (
        "the mutated step still reported offline, so this control proves nothing"
    )


def test_scope_widens_when_the_diff_itself_fails(tmp_path: Path) -> None:
    """The failed-diff exit — enumerated in the step's comment, never driven.

    An unrelated-history base has no merge base, so `git diff base...HEAD`
    exits 128. The step must widen on that. Neutering the DIFF_RC/GONE_RC test
    flips this case to `changed count=0` — "Nothing was checked, and nothing
    needed to be" — over a PR whose diff could not be computed at all.
    """
    repo = tmp_path / "r"
    _base_repo(repo)
    _write(repo, "docs/top.md", "changed\n")
    _commit(repo, "touch")

    # An orphan commit shares no ancestry with HEAD, so `base...HEAD` has no
    # merge base and git fails rather than producing an empty diff.
    _git(repo, "checkout", "-q", "--orphan", "unrelated")
    _git(repo, "rm", "-rq", "--cached", ".")
    _write(repo, "unrelated.txt", "x\n")
    orphan = _commit(repo, "orphan root")
    _git(repo, "checkout", "-q", "main")

    out = _run_scope(repo, base_sha=orphan)
    assert out["scope"] == "full", (
        f"a diff that could not be computed must widen, got {out!r}"
    )
    assert out["reason"], "widened with no reason"

    # SILENCE control: without the rc test this narrows and reports success.
    shipped = _step("scope")["run"]
    mutated = shipped.replace(
        'if [ "$DIFF_RC" -ne 0 ] || [ "$GONE_RC" -ne 0 ]; then',
        'if [ "$DIFF_RC" -eq 999 ]; then',
    )
    assert mutated != shipped, "the rc-test anchor was not found"
    broken = _run_scope(repo, base_sha=orphan, script=mutated)
    assert broken["scope"] != "full", (
        "the mutated step still widened, so this case proves nothing. "
        f"reason={broken.get('reason')!r}"
    )


def test_budget_backstop_has_a_floor() -> None:
    """The budget is read from the workflow, so nothing else guards its VALUE.

    Reading `timeout-minutes` rather than restating it is the right
    single-source-of-truth trade, but it also means dropping the backstop back
    to 10 minutes leaves every other test in this module green. This is the one
    assertion that would notice.

    The floor is MEASURED, not chosen, and it now rests on a COMPLETION rather
    than on a kill. Dispatch run 34393875137 was still going when the then-45m
    backstop killed it at 2699s with no verdict emitted, which established only
    a lower bound. Run 34402571605 then finished the same full online sweep over
    the same 2548-file corpus, on a cache MISS, in 4918s. So the sweep's cost is
    known, and any budget at or below it is not a backstop at all — it is a
    guaranteed TIMEOUT marker every Monday, i.e. a scheduled control that can
    never pass.

    The floor carries a deliberate 1.5x margin over that observation, because
    4918s is n=1 and the corpus is mostly external hosts whose latency is the
    day's luck. The margin is a hedge on the variance, not a claim that the
    sweep ever takes that long.
    """
    floor = (_OBSERVED_FULL_SWEEP_SECONDS * 3) // 2
    assert _BUDGET_SECONDS >= floor, (
        f"the Link Check backstop is {_BUDGET_SECONDS}s; the full online sweep "
        f"was MEASURED at {_OBSERVED_FULL_SWEEP_SECONDS}s on a cache miss (run "
        f"34402571605), so the floor is {floor}s — 1.5x that single observation. "
        "Below it the weekly cron risks emitting only TIMEOUT. Seconds, not "
        "minutes, because the floor is not a whole number of minutes"
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
    # The predicted file count must never be presented as a link count. The
    # first version of this assertion looked for "checked 2520", which the
    # classifier never emits in that word order — so it passed no matter what
    # the code did. Swapping ${MEASURED} for ${COUNT} left the suite green.
    # Assert on the SHAPE the classifier actually produces.
    assert "2520 link(s)" not in job_summary, (
        "the predicted file count was reported as a link count"
    )
    assert "reports 3539 link(s) checked" in job_summary or "3539" in job_summary

    # And when lychee emitted no summary, the marker says so rather than
    # substituting the prediction.
    status2, _, summary2 = _run_classifier(
        script, lychee_out=None, COUNT="2520", LYCHEE_OUTCOME="success", LYCHEE_EXIT="0"
    )
    assert status2 == "OK"
    assert "unknown" in summary2.lower()
    assert "2520 link(s)" not in summary2


def _lychee_summary(total: int, successful: int, excluded: int = 0, errors: int = 0) -> str:
    """A summary in the shape lychee 0.24.2 ACTUALLY emits.

    This matters more than it looks. The first version of these fixtures used a
    tidy ``| Excluded | 4 |``, a shape lychee never produces — the real rows are
    emoji-prefixed and column-padded. Against those fixtures a broken parser
    stayed green: changing the shipped ``Excluded[^0-9]*[0-9]+`` to
    ``Excluded . [0-9]+`` matched the fixture and NOT real output, so the suite
    passed while the marker went back to reporting excluded links as checked.
    A fixture the real tool cannot produce tests nothing.
    """
    rows = [
        "| Status          | Count |",
        "|-----------------|-------|",
        f"| \U0001f50d Total        | {total:>5} |",
        f"| ✅ Successful   | {successful:>5} |",
        "| ⏳ Timeouts     |     0 |",
        "| \U0001f500 Redirected   |     0 |",
        f"| \U0001f47b Excluded     | {excluded:>5} |",
        "| ❓ Unknown      |     0 |",
        f"| \U0001f6ab Errors       | {errors:>5} |",
    ]
    return "\n".join(rows) + "\n"


def test_excluded_links_are_not_counted_as_checked() -> None:
    """R7: lychee's Total INCLUDES links it never contacted.

    Everything the --exclude / --exclude-path list matched is counted in
    `Total`, and on an --offline run so is every external URL. Reporting Total
    as "checked" credits the run with work it did not do.

    Measured before the fix: a file whose links are all excluded gives
    ``Total 4 / Excluded 4`` and the classifier printed
    *"lychee reports 4 link(s) checked, and found no dead links"* — over a run
    that checked zero. On the offline widen it is structural, not a corner
    case: against the real corpus, 18197 Total / 6291 Excluded reported as
    18197 checked when 11906 were.
    """
    script = _step("classify")["run"]
    r = _run_classifier_full(
        script,
        lychee_out=_lychee_summary(total=4, successful=0, excluded=4),
        LYCHEE_OUTCOME="success",
        LYCHEE_EXIT="0",
    )
    assert r["status"] == "OK"
    assert "4 link occurrence(s) checked" not in r["summary"], (
        "excluded links were reported as checked — the run contacted nothing"
    )
    assert r["status_json"]["links_checked"] == "0"
    assert r["status_json"]["links_excluded"] == "4"
    assert r["status_json"]["links_found"] == "4"

    # The real-corpus numbers, verified against a real run: 18197 - 6291 =
    # 11906 = Successful 11833 + Errors 73.
    r2 = _run_classifier_full(
        script,
        lychee_out=_lychee_summary(total=18197, successful=11833, excluded=6291, errors=73),
        LYCHEE_OUTCOME="success",
        LYCHEE_EXIT="0",
    )
    assert r2["status_json"]["links_checked"] == "11906"
    assert "11906" in r2["summary"]

    # No exclusions -> Total is the honest count, unchanged behaviour.
    r3 = _run_classifier_full(
        script,
        lychee_out=_lychee_summary(total=12, successful=12),
        LYCHEE_OUTCOME="success",
        LYCHEE_EXIT="0",
    )
    assert r3["status_json"]["links_checked"] == "12"

    # Absent Excluded row entirely (older/degraded output): fall back to Total
    # rather than crashing or inventing a number.
    minimal = "| Status | Count |\n|---|---|\n| Total | 9 |\n"
    r4 = _run_classifier_full(
        script, lychee_out=minimal, LYCHEE_OUTCOME="success", LYCHEE_EXIT="0"
    )
    assert r4["status_json"]["links_checked"] == "9"

    # Malformed: Excluded > Total must never print a negative count.
    r5 = _run_classifier_full(
        script,
        lychee_out=_lychee_summary(total=3, successful=0, excluded=9),
        LYCHEE_OUTCOME="success",
        LYCHEE_EXIT="0",
    )
    assert not r5["status_json"]["links_checked"].startswith("-"), (
        f"negative link count reached the marker: {r5['status_json']!r}"
    )


def test_a_full_sweep_that_contacted_zero_links_is_not_a_clean_bill_of_health() -> None:
    """The last green-over-nothing hole in this file, found reviewing it.

    ``failIfEmpty: false`` removes the action's own ``Total | 0`` backstop. That
    is right for the diff-scoped PR path — a changed doc may genuinely hold no
    links — but the disable is GLOBAL, so it also removes the backstop from the
    weekly full sweep, where zero contacted links is structurally impossible.

    Measured against the shipped classifier before this fix: ``SCOPE=full``,
    ``COUNT=2548``, lychee Total 0 / Excluded 0, exit 0 gave

        STATUS: OK · RC: 0
        DETAIL: lychee reports 0 link occurrence(s) checked, and found no dead
                links.

    ``files_in_scope: 2548`` and ``links_checked: 0`` side by side in the same
    marker, green — the classifier holds both numbers and never compares them.
    That is exactly the defect this workflow was fixed for: ``docs/**/*.md``
    degrading to ``docs/*.md`` inside the action's eval matched 421 of 2548
    files for years, and the next narrowing of the glob matches none. A run that
    contacted nothing must not print a clean bill of health.
    """
    script = _step("classify")["run"]
    zero = _lychee_summary(total=0, successful=0)

    swept = _run_classifier_full(
        script,
        lychee_out=zero,
        SCOPE="full",
        COUNT="2548",
        LYCHEE_OUTCOME="success",
        LYCHEE_EXIT="0",
    )
    assert swept["status"] == "CHECKER_ERROR", (
        f"a full sweep over 2548 files contacted zero links and passed: {swept['status']!r}"
    )
    assert swept["rc"] == 1, "green-over-nothing must fail closed"
    assert "found no dead links" not in swept["summary"], (
        "the marker still claims a clean bill of health over a run that "
        "contacted nothing"
    )
    assert "ZERO" in swept["summary"]
    # The two numbers the old marker printed without comparing are both still
    # reported — the fix is that they are now read together, not that either
    # goes away.
    assert swept["status_json"]["files_in_scope"] == "2548"
    assert swept["status_json"]["links_checked"] == "0"

    # SILENCE control. Without the guard the same input is a green OK, so this
    # test is measuring the guard and not the fixture.
    ungated = script.replace('if [ "${CHECKED_N:-}" = "0" ]; then', 'if false; then')
    assert ungated != script, "the zero-contacted guard anchor was not found"
    r = _run_classifier_full(
        script=ungated,
        lychee_out=zero,
        SCOPE="full",
        COUNT="2548",
        LYCHEE_OUTCOME="success",
        LYCHEE_EXIT="0",
    )
    assert r["status"] == "OK", (
        "the pre-fix classifier did not reproduce the green-over-nothing shape, "
        f"so this control proves nothing: {r['status']!r}"
    )
    assert r["rc"] == 0, f"pre-fix rc was {r['rc']}, so the control proves nothing"

    # The PR path keeps the legitimate case: a changed doc with no links is not
    # an error — that is WHY failIfEmpty is off — but it does not get to claim
    # it checked anything either.
    pr = _run_classifier_full(
        script,
        lychee_out=zero,
        SCOPE="changed",
        COUNT="1",
        LYCHEE_OUTCOME="success",
        LYCHEE_EXIT="0",
    )
    assert pr["status"] == "OK", f"a changed doc holding no links must not red: {pr['status']!r}"
    assert pr["rc"] == 0
    assert "Nothing was dead because nothing was checked" in pr["summary"]
    assert "0 link occurrence(s) checked, and found no dead links" not in pr["summary"]

    # And a sweep that DID contact links is untouched by the guard.
    healthy = _run_classifier_full(
        script,
        lychee_out=_lychee_summary(total=18196, successful=18080, excluded=116),
        SCOPE="full",
        COUNT="2548",
        LYCHEE_OUTCOME="success",
        LYCHEE_EXIT="0",
    )
    assert healthy["status"] == "OK"
    assert healthy["rc"] == 0
    assert "found no dead links" in healthy["summary"]


def test_the_pr_path_must_not_say_a_file_holds_no_links_when_its_links_were_excluded() -> None:
    """R7: ``contacted zero`` has TWO causes and the marker may not pick one.

    Round 5c's first attempt printed *"the N file(s) in scope hold no links to
    check"* whenever ``CHECKED_N == 0``. For an all-excluded file that is FALSE,
    and falsifiably so from the same marker: ``links_found: 4`` sits three lines
    above it. The code had not failed to establish the truth — it established the
    OPPOSITE and printed both.

    This is the ``docs/_includes`` case the ``Select scope`` comment already
    records: a file whose links are all on the exclude list gives Total 4 /
    Excluded 4. The fix defers to the ``${CHECKED}`` builder, which distinguishes
    the two causes and is true for both.
    """
    script = _step("classify")["run"]
    all_excluded = _lychee_summary(total=4, successful=0, excluded=4)

    pr = _run_classifier_full(
        script,
        lychee_out=all_excluded,
        SCOPE="changed",
        COUNT="1",
        LYCHEE_OUTCOME="success",
        LYCHEE_EXIT="0",
    )
    # Still green — an all-excluded changed doc is not an error.
    assert pr["status"] == "OK", f"all-excluded changed doc must not red: {pr['status']!r}"
    assert pr["rc"] == 0
    # But the marker may not claim the file holds no links when it holds four.
    assert "hold no links to check" not in pr["summary"], (
        "the marker asserts the file holds no links while reporting "
        f"links_found={pr['status_json'].get('links_found')!r}"
    )
    assert "were excluded and never contacted" in pr["summary"]
    assert pr["status_json"]["links_found"] == "4"
    assert pr["status_json"]["links_excluded"] == "4"
    assert pr["status_json"]["links_checked"] == "0"

    # SILENCE control: restore the round-5c sentence and the false claim comes
    # back, so this test is measuring the fix and not the fixture.
    regressed = script.replace(
        'DETAIL="${CHECKED}. Nothing was dead because nothing was checked;'
        ' this says nothing about any URL.${SCOPE_NOTE}"',
        'DETAIL="lychee contacted no link occurrence(s) at all — the ${COUNT}'
        " file(s) in scope hold no links to check. Nothing was dead because"
        ' nothing was checked; this says nothing about any URL.${SCOPE_NOTE}"',
    )
    assert regressed != script, "the PR-path DETAIL anchor was not found"
    r = _run_classifier_full(
        script=regressed,
        lychee_out=all_excluded,
        SCOPE="changed",
        COUNT="1",
        LYCHEE_OUTCOME="success",
        LYCHEE_EXIT="0",
    )
    assert "hold no links to check" in r["summary"], (
        "the pre-fix classifier did not reproduce the false claim, so this "
        f"control proves nothing: {r['summary']!r}"
    )


def test_a_full_sweep_whose_links_were_all_excluded_is_also_green_over_nothing() -> None:
    """The guard's SECOND stated cause, which had no test.

    ``CHECKER_ERROR`` names two causes — "the input glob matched no file **or
    every link was excluded**". Only the first was pinned, so narrowing the guard
    to key on ``Total == 0`` instead of ``contacted == 0`` stayed green and
    reopened green-over-nothing for every all-excluded sweep. Measured on the
    offline widen this is not hypothetical: 18197 Total / 6291 Excluded is the
    real shape, and an all-excluded variant of it contacts zero.

    Also drives the sweep at a SECOND corpus size, so a guard coupled to
    ``COUNT=2548`` stops surviving this suite the moment the corpus grows.
    """
    script = _step("classify")["run"]

    all_excluded = _run_classifier_full(
        script,
        lychee_out=_lychee_summary(total=6291, successful=0, excluded=6291),
        SCOPE="full",
        COUNT="2548",
        LYCHEE_OUTCOME="success",
        LYCHEE_EXIT="0",
    )
    assert all_excluded["status"] == "CHECKER_ERROR", (
        "a full sweep that found 6291 links and contacted NONE of them passed: "
        f"{all_excluded['status']!r}"
    )
    assert all_excluded["rc"] == 1
    assert all_excluded["status_json"]["links_found"] == "6291"
    assert all_excluded["status_json"]["links_checked"] == "0"

    # Second corpus size: the guard must not be coupled to today's file count.
    other_count = _run_classifier_full(
        script,
        lychee_out=_lychee_summary(total=0, successful=0),
        SCOPE="full",
        COUNT="1200",
        LYCHEE_OUTCOME="success",
        LYCHEE_EXIT="0",
    )
    assert other_count["status"] == "CHECKER_ERROR", (
        "the guard stopped firing at a different corpus size, so it is coupled "
        f"to the fixture's COUNT: {other_count['status']!r}"
    )
    assert other_count["rc"] == 1


def test_an_unrecognised_scope_fails_closed_when_nothing_was_contacted() -> None:
    """Unknown scope must not inherit the green branch.

    ``Select scope`` emits exactly ``full`` or ``changed`` today, so this is not
    currently reachable — but every other unknown in this classifier fails closed
    (``SCOPE_FAILED``, an empty ``LYCHEE_EXIT``, an unrecognised outcome), and the
    first draft of this guard was the one place that failed OPEN: an empty
    ``SCOPE`` over 2548 files printed a green clean bill of health. A third scope
    value added later must red, not inherit ``OK``.
    """
    script = _step("classify")["run"]
    zero = _lychee_summary(total=0, successful=0)

    for scope in ("", "partial"):
        r = _run_classifier_full(
            script,
            lychee_out=zero,
            SCOPE=scope,
            COUNT="2548",
            LYCHEE_OUTCOME="success",
            LYCHEE_EXIT="0",
        )
        assert r["status"] == "CHECKER_ERROR", (
            f"scope {scope!r} contacted zero links over 2548 files and passed: "
            f"{r['status']!r}"
        )
        assert r["rc"] == 1, f"scope {scope!r} must fail closed"
        assert "found no dead links" not in r["summary"]


def test_the_excluded_parser_is_tested_against_real_lychee_output() -> None:
    """SILENCE control on the parser itself, using the real output shape.

    The reviewer's mutation — narrowing the separator match — survived a green
    suite because every fixture used a tidy shape lychee never emits. Pin it:
    a parser that cannot read the REAL row must turn this red.
    """
    script = _step("classify")["run"]
    real = _lychee_summary(total=18197, successful=11833, excluded=6291, errors=73)

    healthy = _run_classifier_full(
        script, lychee_out=real, LYCHEE_OUTCOME="success", LYCHEE_EXIT="0"
    )
    assert healthy["status_json"]["links_excluded"] == "6291", (
        "precondition: the shipped parser reads the real emoji-padded row"
    )

    narrowed = script.replace(
        "grep -oE 'Excluded[^0-9]*[0-9]+'", "grep -oE 'Excluded . [0-9]+'"
    )
    assert narrowed != script, "the Excluded parser anchor was not found"
    broken = _run_classifier_full(
        script=narrowed, lychee_out=real, LYCHEE_OUTCOME="success", LYCHEE_EXIT="0"
    )
    assert broken["status_json"]["links_excluded"] != "6291", (
        "a parser that cannot read real lychee output still passed — this "
        "control is measuring the fixture, not the tool"
    )


def test_status_json_is_the_machine_surface_and_is_asserted() -> None:
    """status.json is what a preflight would read; it had zero coverage.

    Hardcoding either status file survived a green suite before this.
    """
    script = _step("classify")["run"]
    r = _run_classifier_full(
        script, age_seconds=_BUDGET_SECONDS - 1, LYCHEE_OUTCOME="cancelled"
    )
    assert r["status"] == "TIMEOUT"
    assert r["status_txt"] == "TIMEOUT", "status.txt must carry the same verdict"
    j = r["status_json"]
    assert j["status"] == "TIMEOUT", "status.json must carry the same verdict"
    assert j["budget_minutes"] == str(_BUDGET_SECONDS // 60)
    assert int(j["elapsed_seconds"]) >= _BUDGET_SECONDS - 60
    assert j["run"].startswith("https://github.com/")

    # A supersede must be distinguishable IN THE JSON, not only in the prose —
    # that is the whole point of the machine surface.
    r2 = _run_classifier_full(script, age_seconds=5, LYCHEE_OUTCOME="cancelled")
    assert r2["status_json"]["status"] == "CANCELLED"
    assert r2["status_json"]["status"] != j["status"]


def _detail_of(summary: str) -> str:
    """The DETAIL sentence — the paragraph under the `## Link Check — X` header.

    Asserting against the whole job summary is not enough: the table below it
    repeats some of the same words, so a check for a phrase can pass on the
    table row while the sentence that actually makes a claim goes unqualified.
    That vacuity was measured, not hypothesised.
    """
    lines = summary.splitlines()
    for i, line in enumerate(lines):
        if line.startswith("## Link Check"):
            rest = [x for x in lines[i + 1 :] if x.strip()]
            return rest[0] if rest else ""
    return ""


def test_offline_runs_say_they_did_not_contact_anything() -> None:
    """An offline run must not read as a verdict on external URLs.

    The whole offline-honesty branch could be deleted with a green suite,
    because no test ever set OFFLINE.
    """
    script = _step("classify")["run"]
    plain = "| Status | Count |\n|---|---|\n| Total | 7 |\n| Successful | 7 |\n"

    online = _run_classifier_full(script, lychee_out=plain, LYCHEE_OUTCOME="success")
    offline = _run_classifier_full(
        script, lychee_out=plain, LYCHEE_OUTCOME="success", OFFLINE="--offline"
    )

    assert online["status"] == offline["status"] == "OK"

    # The DETAIL sentence is the one that says "found no dead links". THAT is
    # what has to be qualified — not merely somewhere in the job summary.
    offline_detail = _detail_of(str(offline["summary"]))
    online_detail = _detail_of(str(online["summary"]))
    assert "found no dead links" in offline_detail, f"unexpected detail: {offline_detail!r}"
    assert "LOCAL links only" in offline_detail, (
        "an offline OK must be qualified IN THE DETAIL or it reads as a clean "
        f"bill of health for external URLs it never contacted: {offline_detail!r}"
    )
    assert "LOCAL links only" not in online_detail
    assert offline["status_json"]["offline"] == "true"
    assert offline["status_json"]["offline"] != online["status_json"]["offline"]
