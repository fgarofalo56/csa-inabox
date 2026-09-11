"""Unit tests for the drain gates, each with a NEGATIVE CONTROL.

A gate that has never been observed failing is not known to watch anything.
#4451 is the standing example: the roll's UAT gate printed "UAT-verified roll"
over `pass=4 fail=4`, measured four separate times, with no observed input for
which it returned anything else.

So every test here comes in pairs: one input the gate must accept, and one it
must REFUSE. A file of only-passing assertions would reproduce the bug it exists
to prevent.

A SECOND lesson, from this module's own first independent review. Every
closing-scan fixture was a SINGLE LINE and every `parse_verdicts` fixture was a
ONE-ELEMENT list, so two mutations that narrow the POPULATION -- scan only the
first line, parse only the newest comment -- survived the whole suite while the
mutation matrix still reported 6/6 KILLED. A mutation that narrows what the gate
LOOKS AT is invisible to a fixture that only ever contains one thing to look at.
Fixtures here are deliberately multi-line and multi-element for that reason.

Run:  python -m pytest tools/drain/__tests__/ -q
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import gates

# ---------------------------------------------------------------------------
# Closing-keyword scan
# ---------------------------------------------------------------------------


def test_clean_text_is_safe():
    scan = gates.scan_closing_keywords("Refs #4361. See #4362 for the remaining work.")
    assert scan.safe
    assert scan.hard == []


def test_negative_control_plural_keyword_is_caught():
    """The spelling everyone types."""
    scan = gates.scan_closing_keywords("Closes #1470")
    assert not scan.safe
    assert scan.hard == [1470]


def test_negative_control_singular_keyword_is_caught():
    """`close #3933` -- SINGULAR. A `closes #|fixes #|resolves #` grep returns
    zero on this, and #3933 auto-closed on a merge cleared by that grep."""
    scan = gates.scan_closing_keywords("close #3933")
    assert not scan.safe
    assert scan.hard == [3933]


def test_negative_control_past_tense_with_colon_is_caught():
    """`fixed: #4361` -- the exact string that closed #4361 on 2026-09-11 while
    `closingIssuesReferences` read EMPTY."""
    scan = gates.scan_closing_keywords("fixed: #4361")
    assert not scan.safe
    assert scan.hard == [4361]


def test_negative_control_negation_is_still_caught():
    """The parser has NO notion of negation. A sentence whose whole purpose is
    to keep an issue open closes it."""
    scan = gates.scan_closing_keywords("Does not close #3549 - it remains open.")
    assert not scan.safe
    assert scan.hard == [3549]


def test_negative_control_backticks_do_not_protect():
    """True of a PR body's markdown; NOT true of a commit message, which is
    plain text. The gate must not be fooled either way."""
    scan = gates.scan_closing_keywords("the trailer still carries `Closes #4059`")
    assert not scan.safe


def test_negative_control_cross_repo_reference_is_caught():
    """`owner/repo#N` closes N in that repo. The reference half of the pattern
    was a spelling list (a bare `#`) while the verb half was shape-keyed, so
    this returned SAFE."""
    scan = gates.scan_closing_keywords("Closes fgarofalo56/csa-inabox#4361")
    assert not scan.safe
    assert scan.hard == [4361]


def test_negative_control_gh_prefixed_reference_is_caught():
    """`GH-N` is a documented GitHub reference form."""
    scan = gates.scan_closing_keywords("closes GH-4361")
    assert not scan.safe
    assert scan.hard == [4361]


def test_negative_control_issue_url_is_caught():
    """The likeliest form in practice: paste the link after the verb. This is
    what a body normally looks like, and it read SAFE."""
    scan = gates.scan_closing_keywords(
        "Fixes: https://github.com/fgarofalo56/csa-inabox/issues/4361"
    )
    assert not scan.safe
    assert scan.hard == [4361]


