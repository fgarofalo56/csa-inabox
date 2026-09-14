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

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import mutate_gates


def test_a_real_pytest_failure_reports_a_failure():
    """The accept side: pytest's SUMMARY vocabulary, and only that.

    ROUND 14: this test used to assert that a bare traceback line
    (`E       AssertionError: ...`) also counts, and the marker list carried
    `AssertionError` to satisfy it. That was the defect, encoded as a control.
    A COLLECTION ERROR prints the same string, so a run with rc=1, `1 error`
    and ZERO failed scored KILLED -- measured by an independent reviewer.

    ROUND 14, again: the fixtures are now WHOLE pytest outputs rather than
    single lines. A real run never prints a `FAILED` line without a summary
    line, so a one-line fixture was describing output pytest cannot produce --
    and it is what made the bare-substring reader look adequate.
    """
    for stdout in (
        ("FAILED tools/drain/__tests__/test_ledger.py::test_x - AssertionError\n"
         "1 failed, 431 passed in 12.02s\n"),
        "=== 1 failed, 261 passed in 1.02s ===",
        "2 failed, 260 passed in 3.41s",
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


# ---------------------------------------------------------------------------
# ROUND 11: the RUNNER's own helpers had no tests at all, and an independent
# reviewer showed that is WHY its blind spot was invisible. `mutate_gates.py` is
# in COPIED but not SOURCES -- no arm can mutate it, because
# `test_mutate_gates.py` imports it -- so ordinary tests are the only instrument
# it can have. Round 10 added nine arms and every one pointed at `gates.py`.
# ---------------------------------------------------------------------------

def test_the_skip_parser_reads_nodeids_containing_spaces(tmp_path):
    """A nodeid may contain a space when a test is parametrised over this
    receipt's own vocabulary (`Jest (portal)`, `Python Tests (3.10)`). A `(\\S+?)`
    pattern drops those SILENTLY, which UNDER-reports -- so the wrong skip set
    could still equal `EXPECTED_SANDBOX_SKIPS` and let a blind matrix run.

    ROUND 12: this test used to RE-TYPE the regex in its own body and never call
    `_skipped_nodeids`, so reverting the real pattern left it green. An
    independent reviewer caught it. A test that restates the implementation is
    not an instrument -- it is the implementation, twice.
    """
    suite = tmp_path / "__tests__"
    suite.mkdir()
    (suite / "test_spaces.py").write_text(
        "import pytest\n"
        "@pytest.mark.parametrize('case', ['Jest (portal)', 'plain'])\n"
        "def test_a(case):\n"
        "    pytest.skip('needs node')\n",
        encoding="utf-8",
    )
    cmd = [sys.executable, "-m", "pytest", str(suite), "-q",
           "-o", "addopts=", "-p", "no:cacheprovider"]
    got = mutate_gates._skipped_nodeids(tmp_path, cmd)
    assert got is not None
    ids, count = got
    assert count == 2, got
    assert "test_spaces.py::test_a[Jest (portal)]" in ids, sorted(ids)


def test_the_skip_count_comes_from_pytest_not_from_the_names(tmp_path):
    """ROUND 10's blocker, now with an instrument. A module-level skip is
    attributed to NO test id, so a count DERIVED from the names cannot see it --
    which is how 56 vanished tests once passed every gate. The count must come
    from pytest's own summary."""
    suite = tmp_path / "__tests__"
    suite.mkdir()
    (suite / "test_modskip.py").write_text(
        "import pytest\n"
        "pytest.skip('whole module', allow_module_level=True)\n"
        "def test_a():\n"
        "    pass\n",
        encoding="utf-8",
    )
    (suite / "test_ok.py").write_text("def test_b():\n    pass\n", encoding="utf-8")
    cmd = [sys.executable, "-m", "pytest", str(suite), "-q",
           "-o", "addopts=", "-p", "no:cacheprovider"]
    got = mutate_gates._skipped_nodeids(tmp_path, cmd)
    assert got is not None
    ids, count = got
    assert ids == set(), ids
    assert count == 1, (
        "a module-level skip must be COUNTED even though it names no test id; "
        f"got {count}"
    )


def test_the_population_counter_reads_the_selected_count_not_the_total(tmp_path):
    """ROUND 12 BLOCKER. With anything deselected pytest prints
    `354/413 tests collected (59 deselected)`, and reading the right-hand number
    makes an inherited `PYTEST_ADDOPTS='-k ...'` invisible: both trees report the
    total while a smaller suite runs."""
    suite = tmp_path / "__tests__"
    suite.mkdir()
    (suite / "test_two.py").write_text(
        "def test_keep():\n    pass\n\ndef test_drop():\n    pass\n",
        encoding="utf-8",
    )
    assert mutate_gates._collected(suite, tmp_path) == 2

    # CALL THE FUNCTION, DO NOT RESTATE IT. Round 13: this block used to re-type
    # `_collected`'s own regex in the test body and run pytest itself, so
    # reverting the real parser left the suite green -- the EXACT defect round 12
    # diagnosed in the sibling test three functions above, repeated in the fix
    # for it.
    #
    # The deselection comes from a conftest HOOK rather than from
    # `PYTEST_ADDOPTS`, because `_collected` now strips that variable (see the
    # test below) and `-o addopts=` neutralises config. A hook is what still
    # produces `1/2 tests collected (1 deselected)` under a clean environment,
    # which is the line the parser has to read correctly.
    (suite / "conftest.py").write_text(
        "def pytest_collection_modifyitems(config, items):\n"
        "    keep = [i for i in items if 'drop' not in i.name]\n"
        "    dropped = [i for i in items if 'drop' in i.name]\n"
        "    config.hook.pytest_deselected(items=dropped)\n"
        "    items[:] = keep\n",
        encoding="utf-8",
    )
    assert mutate_gates._collected(suite, tmp_path) == 1, (
        "the SELECTED count is the one that will execute; the pre-fix parser "
        "reads the total and returns 2 here"
    )


def test_the_matrix_does_not_inherit_pytest_addopts(tmp_path, monkeypatch):
    """ROUND 13 BLOCKER. Round 12 claimed reading the SELECTED count closed the
    inherited-`PYTEST_ADDOPTS` blind run. It did not, and that was the SECOND
    false "closed" claim at that spot: the sandbox is a byte copy of the repo
    running under the SAME environment, so any `-k` moves BOTH numbers together
    and the comparison can never see it.

    A comparison cannot detect a variable that perturbs both sides equally. What
    closes it is refusing to inherit the variable at all.
    """
    monkeypatch.setenv("PYTEST_ADDOPTS", '-k "not drop"')
    assert "PYTEST_ADDOPTS" not in mutate_gates._clean_env()

    suite = tmp_path / "__tests__"
    suite.mkdir()
    (suite / "test_two.py").write_text(
        "def test_keep():\n    pass\n\ndef test_drop():\n    pass\n",
        encoding="utf-8",
    )
    # With the variable stripped, the count is the WHOLE suite again -- which is
    # the suite the matrix says it ran.
    assert mutate_gates._collected(suite, tmp_path) == 2


def test_the_population_counter_fails_closed_when_it_cannot_say(tmp_path):
    """`None`, not `0`. Returning zero would make `main()` print
    `POPULATION 0 collected, matching this checkout` for two broken trees."""
    suite = tmp_path / "__tests__"
    suite.mkdir()
    (suite / "test_broken.py").write_text("import nonexistent_module_xyz\n",
                                          encoding="utf-8")
    assert mutate_gates._collected(suite, tmp_path) is None


def test_the_expected_sandbox_skips_name_tests_that_exist():
    """A hard-coded nodeid tuple goes stale silently. If one of these is renamed
    or deleted, the matrix refuses -- which is the safe direction -- but the
    reason it prints would name a test nobody can find."""
    import pathlib

    here = pathlib.Path(mutate_gates.__file__).resolve().parent
    for nodeid in mutate_gates.EXPECTED_SANDBOX_SKIPS:
        filename, _, testname = nodeid.partition("::")
        source = (here / "__tests__" / filename).read_text(encoding="utf-8")
        assert f"def {testname}(" in source, (
            f"{nodeid} names a test that does not exist; the matrix would refuse "
            "and print a nodeid the reader cannot locate"
        )


def test_the_population_counter_reads_the_summary_not_the_listing():
    """ROUND 11 BLOCKER. Round 10 pinned the SHAPE of a disappearance (a skip)
    and not the POPULATION, so deleting a test FILE from the sandbox left all
    four gates green while 59 tests vanished. This is the counter that closes
    it, and the repo's own `addopts` is the thing that breaks it: `pyproject
    .toml` puts `-q` there, pytest SUMS verbosity, and `-qq` prints no summary
    line at all."""
    import pathlib

    here = pathlib.Path(mutate_gates.__file__).resolve().parent
    root = here.parents[1]
    if not (root / "pyproject.toml").is_file():  # pragma: no cover - sandbox
        # SKIPPED IN THE MUTATION SANDBOX ON PURPOSE, and declared in
        # `EXPECTED_SANDBOX_SKIPS`. The thing under test is the interaction with
        # the REPO's `addopts`, which the sandbox does not have -- and spawning
        # a collect subprocess inside all 236 arms would add ~12 minutes and the
        # memory pressure that killed a run once already.
        pytest.skip("no pyproject.toml above this tree (mutation sandbox)")
    n = mutate_gates._collected(here / "__tests__", root)
    assert n is not None, (
        "the collected count came back unreadable in the repo itself, which is "
        "the `-qq` shape -- `-o addopts=` is what keeps the two trees comparable"
    )
    assert n > 100, n


# ---------------------------------------------------------------------------
# ROUND 14: the runner's HELPERS were tested and its DECISIONS were not.
# An independent reviewer mutated the runner by hand 15 ways and 14 survived;
# the only kill was the one behaviour that had a test. `mutate_gates.py` is in
# COPIED but not SOURCES, so no arm can reach any of this -- ordinary tests are
# the only instrument it can have.
# ---------------------------------------------------------------------------

def test_a_collection_error_is_not_scored_as_a_kill():
    """BLOCKER, and it was wrong UNMUTATED. `_FAILURE_MARKERS` carried the bare
    string `AssertionError`, which is TRACEBACK vocabulary rather than SUMMARY
    vocabulary -- so a run with rc=1, `1 error` and ZERO failed scored KILLED on
    a traceback from a suite that never decided the arm.

    A mutant that breaks the instrument has not been caught by it.
    """
    errored = (
        "ERROR tests/test_x.py - AssertionError: boom\n"
        "1 error in 0.4s\n"
    )
    assert mutate_gates._reports_an_error(errored) is True
    assert mutate_gates._reports_a_failure(errored) is False, (
        "`AssertionError` must not be read as a pytest failure line"
    )

    # CONTROL: a real failure is still a failure.
    failed = "FAILED tests/test_x.py::test_a - assert 1 == 2\n1 failed in 0.3s\n"
    assert mutate_gates._reports_a_failure(failed) is True
    assert mutate_gates._reports_an_error(failed) is False


def test_the_suites_own_vocabulary_does_not_vote_on_its_own_result():
    """ROUND 14, THE SECOND TIME. The first fix for the above introduced an
    `" error"` substring marker, which matched the drain suite's own ASSERTION
    TEXT -- `assert "no error" in why` -- and scored three real kills as ERROR.
    The same defect, inside its own repair.

    A substring of the whole stdout can never answer this question: the suite's
    output contains the vocabulary it is testing. Only the summary line can.
    """
    noisy = (
        "tools/drain/__tests__/test_tick.py::test_x\n"
        "    assert 'no error' in why\n"
        "E   AssertionError: 1 error during the refresh guard\n"
        "FAILED tools/drain/__tests__/test_tick.py::test_x\n"
        "2 failed, 426 passed, 3 skipped, 1 deselected in 12.01s\n"
    )
    assert mutate_gates._reports_a_failure(noisy) is True
    assert mutate_gates._reports_an_error(noisy) is False, (
        "the words `error` and `AssertionError` appear in the suite's own "
        "output; only pytest's summary line decides"
    )

    # And the reverse: a genuine error summary is still an error, even when the
    # run also printed the word `failed` in a traceback above it.
    real_error = (
        "E   assert 'failed' in result\n"
        "ERROR tools/drain/__tests__/test_policy.py\n"
        "1 error in 0.22s\n"
    )
    assert mutate_gates._reports_an_error(real_error) is True
    assert mutate_gates._reports_a_failure(real_error) is False


def test_the_summary_reader_says_nothing_when_pytest_said_nothing():
    """No summary line means no verdict, and "no verdict" must not read as
    "no failure" -- that is the direction that scores a dead run as a
    survivor."""
    assert mutate_gates._summary_counts("") == {}
    assert mutate_gates._summary_counts("Traceback (most recent call last):") == {}
    assert mutate_gates._reports_a_failure("") is False
    assert mutate_gates._reports_an_error("INTERNALERROR> boom") is True


def test_the_tree_digest_changes_when_a_source_changes(tmp_path):
    """BLOCKER. `tracked tree untouched: True` is quoted as evidence in every
    round of this issue, and it had NO TEST -- nor had it ever been exhibited
    printing False. A constant return or an empty population makes it vacuous.
    """
    for name in mutate_gates.SOURCES:
        (tmp_path / name).write_text("original\n", encoding="utf-8")
    before = mutate_gates.digest_tree(tmp_path)
    assert before == mutate_gates.digest_tree(tmp_path), "must be stable"

    # EXHIBIT THE FALSE. Every source, one at a time, must move the digest --
    # otherwise a file is in SOURCES and not actually being watched.
    for name in mutate_gates.SOURCES:
        (tmp_path / name).write_text("mutated\n", encoding="utf-8")
        assert mutate_gates.digest_tree(tmp_path) != before, (
            f"{name} is declared a watched source but does not move the digest"
        )
        (tmp_path / name).write_text("original\n", encoding="utf-8")
    assert mutate_gates.digest_tree(tmp_path) == before


def test_the_tree_digest_refuses_an_empty_population(monkeypatch, tmp_path):
    """A digest over zero files is a constant, and a constant compares equal to
    itself for any tree -- so `sorted(SOURCES)[:0]` would print
    `tracked tree untouched: True` over any modification at all."""
    monkeypatch.setattr(mutate_gates, "SOURCES", [])
    with pytest.raises(ValueError, match="EMPTY source list"):
        mutate_gates.digest_tree(tmp_path)


def test_the_clean_env_strips_both_variables(monkeypatch):
    """`PYTEST_PLUGINS` was the untested half. Both can change what a pytest
    subprocess runs without changing any file."""
    monkeypatch.setenv("PYTEST_ADDOPTS", "-k nope")
    monkeypatch.setenv("PYTEST_PLUGINS", "some_plugin")
    monkeypatch.setenv("PATH", os.environ.get("PATH", ""))
    env = mutate_gates._clean_env()
    assert "PYTEST_ADDOPTS" not in env
    assert "PYTEST_PLUGINS" not in env
    assert "PATH" in env, "it must still be a usable environment"
