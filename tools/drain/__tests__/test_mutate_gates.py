"""Tests for the mutation runner itself -- the one gate the matrix cannot mutate.

`mutate_gates.py` is the instrument every other claim in this package is
measured with, and it is the one file with no arm pointed at it: an arm mutates
a sandbox copy and re-runs the suite, so mutating the runner would mutate the
thing doing the mutating. It therefore needs ordinary tests, and the scoring
rule is what they are for.

The defect these exist for: the runner scored ANY non-zero exit as KILLED. R3's
arm was once a mutation that produced a `SyntaxError`, which exits 2 at
COLLECTION -- so the suite never ran, nothing was measured, and it printed
KILLED beside 106 real kills. The repair was made to that arm rather than to the
scorer, which left the next arm of the same shape reading exactly the same way.
Arms that edit `policy.json` are the likeliest to reproduce it: a malformed edit
raises inside `load_policy` at import.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import mutate_gates


def test_a_real_pytest_failure_reports_a_failure():
    """The accept side. Both the per-test line and the summary line count, and
    an `AssertionError` in a traceback counts too -- pytest's own vocabulary
    varies with `-q`, `-x` and the failure's shape."""
    for stdout in (
        "FAILED tools/drain/__tests__/test_ledger.py::test_x - AssertionError",
        "=== 1 failed, 261 passed in 1.02s ===",
        "2 failed, 260 passed",
        "E       AssertionError: the receipt must be VOID",
    ):
        assert mutate_gates._reports_a_failure(stdout), stdout


def test_negative_control_a_collection_crash_does_not_report_a_failure():
    """THE case the scorer was blind to. Every one of these exits non-zero
    having measured NOTHING, and every one used to print KILLED."""
    for stdout in (
        "ERROR tools/drain/__tests__/test_policy.py - json.decoder.JSONDecodeError",
        "SyntaxError: invalid syntax\n!!! Interrupted: 1 error during collection !!!",
        "ImportError while loading conftest",
        "=== no tests ran in 0.01s ===",
        "",
    ):
        assert not mutate_gates._reports_a_failure(stdout), stdout


def test_negative_control_a_clean_pass_does_not_report_a_failure():
    """The SURVIVED side must stay distinguishable from the KILLED side --
    `passed` contains no marker, and it must not acquire one by accident."""
    assert not mutate_gates._reports_a_failure("=== 268 passed in 1.01s ===")


def test_every_arm_names_a_file_the_runner_actually_copies():
    """An arm pointed at a file outside `SOURCES` can never find its anchor, so
    it would SKIP forever -- which the runner now fails on, but only at the cost
    of a full matrix run. The first such arm died with `KeyError: 'policy.json'`
    because the copy list was hardcoded to `.py`."""
    for name, filename, _old, _new in mutate_gates.ARMS:
        assert filename in mutate_gates.SOURCES, f"{name} -> {filename}"


def test_every_arm_actually_changes_the_source():
    """An arm whose `new` equals its `old` mutates nothing and reports SURVIVED
    -- a blind spot that is really a typo. Cheaper to catch here than in a
    matrix run."""
    for name, _filename, old, new in mutate_gates.ARMS:
        assert old != new, name


def test_every_arm_anchor_is_present_and_unique_in_the_current_source():
    """The cheap version of what a full matrix run discovers in ~90 seconds.

    An anchor that no longer matches SKIPs -- which fails the run, but only
    after every other arm has been executed. An anchor that matches TWICE is
    worse: `replace(old, new, 1)` takes the first, so the arm silently mutates
    a different function and reports SURVIVED, a misfire wearing a blind spot's
    clothes. Both happen on ordinary refactors: renaming one local variable
    broke four anchors and made a fifth ambiguous in a single commit here.

    This reads the same sources the runner copies, so it catches both in under
    a second, and it names the arm.

    READ BYTES AND DECODE, rather than `Path.read_text(newline=...)`. THAT
    keyword landed in **3.13** (`write_text`'s has been there since 3.10);
    `pyproject.toml` declares `>=3.10` and CI runs 3.10/3.11/3.12, so the first
    version passed for me and for both independent reviewers -- all three of us
    on 3.13 -- and was RED on every CI Python. A local green says nothing about
    the floor the project declares."""
    import pathlib

    here = pathlib.Path(mutate_gates.HERE)
    sources = {
        name: here.joinpath(name).read_bytes().decode("utf-8").replace("\r\n", "\n")
        for name in mutate_gates.SOURCES
    }
    broken = []
    for name, filename, old, _new in mutate_gates.ARMS:
        count = sources[filename].count(old)
        if count != 1:
            broken.append(f"{name.split()[0]} -> {count} matches in {filename}")
    assert broken == []


def test_arm_names_are_unique():
    """The name is how a survivor is looked up and how a reviewer audits the
    matrix. Two arms sharing one prefix sent a reader to the wrong one."""
    names = [name.split()[0] for name, *_ in mutate_gates.ARMS]
    assert len(names) == len(set(names)), sorted(
        n for n in names if names.count(n) > 1
    )
