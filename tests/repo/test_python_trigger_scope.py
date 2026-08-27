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
2. ``test_every_tracked_python_file_is_matched`` — THE POPULATION CONTRACT over
   the tree as it stands, and the acceptance criterion of #3862 generalised.
3. ``test_the_filter_is_keyed_to_file_shape_not_to_todays_tree`` — the same
   contract over paths that do NOT exist. (2) alone cannot see the difference
   between ``**.py`` and ``**/*.py``: this repo has ZERO root-level tracked
   ``.py`` (measured — 0 of 773, against 28 root-level tracked files of other
   kinds), so swapping the head for the depth-≥1 form left (2) green while
   ``conftest.py`` / ``setup.py`` / ``noxfile.py`` stopped matching. Probes at
   depth 0..4 under directory names that do not exist restore the claim the
   docstring makes.
4. ``test_every_filter_entry_matches_its_own_instantiation`` — self-consistency.
   An entry in ``on.push.paths`` that the module cannot match is a dead entry.
   This caught a live one: ``matches('.github/workflows/test.yml')`` was False
   because ``str.lstrip('./')`` takes a CHARACTER SET and ate the leading dot.
5. ``test_the_filter_still_discriminates`` — ANTI-VACUITY. A filter that matched
   everything would satisfy the tests above while being no filter at all.
6. ``test_every_reader_of_the_python_job_is_covered`` — the durable half. The
   readers are DERIVED (``SCOPE_DIRS``, ``testpaths``, the bandit argv,
   ``PIP_CONSTRAINT``, the app the fresh-resolve job names), so widening a
   reader without widening the trigger turns this RED.
7. ``test_the_shipped_detect_step_agrees_with_the_module`` — **the teeth.** The
   step is EXECUTED, in bash, against synthetic PRs, and its verdict is
   compared to the module's. This replaces a text-scan that a 103-byte edit
   defeated: an extension test (``grep -qE`` on ``.py|.ipynb``) contains no
   directory literal, so the old assertion never looked at it, and it flipped
   ``pyproject.toml``, ``requirements/ci-constraints.txt``, ``domains/**/*.sql``,
   ``apps/fiab-setup-orchestrator/Dockerfile``, ``tests/fixtures/*.json`` and
   ``apps/loom-duckdb/requirements.txt`` to ``run=false`` with all 12
   assertions green. A behavioural differential does not care what the
   narrowing is spelled with — only that the step and the module disagree.
8. ``test_the_detect_step_emits_no_verdict_of_its_own`` — the static companion
   to (7), for a narrowing keyed to something no finite probe matrix contains
   (a changed-list length, a branch name, a date). The step may emit
   ``run=true`` — its documented force-run and fail-open branches — or the
   module's ``$verdict``. Nothing else.
9. ``test_the_workflow_self_reference_is_outside_the_parsed_list`` — a PR that
   deleted the self-reference from the list must not be judged by the list it
   just deleted from.
10. ``test_unsupported_filter_syntax_is_refused`` / ``test_empty_*`` — the
    module reports CANNOT RUN rather than inventing a ``run=false``.
"""

from __future__ import annotations

import functools
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
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
# probe construction — synthetic, so nothing here is bounded by today's tree
# --------------------------------------------------------------------------- #

#: Path segments used to build probes. They must not exist in the repo: a probe
#: that collided with a real directory would be measuring that directory rather
#: than the shape of the filter. `test_the_probe_namespace_is_synthetic` checks
#: this rather than assuming it.
PROBE_SEG = "__loom_trigger_probe__"


def _instantiate(pattern: str) -> str:
    """One concrete path that *pattern* must match.

    Never assumed — every instantiation is checked against the pattern it came
    from in ``test_every_filter_entry_matches_its_own_instantiation``. An
    instantiation that did not match its own pattern would turn the behavioural
    differential below into a comparison of two irrelevant answers.
    """
    return (
        pattern.replace("**/", f"{PROBE_SEG}_dir/")
        .replace("**", f"{PROBE_SEG}_seg")
        .replace("*", "probe")
    )


