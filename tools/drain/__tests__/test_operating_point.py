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
the gate says two. `tick.py --bind-pr` writes `Item.pr` (#4489).

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
    for stream in ("W9-rest", "W2-security"):        # non-escalating, escalating
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

    OPERATOR DECISION 2026-10-02 retired the stream-driven escalation this
    fixture used to exercise outright (`escalate_when_stream_unknown` ships
    `false`, and no stream VALUE raises the count any more either). `merge_
    time` hardcodes `changed_paths=["docs/x.md"]` and `footprint_known=True`,
    so every item in this fixture now gets the ordinary ZERO regardless of
    stream, state, or PR binding -- DISCLOSED rather than hidden behind a
    test that no longer measures what its name claims: the four rows below
    are kept, with their original comments corrected, specifically so a
    future change that makes `merge_time` sensitive to something besides the
    ordinary default is forced to touch this assertion rather than finding it
    already (silently) green.

    The receipt count is still reported SEPARATELY from the reviewer count --
    a different gate -- which is the one property this test can still pin:
    `receipted` is 0 here even though #2 holds a real `ci-green` receipt,
    because nothing in this ledger reaches `needed > 0` any more for
    `receipted` to be counted against."""
    led = _ledger(tmp_path, [
        (1, "W9-rest", "in-flight", None, None),      # corroborated (scheduled) -> ZERO
        (2, "W9-rest", "in-flight", None, "ci-green"),  # corroborated, receipted -> ZERO
        (3, "W9-rest", "ready", None, None),           # NEVER scheduled -> stream unknown
        (4, "W2-security", "in-flight", None, None),   # corroborated -> ZERO (stream
                                                        # VALUE never escalates, any policy)
    ])
    counts, one_reviewer, receipted = operating_point.merge_time(POLICY, led, pr=1)
    assert counts[0] == 4, counts
    assert one_reviewer == 0
    assert receipted == 0, "nothing in this ledger reaches needed > 0 under the shipped policy"

    # THE MECHANISM STILL EXISTS, only its shipped default changed -- proven
    # through the same override pattern `test_policy.py`'s `POLICY_BLOCK_
    # ESCALATES` uses. With `escalate_when_stream_unknown` turned back on,
    # only #3 (never scheduled, so `stream_known=False`) distinguishes: #1,
    # #2 and #4 are all corroborated (`in-flight` is a SCHEDULED state), and a
    # stream VALUE -- `W2-security` on #4 included -- does not escalate any
    # more under ANY policy value, because that mechanism was removed from
    # `review_requirement` entirely, not merely disabled by this flag.
    reopened = {**POLICY, "review": {**POLICY["review"],
                                     "escalate_when_stream_unknown": True}}
    counts, one_reviewer, receipted = operating_point.merge_time(reopened, led, pr=1)
    assert counts[0] == 3, counts   # #1, #2, #4: corroborated, stream_known=True
    assert counts[1] == 1, counts   # #3: never scheduled, stream_known=False
    assert one_reviewer == 1
    assert receipted == 0, "#3 is the one-reviewer row and it holds no receipt"


def test_negative_control_an_item_bound_to_another_pr_is_not_corroborated(tmp_path):
    """The row that caught the second defect, on its own so a failure names it.
    `item.pr is not None` accepted; `item.pr == pr` refuses. `tick.py
    --bind-pr` writes `Item.pr` (#4489), so this row measures real bindings.

    Operator decision 2026-10-02 retired `escalate_when_stream_unknown`'s
    shipped value (now `false`), so BOTH a corroborated and an uncorroborated
    binding get the ordinary ZERO under the real policy today -- asserted
    first, so that fact is not silently lost. The corroboration logic itself
    is still exercised, and still distinguishes, through the same override
    used above."""
    led = _ledger(tmp_path, [(1, "W9-rest", "in-flight", 99, None)])
    counts, _one, _receipted = operating_point.merge_time(POLICY, led, pr=1)
    assert counts[0] == 1, "unresolvable streams no longer escalate under the shipped policy"

    reopened = {**POLICY, "review": {**POLICY["review"],
                                     "escalate_when_stream_unknown": True}}
    counts, _one, _receipted = operating_point.merge_time(reopened, led, pr=1)
    assert counts[1] == 1, counts
    assert counts[0] == 0, "an item another PR owns cannot corroborate this one"


def test_brief_time_and_merge_time_are_different_questions(tmp_path):
    """They are quoted side by side in `policy.json` and are NOT comparable:
    brief time decides from a LANE before the diff exists, merge time from the
    real diff and the ledger. The same item can legitimately differ.

    Operator decision 2026-10-02: the ordinary count is now 0, not 1, at
    both measurement points -- `brief_time` resolves a laned item's lane to
    `lane:docs` -> `docs/`, which is not a sensitive path, so a laned,
    non-escalating-stream item now reads ZERO at brief time too; an unlaned,
    never-scheduled item still reads ZERO at merge time under the shipped
    policy (see the override tests above for how it distinguishes with
    `escalate_when_stream_unknown` turned back on)."""
    led = _ledger(tmp_path, [(1, "W9-rest", "ready", None, None)])
    brief, _reasons, _per_stream = operating_point.brief_time(POLICY, led)
    merge, _one, _receipted = operating_point.merge_time(POLICY, led, pr=1)
    assert brief[0] == 1, brief
    assert merge[0] == 1, merge
