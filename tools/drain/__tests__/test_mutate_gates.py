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


# ---------------------------------------------------------------------------
# THE RUNNER'S DECISIONS (round 15)
#
# An independent reviewer built the only instrument that can see this file -- a
# byte copy of `tools/drain` under `temp/`, one hand mutation of the runner per
# run, the ordinary suite over it -- and ran fifteen mutations of
# `mutate_gates.py`. FOURTEEN SURVIVED. The single kill was `_clean_env`'s
# `PYTEST_ADDOPTS` strip, i.e. the one runner behaviour that already had a test.
#
# Among the survivors: "any non-zero rc is a kill", "a survivor is counted as a
# kill", "no arm is ever run", "the population gate is off", "the control-rc
# gate is off", "exit code always zero", "the digest hashes nothing". Those are
# the sentences every round of this issue has been closed on.
#
# The cause was structural, not an oversight: the decisions lived inside
# `main()`, and `main()` is called by nothing but `__main__`. These tests exist
# because the decisions now live in three pure functions that a test can reach.
# One test per refusal -- a gate with no negative case is a gate nobody has
# seen fail.


def test_the_scorer_separates_a_kill_from_a_suite_that_never_decided():
    """The four shapes a run can take, and only the second is a kill.

    The third and fourth are the ones that have actually gone wrong here. rc=2
    is a collection crash -- the suite never ran, so the arm was not evaluated,
    and scoring it KILLED is how a `SyntaxError` arm once sat among 106 real
    kills. rc=1 with `1 error` and ZERO failed is a fixture raising at RUNTIME:
    the suite ran but the arm still was not decided, and it read as a kill
    because the marker list carried the bare traceback word `AssertionError`.
    """
    assert mutate_gates._score(0, "425 passed in 20.1s\n") == "survived"
    assert mutate_gates._score(
        1, "FAILED __tests__/test_f.py::test_bad - assert 0\n1 failed, 424 passed in 9.9s\n"
    ) == "killed"
    assert mutate_gates._score(
        2, "E   SyntaxError: invalid syntax\n1 error during collection\n"
    ) == "not-evaluated"
    # The measured misclassification: a traceback word with no failure summary.
    assert mutate_gates._score(
        1, "E       AssertionError: boom\n1 error in 1.83s\n"
    ) == "not-evaluated", "a run that errored decided nothing, whatever its traceback says"
    # ROUND 16, on a reviewer's prescription. The two above pin rc=2 and the
    # error-only shape, but neither reaches the AND that joins the conjuncts:
    # dropping `not _reports_an_error(...)` from `_score` left both green,
    # because in one the rc is already wrong and in the other there is no
    # failure line to combine with. These two do reach it.
    #
    # The first is the MIXED summary -- a failure line AND an error line in the
    # same run. That is a suite which decided some tests and not this arm, and
    # it is the only input where the error conjunct changes the answer on its
    # own. The second is rc=1 with NO summary at all: a run that produced no
    # verdict text cannot have reported a failure, so it cannot be a kill.
    assert mutate_gates._score(
        1, "1 failed, 1 error, 420 passed in 9.9s\n"
    ) == "not-evaluated", "a run that also ERRORED did not decide this arm, even with a failure line"
    assert mutate_gates._score(1, "") == "not-evaluated", (
        "no summary text at all is not a pytest failure, whatever the rc says"
    )
    # ROUND 19, and this one pins the rc CONJUNCT, which nothing did. A reviewer
    # mutated `returncode == 1` to `returncode != 0` and it SURVIVED all 457
    # tests. The reason is fixture shape, not a missing case: every rc=2 fixture
    # above ALSO carries an error line, so `not _reports_an_error(...)` answers
    # first and the rc test is never independently exercised.
    #
    # This input is rc=2 with a genuine failure summary and NO error line, so
    # the rc conjunct is the only thing that can decide it. It is the shape the
    # conjunct exists for: a collection-time crash that still managed to print a
    # failure line is a suite that did not evaluate this arm, and scoring it
    # KILLED is how a `SyntaxError` once sat among 106 real kills.
    assert mutate_gates._score(
        2, "FAILED __tests__/test_f.py::test_bad - assert 0\n1 failed, 424 passed in 9.9s\n"
    ) == "not-evaluated", "rc=2 is not a kill even when the output carries a failure line"


