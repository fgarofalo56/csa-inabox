"""The DECLARED substantive-step rule, and the four blind spots it shipped with.

`green-at-merge` carries 14 of 15 contexts on a typical PR and used to return a
pass on the check conclusion alone -- the same defect `deferred-to-head` had,
one branch along, found by both independent reviewers.

EVERY TEST HERE EXISTS BECAUSE A MUTATION ARM SURVIVED. The first run of the
matrix after the fix reported `killed=184 survived=4`, and all four survivors
were in the code that fix had just added:

    CB4b  green-at-merge's check can be deleted entirely
    CB4c  an UNDECLARED context stops failing closed
    CB4e  a STALE declaration passes instead of failing closed
    CB4f  the ALL rule accepts any number of skipped steps

A fix whose own removal no test notices is not a fix, it is a comment. These are
the controls that make the arms die.

Run:  python -m pytest tools/drain/__tests__/ -q
"""
from __future__ import annotations

import copy
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_ci_green import (
    MERGED_FILES,
    MERGED_SHA,
    POLICY,
    _ev,
    _green,
    _job,
    _receipt,
)

import gates

#: The `infra` ERE that `fiab-console-ci.yml`'s vitest detector greps on,
#: resolved by `merge_gate.resolve_infra_ere()` in production.
#:
#: THIS IS A TEST FIXTURE, NOT A SECOND COPY OF THE AUTHORITY. `policy.json`
#: declares the DELEGATION (`derive-infra-reading-suites.mjs --ere`) and never a
#: path list, for exactly the reason the Python rows point at `on.push.paths`.
#: But a test has to drive the code with a concrete value, and one that reached
#: for `node` would make this suite depend on a toolchain it does not otherwise
#: need. `test_the_infra_ere_fixture_still_matches_the_deriver` keeps it honest
#: where `node` is available, and SKIPS where it is not -- so a drift is visible
#: to a developer and silent in CI, which is stated rather than implied.
INFRA_ERE = (
    r"^(\.claude|\.github|PRPs|azure-functions|content|deploy|docs|domains"
    r"|examples|notebooks|overrides|packages|platform|scripts|sdk|templates"
    r"|tests|tools)/"
)

# ---------------------------------------------------------------------------
# CB4b -- green-at-merge must ASK, not assume
# ---------------------------------------------------------------------------


def test_negative_control_green_at_merge_refuses_a_check_that_skipped_its_work():
    """THE BLOCKER ITSELF, and the arm that proved no test covered it.

    Live at the time it was found: PR #4488 returned `RECEIPT: GREEN` while
    `next build (node 20)` concluded SUCCESS at the merged sha with `Build
    (next build)` SKIPPED behind a change-detection gate. Measured the same on
    #4483 -- which means the "#4483 is the green control" claim made one round
    earlier was itself a false receipt.

    THE MERGED FILES ARE THE LOAD-BEARING HALF, and round 3 did not have them.
    Round 3's version of this test used the tools-only `MERGED_FILES`, i.e. it
    asserted a FAILURE on the exact shape that is a LEGITIMATE skip -- a console
    build correctly not running because no console file changed. It passed
    because the receipt had no way to tell those apart, and the price was that
    `ci-green` went 0-for-2 on the two merges it exists to close. So the fixture
    now changes a console file: the detector had something to detect, skipped
    anyway, and THAT is the #3783 shape this must refuse.
    """
    hollow = _job("next build (node 20)", steps=("Detect console changes", "Build (next build)"),
                  skipped=("Build (next build)",))
    receipt = _receipt(
        [
            _ev("next build (node 20)",
                merged_check=_green("next build (node 20)"),
                merged_job=hollow),
        ],
        merged_changed_files=[*MERGED_FILES, "apps/fiab-console/app/page.tsx"],
    )
    assert not receipt.ok
    assert any("Build (next build)" in r for r in receipt.reasons)
    assert any("not done the thing it is required for" in r for r in receipt.reasons)
    assert any("missed a change" in r for r in receipt.reasons)


def test_a_scope_skip_is_excused_when_the_merged_files_are_outside_the_scope():
    """The other side, and the reason round 4 exists.

    A guard/test-only PR is by construction one that does not touch
    `apps/fiab-console`, so this is the shape of EVERY merge the `ci-green`
    receipt is supposed to close. The skip is corroborated against the merged
    commit's own file list -- the same population the on-push detector computes
    for itself -- not taken on trust from the detector's conclusion.
    """
    hollow = _job("next build (node 20)", steps=("Detect console changes", "Build (next build)"),
                  skipped=("Build (next build)",))
    receipt = _receipt([
        _ev("next build (node 20)",
            merged_check=_green("next build (node 20)"),
            merged_job=hollow),
    ])
    assert receipt.ok, receipt.reasons
    excused = receipt.by_state("scope-untouched-at-merge")
    assert len(excused) == 1
    assert "apps/fiab-console/**" in excused[0].detail
    assert "Detect console changes" in excused[0].detail


def test_negative_control_a_scope_skip_needs_the_gate_step_to_have_run():
    """If the detector itself was skipped, nothing establishes WHY the work was
    skipped -- and an unanswered question is not evidence. Without this the
    excuse would accept a job in which everything, detector included, was
    skipped by an outer `if:`.
    """
    dead = _job("next build (node 20)", steps=("Detect console changes", "Build (next build)"),
                skipped=("Detect console changes", "Build (next build)"))
    ok, why = gates.scope_untouched_at_merge(
        "next build (node 20)", dead, MERGED_FILES, POLICY)
    assert not ok
    assert "gate step" in why
    assert "did not conclude success" in why


def test_negative_control_a_scope_skip_needs_a_declared_scope():
    """An undeclared context cannot reach the excuse at all. This is what stops
    the new branch from becoming a general-purpose amnesty for any skip.

    `Secret Scan` is the example precisely because it has no in-job detector: it
    runs gitleaks unconditionally, so there is nothing a scope could explain.
    """
    ok, why = gates.scope_untouched_at_merge(
        "Secret Scan",
        _job("Secret Scan", steps=("Install gitleaks", "Run gitleaks"),
             skipped=("Run gitleaks",)),
        MERGED_FILES, POLICY,
    )
    assert not ok
    assert "no change-detection scope is DECLARED" in why


def test_negative_control_a_scope_skip_refuses_an_empty_changed_file_list():
    """With no merged file list the declared scope cannot be shown to exclude
    anything, so there is nothing to corroborate the skip against."""
    hollow = _job("next build (node 20)", steps=("Detect console changes", "Build (next build)"),
                  skipped=("Build (next build)",))
    ok, why = gates.scope_untouched_at_merge("next build (node 20)", hollow, [], POLICY)
    assert not ok
    assert "changed-file list is empty" in why


def test_negative_control_a_failed_declared_step_is_not_a_scope_skip():
    """`skipped` is the only conclusion a scope skip produces. A step that
    FAILED and a step that was skipped are different events, and excusing the
    first would turn a red check green."""
    broken = _job("next build (node 20)", steps=("Detect console changes", "Build (next build)"))
    broken["steps"][2]["conclusion"] = "failure"
    ok, why = gates.scope_untouched_at_merge(
        "next build (node 20)", broken, MERGED_FILES, POLICY)
    assert not ok
    assert "rather than `skipped`" in why


def _job_block(text: str, job_key: str) -> str | None:
    """The slice of a workflow file belonging to one JOB, keyed by its YAML key.

    Keyed to the job KEY rather than the context's display name, for two
    measured reasons. Both reviewers found the name-keyed version reading the
    WRONG job — it scanned the whole file and stopped at the first match, so
    both console rows resolved to `build` and `vitest`'s detector 250 lines down
    was never read. And a display name is not always IN the file: `Python Tests
    (3.10)` comes from `name: Python Tests (${{ matrix.python-version }})`, so
    the literal context name appears nowhere.

    Crude on purpose — the alternative is a YAML round-trip inside a drift
    guard, and this must fail LOUDLY when the shape changes rather than parse
    cleverly around it.
    """
    import re as _re

    marker = _re.search(r"^  " + _re.escape(job_key) + r":\s*$", text, _re.MULTILINE)
    if marker is None:
        return None
    rest = text[marker.end():]
    nxt = _re.search(r"^  [A-Za-z0-9_-]+:\s*$", rest, _re.MULTILINE)
    return rest[: nxt.start()] if nxt else rest


def test_every_declared_alternative_exists_and_is_gated_differently():
    """Round 5's blocker, as a contract.

    A job may have MORE THAN ONE work-gating output, and a row naming only the
    first made the receipt print "there was nothing for it to do" about a merge
    where `Run vitest (infra-reading suites only)` had SUCCEEDED. An alternative
    is therefore only meaningful if it (a) exists in the producing workflow's
    own job block and (b) is gated on a DIFFERENT condition than the primary
    step -- an "alternative" behind the same `if:` can never run when the
    primary does not, so declaring one would be decoration.
    """
    root = _workflow_root()
    if root is None:  # pragma: no cover - no workflow tree here
        pytest.skip("workflow tree not reachable from here")
    alts = {
        name: steps
        for name, steps in POLICY["receipts"]["ci_green_rule"]["alternatives"].items()
        if not name.startswith("_")
    }
    assert alts, "an empty alternatives map would make this guard vacuous"
    scope_rows = POLICY["receipts"]["ci_green_rule"]["scope_paths"]
    primary = POLICY["receipts"]["ci_green_rule"]["substantive_steps"]
    for name, steps in alts.items():
        row = scope_rows.get(name)
        assert isinstance(row, dict), f"{name}: an alternative needs a scope row"
        text = (root / row["workflow"]).read_text(encoding="utf-8")
        job = _job_block(text, row["job"])
        assert job is not None, f"{name}: no job block in {row['workflow']}"
        # THE PARSED STEPS, which is what every resolution below uses. Round 10:
        # the existence check was a bare `f"name: {step}" in job` over the whole
        # job TEXT -- satisfied by a `run:` body, a YAML comment, or a DECOY step
        # whose name merely extends the declared one. Both halves of this guard
        # now read the same parse the decision function reads.
        parsed = _job_steps(text, row["job"])
        assert parsed, f"{name}: job {row['job']!r} parsed to no steps"
        assert steps, f"{name}: empty alternative list"

        # The output that gates the PRIMARY, read off the row rather than
        # assumed to be the first one.
        primary_outputs = {
            spec["output"] for spec in row["outputs"]
            if any(p in g or g in p for g in spec["gates"] for p in primary[name])
        }
        assert primary_outputs, (
            f"{name}: no declared output gates its primary step(s) {primary[name]}"
        )
        for step in steps:
            resolved, why_res = gates.steps_named(step, parsed)
            assert resolved is not None, (
                f"{name}: declared alternative {step!r} is ambiguous in its job: "
                f"{why_res}"
            )
            assert len(resolved) == 1, (
                f"{name}: declared alternative {step!r} resolves to "
                f"{len(resolved)} steps in its job, so which one the declaration "
                "means cannot be decided"
            )
            # AN ALTERNATIVE MAY NOT BE THE GATE STEP. Alternatives are matched
            # as substrings against the job's steps and the detector ALWAYS
            # runs, so declaring it would make `alternative_accounted_for`
            # return True for every green run of this context -- switching the
            # substantive-step rule off entirely with a one-line edit to
            # `policy.json`. An independent reviewer drove exactly that
            # declaration through the previous version of this guard and it
            # passed silently, because `Detect console changes` carries no `if:`
            # and so satisfied the "not gated on the same output" assertion
            # vacuously. `gates.alternative_accounted_for` refuses it too; this
            # asserts the declaration, that asserts the decision.
            assert row["gate_step"] not in step, (
                f"{name}: alternative {step!r} IS the gate step, which always runs - "
                "declaring it would make the substantive-step rule vacuous"
            )
            gate = _gate_of(parsed, step)
            assert gate is not None, (
                f"{name}: alternative {step!r} could not be located as a step in its "
                "own job block, so its gate cannot be read - fail closed"
            )
            # AN UNGATED ALTERNATIVE IS A FAILURE, NOT A PASS. The previous
            # version read the empty string for a step with no `if:` and the
            # `not in` assertion below was then vacuously true -- fail-open in a
            # guard whose whole job is to refuse a bad declaration.
            assert gate, (
                f"{name}: alternative {step!r} carries no `if:` at all, so it runs "
                "unconditionally and cannot evidence a second work-gating output"
            )
            for out in sorted(primary_outputs):
                assert f"outputs.{out} == 'true'" not in gate, (
                    f"{name}: alternative {step!r} is gated on {out!r}, the SAME "
                    "output as the primary step, so it can never run when the "
                    "primary does not"
                )
            # AND IT MUST BE GATED ON A DECLARED OUTPUT. Round 8: asserting only
            # that the primary's output is ABSENT leaves "gated on something
            # nobody declared" passing. An alternative gated on an undeclared
            # output is then accepted with that output's scope never examined --
            # the same hole as the undeclared output itself, reached from the
            # other side. Requiring the gate to NAME a declared output closes
            # both, and it is what makes `_outputs_whose_work_did_not_run` able
            # to reason about this step at all.
            declared_here = {spec["output"] for spec in row["outputs"]}
            named = {out for out in declared_here if f"outputs.{out}" in gate}
            assert named, (
                f"{name}: alternative {step!r} is gated on {gate!r}, which names "
                f"none of its row's declared outputs {sorted(declared_here)} - so "
                "the scope that decided it is not one this receipt ever checks"
            )
        for step in primary[name]:
            assert step not in steps, (
                f"{name}: {step!r} is declared as both primary and alternative"
            )


