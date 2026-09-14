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
    assert "rather than success" in why


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

    root = _repo_root()
    if root is None:  # pragma: no cover - mutation sandbox
        pytest.skip("workflow tree not reachable from here (mutation sandbox)")
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

        if row["paths"] == gates.ON_PUSH_PATHS:
            shapes.add("delegated")
            # The delegation itself is the contract. If the detector stops
            # reading the trigger out of its own file, the declaration below
            # stops describing it -- and that is precisely the silent drift.
            assert "python_trigger_scope.py --changed-file" in text, (
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

        shapes.add("literal")
        found = None
        for match in re.finditer(r"grep -qE '([^']+)'", text):
            tail = text[match.end():match.end() + 400]
            if f'echo "{row["output"]}=true"' not in tail:
                continue
            found = {
                alt.lstrip("^").replace(r"\.", ".").rstrip("/")
                for alt in match.group(1).split("|")
            }
            break
        assert found is not None, (
            f"{name}: no `grep -qE` in {row['workflow']} sets "
            f"{row['output']}=true - the detector's shape changed"
        )
        declared = {p[: -len("/**")] if p.endswith("/**") else p for p in row["paths"]}
        assert declared == found, (name, sorted(declared), sorted(found))

    assert shapes == {"literal", "delegated"}, (
        f"both row shapes must stay exercised; saw {sorted(shapes)}"
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


def _repo_root():
    """The checkout this package lives in, or None when it is not reachable.

    Walks UP looking for `.github/workflows` rather than counting `parents[3]`,
    because the mutation runner copies this package to a temp dir outside the
    repo and a fixed index silently resolves to somewhere else entirely.
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
        "output": "console",
        "paths": ["apps/fiab-console/[0-9]**"],
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
