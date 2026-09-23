"""The declaration is resolved AS OF the measured sha (#4676).

`policy.json`'s `receipts.ci_green_rule` describes the workflow AT HEAD.
Judging a MERGED PR's job against it asks a run from last week whether it
executed a step that was created yesterday -- and the refusal it printed said
*the declaration is stale*, which points the reader at the one edit that would
make the declaration wrong for every merge AFTER the rename.

Measured, on the attempt that found it:

    PR #4593 merged 2026-09-20T01:24:35Z. Commit `8d3dd9cbb` (#4657,
    2026-09-21) renamed `vitest (node 20)`'s substantive step from
    `Run vitest (with istanbul coverage floor)` to `Merge shard reports and
    enforce the coverage floor` -- in `fiab-console-ci.yml`, in
    `substantive_steps` and in `scope_paths[].outputs[].gates`, in ONE commit.
    `tick.py --record-receipt 4467 --from-pr 4593` then refused with
    `the declared step(s) ['Merge shard reports and enforce the coverage
    floor'] are ABSENT from this job - the declaration is stale`.

THE CODE IS HEAD'S; THE DECLARATION IS THE SHA'S. Every predicate in
`gates.py` is today's, because every hole reviewers found in rounds 5-16 is
fixed at HEAD and must apply to every measurement. `ci_green_rule` is not a
predicate -- it is a description of a workflow, versioned in the same commit as
the workflow, and the repo therefore already records what it said on the day
any given run happened. That is why this is a git read and NOT an alias table:
there is nothing to transcribe and no second copy to keep in agreement.

Run:  python -m pytest tools/drain/__tests__/
"""
from __future__ import annotations

import copy
import os
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_ci_green import (
    MERGED_FILES,
    POLICY,
    _ev,
    _green,
    _job,
    _receipt,
)
from test_ci_green_declared import INFRA_ERE

import gates

#: The real rename, measured rather than assumed -- and it is NOT one commit.
#: The workflow and the declaration that describes it are two files, and #4657
#: moved them 3h13m apart:
#:
#:     8d3dd9cbb  2026-09-21 21:25  .github/workflows/fiab-console-ci.yml (#4657)
#:     356290aa9  2026-09-22 00:38  tools/drain/policy.json               (#4662)
#:
#: THREE merges landed between them -- #4652, #4654, #4658 -- and for those the
#: job carries the NEW step name while the declaration at their sha still names
#: the OLD one. That window is why `context_did_its_work` consults two clocks
#: and not one; the first draft of this change resolved strictly as-of and would
#: have refused all three, which is #4676 in mirror image.
#:
#: Both spellings are TRANSCRIBED here rather than read out of git: a test that
#: reaches into history fails on a shallow checkout, which is what
#: `actions/checkout` produces by default.
#: `test_the_rename_fixture_matches_what_policy_json_actually_carried` checks
#: the transcription against the repo where the objects are present and SKIPS
#: where they are not -- the same bargain `INFRA_ERE` strikes with `node`,
#: stated rather than implied.
WORKFLOW_RENAME_COMMIT = "8d3dd9cbb"
POLICY_RENAME_COMMIT = "356290aa9"
RENAME_COMMIT = POLICY_RENAME_COMMIT
STEP_BEFORE_RENAME = "Run vitest (with istanbul coverage floor)"
STEP_AFTER_RENAME = "Merge shard reports and enforce the coverage floor"

#: The merged sha of PR #4593 -- the merge the receipt could not take. Used as
#: a fixture value only; nothing here reads it from GitHub.
SHA_BEFORE_RENAME = "6bf53f52d085"