def _gate_of(steps: list[dict], step_name: str) -> str | None:
    """The `if:` expression attached to a named step, resolved STRUCTURALLY.

    `""` when the step exists and carries no gate, `None` when the declaration
    cannot be resolved to exactly one step -- which the caller treats as a
    failure.

    ROUND 10 BLOCKER. This was the SIXTH place resolving a declared step name,
    and the last one still doing first-hit PREFIX matching over the job's TEXT.
    Round 9 moved the guard's DETECTOR half onto the parse and left this, the
    ALTERNATIVES half of the same test, on a regex -- so the two halves of one
    guard disagreed with each other and with `gates.steps_named`.

    An independent reviewer produced exactly the decoration this guard exists to
    refuse: a decoy step `Jest (portal) - snapshot freshness report` inserted
    BEFORE the real `Jest (portal)`, and the real one demoted to the primary's
    own output. The regex read the DECOY's `if:` and passed; the decision
    function read the real step. Full suite 394 passed before and after.

        DECISION  gates.steps_named('Jest (portal)') -> the real step, gated on
                  the PRIMARY's output (so the alternative is decoration)
        GUARD     _gate_of(text, 'Jest (portal)')    -> the DECOY's `if:`

    So it resolves through `gates.steps_named` now -- exact-match-wins, refusing
    an ambiguous pool -- against the PARSED step mappings, and reads `if` off the
    mapping rather than regexing the text after a `name:` line. That also closes
    the reviewer's related question for free: a bare `name:` substring assertion
    over the whole job text is satisfied by a `run:` body or a YAML comment, the
    shape this repo already has a memory for (#4467).
    """
    matches, _why = gates.steps_named(step_name, steps)
    if not matches or len(matches) != 1:
        return None
    gate = matches[0].get("if")
    return "" if gate is None else str(gate)


def test_negative_control_a_declared_alternative_that_ran_is_work_not_an_excuse():
    """The receipt must report work DONE, not an excuse, when the other half of
    a two-output job ran. Reporting it as `scope-untouched-at-merge` was the
    R7 violation: it printed "nothing for it to do" about a job that had just
    run 42 test suites.

    ROUND 6: the acceptance also has to be CORROBORATED. It lives in
    `alternative_accounted_for`, not in `context_did_its_work`, because the
    latter has no merged-file list and so could not ask whether the primary's
    detector was right to say no.
    """
    job = _job(
        "vitest (node 20)",
        steps=("Detect console changes",
               "Run vitest (with istanbul coverage floor)",
               "Run vitest (infra-reading suites only)"),
        skipped=("Run vitest (with istanbul coverage floor)",),
    )
    # The primary is SKIPPED, so the plain predicate refuses -- that is the
    # question it is able to answer.
    did, _ = gates.context_did_its_work("vitest (node 20)", job, POLICY)
    assert not did

    ok, why = gates.alternative_accounted_for(
        "vitest (node 20)", job, MERGED_FILES, POLICY, infra_ere=INFRA_ERE)
    assert ok, why
    assert "Run vitest (infra-reading suites only)" in why
    assert "alternative" in why

    # And it is NOT an excuse: a job that ran something has no "nothing to do".
    excused, scope_why = gates.scope_untouched_at_merge(
        "vitest (node 20)", job, MERGED_FILES, POLICY, infra_ere=INFRA_ERE)
    assert not excused
    assert "work step(s) RAN anyway" in scope_why

    # The composed answer names the route rather than folding it into
    # `green-at-merge`, which an independent reviewer flagged as a summary line
    # that says twelve contexts ran their check when eleven did.
    acct, _, route = gates.context_is_accounted_for(
        "vitest (node 20)", job, MERGED_FILES, POLICY, infra_ere=INFRA_ERE)
    assert acct
    assert route == gates.ACCOUNTED_ALTERNATIVE


def test_blocker_an_alternative_cannot_launder_a_detector_that_missed_a_change():
    """ROUND 6 BLOCKER, found independently by both reviewers on different rows.

    Round 5 accepted "a declared alternative ran" inside `context_did_its_work`,
    which receives no `changed_files` -- so `context_is_accounted_for` returned
    on `did` before the scope corroboration ran, and the `hits` refusal became
    unreachable whenever any alternative ran. The identical input that round 4
    REFUSED ("a change detector that missed a change") round 5 ACCEPTED as
    `green-at-merge`: a required context certified green over a console that was
    never built or tested. This is the #3783 shape `policy.json` says must never
    be laundered, laundered by the fix for something else.
    """
    job = _job(
        "next build (node 20)",
        steps=("Detect console changes", "Build (next build)",
               "Type-check (portal)", "Jest (portal)"),
        skipped=("Build (next build)",),
    )
    merged_with_a_console_file = [
        "apps/fiab-console/lib/editors/lakehouse.tsx",
        "portal/react-webapp/package.json",
    ]
    ok, why = gates.alternative_accounted_for(
        "next build (node 20)", job, merged_with_a_console_file, POLICY)
    assert not ok
    assert "detector that missed a change" in why
    assert "apps/fiab-console/lib/editors/lakehouse.tsx" in why

    # And the composed entry point must refuse too -- the bypass was THERE, not
    # in the predicate.
    acct, evidence, route = gates.context_is_accounted_for(
        "next build (node 20)", job, merged_with_a_console_file, POLICY)
    assert not acct, evidence
    assert route == ""


def test_blocker_the_alternative_route_excludes_outputs_whose_work_ran():
    """The other half of the same blocker, and the one that re-breaks the
    receipt if it is got wrong.

    The alternative's OWN scope should match a merged file -- that is why it
    ran. `infra`'s ERE contains `tools/` and `PRPs/`, the exact footprint of a
    drain PR, so asking every output on this route would refuse `vitest (node
    20)` on every drain merge for the crime of having done the work. That is
    round 4's "unobtainable for the exact class it closes", rebuilt inside the
    fix for round 5.

    ROUND 8: the exclusion is by OUTCOME (its gated step RAN), not by identity
    (it is not the primary). See the third-output control below for why.
    """
    job = _job(
        "vitest (node 20)",
        steps=("Detect console changes",
               "Run vitest (with istanbul coverage floor)",
               "Run vitest (infra-reading suites only)"),
        skipped=("Run vitest (with istanbul coverage floor)",),
    )
    # MERGED_FILES is a drain footprint: it matches `infra`, and not `console`.
    assert any(f.startswith("tools/") for f in MERGED_FILES)
    ok, why = gates.alternative_accounted_for(
        "vitest (node 20)", job, MERGED_FILES, POLICY, infra_ere=INFRA_ERE)
    assert ok, why

    # Asking EVERY output on the same inputs is the refusal we must not make.
    row = gates._scope_row("vitest (node 20)", POLICY)
    every, _ = gates._merged_files_outside_scope(
        "vitest (node 20)", row, list(MERGED_FILES), None, INFRA_ERE)
    assert not every, (
        "the fixture no longer distinguishes the two questions, so this test "
        "would pass under a mutant that asks every output"
    )


def test_blocker_a_third_outputs_matching_scope_is_not_laundered_by_the_alternative():
    """ROUND 8 BLOCKER 1. Selecting by IDENTITY ("the outputs that gate the
    primary") and selecting by OUTCOME ("the outputs whose work did not run")
    are the same set for a two-output row and diverge the moment there is a
    third -- and the divergence is in the excusing direction.

    An independent reviewer drove the real `next build (node 20)` row plus a
    third declared output `docs`, gating a `Docs link check` that SKIPPED, with
    `docs/adr/0001.md` in the merge. The excuse branch refused the job ("2 work
    step(s) RAN anyway"); the alternative branch ACCEPTED it, because `docs`
    gates neither the primary nor the alternative and so was never asked.

    That is the #3783 shape -- a change detector that missed a change -- on a
    correctly DECLARED output. "Declare every work-gating output" was the whole
    remedy round 7 chose for round 6, so a route that does not ask the declared
    output undoes it.
    """
    planted = copy.deepcopy(POLICY)
    row = planted["receipts"]["ci_green_rule"]["scope_paths"]["next build (node 20)"]
    row["outputs"].append({
        "output": "docs",
        "paths": ["docs/**"],
        "gates": ["Docs link check"],
    })
    job = {
        "name": "next build (node 20)",
        "conclusion": "success",
        "steps": [
            {"name": "Detect console changes", "conclusion": "success"},
            {"name": "Build (next build)", "conclusion": "skipped"},
            {"name": "Docs link check", "conclusion": "skipped"},
            {"name": "Type-check (portal)", "conclusion": "success"},
            {"name": "Jest (portal)", "conclusion": "success"},
        ],
    }
    files = ["portal/react-webapp/App.tsx", "docs/adr/0001.md"]

    ok, why = gates.alternative_accounted_for(
        "next build (node 20)", job, files, planted)
    assert not ok, "a THIRD output whose gated step skipped and whose scope matched"
    assert "docs" in why, why
    assert "MATCHES" in why, why

    # THE CONTROL THIS PAIRS WITH: the same job, same policy, with nothing in
    # the merge that `docs` covers, is still ACCEPTED. Otherwise this test would
    # pass under a mutant that simply refuses the route outright.
    ok2, why2 = gates.alternative_accounted_for(
        "next build (node 20)", job, ["portal/react-webapp/App.tsx"], planted)
    assert ok2, why2


