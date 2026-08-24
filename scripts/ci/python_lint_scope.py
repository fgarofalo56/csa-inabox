#!/usr/bin/env python3
"""The Python lint POPULATION, defined once, for `make validate` AND for CI.

Why this exists (#3811)
-----------------------
A gate that FIRES for a file it never OPENS does not merely leave a gap. It
manufactures a positive: the change selects the gate, the gate reads a
different, clean set of files, exits 0, and the suite prints "All gates
passed!" over a change nothing examined. #3811 was filed for that shape at
762-fires / 207-reads. Narrowing the trigger to six directories closed most of
it and left nine files behind, because the two populations were still computed
by two different methods that happened to disagree:

* the TRIGGER was ``git``'s view - tracked files under those directories;
* the CHECK was ``ruff``'s view - files ruff finds by WALKING those directories.

``.gitignore:34`` contains ``data/`` and ruff respects gitignore, so ruff's walk
skipped ``scripts/data/`` entirely. Nine tracked files there carry 216 findings
including 10 ``F401``. Measured: ``ruff check scripts domains tools csa_platform
dev-loop`` was RC=0; the same command with ``--no-respect-gitignore`` was RC=1
with exactly 216 errors. The gate was green on nine tracked files in its own
headline directory.

The fix is not another flag. It is to stop having two methods. This module
computes ONE list - tracked ``.py``/``.ipynb`` under the declared directories -
and:

* hands it to ruff as EXPLICIT PATHS, which ruff opens regardless of gitignore
  (measured: an explicit ``scripts/data/download-noaa.py`` reports its 20
  findings; the directory walk reports none). Untracked build junk under those
  trees - ``.venv``, ``__pycache__``, ``site/`` - is excluded for the same
  reason, which the directory walk only got right by accident of gitignore;
* asserts, every run, that ruff actually OPENED every one of them
  (``--show-files``). That assertion is the population contract. It is keyed to
  the observable property, not to a directory-name list, so the next
  ``.gitignore`` line, the next ``extend-exclude`` entry, or the next directory
  anyone adds cannot silently subtract from the check side;
* asserts, when the caller supplies them, that the ORCHESTRATOR's trigger globs
  describe exactly this same list (``--assert-trigger-globs``). Widening
  ``validate-all.ps1``'s Gate 2 trigger without widening this module reds the
  gate on the very next run, whatever directory was added.

``dev-loop`` and ``governance`` carry zero tracked Python today. ``dev-loop`` is
itself gitignored (``.gitignore:377``) with 14 files force-added, so under the
old directory walk its check side could NEVER have been non-empty - the first
tracked ``.py`` added there would have been triggered and structurally
unreadable. Under ``git ls-files`` + explicit paths it is readable. This file
lives under ``scripts/`` and is therefore inside the population it defines: it
lints itself.

The ratchet
-----------
``RATCHET`` freezes pre-existing debt PER FILE at an exact count. Per file, not
per total: a total-only ratchet reads ``216 == 216`` while one file is fixed and
another regresses. A file absent from ``RATCHET`` is held at zero, so the debt
cannot grow by file count either. Any drift in EITHER direction fails - a
finding added is a regression, a finding removed is a number in this file that
has stopped being true, and #3811 exists because of numbers that stopped being
true. Paydown is tracked in #3990; done is ``RATCHET == {}``.

Usage::

    python scripts/ci/python_lint_scope.py                      # lint
    python scripts/ci/python_lint_scope.py --output-format github
    python scripts/ci/python_lint_scope.py --print-scope        # what it lints
    python scripts/ci/python_lint_scope.py --print-trigger-globs
    python scripts/ci/python_lint_scope.py --assert-trigger-globs 'scripts/*.py' ...

Exit codes match the dev-loop gate convention:
    0 - clean
    1 - findings, or a broken population contract
    2 - COULD NOT RUN (no git, no ruff, empty population). Never reported as a
        pass; see ``GateStatus`` in ``dev-loop/gates/validate-all.ps1``.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

EXIT_OK = 0
EXIT_FINDINGS = 1
EXIT_CANNOT_RUN = 2

#: The declared population. BOTH halves of the gate derive from this tuple:
#: ``validate-python.ps1`` lints it, and ``validate-all.ps1``'s Gate 2 trigger
#: is asserted against ``trigger_globs()`` on every run. Adding a directory here
#: widens both sides at once, which is the entire point - there is no edit that
#: widens one.
SCOPE_DIRS: tuple[str, ...] = (
    "csa_platform",
    "dev-loop",
    "domains",
    "governance",
    "scripts",
    "tools",
)

#: ruff lints notebooks as well as modules, and six tracked ``.ipynb`` under
#: ``scripts/`` and ``tools/`` were in the old walk's population. Passing only
#: ``.py`` would have silently dropped them while "fixing" coverage.
LINTABLE_SUFFIXES: tuple[str, ...] = (".py", ".ipynb")

#: Pre-existing debt, frozen per file at an EXACT count. See the module
#: docstring and #3990. Measured with ruff 0.16.3 under ``pyproject.toml``'s
#: rule set; every entry must be an exact match or this script fails and prints
#: the number to write. CI installs ruff unpinned (``pip install ruff``), so a
#: ruff release that adds or retires a rule will move several of these at once -
#: that is a real signal about what is now enforced, and it is re-recorded in
#: one commit rather than tolerated by loosening the comparison.
RATCHET: dict[str, int] = {
    "scripts/data/download-census.py": 27,
    "scripts/data/download-commerce.py": 21,
    "scripts/data/download-dot.py": 28,
    "scripts/data/download-epa.py": 22,
    "scripts/data/download-geospatial.py": 23,
    "scripts/data/download-health.py": 25,
    "scripts/data/download-noaa.py": 20,
    "scripts/data/download-streaming.py": 26,
    "scripts/data/download-usda.py": 24,
}

#: Tracked files inside ``SCOPE_DIRS`` that ruff legitimately refuses to open,
#: each with the reason. ``pyproject.toml``'s ``extend-exclude`` is honoured via
#: ``--force-exclude``, so an entry there hides a file from the linter; that is
#: allowed only when it is written down HERE too. Empty today: of the two
#: ``extend-exclude`` paths, ``domains/spark/ArcGIS_GeoAnalyticsEngine`` has no
#: tracked files and ``scripts/monitor/SynapseTroubleshooting.ipynb`` is
#: untracked, so neither is in the population to begin with.
CONFIG_INVISIBLE: dict[str, str] = {}


def _key(repo_root: str, rel_path: str) -> str:
    """Comparable absolute path. Windows is case-insensitive and mixes separators."""
    return os.path.normcase(os.path.realpath(os.path.join(repo_root, rel_path)))


def _run(repo_root: str, args: list[str]) -> subprocess.CompletedProcess[str]:
    # Fixed argv, never a shell: every element is either a literal or a
    # repo-relative path this module produced from `git ls-files`.
    return subprocess.run(
        args,
        cwd=repo_root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )


def trigger_globs() -> tuple[str, ...]:
    """The orchestrator's Gate 2 trigger, derived from ``SCOPE_DIRS``.

    PowerShell ``-like`` treats ``*`` as matching across ``/``, so
    ``scripts/*.py`` covers ``scripts/data/download-noaa.py``. That is the
    dialect ``validate-all.ps1``'s ``ShouldRunGate`` matches in, and it is why
    ``dev-loop/config.yaml`` carries the same globs rather than ``**`` ones.
    """
    return tuple(sorted(f"{d}/*{suffix}" for d in SCOPE_DIRS for suffix in LINTABLE_SUFFIXES))


def tracked_scope(repo_root: str) -> list[str] | None:
    """Tracked lintable files under ``SCOPE_DIRS``. ``None`` when git cannot answer.

    ``git ls-files`` is asked for every tracked ``.py``/``.ipynb`` in the repo
    and filtered here, rather than being handed per-directory pathspecs: one
    call, one dialect, and the filter is plain string prefixing that cannot
    disagree with itself.
    """
    proc = _run(repo_root, ["git", "ls-files", "-z", "--", "*.py", "*.ipynb"])
    if proc.returncode != 0:
        return None
    tracked = [p.replace("\\", "/") for p in proc.stdout.split("\0") if p]
    prefixes = tuple(f"{d}/" for d in SCOPE_DIRS)
    return sorted(p for p in tracked if p.endswith(LINTABLE_SUFFIXES) and p.startswith(prefixes))


def opened_by_ruff(repo_root: str, paths: list[str]) -> set[str] | None:
    """Repo-relative paths ruff will actually READ for ``paths``. ``None`` on failure."""
    proc = _run(repo_root, ["ruff", "check", "--show-files", "--force-exclude", "--", *paths])
    if proc.returncode != 0:
        return None
    by_key = {_key(repo_root, p): p for p in paths}
    opened: set[str] = set()
    for line in proc.stdout.splitlines():
        candidate = line.strip()
        if not candidate:
            continue
        match = by_key.get(_key(repo_root, candidate))
        if match is not None:
            opened.add(match)
    return opened


def assert_population(repo_root: str, scope: list[str]) -> list[str]:
    """The population contract. Returns the failure lines; empty means it holds."""
    opened = opened_by_ruff(repo_root, scope)
    if opened is None:
        return ["ruff --show-files failed, so the check population is UNKNOWN - not a pass."]
    unopened = [p for p in scope if p not in opened and p not in CONFIG_INVISIBLE]
    if not unopened:
        return []
    lines = [
        f"POPULATION CONTRACT BROKEN: {len(unopened)} tracked file(s) select this gate and ruff never opens them.",
        "  A gate that fires for a file it does not read reports a PASS over an unexamined change (#3811).",
    ]
    lines += [f"    {p}" for p in unopened]
    lines += [
        "  Usual cause: a .gitignore or pyproject `extend-exclude` entry now covers them.",
        "  Fix the exclusion, or record each path in CONFIG_INVISIBLE with the reason it is",
        "  genuinely unreadable. Do NOT drop it from SCOPE_DIRS while leaving the trigger wide.",
    ]
    return lines


def ratchet_counts(repo_root: str, paths: list[str]) -> dict[str, int] | None:
    """Findings per file for ``paths``, zero-filled. ``None`` when ruff cannot answer."""
    proc = _run(
        repo_root,
        ["ruff", "check", "--force-exclude", "--output-format", "json", "--", *paths],
    )
    if proc.returncode not in (0, 1):
        return None
    try:
        findings = json.loads(proc.stdout or "[]")
    except json.JSONDecodeError:
        return None
    by_key = {_key(repo_root, p): p for p in paths}
    counts = dict.fromkeys(paths, 0)
    for finding in findings:
        filename = finding.get("filename") or ""
        match = by_key.get(_key(repo_root, filename))
        if match is not None:
            counts[match] += 1
    return counts


def own_repo_root() -> str:
    """The checkout this module was loaded from: ``<root>/scripts/ci/this_file``."""
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))


def ratchet_applies(repo_root: str) -> bool:
    """Whether ``RATCHET``'s paths mean anything for ``repo_root``.

    ``RATCHET`` names concrete files in this repository. ``gate-selftest.ps1``
    points the gate at synthetic repositories, where those paths legitimately do
    not exist - and a foreign repo must not be told to "delete the stale
    entries", nor have its own files quietly exempted by a name collision. When
    the subject is not this module's own checkout the ratchet is skipped and
    EVERY file is held at zero, which is the stricter reading, never the laxer
    one.
    """
    return os.path.normcase(os.path.realpath(repo_root)) == os.path.normcase(own_repo_root())


def check_ratchet(repo_root: str, scope: list[str]) -> tuple[list[str], list[str]]:
    """Enforce ``RATCHET``. Returns (report lines, failure lines)."""
    if not ratchet_applies(repo_root):
        return [
            f"Ratchet SKIPPED: --repo-root {repo_root} is not this module's own checkout",
            f"  ({own_repo_root()}), so RATCHET's paths do not describe it.",
            "  Every file in this population is held at zero findings.",
        ], []
    stale = sorted(set(RATCHET) - set(scope))
    if stale:
        return [], [
            "RATCHET names file(s) that are no longer in the population:",
            *[f"    {p}" for p in stale],
            "  Delete the entries. A ratchet over a file nobody lints measures nothing.",
        ]
    tracked_debt = sorted(RATCHET)
    if not tracked_debt:
        return ["Ratcheted debt: none. RATCHET is empty - the population is held at zero."], []

    counts = ratchet_counts(repo_root, tracked_debt)
    if counts is None:
        return [], ["ruff could not report per-file findings for the ratcheted files - not a pass."]

    report = [
        (
            f"Ratcheted debt: {len(tracked_debt)} file(s), {sum(RATCHET.values())} finding(s) "
            "frozen at an exact per-file count (#3990)."
        ),
    ]
    failures: list[str] = []
    for path in tracked_debt:
        expected = RATCHET[path]
        actual = counts[path]
        flag = "ok" if actual == expected else "DRIFT"
        report.append(f"    {actual:5d} / {expected:<5d} {flag:5s} {path}")
        if actual > expected:
            failures.append(
                f"REGRESSION {path}: {actual} findings, ratchet holds it at {expected}. "
                "Fix the new findings; do not raise the ratchet.",
            )
        elif actual < expected:
            failures.append(
                f"RATCHET STALE {path}: {actual} findings, this file says {expected}. "
                f"Lower it to {actual} in scripts/ci/python_lint_scope.py (or delete the entry at 0). "
                "If several entries moved at once and nobody touched these files, suspect a ruff "
                "upgrade - CI installs ruff unpinned - and re-record the counts in one commit.",
            )
    return report, failures


def check_trigger_globs(supplied: list[str]) -> list[str]:
    """Assert the orchestrator's trigger describes exactly this population."""
    want = set(trigger_globs())
    got = {g.strip().replace("\\", "/") for g in supplied if g.strip()}
    if want == got:
        return []
    lines = [
        "TRIGGER/CHECK MISMATCH: the orchestrator fires this gate for a different set of",
        "  files than this module lints. That is #3811's defect verbatim.",
    ]
    for extra in sorted(got - want):
        lines.append(f"    trigger-only (fires, never read): {extra}")
    for missing in sorted(want - got):
        lines.append(f"    check-only (read, never fires):   {missing}")
    lines += [
        "  Both sides derive from SCOPE_DIRS in scripts/ci/python_lint_scope.py.",
        "  Widen THAT, not one caller's glob list.",
    ]
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo-root", default=".", help="repository root (default: cwd)")
    parser.add_argument("--output-format", default="full", help="ruff --output-format for the strict population")
    parser.add_argument("--print-scope", action="store_true", help="print the population and exit")
    parser.add_argument("--print-trigger-globs", action="store_true", help="print the derived trigger globs and exit")
    parser.add_argument(
        "--assert-trigger-globs",
        nargs="*",
        default=None,
        metavar="GLOB",
        help="fail unless these are exactly the derived trigger globs",
    )
    parser.add_argument(
        "--assert-only",
        action="store_true",
        help=(
            "run only the assertions that do not need ruff, then exit. This is what "
            "gate-selftest.ps1 uses for its embedded control, so the control's verdict "
            "depends on the assertion alone and not on whether the tree happens to lint clean."
        ),
    )
    args = parser.parse_args(argv)

    if args.print_trigger_globs:
        for glob in trigger_globs():
            print(glob)
        return EXIT_OK

    repo_root = os.path.abspath(args.repo_root)

    failures: list[str] = []
    if args.assert_trigger_globs is not None:
        failures += check_trigger_globs(args.assert_trigger_globs)

    if args.assert_only:
        for line in failures:
            print(line)
        if failures:
            return EXIT_FINDINGS
        print(f"Trigger globs match the declared population ({len(trigger_globs())} glob(s)).")
        return EXIT_OK

    if shutil.which("git") is None:
        print("git is not on PATH - the population is UNKNOWN, which is NOT a pass.")
        return EXIT_CANNOT_RUN
    scope = tracked_scope(repo_root)
    if scope is None:
        print(f"git ls-files failed under {repo_root} - the population is UNKNOWN, which is NOT a pass.")
        return EXIT_CANNOT_RUN

    if args.print_scope:
        for path in scope:
            print(path)
        return EXIT_OK

    py_count = sum(1 for p in scope if p.endswith(".py"))
    nb_count = len(scope) - py_count
    print(f"Python lint population: {len(scope)} tracked file(s) - {py_count} .py + {nb_count} .ipynb")
    print(f"  under: {', '.join(SCOPE_DIRS)}")

    if not scope:
        print("No tracked Python under the declared directories - CANNOT VALIDATE, not a pass.")
        return EXIT_CANNOT_RUN

    if shutil.which("ruff") is None:
        print("ruff is not on PATH - CANNOT VALIDATE, not a pass.")
        return EXIT_CANNOT_RUN

    failures += assert_population(repo_root, scope)

    report, ratchet_failures = check_ratchet(repo_root, scope)
    for line in report:
        print(line)
    failures += ratchet_failures

    exempt = set(RATCHET) if ratchet_applies(repo_root) else set()
    strict = [p for p in scope if p not in exempt]
    print(f"Strict population (held at zero findings): {len(strict)} file(s)")
    strict_rc = 0
    if strict:
        proc = _run(
            repo_root,
            ["ruff", "check", "--force-exclude", "--output-format", args.output_format, "--", *strict],
        )
        sys.stdout.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        strict_rc = proc.returncode
        if strict_rc not in (0, 1):
            print(f"ruff exited {strict_rc} - it did not complete, so this is NOT a pass.")
            return EXIT_CANNOT_RUN

    for line in failures:
        print(line)

    if failures or strict_rc != 0:
        return EXIT_FINDINGS
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