def _rule_before_the_rename():
    """HEAD's `ci_green_rule`, with the vitest rename UNDONE.

    DERIVED FROM THE LIVE RULE BY SUBSTITUTION, never written out, so a future
    change to any other row cannot leave this fixture describing a policy shape
    the code no longer reads. The substitution is asserted: if HEAD ever stops
    carrying `STEP_AFTER_RENAME`, this RAISES instead of quietly returning a
    rule identical to HEAD's -- which would be a fixture that cannot fail,
    passing both halves of the pair test while witnessing nothing.
    """
    rule = copy.deepcopy(POLICY["receipts"]["ci_green_rule"])
    assert rule["substantive_steps"]["vitest (node 20)"] == [STEP_AFTER_RENAME], (
        "HEAD no longer declares the post-rename step, so this fixture would be "
        "identical to HEAD's rule and could not witness the as-of resolution"
    )
    rule["substantive_steps"]["vitest (node 20)"] = [STEP_BEFORE_RENAME]
    # THE SAME RENAME, IN THE SCOPE ROW. #4657 moved the name in three places in
    # one commit, because all three are descriptions of one workflow. A fixture
    # that renamed only `substantive_steps` would make arm AS2 -- the narrowing
    # that swaps only that key -- survive.
    moved = 0
    for output in rule["scope_paths"]["vitest (node 20)"]["outputs"]:
        gates_before = list(output["gates"])
        output["gates"] = [
            STEP_BEFORE_RENAME if g == STEP_AFTER_RENAME else g for g in gates_before
        ]
        moved += sum(1 for a, b in zip(gates_before, output["gates"]) if a != b)
    assert moved == 1, (
        f"expected exactly one scope-row gate to carry the renamed step, moved {moved}"
    )
    return rule


def test_a_merge_from_before_a_step_rename_and_one_from_after_both_measure():
    """THE PAIR, in one run. This is #4676's acceptance test.

    WHAT VALUE WOULD MAKE THIS FAIL: resolving the declaration at HEAD instead
    of at the measured sha. The BEFORE half then reports `['Merge shard reports
    and enforce the coverage floor'] are ABSENT from this job`, because that
    step did not exist on 2026-09-20. That is arm AS1 in `mutate_gates.py`.

    THE AFTER HALF IS NOT DECORATION. A "fix" that reaches for the old name --
    an alias table, a hardcoded fallback, a substring both spellings share --
    passes the BEFORE half and breaks every merge since the rename. Measuring
    both in ONE run is what makes that visible, and it is why the issue asked
    for a pair rather than a regression test.

    THE FIXTURE IS PROVED TO REACH THE RULE, inline: the first assertion drives
    the BEFORE job with NO as-of declaration and requires a REFUSAL. Without it,
    a test that passed because the predicate accepts everything would be
    indistinguishable from one that passed because the resolution works.
    """
    before_rule = _rule_before_the_rename()
    # The arithmetic of the fixture, asserted rather than trusted: the two
    # spellings must actually differ, and neither may contain the other --
    # declared steps are matched as SUBSTRINGS, so a shared prefix would let
    # HEAD's declaration match the old step and the pair would witness nothing.
    assert STEP_BEFORE_RENAME != STEP_AFTER_RENAME
    assert STEP_BEFORE_RENAME not in STEP_AFTER_RENAME
    assert STEP_AFTER_RENAME not in STEP_BEFORE_RENAME

    before_job = _job("vitest (node 20)",
                      steps=("Detect console changes", STEP_BEFORE_RENAME))
    after_job = _job("vitest (node 20)",
                     steps=("Detect console changes", STEP_AFTER_RENAME))

    # POSITIVE CONTROL FOR THE FIXTURE. HEAD's declaration does not describe the
    # pre-rename job -- that IS the defect -- so this must refuse. If it ever
    # stops refusing, the two halves below prove nothing.
    stale, why = gates.context_did_its_work("vitest (node 20)", before_job, POLICY)
    assert not stale
    assert STEP_AFTER_RENAME in why
    assert "ABSENT" in why

    # BEFORE the rename: judged by the declaration as of that sha.
    ok_before, ev_before = gates.context_did_its_work(
        "vitest (node 20)", before_job, POLICY,
        declared_at=gates.DeclarationAsOf(sha=SHA_BEFORE_RENAME, rule=before_rule),
    )
    assert ok_before, ev_before
    assert STEP_BEFORE_RENAME in ev_before
    # And the pass NAMES the declaration it was decided on, so a reader does not
    # have to diff `git show <sha>:tools/drain/policy.json` to find out which.
    assert f"AS OF the measured sha {SHA_BEFORE_RENAME}" in ev_before

    # AFTER the rename: the as-of declaration IS HEAD's, and nothing changes --
    # including the wording, which must not annotate every modern PR's receipt.
    ok_after, ev_after = gates.context_did_its_work(
        "vitest (node 20)", after_job, POLICY,
        declared_at=gates.DeclarationAsOf(
            sha="8d3dd9cbb7a7", rule=POLICY["receipts"]["ci_green_rule"]),
    )
    assert ok_after, ev_after
    assert STEP_AFTER_RENAME in ev_after
    assert "AS OF the measured sha" not in ev_after