def test_negative_control_a_skipped_alternative_is_not_work():
    """Both halves skipped is the genuine scope skip, and must stay reachable —
    otherwise the fix for the lie would re-break the receipt it repaired.

    The merged files must fall outside BOTH declared scopes for this to be a
    real "nothing to do": `apps/loom-vscode` is neither a console path nor
    inside the infra ERE's top-level directory list. That is the population the
    README names -- the dependency bumps that score five scope-untouched
    contexts because no required context builds those packages.
    """
    job = _job(
        "vitest (node 20)",
        steps=("Detect console changes",
               "Run vitest (with istanbul coverage floor)",
               "Run vitest (infra-reading suites only)"),
        skipped=("Run vitest (with istanbul coverage floor)",
                 "Run vitest (infra-reading suites only)"),
    )
    outside_both = ["apps/loom-vscode/package.json", "apps/loom-vscode/src/ext.ts"]
    ok, _ = gates.context_did_its_work("vitest (node 20)", job, POLICY)
    assert not ok
    excused, why = gates.scope_untouched_at_merge(
        "vitest (node 20)", job, outside_both, POLICY, infra_ere=INFRA_ERE)
    assert excused, why
    assert "no work step in the job ran" in why


def test_negative_control_an_unresolvable_infra_ere_fails_closed():
    """The delegation is only safe if not resolving it REFUSES.

    `vitest (node 20)`'s `infra` scope is computed by a script rather than
    written down, so the gate cannot evaluate it when the caller did not resolve
    it. Assuming it excludes everything would excuse a skip on an unanswered
    question -- which is the one thing every branch of this receipt is specified
    not to do.
    """
    job = _job(
        "vitest (node 20)",
        steps=("Detect console changes",
               "Run vitest (with istanbul coverage floor)",
               "Run vitest (infra-reading suites only)"),
        skipped=("Run vitest (with istanbul coverage floor)",
                 "Run vitest (infra-reading suites only)"),
    )
    outside_both = ["apps/loom-vscode/package.json"]
    excused, why = gates.scope_untouched_at_merge(
        "vitest (node 20)", job, outside_both, POLICY, infra_ere=None)
    assert not excused
    assert "fail closed" in why
    # ... and resolving it is what makes the same inputs excusable.
    excused2, _ = gates.scope_untouched_at_merge(
        "vitest (node 20)", job, outside_both, POLICY, infra_ere=INFRA_ERE)
    assert excused2


def test_negative_control_a_sibling_gate_step_cannot_answer_for_a_skipped_one():
    """Round 5 BLOCKER: `gate_step` is matched as a SUBSTRING and the check was
    `any()`, so a step whose name merely CONTAINS the declared one could answer
    for a detector that was itself skipped — and the message then asserted the
    declared detector had run, which it had not.

    THE SUCCEEDING SIBLING COMES FIRST, DELIBERATELY. Round 6: an independent
    reviewer's arm narrowed the population to `detectors[:1]` — the honest form
    of an accident, where `[:0]` is not — and it SURVIVED, because this fixture
    listed the SKIPPED detector first and a one-element slice therefore reached
    the same refusal by luck. With the succeeding sibling first, only a check
    that reads EVERY matching detector can refuse, so the `all` semantics the
    round-5 fix installed are what this test depends on.
    """
    job = {
        "name": "next build (node 20)",
        "conclusion": "success",
        "steps": [
            {"name": "Set up job", "conclusion": "success"},
            {"name": "Detect console changes (portal half)", "conclusion": "success"},
            {"name": "Detect console changes", "conclusion": "skipped"},
            {"name": "Build (next build)", "conclusion": "skipped"},
            {"name": "Complete job", "conclusion": "success"},
        ],
    }
    ok, why = gates.scope_untouched_at_merge(
        "next build (node 20)", job, MERGED_FILES, POLICY)
    assert not ok
    assert "did not conclude success" in why


def test_negative_control_every_declared_alternative_is_consulted_not_just_the_first():
    """ROUND 6 BLOCKER: two of the reviewer's surviving arms, `alternatives[:1]`
    and `len(alternatives) == 1`, both disable the alternatives path for
    `next build (node 20)` — the row the round-5 commit message calls the
    portal's only blocking check — and nothing noticed. Grepping the suite for
    `Jest (portal)` returned nothing: the second of the only two rows in the map
    had ZERO behavioural coverage.

    So this drives it through with ONLY THE SECOND declared alternative running.
    A truncating mutant sees `Jest (portal)` skipped and refuses; a mutant that
    requires exactly one declaration refuses outright.
    """
    declared = POLICY["receipts"]["ci_green_rule"]["alternatives"]["next build (node 20)"]
    assert declared[0] == "Jest (portal)", declared
    assert declared[1] == "Type-check (portal)", declared

    job = {
        "name": "next build (node 20)",
        "conclusion": "success",
        "steps": [
            {"name": "Set up job", "conclusion": "success"},
            {"name": "Detect console changes", "conclusion": "success"},
            {"name": "Build (next build)", "conclusion": "skipped"},
            {"name": "Jest (portal)", "conclusion": "success"},
            {"name": "Type-check (portal)", "conclusion": "success"},
            {"name": "Complete job", "conclusion": "success"},
        ],
    }
    # A portal-only merge: outside the PRIMARY's (`console`) scope, which is why
    # the primary skipped, and inside the alternative's, which is why it ran.
    #
    # ROUND 11: BOTH portal steps succeed here, because in the real workflow they
    # carry the IDENTICAL condition (`fiab-console-ci.yml:297` and `:302`) and so
    # cannot disagree. The previous fixture had one skipped and one succeeded --
    # an impossible job -- and round 10 backed a CORRECT refusal out of
    # `_outputs_whose_work_did_not_run` because this test failed against it. A
    # fixture describing a state the workflow cannot reach is not a control; it
    # is a licence.
    #
    # It still kills R2A1 (`alternatives[:1]`): with only the first consulted the
    # message names `Jest (portal)` alone and the assertion below fails.
    portal_only = ["portal/react-webapp/src/App.tsx"]
    ok, why = gates.alternative_accounted_for(
        "next build (node 20)", job, portal_only, POLICY)
    assert ok, why
    assert "Jest (portal)" in why, why
    assert "Type-check (portal)" in why, why


def test_negative_control_a_failed_work_step_still_counts_as_work():
    """ROUND 6: the reviewer's `did_run` narrowing survived — a mutant that stops
    counting a FAILED step as work prints "nothing for it to do" about a job
    that ran a step and it failed. That is the R7 lie this branch exists to
    refuse, reachable through `continue-on-error`.
    """
    job = {
        "name": "next build (node 20)",
        "conclusion": "success",
        "steps": [
            {"name": "Set up job", "conclusion": "success"},
            {"name": "Detect console changes", "conclusion": "success"},
            {"name": "Build (next build)", "conclusion": "skipped"},
            {"name": "Upload coverage artifact", "conclusion": "failure"},
            {"name": "Complete job", "conclusion": "success"},
        ],
    }
    outside = ["apps/loom-vscode/package.json"]
    ok, why = gates.scope_untouched_at_merge(
        "next build (node 20)", job, outside, POLICY)
    assert not ok
    assert "RAN anyway" in why
    assert "Upload coverage artifact" in why


def test_negative_control_an_alternative_that_failed_is_not_work_done():
    """The mirror of the above, in the new branch. `ran()` counts `failure` and
    `cancelled` as executed, which is harmless for a primary inside a green job
    and is NOT harmless for an alternative: it would report a FAILED step as the
    work this context did instead of its primary.

    ROUND 12: this fixture WAS a licence by round 11's own definition, and an
    independent reviewer caught it forty lines below the one round 11 rewrote
    for the same reason. It had `Jest (portal)=failure` with `Type-check
    (portal)=skipped` -- but Type-check runs FIRST (`fiab-console-ci.yml:296`
    against `:301`), and an explicit `if:` implies `success()`, so a failure in
    Jest cannot skip a step that already ran. The reachable ordering is the
    reverse, and it is now the first case below.

    BOTH refusal paths are driven, because they are different code:
      1. the output's own steps did not all succeed and did not all skip, which
         `_outputs_whose_work_did_not_run` refuses before the route is reached;
      2. a declared alternative OUTSIDE any output's `gates` that failed, which
         only `ran_instead` can refuse.
    """
    reachable = {
        "name": "next build (node 20)",
        "conclusion": "success",
        "steps": [
            {"name": "Set up job", "conclusion": "success"},
            {"name": "Detect console changes", "conclusion": "success"},
            {"name": "Build (next build)", "conclusion": "skipped"},
            {"name": "Type-check (portal)", "conclusion": "failure"},
            {"name": "Jest (portal)", "conclusion": "skipped"},
            {"name": "Complete job", "conclusion": "success"},
        ],
    }
    ok, why = gates.alternative_accounted_for(
        "next build (node 20)", reachable,
        ["portal/react-webapp/src/App.tsx"], POLICY)
    assert not ok
    assert "neither 'every step skipped' nor 'every step succeeded'" in why, why

    # 2. THE `ran_instead` PATH. The alternative is not gated work, so the
    # outputs resolve cleanly and the failure is the only thing left to refuse.
    planted = copy.deepcopy(POLICY)
    planted["receipts"]["ci_green_rule"]["alternatives"]["next build (node 20)"] = [
        "Lint (next lint)"
    ]
    job = {
        "name": "next build (node 20)",
        "conclusion": "success",
        "steps": [
            {"name": "Detect console changes", "conclusion": "success"},
            {"name": "Build (next build)", "conclusion": "skipped"},
            {"name": "Type-check (portal)", "conclusion": "skipped"},
            {"name": "Jest (portal)", "conclusion": "skipped"},
            {"name": "Lint (next lint)", "conclusion": "failure"},
        ],
    }
    ok2, why2 = gates.alternative_accounted_for(
        "next build (node 20)", job, ["tools/drain/gates.py"], planted)
    assert not ok2
    # THE REASON SPECIFIC TO THIS SCENARIO. Round 10 (R7): this used to assert
    # the generic "concluded success", which the gate-step control below
    # asserted too -- so both passed on a sentence that was false for one of
    # them. A refusal reason that fits every refusal distinguishes none of them.
    assert "concluded ['failure'], not success" in why2, why2


def test_blocker_a_failed_gated_step_does_not_excuse_its_outputs_scope():
    """ROUND 12 BLOCKER. Round 11 narrowed the refusal to `skipped`+`success`
    and EXCLUDED everything else, so a FAILED step read as "work that ran" and
    its output's scope was never compared.

    Driven by an independent reviewer on the UNMODIFIED real policy row: the
    portal scope MATCHED a merged file and was never asked, while the portal's
    blocking test step had failed. `cancelled`, `timed_out` and an unknown
    conclusion all behaved identically, which is why the rule is now the whole
    table rather than one row of it.
    """
    for bad in ("failure", "cancelled", "timed_out", None):
        job = {
            "name": "next build (node 20)", "conclusion": "success",
            "steps": [
                {"name": "Detect console changes", "conclusion": "success"},
                {"name": "Build (next build)", "conclusion": "skipped"},
                {"name": "Jest (portal)", "conclusion": bad},
                {"name": "Type-check (portal)", "conclusion": "success"},
            ],
        }
        ok, why = gates.alternative_accounted_for(
            "next build (node 20)", job,
            ["portal/react-webapp/src/App.tsx"], POLICY)
        assert not ok, f"{bad!r} let a matching portal scope go unasked: {why}"
        assert "cannot be read off the declaration" in why, (bad, why)

    # CONTROL: every gated step SUCCEEDING is still excluded, or this refuses
    # the population the route exists for.
    good = {
        "name": "next build (node 20)", "conclusion": "success",
        "steps": [
            {"name": "Detect console changes", "conclusion": "success"},
            {"name": "Build (next build)", "conclusion": "skipped"},
            {"name": "Jest (portal)", "conclusion": "success"},
            {"name": "Type-check (portal)", "conclusion": "success"},
        ],
    }
    ok2, why2 = gates.alternative_accounted_for(
        "next build (node 20)", good, ["portal/react-webapp/src/App.tsx"], POLICY)
    assert ok2, why2