def test_negative_control_reference_below_the_first_line_is_caught():
    """POPULATION CONTRACT over the TEXT. A scan narrowed to `text.splitlines()[0]`
    passes every single-line fixture -- and the reference that closed an issue on
    2026-09-11 lived in a squash commit's BODY, four lines down from its subject."""
    body = "\n".join(
        [
            "chore: re-grade the parity rows",
            "",
            "Long explanation that mentions nothing actionable.",
            "",
            "fixed: #4361",
        ]
    )
    scan = gates.scan_closing_keywords(body)
    assert not scan.safe
    assert scan.hard == [4361]


def test_negative_control_fenced_code_is_not_exempt():
    """GitHub's closing parser does not read Markdown. Exempting fenced blocks
    is a filter placed INSIDE the predicate -- it looks like a fix for false
    positives and is a hole."""
    body = "Example of the hazard:\n\n```\nCloses #4361\n```\n"
    scan = gates.scan_closing_keywords(body)
    assert not scan.safe
    assert scan.hard == [4361]


def test_near_miss_is_reported_but_not_fatal():
    """`fixed in #4396` -- a word intervenes, so GitHub does not act, but it is
    one edit from doing so. Reported, not refused."""
    scan = gates.scan_closing_keywords("recorded here rather than fixed in #4396")
    assert scan.safe
    assert scan.near == [4396]


def test_near_miss_window_reaches_past_a_repo_slug():
    """The window was 12 chars -- shorter than this repo's own slug, so a
    non-adjacent cross-repo or URL reference did not even surface as a
    near-miss and the gate returned a clean bill of health."""
    scan = gates.scan_closing_keywords(
        "recorded rather than fixed, see https://github.com/fgarofalo56/csa-inabox/issues/4396"
    )
    assert scan.safe
    assert scan.near == [4396]


def test_commit_trail_is_scanned_not_only_the_body():
    """The #4361 incident in one assertion: clean body, poisoned commit."""
    scan = gates.merge_is_close_safe(
        body="Refs #4361 - stays open pending its receipt.",
        commit_messages=["docs: re-grade the parity rows", "chore: fixed: #4361"],
    )
    assert not scan.safe
    assert 4361 in scan.hard


def test_negative_control_the_first_commit_is_scanned_too():
    """A squash concatenates the WHOLE trail. Scanning only the tip -- the
    population narrowed rather than the check weakened -- survives the fixture
    above, because there the poisoned commit happens to be last."""
    scan = gates.merge_is_close_safe(
        body="Refs #4361.",
        commit_messages=[
            "feat: resolves #2101",
            "test: add the negative control",
            "docs: explain the trap",
        ],
    )
    assert not scan.safe
    assert 2101 in scan.hard


# ---------------------------------------------------------------------------
# Verdict parsing
# ---------------------------------------------------------------------------

HEAD = "2026-09-11T10:00:00Z"


def _c(cid, body, when):
    return {"id": cid, "body": body, "created_at": when}


def test_well_formed_approve_registers():
    live, near = gates.parse_verdicts(
        [_c(1, "## Independent review - APPROVE\n\nHead `abc`.", "2026-09-11T11:00:00Z")],
        HEAD,
    )
    assert [v.token for v in live] == ["APPROVE"]
    assert near == []


def test_negative_control_every_comment_is_parsed_not_only_the_newest():
    """POPULATION CONTRACT over the COMMENTS, and the other half of "conjunction,
    not recency".

    That rule was tested only at `reduce_verdicts`, and every `parse_verdicts`
    fixture was a ONE-ELEMENT list -- so narrowing the comment population to
    `[-1:]` reinstated recency semantics upstream of the reducer and survived
    the entire suite with the mutation matrix still green.
    """
    live, near = gates.parse_verdicts(
        [
            _c(1, "## Independent review - REQUEST-CHANGES\n\nblocking.", "2026-09-11T11:00:00Z"),
            _c(2, "## Independent re-review - APPROVE\n\nlooks good now.", "2026-09-11T12:00:00Z"),
        ],
        HEAD,
    )
    assert sorted(v.token for v in live) == ["APPROVE", "REQUEST-CHANGES"]
    ok, why = gates.reduce_verdicts(live, near)
    assert not ok
    assert "REQUEST-CHANGES" in why


