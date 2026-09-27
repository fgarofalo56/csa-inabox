"""The drain mutation matrix must RUN on every PR, over EVERY arm (#4555, #4712).

`tools/drain/mutate_gates.py` is the instrument that certifies the drain's test
suite is not blind. On 2026-09-19 it moved out of the ``python-tests`` job --
where it was a step gated on ``steps.relevant.outputs.run`` and pinned to the
3.10 leg -- into its own job, because at 330 arms it was ~70% of a REQUIRED
context's runtime and that context died against its ``timeout-minutes`` wall
twice (45m00s with zero margin at 2843bd3cc49, then 45m18s CANCELLED at
33856071b2c, blocking five PRs).

THEN THE SPLIT JOB HIT THE SAME WALL (#4712). At 413 arms it ran 44m54s against
its own ``timeout-minutes: 45`` and reported CANCELLED -- including on a head
that added no arms and no tests, so the population, not any one PR, no longer
fit on one runner. On 2026-09-25 it was SHARDED six ways with an adjudicating
merge job, following #4682's vitest split.

THE SIGNAL IS ADVISORY, AND THAT IS THE RISK. Branch protection is not a
workflow file, so ``Drain Mutation Matrix (3.10)`` is absent from `main`'s
required checks. (It is not therefore harmless: `merge_gate.py` gate 4c reads
`policy.json: merge_gate.advisory_red_is_a_no_go`, which is `true`, so an
advisory RED is a NO-GO for the drain's own gate. Branch protection and the
drain gate are different surfaces and this file is about the first.) That makes
the remaining guarantee -- *it still runs, on every PR, over the WHOLE arm
population* -- the only thing standing between this repo and a mutation matrix
that silently watches nothing.

A guarantee stated only in a YAML comment is one edit from being false, and this
file exists so that edit is RED instead of quiet.

What is asserted here, and the value that breaks each
-----------------------------------------------------
1.  ``test_a_job_runs_the_mutation_matrix`` -- deleting or renaming the
    ``python tools/drain/mutate_gates.py`` shard command.
2.  ``test_a_job_adjudicates_the_shards`` -- deleting the ``--adjudicate``
    step, i.e. sharding with nobody checking the union. This is the #4679
    failure in its drain-shaped form: a merge job that merely CONCLUDES after
    the shards rather than adjudicating them.
3.  ``test_the_adjudicator_reads_the_shard_jobs_result`` -- hardcoding
    ``--needs-result success``, which would count a CANCELLED or SKIPPED shard
    as a pass.
4.  ``test_the_shard_count_agrees_in_all_four_places`` -- THE COUPLING GUARD.
    Changing ``shard: [1..6]`` without changing the ``/6`` in the job name, the
    ``/6`` in ``--shard``, or the ``--shards 6`` in the adjudicator. Every one
    of those leaves arms unassigned or shards unaccounted while each individual
    shard job stays green.
5.  ``test_the_shard_job_is_unconditional`` -- adding ANY job-level ``if:`` to
    the shard job (e.g. restoring ``steps.relevant.outputs.run``).
6.  ``test_the_adjudicator_runs_even_when_a_shard_fails`` -- REMOVING the merge
    job's ``if: ${{ !cancelled() }}``, which by GitHub's default would SKIP the
    adjudicator whenever a shard failed, turning "red, and here is the surviving
    arm" into "skipped".
7.  ``test_no_step_is_conditional_except_the_receipt_upload`` -- ``if:`` on any
    step of either job other than ``always()`` on the receipt upload; the
    verbatim pre-split shape ``if: steps.relevant.outputs.run == 'true' &&
    matrix.python-version == '3.10'`` is the input this is aimed at.
8.  ``test_the_matrix_steps_are_exactly_their_commands`` -- wrapping a command
    in shell control flow (``if ! git diff ...; then exit 0; fi``), which is a
    narrowing no ``if:``-shaped assertion above can see.
9.  ``test_the_shard_receipt_is_uploaded_on_every_path`` -- dropping
    ``if: always()`` or ``if-no-files-found: error`` from the upload. Without
    the first, a shard that finds a SURVIVOR uploads nothing and is reported as
    "never ran"; without the second, a shard that produced no receipt uploads
    an empty artifact and reads as present.
10. ``test_the_pull_request_trigger_has_no_path_filter`` -- adding ``paths:`` or
    ``paths-ignore:`` under ``on.pull_request``, which would skip the whole
    workflow (and therefore both jobs) on a PR that touches no listed path.
11. ``test_the_parser_can_see_a_conditional_step`` -- THE POSITIVE CONTROL for
    (5)(7). Those assert an ABSENCE, and an absence-only assertion is satisfied
    by an instrument that can no longer find anything: if the YAML shape changed
    under this parser, ``if:`` would read as absent everywhere and both would
    report green over a fully gated job. This pins that the same parser DOES
    find the conditional steps in ``python-tests``.
12. ``test_no_required_context_from_this_workflow_lost_its_producer`` -- renaming
    any of the SEVEN required contexts this workflow publishes. The shard split
    adds a job name; it must not move one.
13. ``test_the_matrix_result_is_reported_on_the_pr`` -- dropping either drain
    job from ``pr-summary``. An advisory check nobody surfaces is the "control
    that stops reporting" failure #4712 is about.
"""

