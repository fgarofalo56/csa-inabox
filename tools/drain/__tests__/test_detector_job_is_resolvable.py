"""#4701 arm: the declaration must be checkable in the CONSUMER's namespace.

`test_ci_green_declared.py` validates every `detector_job` against the WORKFLOW
YAML, where a job KEY is the correct identifier. The consumer -- `gates.py` at
merge time -- reads the JOBS API, which reports the display `name:`. Those are
different strings, and on 2026-09-25 they differed for the only row that
declares the field:

    policy.json   detector_job = 'vitest-detect'          <- the YAML key
    jobs API      name         = 'vitest — detect changes' <- what the consumer sees (U+2014)

The existing test passes, correctly, against the source where the declaration
IS right. No input to it can turn it red on that mismatch. That is the
`assertion-design.md` shape: a control that reads the one namespace where its
subject is correct cannot witness a defect in the other.

These arms close it by checking the MAPPING rather than the declaration --
i.e. that `gates._detector_display_name` translates the declared key into
something the jobs API would actually report.
"""
from __future__ import annotations

import json
import pathlib
import sys

_HERE = pathlib.Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parents[1]))

import gates  # noqa: E402


def _workflow_root() -> pathlib.Path | None:
    """The tree holding `.github/workflows`, in the repo OR in the sandbox.

    Walks UP looking for the marker rather than counting `parents[n]`. An
    earlier revision of this file used `parents[3]`, which resolved to `/` when
    the mutation runner copied the package to a temp dir -- the control run
    died on `FileNotFoundError: /tools/drain/policy.json` and the harness
    correctly refused to score anything ("REFUSING -- control is not green").

    `test_ci_green_declared.py` already carries this helper and a comment
    explaining exactly that failure. This is the same walk, deliberately keyed
    on `.github/workflows` ALONE and NOT on `scripts/ci`.

    WHY, CORRECTED: an earlier revision of this docstring said the two-marker
    form would SKIP these arms in the sandbox. It would not -- this module
    contains no `pytest.skip`, so a `None` root makes the arms assert RED, and
    the mutation harness would refuse to score again on a dead control, exactly
    as it did on `parents[3]`. A reviewer measured that by deleting `.github`
    from a sandbox copy. Same remedy, different mechanism, and the mechanism is
    the part a future reader needs.

    The tautology the two-marker form guards against elsewhere is real and is
    not this: `_repo_root` keeps `scripts/ci` so that tests shelling out to
    `node` and `gh api` skip in the sandbox rather than firing a network
    request on every arm. These arms read two files and call two pure
    functions, so they have nothing to skip for.
    """
    for candidate in _HERE.parents:
        if (candidate / ".github" / "workflows").is_dir():
            return candidate
    return None


#: `policy.json` sits beside `gates.py`, so it is resolved from the imported
#: module rather than from a path walk -- it travels with the package into the
#: sandbox, and asking the module where it lives cannot disagree with the
#: module the test is exercising.
POLICY_PATH = pathlib.Path(gates.__file__).resolve().parent / "policy.json"
POLICY = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
SCOPE_ROWS = POLICY["receipts"]["ci_green_rule"]["scope_paths"]

#: Rows that declare a cross-job detector. A row with no `detector_job` resolves
#: to its own job and is not in this arm's scope.
CROSS_JOB_ROWS = {
    name: row for name, row in SCOPE_ROWS.items()
    if isinstance(row, dict) and row.get("detector_job")
}


def _workflow_text(path: str) -> str | None:
    root = _workflow_root()
    if root is None:
        return None
    p = root / path
    return p.read_text(encoding="utf-8") if p.is_file() else None


def _workflow_for(row: dict) -> str | None:
    """The workflow file a scope row describes.

    Read from the row's own `workflow` key rather than inferred from its path
    globs. An earlier draft of this arm guessed it out of the `outputs[].paths`
    entries, found nothing, and failed loudly -- which was the correct outcome
    but for the wrong reason, and would have gone quiet the moment any glob
    happened to name a workflow.
    """
    wf = row.get("workflow")
    return wf if isinstance(wf, str) and wf else None