def test_negative_control_missing_marker_is_reported_not_silent():
    """A sound APPROVE headed "Re-review" was discarded for exactly this, and
    the gate said only "no live APPROVE" -- three runs to diagnose."""
    live, near = gates.parse_verdicts(
        [_c(2, "## Re-review - APPROVE\n\nHead `abc`.", "2026-09-11T11:00:00Z")], HEAD
    )
    assert live == []
    assert len(near) == 1
    assert "no marker" in near[0].reason


def test_negative_control_wrong_token_spelling_is_reported():
    """"CHANGES REQUIRED" is not the token. Two blocking verdicts were invisible
    to the gate for two full rounds because of this."""
    live, near = gates.parse_verdicts(
        [_c(3, "## Independent review - CHANGES REQUIRED\n\n...", "2026-09-11T11:00:00Z")],
        HEAD,
    )
    assert live == []
    assert "no token" in near[0].reason


def test_negative_control_an_unparseable_review_at_head_blocks():
    """Reporting a near-miss to a caller that does not consult it is the same
    silence with extra steps. `reduce_verdicts` took only `live`, so the exact
    incident this machinery documents still returned GO."""
    live, near = gates.parse_verdicts(
        [
            _c(3, "## Independent review - CHANGES REQUIRED\n\n...", "2026-09-11T11:00:00Z"),
            _c(4, "## Independent re-review - APPROVE\n\n...", "2026-09-11T12:00:00Z"),
        ],
        HEAD,
    )
    assert [v.token for v in live] == ["APPROVE"]
    ok, why = gates.reduce_verdicts(live, near)
    assert not ok
    assert "unparseable review at head" in why


def test_negative_control_verdict_predating_head_is_void():
    live, near = gates.parse_verdicts(
        [_c(4, "## Independent review - APPROVE", "2026-09-11T09:00:00Z")], HEAD
    )
    assert live == []
    assert "predates head" in near[0].reason


def test_a_void_verdict_does_not_block_the_next_head():
    """The companion to the test above. A verdict voided BY A PUSH is not a
    block -- it is a measurement of a diff that no longer exists. If it blocked,
    no PR could ever recover from a single stale review."""
    live, near = gates.parse_verdicts(
        [
            _c(4, "## Independent review - APPROVE", "2026-09-11T09:00:00Z"),
            _c(5, "## Independent re-review - APPROVE", "2026-09-11T11:00:00Z"),
        ],
        HEAD,
    )
    assert [v.token for v in live] == ["APPROVE"]
    ok, why = gates.reduce_verdicts(live, near)
    assert ok, why


def test_token_outside_the_window_does_not_register():
    """Only the HEADER carries the verdict. Scanning the whole body would read
    an engaging "the previous REQUEST-CHANGES is addressed" as a fresh block."""
    body = "## Independent review\n\n" + ("x" * 400) + "\nAPPROVE"
    live, near = gates.parse_verdicts([_c(5, body, "2026-09-11T11:00:00Z")], HEAD)
    assert live == []
    assert near
    assert "no token" in near[0].reason


def test_negative_control_an_unresolvable_head_date_cannot_pin_anything():
    """An unpinned verdict is a measurement of some other diff. A caller that
    could not resolve the head date must get NO-GO, not a silently unpinned
    APPROVE."""
    live, near = gates.parse_verdicts(
        [_c(6, "## Independent review - APPROVE", "2026-09-11T11:00:00Z")], ""
    )
    assert live == []
    assert near[0].kind == gates.NEAR_UNPINNABLE
    ok, _ = gates.reduce_verdicts(live, near)
    assert not ok


def test_negative_control_the_template_line_is_not_a_decision():
    """The review template lists every token on one line. Read in token order it
    registers as REQUEST-CHANGES, so a reviewer who leaves the header in blocks
    their own PR -- and a reviewer who leaves it in an APPROVE gets a verdict
    they did not write."""
    live, near = gates.parse_verdicts(
        [
            _c(
                7,
                "## Independent review\n\nVERDICT: APPROVE | REQUEST-CHANGES | CANNOT-ASSESS\n",
                "2026-09-11T11:00:00Z",
            )
        ],
        HEAD,
    )
    assert live == []
    assert near[0].kind == gates.NEAR_TEMPLATE


