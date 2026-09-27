"""The inventory's totality refusal -- PRP §8's acceptance box, with a control.

"`build_inventory.py` regenerates INVENTORY.md and **refuses on a partition that
loses an issue**" is an acceptance criterion of this program. It was asserted in
the PRP, implemented inline in `main()`, and tested nowhere — so two mutation
arms that switched it off survived the whole suite. An acceptance criterion with
no negative control is an assertion about untested code.

A partition that silently drops an issue is worse than no partition: the item
leaves the plan without leaving the backlog, which is the same failure the ledger
refuses when it will not let you park without an owner.

Run:  python -m pytest tools/drain/__tests__/ -q
"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import build_inventory


def _issues(*numbers):
    return [{"number": n, "title": f"issue {n}", "labels": []} for n in numbers]


def _rows(**buckets):
    return {key: [{"n": n} for n in numbers] for key, numbers in buckets.items()}


def test_a_total_partition_is_accepted():
    build_inventory.assert_partition_is_total(
        _issues(1, 2, 3), _rows(W1=[1, 2], W9=[3])
    )


def test_negative_control_a_lost_issue_refuses():
    with pytest.raises(SystemExit, match="LOST"):
        build_inventory.assert_partition_is_total(_issues(1, 2, 3), _rows(W1=[1, 2]))


def test_negative_control_a_swap_refuses():
    """Counting alone passes a SWAP: one issue lost and one counted twice sum to
    the right total. The set comparison is what catches it."""
    lost_and_duped = _rows(W1=[1, 2], W9=[2])
    assert sum(len(v) for v in lost_and_duped.values()) == 3  # the count agrees
    with pytest.raises(SystemExit, match="LOST"):
        build_inventory.assert_partition_is_total(_issues(1, 2, 3), lost_and_duped)


def test_negative_control_a_duplicated_issue_refuses():
    """An issue in two streams is scheduled twice, on two lanes, against the
    same files -- the shared-file conflict lanes exist to prevent."""
    with pytest.raises(SystemExit, match="DUPLICATED"):
        build_inventory.assert_partition_is_total(
            _issues(1, 2, 3), _rows(W1=[1, 2], W9=[2, 3])
        )


def test_negative_control_an_empty_issue_list_refuses():
    """An empty partition is total over nothing -- the one case the totality
    check cannot catch, so the reader refuses it instead."""
    with pytest.raises(SystemExit, match="ZERO issues"):
        build_inventory.read_issues_from(list)


# ---------------------------------------------------------------------------
# Stream assignment -- order IS precedence
# ---------------------------------------------------------------------------


def test_every_stream_a_real_issue_can_reach_has_a_receipt_class():
    """An item whose class is absent from `policy.json` can NEVER close, and it
    would stick in the queue with no error. This is the join between the two
    modules, and neither one's tests cover it alone."""
    import ledger

    import gates

    policy = gates.load_policy(os.path.join(os.path.dirname(__file__), "..", "policy.json"))
    for stream in build_inventory.ORDER:
        item = ledger.Item(number=1, title="x", stream=stream)
        assert policy["receipts"].get(item.effective_receipt_class), (
            f"{stream} -> {item.effective_receipt_class} is not a receipt class"
        )


def test_the_deploy_stream_wins_over_a_lane():
    """R1 makes the deploy path the thing that preempts, so a bicep-drift issue
    that also carries a lane belongs to W1, not to the lane's stream."""
    assert build_inventory.stream_for(9999, "x", {"bicep-drift", "lane:bicep"}) == "W1-deploy"
    assert build_inventory.stream_for(9999, "x", {"lane:bicep"}) == "W7-bicep"