def test_the_scorer_does_not_call_a_clean_exit_a_kill_on_output_alone():
    """rc=0 is a survivor no matter what the text contains.

    Guards the arm that reverted the conjunction to `rc != 0`, and the one that
    dropped the output half. Both SURVIVED the suite before this existed.
    """
    assert mutate_gates._score(0, "1 failed, 424 passed\n") == "survived"


def test_the_exit_code_refuses_a_matrix_that_evaluated_nothing():
    """`ARMS[:0]` printed `killed=0 ... of 0 arms` and exited 0 -- green over
    nothing, which is the `steps=0` shape this repo refuses everywhere else."""
    code, why = mutate_gates._exit_code(
        killed=0, survived=0, skipped=0, errored=0, total=0, before="d0", after="d0"
    )
    assert code == 1
    assert "EMPTY" in why


def test_the_exit_code_refuses_when_the_buckets_do_not_add_up():
    """The partition identity, asserted rather than implied."""
    code, why = mutate_gates._exit_code(
        killed=5, survived=0, skipped=0, errored=0, total=9, before="d0", after="d0"
    )
    assert code == 1
    assert "scored 5" in why
    assert "9" in why


def test_the_exit_code_refuses_a_tree_that_changed_under_the_run():
    """`tracked tree untouched` is the sentence this issue has been closed on
    fourteen times, and it had no negative case anywhere: nothing in a run
    writes to `HERE`, so `before != after` was never exhibited failing.

    ROUND 16: this now passes the two DIGESTS rather than a precomputed bool.
    While the parameter was `tree_intact`, the `before == after` comparison sat
    in `main()` -- untested by construction -- and a reviewer's mutation to
    `tree_intact=True` at that call site went unnoticed by every test here.
    The check is only as good as the least-tested link between the digests and
    the verdict, and that link is now inside the function under test.
    """
    code, why = mutate_gates._exit_code(
        killed=9, survived=0, skipped=0, errored=0, total=9,
        before="d0", after="CHANGED",
    )
    assert code == 1
    assert "TRACKED TREE CHANGED" in why


def test_the_exit_code_refuses_any_arm_that_did_not_die():
    """One check, not two. An earlier draft asked `survived or skipped or
    errored` and then `killed != total` separately; the second was an EQUIVALENT
    MUTANT -- with the partition identity already enforced above it, no input
    distinguishes them -- and a mutation run proved no test could kill it.
    """
    for kwargs in (
        {"killed": 8, "survived": 1, "skipped": 0, "errored": 0},
        {"killed": 8, "survived": 0, "skipped": 1, "errored": 0},
        {"killed": 8, "survived": 0, "skipped": 0, "errored": 1},
    ):
        code, why = mutate_gates._exit_code(
            total=9, before="d0", after="d0", **kwargs
        )
        assert code == 1, kwargs
        assert "not every arm died" in why
        assert "killed=8 of 9" in why, "the breakdown must survive the merge"


def test_the_exit_code_is_zero_only_when_every_arm_died_over_an_intact_tree():
    code, why = mutate_gates._exit_code(
        killed=9, survived=0, skipped=0, errored=0, total=9, before="d0", after="d0"
    )
    assert code == 0
    assert "all 9 arms KILLED" in why


# --------------------------------------------------------------------------
# THE DISPATCH. Round 15 made the three decisions testable and the kill rate
# went 1-of-15 to 8-of-10; every one of the nine survivors that remained was in
# the LOOP, not in a decision. The loop lived in `main()`, which nothing but
# `__main__` calls, so no input could reach it and no assertion could watch it.
# A reviewer pinned `outcome = "killed"` at the call site and the runner printed
# `all 247 arms KILLED` and exited 0 having measured nothing -- `_exit_code`
# saw only the counters, and the counters were internally consistent.
#
# `_run_arms` takes `run` as an argument, so these drive it with a fake and
# assert on the buckets. The fake also RECORDS what it was asked to execute,
# because "the right bucket" and "the right mutant" are different claims and an
# arm that corrupts the second while preserving the first is exactly the shape
# that survived.
# --------------------------------------------------------------------------

def _fake_run(script):
    """A `run` that replays canned (rc, stdout) per call and records its inputs.

    `script` is a list of (returncode, stdout). `calls` accumulates the
    `(filename, mutated_source)` each invocation was handed.
    """
    calls = []

    def run(filename, mutated):
        calls.append((filename, mutated))
        return script[len(calls) - 1]

    run.calls = calls
    return run


