"""The Python lane's trigger must cover everything the Python lane READS (#3862).

`.github/workflows/test.yml` publishes THREE REQUIRED contexts — Python Tests
(3.10), (3.11), (3.12). Whether their substantive steps execute is decided by a
path filter. When that filter does not match a change, the job still reports
**success** — so a filter gap does not merely lose coverage, it manufactures a
positive: a reviewer sees three green Python checks and concludes the Python
change was tested. Nothing tested it.

Measured on the tip this was written against, the filter was TWO lists that had
to agree and did not, in both directions:

* ``apps/fiab-setup-orchestrator/**`` was in ``on.push.paths`` — with a comment
  saying the fresh-resolve job is that app's ONLY automated signal — and absent
  from the PR-side detector regex;
* ``tools/`` was in the PR-side detector and absent from ``on.push.paths``.

and both omitted directories the job demonstrably reads —
``portal/shared/portal_tests`` (a ``testpaths`` entry, 271 tests),
``dev-loop``/``governance`` (``python_lint_scope.SCOPE_DIRS`` entries),
``requirements/ci-constraints.txt`` (this job's ``PIP_CONSTRAINT``) — plus
``apps/copilot``'s 137 tracked ``.py``, the instance #3862 was filed for.

What is asserted here
---------------------
1. ``test_hand_parser_agrees_with_a_real_yaml_parser`` — the parser the workflow
   runs before ``setup-python`` sees the same list PyYAML sees. If it did not,
   every other assertion in this file would be about a list GitHub never uses.
2. ``test_every_tracked_python_file_is_matched`` — THE POPULATION CONTRACT, and
   the acceptance criterion of #3862 generalised. Keyed to the observable
   property ("is this file Python?"), never to a directory list, so the next
   directory anyone adds is covered before it exists.
3. ``test_the_filter_still_discriminates`` — ANTI-VACUITY. A filter that matched
   everything would satisfy (2) while being no filter at all.
4. ``test_every_reader_of_the_python_job_is_covered`` — the durable half. The
   readers are DERIVED (``SCOPE_DIRS``, ``testpaths``, the bandit argv,
   ``PIP_CONSTRAINT``, the app the fresh-resolve job names), so widening a
   reader without widening the trigger turns this RED. There is no edit that
   widens one side only.
5. ``test_the_pr_detector_carries_no_second_path_list`` — the anti-drift
   assertion. Two lists cannot disagree if there is only one; this fails if a
   second one reappears.
6. ``test_the_workflow_self_reference_is_outside_the_parsed_list`` — a PR that
   deleted the self-reference from the list must not be judged by the list it
   just deleted from.
7. ``test_unsupported_filter_syntax_is_refused`` / ``test_empty_*`` — the
   module reports CANNOT RUN rather than inventing a ``run=false``.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from tests.conftest import load_script_module

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "test.yml"
TRIGGER_SCOPE = REPO_ROOT / "scripts" / "ci" / "python_trigger_scope.py"
LINT_SCOPE = REPO_ROOT / "scripts" / "ci" / "python_lint_scope.py"
PYPROJECT = REPO_ROOT / "pyproject.toml"

_scope = load_script_module("python_trigger_scope", TRIGGER_SCOPE)
_lint = load_script_module("python_lint_scope", LINT_SCOPE)

WORKFLOW_TEXT = WORKFLOW.read_text(encoding="utf-8")
PATTERNS = _scope.load_patterns(WORKFLOW_TEXT)


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def _tracked(*globs: str) -> list[str]:
    """Tracked paths matching *globs*. Empty is a hard failure, never a pass."""
    result = subprocess.run(
        ["git", "ls-files", "-z", *globs],
        cwd=REPO_ROOT,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        pytest.fail(
            "git ls-files failed — this test CANNOT VALIDATE and is not a pass.\n"
            f"stderr: {result.stderr}"
        )
    return [p for p in result.stdout.split("\0") if p]


def _detect_step_body() -> str:
    """The `run:` body of the `Detect Python-relevant changes` step."""
    doc = yaml.safe_load(WORKFLOW_TEXT)
    # PyYAML resolves the bare key `on:` to the boolean True (YAML 1.1).
    jobs = doc["jobs"]
    for step in jobs["python-tests"]["steps"]:
        if step.get("name") == "Detect Python-relevant changes":
            return str(step["run"])
    pytest.fail(
        "the 'Detect Python-relevant changes' step is gone from python-tests. "
        "This test models that step; it cannot silently pass without it."
    )
    raise AssertionError("unreachable")


def _detect_step_code() -> str:
    """The detect step with comment-only lines removed.

    Measured while building the mutation receipts for this file: an assertion
    written against the raw body was satisfied by the PROSE. Deleting the
    `grep -qxF '.github/workflows/test.yml'` line left a comment three lines
    above that names the same path, and the control stayed GREEN over the exact
    removal it exists to catch. A guard that a comment can satisfy is not a
    guard, so every assertion about what this step DOES reads code only.
    """
    return "\n".join(
        line for line in _detect_step_body().splitlines()
        if not line.lstrip().startswith("#")
    )


def _pytest_testpaths() -> list[str]:
    """``[tool.pytest.ini_options] testpaths``, without needing tomllib.

    The Python matrix includes 3.10, which has no ``tomllib``, and ``tomli`` is
    not a declared dependency. A one-line regex over the literal is honest here
    and fails loudly rather than returning an empty list.
    """
    text = PYPROJECT.read_text(encoding="utf-8")
    match = re.search(r"^testpaths\s*=\s*\[([^\]]*)\]", text, re.MULTILINE)
    if not match:
        pytest.fail(
            "could not read `testpaths` from pyproject.toml — the reader set "
            "cannot be derived, so this test CANNOT VALIDATE."
        )
    paths = re.findall(r'"([^"]+)"', match.group(1))
    if not paths:
        pytest.fail("`testpaths` parsed to an EMPTY list — refusing to pass.")
    return paths


def _bandit_dirs() -> list[str]:
    """The directories the workflow's bandit step actually scans."""
    match = re.search(r"bandit -r ([^\r\n]+)", WORKFLOW_TEXT)
    if not match:
        pytest.fail("no `bandit -r` invocation found in test.yml — cannot derive its scope.")
    dirs = [
        token.rstrip("/")
        for token in match.group(1).split()
        if not token.startswith("-") and "/" in token
    ]
    if not dirs:
        pytest.fail("the bandit invocation named ZERO directories — refusing to pass.")
    return dirs


