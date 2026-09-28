"""#4728: the dependency-bump exemption in gate 3b.

Operator decision 2026-09-21 -- "dependency bumps merge on CI-green alone" --
existed only as prose until 2026-09-27. `review_requirement` never read it, so
a bot PR (which references no ledger item, so its stream never resolves)
escalated to TWO reviewers to re-derive by hand what CI had already measured.

WHAT IS ENCODED HERE IS PART OF THAT DECISION, NOT ALL OF IT, and the tests say
so rather than implying more: gate 2+3 (`gates.reduce_verdicts`) ends with an
unconditional "no live APPROVE at head" that this change does not touch, so a
qualifying bump needs ONE reviewer instead of two, never zero.
`test_the_exemption_does_not_reach_gate_2_3` pins that boundary, and
`test_merge_gate.py::test_a_bot_bump_still_needs_one_approve_from_gate_2_3`
pins it through the real gate.

THIS EXEMPTION LOOSENS A SAFETY GATE, so every test here names the input that
would make it fail, and the fail-closed arms are tested individually rather
than as one "it refuses" assertion -- three arms under one label is how a
finding gets closed at its label and left open at its sites.
"""
from __future__ import annotations

import copy
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import gates

POLICY = gates.load_policy(os.path.join(os.path.dirname(__file__), "..", "policy.json"))

#: EVERY declared author, not just the first. Production's dependabot login on
#: this repo is `app/dependabot` -- index 1 -- so a suite that only ever used
#: index 0 left the entry the live gate depends on unexercised.
BOTS = list(POLICY["review"]["dependency_bump_authors"])
BOT = BOTS[0]
LOCKS = ["requirements/locks/copilot/requirements.txt"]


def _req(**kw):
    """`review_requirement` with the merge-gate caller's real argument shape."""
    base = {"changed_paths": LOCKS, "prior_verdict": None, "stream": None,
            "footprint_known": True, "stream_known": False, "dependency_bump": True}
    base.update(kw)
    return gates.review_requirement(POLICY, **base)


def test_a_lock_only_bot_bump_needs_no_reviewers():
    """The decision, encoded. This is the whole point of the change.

    WHAT VALUE WOULD MAKE THIS FAIL: deleting the exemption branch, or setting
    `dependency_bump_reviewers` above 0 -- verified directly in
    `test_the_reviewer_count_is_read_from_policy_not_hard_coded`, which sets it
    to 2 and watches this call return 2.

    Either restores the state this change was written for: gate 3b escalating a
    bot PR to TWO independent reviewers because a bot PR references no ledger
    item, so its stream never resolves and the gate fails closed.

    NO ISSUE NUMBERS ARE CITED HERE ON PURPOSE. An earlier draft named #4617
    and #4618 as the bumps in that state. Measured 2026-09-27 with
    `gh pr view <n> --json state,changedFiles`: both are CLOSED and both report
    `changedFiles: 0`, so neither is evidence of anything any more. A docstring
    that cites a live PR as evidence goes stale in hours -- the behaviour is
    the evidence, and the behaviour is asserted below.
    """
    needed, why = _req()
    assert needed == 0, (needed, why)
    assert "reviewer COUNT only" in why, why


def test_the_exemption_does_not_reach_gate_2_3():
    """THE SCOPE, asserted rather than described.

    `reduce_verdicts` is gate 2+3 and is computed before `review_requirement`
    ever runs. It ends with an unconditional refusal when no live APPROVE
    exists, and nothing in this change touches it. So the exemption lowers the
    bar from two reviewers to ONE.

    WHAT VALUE WOULD MAKE THIS FAIL: any future edit that teaches
    `reduce_verdicts` about bumps. That would be a strictly larger loosening
    than the one granted -- a real change merging with no human or agent
    verdict at all -- and this assertion is what stops it arriving quietly.
    """
    ok, why = gates.reduce_verdicts([], [])
    assert ok is False, why
    assert "no live APPROVE at head" in why, why

    # POSITIVE CONTROL: the floor is a floor, not a wall. One APPROVE clears
    # it, so the assertion above is not satisfied by a function that always
    # refuses.
    approve = gates.Verdict(token="APPROVE", created_at="2026-09-27T12:00:00Z",
                            comment_id=1)
    ok, why = gates.reduce_verdicts([approve], [])
    assert ok is True, why