def test_the_whole_receipt_takes_the_pre_rename_merge_not_just_the_predicate():
    """The pair again through `ci_green_receipt`, the function the CLI calls.

    `context_did_its_work` passing proves the predicate. This proves the
    argument actually arrives there, through `ci_green_receipt` ->
    `_one_context` -> `context_is_accounted_for`.

    WHAT VALUE WOULD MAKE THIS FAIL: dropping `declared_at=declared_at` from any
    one of those three hops. The receipt then reports NOT GREEN naming the
    post-rename step -- which is the exact output #4676 records.

    THE PROVENANCE ASSERTION IS NOT DECORATION, and it is here because its
    absence let a real defect through. The first version of this change passed
    `context_is_accounted_for`'s ALREADY-SUBSTITUTED policy to route 1, so
    `head_declared` read the as-of rule, the two compared equal, and the
    "AS OF the measured sha" clause disappeared from every real receipt --
    measured on PR #4593, verdict correct, disclosure gone. The unit test above
    did not see it because it calls the predicate directly with HEAD's policy,
    which is exactly the path production does NOT take. Only an assertion made
    THROUGH `ci_green_receipt` can witness it.
    """
    before_rule = _rule_before_the_rename()
    before_job = _job("vitest (node 20)",
                      steps=("Detect console changes", STEP_BEFORE_RENAME))
    evidence = [
        _ev("vitest (node 20)", merged_check=_green("vitest (node 20)"),
            merged_job=before_job),
        _ev("Secret Scan", merged_check=_green("Secret Scan")),
    ]

    # POSITIVE CONTROL: the same evidence with no as-of declaration is REFUSED.
    stale = _receipt(evidence)
    assert not stale.ok
    assert any(STEP_AFTER_RENAME in reason for reason in stale.reasons)

    receipt = _receipt(
        evidence,
        declared_at=gates.DeclarationAsOf(sha=SHA_BEFORE_RENAME, rule=before_rule),
    )
    assert receipt.ok, receipt.reasons
    states = {c.name: c.state for c in receipt.contexts}
    detail = {c.name: c.detail for c in receipt.contexts}
    assert states["vitest (node 20)"] == gates.ACCOUNTED_DID_WORK
    # The line a reader acts on names WHICH declaration decided it, and names
    # both spellings. Without this the verdict is right and the receipt is
    # silent about having judged on a declaration HEAD no longer carries.
    assert STEP_BEFORE_RENAME in detail["vitest (node 20)"]
    assert f"AS OF the measured sha {SHA_BEFORE_RENAME}" in detail["vitest (node 20)"]
    assert STEP_AFTER_RENAME in detail["vitest (node 20)"]
    # And a context whose declaration did NOT move is not annotated.
    assert "AS OF the measured sha" not in detail["Secret Scan"]
    # The second context is not padding: it proves the substituted declaration
    # is scoped to the call and did not replace the policy every other context
    # is judged by.
    assert states["Secret Scan"] == gates.ACCOUNTED_DID_WORK