def _fresh_resolve_app() -> str:
    match = re.search(r"check_app_fresh_resolve\.py\s+(\S+)", WORKFLOW_TEXT)
    if not match:
        pytest.fail("the fresh-resolve job no longer names an app directory.")
    return match.group(1).strip()


def _pip_constraint_path() -> str:
    match = re.search(r"PIP_CONSTRAINT:.*?workspace \}\}/(\S+)", WORKFLOW_TEXT)
    if not match:
        pytest.fail("PIP_CONSTRAINT is no longer set from a workspace-relative path.")
    return match.group(1).strip()


# --------------------------------------------------------------------------- #
# 1. the parser the workflow relies on sees what GitHub sees
# --------------------------------------------------------------------------- #

def test_hand_parser_agrees_with_a_real_yaml_parser() -> None:
    """python_trigger_scope parses `on.push.paths` the way PyYAML does.

    The workflow calls that module in its FIRST step, before setup-python and
    before any pip install, so it cannot depend on PyYAML and hand-parses
    instead. If the hand parser drifted from real YAML semantics, every other
    assertion here would be about a list GitHub never applies.
    """
    doc = yaml.safe_load(WORKFLOW_TEXT)
    triggers = doc[True] if True in doc else doc["on"]
    assert list(triggers["push"]["paths"]) == PATTERNS, (
        "the hand parser and PyYAML disagree about on.push.paths:\n"
        f"  hand-parsed: {PATTERNS}\n"
        f"  PyYAML:      {triggers['push']['paths']}"
    )
    assert PATTERNS, "on.push.paths is EMPTY — an empty filter is not a filter."


# --------------------------------------------------------------------------- #
# 2. the population contract
# --------------------------------------------------------------------------- #

def test_every_tracked_python_file_is_matched() -> None:
    """Every tracked .py / .ipynb in the repo triggers the Python lane.

    This is #3862's acceptance criterion generalised. It is keyed to the
    observable property — is this file Python? — and NOT to a list of
    directories, which is why adding `apps/copilot/**` alone would not have
    been a fix: the next uncovered directory would repeat the defect. Under a
    shape-keyed filter there is no next uncovered directory.
    """
    files = _tracked("*.py", "*.ipynb")
    assert len(files) > 100, (
        f"git ls-files reported only {len(files)} tracked Python files. That is "
        "not a plausible population for this repo; treating it as a pass would "
        "make this assertion vacuous."
    )
    missed = [f for f in files if not _scope.matches(f, PATTERNS)]
    assert not missed, (
        f"{len(missed)} tracked Python file(s) are matched by NO entry in "
        "on.push.paths. A PR touching only these reports three REQUIRED green "
        "Python contexts having executed nothing:\n  "
        + "\n  ".join(missed[:40])
    )