from __future__ import annotations

import itertools
import json
import re
from pathlib import Path
from typing import Any

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "test.yml"
REQUIRED_CONTEXTS = REPO_ROOT / "tools" / "drain" / "required_contexts.json"

#: The job keys. Named once so a rename fails in ONE place with a readable
#: message rather than as a handful of confusing absences.
SHARD_JOB = "drain-mutation-shard"
MERGE_JOB = "drain-mutation-matrix"

#: The script whose invocation IS the guarantee. Matched as a PREFIX because
#: the shard job now passes `--shard i/N --receipt ...` and the merge job passes
#: `--adjudicate ...`; the exact bodies are pinned separately in (8).
MATRIX_SCRIPT = "python tools/drain/mutate_gates.py"

#: The one condition permitted on a step of either job, and only on the upload.
#: An allowlist rather than a widening: the assertion it replaces was
#: "no step is conditional", and its own message named `always()` on an upload
#: as the anticipated exception.
ALLOWED_STEP_IF = "always()"

WORKFLOW_TEXT = WORKFLOW.read_text(encoding="utf-8")
DOC = yaml.safe_load(WORKFLOW_TEXT)
JOBS = DOC["jobs"]

#: PyYAML resolves the bare key `on:` to the boolean True under YAML 1.1. Read
#: it by that key rather than by the string, and say so -- `DOC["on"]` raises
#: KeyError here and the resulting failure reads like a missing trigger.
TRIGGERS = DOC[True]

_MATRIX_REF = re.compile(r"\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}")


def _job(key: str) -> dict[str, Any]:
    """One of the two jobs, or a hard failure naming what is gone."""
    job = JOBS.get(key)
    if not isinstance(job, dict):
        pytest.fail(
            f"{WORKFLOW.name} has no job {key!r} (got {type(job).__name__}). "
            "Every assertion in this file is about the two drain-matrix jobs; "
            "without them they would pass vacuously. If the matrix moved again, "
            "repoint SHARD_JOB/MERGE_JOB -- do not delete this file, which is "
            "the only thing asserting the matrix still runs over every arm."
        )
    return job


def _steps(key: str) -> list[dict[str, Any]]:
    return [s for s in (_job(key).get("steps") or []) if isinstance(s, dict)]


def _step_running(key: str, needle: str) -> dict[str, Any]:
    """The single step of ``key`` whose ``run`` contains ``needle``."""
    hits = [s for s in _steps(key) if needle in str(s.get("run") or "")]
    assert len(hits) == 1, (
        f"expected exactly one step in {key!r} running {needle!r}, found "
        f"{len(hits)}. Two would pay the cost twice; zero is the guarantee gone."
    )
    return hits[0]