def test_the_as_of_declaration_governs_the_alternatives_and_the_scope_row_too():
    """Not only `substantive_steps`. All three keys describe ONE workflow.

    A resolution that swaps only the first fixes route 1 and leaves routes 2
    and 3 asking a pre-rename job about a post-rename step -- the identical
    defect one route over, which is this package's most-repeated shape
    ("fixed on one side only").

    WHAT VALUE WOULD MAKE THIS FAIL: narrowing `_declaration_as_of` to
    `substantive_steps` only. That is arm AS2. The scope row then gates the
    `console` output on a step name this job does not carry, so the alternative
    cannot be corroborated and the route refuses.

    The job is the `alternative-work-at-merge` shape -- primary hollow, the
    infra half run -- taken at a sha BEFORE the rename.
    """
    before_rule = _rule_before_the_rename()
    job = _job(
        "vitest (node 20)",
        steps=("Detect console changes", STEP_BEFORE_RENAME,
               "Run vitest (infra-reading suites only)"),
        skipped=(STEP_BEFORE_RENAME,),
    )
    # POSITIVE CONTROL: HEAD's declaration cannot account for this job by ANY
    # route, so the acceptance below cannot be coming from somewhere else.
    stale_ok, _stale_why, stale_route = gates.context_is_accounted_for(
        "vitest (node 20)", job, MERGED_FILES, POLICY, infra_ere=INFRA_ERE)
    assert not stale_ok
    assert stale_route == ""

    acct, evidence, route = gates.context_is_accounted_for(
        "vitest (node 20)", job, MERGED_FILES, POLICY, infra_ere=INFRA_ERE,
        declared_at=gates.DeclarationAsOf(sha=SHA_BEFORE_RENAME, rule=before_rule),
    )
    assert acct, evidence
    assert route == gates.ACCOUNTED_ALTERNATIVE
    # The primary it reports as skipped is the PRE-RENAME one -- read out of the
    # as-of declaration, not out of HEAD's.
    assert STEP_BEFORE_RENAME in evidence
    assert "Run vitest (infra-reading suites only)" in evidence


def test_an_unreadable_as_of_declaration_refuses_in_DIFFERENT_words():
    """The two failure modes have OPPOSITE remedies, so they get two sentences.

    - the declaration is stale at HEAD  -> re-read it off a green run.
    - the step did not exist at the sha -> obtain the sha; do NOT touch
      `policy.json`, which is correct for HEAD.

    Printing one sentence for both is what #4676 cost: the refusal for a
    2026-09-20 run read "the declaration is stale", and the declaration was
    exactly current.

    WHAT VALUE WOULD MAKE THIS FAIL: collapsing the two branches into one
    message, or falling back to HEAD silently with no disclosure. The
    discriminating substrings are `could NOT be read` and `re-read it off a
    green run`, and each occurs in only one of the two arms -- an assertion on
    a substring both carry would pass with the branches merged.
    """
    before_job = _job("vitest (node 20)",
                      steps=("Detect console changes", STEP_BEFORE_RENAME))

    # The attempt was MADE and FAILED: HEAD's declaration is what is left, and
    # the refusal says the sha's could not be read rather than blaming it.
    unreadable = gates.DeclarationAsOf(
        sha=SHA_BEFORE_RENAME, rule=None,
        error="git show 6bf53f52d085:tools/drain/policy.json exited 128: bad object",
    )
    ok, why = gates.context_did_its_work(
        "vitest (node 20)", before_job, POLICY, declared_at=unreadable)
    assert not ok
    assert "could NOT be read" in why
    # The REASON is quoted, not summarised -- R7: the message may not assert a
    # cause it did not establish, and "bad object" is the cause git gave.
    assert "bad object" in why
    assert "do NOT edit policy.json" in why
    assert "re-read it off a green run" not in why

    # The OTHER failure: the declaration AT THE SHA was read and does not
    # describe this job either. That one IS stale, and says so.
    wrong_rule = copy.deepcopy(POLICY["receipts"]["ci_green_rule"])
    wrong_rule["substantive_steps"]["vitest (node 20)"] = ["A step nobody ever ran"]
    ok2, why2 = gates.context_did_its_work(
        "vitest (node 20)", before_job, POLICY,
        declared_at=gates.DeclarationAsOf(sha=SHA_BEFORE_RENAME, rule=wrong_rule))
    assert not ok2
    assert "re-read it off a green run" in why2
    assert f"AS OF the measured sha {SHA_BEFORE_RENAME}" in why2
    assert "could NOT be read" not in why2