def test_the_filter_still_discriminates() -> None:
    """ANTI-VACUITY. A filter that matched everything would satisfy the test above.

    These are real, populous non-Python trees. If any of them starts matching,
    the `run=false` branch is dead and the 15-minute suite runs on every
    docs/TypeScript/Bicep PR — which is the cost the branch exists to avoid,
    and a silent one.
    """
    must_not_match = [
        "apps/fiab-console/app/page.tsx",
        "apps/fiab-console/lib/editors/lakehouse.ts",
        "docs/ARCHITECTURE.md",
        "README.md",
        "platform/fiab/bicep/main.bicep",
        ".github/workflows/loom-guardrails.yml",
        "portal/shared/api/openapi.json",
        "apps/copilot/skills/catalog.yaml",
    ]
    matched = [p for p in must_not_match if _scope.matches(p, PATTERNS)]
    assert not matched, (
        "these non-Python paths now trigger the Python lane, so the filter no "
        f"longer discriminates: {matched}"
    )


def test_the_instances_named_in_3862_are_covered() -> None:
    """The three concrete instances the issue and the survey named.

    A regression here is not hypothetical: each of these was measured green
    over an unexecuted suite.
    """
    for path in (
        "apps/copilot/tools/readonly.py",              # the reported instance
        "apps/fiab-setup-orchestrator/app/main.py",    # push-list-only drift
        "tools/anything.py",                           # detector-only drift
        "portal/shared/api/audit.py",                  # a testpaths reader
        "requirements/ci-constraints.txt",             # this job's PIP_CONSTRAINT
    ):
        assert _scope.matches(path, PATTERNS), f"{path} is matched by no pattern"


# --------------------------------------------------------------------------- #
# 3. the durable half — the trigger is derived from the READERS
# --------------------------------------------------------------------------- #

def test_every_reader_of_the_python_job_is_covered() -> None:
    """Each directory the job READS must trigger it — for ALL of its files.

    The reader set is derived, not re-declared: ``python_lint_scope.SCOPE_DIRS``
    (what ruff opens), ``testpaths`` (what pytest collects), the bandit argv,
    and the app the fresh-resolve job names. A future widening of any of those
    reds this test until the trigger is widened too, which is the property the
    two hand-maintained lists never had.

    Both a ``.py`` and a NON-``.py`` probe are required per directory: the
    shape-keyed head of the filter covers the first on its own, and the point
    of the directory entries is the second (dbt models, fixtures, Dockerfiles).
    """
    readers: dict[str, str] = {}
    for directory in _lint.SCOPE_DIRS:
        readers[directory] = "python_lint_scope.SCOPE_DIRS (the ruff step)"
    for directory in _pytest_testpaths():
        readers[directory] = "pyproject [tool.pytest.ini_options] testpaths"
    for directory in _bandit_dirs():
        readers[directory] = "the `bandit -r` step"
    readers[_fresh_resolve_app()] = "the app-fresh-resolve job"

    failures = []
    for directory, why in sorted(readers.items()):
        for probe in (f"{directory}/__probe__.py", f"{directory}/__probe__.txt"):
            if not _scope.matches(probe, PATTERNS):
                failures.append(f"{probe}  (read by: {why})")
    assert not failures, (
        "these paths are READ by a step in test.yml but trigger nothing, so a "
        "change to them reports three REQUIRED green contexts over an "
        "unexecuted suite:\n  " + "\n  ".join(failures)
    )


def test_the_pip_constraint_file_triggers_the_lane() -> None:
    """PIP_CONSTRAINT decides what all ~22 pip resolutions may resolve to.

    Derived from the workflow rather than hard-coded, so pointing
    PIP_CONSTRAINT at a different file without widening the trigger reds here.
    """
    constraint = _pip_constraint_path()
    assert _scope.matches(constraint, PATTERNS), (
        f"{constraint} is this job's PIP_CONSTRAINT — it bounds every pip "
        "resolution the suite performs — and it is matched by no trigger entry."
    )


# --------------------------------------------------------------------------- #
# 4. there is only ONE list
# --------------------------------------------------------------------------- #