def _rendered_names(job: dict[str, Any]) -> set[str]:
    """Every status-check name a job publishes, matrix expanded.

    `Python Tests (3.10)` is not a literal anywhere in the workflow -- the job
    carries `name: Python Tests (${{ matrix.python-version }})`. Comparing the
    required-context list against raw `name:` strings would therefore find
    nothing and report it as agreement.
    """
    name = str(job.get("name") or "")
    if not name:
        return set()
    keys = sorted(set(_MATRIX_REF.findall(name)))
    if not keys:
        return {name}
    matrix = (job.get("strategy") or {}).get("matrix") or {}
    value_lists = []
    for key in keys:
        values = matrix.get(key)
        if not isinstance(values, list) or not values:
            # An unresolvable axis must not silently narrow the rendered set --
            # that would let a rename hide behind "we could not expand it".
            pytest.fail(
                f"job name {name!r} interpolates matrix.{key}, which its "
                f"`strategy.matrix` does not define as a non-empty list "
                f"(got {values!r})."
            )
        value_lists.append([str(v) for v in values])
    out: set[str] = set()
    for combo in itertools.product(*value_lists):
        rendered = name
        # strict=True is not decoration: `keys` and `combo` are the same length
        # by construction (the product is built FROM `keys`), so a mismatch
        # means the construction changed and a rendered name would silently
        # lose an axis -- which is how a rename would hide from this file.
        for key, value in zip(keys, combo, strict=True):
            rendered = re.sub(
                r"\$\{\{\s*matrix\." + re.escape(key) + r"\s*\}\}", value, rendered
            )
        out.add(rendered)
    return out


# --------------------------------------------------------------------------- #
# 1-4: the matrix runs, over every arm, with somebody checking that it did
# --------------------------------------------------------------------------- #

def test_a_job_runs_the_mutation_matrix() -> None:
    """BREAKS ON: deleting or renaming the `python tools/drain/mutate_gates.py`
    shard command. Searched across EVERY job, not just the expected one, so
    moving it elsewhere is reported as a move rather than as a deletion."""
    owners = sorted({
        key
        for key, job in JOBS.items()
        for step in (job.get("steps") or [])
        if MATRIX_SCRIPT in str(step.get("run") or "")
    })
    assert owners, (
        f"no job in {WORKFLOW.name} runs {MATRIX_SCRIPT!r}. The drain mutation "
        "matrix certifies that the drain suite is not blind; nothing else in "
        "the repo runs it, so this is the whole control."
    )
    assert owners == sorted([SHARD_JOB, MERGE_JOB]), (
        f"{MATRIX_SCRIPT!r} is run by {owners}, expected exactly "
        f"{sorted([SHARD_JOB, MERGE_JOB])}. Running the arms twice pays the "
        "whole cost twice; running them somewhere else leaves this file "
        "asserting an empty job."
    )


def test_a_job_adjudicates_the_shards() -> None:
    """BREAKS ON: deleting the `--adjudicate` step, or moving it into the shard
    job where it would grade only its own shard.

    THIS IS #4679's LESSON. After vitest was sharded, the merge job went green
    in 98s over shards that had not run, and the gate pointed at it froze the
    estate for two days. A merge job that merely CONCLUDES after its `needs` is
    not a control; something has to read the shards and refuse.
    """
    step = _step_running(MERGE_JOB, "--adjudicate")
    body = str(step.get("run"))
    assert "--shards" in body, (
        f"the adjudicate step does not pass --shards:\n{body!r}\n"
        "Without it the adjudicator cannot know how many receipts to expect, "
        "so a shard that never ran is an absence with nothing to compare against."
    )
    assert _job(MERGE_JOB).get("needs") == SHARD_JOB, (
        f"job {MERGE_JOB!r} does not `needs: {SHARD_JOB}` (got "
        f"{_job(MERGE_JOB).get('needs')!r}). Without the dependency it can run "
        "BEFORE the shards and adjudicate an empty directory."
    )