# ---------------------------------------------------------------------------
# Conjunction, not recency
# ---------------------------------------------------------------------------


def test_approve_alone_is_go():
    ok, why = gates.reduce_verdicts([gates.Verdict("APPROVE", "t2", 2)])
    assert ok, why


def test_negative_control_later_approve_does_not_discharge_earlier_block():
    """Reduce by CONJUNCTION. This is the whole rule."""
    ok, why = gates.reduce_verdicts(
        [gates.Verdict("REQUEST-CHANGES", "t1", 1), gates.Verdict("APPROVE", "t2", 2)]
    )
    assert not ok
    assert "REQUEST-CHANGES" in why


def test_negative_control_cannot_assess_blocks():
    """CANNOT-ASSESS is not a weak approval. It means the reviewer could not
    reach the thing, and merging on it is merging unreviewed. This branch had no
    test at all -- by this module's own standard it was not known to watch
    anything."""
    ok, why = gates.reduce_verdicts([gates.Verdict("CANNOT-ASSESS", "t1", 1)])
    assert not ok
    assert "CANNOT-ASSESS" in why


def test_negative_control_cannot_assess_blocks_even_after_an_approve():
    ok, why = gates.reduce_verdicts(
        [gates.Verdict("CANNOT-ASSESS", "t1", 1), gates.Verdict("APPROVE", "t2", 2)]
    )
    assert not ok
    assert "CANNOT-ASSESS" in why


def test_negative_control_no_verdict_is_not_go():
    ok, why = gates.reduce_verdicts([])
    assert not ok
    assert "no live APPROVE" in why


# ---------------------------------------------------------------------------
# MISSING: never-created vs parked -- same symptom, opposite remedy
# ---------------------------------------------------------------------------


def test_parked_run_is_distinguishable():
    assert gates.classify_missing(total_count=3, waiting=True) == "parked"


def test_negative_control_conflicting_window_push_has_no_runs():
    """total_count == 0 means no run will EVER exist for that sha. Approving it
    is a no-op and `--admin`-ing past it ships code CI never saw."""
    assert gates.classify_missing(total_count=0, waiting=False) == "never-created"


def test_present_is_neither():
    assert gates.classify_missing(total_count=12, waiting=False) == "present"


# ---------------------------------------------------------------------------
# Gate 4 -- required contexts present, none RED, none INCOMPLETE
# ---------------------------------------------------------------------------

REQUIRED = ["Python Lint", "vitest (node 20)", "guardrails"]


def _run(name, conclusion, status="COMPLETED"):
    return {"name": name, "conclusion": conclusion, "status": status}


def test_all_required_green_is_go():
    ok, reasons = gates.classify_checks(
        [_run(n, "SUCCESS") for n in REQUIRED] + [_run("Bicep Lint", "SKIPPED")], REQUIRED
    )
    assert ok, reasons


def test_negative_control_a_red_required_context_blocks():
    checks = [_run(n, "SUCCESS") for n in REQUIRED]
    checks[1] = _run("vitest (node 20)", "FAILURE")
    ok, reasons = gates.classify_checks(checks, REQUIRED)
    assert not ok
    assert any("RED" in r for r in reasons)


def test_negative_control_an_incomplete_required_context_blocks():
    """A check that has not concluded is INCOMPLETE, never a pass. Merging here
    ships code whose required gate was still running."""
    checks = [_run(n, "SUCCESS") for n in REQUIRED]
    checks[0] = {"name": "Python Lint", "conclusion": None, "status": "IN_PROGRESS"}
    ok, reasons = gates.classify_checks(checks, REQUIRED)
    assert not ok
    assert any("INCOMPLETE" in r for r in reasons)


