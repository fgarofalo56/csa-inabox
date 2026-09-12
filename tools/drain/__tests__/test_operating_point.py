"""`operating_point.py` MODELS the gates. A model that is wrong is worse than none.

This file exists because both independent reviewers found the same defect in it
on the same round, and neither could have been caught by the suite: the module
shipped with ZERO tests and ZERO mutation arms, in a package whose whole thesis
is that an unexercised control is prose.

The first version ANDed `receipt_ok` into `stream_known` and called the result
"what gate 3b will say". `receipt_ok` is `--allow-close`'s business -- gate 6 --
and 3b never reads it. Over the live 299 the model said `{2: 299}` and the gate
says `{2: 298, 1: 1}`.

The second version read `item.pr is not None` where the gate reads
`item.pr == pr`, so an item bound to ANOTHER PR modelled as one-reviewer where
the gate says two. Inert while nothing writes `Item.pr`; it arms on #4489.

So the test here is not "does the model return a plausible number". It is **does
the model agree with the real composition, item by item**. Anything less is a
test of the model against itself.

Run:  python -m pytest tools/drain/__tests__/ -q
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import merge_gate
import operating_point
from ledger import Ledger

import gates

POLICY = gates.load_policy(os.path.join(os.path.dirname(__file__), "..", "policy.json"))


def _ledger(tmp_path, rows):
    """rows: (number, stream, state, pr, receipt_kind)

    States are assigned DIRECTLY rather than through `transition()`. The
    transition rules are R2's business and have their own suite; what is under
    test here is whether the model and the gate agree about a state VALUE, and
    routing through `transition` would mean a terminal row needs a receipt it
    is not supposed to have.
    """
    path = str(tmp_path / "state.json")
    led = Ledger(path, receipts=POLICY["receipts"])
    for number, stream, state, pr, receipt in rows:
        led.upsert(number, "x", stream, lane="lane:docs", size=1)
        led.items[number].state = state
        if pr is not None:
            led.items[number].pr = pr
        if receipt:
            led.record_receipt(number, receipt, "evidence")
    led.save()
    return led


def _real(policy, number, pr):
    """The composition `run_gates` actually performs for gate 3b."""
    stream, _why = merge_gate.ledger_stream([number], [], policy, None, pr=pr)
    needed, _why = gates.review_requirement(
        policy, changed_paths=["docs/x.md"], footprint_known=True,
        stream=stream, stream_known=stream is not None,
    )
    return needed


def test_the_model_agrees_with_the_gate_on_every_shape(tmp_path, monkeypatch):
    """THE contract. Every combination of the inputs gate 3b consults, driven
    through BOTH the model and the real composition, asserted equal.

    `item.pr = 99` with the PR under test being 1 is the row that caught the
    second defect: the gate refuses (bound elsewhere), the model accepted."""
    # EVERY scheduled state, taken from the constant rather than typed out. The
    # first version listed three states by hand and omitted `awaiting-receipt`,
    # so arm OP3 -- dropping one state from the model -- SURVIVED. A fixture
    # that enumerates a subset of a constant cannot see the constant shrink.
    rows = []
    number = 1
    states = ("ready", "closed", *merge_gate.SCHEDULED_STATES)
    for stream in ("W9-rest", "W1-deploy"):          # non-escalating, escalating
        for state in states:
            for pr in (None, 1, 99):                  # unbound, ours, another's
                rows.append((number, stream, state, pr, None))
                number += 1

    # ONE ITEM PER LEDGER, and the model is CALLED, not reimplemented.
    #
    # The first version recomputed `stream_known` inline with the same
    # expression `merge_time` uses -- so it compared a COPY of the model to the
    # gate, and arm OP3 (which mutates the real model) SURVIVED, because the
    # copy in the test was not mutated. That is verbatim "a test of the model
    # against itself", which this file's own docstring warns about. Written by
    # me, in the file written to prevent it.
    #
    # `ledger_stream(state_path=None)` resolves through `ledger_candidates`, so
    # HERE is pointed at the fixture rather than a path being passed -- that is
    # the code path production takes, and a test that bypasses it tests
    # something else.
    mismatches = []
    for row in rows:
        num, stream, state, pr, _receipt = row
        one = tmp_path / f"row{num}"
        one.mkdir()
        led = _ledger(one, [row])
        monkeypatch.setattr(merge_gate, "HERE", str(one))

        counts, _one_reviewer, _receipted = operating_point.merge_time(
            POLICY, led, pr=1)
        model = next(iter(counts))
        real = _real(POLICY, num, pr=1)
        if model != real:
            mismatches.append(
                f"#{num} {stream} state={state} pr={pr} model={model} real={real}"
            )
    assert mismatches == [], "\n".join(mismatches)


def test_merge_time_counts_the_gate_not_the_receipt(tmp_path):
    """`receipt_ok` is gate 6's, not 3b's. The first version conflated them and
    reported 100% two-reviewer over a ledger where one item asks for one.

    The receipt count is reported SEPARATELY, because it is the thing that
    actually stops that item -- a different gate, and the operator should see
    both numbers rather than one that silently merges them."""
    led = _ledger(tmp_path, [
        (1, "W9-rest", "in-flight", None, None),     # 3b says ONE, no receipt
        (2, "W9-rest", "in-flight", None, "ci-green"),  # ONE, and receipted
        (3, "W9-rest", "ready", None, None),         # never scheduled -> TWO
        (4, "W1-deploy", "in-flight", None, None),   # escalating stream -> TWO
    ])
    counts, one_reviewer, receipted = operating_point.merge_time(POLICY, led, pr=1)
    assert counts[1] == 2, counts
    assert counts[2] == 2, counts
    assert one_reviewer == 2
    assert receipted == 1, "only #2 could actually reach GO"


def test_negative_control_an_item_bound_to_another_pr_is_not_corroborated(tmp_path):
    """The row that caught the second defect, on its own so a failure names it.
    `item.pr is not None` accepted; `item.pr == pr` refuses. Inert until #4489
    lands a writer, which is exactly when a silent divergence would start."""
    led = _ledger(tmp_path, [(1, "W9-rest", "in-flight", 99, None)])
    counts, _one, _receipted = operating_point.merge_time(POLICY, led, pr=1)
    assert counts[2] == 1, counts
    assert counts[1] == 0, "an item another PR owns cannot corroborate this one"


def test_brief_time_and_merge_time_are_different_questions(tmp_path):
    """They are quoted side by side in `policy.json` and are NOT comparable:
    brief time decides from a LANE before the diff exists, merge time from the
    real diff and the ledger. The same item can legitimately differ."""
    led = _ledger(tmp_path, [(1, "W9-rest", "ready", None, None)])
    brief, _reasons, _per_stream = operating_point.brief_time(POLICY, led)
    merge, _one, _receipted = operating_point.merge_time(POLICY, led, pr=1)
    # brief: laned, non-escalating stream -> ONE. merge: never scheduled -> TWO.
    assert brief[1] == 1, brief
    assert merge[2] == 1, merge