def test_negative_control_the_gate_step_cannot_be_declared_as_its_own_alternative():
    """An independent reviewer's one-line policy edit: declare the DETECTOR as
    an alternative. It always runs, so every green run of the context would
    return "it did its work" and the substantive-step rule would silently stop
    applying. The guard test missed it because the detector carries no `if:`;
    the DECISION FUNCTION must refuse it too.
    """
    planted = copy.deepcopy(POLICY)
    planted["receipts"]["ci_green_rule"]["alternatives"]["next build (node 20)"] = [
        "Detect console changes"
    ]
    job = {
        "name": "next build (node 20)",
        "conclusion": "success",
        "steps": [
            {"name": "Detect console changes", "conclusion": "success"},
            {"name": "Build (next build)", "conclusion": "skipped"},
            {"name": "Jest (portal)", "conclusion": "skipped"},
            {"name": "Type-check (portal)", "conclusion": "skipped"},
        ],
    }
    # A merge inside NO declared scope, so the gate-step exclusion is the only
    # thing left that can refuse this. Round 8: with a `portal/` file here the
    # refusal came from the scope check instead -- correctly, since portal's
    # steps are skipped -- and the control this test exists for was never
    # reached. A negative control that passes for the wrong reason is not one.
    ok, why = gates.alternative_accounted_for(
        "next build (node 20)", job, ["tools/drain/gates.py"], planted)
    assert not ok
    # AND THE REASON IS THE DETECTOR, not "did not conclude success". The
    # detector DID conclude success -- `_declared_gate_ran` established that
    # forty lines earlier -- so the old message asserted the opposite of what
    # the code had just proved (R7).
    assert "IS the change detector" in why, why


def test_the_infra_ere_fixture_still_matches_the_deriver():
    """The fixture is a copy, so it needs a currency check — and the check is
    honest about where it runs.

    `node` is not a dependency of this suite, so this SKIPS when the deriver
    cannot be run. That makes a drift visible to a developer and invisible in
    CI, which is stated here rather than implied — the same disclosure the
    `required_contexts.json` snapshot carries one file over.
    """
    import subprocess

    root = _repo_root()
    if root is None:  # pragma: no cover - mutation sandbox
        pytest.skip("repo tree not reachable from here (mutation sandbox)")
    try:
        out = subprocess.run(
            ["node", "scripts/ci/derive-infra-reading-suites.mjs", "--ere"],
            capture_output=True, text=True, cwd=root, timeout=180,
        )
    except (OSError, subprocess.SubprocessError):  # pragma: no cover
        pytest.skip("node is not available here")
    if out.returncode != 0:  # pragma: no cover
        pytest.skip(f"the deriver did not run here (rc={out.returncode})")
    assert out.stdout.strip() == INFRA_ERE, (
        "the infra ERE has drifted from the fixture in this file; update "
        "INFRA_ERE. policy.json declares the DELEGATION and needs no change."
    )


def test_negative_control_every_declared_pattern_is_applied_not_just_the_first():
    """Round 5 BLOCKER 2, and the arm that proved no test drove it: the console
    rows declare TWO patterns, and `MERGED_FILES` carries no workflow path, so
    a mutation applying only `paths[0]` survived. A merge that touches ONLY
    `.github/workflows/fiab-console-ci.yml` is inside the declared scope by the
    second pattern — it is the #3783 case this branch exists to catch."""
    hollow = _job("next build (node 20)",
                  steps=("Detect console changes", "Build (next build)"),
                  skipped=("Build (next build)",))
    ok, why = gates.scope_untouched_at_merge(
        "next build (node 20)", hollow,
        [".github/workflows/fiab-console-ci.yml"], POLICY)
    assert not ok
    assert "missed a change" in why
    assert "fiab-console-ci.yml" in why


def test_the_declared_scope_matches_the_workflows_own_change_detector():
    """DRIFT GUARD. `scope_paths` is read off the producing workflow's detector,
    and a lookup table read off something else is one edit away from being
    wrong, silently -- which is the failure mode this package keeps finding.

    TWO ROW SHAPES, because the two workflows write their detector differently
    and a guard that only understood one would have to be bypassed for the other:

    - a LITERAL path list -- the workflow greps its own ERE, so the declared
      globs must be exactly that ERE's alternatives, and the grep must be the one
      that sets the declared output;
    - `"on.push.paths"` -- the workflow's detector reads `on.push.paths` out of
      itself (via `scripts/ci/python_trigger_scope.py`), so there is no second
      list to compare and the guard asserts that delegation instead. Copying the
      globs here would create exactly the second copy `test.yml` refuses to have.

    SKIPPED when the workflow tree is not reachable -- the mutation runner
    copies this package into a temp dir outside the repo, and a test that raises
    `FileNotFoundError` there would score EVERY arm as KILLED regardless of the
    mutation. A kill that does not depend on the arm is a tautology.
    """
    import re

    root = _workflow_root()
    if root is None:  # pragma: no cover - no workflow tree here
        pytest.skip("workflow tree not reachable from here")
    rows = {
        name: row
        for name, row in POLICY["receipts"]["ci_green_rule"]["scope_paths"].items()
        if not name.startswith("_")
    }
    assert rows, "an empty scope_paths would make this guard vacuous"
    shapes = set()
    for name, row in rows.items():
        text = (root / row["workflow"]).read_text(encoding="utf-8")
        assert row["gate_step"] in text, (name, row["gate_step"])
        # SCOPED TO THIS ROW'S OWN JOB. Both independent reviewers found this
        # guard reading the WRONG job: it scanned the whole file and broke at the
        # first `grep -qE` setting the declared output, so BOTH literal rows
        # resolved to the `next build` job's detector and the `vitest` job's --
        # 250 lines further down, with a different second output -- was never
        # read. A drift guard that validates one job twice is not a drift guard,
        # and `DATA_NOT_NAMESPACE` stops the policy-key walk on the strength of
        # this test.
        job = _job_block(text, row["job"])
        assert job is not None, (
            f"{name}: no job in {row['workflow']} publishes this context - the "
            "`name:` changed, or the row points at the wrong workflow"
        )
        assert row["gate_step"] in job, (
            f"{name}: its declared gate step is not in ITS OWN job block"
        )

        # ---- THE MISSING DIRECTION (round 8 BLOCKER, found by BOTH reviewers)
        # Everything below walks DECLARED -> WORKFLOW, which makes a STALE row
        # visible and CANNOT make an UNDER-declared one visible: an output
        # nobody declared is not in the list being walked. Round 6's blocker was
        # an undeclared `portal` on this exact row; round 7 fixed the DATA and
        # built no instrument to keep it true, so `policy.json` asserted "an
        # under-declared row is now a refusal, not a silent pass" while deleting
        # four lines from a row still passed every test and flipped a
        # portal-only merge from refused to excused.
        #
        # So: walk WORKFLOW -> DECLARED. Every output the job actually GATES ON
        # must be declared.
        #
        # ROUND 9 BLOCKER: round 8 resolved the detector by
        # `job.index(f"name: {gate_step}")` -- the FIRST hit, and a PREFIX match.
        # A step named `Detect console changes (portal half)` sitting before the
        # real detector made this sweep the WRONG step's outputs, so an
        # undeclared output went unseen with 396 tests green and a false
        # `ok=True` receipt behind it. That step name is not invented: it is the
        # verbatim counterexample in `_declared_gate_ran`'s own docstring, and
        # THAT function matches `gate_step` as a substring across every step. The
        # instrument and the decision disagreed about which steps are detectors.
        #
        # Resolved STRUCTURALLY now, not positionally: every step whose `name`
        # contains `gate_step` (the decision side's own semantics), each one's
        # `id` read off the parsed step mapping rather than from the text after a
        # `name:` line, and the outputs unioned across all of them. Positional
        # parsing is what this package's own memory warns about, and it then took
        # three rounds to find "not the idioms I thought of".
        parsed_steps = _job_steps(text, row["job"])
        assert parsed_steps, (
            f"{name}: job {row['job']!r} parsed to no steps"
        )
        detectors = [
            s for s in parsed_steps
            if row["gate_step"] in str(s.get("name") or "")
        ]
        assert detectors, (
            f"{name}: no step in job {row['job']!r} has a name containing its "
            f"declared gate step {row['gate_step']!r}"
        )
        detector_ids = []
        for s in detectors:
            step_id = s.get("id")
            why_id = (
                f"{name}: the step {str(s.get('name'))!r} matches its declared gate "
                f"step but its parsed `id` is {step_id!r}, so the `if:` conditions "
                "that read its outputs cannot be traced to it"
            )
            assert isinstance(step_id, str), why_id
            assert step_id.strip(), why_id
            detector_ids.append(step_id)
        gated_on = set()
        for step_id in detector_ids:
            gated_on |= set(re.findall(
                rf"steps\.{re.escape(step_id)}\.outputs\.([A-Za-z0-9_-]+)", job))
        declared_names = {spec["output"] for spec in row["outputs"]}
        assert gated_on, (
            f"{name}: no step in its job block is gated on the outputs of "
            f"{detector_ids} - the detector's shape changed, and a row describing "
            "outputs nothing reads is not a scope declaration"
        )
        assert gated_on <= declared_names, (
            f"{name}: its job gates work on {sorted(gated_on - declared_names)}, "
            f"which `policy.json` does not declare (it declares "
            f"{sorted(declared_names)}). An UNDECLARED output is never asked, so "
            "the excuse route would report 'there was nothing for it to do' about "
            "a merge whose work that output gated and skipped - #3783, which is "
            "the defect this receipt exists to refuse."
        )

        # EVERY DECLARED OUTPUT, not just the first. Round 6 BLOCKER: a row
        # carried one `paths` against a `gate_step` that emits SEVERAL outputs,
        # so the receipt corroborated `console` and never `portal` or `infra` --
        # and `next build (node 20)` is, per that workflow's own #4187 comment,
        # the portal's ONLY blocking check. Walking the list is what makes an
        # under-declared row visible here rather than at a false receipt.
        for spec in row["outputs"]:
            gated = spec["gates"]
            assert isinstance(gated, list), (name, spec)
            assert gated, (name, spec)
            for step in gated:
                # THROUGH THE SAME RESOLVER THE DECISION USES. Round 11, found
                # by BOTH reviewers: this was a bare `name: <step>` SUBSTRING
                # over the job's TEXT -- satisfied by a `run:` body, by a YAML
                # comment (#4467's shape), and by a DECOY step whose name merely
                # extends the declared one. So the guard and
                # `_outputs_whose_work_did_not_run` could resolve the same
                # declaration to DIFFERENT steps, which is the one-side-of-a-
                # symmetry defect this package names repeatedly. The round-10
                # comment claimed this shape was "gone"; it was gone from
                # `_gate_of` and still here, and the claim has been corrected.
                resolved, why_res = gates.steps_named(step, parsed_steps)
                assert resolved is not None, (
                    f"{name}: output {spec['output']!r} claims to gate {step!r}, "
                    f"which is ambiguous in its own job: {why_res}"
                )
                assert len(resolved) == 1, (
                    f"{name}: output {spec['output']!r} claims to gate {step!r}, "
                    f"which resolves to {len(resolved)} steps in its own job block"
                )

            if spec["paths"] == gates.ON_PUSH_PATHS:
                shapes.add("delegated")
                # The delegation itself is the contract. If the detector stops
                # reading the trigger out of its own file, the declaration below
                # stops describing it -- and that is precisely the silent drift.
                assert "python_trigger_scope.py --changed-file" in job, (
                    f"{name}: {row['workflow']}'s detector no longer delegates to the "
                    "shared scope script, so `on.push.paths` is no longer its scope"
                )
                trigger = gates.parse_push_trigger(text)
                assert trigger is not None, (
                    f"{name}: {row['workflow']} has no readable push trigger"
                )
                assert trigger.paths, (
                    f"{name}: {row['workflow']} has no `on.push.paths` to be the "
                    "declared scope"
                )
                continue

            if spec["paths"] == gates.INFRA_READING_ERE:
                shapes.add("computed")
                # Same contract, for a scope that is DERIVED rather than
                # written. The declaration says "whatever that script prints";
                # if the job stops asking the script, it stops being true.
                assert "derive-infra-reading-suites.mjs --ere" in job, (
                    f"{name}: output {spec['output']!r} declares its scope as the "
                    "ERE that script computes, and its own job block no longer "
                    "runs it"
                )
                assert f'echo "{spec["output"]}=true"' in job, (
                    f"{name}: its job block never sets {spec['output']}=true"
                )
                continue

            shapes.add("literal")
            found = None
            for match in re.finditer(r"grep -qE '([^']+)'", job):
                tail = job[match.end():match.end() + 400]
                if f'echo "{spec["output"]}=true"' not in tail:
                    continue
                found = {
                    alt.lstrip("^").replace(r"\.", ".").rstrip("/")
                    for alt in match.group(1).split("|")
                }
                break
            assert found is not None, (
                f"{name}: no `grep -qE` in its own job block sets "
                f"{spec['output']}=true - the detector's shape changed"
            )
            declared = {
                p[: -len("/**")] if p.endswith("/**") else p for p in spec["paths"]
            }
            assert declared == found, (name, spec["output"], sorted(declared), sorted(found))

    assert shapes == {"literal", "delegated", "computed"}, (
        f"all three row shapes must stay exercised; saw {sorted(shapes)}"
    )