def test_negative_control_a_missing_required_context_blocks():
    ok, reasons = gates.classify_checks([_run("Python Lint", "SUCCESS")], REQUIRED)
    assert not ok
    assert sum("MISSING" in r for r in reasons) == 2


def test_negative_control_a_cancelled_run_is_red_not_absent():
    """A CANCELLED job measured nothing, and reading it as merely absent is how
    a rapid-merge cancellation gets mistaken for a check that never ran."""
    checks = [_run(n, "SUCCESS") for n in REQUIRED]
    checks[2] = _run("guardrails", "CANCELLED")
    ok, reasons = gates.classify_checks(checks, REQUIRED)
    assert not ok
    assert any("CANCELLED" in r for r in reasons)


def test_negative_control_the_statuscontext_shape_is_read_too():
    """statusCheckRollup returns TWO shapes -- CheckRun (name/conclusion) and
    StatusContext (context/state). A reader that knows only one is blind to
    every context published by the other."""
    checks = [
        {"context": n, "state": "SUCCESS"} for n in REQUIRED
    ]
    ok, reasons = gates.classify_checks(checks, REQUIRED)
    assert ok, reasons
    checks[0] = {"context": "Python Lint", "state": "FAILURE"}
    ok, reasons = gates.classify_checks(checks, REQUIRED)
    assert not ok


def test_negative_control_a_duplicated_context_is_judged_by_its_worst_run():
    """Two runs can publish the same required context. Taking the first (or the
    last) lets a red one hide behind a green twin."""
    checks = [_run(n, "SUCCESS") for n in REQUIRED] + [_run("guardrails", "FAILURE")]
    ok, reasons = gates.classify_checks(checks, REQUIRED)
    assert not ok
    assert any("guardrails" in r and "RED" in r for r in reasons)


# ---------------------------------------------------------------------------
# Gate 5 -- hollow check
# ---------------------------------------------------------------------------


def test_a_check_that_measured_something_is_not_hollow():
    hollow, note = gates.check_is_hollow("Python Lint", "SUCCESS", 773)
    assert not hollow
    assert "773" in note


def test_negative_control_green_over_zero_items_is_hollow():
    """#4451: `pass=0 fail=4` printed "UAT-verified roll". A pass with no
    population is the absence of evidence wearing evidence's colour."""
    hollow, note = gates.check_is_hollow("UAT", "SUCCESS", 0)
    assert hollow
    assert "ZERO" in note


def test_negative_control_skipped_is_hollow():
    hollow, _ = gates.check_is_hollow("Bicep Lint", "SKIPPED", None)
    assert hollow


def test_negative_control_an_unreported_population_is_not_a_pass():
    """"I do not know" must not round to "yes"."""
    hollow, note = gates.check_is_hollow("guardrails", "SUCCESS", None)
    assert hollow
    assert "cannot assert" in note


# ---------------------------------------------------------------------------
# Gate 1 -- base == origin/main
# ---------------------------------------------------------------------------


def test_current_base_is_go():
    ok, why = gates.base_is_current("main", "a" * 40, "a" * 40)
    assert ok, why


def test_negative_control_a_stale_base_blocks():
    """Every green check on a stale base is a statement about a tree that no
    longer exists."""
    ok, why = gates.base_is_current("main", "a" * 40, "b" * 40)
    assert not ok
    assert "!=" in why


def test_negative_control_a_non_main_base_blocks():
    ok, why = gates.base_is_current("release/0.106", "a" * 40, "a" * 40)
    assert not ok
    assert "not 'main'" in why


def test_negative_control_an_unresolvable_sha_is_not_a_pass():
    ok, why = gates.base_is_current("main", "", "")
    assert not ok
    assert "unmeasurable" in why


# ---------------------------------------------------------------------------
# Gate 7 -- the before/after open-issue audit
# ---------------------------------------------------------------------------


def test_an_exact_delta_passes_the_audit():
    ok, why = gates.issue_count_audit(297, 296, [4468])
    assert ok, why