def test_no_as_of_resolution_attempted_keeps_todays_message_exactly():
    """`declared_at=None` is a THIRD state, not a synonym for "unreadable".

    A direct unit call, and any caller not yet taught to resolve the sha, has
    exactly today's information -- so it gets exactly today's sentence.
    Conflating it with the unreadable case would tell a developer running the
    predicate by hand to fetch a sha they never named.

    WHAT VALUE WOULD MAKE THIS FAIL: routing `None` into the
    `DECL_HEAD_UNVERIFIED` branch, which would put `could NOT be read` into a
    message about a sha that was never supplied.
    """
    job = _job("vitest (node 20)",
               steps=("Detect console changes", STEP_BEFORE_RENAME))
    ok, why = gates.context_did_its_work("vitest (node 20)", job, POLICY)
    assert not ok
    assert "the declaration is stale, or this is not the job it describes" in why
    assert "could NOT be read" not in why
    assert "AS OF the measured sha" not in why


def test_substituting_a_declaration_does_not_mutate_the_callers_policy():
    """The loaded contract is shared by every context in a receipt.

    `_declaration_as_of` copies two levels rather than writing into `policy`,
    because a mutation would make the declaration used for context N+1 depend
    on the sha resolved for context N -- an order-dependent gate, which is the
    worst shape a gate can have because it is green on a re-run.

    WHAT VALUE WOULD MAKE THIS FAIL: `policy["receipts"]["ci_green_rule"] =
    as_of.rule` in place of the copy. HEAD's declaration then reads
    `['Run vitest (with istanbul coverage floor)']` after this call.
    """
    before = copy.deepcopy(POLICY["receipts"]["ci_green_rule"]["substantive_steps"])
    effective, provenance, sha = gates._declaration_as_of(
        POLICY, gates.DeclarationAsOf(sha=SHA_BEFORE_RENAME,
                                      rule=_rule_before_the_rename()))
    assert provenance == gates.DECL_AS_OF
    assert sha == SHA_BEFORE_RENAME
    # The substitution reached the returned policy ...
    assert (effective["receipts"]["ci_green_rule"]["substantive_steps"]
            ["vitest (node 20)"] == [STEP_BEFORE_RENAME])
    # ... and did NOT reach the caller's.
    assert POLICY["receipts"]["ci_green_rule"]["substantive_steps"] == before
    assert (POLICY["receipts"]["ci_green_rule"]["substantive_steps"]
            ["vitest (node 20)"] == [STEP_AFTER_RENAME])