def test_negative_control_a_delegated_scope_fails_closed_without_the_trigger():
    """`"on.push.paths"` with no readable trigger is an unanswered question, and
    an unanswered question is not evidence. Without this the delegated shape
    would silently excuse every skip, since its path list would be empty."""
    job = _job("Python Tests (3.10)",
               steps=("Detect Python-relevant changes", "Run pytest with coverage"),
               skipped=("Run pytest with coverage",))
    ok, why = gates.scope_untouched_at_merge(
        "Python Tests (3.10)", job, MERGED_FILES, POLICY, push_trigger=None)
    assert not ok
    assert "could not be read here" in why

    empty = gates.PushTrigger(present=True)
    ok, why = gates.scope_untouched_at_merge(
        "Python Tests (3.10)", job, MERGED_FILES, POLICY, push_trigger=empty)
    assert not ok
    assert "could not be read here" in why


def test_a_delegated_scope_is_the_producing_workflows_own_push_paths():
    """The positive side: with the trigger readable and the merged files outside
    it, the skip is excused -- and with a file INSIDE it, it is not.

    The second half is what makes this a control rather than a rubber stamp:
    `tools/**` is in `test.yml`'s `on.push.paths`, which is exactly why a
    guard/test-only merge gets a REAL Python run and never reaches this branch.
    """
    job = _job("Python Tests (3.10)",
               steps=("Detect Python-relevant changes", "Run pytest with coverage"),
               skipped=("Run pytest with coverage",))
    trigger = gates.PushTrigger(present=True, paths=("**.py", "tools/**"))

    ok, why = gates.scope_untouched_at_merge(
        "Python Tests (3.10)", job, ["apps/fiab-console/app/page.tsx"], POLICY,
        push_trigger=trigger)
    assert ok, why
    assert "tools/**" in why

    ok, why = gates.scope_untouched_at_merge(
        "Python Tests (3.10)", job, ["tools/drain/gates.py"], POLICY,
        push_trigger=trigger)
    assert not ok
    assert "missed a change" in why


def test_green_at_merge_still_passes_a_check_that_did_its_work():
    """The other side, so the rule DISCRIMINATES rather than refusing the
    category. Without this, deleting the whole branch would also pass."""
    receipt = _receipt([
        _ev("next build (node 20)",
            merged_check=_green("next build (node 20)"),
            merged_job=_job("next build (node 20)",
                            steps=("Detect console changes", "Build (next build)"))),
    ])
    assert receipt.ok, receipt.reasons
    assert "Build (next build)" in receipt.by_state("green-at-merge")[0].detail


# ---------------------------------------------------------------------------
# CB4c -- an UNDECLARED context fails closed
# ---------------------------------------------------------------------------


def test_negative_control_an_undeclared_context_fails_closed():
    """Adding a required context must not silently remove it from the receipt.

    This is the property that makes the declaration a control rather than a
    convenience: the failure mode of a lookup table is that a new key is simply
    absent, and absence must not read as approval.
    """
    ok, why = gates.context_did_its_work("Brand New Required Check", _job("x"), POLICY)
    assert not ok
    assert "no substantive step is DECLARED" in why
    receipt = _receipt([
        _ev("Brand New Required Check",
            merged_check=_green("Brand New Required Check"),
            merged_job=_job("x")),
    ])
    assert not receipt.ok


def test_every_required_context_of_this_repo_is_declared():
    """...and the corollary: the contexts that exist today are all declared, so
    the fail-closed branch is not silently refusing the whole live set.

    A rule that fails closed on everything is as useless as one that passes
    everything, and only measuring both directions tells them apart.

    SET EQUALITY AGAINST A SNAPSHOT OF BRANCH PROTECTION, not a subset of a
    tuple retyped into this file. The previous version asserted that fifteen
    hand-copied names were a SUBSET of the declaration and never read the live
    required set at all, so it could not notice a rename in branch protection, a
    new matrix leg (`Python Tests (3.13)`), or a declared key that no longer
    corresponds to anything -- which is exactly the failure mode of a name-keyed
    lookup table, and exactly what `gates.DATA_NOT_NAMESPACE` names THIS test as
    the instrument for. Subset also made the direction that matters unobservable:
    an invented row could never fail it.

    The snapshot is refreshed with `--refresh-required-contexts`, which reads
    branch protection live; `test_the_required_context_snapshot_is_current`
    checks it against the live API when `gh` is reachable, and is skipped
    offline rather than making the whole suite need a network.
    """
    declared = set(POLICY["receipts"]["ci_green_rule"]["substantive_steps"])
    required = set(_required_context_snapshot())
    assert declared == required, {
        "declared but not required": sorted(declared - required),
        "required but not declared": sorted(required - declared),
    }


def test_the_required_context_snapshot_is_current():
    """The snapshot's own drift guard. Skipped when `gh` cannot reach GitHub,
    because a suite that needs a network is a suite people stop running.

    Also skipped in the mutation sandbox, and that is not merely tidiness: the
    matrix re-runs this suite once per arm, so a network call here is 200+ live
    API requests per matrix run, each one able to turn a KILLED into an ERROR
    for a reason that has nothing to do with the mutation.
    """
    import json
    import subprocess

    if _repo_root() is None:  # pragma: no cover - mutation sandbox
        pytest.skip("mutation sandbox - keeping the matrix offline")
    endpoint = ("repos/fgarofalo56/csa-inabox/branches/main/protection/"
                "required_status_checks")
    try:
        out = subprocess.run(
            ["gh", "api", endpoint, "--jq", ".contexts"],
            capture_output=True, text=True, timeout=45,
        )
    except (OSError, subprocess.SubprocessError) as exc:  # pragma: no cover - offline
        pytest.skip(f"gh unavailable: {exc}")
    if out.returncode != 0:  # pragma: no cover - offline or unauthorised
        pytest.skip(f"gh api failed (rc={out.returncode}): {out.stderr.strip()[:120]}")
    live = set(json.loads(out.stdout))
    snapshot = set(_required_context_snapshot())
    assert live == snapshot, {
        "live but not in the snapshot": sorted(live - snapshot),
        "in the snapshot but not live": sorted(snapshot - live),
        "refresh": "python tools/drain/merge_gate.py --refresh-required-contexts",
    }


def _job_steps(workflow_text: str, job_key: str) -> list[dict]:
    """The parsed step mappings of one job, by STRUCTURE rather than by position.

    ROUND 9. The drift guard used to find the detector's `id:` with a regex over
    the text FOLLOWING its `name:` line. That is order-dependent and
    idiom-dependent, and an independent reviewer broke it five ways with valid
    YAML: `id:` written before `name:`, a quoted `id: 'changed'`, and a sibling
    step whose name merely EXTENDS the declared one placed earlier in the job.
    The last of those reopened round 6's under-declaration hole with the whole
    suite green.

    Parsing the document removes the entire class: a step's `id` is the `id` key
    of its own mapping, whatever order the keys are in and however it is quoted.

    Note `yaml.safe_load` turns a workflow's bare `on:` key into `True` (YAML 1.1
    booleans). Harmless here -- only `jobs` is read -- but it is why this does
    not assert on the top-level key set.
    """
    import yaml

    doc = yaml.safe_load(workflow_text)
    jobs = (doc or {}).get("jobs") or {}
    steps = (jobs.get(job_key) or {}).get("steps") or []
    return [s for s in steps if isinstance(s, dict)]


def _repo_root():
    """The FULL checkout this package lives in, or None when out of tree.

    Walks UP looking for `.github/workflows` AND `scripts/ci` rather than
    counting `parents[3]`, because the mutation runner copies this package to a
    temp dir outside the repo and a fixed index silently resolves to somewhere
    else entirely.

    ROUND 8: `scripts/ci` is half of the marker precisely so this stays None in
    the mutation sandbox. The sandbox now carries the workflow files the drift
    guard needs (see `_workflow_root`), and keying BOTH helpers on
    `.github/workflows` would have un-skipped the two tests below that shell out
    to `node` and to `gh api` -- the second firing a network request on every
    one of 213 arms, each able to turn a KILLED into an ERROR for a reason that
    has nothing to do with the mutation. That is the tautology this package has
    already been burned by twice; the marker is what keeps it closed.
    """
    import pathlib

    for candidate in pathlib.Path(__file__).resolve().parents:
        if (candidate / ".github" / "workflows").is_dir() and (
                candidate / "scripts" / "ci").is_dir():
            return candidate
    return None


def _workflow_root():
    """The tree holding `.github/workflows`, in the repo OR in the sandbox.

    The drift guards need the workflow YAML and nothing else. Separating that
    from `_repo_root` is what lets them run inside the mutation sandbox, which
    is what makes a `policy.json` arm killable -- a guard that skips where the
    mutants live scores every arm KILLED regardless of the mutation.
    """
    import pathlib

    for candidate in pathlib.Path(__file__).resolve().parents:
        if (candidate / ".github" / "workflows").is_dir():
            return candidate
    return None


def _required_context_snapshot() -> list[str]:
    import json
    import pathlib

    path = pathlib.Path(__file__).resolve().parents[1] / "required_contexts.json"
    return json.loads(path.read_text(encoding="utf-8"))["contexts"]


# ---------------------------------------------------------------------------
# CB4e -- a STALE declaration fails closed
# ---------------------------------------------------------------------------


def test_negative_control_a_declared_step_absent_from_the_job_fails_closed():
    """If a workflow renames the step, the declaration is stale and the receipt
    must REFUSE -- not pass because it found nothing to object to.

    Silently passing is the worse direction: the check would stop being
    verified at the exact moment someone changed what it does.

    The fixture is a REAL rename. The first draft used `"Run gitleaks v2
    (renamed)"`, which still CONTAINS `"Run gitleaks"` -- so the substring match
    found it and the test failed, correctly. That is the declaration working as
    designed: a parenthetical suffix is not a rename.
    """
    renamed = _job("Secret Scan", steps=("Scan for secrets with trufflehog",))
    ok, why = gates.context_did_its_work("Secret Scan", renamed, POLICY)
    assert not ok
    assert "ABSENT from this job" in why
    assert "Run gitleaks" in why


# ---------------------------------------------------------------------------
# CB4f -- the ALL rule
# ---------------------------------------------------------------------------


