"""The drain mutation matrix must RUN on every PR (#4555).

`tools/drain/mutate_gates.py` is the instrument that certifies the drain's test
suite is not blind. On 2026-09-19 it moved out of the ``python-tests`` job --
where it was a step gated on ``steps.relevant.outputs.run`` and pinned to the
3.10 leg -- into its own ``drain-mutation-matrix`` job, because at 330 arms it
was ~70% of a REQUIRED context's runtime and that context died against its
``timeout-minutes`` wall twice (45m00s with zero margin at 2843bd3cc49, then
45m18s CANCELLED at 33856071b2c, blocking five PRs).

THE SPLIT MOVED THE SIGNAL OUT OF THE BLOCKING SET. Branch protection is not a
workflow file, so ``Drain Mutation Matrix (3.10)`` is advisory: a red there does
not block a merge. That makes the remaining guarantee -- *it still runs, on
every PR, over the whole suite* -- the only thing standing between this repo and
a mutation matrix that silently watches nothing, which is a strictly worse
outcome than the timeout it replaced.

A guarantee stated only in a YAML comment is one edit from being false, and this
file exists so that edit is RED instead of quiet.

What is asserted here, and the value that breaks each
-----------------------------------------------------
1. ``test_a_job_runs_the_mutation_matrix`` -- deleting or renaming the
   ``python tools/drain/mutate_gates.py`` command.
2. ``test_the_matrix_job_is_unconditional`` -- adding ANY job-level ``if:`` to
   ``drain-mutation-matrix`` (e.g. restoring ``steps.relevant.outputs.run``).
3. ``test_no_step_in_the_matrix_job_is_conditional`` -- adding ``if:`` to any
   step of that job; the verbatim pre-split shape
   ``if: steps.relevant.outputs.run == 'true' && matrix.python-version ==
   '3.10'`` is the input this is aimed at.
4. ``test_the_matrix_step_is_exactly_the_command`` -- wrapping the command in
   shell control flow (``if ! git diff ...; then exit 0; fi``), which is a
   narrowing no ``if:``-shaped assertion above can see.
5. ``test_the_pull_request_trigger_has_no_path_filter`` -- adding ``paths:`` or
   ``paths-ignore:`` under ``on.pull_request``, which would skip the whole
   workflow (and therefore this job) on a PR that touches no listed path.
6. ``test_the_parser_can_see_a_conditional_step`` -- THE POSITIVE CONTROL for
   (2)(3). Those two assert an ABSENCE, and an absence-only assertion is
   satisfied by an instrument that can no longer find anything: if the YAML
   shape changed under this parser, ``if:`` would read as absent everywhere and
   both would report green over a fully gated job. This pins that the same
   parser DOES find the conditional steps in ``python-tests``.
7. ``test_no_required_context_from_this_workflow_lost_its_producer`` -- renaming
   any of the SEVEN required contexts this workflow publishes. The split adds a
   job name; it must not move one.
"""

from __future__ import annotations

import itertools
import json
import re
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "test.yml"
REQUIRED_CONTEXTS = REPO_ROOT / "tools" / "drain" / "required_contexts.json"

#: The job key the matrix lives in. Named once so a rename fails in ONE place
#: with a readable message rather than as four confusing absences.
MATRIX_JOB = "drain-mutation-matrix"

#: The command whose presence IS the guarantee.
MATRIX_COMMAND = "python tools/drain/mutate_gates.py"

WORKFLOW_TEXT = WORKFLOW.read_text(encoding="utf-8")
DOC = yaml.safe_load(WORKFLOW_TEXT)
JOBS = DOC["jobs"]

#: PyYAML resolves the bare key `on:` to the boolean True under YAML 1.1. Read
#: it by that key rather than by the string, and say so -- `DOC["on"]` raises
#: KeyError here and the resulting failure reads like a missing trigger.
TRIGGERS = DOC[True]

_MATRIX_REF = re.compile(r"\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}")


def _matrix_job() -> dict:
    """The matrix job, or a hard failure naming what is gone."""
    job = JOBS.get(MATRIX_JOB)
    if job is None:
        pytest.fail(
            f"{WORKFLOW.name} has no job {MATRIX_JOB!r}. Every assertion in this "
            "file is about that job; without it they would pass vacuously. If "
            "the matrix moved again, repoint MATRIX_JOB -- do not delete this "
            "file, which is the only thing asserting the matrix still runs."
        )
    return job


def _rendered_names(job: dict) -> set[str]:
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
    out = set()
    for combo in itertools.product(*value_lists):
        rendered = name
        for key, value in zip(keys, combo):
            rendered = re.sub(
                r"\$\{\{\s*matrix\." + re.escape(key) + r"\s*\}\}", value, rendered
            )
        out.add(rendered)
    return out