def test_the_pr_detector_carries_no_second_path_list() -> None:
    """The detect step must not re-declare the population.

    #3862 IS two lists disagreeing. Keyed to the shape of the defect — a path
    prefix appearing literally inside the detector — rather than to the exact
    `grep -qE` spelling the old code happened to use, so re-introducing the
    same mistake in `case`, `awk`, or a different regex dialect fails too.
    """
    body = _detect_step_code()
    assert "python_trigger_scope.py" in body, (
        "the detect step no longer derives its verdict from on.push.paths. "
        "Whatever replaced it is a second population definition."
    )
    # Two literals are legitimately present and are subtracted before the scan:
    # the path of the module being invoked, and the self-reference that the test
    # below requires. Nothing else in this body may name a path pattern.
    haystack = body.replace("scripts/ci/python_trigger_scope.py", "")
    haystack = haystack.replace(".github/workflows/test.yml", "")

    def longest_literal(pattern: str) -> str:
        return max((seg.strip("/") for seg in pattern.split("*")), key=len)

    reintroduced = [
        pattern
        for pattern in PATTERNS
        if pattern != ".github/workflows/test.yml"
        and len(longest_literal(pattern)) >= 4
        and longest_literal(pattern) in haystack
    ]
    assert not reintroduced, (
        "the detect step names path patterns directly, so there are two lists "
        f"again and they can disagree: {reintroduced}"
    )


def test_the_workflow_self_reference_is_outside_the_parsed_list() -> None:
    """Editing the list must not be able to switch off the guard on the list.

    '.github/workflows/test.yml' is an entry in on.push.paths AND an explicit
    check in the detect step. Only the second survives a PR that deletes the
    first — and a PR that deletes the first is exactly the PR that must not be
    allowed to skip this file's tests.
    """
    body = _detect_step_code()
    assert ".github/workflows/test.yml" in body, (
        "the detect step no longer force-runs on a change to test.yml itself. "
        "A PR that removed the entry from on.push.paths would then be judged "
        "by the list it had just deleted from and skip the suite that guards it."
    )
    # Not merely mentioned - USED as a test against the changed-path list. The
    # first draft of this assertion accepted the prose, and the M6 mutation
    # (delete the grep, keep the comment) stayed GREEN.
    assert re.search(
        r"(grep|case|match)[^\r\n]*\.github/workflows/test\.yml", body
    ), (
        "test.yml appears in the detect step but not inside a command that "
        "tests the changed-path list for it. A mention is not a check."
    )
    assert ".github/workflows/test.yml" in PATTERNS, (
        "test.yml is no longer in on.push.paths, so a PUSH to main that only "
        "edits this workflow runs nothing."
    )


# --------------------------------------------------------------------------- #
# 5. the module refuses to invent a verdict
# --------------------------------------------------------------------------- #

def test_unsupported_filter_syntax_is_refused() -> None:
    """A pattern this module cannot evaluate is an error, never a `run=false`.

    GitHub's filter syntax also has `?`, `+`, `[]` and a leading `!`. Guessing
    at one is how a filter starts answering "no match" for a path it should
    have matched — the #3862 outcome by another route.
    """
    for pattern in ("src/[abc]/**", "src/a+/**", "!docs/**", "src/a?.py"):
        with pytest.raises(_scope.TriggerScopeError):
            _scope.pattern_to_regex(pattern)


def test_an_empty_pattern_list_is_an_error_not_a_skip() -> None:
    with pytest.raises(_scope.TriggerScopeError):
        _scope.matches("anything.py", [])
    with pytest.raises(_scope.TriggerScopeError):
        _scope.load_patterns("on:\n  push:\n    paths:\n  schedule:\n")


def test_cli_reports_cannot_run_rather_than_run_false() -> None:
    """Exit 2 on an empty input; the workflow fails OPEN on a non-zero rc.

    A CLI that printed `run=false` for "I was given nothing" would put the
    skip branch one empty variable away.
    """
    empty = subprocess.run(
        [sys.executable, str(TRIGGER_SCOPE), "--match"],
        cwd=REPO_ROOT,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    assert empty.returncode == _scope.EXIT_CANNOT_RUN, (
        f"expected EXIT_CANNOT_RUN on an empty input, got rc={empty.returncode} "
        f"stdout={empty.stdout!r}"
    )
    assert "run=false" not in empty.stdout


def test_cli_answers_run_true_and_run_false() -> None:
    """The end-to-end verdict the workflow actually consumes."""
    for path, expected in (
        ("apps/copilot/tools/readonly.py", "run=true"),
        ("apps/fiab-console/app/page.tsx", "run=false"),
    ):
        proc = subprocess.run(
            [sys.executable, str(TRIGGER_SCOPE), "--match", path],
            cwd=REPO_ROOT,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
        )
        assert proc.returncode == 0, f"rc={proc.returncode} stderr={proc.stderr}"
        assert proc.stdout.strip() == expected, (
            f"{path}: expected {expected}, got {proc.stdout.strip()!r}"
        )