def test_resolving_the_declaration_twice_cannot_produce_two_answers():
    """IDEMPOTENCE, because the resolution happens in more than one place.

    `context_is_accounted_for` substitutes for routes 2 and 3 and hands route 1
    the `DeclarationAsOf` to resolve for itself -- route 1 must be able to name
    BOTH declarations, so it cannot be given a policy with the substitution
    already applied. Two resolutions of one question is the shape this package
    keeps getting wrong; it is safe here only because the second cannot
    disagree with the first, and that is a property to assert rather than
    believe.

    WHAT VALUE WOULD MAKE THIS FAIL: a resolver that merges rather than
    replaces, or one that reads its own output back (the second pass would then
    see the substituted rule as HEAD's and stop reporting the provenance --
    which is the defect this change actually shipped once).
    """
    as_of = gates.DeclarationAsOf(sha=SHA_BEFORE_RENAME, rule=_rule_before_the_rename())
    once, prov1, sha1 = gates._declaration_as_of(POLICY, as_of)
    twice, prov2, sha2 = gates._declaration_as_of(once, as_of)
    assert (once["receipts"]["ci_green_rule"]
            == twice["receipts"]["ci_green_rule"])
    assert (prov1, sha1) == (prov2, sha2) == (gates.DECL_AS_OF, SHA_BEFORE_RENAME)


def test_the_lag_window_between_the_workflow_rename_and_the_policy_rename():
    """The THIRD real case, and the one the first draft of this fix got wrong.

    A rename is not atomic. `8d3dd9cbb` renamed the step in
    `fiab-console-ci.yml` at 2026-09-21 21:25; `356290aa9` renamed it in
    `policy.json` at 2026-09-22 00:38. For 3h13m the job ran the NEW name while
    the declaration at every sha in between named the OLD one, and THREE merges
    landed there: #4652, #4654, #4658.

    Resolving strictly as-of refuses all three -- the declaration names a step
    the job does not carry -- which is #4676 in mirror image, with the same
    wrong remedy ("re-read the declaration") attached. So the other clock is
    consulted, and WHICH one decided is printed.

    WHAT VALUE WOULD MAKE THIS FAIL: deleting the fallback, or widening it from
    `missing` to any refusal (the next test pins that half). The value that
    makes the FIRST assertion fail is the one that matters: a job carrying only
    `Merge shard reports and enforce the coverage floor`, measured at a sha
    whose declaration names `Run vitest (with istanbul coverage floor)`.
    """
    lag_rule = _rule_before_the_rename()
    # The job at a lag-window sha: the WORKFLOW has already been renamed.
    job = _job("vitest (node 20)",
               steps=("Detect console changes", STEP_AFTER_RENAME))

    ok, why = gates.context_did_its_work(
        "vitest (node 20)", job, POLICY,
        declared_at=gates.DeclarationAsOf(sha="f78f2e43de8b", rule=lag_rule))
    assert ok, why
    assert STEP_AFTER_RENAME in why
    # It says which clock, and why it reached for it -- a pass that silently
    # used a declaration other than the sha's would be the same class of
    # undisclosed substitution this whole change exists to end.
    assert "the declaration AS OF the measured sha f78f2e43de8b named" in why
    assert STEP_BEFORE_RENAME in why
    assert "renamed in different commits" in why


def test_the_other_clock_is_reached_on_ABSENCE_only_never_on_a_SKIP():
    """A hollow check may not be laundered by a rename.

    `missing` -- the declared name is nowhere in the job -- is the rename
    signature. `hollow` -- the declared name is RIGHT THERE and was SKIPPED --
    is the check concluding green without doing its work, which is the defect
    `context_did_its_work` exists for. If the fallback fired on any refusal,
    a job that skipped the step the sha's declaration names would be re-judged
    against HEAD's declaration, and where HEAD names a step that DID run the
    hollow job would pass.

    WHAT VALUE WOULD MAKE THIS FAIL: `if kind != "missing"` widened to `if not
    ok`, or the `kind` check dropped. The fixture below is built to make that
    difference visible: the as-of step is present and SKIPPED, and HEAD's step
    is present and RAN, so the two clocks give OPPOSITE answers and only the
    `missing` restriction keeps the refusal.
    """
    as_of_rule = _rule_before_the_rename()
    job = _job(
        "vitest (node 20)",
        steps=("Detect console changes", STEP_BEFORE_RENAME, STEP_AFTER_RENAME),
        skipped=(STEP_BEFORE_RENAME,),
    )
    # The fixture's arithmetic, asserted: the as-of step is HOLLOW and HEAD's
    # step RAN. Without both, this test cannot tell the two rules apart.
    by_name = {s["name"]: s["conclusion"] for s in job["steps"]}
    assert by_name[STEP_BEFORE_RENAME] == "skipped"
    assert by_name[STEP_AFTER_RENAME] == "success"
    head_ok, _ = gates.context_did_its_work("vitest (node 20)", job, POLICY)
    assert head_ok, "HEAD's declaration must ACCEPT this job, or the fallback " \
                    "could not have laundered it and this test proves nothing"

    ok, why = gates.context_did_its_work(
        "vitest (node 20)", job, POLICY,
        declared_at=gates.DeclarationAsOf(sha="6bf53f52d085", rule=as_of_rule))
    assert not ok, why
    assert "were SKIPPED" in why
    assert STEP_BEFORE_RENAME in why