def test_negative_control_the_harness_own_issues_are_pinned_not_title_matched():
    """#4487's title is *about* receipts -- "the ci-green RECEIPT names a
    measurement the CI topology cannot produce" -- so the W4 fall-through
    (`"receipt" in title.lower()`) claimed it, giving it the `estate-behaviour`
    class. The ledger would then have demanded a LIVE ESTATE receipt for a
    path-filter fix in a workflow file and refused every other kind, and the
    cold-start KICKOFF names #4487 as the FIRST TASK. A title-substring
    heuristic classifies an issue by what it MENTIONS, not by what it IS.

    THE PARAGRAPH ABOVE DESCRIBES THE STATE BEFORE #4694's PRECEDENCE FIX. With
    the title arm demoted below the lane loop, an unpinned #4487 with `lane:ci`
    reaches W6-ci, not W4 -- which is why this test's assertions are worded as
    "W0-harness", the pin's verdict, rather than as "not W4". WHAT MAKES EACH
    FAIL: dropping that number from `HARNESS` (measured: it reds this test and
    no other for #4485/#4487).
    """
    import ledger

    for number, title in (
        (4487, ("drain harness: the ci-green receipt names a measurement the CI "
                "topology cannot produce")),
        (4485, "drain harness: five residual review findings, owed rather than forgotten"),
        (4468, "ci: the merge gate that decides GO/NO-GO is gitignored"),
    ):
        stream = build_inventory.stream_for(number, title, {"lane:ci"})
        assert stream == "W0-harness", f"#{number} -> {stream}"
        item = ledger.Item(number=number, title=title, stream=stream, lane="lane:ci")
        assert item.effective_receipt_class == "guard-or-test-only"


def test_an_unlabelled_issue_lands_in_the_triage_stream():
    assert build_inventory.stream_for(9999, "x", set()) == "W9-rest"


# ---------------------------------------------------------------------------
# #4694 -- the two W4 arms carry different evidence, so they get different
# precedence. The pinned-by-number arm outranks a label; the title SUBSTRING
# does not.
#
# WHEREVER A FIXTURE NAMES A REAL ISSUE NUMBER, ITS TITLE IS THE LIVE ONE,
# BYTE FOR BYTE (modulo the string concatenation used to keep lines under the
# line-length limit, which changes no character). Round 1 claimed the titles
# were "truncated only where length adds nothing" and they were in fact
# REWORDED in 6 of 8 places -- which broke the only reason for using live
# titles at all. Re-transcribing them by hand would repeat that, so they were
# generated from `gh issue view` with `ascii()` and pasted; the em dashes are
# U+2014, as they are on GitHub and as this file's own module docstring
# already uses. Verified against `gh issue view` on 2026-09-24; a title can be
# edited on GitHub afterwards and nothing here would notice, so the provenance
# is a statement about that moment and not a live guarantee.
#
# WHAT ACTUALLY PROTECTS THESE TESTS IS NOT THE PROVENANCE. It is
# `_reaches_the_title_arm`, which asks the implementation whether the fixture
# still triggers the rule under test. A narrowed rule reds the guard whether
# or not the title is verbatim -- which is the failure mode the verbatim
# titles were reached for in the first place.
#
# Fixtures that use an INVENTED number (999_99x) or an obviously synthetic
# title ("no keyword here") are probes, not claims about an issue, and are
# labelled as such at their site.
# ---------------------------------------------------------------------------


def _reaches_the_title_arm(title: str) -> bool:
    """Ask the IMPLEMENTATION whether this title triggers the W4 substring arm.

    `assertion-design.md` "done" #3 says lift the pattern out of the source
    rather than transcribing it. Round 1 transcribed it -- every guard read
    `assert "receipt" in title.lower()`, which agrees with itself by
    construction. Narrow the arm in `build_inventory` to a whole-word singular
    match and the transcription keeps saying True for "drain receipts:" while
    the implementation says False. #4533's live title is exactly that case: it
    contains the PLURAL only.

    The probe is a number in NO pinned set with NO labels, so the title arm is
    the only arm that can return "W4-receipts".
    """
    probe = 999_998
    for pinned in (
        build_inventory.HARNESS,
        build_inventory.RECEIPTS,
        build_inventory.DEPLOY,
        build_inventory.SECURITY,
    ):
        assert probe not in pinned, "the probe is pinned; it cannot isolate the arm"
    return build_inventory.stream_for(probe, title, set()) == "W4-receipts"


def test_the_title_arm_probe_is_not_a_tautology():
    """The helper above is a measuring instrument, so it gets a control at both
    ends. WHAT MAKES THIS FAIL: a helper that always returns True (then the
    second assertion goes red) or always False (then the first does).
    """
    assert _reaches_the_title_arm("G1 receipt owed: something") is True
    assert _reaches_the_title_arm("in-browser walk owed") is False