def test_the_declaration_is_resolvable_in_the_consumer_namespace():
    """Every declared `detector_job` maps to the `name:` its workflow declares.

    WHAT VALUE WOULD MAKE THIS FAIL: a `detector_job` naming a key that is not
    in its workflow's `jobs:` block -- which is what a rename or a job split
    produces, and is the state #4701 was filed for. It ALSO fails if
    `_detector_display_name` is reduced to the identity function, because the
    assertion below pins the mapped name against the file's own `name:`.

    SCOPE, STATED BECAUSE AN EARLIER NAME OVERCLAIMED IT. This arm does not
    consult the jobs API. It compares what `gates` parses out of the workflow
    against what this test re-parses out of the same text, so a reviewer
    measured that tampering with a sandbox workflow's `name:` leaves every arm
    here green -- both sides move together. What it pins is that the mapping
    agrees with the file, which is the half of #4701's second defect that is
    checkable offline; that the file agrees with the jobs API is established by
    the receipt runs in the PR body, not here.

    This is deliberately NOT "the key exists in the YAML" -- that is what the
    existing declaration test already checks, in the namespace where the
    declaration is correct by construction.
    """
    assert CROSS_JOB_ROWS, (
        "no scope row declares a `detector_job`, so this arm witnesses nothing. "
        "If the field was removed, delete this test rather than leaving it green."
    )
    for name, row in CROSS_JOB_ROWS.items():
        wf = _workflow_for(row)
        assert wf, f"{name}: no workflow path resolvable from its declared scopes"
        text = _workflow_text(wf)
        assert text, f"{name}: {wf} is not readable from the repo root"

        key = row["detector_job"]
        mapped = gates._detector_display_name(key, text)

        # The key must actually BE a job in that workflow. `_detector_display_name`
        # returns the key unchanged for an unknown key -- a deliberate
        # fall-through -- so this is the check that distinguishes "no explicit
        # name:" from "no such job".
        assert f"\n  {key}:\n" in text, (
            f"{name}: declared detector_job {key!r} is not a job key in {wf}. "
            "The declaration is stale; a lookup against the jobs API will find "
            "nothing and the receipt will refuse."
        )
        # And the mapped value must be what the jobs API would report: the
        # explicit `name:` when the job sets one, else the key.
        block = text.split(f"\n  {key}:\n", 1)[1]
        first = block.split("\n  ", 1)[0]
        explicit = None
        for line in first.splitlines():
            if line.startswith("    name:"):
                explicit = line.split("name:", 1)[1].strip().strip("'\"")
                break
        want = explicit if explicit is not None else key
        assert mapped == want, (
            f"{name}: detector_job {key!r} maps to {mapped!r} but {wf} declares "
            f"name: {want!r}. The consumer searches the jobs API by display "
            "name, so a wrong mapping finds no job and the receipt refuses."
        )


def test_negative_control_the_mapping_is_not_the_identity_function():
    """If `_detector_display_name` just returned its input, the arm above would
    still pass for any job that sets no `name:`. It must be shown to actually
    translate at least one real row, or it witnesses nothing.

    WHAT VALUE WOULD MAKE THIS FAIL: replacing the function body with
    `return key`. Measured 2026-09-25: `vitest-detect` -> `vitest - detect
    changes`, so the identity function is demonstrably wrong here.
    """
    translated = []
    for name, row in CROSS_JOB_ROWS.items():
        wf = _workflow_for(row)
        text = _workflow_text(wf) if wf else None
        if not text:
            continue
        key = row["detector_job"]
        if gates._detector_display_name(key, text) != key:
            translated.append((name, key))
    assert translated, (
        "no declared detector_job translates to a different display name, so "
        "this suite cannot distinguish the mapping from the identity function. "
        "That is the exact blindness #4701 records -- if every job legitimately "
        "sets no `name:`, say so at this site rather than deleting the arm."
    )


def test_an_unresolvable_detector_refuses_rather_than_searching_the_gated_job():
    """Fail-closed: a supplied sibling list that lacks the named detector is a
    refusal, never a fall-through to the gated job's own steps.

    WHAT VALUE WOULD MAKE THIS FAIL: changing `_detector_steps` to return
    `steps` instead of `None` when the sibling lookup misses. That is the
    difference between "we could not establish why the work was skipped" and
    silently accepting the wrong job's evidence.
    """
    row = {"gate_step": "Detect console changes", "detector_job": "absent-job"}
    gated = {"name": "vitest (node 20)", "steps": [
        {"name": "Detect console changes", "conclusion": "success"},
    ]}
    # The gated job DOES carry the gate step -- so a fall-through would accept.
    ok, why, _ = gates._declared_gate_ran(row, gated["steps"], (gated,), None)
    assert not ok, "a missing detector job must refuse, not fall through"
    assert "is not among the" in why, why
    assert "absent-job" in why, why


