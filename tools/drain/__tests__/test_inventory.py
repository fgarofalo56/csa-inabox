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
    heuristic classifies an issue by what it MENTIONS, not by what it IS."""
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
# ---------------------------------------------------------------------------


def test_an_explicit_lane_label_outranks_a_title_substring():
    """WHAT MAKES THIS FAIL: putting `"receipt" in title.lower()` back ahead of
    the lane loop. Then every assertion below returns "W4-receipts".

    A `lane:*` label is a human decision about the issue. `"receipt" in title`
    is a substring, and it classifies an issue by what it MENTIONS rather than
    by what it IS. Measured at 76377a86e against the live ledger, the substring
    was winning: #3965 carries `lane:bicep` and reached `estate-behaviour` via
    W4 instead of `deploy-path` via W7-bicep, purely on the word in its title.

    The fixtures are the three live items, with their REAL titles (truncated
    only where length adds nothing), so a future edit that narrows the substring
    cannot make this test agree with itself while disagreeing with the ledger.
    """
    cases = [
        (
            4408,
            "G1 receipt owed: in-browser E2E click-walk of the four highest-risk pickers",
            "lane:console",
            "W5-console",
        ),
        (
            4242,
            (
                "brain Perform: BUILT and DEPLOYED (backend + UI + guards live) - what "
                "remains is the G1 receipt"
            ),
            "lane:console",
            "W5-console",
        ),
        (
            3965,
            (
                "bicep-sync: cost-export.bicep is allowlisted, not wired - routing "
                "decision owed, then a deploy receipt"
            ),
            "lane:bicep",
            "W7-bicep",
        ),
    ]
    for number, title, lane, expected in cases:
        # The fixture must actually REACH the arm under test, or this proves
        # nothing about precedence. Assert the trigger, do not assume it.
        assert "receipt" in title.lower(), f"#{number} fixture never reaches the W4 arm"
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
    nothing better is known -- which is #4554's situation today: unlabelled, so
    W4 is the honest answer until someone labels it.

    WHAT MAKES THIS FAIL: deleting the `"receipt" in title.lower()` arm. Then
    #4554 falls to "W9-rest".
    """
    title = "G1 receipt owed: in-browser walk of the /workspaces create wizard"
    assert build_inventory.stream_for(4554, title, set()) == "W4-receipts"
    # And the arm is a substring match, not a whole-title match: without the
    # word there is no W4 at all.
    assert build_inventory.stream_for(4554, "in-browser walk owed", set()) == "W9-rest"


def test_the_five_pure_harness_items_are_pinned_and_closable():
    """WHAT MAKES EACH ASSERTION FAIL: removing that number from `HARNESS`.

    Each of these is a change to `tools/drain/*.py` with NO ESTATE SURFACE. Left
    in W4-receipts they resolve to `estate-behaviour`, whose producer is
    `loom-synthetic-monitor` -- and no monitor run can witness an edit to this
    file, so the item is UNCLOSABLE rather than merely mislabelled. Measured on
    #4545, whose fix merged in #4552 and which still refused every receipt kind:

        #4545 is 'estate-behaviour' and needs a estate receipt, which is
        established by a workflow run - pass --from-run

    The titles are the live ones and all five contain "receipt", so the W4 arm
    is REACHABLE for every fixture -- asserted below rather than assumed, since
    a fixture that never reaches the arm proves nothing about the pin.
    """
    import ledger

    cases = [
        (4533, ("drain receipts: three partly-exercised branches - both binding "
                "surfaces, and a receipt kind")),
        (4544, ("drain harness: three TERMINAL-adjacent mutations survive the whole "
                "suite, including a receipt path")),
        (4545, ("drain harness: a ledger close never reaches GitHub, so the next "
                "refresh voids the receipt")),
        (4578, "drain: a run-backed receipt is bound to no TIME and no SHA"),
        (4579, ("drain: the already-closed route records a receipt with no public "
                "trace and no receipt kind")),
    ]
    for number, title in cases:
        assert "receipt" in title.lower(), f"#{number} fixture never reaches the W4 arm"
        stream = build_inventory.stream_for(number, title, set())
        assert stream == "W0-harness", f"#{number} -> {stream}"
        item = ledger.Item(number=number, title=title, stream=stream)
        assert item.effective_receipt_class == "guard-or-test-only", (
            f"#{number} -> {item.effective_receipt_class}"
        )


def test_the_harness_pin_beats_the_title_arm_at_both_of_its_positions():
    """A negative control for the test above: it must be the PIN doing the work,
    not the lane loop, and not the demotion of the substring arm.

    #4545 is unlabelled, so the precedence change alone leaves it in W4. This
    pins that the W0 arm -- which sits ahead of BOTH W4 arms -- is what moves
    it. WHAT MAKES THIS FAIL: removing 4545 from `HARNESS` (the assertion then
    reads "W4-receipts", which is exactly the unclosable state).
    """
    title = "drain harness: a ledger close never reaches GitHub, so the next refresh voids the receipt"
    assert build_inventory.stream_for(4545, title, set()) == "W0-harness"
    # The un-pinned counterfactual, spelled out with a number that is in no
    # pinned set: same title, same (absent) labels, different verdict.
    assert 999_999 not in build_inventory.HARNESS
    assert build_inventory.stream_for(999_999, title, set()) == "W4-receipts"