def _shape_probes() -> list[str]:
    """Python files at every depth, in directories that do not exist.

    Depth 0 is the load-bearing one. ``**.py`` and ``**/*.py`` are
    indistinguishable over a tree with no root-level ``.py`` — and this tree has
    none — so the population contract has to be asserted against paths the tree
    does not contain.
    """
    probes = [
        # depth 0: the case a `**/`-prefixed filter silently drops
        "conftest.py",
        "setup.py",
        "noxfile.py",
        "manage.py",
        "probe_notebook.ipynb",
        ".probe_dotfile.py",
    ]
    for depth in range(1, 5):
        prefix = "/".join(f"{PROBE_SEG}_{i}" for i in range(depth))
        probes.append(f"{prefix}/probe_module.py")
        probes.append(f"{prefix}/probe_notebook.ipynb")
    return probes


# --------------------------------------------------------------------------- #
# the shipped detect step, EXECUTED
# --------------------------------------------------------------------------- #

#: The GitHub expressions the detect step interpolates, bound to the values a
#: `pull_request` event would carry. An expression NOT in this map is a hard
#: failure rather than an empty substitution: substituting the empty string
#: would silently change the branch the step takes and the differential would
#: then be measuring a script GitHub never runs.
_EVENT_NAME_EXPR = "${{ github.event_name }}"
_BASE_SHA_EXPR = "${{ github.event.pull_request.base.sha }}"


@functools.lru_cache(maxsize=1)
def _bash() -> str:
    """A bash that can actually reach this filesystem.

    On Windows ``shutil.which('bash')`` frequently resolves to WSL's bash, which
    cannot ``cd`` into a Windows path — it would fail in a way that reads like
    "the step is broken". Every candidate is therefore PROBED before use, and if
    none works this is reported as CANNOT VALIDATE, never as a pass or a skip.
    ``LOOM_TEST_BASH`` overrides the search for an unusual environment.
    """
    candidates: list[str] = []
    override = os.environ.get("LOOM_TEST_BASH")
    if override:
        candidates.append(override)
    if os.name == "nt":
        git = shutil.which("git")
        if git:
            for ancestor in Path(git).resolve().parents:
                for rel in ("bin/bash.exe", "usr/bin/bash.exe"):
                    git_bash = ancestor / rel
                    if git_bash.is_file():
                        candidates.append(str(git_bash))
    found = shutil.which("bash")
    if found:
        candidates.append(found)
    candidates.extend(["/bin/bash", "/usr/bin/bash"])

    probe_dir = tempfile.mkdtemp(prefix="loom-bash-probe-")
    posix_probe = probe_dir.replace("\\", "/")
    rejected: list[str] = []
    for candidate in candidates:
        if not os.path.isfile(candidate):
            rejected.append(f"{candidate}: not a file")
            continue
        try:
            proc = subprocess.run(
                [candidate, "-c", 'cd "$1" && printf ok', "_", posix_probe],
                capture_output=True, encoding="utf-8", errors="replace", timeout=60,
            )
        except OSError as exc:
            rejected.append(f"{candidate}: {exc}")
            continue
        if proc.returncode == 0 and proc.stdout.strip() == "ok":
            return candidate
        rejected.append(
            f"{candidate}: rc={proc.returncode} stdout={proc.stdout!r} "
            f"stderr={proc.stderr!r}"
        )
    pytest.fail(
        "no bash on this machine can reach the filesystem, so the detect step "
        "CANNOT BE EXECUTED and this test is not a pass. Set LOOM_TEST_BASH to "
        "a working bash. Candidates tried:\n  " + "\n  ".join(rejected)
    )
    raise AssertionError("unreachable")