def test_two_jobs_with_the_declared_name_is_ambiguous_and_refuses():
    """A duplicate detector name must refuse, not let one leg answer for all.

    WHAT VALUE WOULD MAKE THIS FAIL: neutering the `len(matches) > 1` branch to
    `if False:`. An independent reviewer measured that mutation and found the
    WHOLE SUITE still green -- the refusal existed with no witness at all, which
    is the `assertion-design.md` shape this package keeps re-finding.

    It is REACHABLE, which is why it is worth a test rather than a disclosure.
    The green-at-merge branch builds its sibling list from `_jobs_by_name`,
    which is keyed by name and so cannot contain a duplicate. The rename branch
    builds it from `_jobs_of_run`, which is NOT deduped -- so a matrix job whose
    name does not interpolate (`vitest shard ${{ matrix.shard }}/4` is a real
    example in this repo) yields several jobs sharing one name, and one leg
    would otherwise answer for every leg.
    """
    row = {"gate_step": "Detect console changes", "detector_job": "dup"}
    leg_a = {"name": "dup", "run_id": 1, "steps": [
        {"name": "Detect console changes", "conclusion": "success"}]}
    leg_b = {"name": "dup", "run_id": 1, "steps": [
        {"name": "Detect console changes", "conclusion": "skipped"}]}
    gated = [{"name": "x", "conclusion": "success"}]

    ok, why, _ = gates._declared_gate_ran(row, gated, (leg_a, leg_b), None)
    assert not ok, "two jobs sharing the declared name must be ambiguous"
    assert "matches 2 jobs" in why, why

    # POSITIVE CONTROL: one leg alone resolves, so the refusal above is the
    # DUPLICATE and not something else about the fixture.
    ok_one, why_one, det = gates._declared_gate_ran(row, gated, (leg_a,), None)
    assert ok_one, why_one
    assert len(det) == 1


def test_a_detector_job_carrying_no_steps_refuses_with_its_own_message():
    """An empty-`steps` detector refuses, and says which of two things happened.

    WHAT VALUE WOULD MAKE THIS FAIL: neutering `if not dsteps:`. The verdict is
    unchanged by that mutation -- a detector with no steps also matches no
    `gate_step`, so the next branch refuses anyway -- but the MESSAGE changes,
    and this assertion pins the message.

    That distinction is the point rather than a technicality. "found but
    carries no steps" says the job exists and the jobs API returned nothing for
    it; "ABSENT from its declared detector job" says the step is not there.
    Those send an investigator to different places.

    Two earlier revisions of this docstring tried to describe the arm's kill
    power and got it wrong in opposite directions, each time inside the round
    fixing the previous one. Both reviewers found it. The description is gone;
    the assertion is the claim.
    """
    row = {"gate_step": "Detect console changes", "detector_job": "empty"}
    empty = {"name": "empty", "run_id": 1, "steps": []}
    ok, why, _ = gates._declared_gate_ran(
        row, [{"name": "x", "conclusion": "success"}], (empty,), None)
    assert not ok
    assert "carries no steps" in why, why


def test_no_sibling_list_falls_back_to_the_gated_job_deliberately():
    """The counterpart, and it is a DELIBERATE leniency rather than an oversight.

    With no sibling list there is nothing to look in, and the gated job's own
    steps are the historical answer. If that job carries the declared gate step,
    the step genuinely ran there and explains the skip.

    WHAT VALUE WOULD MAKE THIS FAIL: making the no-siblings case a refusal. An
    earlier revision of #4701 did exactly that and broke five existing tests
    whose fixtures put the detector in the gated job -- the pre-#4682 shape,
    which was never wrong, only superseded.
    """
    row = {"gate_step": "Detect console changes", "detector_job": "vitest-detect"}
    steps = [{"name": "Detect console changes", "conclusion": "success"}]
    ok, why, detectors = gates._declared_gate_ran(row, steps, (), None)
    assert ok, why
    assert len(detectors) == 1
