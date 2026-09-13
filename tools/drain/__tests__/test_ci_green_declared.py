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

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_ci_green import (
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
    """
    hollow = _job("next build (node 20)", steps=("Detect console changes", "Build (next build)"),
                  skipped=("Build (next build)",))
    receipt = _receipt([
        _ev("next build (node 20)",
            merged_check=_green("next build (node 20)"),
            merged_job=hollow),
    ])
    assert not receipt.ok
    assert any("Build (next build)" in r for r in receipt.reasons)
    assert any("not done the thing it is required for" in r for r in receipt.reasons)


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
    """...and the corollary: the 15 contexts that exist today are all declared,
    so the fail-closed branch is not silently refusing the whole live set.

    A rule that fails closed on everything is as useless as one that passes
    everything, and only measuring both directions tells them apart.
    """
    declared = POLICY["receipts"]["ci_green_rule"]["substantive_steps"]
    for name in (
        "Python Lint", "Python Tests (3.10)", "Python Tests (3.11)",
        "Python Tests (3.12)", "PowerShell Lint", "Secret Scan", "Repo Hygiene",
        "dbt Compile (shared)", "dbt Compile (finance)", "dbt Compile (inventory)",
        "dbt Compile (sales)", "next build (node 20)", "guardrails",
        "vitest (node 20)", "changelog parser can read every commit message",
    ):
        assert name in declared, name


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


def test_negative_control_the_merged_sha_fixture_is_not_accidentally_empty():
    """Guards the fixture, not the code: `MERGED_SHA` being "" would make the
    rename branch's sha check vacuous everywhere in this file."""
    assert MERGED_SHA