class _DetectStep:
    """Runs the SHIPPED `Detect Python-relevant changes` step over a fake PR.

    The step is not retyped here — it is lifted out of `.github/workflows/test.yml`
    by PyYAML, so what executes is byte-for-byte what GitHub executes, with only
    the two `${{ }}` expressions bound. It runs against a throwaway git repo that
    carries real copies of the workflow and the module, so `git diff`, the
    self-reference `grep`, and `python_trigger_scope.py` all do their real work.
    """

    _GIT_FLAGS = (
        "-c", "commit.gpgsign=false",
        "-c", "core.hooksPath=",
        "-c", "core.autocrlf=false",
        "-c", "user.email=probe@loom.invalid",
        "-c", "user.name=loom-probe",
    )
    _CARRIED = (".github/workflows/test.yml", "scripts/ci/python_trigger_scope.py")

    def __init__(self, workdir: Path) -> None:
        self.bash = _bash()
        self.work = workdir
        self.repo = workdir / "repo"
        self.repo.mkdir(parents=True, exist_ok=True)
        self._git("init", "-q")
        for rel in self._CARRIED:
            dst = self.repo / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO_ROOT / rel, dst)
        self._git("add", "-A")
        self._git("commit", "-q", "-m", "base")
        self.base = self._git("rev-parse", "HEAD").strip()

        # `python3` is what the step invokes. On Windows that name resolves to
        # the Microsoft Store shim, which is not a Python; pinning it to THIS
        # interpreter also removes "which python3 did it get?" from the result.
        self.shim = workdir / "shim"
        self.shim.mkdir(exist_ok=True)
        launcher = self.shim / "python3"
        launcher.write_bytes(
            f'#!/bin/sh\nexec "{sys.executable.replace(chr(92), "/")}" "$@"\n'.encode()
        )
        launcher.chmod(launcher.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

        body = _detect_step_body()
        for expr, value in ((_EVENT_NAME_EXPR, "pull_request"), (_BASE_SHA_EXPR, self.base)):
            if expr not in body:
                pytest.fail(
                    f"the detect step no longer interpolates {expr}. The harness "
                    "would then be running a script that differs from the shipped "
                    "one, so it cannot validate."
                )
            body = body.replace(expr, value)
        leftover = re.findall(r"\$\{\{[^}]*\}\}", body)
        if leftover:
            pytest.fail(
                "the detect step interpolates GitHub expressions this harness "
                f"cannot bind: {sorted(set(leftover))}. Substituting them with "
                "anything would change which branch the step takes."
            )
        self.script = workdir / "detect-step.sh"
        self.script.write_bytes(body.encode("utf-8").replace(b"\r\n", b"\n"))

    def _git(self, *args: str) -> str:
        proc = subprocess.run(
            ["git", "-C", str(self.repo), *self._GIT_FLAGS, *args],
            capture_output=True, encoding="utf-8", errors="replace",
        )
        if proc.returncode != 0:
            pytest.fail(
                f"git {args!r} failed in the probe repo (rc={proc.returncode}); "
                f"the detect step CANNOT BE EXERCISED.\nstderr: {proc.stderr}"
            )
        return proc.stdout

    def verdict_for(self, changed: list[str]) -> tuple[str | None, str]:
        """Run the step over a PR whose diff is exactly *changed*.

        Returns ``(verdict, log)``. ``verdict`` is ``None`` when the step wrote
        NO ``run=`` at all — which is not a benign outcome: an empty
        ``steps.relevant.outputs.run`` makes every downstream ``if:`` false and
        the three REQUIRED contexts report success over an unexecuted suite,
        exactly as a ``run=false`` would.
        """
        self._git("checkout", "-q", "-B", "probe", self.base)
        for rel in changed:
            target = self.repo / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                # e.g. the workflow itself: APPEND a comment rather than
                # overwrite, so the module inside the probe repo can still read
                # it and the run measures the filter, not a parse failure.
                with open(target, "a", encoding="utf-8") as handle:
                    handle.write("\n# loom trigger probe\n")
            else:
                target.write_bytes(b"probe\n")
        self._git("add", "-A")
        self._git("commit", "-q", "-m", "probe")

        out = self.work / "github_output.txt"
        out.write_bytes(b"")
        runner_temp = self.work / "runner_temp"
        runner_temp.mkdir(exist_ok=True)
        env = dict(os.environ)
        env["PATH"] = str(self.shim) + os.pathsep + env.get("PATH", "")
        env["GITHUB_OUTPUT"] = str(out).replace("\\", "/")
        env["RUNNER_TEMP"] = str(runner_temp).replace("\\", "/")
        proc = subprocess.run(
            [self.bash, "-e", str(self.script).replace("\\", "/")],
            cwd=str(self.repo), env=env, capture_output=True,
            encoding="utf-8", errors="replace", timeout=300,
        )
        written = out.read_text(encoding="utf-8", errors="replace")
        # GitHub takes the LAST value written for a key.
        verdicts = [
            line.strip() for line in written.splitlines()
            if line.strip().startswith("run=")
        ]
        log = (
            f"changed={changed}\nbash rc={proc.returncode}\n"
            f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}\n"
            f"--- GITHUB_OUTPUT ---\n{written}"
        )
        return (verdicts[-1] if verdicts else None), log