def test_an_explicit_lane_label_outranks_a_title_substring():
    """WHAT MAKES THIS FAIL: putting `"receipt" in title.lower()` back ahead of
    the lane loop. Then every assertion below returns "W4-receipts".

    A `lane:*` label is a human decision about the issue. `"receipt" in title`
    is a substring, and it classifies an issue by what it MENTIONS rather than
    by what it IS. Measured at 76377a86e against the live ledger, the substring
    was winning: #3965 carries `lane:bicep` and reached `estate-behaviour` via
    W4 instead of `deploy-path` via W7-bicep, purely on the word in its title.

    Titles and labels are the LIVE ones. The reachability guard asks the
    implementation rather than restating the rule, so a future narrowing of the
    substring cannot leave this test agreeing with itself while disagreeing
    with the ledger.
    """
    cases = [
        (
            4408,
            ("G1 receipt owed: in-browser E2E click-walk of the four highest-risk "
             "picker surfaces #4344 rewrote (Commercial, then Gov)"),
            "lane:console",
            "W5-console",
        ),
        (
            4242,
            ("brain Perform: BUILT and DEPLOYED (backend + UI + guards live) "
             "— what remains is the G1 estate receipt, now unblocked"),
            "lane:console",
            "W5-console",
        ),
        (
            3965,
            ("bicep-sync: cost-export.bicep is allowlisted, not wired — routing "
             "decision + Gov receipt owed by the admin-plane/main.bicep lane"),
            "lane:bicep",
            "W7-bicep",
        ),
    ]
    for number, title, lane, expected in cases:
        # The fixture must actually REACH the arm under test, or this proves
        # nothing about precedence. Asked of the implementation, not asserted.
        assert _reaches_the_title_arm(title), (
            f"#{number} fixture no longer reaches the W4 title arm -- this test "
            f"stopped witnessing precedence the moment that became true"
        )
        got = build_inventory.stream_for(number, title, {lane})
        assert got == expected, f"#{number} with {lane} -> {got}, wanted {expected}"


def test_a_by_number_pin_still_outranks_a_lane_label():
    """The OTHER half of the precedence change, and the one that would be lost
    by "just move the whole W4 branch down".

    WHAT MAKES THIS FAIL: moving `number in RECEIPTS` below the lane loop too.
    #4405 is in RECEIPTS and is given `lane:console` here; if the pin lost its
    precedence this returns "W5-console".

    A by-number pin is a person naming one issue. That is strictly more evidence
    than a label, so it keeps the position the substring gave up.
    """
    assert 4405 in build_inventory.RECEIPTS
    assert build_inventory.stream_for(4405, "no keyword here", {"lane:console"}) == (
        "W4-receipts"
    )


def test_the_title_substring_still_catches_an_unlabelled_receipt_issue():
    """The POSITIVE control for the arm the test above demotes.

    `test_an_explicit_lane_label_outranks_a_title_substring` is satisfied by
    DELETING the substring arm outright. This pins that it still fires when
    nothing better is known, which is the honest answer until someone labels
    the issue.

    THE FIXTURE IS #4680, and it is the live residue rather than an invention:
    as of 2026-09-24 it carries only `csa-loom` (not a `lane:*`), so no lane
    arm can reach it. Round 1 used #4554 and called it "unlabelled today" --
    #4554 was labelled `lane:console` within the hour and now routes to
    W5-console via this very change, so that sentence was false before the PR
    merged. #4680 is used with its live title and a lane-free label set; if it
    too gets a lane label this test still passes, because the assertion is
    about the RULE and the labels passed here are explicit, not read from
    GitHub.

    WHAT MAKES THIS FAIL: deleting the `"receipt" in title.lower()` arm. Then
    the first assertion reads "W9-rest".
    """
    title = (
        "The g1-browser receipt producer cannot start a runner — gh-aca-runner "
        "was zeroed 2026-09-13 as a cost decision, and loom-ui-verify is the "
        "in-VNet driver that decision did not account for (143 ui-surface items "
        "unclosable)"
    )
    assert build_inventory.stream_for(4680, title, {"csa-loom"}) == "W4-receipts"
    # And the arm is a substring match, not a whole-title match: without the
    # word there is no W4 at all.
    assert build_inventory.stream_for(4680, "runner cannot start", {"csa-loom"}) == (
        "W9-rest"
    )