def test_the_exemption_does_not_apply_to_a_workflow_bump():
    """A bump that edits `.github/workflows` still needs TWO.

    WHAT VALUE WOULD MAKE THIS FAIL: moving the exemption ABOVE the
    escalation-path loop in `review_requirement`. That single reordering is
    the dangerous version of this change: CI-green proves least precisely
    where the diff can alter what CI runs.
    """
    needed, why = _req(changed_paths=[".github/workflows/copilot-evals.yml"])
    assert needed == 2, (needed, why)
    assert ".github/workflows" in why, why

    needed, why = _req(changed_paths=["portal/react-webapp/package-lock.json"])
    assert needed == 2, (needed, why)
    assert "portal/" in why, why


def test_a_blocking_verdict_still_escalates_a_bump():
    """Being a bot does not reduce a block.

    WHAT VALUE WOULD MAKE THIS FAIL: moving the exemption above the
    prior-verdict check. A reviewer who found a real defect in a bump would
    then be overruled by the bump's own exemption on the next gate run.
    """
    needed, why = _req(prior_verdict="REQUEST-CHANGES")
    assert needed == 2, (needed, why)
    assert "reviewer returned" in why, why


def test_the_footprint_conjunct_is_load_bearing():
    """`dependency_bump AND footprint_known`, with the second conjunct driven.

    DISCLOSED RATHER THAN OVERSOLD, per `assertion-design.md` "done" #5:
    through today's only caller this conjunct is an EQUIVALENT MUTANT.
    `merge_gate` passes `footprint_known=bool(changed)` and
    `is_dependency_bump` is True only when the path list is non-empty, so
    `dependency_bump and not footprint_known` is unreachable from there --
    an independent reviewer removed `and footprint_known` and the suite stayed
    at 934 passed.

    It is kept and pinned here because `review_requirement` is PUBLIC, has a
    second caller, and defaults the flag, so a future caller can reach the
    combination this asserts.

    WHAT VALUE WOULD MAKE THIS FAIL: deleting `and footprint_known` from the
    exemption branch. This call is the only site in the suite that varies it.
    """
    needed, why = _req(footprint_known=False)
    assert needed == 2, (needed, why)
    assert "footprint is not known" in why, why