@pytest.fixture(scope="module")
def detect_step(tmp_path_factory: pytest.TempPathFactory) -> _DetectStep:
    return _DetectStep(tmp_path_factory.mktemp("detect-step"))


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


def test_the_probe_namespace_is_synthetic() -> None:
    """The probe segments must not name anything that exists.

    A probe that collided with a real directory would be measuring that
    directory's coverage, not the shape of the filter — and would keep passing
    after the shape broke.
    """
    collisions = [p for p in _tracked() if PROBE_SEG in p]
    assert not collisions, (
        f"the probe namespace {PROBE_SEG!r} collides with tracked paths, so the "
        f"shape probes are no longer synthetic: {collisions[:10]}"
    )


def test_the_filter_is_keyed_to_file_shape_not_to_todays_tree() -> None:
    """Python files trigger the lane at EVERY depth, including the repo root.

    ``test_every_tracked_python_file_is_matched`` cannot establish this. Its
    population is the tree as it stands, and this tree has ZERO root-level
    tracked ``.py`` or ``.ipynb`` — measured 0 of 773, while 28 root-level files
    of other kinds are tracked, so the zero is real and not a broken query.
    A filter head of ``**/*.py`` therefore satisfies that test completely while
    ``conftest.py``, ``setup.py`` and ``noxfile.py`` match nothing: the moment
    anyone adds one, three REQUIRED contexts go green over an unexecuted suite.

    The docstring on ``on.push.paths`` claims coverage of "directories nobody
    has created yet". These probes are the only assertion that says so.
    """
    missed = [p for p in _shape_probes() if not _scope.matches(p, PATTERNS)]
    assert not missed, (
        "these Python paths are matched by NO entry in on.push.paths. The filter "
        "is keyed to where files happen to live today rather than to what they "
        "are:\n  " + "\n  ".join(missed)
    )


def test_every_filter_entry_matches_its_own_instantiation() -> None:
    """Every entry in the list must match a path that entry describes.

    Self-consistency, and it caught a live defect: ``matches()`` normalised with
    ``path.lstrip('./')``, and ``str.lstrip`` takes a CHARACTER SET — so it ate
    the leading dot of a NAME, not just a ``./`` prefix.
    ``matches('.github/workflows/test.yml')`` returned False: the module could
    not match its own self-reference, a literal entry in this very list. Nothing
    regressed that day only because the detect step force-runs on that one path
    with a hard-coded ``grep -qxF``. Any OTHER dot-leading entry added later —
    ``.pre-commit-config.yaml``, ``.github/workflows/anything.yml`` — would have
    been silently inert, which is #3862's failure mode with a different cause.
    """
    dead = []
    for pattern in PATTERNS:
        probe = _instantiate(pattern)
        if not _scope.matches(probe, [pattern]):
            dead.append(f"{pattern!r} does not match its own instantiation {probe!r}")
        elif not _scope.matches(probe, PATTERNS):
            dead.append(f"{pattern!r} is in the list but {probe!r} matches nothing")
    assert not dead, "dead entries in on.push.paths:\n  " + "\n  ".join(dead)