def _git(*args):
    try:
        run = subprocess.run(
            gates.git_argv(["git", *args]),
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=os.path.join(os.path.dirname(__file__), "..", "..", ".."),
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as exc:  # pragma: no cover
        pytest.skip(f"git unavailable: {exc}")
    return run


def test_the_rename_fixture_matches_what_policy_json_actually_carried():
    """Keeps the transcription above honest where the objects are present.

    SKIPS on a shallow checkout rather than failing, and that limit is stated
    rather than implied: `actions/checkout` fetches depth 1 by default, so in
    CI this test proves nothing and the transcribed constants are on trust
    there. Locally, and on any full clone, a drift between the fixture and the
    real history fails here.

    WHAT VALUE WOULD MAKE THIS FAIL: changing either constant to a spelling
    `8d3dd9cbb` did not actually move -- for instance "fixing" the pre-rename
    name to match HEAD, which is the edit #4676 warns the stale-declaration
    message used to invite.
    """
    import json

    run = _git("show", f"{RENAME_COMMIT}^:tools/drain/policy.json")
    if run.returncode != 0:
        pytest.skip(
            f"{RENAME_COMMIT}^ is not in this object store "
            f"(shallow clone?): {run.stderr.strip()[:120]}"
        )
    historical = json.loads(run.stdout)
    declared = (historical["receipts"]["ci_green_rule"]["substantive_steps"]
                ["vitest (node 20)"])
    assert declared == [STEP_BEFORE_RENAME], (
        f"the pre-rename fixture says {STEP_BEFORE_RENAME!r} but policy.json at "
        f"{RENAME_COMMIT}^ declared {declared!r}"
    )
    assert (POLICY["receipts"]["ci_green_rule"]["substantive_steps"]
            ["vitest (node 20)"] == [STEP_AFTER_RENAME])


# ---------------------------------------------------------------------------
# The PRODUCER. `gates.py` runs no subprocess, so the git read lives in
# `merge_gate` -- and an untested producer is where the last five surviving
# arms lived ("168/168 KILLED" was true about the pure function and not about
# the program deciding its inputs).
# ---------------------------------------------------------------------------


def _merge_gate():
    import merge_gate

    return merge_gate


def _skip_without_history():
    run = _git("cat-file", "-e", f"{RENAME_COMMIT}^")
    if run.returncode != 0:
        pytest.skip(
            f"{RENAME_COMMIT}^ is not in this object store (shallow clone?)"
        )


def test_the_producer_reads_the_declaration_at_the_sha_not_off_disk():
    """`resolve_declaration_as_of` must read the SHA, not HEAD and not the tree.

    WHAT VALUE WOULD MAKE THIS FAIL: `git show HEAD:tools/drain/policy.json`,
    or `open(POLICY_PATH)`. Either returns today's declaration for every sha,
    which is #4676 with a git command in front of it. That is arm AS3.

    SKIPS on a shallow object store, and the consequence is stated rather than
    implied: where this skips, AS3 is unobserved. `mutate_gates.py` is run from
    a full clone, which is where that arm's verdict is taken.
    """
    _skip_without_history()
    merge_gate = _merge_gate()

    before = merge_gate.resolve_declaration_as_of(f"{POLICY_RENAME_COMMIT}^")
    assert before.error == ""
    assert before.rule is not None
    assert (before.rule["substantive_steps"]["vitest (node 20)"]
            == [STEP_BEFORE_RENAME])

    after = merge_gate.resolve_declaration_as_of(POLICY_RENAME_COMMIT)
    assert after.error == ""
    assert after.rule is not None
    assert (after.rule["substantive_steps"]["vitest (node 20)"]
            == [STEP_AFTER_RENAME])

    # The two shas are ONE COMMIT APART and disagree. A resolver keyed to
    # anything other than the sha cannot produce these two answers.
    assert (before.rule["substantive_steps"]["vitest (node 20)"]
            != after.rule["substantive_steps"]["vitest (node 20)"])


def test_the_producer_fails_to_a_NAMED_error_never_to_a_silent_head_fallback():
    """Every failure carries `rule=None` AND a reason git actually gave.

    `deploy-integrity.md` R7: an error may not state as fact something it did
    not establish. "the declaration could not be read" must quote what went
    wrong, because the consumer prints it and a reader acts on it.

    WHAT VALUE WOULD MAKE THIS FAIL: returning HEAD's rule on error (the
    consumer would then judge a historical job by today's declaration and say
    nothing about it -- #4676, silently), or an empty `error` string (the
    refusal downstream would then name no cause at all).
    """
    merge_gate = _merge_gate()

    nothing = merge_gate.resolve_declaration_as_of("")
    assert nothing.rule is None
    assert "no merged sha" in nothing.error

    absent = merge_gate.resolve_declaration_as_of("0" * 40)
    assert absent.rule is None
    assert absent.sha == "0" * 40
    # Names the command and git's own words, not a guess at the cause.
    assert "git show" in absent.error
    assert "tools/drain/policy.json" in absent.error
    assert absent.error.strip() != "git show"


def test_the_producer_refuses_a_policy_with_no_ci_green_rule():
    """The nesting is not eternal, and an older shape must fail CLOSED.

    `receipts.ci_green_rule` did not always exist. A sha from before it must
    refuse with THAT reason attached, rather than resolving to `{}` -- which
    reads downstream as "no substantive step is DECLARED" for every context, a
    refusal with the wrong cause on it.

    WHAT VALUE WOULD MAKE THIS FAIL: accepting a non-dict `ci_green_rule`.
    Driven through a real git blob rather than a mock: `required_contexts.json`
    sits beside `policy.json`, is valid JSON, and is not a policy.
    """
    merge_gate = _merge_gate()

    stand_in = "tools/drain/required_contexts.json"
    run = _git("show", f"HEAD:{stand_in}")
    if run.returncode != 0:
        pytest.skip(f"{stand_in} is not at HEAD in this checkout")
    import json

    # The stand-in must PARSE and must NOT carry the key, or this test would
    # pass for the wrong reason (an unparseable blob takes a different branch).
    parsed = json.loads(run.stdout)
    assert not (isinstance(parsed, dict)
                and isinstance(parsed.get("receipts"), dict)
                and "ci_green_rule" in parsed["receipts"])

    original = merge_gate.POLICY_TRACKED_PATH
    try:
        merge_gate.POLICY_TRACKED_PATH = stand_in
        result = merge_gate.resolve_declaration_as_of("HEAD")
    finally:
        merge_gate.POLICY_TRACKED_PATH = original
    assert result.rule is None
    assert "no receipts.ci_green_rule object" in result.error
    assert merge_gate.POLICY_TRACKED_PATH == "tools/drain/policy.json"