@pytest.mark.parametrize("bot", BOTS)
def test_an_unknown_author_gets_no_exemption(bot):
    """FAIL-CLOSED ARM 1, tested on its own, for EVERY declared login.

    WHAT VALUE WOULD MAKE THIS FAIL: `author in authors` becoming a SUBSTRING
    test in either of its two shapes -- `author not in str(authors)` (BMP13)
    or `not any(author in a for a in authors)` (BMP14) -- a truthiness
    rewrite, or the author check being skipped entirely when the path list
    already matches (BMP3).

    THE SUBSTRING ROWS BELOW ARE WHAT MAKES THAT SENTENCE TRUE, and an
    earlier draft of this docstring named the substring rewrite while
    carrying no input that distinguishes it. `some-human` is not a substring
    of either declared login, so BOTH substring mutations SURVIVED the full
    suite -- control and both arms at 944 passed, 8 skipped, 1 deselected,
    measured on a sandbox copy of `8f66b718f` (the head before this round)
    with the anchor meta-test deselected the way `mutate_gates.main` does it
    -- while this docstring claimed they were covered. That is the exact
    shape `assertion-design.md` forbids: reporting a suite as covering a
    behaviour when no input distinguishes the correct code from the defect.

    It is not bookkeeping. `dependabot` is a real GitHub account, DISTINCT
    from the declared `dependabot[bot]`, and it is a proper substring of BOTH
    declared logins. Under either substring rewrite it takes the exemption --
    and this predicate is the only check standing between a human PR and a
    halved reviewer count.

    TWO NEAR-EQUIVALENT MUTANTS ARE DISCLOSED HERE RATHER THAN LEFT LOOKING
    LIKE A GAP, per `assertion-design.md` "done" #5. Both SURVIVE the full
    suite WITH the substring rows above present -- 950 passed, 8 skipped, 1
    deselected on a sandbox copy of this round's tree -- and are deliberately
    NOT arms:

        author.lower() not in [a.lower() for a in authors]        SURVIVED
        author.strip("[]") not in [a.strip("[]") for a in authors] SURVIVED

    THEY ARE NOT STRICT EQUIVALENTS, and saying so plainly matters more than
    claiming they are unkillable. Each HAS a distinguishing input --
    `DEPENDABOT[BOT]` for the first, `dependabot[bot` (unterminated, so
    `strip` makes both sides equal) for the second. Neither is PRODUCIBLE:
    the author reaching this function comes from `gh pr view --json author`,
    which returns GitHub's canonical casing, and a login truncated mid-
    bracket is not a string GitHub emits. So they are evidence about the arm
    rather than coverage this test lacks -- but the honest statement is "no
    input the caller can supply reaches the difference", not "no input
    exists".
    """
    ok, why = gates.is_dependency_bump(POLICY, "some-human", LOCKS)
    assert ok is False
    assert "not a declared bump author" in why, why

    ok, why = gates.is_dependency_bump(POLICY, None, LOCKS)
    assert ok is False
    assert "could not be read" in why, why

    # A PROPER SUBSTRING OF A DECLARED LOGIN -- the input the docstring above
    # names. The fixture's shape is ASSERTED against the policy read at
    # runtime rather than transcribed, so a future edit to
    # `dependency_bump_authors` that makes these strings no longer substrings
    # fails loudly here instead of quietly turning both rows into dead
    # weight.
    for impostor in ("dependabot", "pendabot"):
        assert any(impostor in declared for declared in BOTS), (
            f"{impostor!r} is no longer a substring of any declared login "
            f"({BOTS}), so this row would witness nothing")
        assert impostor not in BOTS, (
            f"{impostor!r} is now a DECLARED login, so it can no longer stand "
            "in for an impostor")
        ok, why = gates.is_dependency_bump(POLICY, impostor, LOCKS)
        assert ok is False, f"{impostor!r} took the bump exemption: {why}"
        assert "not a declared bump author" in why, why

    # POSITIVE CONTROL: the real bot still qualifies, so this is not satisfied
    # by a predicate that refuses everyone. Parametrized because production's
    # login is `app/dependabot` and a suite pinned to index 0 would leave the
    # entry the live gate actually depends on unexercised.
    ok, why = gates.is_dependency_bump(POLICY, bot, LOCKS)
    assert ok is True, why


def test_an_empty_file_list_gets_no_exemption():
    """FAIL-CLOSED ARM 2, tested on its own.

    WHAT VALUE WOULD MAKE THIS FAIL: treating `[]` as "touches nothing outside
    the allowlist", which is vacuously true and is exactly the boundary
    `footprint_known` already guards elsewhere in this module. A failed
    `gh pr diff` would then buy a weaker gate than a real one.
    """
    for empty in ([], None, [""]):
        ok, why = gates.is_dependency_bump(POLICY, BOT, empty)
        assert ok is False, empty
        assert "empty" in why, why


def test_one_path_outside_the_allowlist_voids_the_exemption():
    """FAIL-CLOSED ARM 3: the allowlist is a conjunction, not a majority vote.

    WHAT VALUE WOULD MAKE THIS FAIL: `any(...)` over the paths instead of
    checking that NONE is outside. A bump carrying twenty lock files and one
    source file would then be exempt, which is how a real change rides in on a
    bot PR.
    """
    ok, why = gates.is_dependency_bump(POLICY, BOT, [*LOCKS, "csa_platform/security/auth.py"])
    assert ok is False
    assert "outside the allowlist" in why, why
    assert "auth.py" in why, "the message must name the offending path"