def test_negative_control_the_all_rule_refuses_any_skipped_work_step():
    """`guardrails` (158 steps) and `Repo Hygiene` declare ALL, because their
    work is spread across every step rather than concentrated in one. ALL has
    to mean all, or those two contexts stop being checked at all."""
    ok, why = gates.context_did_its_work(
        "Repo Hygiene",
        _job("Repo Hygiene", steps=("Check for large files", "Check for committed secrets patterns"),
             skipped=("Check for committed secrets patterns",)),
        POLICY,
    )
    assert not ok
    assert "declared ALL" in why
    assert "SKIPPED" in why


def test_the_all_rule_passes_when_every_work_step_ran():
    ok, why = gates.context_did_its_work(
        "Repo Hygiene",
        _job("Repo Hygiene", steps=("Check for large files", "Check for committed secrets patterns")),
        POLICY,
    )
    assert ok
    assert "every one of its 2 work step(s) ran" in why


# ---------------------------------------------------------------------------
# The declaration's own shape
# ---------------------------------------------------------------------------


def test_negative_control_a_malformed_declaration_fails_closed():
    """Neither "ALL" nor a non-empty list is an unanswerable declaration, and an
    unanswered question is not evidence."""
    for bad in ("EVERYTHING", [], 7, None, {}):
        planted = copy.deepcopy(POLICY)
        planted["receipts"]["ci_green_rule"]["substantive_steps"]["Secret Scan"] = bad
        ok, why = gates.context_did_its_work("Secret Scan", _job("Secret Scan"), planted)
        assert not ok, bad
        assert "neither" in why or "no substantive step is DECLARED" in why


def test_a_declared_step_matches_as_a_substring():
    """Declarations name a step by substring so a parenthetical detail can
    change without breaking the receipt -- `Run vitest (with istanbul coverage
    floor)` carries an issue-number aside in some runs."""
    ok, _ = gates.context_did_its_work(
        "vitest (node 20)",
        _job("vitest (node 20)",
             steps=("Run vitest (with istanbul coverage floor) — #4432",)),
        POLICY,
    )
    assert ok


def test_negative_control_an_unrepresentable_scope_pattern_fails_closed():
    """Arm SC9. `glob_matches` RAISES on a pattern it cannot represent — `!`,
    `[0-9]`, `+(...)` — because treating one as a literal UNDER-matches, and
    under-matching a scope is the direction that EXCUSES. Without the guard this
    branch propagated that exception out of a gate whose whole contract is to
    fail closed: a crash instead of a refusal.

    `push_event_runs` has the identical guard one branch up, which is how the
    hole was visible at all — the two branches now resolve it the same way.
    """
    planted = copy.deepcopy(POLICY)
    planted["receipts"]["ci_green_rule"]["scope_paths"]["next build (node 20)"] = {
        "workflow": ".github/workflows/fiab-console-ci.yml",
        "gate_step": "Detect console changes",
        "outputs": [{
            "output": "console",
            "paths": ["apps/fiab-console/[0-9]**"],
            "gates": ["Build (next build)"],
        }],
    }
    hollow = _job("next build (node 20)", steps=("Detect console changes", "Build (next build)"),
                  skipped=("Build (next build)",))
    ok, why = gates.scope_untouched_at_merge(
        "next build (node 20)", hollow, MERGED_FILES, planted)
    assert not ok
    assert "cannot represent faithfully" in why


def test_negative_control_the_merged_sha_fixture_is_not_accidentally_empty():
    """Guards the fixture, not the code: `MERGED_SHA` being "" would make the
    rename branch's sha check vacuous everywhere in this file."""
    assert MERGED_SHA


# ---------------------------------------------------------------------------
# The six arms an independent reviewer wrote that SURVIVED round 3.
#
# Every one narrows a POPULATION rather than weakening a CHECK -- the `N*`
# lesson, which round 3's own arms had already been told and did not apply to
# the code they were about to add. A filter placed INSIDE the predicate beats a
# contract written about the predicate.
# ---------------------------------------------------------------------------


def test_negative_control_a_declaration_matching_several_steps_with_a_mixed_outcome():
    """RR2 / arm CB4i: `matches[:1]`.

    Round 3 asked `any(ran(s) for s in matches)`, so ONE running step satisfied
    a declaration no matter how many others matched and skipped -- which made
    the SIZE of the match set irrelevant and the truncation unobservable. The
    reviewer measured that zero declarations match more than one step today, so
    the risk is structural rather than live; that is precisely the kind that
    arrives later with no test watching.

    A mixed outcome is now UNDECIDABLE rather than optimistic: which of the two
    is the check cannot be read off the declaration, so it refuses and asks for
    a declaration that names one step.
    """
    job = _job(
        "vitest (node 20)",
        steps=("Run vitest (with istanbul coverage floor)",
               "Run vitest (with istanbul coverage floor) — second leg"),
        skipped=("Run vitest (with istanbul coverage floor) — second leg",),
    )
    ok, why = gates.context_did_its_work("vitest (node 20)", job, POLICY)
    assert not ok
    assert "matches 2 steps" in why
    assert "name exactly one step" in why


def test_the_all_rule_reads_past_the_fiftieth_work_step():
    """RR3 / arm CB4j: `work[:50]`.

    `guardrails` carries 158 work steps and is the context ALL was written for,
    yet every ALL fixture was 2-3 steps long -- so the rule was never exercised
    at the size that matters, and a bound of 50 was invisible.
    """
    steps = tuple(f"Guard {i:03d}" for i in range(120))
    job = _job("guardrails", steps=steps, skipped=(steps[99],))
    ok, why = gates.context_did_its_work("guardrails", job, POLICY)
    assert not ok
    assert "declared ALL" in why
    assert "Guard 099" in why


def test_every_failing_context_contributes_a_reason():
    """RR4 / arm CB4k: only the first failure is reported.

    Cosmetic on its own -- the receipt is NOT GREEN either way -- but a receipt
    that under-reports sends the reader to fix one context and re-run, twice.
    """
    receipt = _receipt(
        [
            _ev("next build (node 20)",
                merged_check=_green("next build (node 20)"),
                merged_job=_job("next build (node 20)",
                                steps=("Detect console changes", "Build (next build)"),
                                skipped=("Build (next build)",))),
            _ev("vitest (node 20)",
                merged_check=_green("vitest (node 20)"),
                merged_job=_job("vitest (node 20)",
                                steps=("Detect console changes",
                                       "Run vitest (with istanbul coverage floor)"),
                                skipped=("Run vitest (with istanbul coverage floor)",))),
        ],
        merged_changed_files=[*MERGED_FILES, "apps/fiab-console/app/page.tsx"],
    )
    assert not receipt.ok
    assert len(receipt.reasons) == 2, receipt.reasons
    assert any("next build" in r for r in receipt.reasons)
    assert any("vitest" in r for r in receipt.reasons)


def test_negative_control_green_at_merge_does_not_fall_back_to_the_pr_head_job():
    """RR5 / arm CB4h: `item.merged_job or item.head_job`.

    A real weakening, not a cosmetic one: the PR-head job is the `pull_request`
    hollow shape this very file documents -- `test.yml` reports SUCCESS there
    with `Run pytest`, `Lint with ruff` and `mypy` all skipped, by design. Using
    it to answer a question about the MERGED sha is the deferral defect wearing
    a fallback.
    """
    receipt = _receipt([
        _ev("Python Tests (3.10)",
            merged_check=_green("Python Tests (3.10)"),
            merged_job=None,
            head_job=_job("Python Tests (3.10)")),
    ])
    assert not receipt.ok
    assert any("no job record was read" in r for r in receipt.reasons)


def test_negative_control_a_scope_skip_needs_the_gate_step_to_be_present():
    """Arm SC6. A declaration naming a detector the job does not have is stale,
    and a stale declaration must refuse rather than excuse -- the same direction
    `CB4e` fixes for the substantive step."""
    job = _job("next build (node 20)", steps=("Build (next build)",),
               skipped=("Build (next build)",))
    ok, why = gates.scope_untouched_at_merge(
        "next build (node 20)", job, MERGED_FILES, POLICY)
    assert not ok
    assert "is ABSENT from this job" in why


def test_negative_control_a_scope_skip_refuses_an_all_declaration():
    """Arm SC7. `ALL` means every work step must run, so there is no single step
    whose skip a scope could explain. Planted rather than live, because no ALL
    context has a scope row -- and an unreachable branch is prose unless a test
    reaches it."""
    planted = copy.deepcopy(POLICY)
    planted["receipts"]["ci_green_rule"]["scope_paths"]["Repo Hygiene"] = {
        "workflow": ".github/workflows/validate.yml",
        "gate_step": "Detect changes",
        "output": "hygiene",
        "paths": ["apps/fiab-console/**"],
    }
    job = _job("Repo Hygiene", steps=("Detect changes", "Check for large files"),
               skipped=("Check for large files",))
    ok, why = gates.scope_untouched_at_merge("Repo Hygiene", job, MERGED_FILES, planted)
    assert not ok
    assert "never for \"ALL\"" in why


# ---------------------------------------------------------------------------
# ROUND 10: the single resolver, which round 9 added and left UNOBSERVED.
#
# An independent reviewer ran three arms over `steps_named` in a sandbox of the
# same shape as the matrix and ALL THREE SURVIVED the 397-test suite. No test
# named the function; no arm touched it; the round-9 diff added no regression
# case for the exploit it was written for. That is the third round running where
# a fix shipped without an instrument -- round 8 fixed the DATA and built none,
# round 9 fixed the LOGIC and built none.
# ---------------------------------------------------------------------------

def _steps(*pairs):
    return [{"name": n, "conclusion": c} for n, c in pairs]


def test_the_resolver_prefers_the_exact_step_over_one_that_merely_extends_it():
    """Kills X1. Round 9's exploit: `Jest (portal)` must not also resolve to
    `Jest (portal) - snapshot freshness report`, because the two disagree and
    the caller then drops the output from the scope question entirely."""
    steps = _steps(("Jest (portal)", "skipped"),
                   ("Jest (portal) - snapshot freshness report", "success"))
    matches, why = gates.steps_named("Jest (portal)", steps)
    assert matches is not None, why
    assert [s["name"] for s in matches] == ["Jest (portal)"]
    assert [s["conclusion"] for s in matches] == ["skipped"]


def test_the_resolver_refuses_several_loose_matches_with_no_exact_hit():
    """Kills X2. The fail-closed control the resolver exists to add: several
    near-misses and nothing named exactly that cannot say which was meant."""
    steps = _steps(("Jest (portal) - a", "success"), ("Jest (portal) - b", "skipped"))
    matches, why = gates.steps_named("Jest (portal)", steps)
    assert matches is None
    assert "NONE is named exactly that" in why, why

    # CONTROL: a single loose match is still accepted, or this test would pass
    # under a mutant that refuses every substring match.
    one, _ = gates.steps_named("Jest (portal)", _steps(("Jest (portal) - a", "success")))
    assert one is not None
    assert len(one) == 1


def test_the_resolver_returns_every_exact_match_not_just_the_first():
    """Kills X3. GitHub Actions permits two steps in one job to share a `name`
    (steps are a list, not a map). Returning only the first hides the second,
    and the second is what the duplicate-name attack adds."""
    steps = _steps(("Docs link check", "skipped"), ("Docs link check", "success"))
    matches, _ = gates.steps_named("Docs link check", steps)
    assert matches is not None
    assert len(matches) == 2, [s["conclusion"] for s in matches]


