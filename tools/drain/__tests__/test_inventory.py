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