def test_a_leading_dot_slash_is_stripped_as_a_unit() -> None:
    """`./x` normalises to `x`; `.x` stays `.x`.

    The two cases share one line of code and a character-set strip conflates
    them. Both directions are asserted so a future "simplification" back to
    ``lstrip`` fails here rather than in a required check six months later.
    """
    assert _scope.normalise("./apps/copilot/x.py") == "apps/copilot/x.py"
    assert _scope.normalise("././apps/copilot/x.py") == "apps/copilot/x.py"
    assert _scope.normalise(".github/workflows/test.yml") == ".github/workflows/test.yml"
    assert _scope.normalise(".pre-commit-config.yaml") == ".pre-commit-config.yaml"
    assert _scope.normalise(r"apps\copilot\x.py") == "apps/copilot/x.py"
    assert _scope.matches("./apps/copilot/x.py", PATTERNS)
    assert _scope.matches(".github/workflows/test.yml", PATTERNS)


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

def test_the_detect_step_emits_no_verdict_of_its_own() -> None:
    """The step is a DELEGATE. It may force-run; it may not decide to skip.

    The static companion to the differential below, and it exists because a
    finite probe matrix cannot see a narrowing keyed to something no probe
    carries — the LENGTH of the changed list, the branch name, the day of the
    week. Those all still have to write a verdict, so the contract is put on
    the write rather than on the predicate:

    * the step calls ``python_trigger_scope.py`` (there is a delegate at all);
    * ``verdict`` is assigned ONLY from that call;
    * every line that EMITS a verdict — contains ``run=`` and a redirect —
      emits either ``run=true`` (the documented force-run and fail-open
      branches, whose direction is always "run more") or ``$verdict``;
    * every write to ``$GITHUB_OUTPUT`` carries one of those two.

    This is keyed to the ACT of deciding, not to any spelling of a predicate.
    ``grep``, ``case``, ``awk``, a python one-liner and an arithmetic test are
    all caught identically, because all of them must eventually write the
    answer somewhere.
    """
    code = _detect_step_code()
    assert "python_trigger_scope.py" in code, (
        "the detect step no longer derives its verdict from on.push.paths. "
        "Whatever replaced it is a second population definition."
    )

    lines = code.splitlines()

    assignments = [ln for ln in lines if re.match(r"\s*verdict=", ln)]
    assert assignments, (
        "positive control failed: the step assigns no `verdict` variable at all, "
        "so the contract below would be vacuous."
    )
    foreign = [ln for ln in assignments if "python_trigger_scope.py" not in ln]
    assert not foreign, (
        "`verdict` is assigned from something other than the module, so the "
        "value the step reports is not the module's answer:\n  "
        + "\n  ".join(ln.strip() for ln in foreign)
    )

    def emits(line: str) -> bool:
        return "run=" in line and ">" in line

    def carries_allowed_verdict(line: str) -> bool:
        return "run=true" in line or "$verdict" in line or "${verdict}" in line

    emitters = [ln for ln in lines if emits(ln)]
    assert emitters, (
        "positive control failed: no line in the step writes a `run=` verdict "
        "anywhere, so this contract cannot be violated and cannot be trusted."
    )
    rogue = [ln for ln in emitters if not carries_allowed_verdict(ln)]
    assert not rogue, (
        "the detect step emits a verdict that is neither the documented "
        "fail-open `run=true` nor the module's `$verdict`. Whatever computed it "
        "is a second population definition and it can disagree with the "
        "first:\n  " + "\n  ".join(ln.strip() for ln in rogue)
    )

    output_writes = [ln for ln in lines if "GITHUB_OUTPUT" in ln]
    assert output_writes, (
        "positive control failed: the step writes to no GITHUB_OUTPUT at all."
    )
    unsourced = [ln for ln in output_writes if not carries_allowed_verdict(ln)]
    assert not unsourced, (
        "these lines write to GITHUB_OUTPUT without carrying `run=true` or the "
        "module's `$verdict`, so the value GitHub receives came from somewhere "
        "this test cannot account for:\n  "
        + "\n  ".join(ln.strip() for ln in unsourced)
    )