def test_the_adjudicator_reads_the_shard_jobs_result() -> None:
    """BREAKS ON: `--needs-result success` written as a literal.

    A shard that overruns `timeout-minutes` concludes CANCELLED; one that is
    never scheduled concludes SKIPPED. Neither measured anything. The
    adjudicator refuses both BY NAME, which it can only do if the real
    aggregate is passed in -- a hardcoded `success` makes that refusal
    unreachable, which is an assertion that cannot fail.
    """
    body = str(_step_running(MERGE_JOB, "--adjudicate").get("run"))
    expected = f"--needs-result ${{{{ needs.{SHARD_JOB}.result }}}}"
    assert expected in body, (
        f"the adjudicate step does not pass the real shard result. Expected to "
        f"find {expected!r} in:\n{body!r}\n"
        "`needs.<job>.result` on a matrix job is the AGGREGATE -- 'success' "
        "only when every shard succeeded -- and it is the only in-workflow "
        "signal that distinguishes a cancelled shard from a passing one."
    )


def test_the_shard_count_agrees_in_all_four_places() -> None:
    """THE COUPLING GUARD. BREAKS ON: changing `shard: [1..6]` without changing
    the `/6` in the job name, the `/6` in `--shard`, or `--shards 6`.

    Every one of those disagreements leaves the matrix looking green while it
    covers less than `ARMS`:

      matrix [1..6] + `--shard i/5`  -> shard 6 is refused at parse (out of
                                        range), but 1..5 each run a FIFTH, so
                                        five sixths of a five-way partition
                                        runs and the sixth job is the only red.
      matrix [1..5] + `--shard i/6`  -> five shards run 5/6 of the arms and all
                                        five are GREEN. Only the adjudicator's
                                        union check catches it at run time.
      `--shards 5` in the adjudicator -> it demands five receipts, gets six,
                                        and refuses for the wrong reason.
      a stale `/6` in the job NAME   -> the roll-gate-shaped consumer reads the
                                        denominator off the name (#4679) and
                                        adjudicates the wrong topology.

    The run-time union check is the real backstop; this makes the breakage
    surface on the PR that causes it rather than on the next matrix run.
    """
    job = _job(SHARD_JOB)
    axis = (job.get("strategy") or {}).get("matrix", {}).get("shard")
    assert isinstance(axis, list), (
        f"{SHARD_JOB!r} has `strategy.matrix.shard` of type "
        f"{type(axis).__name__}, not a list (got {axis!r})."
    )
    assert axis, (
        f"{SHARD_JOB!r} has no `strategy.matrix.shard` list (got {axis!r}); "
        "there is no shard count for the other three places to agree with."
    )
    assert axis == list(range(1, len(axis) + 1)), (
        f"`strategy.matrix.shard` is {axis!r}, expected 1..{len(axis)} "
        "contiguous. `--shard i/N` requires 1 <= i <= N and the adjudicator "
        "expects receipts for exactly {1..N}; a gap means a permanently "
        "missing receipt and a duplicate means two receipts claiming one shard."
    )
    n = len(axis)

    name = str(job.get("name") or "")
    assert f"/{n} " in name or name.endswith(f"/{n}"), (
        f"job name {name!r} does not carry '/{n}', but `strategy.matrix.shard` "
        f"has {n} entries. The denominator in the name is what an external "
        "consumer reads the topology from (#4679)."
    )

    shard_body = str(_step_running(SHARD_JOB, "--shard").get("run"))
    assert f"--shard ${{{{ matrix.shard }}}}/{n}" in shard_body, (
        f"the shard step does not invoke `--shard ${{{{ matrix.shard }}}}/{n}`:"
        f"\n{shard_body!r}\nThe denominator must equal the matrix length, or "
        "the partition and the dispatch are describing different topologies."
    )

    merge_body = str(_step_running(MERGE_JOB, "--adjudicate").get("run"))
    assert f"--shards {n}" in merge_body, (
        f"the adjudicate step does not pass `--shards {n}`:\n{merge_body!r}\n"
        f"It would demand a different number of receipts than the {n} shards "
        "this workflow dispatches."
    )