def test_blocker_a_duplicate_step_name_does_not_drop_the_output_from_the_question():
    """Kills X4. ROUND 10 BLOCKER, and round 8's blocker restored by a duplicate
    name where round 9 closed only the extending one.

    One added step named EXACTLY `Docs link check`, concluded success, pools with
    the real skipped one. Before the fix `all(c == "skipped")` came back False,
    `docs` was silently removed from `asked`, and its scope was never compared --
    so a merge carrying `docs/adr/0001.md` was accepted with "1 declared scope(s)
    checked" out of 3.
    """
    planted = copy.deepcopy(POLICY)
    row = planted["receipts"]["ci_green_rule"]["scope_paths"]["next build (node 20)"]
    row["outputs"].append(
        {"output": "docs", "paths": ["docs/**"], "gates": ["Docs link check"]})
    base = [
        {"name": "Detect console changes", "conclusion": "success"},
        {"name": "Build (next build)", "conclusion": "skipped"},
        {"name": "Docs link check", "conclusion": "skipped"},
        {"name": "Type-check (portal)", "conclusion": "success"},
        {"name": "Jest (portal)", "conclusion": "success"},
    ]
    files = ["portal/react-webapp/App.tsx", "docs/adr/0001.md"]

    # CONTROL: refused, because `docs/adr/0001.md` is inside a declared scope
    # whose gated step skipped.
    job = {"name": "next build (node 20)", "conclusion": "success", "steps": base}
    ok, why = gates.alternative_accounted_for(
        "next build (node 20)", job, files, planted)
    assert not ok, why
    assert "MATCHES" in why, why

    # EXPLOIT: one added step with a DUPLICATE name must not launder it.
    dup = {"name": "next build (node 20)", "conclusion": "success",
           "steps": [*base, {"name": "Docs link check", "conclusion": "success"}]}
    ok2, why2 = gates.alternative_accounted_for(
        "next build (node 20)", dup, files, planted)
    assert not ok2, "a duplicate step name laundered a matching declared scope"
    assert "one declared name cannot say whether its own work ran" in why2, why2


def test_an_output_may_not_declare_its_own_detector_or_bookkeeping_as_gated_work():
    """Kills X5 and X6. `ran_instead` refuses both; this caller -- whose answer
    decides WHICH SCOPES GET COMPARED -- refused neither, so a single policy line
    exempted an output's scope on the alternative route while the excuse route
    refused the byte-identical job."""
    steps = [
        {"name": "Detect console changes", "conclusion": "success"},
        {"name": "Build (next build)", "conclusion": "skipped"},
        {"name": "Set up job", "conclusion": "success"},
        {"name": "Type-check (portal)", "conclusion": "success"},
        {"name": "Jest (portal)", "conclusion": "success"},
    ]
    for gated, needle in [("Detect console changes", "its own change DETECTOR"),
                          ("Set up job", "runner BOOKKEEPING")]:
        planted = copy.deepcopy(POLICY)
        row = planted["receipts"]["ci_green_rule"]["scope_paths"]["next build (node 20)"]
        row["outputs"].append(
            {"output": "docs", "paths": ["docs/**"], "gates": [gated]})
        asked, why = gates._outputs_whose_work_did_not_run(
            "next build (node 20)", row, steps)
        assert asked is None, f"{gated!r} was accepted as gated work"
        assert needle in why, why


# ---------------------------------------------------------------------------
# ROUND 11: SIX mutations of these functions survived the 230-arm matrix, found
# by an independent reviewer who wrote their own arms. Every test below exists
# to kill one of them. Round 10's commit said it "adds nine instruments" and all
# nine pointed at the same two functions; these reach the ones it missed.
# ---------------------------------------------------------------------------

def test_an_alternative_resolving_to_steps_that_disagree_is_refused():
    """Kills Q8. Two steps named EXACTLY the same, one success and one skipped,
    cannot show the declared alternative ran -- and `steps_named` returns both,
    so the MIXED branch is the only thing that refuses.

    The alternative here is NOT in any output's `gates`, which is what makes the
    branch reachable: an alternative that IS gated work is refused earlier, by
    `_outputs_whose_work_did_not_run`'s own duplicate-name guard.
    """
    planted = copy.deepcopy(POLICY)
    planted["receipts"]["ci_green_rule"]["alternatives"]["next build (node 20)"] = [
        "Lint (next lint)"
    ]
    job = {
        "name": "next build (node 20)", "conclusion": "success",
        "steps": [
            {"name": "Detect console changes", "conclusion": "success"},
            {"name": "Build (next build)", "conclusion": "skipped"},
            {"name": "Type-check (portal)", "conclusion": "skipped"},
            {"name": "Jest (portal)", "conclusion": "skipped"},
            {"name": "Lint (next lint)", "conclusion": "success"},
            {"name": "Lint (next lint)", "conclusion": "skipped"},
        ],
    }
    ok, why = gates.alternative_accounted_for(
        "next build (node 20)", job, ["tools/drain/gates.py"], planted)
    assert not ok, why
    assert "MIXED outcome cannot show the alternative ran" in why, why


def test_a_bookkeeping_step_cannot_stand_in_as_a_declared_alternative():
    """Kills Q9. `usable` filters runner bookkeeping; without it a declared
    alternative that resolves only to a `Post ...` step counts as work done."""
    planted = copy.deepcopy(POLICY)
    planted["receipts"]["ci_green_rule"]["alternatives"]["next build (node 20)"] = [
        "Post Use Node.js 20"
    ]
    job = {
        "name": "next build (node 20)", "conclusion": "success",
        "steps": [
            {"name": "Detect console changes", "conclusion": "success"},
            {"name": "Build (next build)", "conclusion": "skipped"},
            {"name": "Type-check (portal)", "conclusion": "skipped"},
            {"name": "Jest (portal)", "conclusion": "skipped"},
            {"name": "Post Use Node.js 20", "conclusion": "success"},
        ],
    }
    ok, why = gates.alternative_accounted_for(
        "next build (node 20)", job, ["tools/drain/gates.py"], planted)
    assert not ok, why
    assert "runner bookkeeping" in why, why


def test_each_reason_an_alternative_was_not_counted_is_stated_specifically():
    """Kills Q11, Q12 and Q13 -- the three `not_counted` reasons round 10 added
    and asserted nowhere, so the ABSENT one could revert VERBATIM to the untrue
    'did not conclude success' with the suite green.

    R7: an error must not state as fact something the code did not establish.
    """
    base = [
        {"name": "Detect console changes", "conclusion": "success"},
        {"name": "Build (next build)", "conclusion": "skipped"},
        {"name": "Type-check (portal)", "conclusion": "skipped"},
        {"name": "Jest (portal)", "conclusion": "skipped"},
    ]
    cases = [
        ("Storybook (portal)", None, "is absent from this job"),
        ("Post Use Node.js 20", {"name": "Post Use Node.js 20",
                                 "conclusion": "success"},
         "runner bookkeeping"),
        ("Detect console changes", None, "IS the change detector"),
    ]
    for alt, extra, needle in cases:
        planted = copy.deepcopy(POLICY)
        planted["receipts"]["ci_green_rule"]["alternatives"][
            "next build (node 20)"] = [alt]
        steps = [*base, extra] if extra else list(base)
        job = {"name": "next build (node 20)", "conclusion": "success",
               "steps": steps}
        ok, why = gates.alternative_accounted_for(
            "next build (node 20)", job, ["tools/drain/gates.py"], planted)
        assert not ok, (alt, why)
        assert needle in why, (alt, why)
        # AND NOT the sentence round 10 removed for being untrue.
        assert "concluded success in this job" not in why, (alt, why)


def test_the_hollow_primary_precondition_consults_every_resolved_step():
    """Kills Q15. `_primary_steps_all_skipped` gates BOTH routes, and a `[:1]`
    narrowing of it is fail-OPEN: a decoy that SKIPPED ahead of a primary that
    RAN would read as cleanly hollow.

    Exact-match-wins makes the decoy irrelevant; the duplicate-name shape is
    what still needs every match consulted.
    """
    steps = [
        {"name": "Detect console changes", "conclusion": "success"},
        {"name": "Build (next build)", "conclusion": "skipped"},
        {"name": "Build (next build)", "conclusion": "success"},
    ]
    ok, why = gates._primary_steps_all_skipped(
        "next build (node 20)", steps, POLICY)
    assert not ok, "a duplicate primary that RAN read as cleanly hollow"
    assert "rather than `skipped`" in why, why

    # CONTROL: a decoy whose name merely EXTENDS the primary is ignored, so the
    # genuine hollow case still passes.
    decoyed = [
        {"name": "Detect console changes", "conclusion": "success"},
        {"name": "Build (next build) - bundle report", "conclusion": "success"},
        {"name": "Build (next build)", "conclusion": "skipped"},
    ]
    ok2, why2 = gates._primary_steps_all_skipped(
        "next build (node 20)", decoyed, POLICY)
    assert ok2, why2


def test_an_output_mixing_skipped_and_succeeded_refuses_for_that_reason():
    """Kills W2. Widening `outcomes == {"skipped"}` to `"skipped" in outcomes`
    still refuses this job -- via the #3783 scope message instead -- so only an
    assertion on the REASON can tell the two apart. A refusal reached by the
    wrong route is a coincidence, not a control.
    """
    job = {
        "name": "next build (node 20)", "conclusion": "success",
        "steps": [
            {"name": "Detect console changes", "conclusion": "success"},
            {"name": "Build (next build)", "conclusion": "skipped"},
            {"name": "Jest (portal)", "conclusion": "skipped"},
            {"name": "Type-check (portal)", "conclusion": "success"},
        ],
    }
    asked, why = gates._outputs_whose_work_did_not_run(
        "next build (node 20)", gates._scope_row("next build (node 20)", POLICY),
        job["steps"])
    assert asked is None, asked
    assert "cannot be read off the declaration" in why, why


def test_an_absent_primary_step_is_refused_not_tolerated():
    """Kills W3. `_primary_steps_all_skipped` is the precondition BOTH routes
    share, so a declaration naming a step no longer in the job must refuse --
    tolerating it reads a job with no primary at all as cleanly hollow.
    """
    steps = [
        {"name": "Detect console changes", "conclusion": "success"},
        {"name": "Jest (portal)", "conclusion": "skipped"},
    ]
    ok, why = gates._primary_steps_all_skipped(
        "next build (node 20)", steps, POLICY)
    assert not ok
    assert "is absent from this job" in why, why


def test_an_ambiguous_primary_step_is_refused_not_reduced():
    """Kills W4. Several loose matches and no exact hit cannot say which step
    the declaration means -- which is exactly what round 11's `steps_named`
    migration of this function was written to close, and what no arm covered.
    """
    steps = [
        {"name": "Detect console changes", "conclusion": "success"},
        {"name": "Build (next build) - bundle report", "conclusion": "skipped"},
        {"name": "Build (next build) - size check", "conclusion": "success"},
    ]
    ok, why = gates._primary_steps_all_skipped(
        "next build (node 20)", steps, POLICY)
    assert not ok
    assert "cannot be resolved" in why, why
    assert "NONE is named exactly that" in why, why


# ---------------------------------------------------------------------------
# ROUND 13: a step with NO conclusion. The most reachable defect this issue has
# produced -- no mutation, no policy edit, live production path -- plus the
# three readers an independent reviewer proved uninstrumented.
# ---------------------------------------------------------------------------