def test_the_detect_step_is_unconditional() -> None:
    """A gated detect step emits NOTHING, which skips the suite just as well.

    `steps.relevant.outputs.run` empty makes every downstream `if:` false. An
    `if:` on this step would therefore reproduce #3862 without any `run=false`
    existing anywhere — the contract above would still pass and the differential
    would never get to run it.
    """
    doc = yaml.safe_load(WORKFLOW_TEXT)
    for step in doc["jobs"]["python-tests"]["steps"]:
        if step.get("name") == "Detect Python-relevant changes":
            assert "if" not in step, (
                "the detect step is now conditional "
                f"(if: {step['if']!r}). When that condition is false the step "
                "writes no verdict, every heavy step below is skipped, and the "
                "three REQUIRED contexts report success over an unexecuted "
                "suite — #3862 with no `run=false` anywhere to find."
            )
            return
    pytest.fail("the 'Detect Python-relevant changes' step is gone from python-tests.")


def _differential_probes() -> list[tuple[list[str], str]]:
    """The changed-path sets the step and the module are compared over.

    DERIVED, not listed: every entry in ``on.push.paths`` instantiated, every
    directory a step of this job READS (with a NON-Python probe, because the
    ``**.py`` head covers the Python one on its own and the directory entries
    exist precisely for the rest), the shape probes, and real tracked files.
    Each carries a label so a failure says which class broke.
    """
    probes: list[tuple[list[str], str]] = []

    for pattern in PATTERNS:
        if pattern == ".github/workflows/test.yml":
            # Force-run by a hard-coded grep OUTSIDE the parsed list; covered by
            # test_the_workflow_self_reference_is_outside_the_parsed_list.
            continue
        probes.append(([_instantiate(pattern)], f"on.push.paths entry {pattern!r}"))

    for directory in _lint.SCOPE_DIRS:
        probes.append(([f"{directory}/{PROBE_SEG}.txt"], f"ruff scope {directory}"))
    for directory in _pytest_testpaths():
        probes.append(([f"{directory}/{PROBE_SEG}.json"], f"pytest testpath {directory}"))
    for directory in _bandit_dirs():
        probes.append(([f"{directory}/{PROBE_SEG}.cfg"], f"bandit scope {directory}"))
    probes.append(
        ([f"{_fresh_resolve_app()}/Dockerfile"], "the app-fresh-resolve job's app")
    )
    probes.append(([_pip_constraint_path()], "this job's PIP_CONSTRAINT"))

    for probe in _shape_probes()[:4] + _shape_probes()[-2:]:
        # A SAMPLE on purpose: the full depth-0..4 sweep is asserted against the
        # module in test_the_filter_is_keyed_to_file_shape_not_to_todays_tree,
        # which costs microseconds. What the differential adds here is that the
        # STEP agrees about the depth-0 case and about a deep one; running all
        # fourteen through bash + git would triple this test's wall time for no
        # additional class of narrowing.
        probes.append(([probe], "shape probe (Python at an arbitrary depth)"))

    # Real tracked files, sampled deterministically across the tree, so the
    # differential is not exclusively synthetic.
    tracked = _tracked()
    stride = max(1, len(tracked) // 7)
    probes.extend(([tracked[i]], "tracked file") for i in range(0, len(tracked), stride))

    # The other side of the discrimination: these must reach `run=false`, and if
    # the step ever answers `run=true` unconditionally the differential says so.
    for path in (
        "apps/fiab-console/app/page.tsx",
        "apps/fiab-console/lib/editors/lakehouse.ts",
        "docs/ARCHITECTURE.md",
        "README.md",
        "platform/fiab/bicep/main.bicep",
        ".github/workflows/loom-guardrails.yml",
        "apps/copilot/skills/catalog.yaml",
    ):
        probes.append(([path], "non-Python path (must NOT trigger)"))

    # Mixed sets: one relevant path among irrelevant ones must still run.
    probes.append((
        ["apps/fiab-console/app/page.tsx", "docs/ARCHITECTURE.md",
         f"{PROBE_SEG}_mixed/thing.py"],
        "mixed set with one Python file",
    ))
    probes.append((
        ["apps/fiab-console/app/page.tsx", "docs/ARCHITECTURE.md"],
        "mixed set with no Python file",
    ))
    return probes


def test_the_shipped_detect_step_agrees_with_the_module(detect_step: _DetectStep) -> None:
    """EXECUTE the step. Its verdict must be the module's verdict.

    This is the assertion the previous one should have been. #3862 is not "a
    directory literal appears in the detector" — that was one SPELLING of it.
    #3862 is "the step answers something the single source of truth did not",
    and the previous control could only see the spelling: it scanned the step
    for pattern literals at least four characters long, and ``'**.py'``'s
    longest literal is ``'.py'`` — three. So a 103-byte extension test spliced
    in above the module call flipped ``pyproject.toml``,
    ``requirements/ci-constraints.txt``, ``domains/**/*.sql``,
    ``apps/fiab-setup-orchestrator/Dockerfile``, ``tests/fixtures/*.json`` and
    ``apps/loom-duckdb/requirements.txt`` to ``run=false`` — measured, by
    running the extracted step — with the whole file green.

    A differential has no spelling to evade. Filter the changed list before the
    module sees it, short-circuit above it, post-process its answer, exit early
    writing nothing: all of them move the step's answer away from the module's,
    and that is the only thing checked here.
    """
    probes = _differential_probes()
    assert len(probes) >= 25, (
        f"the probe matrix collapsed to {len(probes)} sets. A differential over "
        "a handful of paths would pass over most narrowings."
    )

    expected = {
        label: _scope.verdict(changed, PATTERNS) for changed, label in probes
    }
    # ANTI-VACUITY for the differential itself: a matrix that was all-run=true
    # would be satisfied by a step hard-wired to `echo run=true`, and one that
    # was all-run=false by the failure this test exists to catch.
    assert _scope.VERDICT_RUN in expected.values(), (
        "no probe in the matrix expects run=true — the differential cannot "
        "detect a step that always skips."
    )
    assert _scope.VERDICT_SKIP in expected.values(), (
        "no probe in the matrix expects run=false — the differential cannot "
        "detect a step that always runs."
    )

    failures: list[str] = []
    for changed, label in probes:
        want = _scope.verdict(changed, PATTERNS)
        got, log = detect_step.verdict_for(changed)
        if got != want:
            failures.append(
                f"{label}: the module says {want}, the SHIPPED step says "
                f"{got if got is not None else 'NOTHING (empty outputs.run)'}\n{log}"
            )
    assert not failures, (
        f"{len(failures)} of {len(probes)} probe sets: the detect step's verdict "
        "is not the one python_trigger_scope.py produced. There are two "
        "population definitions again, whatever the second one is spelled "
        "with.\n\n" + "\n\n".join(failures[:6])
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