def test_the_dispatch_routes_each_outcome_to_its_own_bucket():
    """One arm per bucket, and the counts must not be interchangeable.

    This is the test the nine surviving dispatch arms had no equivalent of.
    Swapping `killed += 1` for `survived += 1`, or returning the tuple in a
    different order, changes this assertion.
    """
    arms = [
        ("kills", "f.py", "AAA", "aaa"),
        ("survives", "f.py", "BBB", "bbb"),
        ("errors", "f.py", "CCC", "ccc"),
    ]
    originals = {"f.py": "AAA BBB CCC\n"}
    run = _fake_run([
        (1, "FAILED t.py::t - assert 0\n1 failed, 424 passed in 9.9s\n"),
        (0, "425 passed in 20.1s\n"),
        (2, "E   SyntaxError: invalid syntax\n1 error during collection\n"),
    ])

    killed, survived, skipped, errored = mutate_gates._run_arms(arms, originals, run)

    assert (killed, survived, skipped, errored) == (1, 1, 0, 1), (
        "each outcome belongs to exactly one bucket, and the ORDER of the "
        "returned tuple is part of the contract. rc=2 is ERRORED, not SKIPPED: "
        "the arm was executed and failed to be decided, which is a different "
        "claim from never having been executed at all"
    )
    assert len(run.calls) == 3, "every arm with a matching anchor must be executed"


def test_the_dispatch_skips_a_missing_anchor_without_running_the_suite():
    """A zero-match anchor is NOT-RUN, never a kill.

    The measured failure this guards: six arms reported `anchor matched 0x`
    against a CRLF worktree, and had the loop scored them rather than skipping
    them, the matrix would have claimed evidence it never gathered.
    """
    arms = [("no such anchor", "f.py", "NOT PRESENT", "x")]
    run = _fake_run([])

    killed, survived, skipped, errored = mutate_gates._run_arms(
        arms, {"f.py": "AAA\n"}, run
    )

    assert (killed, survived, skipped, errored) == (0, 0, 1, 0)
    assert run.calls == [], "a skipped arm must not consume a suite run"


def test_the_dispatch_skips_an_ambiguous_anchor_rather_than_mutating_the_first():
    """`replace(old, new, 1)` takes the FIRST match, so a needle that matches
    twice mutates something the arm did not name -- and once reported SURVIVED
    for a function it never touched. Ambiguity is a skip, not a guess."""
    arms = [("ambiguous", "f.py", "DUP", "x")]
    run = _fake_run([])

    killed, survived, skipped, errored = mutate_gates._run_arms(
        arms, {"f.py": "DUP and DUP\n"}, run
    )

    assert (killed, survived, skipped, errored) == (0, 0, 1, 0)
    assert run.calls == [], "an ambiguous arm must not consume a suite run"


def test_the_dispatch_hands_the_runner_the_mutated_source_not_the_original():
    """The bucket can be right while the mutant is wrong.

    An arm that drops `.replace(...)` and passes `source` through unchanged
    would still produce a green suite and score SURVIVED -- a truthful-looking
    bucket over a mutation that never happened. Only the recorded input catches
    it.

    NOT asserted here, deliberately: that `replace(old, new, 1)` replaces only
    the FIRST occurrence. Writing this test found that the count argument is an
    EQUIVALENT MUTANT by construction -- the ambiguity guard immediately above
    it refuses any source where `old` occurs more than once, so every source
    that reaches the replace has exactly one occurrence and `replace(old, new)`
    is indistinguishable from `replace(old, new, 1)`. The first draft of this
    test used `"TARGET stays TARGET"` as the fixture and was SKIPPED as
    ambiguous, which is how the guard proved the point. The `1` stays because it
    documents intent and costs nothing; no test can kill it, and per this
    package's own rule an un-killable arm is evidence about the arm rather than
    a gap in the suite.
    """
    arms = [("replaces the anchor", "f.py", "TARGET", "REPLACED")]
    originals = {"f.py": "before TARGET after\n"}
    run = _fake_run([(0, "425 passed in 20.1s\n")])

    mutate_gates._run_arms(arms, originals, run)

    assert run.calls == [("f.py", "before REPLACED after\n")], (
        "the runner must receive the source with the anchor replaced and "
        "everything around it intact"
    )
    assert originals["f.py"] == "before TARGET after\n", (
        "the dispatch must not mutate the originals it was lent"
    )