# --------------------------------------------------------------------------- #
# 5-9: it runs unconditionally, and its verdict is never silently skipped
# --------------------------------------------------------------------------- #

def test_the_shard_job_is_unconditional() -> None:
    """BREAKS ON: any job-level `if:` on the shard job.

    The pre-split step was gated `steps.relevant.outputs.run == 'true'`, which
    made the matrix skip on a PR touching no Python path. Lifting that gate to
    the job would reproduce it exactly, and the job would report `skipped` --
    indistinguishable, on a non-required check, from "nothing to do".
    """
    job = _job(SHARD_JOB)
    assert "if" not in job, (
        f"job {SHARD_JOB!r} carries a job-level `if:` ({job.get('if')!r}). It "
        "must run on every PR, push, merge group and dispatch. This job is NOT "
        "a required context, so a skip here is silent: there is no branch "
        "protection to notice the absence."
    )


def test_the_adjudicator_runs_even_when_a_shard_fails() -> None:
    """BREAKS ON: removing the merge job's `if:`, or writing any other
    condition there.

    This is the ONE place a job-level `if:` is required rather than forbidden,
    and the direction is the opposite of (5). GitHub's DEFAULT skips a job whose
    `needs` failed -- so without this, a shard that finds a SURVIVING ARM (the
    single outcome the whole matrix exists to produce) would turn the
    adjudicator from `failure` into `skipped`. On an advisory check that is the
    difference between a finding and a silence.

    Pinned to the exact literal rather than "some `if:` exists", because
    `always()` would ALSO run it on a cancelled RUN -- adjudicating shards that
    a human deliberately stopped -- and `success()` would reintroduce the skip.
    """
    actual = _job(MERGE_JOB).get("if")
    assert actual == "${{ !cancelled() }}", (
        f"job {MERGE_JOB!r} has `if: {actual!r}`, expected '${{{{ !cancelled() }}}}'. "
        "Absent, a failing shard SKIPS the adjudicator and the survivor is "
        "never reported; `always()` would adjudicate a run the operator cancelled."
    )


def test_no_step_is_conditional_except_the_receipt_upload() -> None:
    """BREAKS ON: `if:` on any step of either job other than `always()` on the
    receipt upload -- in particular the verbatim pre-split gate
    `steps.relevant.outputs.run == 'true' && matrix.python-version == '3.10'`.

    Scoped to every step, not just the matrix step: gating the INSTALL step
    would leave the matrix step running without `pytest`, and the whole point
    of the job is that its verdict means something.

    `always()` on the upload is ALLOWLISTED, not tolerated. It is
    unconditional-by-construction -- it makes the step run MORE, not less -- and
    it is load-bearing: without it a shard that exits non-zero on a survivor
    uploads nothing, and the adjudicator reports "shard N never ran", replacing
    a true finding with a false one. The assertion this replaces named exactly
    this case ("`always()` on an upload, say") as the anticipated exception.
    """
    gated = [
        (key, str(step.get("name") or step.get("uses") or "<unnamed>"), step["if"])
        for key in (SHARD_JOB, MERGE_JOB)
        for step in _steps(key)
        if "if" in step and str(step["if"]).strip() != ALLOWED_STEP_IF
    ]
    assert not gated, (
        f"steps are conditional with something other than {ALLOWED_STEP_IF!r}: "
        f"{gated}. The matrix must run unconditionally. Widen this allowlist "
        "only for another condition that runs a step MORE often -- never for "
        "one that can decide not to run it, which is the shape #4555 removed."
    )