def test_a_step_still_running_is_not_a_step_that_did_nothing():
    """THE BLOCKER. `did_run` folded "has no conclusion" into "did not run", so
    a job with `queued` or `in_progress` work steps was excused with "no work
    step in the job ran - so there was nothing for it to do".

    Reachability was measured end to end by the reviewer, not argued: the job
    join applies no `status == "completed"` filter and PREFERS the job that
    executed less, so an in-progress duplicate wins in both input orders, and
    the live jobs API returned `guardrails steps=162 status=in_progress
    nullsteps=11` that day.
    """
    for unfinished in (None, "", "   "):
        job = {
            "name": "next build (node 20)", "conclusion": "success",
            "steps": [
                {"name": "Detect console changes", "conclusion": "success"},
                {"name": "Build (next build)", "conclusion": "skipped"},
                {"name": "Lint (next lint)", "conclusion": unfinished},
            ],
        }
        ok, why = gates.scope_untouched_at_merge(
            "next build (node 20)", job, MERGED_FILES, POLICY)
        assert not ok, f"conclusion={unfinished!r} read as 'did nothing': {why}"
        assert "have NOT CONCLUDED" in why, (unfinished, why)
        # AND THE MESSAGE MUST NOT CLAIM THE OPPOSITE (R7).
        assert "nothing for it to do" not in why, (unfinished, why)

    # CONTROL: every work step genuinely skipped is still the excuse this
    # branch exists for.
    clean = {
        "name": "next build (node 20)", "conclusion": "success",
        "steps": [
            {"name": "Detect console changes", "conclusion": "success"},
            {"name": "Build (next build)", "conclusion": "skipped"},
            {"name": "Lint (next lint)", "conclusion": "skipped"},
        ],
    }
    ok2, why2 = gates.scope_untouched_at_merge(
        "next build (node 20)", clean, MERGED_FILES, POLICY)
    assert ok2, why2


def test_the_shared_conclusion_reader_separates_none_from_every_verdict():
    """`None` is not `skipped`, not `success`, not `failure`. It is "this step
    has not said", and every reader must be able to tell it apart."""
    assert gates.step_conclusion({"conclusion": "SUCCESS"}) == "success"
    assert gates.step_conclusion({"conclusion": " Skipped "}) == "skipped"
    assert gates.step_conclusion({"conclusion": None}) is None
    assert gates.step_conclusion({"conclusion": ""}) is None
    assert gates.step_conclusion({}) is None
    assert gates.step_has_concluded({"conclusion": "failure"}) is True
    assert gates.step_has_concluded({"conclusion": None}) is False


def test_an_unconcluded_detector_does_not_answer_for_the_scope():
    """`_declared_gate_ran` must refuse a detector that has not concluded --
    an uninstrumented row the reviewer's arm survived on."""
    steps = [
        {"name": "Detect console changes", "conclusion": None},
        {"name": "Build (next build)", "conclusion": "skipped"},
    ]
    row = gates._scope_row("next build (node 20)", POLICY)
    ok, why, _ = gates._declared_gate_ran(row, steps)
    assert not ok
    assert "NOT CONCLUDED" in why, why


def test_an_unconcluded_primary_is_not_a_clean_scope_skip():
    """`_primary_steps_all_skipped` gates BOTH routes; a primary that has not
    concluded has not been shown to be hollow."""
    steps = [
        {"name": "Detect console changes", "conclusion": "success"},
        {"name": "Build (next build)", "conclusion": None},
    ]
    ok, why = gates._primary_steps_all_skipped(
        "next build (node 20)", steps, POLICY)
    assert not ok
    assert "NOT CONCLUDED" in why, why


def test_an_output_gating_an_absent_step_is_refused():
    """ROUND 13 BLOCKER 2. This refusal had NO test: replacing it with
    `continue` accepted a portal-only merge with `Type-check (portal)` missing
    from the job entirely, on the alternative route."""
    job = {
        "name": "next build (node 20)", "conclusion": "success",
        "steps": [
            {"name": "Detect console changes", "conclusion": "success"},
            {"name": "Build (next build)", "conclusion": "skipped"},
            {"name": "Jest (portal)", "conclusion": "success"},
        ],
    }
    ok, why = gates.alternative_accounted_for(
        "next build (node 20)", job, ["portal/react-webapp/src/App.tsx"], POLICY)
    assert not ok, why
    assert "absent from this job" in why, why


# ---------------------------------------------------------------------------
# ROUND 14: round 13's "root cause" fix landed on ONE OF THREE ROUTES. These
# cover the other two, plus the job's own verdict, which no route but
# `_renamed_at_merge` had ever read.
# ---------------------------------------------------------------------------

def test_green_at_merge_refuses_a_job_that_is_still_running():
    """BLOCKER. `context_did_its_work`'s `ran()` was the SEVENTH reader of
    `conclusion` and still coerced, so an in-progress job whose declared step
    had already succeeded was accepted as `green-at-merge` -- and the job join
    PREFERS that job in both input orders.

    TWO SEPARATE GUARDS, DRIVEN SEPARATELY. The first version of this test set
    the JOB conclusion to None as well, so the job-level refusal fired first and
    silently covered for the work-step refusal -- arm U1 SURVIVED the whole
    suite. A test that is satisfied by either of two guards cannot witness
    either, which is the shape an independent reviewer named one round earlier
    and which I then reproduced.
    """
    # 1. THE WORK-STEP GUARD, isolated: the job itself claims success while one
    #    of its work steps never concluded. GitHub should not emit this, but the
    #    job record here is chosen by a JOIN across duplicate jobs, so a
    #    half-written or truncated record can surface it -- and "should not
    #    happen" is not a control.
    step_level = {
        "name": "next build (node 20)", "conclusion": "success",
        "steps": [
            {"name": "Detect console changes", "conclusion": "success"},
            {"name": "Build (next build)", "conclusion": "success"},
            {"name": "Lint (next lint)", "conclusion": None},
        ],
    }
    ok, why = gates.context_did_its_work("next build (node 20)", step_level, POLICY)
    assert not ok, why
    assert "work step(s) have NOT CONCLUDED" in why, why

    # 2. THE JOB-LEVEL GUARD, isolated: every step concluded, the job did not.
    job_level = {
        "name": "next build (node 20)", "conclusion": None,
        "steps": [
            {"name": "Detect console changes", "conclusion": "success"},
            {"name": "Build (next build)", "conclusion": "success"},
        ],
    }
    ok2, why2 = gates.context_did_its_work("next build (node 20)", job_level, POLICY)
    assert not ok2, why2
    assert "its job record has not concluded" in why2, why2


def test_green_at_merge_refuses_a_job_that_concluded_failure():
    """The job's OWN verdict, which this route never read. A job that concluded
    `failure` was accepted as having executed its declared substantive step,
    and the join prefers the failed job over its green twin."""
    job = {
        "name": "next build (node 20)", "conclusion": "failure",
        "steps": [
            {"name": "Detect console changes", "conclusion": "success"},
            {"name": "Build (next build)", "conclusion": "success"},
        ],
    }
    ok, why = gates.context_did_its_work("next build (node 20)", job, POLICY)
    assert not ok, why
    assert "concluded 'failure', not success" in why, why

    # CONTROL: the same job concluding success is still accepted, or this
    # refuses the population every green receipt depends on.
    job["conclusion"] = "success"
    ok2, why2 = gates.context_did_its_work("next build (node 20)", job, POLICY)
    assert ok2, why2


def test_job_executed_does_not_call_a_queued_step_skipped():
    """BLOCKER. `job_executed` was the EIGHTH reader, and it is the SELECTOR
    that steers the receipt into a route -- so its message being false about a
    queued step (R7) also made the route choice wrong."""
    job = {
        "name": "guardrails", "conclusion": None,
        "steps": [
            {"name": "Set up job", "conclusion": "success"},
            {"name": "Run the guard", "conclusion": None},
        ],
    }
    ok, why = gates.job_executed(job)
    assert not ok
    assert "NOT CONCLUDED" in why, why
    assert "SKIPPED" not in why, why


# -- FINDING 5 (#4518): the job verdict, asked on ALL THREE routes ------------

#: The reviewer's fixture, reproduced exactly: the real unmodified `next build
#: (node 20)` policy row, its DETECTOR concluding `success` and every work step
#: `skipped`. That combination is what reaches route 2, and route 2 is the one
#: that read no job verdict. `_hollow_job` will NOT do -- it skips the detector
#: too, so the scope route refuses on a stale/absent gate step and the test
#: would pass without ever reaching the check it exists for.
_F5_STEPS = ("Detect console changes", "Build (next build)",
             "Type-check (portal)", "Jest (portal)")
_F5_WORK = ("Build (next build)", "Type-check (portal)", "Jest (portal)")


def _f5_job(conclusion):
    return _job("next build (node 20)", steps=_F5_STEPS, skipped=_F5_WORK,
                conclusion=conclusion)


def test_positive_control_a_successful_job_still_takes_the_scope_route():
    """THE CONTROL THAT MAKES THE THREE BELOW MEAN ANYTHING.

    Every test under this heading asserts a REFUSAL. A refusal proves nothing
    on its own -- a fixture that never reaches route 2 refuses for free, and
    then the job-verdict check could be deleted with the suite still green.
    This row is the one that would break if the fixture stopped reaching it:
    same job, same files, `conclusion='success'` -> ACCEPTED, and by the scope
    route specifically.
    """
    acct, evidence, route = gates.context_is_accounted_for(
        "next build (node 20)", _f5_job("success"), MERGED_FILES, POLICY)
    assert acct, evidence
    assert route == gates.ACCOUNTED_SCOPE_SKIP


@pytest.mark.parametrize("conclusion", ["failure", "cancelled"])
def test_blocker_a_job_that_did_not_pass_is_not_excused_by_its_scope(conclusion):
    """#4491 round 16, finding 5. Round 14 added the job-level conclusion check
    and it landed on ROUTE 1 ONLY, so a job that concluded `failure` was still
    accounted for as `scope-untouched-at-merge` -- the shape the entry point's
    own docstring says a single entry point makes impossible to write.

    THE SECOND ASSERTION IS THE LOAD-BEARING ONE. Route 2 STILL reads no job
    verdict -- it is unchanged by this fix and it still says "excused" about a
    failed job. If the composed answer refuses while route 2 accepts, the only
    thing that can be refusing is the gate this test is for. Drop the new check
    and `scope_route_alone` stays True while `acct` flips to True with it.
    """
    job = _f5_job(conclusion)

    scope_only, scope_why = gates.scope_untouched_at_merge(
        "next build (node 20)", job, MERGED_FILES, POLICY)
    assert scope_only, scope_why

    acct, evidence, route = gates.context_is_accounted_for(
        "next build (node 20)", job, MERGED_FILES, POLICY)
    assert not acct, evidence
    assert route == ""
    assert f"its job concluded {conclusion!r}, not success" in evidence
    assert "no route can account for" in evidence


def test_blocker_a_job_that_has_not_concluded_is_not_excused_by_its_scope():
    """The `None` row, which is the one that matters end-to-end:
    `merge_gate._jobs_by_name` deliberately prefers "the one that executed
    LESS", so an in-progress duplicate wins the join. That is the documented
    input rounds 13 and 14 exist for, and until finding 5 it was accounted for
    as a scope skip -- a merge certified on a job that was still running.
    """
    job = _f5_job(None)

    scope_only, scope_why = gates.scope_untouched_at_merge(
        "next build (node 20)", job, MERGED_FILES, POLICY)
    assert scope_only, scope_why

    acct, evidence, route = gates.context_is_accounted_for(
        "next build (node 20)", job, MERGED_FILES, POLICY)
    assert not acct, evidence
    assert route == ""
    assert "has not concluded" in evidence


def test_blocker_an_absent_job_record_fails_closed_on_every_route():
    """The `isinstance` guard moved up WITH the check it protects, and it is
    not defensive padding: `job` is `dict | None` by signature,
    `step_conclusion` does `step.get(...)`, and omitting the guard crashed the
    negative control on the first run of this change.

    Without it the routes below decide an absent job on their own terms, and
    route 2 is happy to excuse a context whose job was never read at all.
    """
    acct, evidence, route = gates.context_is_accounted_for(
        "next build (node 20)", None, MERGED_FILES, POLICY)
    assert not acct, evidence
    assert route == ""
    assert "no job record was read for it" in evidence