def test_the_dispatch_over_an_empty_matrix_scores_nothing():
    """Zero arms is zero of every bucket -- it is `_exit_code` that refuses the
    empty matrix, and it can only do so if the dispatch reports it honestly
    instead of, say, defaulting a counter to the total."""
    killed, survived, skipped, errored = mutate_gates._run_arms([], {}, _fake_run([]))
    assert (killed, survived, skipped, errored) == (0, 0, 0, 0)


def test_the_exit_args_wiring_cannot_pass_a_count_where_the_total_belongs():
    """`main()`'s wiring, now reachable — round 16 disclosed it as a gap.

    A reviewer measured that ALL FOUR wiring mutations survived, and named the
    two that are not innocuous: `total=killed` makes both partition refusals
    vacuously false, and `survived=0` hides survivors. Either turns the matrix
    GREEN over a run that found blind spots, from one keyword in the one
    function nothing calls.

    Round 16 costed the fix as a `main()` smoke test and deferred it. That was
    the wrong instrument for the thing: this is argument passing, so it only
    had to stop living inside `main()`.
    """
    args = mutate_gates._exit_args(
        counts=(7, 1, 2, 0),
        arms=[("a", "f", "x", "y")] * 10,
        # DISTINCT DIGESTS, AND THE FIRST VERSION USED THE SAME VALUE TWICE.
        # With `before="d0", after="d0"` the returned dict is byte-identical
        # under `"after": before`, so that mutation SURVIVED all 459 tests — the
        # swap is invisible when the two operands are equal.
        #
        # This is the SECOND time in two rounds that the remaining gap was in
        # the fix for the previous gap, for the same reason: a fixture that
        # could not fail. The `_score` rc conjunct was unpinned because every
        # rc=2 fixture also carried an error line; this was unpinned because
        # both digests were "d0". A reviewer named the discipline that catches
        # both: the question to ask an assertion is not "does this cover the
        # field" but "WHAT VALUE WOULD MAKE THIS FAIL".
        before="digest-before",
        after="digest-after",
    )
    assert args == {
        "killed": 7, "survived": 1, "skipped": 2, "errored": 0,
        "total": 10, "before": "digest-before", "after": "digest-after",
    }
    # TOTAL IS DERIVED, NOT PASSED. This is the assertion that closes the
    # `total=killed` mutation: the count and the total come from different
    # objects, so no edit here can make them the same by accident.
    assert args["total"] != args["killed"]
    # THE DIGESTS MUST NOT COLLAPSE ONTO EACH OTHER -- but this line is NOT what
    # catches that, and saying otherwise would be the defect this round is about.
    #
    # A reviewer measured it: deleting this assertion changes nothing, because
    # the dict-equality assertion above pins BOTH values exactly and throws
    # first. Asked the honest question -- what value would make this line fail
    # that would not already fail the line above it? -- there is none. The
    # `"after": before` swap is killed by the dict comparison and by the
    # composed `_exit_code` call below; this is a third statement of a property
    # already covered twice, not a third killer.
    #
    # Kept deliberately, and only for what it actually does: it fires if the
    # dict assertion is ever loosened to a subset check, which is a plausible
    # future edit. It is not coverage of the swap and must not be counted as
    # such -- the rule that produced this round, applied to the round itself.
    assert args["before"] != args["after"]

    # Composed into the real refusal rather than checked as a shape: with
    # distinct digests the tree-changed refusal must fire. Under the mutant this
    # returns (0, "all 10 arms KILLED, tracked tree untouched") -- green over a
    # run whose results cannot be trusted.
    code, why = mutate_gates._exit_code(**args)
    assert code == 1
    assert "TRACKED TREE CHANGED" in why, (
        "distinct digests must reach the sandbox-escape refusal; if this reads "
        "'all arms KILLED' the two digests collapsed onto one operand"
    )