def test_the_matrix_steps_are_exactly_their_commands() -> None:
    """BREAKS ON: wrapping either command in shell control flow.

    A narrowing does not have to be spelled `if:`. `if ! git diff --quiet ...;
    then exit 0; fi` around the command skips the matrix while every assertion
    above stays green -- the same class of defect as the 103-byte extension
    test that defeated a text-scan in `test_python_trigger_scope.py`.

    The bodies are pinned as single-line invocations of the script with nothing
    else on them, so the only narrowing either can express is `--shard`, whose
    consequences the adjudicator's union check refuses.
    """
    n = len((_job(SHARD_JOB).get("strategy") or {}).get("matrix", {}).get("shard") or [])
    expected = {
        SHARD_JOB: (
            f"{MATRIX_SCRIPT} --shard ${{{{ matrix.shard }}}}/{n} "
            "--receipt shard-receipt.json"
        ),
        MERGE_JOB: (
            f"{MATRIX_SCRIPT} --adjudicate shard-receipts --shards {n} "
            f"--needs-result ${{{{ needs.{SHARD_JOB}.result }}}}"
        ),
    }
    for key, want in expected.items():
        body = str(_step_running(key, MATRIX_SCRIPT).get("run")).strip()
        assert body == want, (
            f"the {key!r} matrix step's body is not the bare command.\n"
            f"  got:      {body!r}\n  expected: {want!r}\n"
            "Anything around it can decide not to run it, or can decide which "
            "arms run, without tripping any `if:`-shaped assertion in this file."
        )


def test_the_shard_receipt_is_uploaded_on_every_path() -> None:
    """BREAKS ON: dropping `if: always()` or `if-no-files-found: error` from the
    upload step.

    The receipt is the ONLY thing that distinguishes a shard which refused (and
    can say why) from one that never ran. Both halves are load-bearing and they
    fail in opposite directions:

      no `always()`          -> a shard that finds a SURVIVOR exits non-zero,
                                skips the upload, and is misreported as NOT-RUN.
      no `if-no-files-found` -> a shard whose receipt was never written uploads
                                an EMPTY artifact, the adjudicator downloads a
                                directory with no JSON in it, and the diagnosis
                                is "no receipts at all" rather than "shard N".
    """
    uploads = [s for s in _steps(SHARD_JOB) if "upload-artifact" in str(s.get("uses") or "")]
    assert len(uploads) == 1, (
        f"expected exactly one upload-artifact step in {SHARD_JOB!r}, found "
        f"{len(uploads)}. Without it no receipt reaches the adjudicator and "
        "EVERY shard reads as never-run."
    )
    step = uploads[0]
    assert str(step.get("if") or "").strip() == ALLOWED_STEP_IF, (
        f"the receipt upload has `if: {step.get('if')!r}`, expected "
        f"{ALLOWED_STEP_IF!r}. By default a step is skipped once an earlier one "
        "failed -- which is precisely the run whose receipt matters most."
    )
    assert (step.get("with") or {}).get("if-no-files-found") == "error", (
        "the receipt upload does not set `if-no-files-found: error` (got "
        f"{(step.get('with') or {}).get('if-no-files-found')!r}). A shard that "
        "produced no receipt must fail at the source, which names it; the "
        "adjudicator can only report that one is missing."
    )


def test_the_pull_request_trigger_has_no_path_filter() -> None:
    """BREAKS ON: adding `paths:` / `paths-ignore:` under `on.pull_request`.

    A path filter there suppresses the whole workflow run on a PR that touches
    nothing listed -- so the matrix would not merely skip, it would never be
    created. The workflow already carries a comment saying this filter must not
    exist; this asserts it.
    """
    pull_request = TRIGGERS.get("pull_request")
    assert isinstance(pull_request, dict), (
        f"`on.pull_request` is {pull_request!r}; this file's claim that the "
        "matrix runs on every PR rests on that trigger existing."
    )
    for key in ("paths", "paths-ignore"):
        assert key not in pull_request, (
            f"`on.pull_request.{key}` is set to {pull_request[key]!r}. The "
            f"{SHARD_JOB!r} job cannot run on a PR whose run is never created."
        )