def test_the_allowlist_is_read_from_policy_not_hard_coded():
    """Emptying the policy list must change the decision.

    WHAT VALUE WOULD MAKE THIS FAIL: a module-level tuple of path prefixes
    with `dependency_bump_paths` reading it instead of the policy. That is the
    exact defect `review._escalate` records one key above -- a list code does
    not read can be emptied, inverted or deleted with every decision
    unchanged.
    """
    empty = copy.deepcopy(POLICY)
    empty["review"]["dependency_bump_paths"] = []
    ok, why = gates.is_dependency_bump(empty, BOT, LOCKS)
    assert ok is False
    assert "no dependency_bump_paths" in why, why

    narrowed = copy.deepcopy(POLICY)
    narrowed["review"]["dependency_bump_paths"] = ["Cargo.lock"]
    ok, _ = gates.is_dependency_bump(narrowed, BOT, LOCKS)
    assert ok is False, "a narrowed allowlist must stop covering requirements/"


def test_the_author_list_is_read_from_policy_not_hard_coded():
    """The SECOND policy key, which had no guard at all.

    `dependency_bump_paths` got `BMP6`; its two siblings got nothing, and an
    independent reviewer measured both: hard-coding the author tuple in
    `is_dependency_bump` left the suite at 934 passed. Emptying
    `dependency_bump_authors` would then disable nothing, which is precisely
    the `_escalate` defect this change cites as its own justification.

    WHAT VALUE WOULD MAKE THIS FAIL: replacing the `dependency_bump_authors`
    read with a literal tuple. The INVERSION below is what kills it -- a test
    that only empties the list could be passed by a hard-coded implementation
    that happened to also check `if not authors`.
    """
    empty = copy.deepcopy(POLICY)
    empty["review"]["dependency_bump_authors"] = []
    ok, why = gates.is_dependency_bump(empty, BOT, LOCKS)
    assert ok is False
    assert "no dependency_bump_authors" in why, why

    inverted = copy.deepcopy(POLICY)
    inverted["review"]["dependency_bump_authors"] = ["some-human"]
    ok, why = gates.is_dependency_bump(inverted, "some-human", LOCKS)
    assert ok is True, why
    ok, why = gates.is_dependency_bump(inverted, BOT, LOCKS)
    assert ok is False, f"{BOT} must stop qualifying once policy drops it: {why}"


def test_the_reviewer_count_is_read_from_policy_not_hard_coded():
    """The THIRD policy key, which had no guard either.

    An independent reviewer replaced the `dependency_bump_reviewers` read with
    a literal `0` and the suite stayed at 934 passed -- so setting the key to 2
    in `policy.json` would have changed nothing, and the operator's only dial
    on this exemption was inert.

    WHAT VALUE WOULD MAKE THIS FAIL: any literal in place of that read. Both
    directions are asserted, because a test that only raises the value could be
    passed by an implementation that returns the count of something else.
    """
    raised = copy.deepcopy(POLICY)
    raised["review"]["dependency_bump_reviewers"] = 2
    needed, _ = gates.review_requirement(
        raised, changed_paths=LOCKS, stream_known=False, dependency_bump=True)
    assert needed == 2, "raising the policy value must raise the requirement"

    one = copy.deepcopy(POLICY)
    one["review"]["dependency_bump_reviewers"] = 1
    needed, _ = gates.review_requirement(
        one, changed_paths=LOCKS, stream_known=False, dependency_bump=True)
    assert needed == 1

    # NEGATIVE VALUES ARE CLAMPED, because `len(approvals) >= -5` is an
    # assertion no input can break -- the shape this whole module exists to
    # remove, arriving through a typo in a config file.
    silly = copy.deepcopy(POLICY)
    silly["review"]["dependency_bump_reviewers"] = -5
    assert gates.dependency_bump_reviewers(silly) == 0


@pytest.mark.parametrize("path", ["requirements/locks/streaming/requirements.txt",
                                  "requirements/ci-constraints.txt",
                                  "Cargo.lock",
                                  "apps/loom-directlake/Cargo.lock",
                                  "sdk/terraform-provider-loom/go.mod",
                                  "portal/react-webapp/package-lock.json"])