def test_the_error_line_says_whether_an_error_was_reported(capsys):
    """The ERROR branch's diagnostic suffix, which no test observed.

    ROUND 19. A reviewer pinned `errored_out = _reports_an_error(stdout)` to
    `False` and it SURVIVED all 457 tests. It is NOT an equivalent mutant: every
    COUNT is identical, so any assertion about buckets passes, but the printed
    line silently loses ` (an ERROR line was reported)` -- the exact diagnostic
    round 14 was blocked to add, and the one that distinguishes "the suite
    crashed" from "the suite ran and this arm was not decided".

    A survivor whose only effect is on a message is invisible to a test that
    reads only return values. This reads the output.
    """
    originals = {"f.py": "AAA BBB\n"}
    run = _fake_run([
        # rc=1 with an ERROR line and no failure summary: the runtime-fixture
        # shape. `_score` returns not-evaluated and the suffix must appear.
        (1, "E       AssertionError: boom\n1 error in 1.83s\n"),
        # rc=2 with neither: a collection crash that reported no ERROR line, so
        # the same branch must NOT claim one.
        (2, "Interrupted: no tests ran\n"),
    ])

    killed, survived, skipped, errored = mutate_gates._run_arms(
        [("errored with an error line", "f.py", "AAA", "aaa"),
         ("errored without one", "f.py", "BBB", "bbb")],
        originals,
        run,
    )
    assert (killed, survived, skipped, errored) == (0, 0, 0, 2)

    out = capsys.readouterr().out
    lines = [ln for ln in out.splitlines() if "ERROR    " in ln]
    assert len(lines) == 2, out
    assert "(an ERROR line was reported)" in lines[0], (
        "the arm whose output carried an ERROR line must say so -- this is the "
        "round-14 diagnostic, and it is the only observable effect of `errored_out`"
    )
    assert "(an ERROR line was reported)" not in lines[1], (
        "the arm whose output carried NO error line must not claim one (R7)"
    )


def _preamble_kwargs(**overrides):
    """A passing preamble, so each test below changes exactly one thing."""
    base = {
        "control_rc": 0,
        "skipped_ids": list(mutate_gates.EXPECTED_SANDBOX_SKIPS),
        "skipped_count": len(mutate_gates.EXPECTED_SANDBOX_SKIPS),
        "here_n": 425,
        "there_n": 425,
        "with_meta_rc": 0,
        "selected_with": 422,
        "selected_without": 421,
    }
    base.update(overrides)
    return base


def test_the_preamble_admits_a_clean_run():
    """The positive control. Without it, every refusal below could be produced
    by a function that refuses everything."""
    ok, why = mutate_gates._preamble_verdict(**_preamble_kwargs())
    assert ok is True, why
    assert why == ""


@pytest.mark.parametrize(
    ("overrides", "needle"),
    [
        ({"control_rc": 1}, "control is not green"),
        ({"skipped_ids": None, "skipped_count": None}, "could not read the sandbox skip set"),
        ({"skipped_ids": ["some_other.py::test_x"]}, "sandbox skips are"),
        ({"skipped_count": 57}, "attributable to a test id"),
        ({"here_n": None}, "could not collect one of the two trees"),
        ({"there_n": None}, "could not collect one of the two trees"),
        ({"there_n": 366}, "Tests that VANISH do not skip"),
        ({"with_meta_rc": 1}, "the nodeid is not implicated"),
        ({"selected_with": 421}, "did not remove exactly one passing test"),
    ],
)
def test_each_preamble_gate_has_a_negative_case(overrides, needle):
    """One row per refusal. A reviewer turned four of these gates OFF in turn --
    skip-names, skip-count, population and control-rc -- and the suite stayed
    green on all four, because the conditions were `if`s inside `main()` and
    nothing calls `main()`.

    `control_rc` is the one that had no coverage of any kind, anywhere.
    """
    ok, why = mutate_gates._preamble_verdict(**_preamble_kwargs(**overrides))
    assert ok is False, f"{overrides} should have been refused"
    assert needle in why, f"{overrides} refused with the wrong reason: {why}"


def test_the_passed_count_sentinel_is_minus_one_and_not_zero():
    """The -1 is load-bearing: the deselect gate asks
    `selected_with == selected_without + 1`, and two summary-less runs both
    reading 0 would satisfy nothing while two reading -1 cannot accidentally
    satisfy it either. 0 would make `1 == 0 + 1` true against a run that never
    reported a count.
    """
    assert mutate_gates._passed_count("no summary line here at all\n") == -1
    assert mutate_gates._passed_count("421 passed in 9.9s\n") == 421
    # And the gate it protects cannot be satisfied by two unreadable runs.
    ok, why = mutate_gates._preamble_verdict(
        **_preamble_kwargs(selected_with=-1, selected_without=-1)
    )
    assert ok is False
    assert "did not remove exactly one passing test" in why