def test_negative_control_a_silent_extra_close_is_caught():
    """The detection half. #4361 closed while `closingIssuesReferences` read
    EMPTY -- the count is what caught it, not the API."""
    ok, why = gates.issue_count_audit(297, 295, [4468])
    assert not ok
    assert "EXCEEDS" in why


def test_negative_control_an_issue_that_did_not_close_is_also_a_finding():
    """The backlog lying in the other direction is still the backlog lying."""
    ok, why = gates.issue_count_audit(297, 297, [4468])
    assert not ok
    assert "SHORT" in why


# ---------------------------------------------------------------------------
# Autonomy contract -- must FAIL CLOSED
# ---------------------------------------------------------------------------

POLICY = gates.load_policy(
    os.path.join(os.path.dirname(__file__), "..", "policy.json")
)


def test_permitted_action_is_allowed():
    ok, _ = gates.action_is_permitted("merge-on-gate-go", POLICY)
    assert ok


def test_negative_control_stop_and_ask_is_refused():
    ok, why = gates.action_is_permitted("move_live_acr_tags", POLICY)
    assert not ok
    assert "STOP AND ASK" in why


def test_negative_control_never_is_refused():
    ok, why = gates.action_is_permitted("commit-a-secret", POLICY)
    assert not ok
    assert "NEVER" in why


def test_negative_control_unknown_action_fails_closed():
    """An action in neither list is REFUSED. Adding a capability must be a
    deliberate edit to policy.json, never an emergent behaviour."""
    ok, why = gates.action_is_permitted("rewrite-git-history", POLICY)
    assert not ok
    assert "fails closed" in why


def test_negative_control_a_prefix_of_a_permitted_action_is_not_permitted():
    """Matching is EXACT. A fast path keyed on a shared prefix -- `startswith`
    anywhere in this function -- turns one permission into a family, and every
    fixture naming an exact known action stays green while it does."""
    for action in ("merge-without-review", "merge-on-gate-go-and-skip-uat", "merge"):
        ok, why = gates.action_is_permitted(action, POLICY)
        assert not ok, f"{action} must be refused: {why}"


def test_the_documentation_key_is_not_an_action():
    """policy.json's `stop_and_ask` carries a `_` key holding rationale prose.
    Emitted into a brief it prints `Stop and ask for: _, add_trivyignore_entry`,
    which reads as a parsing bug and teaches the reader to skim the line."""
    actions = gates.stop_and_ask_actions(POLICY)
    assert "_" not in actions
    assert "move_live_acr_tags" in actions


def test_the_policy_declares_the_repo_it_governs():
    """`gh` with no --repo resolves from the working directory, so the repo is a
    policy input or it is an accident."""
    assert POLICY["repo"] == "fgarofalo56/csa-inabox"


def test_receipt_must_match_the_issue_class():
    assert gates.receipt_satisfies("ui-surface", "g1-browser", POLICY)


def test_negative_control_wrong_receipt_does_not_close():
    """`ci-green` does not close a UI surface. Per ux-baseline G1, tsc + vitest
    are not completion evidence -- only the browser catches a dead data path
    AND a frozen renderer."""
    assert not gates.receipt_satisfies("ui-surface", "ci-green", POLICY)


def test_negative_control_ci_green_does_not_close_a_deploy_path_item():
    """R1's stream. `ci-green` on a deploy-path issue is `report-a-merge-as-a-fix`
    with extra steps."""
    assert not gates.receipt_satisfies("deploy-path", "ci-green", POLICY)
    assert gates.receipt_satisfies("deploy-path", "deploy-run", POLICY)


def test_every_receipt_class_is_reachable():
    """All five classes exist in policy.json, and `ledger.Item` must be able to
    land in each. Two of the five were unreachable: the brief keyed the receipt
    off `lane == 'lane:console'`, so `deploy-run`, `estate` and `operator` were
    never selected for any item."""
    classes = {k: v for k, v in POLICY["receipts"].items() if not k.startswith("_")
               and not k.endswith("_rule")}
    assert set(classes) == {
        "guard-or-test-only", "deploy-path", "estate-behaviour", "ui-surface", "human-only"
    }