def test_the_pure_harness_items_are_pinned_and_the_pin_is_load_bearing():
    """WHAT MAKES EACH ASSERTION FAIL: removing that number from `HARNESS`.

    Each of these is a change to `tools/drain/*.py` with NO ESTATE SURFACE. Left
    in W4-receipts they resolve to `estate-behaviour`, whose producer is
    `loom-synthetic-monitor` -- and no monitor run can witness an edit to this
    file, so the item is UNCLOSABLE rather than merely mislabelled. Measured on
    #4545, whose fix merged in #4552 and which still refused every receipt kind:

        #4545 is 'estate-behaviour' and needs a estate receipt, which is
        established by a workflow run - pass --from-run

    THE EMPTY LABEL SET IS A DELIBERATE COUNTERFACTUAL, NOT THE LIVE STATE.
    Five of these seven carry `lane:ci` on GitHub as of 2026-09-24T16:23Z and
    would reach W6-ci without any pin at all. The pin is not what makes them
    closable TODAY -- it is what keeps them closable when a label is removed,
    which is measured history for #4545 (it held `lane:ci`, lost it on
    2026-09-18, and was demoted W0-harness -> W4-receipts in the same tick).
    So the case under test is exactly "the label is gone", and that is why no
    labels are passed.

    The third assertion is what makes the pin LOAD-BEARING rather than
    decorative: the same title at an unpinned number must be unclosable. If
    that ever stops holding, the justification in `build_inventory.HARNESS`
    has expired and should be re-read, not silenced.
    """
    import ledger

    cases = [
        (4533, ("drain receipts: three partly-exercised branches - both binding "
                "surfaces, and TERMINAL narrowed to CLOSED")),
        (4544, ("drain harness: three TERMINAL-adjacent mutations survive the "
                "whole suite — including one that would let --record-receipt "
                "close a PARKED item")),
        (4545, ("drain harness: a ledger close never reaches GitHub, so the next "
                "refresh calls it a reopen and VOIDS the receipt — every "
                "self-closed item un-closes itself")),
        (4578, ("drain: a run-backed receipt is bound to no TIME and no SHA, so "
                "a run that predates the issue is accepted as evidence for it")),
        (4579, ("drain: the already-closed route records a receipt with no public "
                "trace at all — it lives only in a gitignored local file")),
        (4676, ("drain harness: the ci-green receipt judges a merged PR's steps "
                "against TODAY's declaration, so any step rename retroactively "
                "voids every older receipt")),
        (4694, ("drain: a title substring routes 9 items to W4-receipts, "
                "overruling explicit lane labels and making 5 harness items "
                "unclosable")),
    ]
    unpinned = 999_997
    assert unpinned not in build_inventory.HARNESS
    for number, title in cases:
        assert number in build_inventory.HARNESS, f"#{number} is not pinned"
        stream = build_inventory.stream_for(number, title, set())
        assert stream == "W0-harness", f"#{number} -> {stream}"
        item = ledger.Item(number=number, title=title, stream=stream)
        assert item.effective_receipt_class == "guard-or-test-only", (
            f"#{number} -> {item.effective_receipt_class}"
        )
        # The counterfactual: unpinned, this exact title is unclosable. Asked
        # of the implementation, so a narrowing of the substring arm surfaces
        # here instead of silently making the pin redundant.
        assert _reaches_the_title_arm(title), (
            f"#{number}'s title no longer reaches the W4 arm, so the pin is no "
            f"longer what rescues it -- re-read why it is pinned"
        )
        without = ledger.Item(
            number=unpinned,
            title=title,
            stream=build_inventory.stream_for(unpinned, title, set()),
        )
        assert without.effective_receipt_class == "estate-behaviour", (
            f"#{number} unpinned -> {without.effective_receipt_class}, so the "
            f"pin is not load-bearing"
        )


def test_the_harness_pin_beats_the_title_arm_and_survives_a_lane_label():
    """A negative control for the test above: it must be the PIN doing the work,
    not the lane loop, and not the demotion of the substring arm.

    WHAT MAKES THIS FAIL: removing 4545 from `HARNESS` (the first assertion
    then reads "W4-receipts", which is exactly the unclosable state).

    The second block is the property that justifies the pin's continued
    existence now that #4545 carries `lane:ci` again: the pin sits ahead of the
    lane loop, so the verdict does NOT depend on the label being present. Both
    label states give W0-harness; only the pin does.
    """
    title = (
        "drain harness: a ledger close never reaches GitHub, so the next refresh "
        "calls it a reopen and VOIDS the receipt — every self-closed item "
        "un-closes itself"
    )
    assert build_inventory.stream_for(4545, title, set()) == "W0-harness"
    assert build_inventory.stream_for(4545, title, {"lane:ci"}) == "W0-harness"
    # The un-pinned counterfactual, spelled out with a number that is in no
    # pinned set: same title, same (absent) labels, different verdict.
    assert 999_999 not in build_inventory.HARNESS
    assert build_inventory.stream_for(999_999, title, set()) == "W4-receipts"