def test_the_parser_can_see_a_conditional_step() -> None:
    """POSITIVE CONTROL for the two absence-only assertions above.

    `test_the_shard_job_is_unconditional` and
    `test_no_step_is_conditional_except_the_receipt_upload` both assert that
    something is NOT there. Such an assertion is satisfied just as well by an
    instrument that can no longer find anything -- a YAML shape change, a
    different key spelling, a parser returning strings instead of mappings --
    and would then report green over a fully gated job.

    BREAKS ON: `if:` becoming invisible to this parser. `python-tests` gates its
    heavy steps on `steps.relevant.outputs.run`, so the same read over the same
    document must find those.
    """
    conditional = [
        step.get("if")
        for step in (JOBS["python-tests"].get("steps") or [])
        if "if" in step
    ]
    assert conditional, (
        "the `python-tests` job parsed to ZERO conditional steps. It gates "
        "every heavy step on `steps.relevant.outputs.run`, so this read is "
        "broken -- and the two absence assertions above are therefore vacuous, "
        "not green."
    )
    assert any("steps.relevant.outputs.run" in str(c) for c in conditional), (
        "no `python-tests` step is gated on `steps.relevant.outputs.run`. "
        f"Found: {conditional!r}. If that detector was removed on purpose, this "
        "control needs a new reference conditional -- it must point at one that "
        "really exists."
    )


def test_no_required_context_from_this_workflow_lost_its_producer() -> None:
    """BREAKS ON: renaming `python-tests` or `dbt-compile`'s `name:`.

    This workflow publishes SEVEN of `main`'s required contexts. Sharding the
    matrix ADDS a job name; it must not move one, because a required context
    whose producer no longer emits it reports nothing and leaves a PR (and a
    merge group) pending forever.

    `required_contexts.json` is a snapshot of branch protection, not the live
    API, so this compares the file against the workflow -- a rename on either
    side of that pair is what turns it red.
    """
    snapshot = json.loads(REQUIRED_CONTEXTS.read_text(encoding="utf-8"))
    required = set(snapshot["contexts"])
    assert required, "an empty required-context snapshot would make this vacuous"

    published = set()
    for job in JOBS.values():
        published |= _rendered_names(job)

    # The seven this workflow owns, derived from the two producing jobs rather
    # than transcribed -- a transcribed list is a second copy that has to be
    # kept in agreement by review, which is defect #3862's shape.
    owned = (_rendered_names(JOBS["python-tests"])
             | _rendered_names(JOBS["dbt-compile"])) & required
    assert len(owned) == 7, (
        f"expected this workflow to own 7 required contexts, found {len(owned)}: "
        f"{sorted(owned)}. Either a job name moved (the defect this guards) or "
        "the required set changed and `required_contexts.json` needs a refresh."
    )
    missing = owned - published
    assert not missing, f"required contexts with no producing job here: {sorted(missing)}"


def test_the_matrix_result_is_reported_on_the_pr() -> None:
    """BREAKS ON: dropping either drain job from `pr-summary`'s `needs` or from
    the table its script builds.

    The matrix is ADVISORY on branch protection, so the PR comment is where a
    human sees it. #4712's whole finding is that a control which stops
    reporting is indistinguishable from one that watches nothing -- and the
    cancelled matrix was visible exactly once, in the run that cancelled it.

    BOTH jobs are required here because they answer different questions: the
    shard aggregate says whether the arms RAN, the adjudicator says whether
    they all DIED. Shards `cancelled` + matrix `failure` is a timeout; shards
    `success` + matrix `failure` is a real surviving arm.
    """
    summary = _job("pr-summary")
    needs = summary.get("needs") or []
    for key in (SHARD_JOB, MERGE_JOB):
        assert key in needs, (
            f"`pr-summary` does not `needs: {key}` (got {needs!r}), so its "
            "result is {} in the table and renders as 'skipped' regardless of "
            "what the job actually did."
        )
    script = "\n".join(str(s.get("with", {}).get("script") or "") for s in _steps("pr-summary"))
    assert script.strip(), "could not read `pr-summary`'s github-script body"
    for key in (SHARD_JOB, MERGE_JOB):
        assert f"'{key}'" in script, (
            f"`pr-summary`'s table does not list {key!r}. A job in `needs` but "
            "not in the table is paid for and never shown."
        )