def test_the_allowlist_admits_a_real_lock_by_directory_or_by_filename(path):
    """The POSITIVE side of the segment matcher.

    `requirements/` matches as a top-level DIRECTORY; `Cargo.lock`, `go.mod`
    and `package-lock.json` match as FILE NAMES at any depth. Both halves of
    the grammar are exercised, so the negative rows below cannot be satisfied
    by a matcher that simply refuses everything.

    The last row is exempt by the allowlist and still refused by the
    escalation-path loop, which is the layering this change relies on -- so
    `is_dependency_bump` alone is NOT the safety boundary.

    WHAT VALUE WOULD MAKE THIS FAIL: narrowing the directory rule to an exact
    path, or the filename rule to top-level only.
    """
    ok, why = gates.is_dependency_bump(POLICY, BOT, [path])
    assert ok is True, why


@pytest.mark.parametrize("path", [
    # No LEFT boundary on a directory entry: `requirements/` must not match a
    # `requirements` directory nested at any depth.
    "evil/requirements/x.py",
    "csa_platform/requirements/backdoor.py",
    # No LEFT boundary at all: the bare-substring degradation.
    "notrequirements/evil.py",
    # No RIGHT boundary on a filename entry: `go.mod` must not admit
    # `go.modules/`, nor `poetry.lock` a shell script named after it.
    "go.modules/evil.py",
    "x/go.modules/evil.py",
    "Cargo.lockdir/evil.rs",
    "Cargo.tomlfoo/build.rs",
    "package-lock.json.py",
    "poetry.lock.sh",
])
def test_the_allowlist_matches_whole_segments_not_substrings(path):
    """EIGHT of these nine took the exemption at ZERO reviewers before the fix.

    Measured by an independent reviewer at `9d8952420` and re-derived at this
    head by driving that head's matcher -- `p.startswith(entry) or
    f"/{entry}" in p`, lifted from `9d8952420:gates.py:5706-5708` rather than
    transcribed -- over every row below. It has no boundary at either end, so
    a shell script was being classified as a lock file and any `requirements`
    directory at any depth qualified.

    THE COUNT IS EIGHT, NOT NINE, and saying "every one" was wrong. Measured:
    `notrequirements/evil.py` is REFUSED by that matcher, because
    `"notrequirements/evil.py"` neither starts with `"requirements/"` nor
    contains `"/requirements/"`. It is in this list for a different
    degradation -- the bare-substring form `any(entry in p)`, which is the
    only one of the four that admits it -- and the parametrize comment above
    it says so. The universal claim swept it up anyway.

    Reach over the tracked tree was ZERO on the day it was measured, so this
    was latent rather than live -- and latent is the hazard: it goes live the
    day someone adds `csa_platform/requirements/`, silently, with no test
    change.

    WHAT VALUE WOULD MAKE THIS FAIL, with each form's ADMITTED set measured
    over THE NINE ROWS IN THIS LIST -- the population is stated because a
    count without one is the defect this module is about:

      * the bare-substring form `any(entry in p)` -- 9 of 9, the only form
        that readmits `notrequirements/evil.py`;
      * the prefix form `p.startswith(entry)` -- 5 of 9: `poetry.lock.sh`,
        `package-lock.json.py`, `Cargo.lockdir/evil.rs`,
        `Cargo.tomlfoo/build.rs`, `go.modules/evil.py`. It does NOT readmit
        `notrequirements/evil.py`;
      * the embedded-segment form `f"/{entry}" in p` -- 3 of 9:
        `evil/requirements/x.py`, `csa_platform/requirements/backdoor.py`,
        `x/go.modules/evil.py`.

    Any one of the three turns at least one row red, so all three are genuine
    breaking values for this test.

    Arms BMP10 and BMP11 restore ONE boundary each -- the directory rule's
    left edge and the filename rule's right edge. They are not the whole
    grammar; the other three directions are pinned by
    `test_the_allowlist_has_a_boundary_in_every_direction`, which exists
    because all three SURVIVED the full suite while this file looked like it
    covered the matcher.

    This is the negative side the file previously lacked -- its only negative
    path was `csa_platform/security/auth.py`, which is refused by ANY
    plausible matcher and therefore had no kill power over the matching rule
    at all.
    """
    ok, why = gates.is_dependency_bump(POLICY, BOT, [path])
    assert ok is False, f"{path} must not be on the bump allowlist: {why}"
    assert "outside the allowlist" in why, why

    needed, _ = gates.review_requirement(
        POLICY, changed_paths=[path], stream_known=False, dependency_bump=ok)
    assert needed >= 1, f"{path} reached zero reviewers"