# --------------------------------------------------------------------------- #
# 1-4: the matrix runs, unconditionally, over the whole suite
# --------------------------------------------------------------------------- #

def test_a_job_runs_the_mutation_matrix():
    """BREAKS ON: deleting or editing the `python tools/drain/mutate_gates.py`
    command. Searched across EVERY job, not just the expected one, so moving it
    elsewhere is reported as a move rather than as a deletion."""
    owners = [
        key
        for key, job in JOBS.items()
        for step in (job.get("steps") or [])
        if MATRIX_COMMAND in str(step.get("run") or "")
    ]
    assert owners, (
        f"no job in {WORKFLOW.name} runs {MATRIX_COMMAND!r}. The drain mutation "
        "matrix certifies that the drain suite is not blind; nothing else in "
        "the repo runs it, so this is the whole control."
    )
    assert owners == [MATRIX_JOB], (
        f"{MATRIX_COMMAND!r} is run by {owners}, expected exactly [{MATRIX_JOB!r}]. "
        "Running it twice pays the whole cost twice; running it somewhere else "
        "leaves this file asserting an empty job."
    )


def test_the_matrix_job_is_unconditional():
    """BREAKS ON: any job-level `if:` on the matrix job.

    The pre-split step was gated `steps.relevant.outputs.run == 'true'`, which
    made the matrix skip on a PR touching no Python path. Lifting that gate to
    the job would reproduce it exactly, and the job would report `skipped` --
    indistinguishable, on a non-required check, from "nothing to do".
    """
    job = _matrix_job()
    assert "if" not in job, (
        f"job {MATRIX_JOB!r} carries a job-level `if:` ({job.get('if')!r}). It "
        "must run on every PR, push, merge group and dispatch. This job is NOT "
        "a required context, so a skip here is silent: there is no branch "
        "protection to notice the absence."
    )


def test_no_step_in_the_matrix_job_is_conditional():
    """BREAKS ON: `if:` on any step of the matrix job -- in particular the
    verbatim pre-split gate
    `steps.relevant.outputs.run == 'true' && matrix.python-version == '3.10'`.

    Scoped to every step, not just the matrix step: gating the INSTALL step
    would leave the matrix step running without `pytest`, and the whole point
    of the job is that its verdict means something.
    """
    job = _matrix_job()
    gated = [
        (str(step.get("name") or step.get("uses") or "<unnamed>"), step["if"])
        for step in (job.get("steps") or [])
        if "if" in step
    ]
    assert not gated, (
        f"steps in {MATRIX_JOB!r} are conditional: {gated}. The matrix must run "
        "unconditionally. If a genuinely unconditional-by-construction "
        "condition is ever needed here (`always()` on an upload, say), relax "
        "THIS assertion deliberately and say why -- do not widen it to 'the "
        "matrix step only', which is the shape that was just removed."
    )


def test_the_matrix_step_is_exactly_the_command():
    """BREAKS ON: wrapping the command in shell control flow.

    A narrowing does not have to be spelled `if:`. `if ! git diff --quiet ...;
    then exit 0; fi` around the command skips the matrix while every assertion
    above stays green -- the same class of defect as the 103-byte extension
    test that defeated a text-scan in `test_python_trigger_scope.py`.
    """
    job = _matrix_job()
    runs = [
        str(step.get("run"))
        for step in (job.get("steps") or [])
        if MATRIX_COMMAND in str(step.get("run") or "")
    ]
    assert len(runs) == 1, f"expected one matrix step in {MATRIX_JOB!r}, got {len(runs)}"
    body = runs[0].strip()
    assert body == MATRIX_COMMAND, (
        f"the matrix step's body is not the bare command:\n{body!r}\n"
        "Anything around it can decide not to run it, or can decide which arms "
        "run, without tripping any `if:`-shaped assertion in this file."
    )


def test_the_pull_request_trigger_has_no_path_filter():
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
            f"{MATRIX_JOB!r} job cannot run on a PR whose run is never created."
        )


def test_the_parser_can_see_a_conditional_step():
    """POSITIVE CONTROL for the two absence-only assertions above.

    `test_the_matrix_job_is_unconditional` and
    `test_no_step_in_the_matrix_job_is_conditional` both assert that something
    is NOT there. Such an assertion is satisfied just as well by an instrument
    that can no longer find anything -- a YAML shape change, a different key
    spelling, a parser returning strings instead of mappings -- and would then
    report green over a fully gated job.

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


def test_no_required_context_from_this_workflow_lost_its_producer():
    """BREAKS ON: renaming `python-tests` or `dbt-compile`'s `name:`.

    This workflow publishes SEVEN of `main`'s required contexts. Splitting the
    matrix out ADDS a job name; it must not move one, because a required
    context whose producer no longer emits it reports nothing and leaves a PR
    (and a merge group) pending forever.

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