@pytest.mark.parametrize(("path", "arm"), [
    # DIRECTORY rule, RIGHT edge. `requirements/` must match the segment
    # `requirements` exactly, not merely start it. Killed by BMP15.
    ("requirementsfoo/evil.py", "BMP15"),
    ("requirements-dev/x.txt", "BMP15"),
    # FILENAME rule, LEFT edge. `go.mod` must not admit a file whose name
    # merely ENDS with it. Killed by BMP16.
    ("evil.go.mod", "BMP16"),
    ("x/my.package-lock.json", "BMP16"),
    # FILENAME rule, POSITION. A declared file name must match the LAST
    # segment, not any segment -- otherwise a DIRECTORY named `go.mod`
    # carries arbitrary files in with it. Killed by BMP17.
    ("go.mod/evil.py", "BMP17"),
    ("Cargo.lock/evil.rs", "BMP17"),
])
def test_the_allowlist_has_a_boundary_in_every_direction(path, arm):
    """The three directions BMP10 and BMP11 do NOT pin.

    The grammar has FIVE edges, not two: a directory entry has a left and a
    right boundary, and a filename entry has a left boundary, a right
    boundary, and a POSITION rule (last segment only). The shipped arms
    restore the directory-left edge (BMP10) and the filename-right edge
    (BMP11). The remaining three widenings all SURVIVED the full suite --
    control and each arm at 944 passed, 8 skipped, 1 deselected, measured on
    a sandbox copy of `8f66b718f` (the head before this round) with the
    anchor meta-test deselected the way `mutate_gates.main` does it -- so the
    matcher looked covered and was not:

        parts[0].startswith(entry.rstrip("/"))   SURVIVED  -> now BMP15
        parts[-1].endswith(entry)                SURVIVED  -> now BMP16
        entry in parts                           SURVIVED  -> now BMP17

    WHAT VALUE WOULD MAKE THIS FAIL: each row above is the input that breaks
    exactly one of those three, and the mapping is MEASURED rather than
    reasoned -- all five matcher predicates (BMP10, BMP11, BMP15, BMP16,
    BMP17) were driven over every negative row in this file, and each row
    here is admitted by its named arm and by no OTHER matcher arm.

    NOT A HISTORICAL REGRESSION LIST, unlike its sibling above, and the
    difference is stated because conflating them is how a universal claim
    goes wrong. Driving `9d8952420`'s matcher over these rows: only
    `go.mod/evil.py` and `Cargo.lock/evil.rs` were admitted by it. The four
    others were refused by the shipped defect and are refused now -- they
    pin a boundary the grammar requires, not a hole that was once open.
    """
    ok, why = gates.is_dependency_bump(POLICY, BOT, [path])
    assert ok is False, f"{path} must not be on the bump allowlist ({arm}): {why}"
    assert "outside the allowlist" in why, why

    needed, _ = gates.review_requirement(
        POLICY, changed_paths=[path], stream_known=False, dependency_bump=ok)
    assert needed >= 1, f"{path} reached zero reviewers"

    # POSITIVE CONTROL, so these rows cannot be satisfied by a matcher that
    # refuses everything: the un-degraded neighbour of each row is still
    # admitted. `requirements/locks/x.txt` exercises the directory rule,
    # `x/go.mod` the filename rule at depth -- which is the pair the three
    # widenings above would each have left working, so a green here plus a
    # red above is what localises the defect to a boundary.
    for legitimate in ("requirements/locks/x.txt", "x/go.mod"):
        ok, why = gates.is_dependency_bump(POLICY, BOT, [legitimate])
        assert ok is True, f"{legitimate} must still qualify: {why}"

