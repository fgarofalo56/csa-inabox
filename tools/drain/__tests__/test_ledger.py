"""Unit tests for the ledger, each with a NEGATIVE CONTROL.

The README calls `ledger.transition()` the enforcement point for
`deploy-integrity.md` R2 -- merged is never done -- and for the rule that a park
without an owner is indistinguishable from forgetting. Until this file existed
that module had ZERO tests, so both "load-bearing refusals" were claims about
untested code, and the one that mattered was wrong: `transition()` checked that a
receipt was PRESENT, never that it was the KIND the item's class requires, so the
literal string "merged" closed a console surface.

Run:  python -m pytest tools/drain/__tests__/ -q
"""
from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import ledger as led_mod
from ledger import CLOSED, DECLINED, NEEDS_AUDIT, PARKED, READY, Ledger

import gates

POLICY = gates.load_policy(os.path.join(os.path.dirname(__file__), "..", "policy.json"))
RECEIPTS = POLICY["receipts"]


def _led(tmp_path, receipts=RECEIPTS) -> Ledger:
    return Ledger(str(tmp_path / "state.json"), receipts=receipts)


# ---------------------------------------------------------------------------
# R2 in code: closed requires a receipt OF THE RIGHT KIND
# ---------------------------------------------------------------------------


def test_a_matching_receipt_closes(tmp_path):
    led = _led(tmp_path)
    led.upsert(1, "a console surface", "W5-console", lane="lane:console", size=3)
    led.record_receipt(1, "g1-browser", "playwright run 123, agent badge asserted")
    item = led.transition(1, CLOSED, "verified live")
    assert item.state == CLOSED


def test_negative_control_no_receipt_refuses(tmp_path):
    led = _led(tmp_path)
    led.upsert(1, "a guard", "W6-ci", lane="lane:ci", size=2)
    with pytest.raises(ValueError, match="without a receipt"):
        led.transition(1, CLOSED)


def test_negative_control_an_empty_receipt_refuses(tmp_path):
    led = _led(tmp_path)
    led.upsert(1, "a guard", "W6-ci", lane="lane:ci", size=2)
    led.record_receipt(1, "", "")
    with pytest.raises(ValueError, match="without a receipt"):
        led.transition(1, CLOSED)


def test_negative_control_the_string_merged_does_not_close_anything(tmp_path):
    """THE defect this suite exists for. A truthiness check on the receipt let
    any non-empty string close any item, including the one word R2 says is never
    a receipt."""
    led = _led(tmp_path)
    led.upsert(1, "a console surface", "W5-console", lane="lane:console", size=3)
    led.record_receipt(1, "merged", "PR #4483 landed")
    with pytest.raises(ValueError, match="does not close"):
        led.transition(1, CLOSED)


def test_negative_control_ci_green_does_not_close_a_ui_surface(tmp_path):
    """ux-baseline G1: tsc + vitest are not completion evidence."""
    led = _led(tmp_path)
    led.upsert(1, "an editor", "W5-console", lane="lane:console", size=5)
    led.record_receipt(1, "ci-green", "all required contexts green")
    with pytest.raises(ValueError, match="does not close"):
        led.transition(1, CLOSED)


def test_negative_control_ci_green_does_not_close_a_deploy_path_item(tmp_path):
    """W1 is the stream R1 says preempts everything. Closing it on CI green is
    reporting a merge as a fix."""
    led = _led(tmp_path)
    led.upsert(1, "a deploy lane", "W1-deploy", lane="lane:ci", size=5)
    led.record_receipt(1, "ci-green", "green at the merged sha")
    with pytest.raises(ValueError, match="does not close"):
        led.transition(1, CLOSED)
    led.record_receipt(1, "deploy-run", "run 987654321, deploy job executed 33 steps")
    assert led.transition(1, CLOSED).state == CLOSED


def test_negative_control_the_receipt_refusal_applies_to_every_stream(tmp_path):
    """THE narrow bypass: `if state == CLOSED and item.stream != "W9-rest":`
    exempts 90 of 297 issues from R2 and survives any fixture built from one
    stream. A filter placed INSIDE the predicate beats a contract written about
    the predicate, so the contract has to be written over the POPULATION."""
    import build_inventory

    for i, stream in enumerate(build_inventory.ORDER):
        led = _led(tmp_path)
        led.upsert(i, "x", stream, lane="lane:ci", size=1)
        with pytest.raises(ValueError, match="without a receipt"):
            led.transition(i, CLOSED)
        led.record_receipt(i, "merged", "the PR landed")
        with pytest.raises(ValueError, match="does not close"):
            led.transition(i, CLOSED)


def test_negative_control_the_decline_refusal_applies_to_every_stream(tmp_path):
    """Same shape, same door. Both refusals that define a terminal state must be
    contracted over every stream, not over the one the fixture happened to use."""
    import build_inventory

    for i, stream in enumerate(build_inventory.ORDER):
        led = _led(tmp_path)
        led.upsert(i, "x", stream, lane="lane:ci", size=1)
        with pytest.raises(ValueError, match="recorded decision"):
            led.transition(i, DECLINED)


def test_negative_control_the_park_refusal_applies_to_every_stream(tmp_path):
    import build_inventory

    for i, stream in enumerate(build_inventory.ORDER):
        led = _led(tmp_path)
        led.upsert(i, "x", stream, lane="lane:ci", size=1)
        with pytest.raises(ValueError, match="blocker AND owner"):
            led.transition(i, PARKED)


def test_negative_control_without_the_policy_map_nothing_closes(tmp_path):
    """A ledger that cannot validate the KIND must refuse, not fall back to a
    presence check -- falling back is exactly the defect, re-entered by a
    different door."""
    led = _led(tmp_path, receipts=None)
    led.upsert(1, "a guard", "W6-ci", lane="lane:ci", size=2)
    led.record_receipt(1, "ci-green", "green")
    with pytest.raises(ValueError, match="no policy receipts map"):
        led.transition(1, CLOSED)


# ---------------------------------------------------------------------------
# A park without an owner is indistinguishable from forgetting
# ---------------------------------------------------------------------------


def test_a_named_blocker_and_owner_parks(tmp_path):
    led = _led(tmp_path)
    item = led.upsert(1, "gov lane", "W3-gov", lane="lane:bicep", size=3)
    item.blocker = "no GCC tenant exists to authenticate against"
    item.owner = "operator"
    item.review_by = "2026-11-11"
    assert led.transition(1, PARKED).state == PARKED


def test_negative_control_a_park_with_no_owner_refuses(tmp_path):
    led = _led(tmp_path)
    item = led.upsert(1, "gov lane", "W3-gov", lane="lane:bicep", size=3)
    item.blocker = "no GCC tenant"
    with pytest.raises(ValueError, match="blocker AND owner"):
        led.transition(1, PARKED)


def test_negative_control_a_park_with_no_blocker_refuses(tmp_path):
    led = _led(tmp_path)
    item = led.upsert(1, "gov lane", "W3-gov", lane="lane:bicep", size=3)
    item.owner = "operator"
    with pytest.raises(ValueError, match="blocker AND owner"):
        led.transition(1, PARKED)


def test_a_recorded_decision_declines(tmp_path):
    led = _led(tmp_path)
    led.upsert(1, "x", "W9-rest", lane="lane:ci", size=1)
    assert led.transition(
        1, DECLINED, "operator 2026-09-11: superseded by the Iceberg path"
    ).state == DECLINED


def test_negative_control_a_decline_with_no_recorded_decision_refuses(tmp_path):
    """`declined` is the THIRD terminal state and had NO refusal: an empty `why`
    recorded the transition and nothing else, so a whole backlog could reach
    `drained(): True` -- this program's exit condition -- with zero evidence.
    Two of the three refusals were in code; this one was only in prose."""
    led = _led(tmp_path)
    led.upsert(1, "x", "W9-rest", lane="lane:ci", size=1)
    with pytest.raises(ValueError, match="without a recorded decision"):
        led.transition(1, DECLINED)
    with pytest.raises(ValueError, match="without a recorded decision"):
        led.transition(1, DECLINED, "   ")


def test_negative_control_a_backlog_cannot_be_declined_into_drained(tmp_path):
    led = _led(tmp_path)
    for n in range(10):
        led.upsert(n, "x", "W9-rest", lane="lane:ci", size=1)
    for n in range(10):
        with pytest.raises(ValueError, match="recorded decision"):
            led.transition(n, DECLINED)
    assert not led.drained()


def test_an_unknown_state_is_refused(tmp_path):
    led = _led(tmp_path)
    led.upsert(1, "x", "W9-rest", lane="lane:ci", size=1)
    with pytest.raises(ValueError, match="unknown state"):
        led.transition(1, "done-ish")


# ---------------------------------------------------------------------------
# drained() -- the run's exit test
# ---------------------------------------------------------------------------


def test_negative_control_an_empty_ledger_is_not_drained(tmp_path):
    """`all([])` is True. Without the emptiness clause a wiped scratch file
    reports a 297-issue backlog DRAINED, and `drained: true` is the documented
    exit condition of the whole program -- so the run ends having done nothing.
    An empty ledger is the absence of a measurement, not a result."""
    assert not _led(tmp_path).drained()


def test_all_terminal_is_drained(tmp_path):
    led = _led(tmp_path)
    led.upsert(1, "a", "W6-ci", lane="lane:ci", size=1)
    led.upsert(2, "b", "W6-ci", lane="lane:ci", size=1)
    led.record_receipt(1, "ci-green", "green at sha")
    led.transition(1, CLOSED)
    item = led.items[2]
    item.blocker, item.owner = "upstream", "operator"
    led.transition(2, PARKED)
    assert led.drained()


def test_negative_control_one_open_item_is_not_drained(tmp_path):
    led = _led(tmp_path)
    led.upsert(1, "a", "W6-ci", lane="lane:ci", size=1)
    led.record_receipt(1, "ci-green", "green")
    led.transition(1, CLOSED)
    led.upsert(2, "b", "W6-ci", lane="lane:ci", size=1)
    assert not led.drained()


def test_a_missing_file_is_distinguishable_from_an_empty_one(tmp_path):
    """`--status` must be able to tell "no queue" from "an empty queue"."""
    led = _led(tmp_path)
    assert not led.load().loaded_from_disk
    led.upsert(1, "a", "W6-ci", lane="lane:ci", size=1)
    led.save()
    assert _led(tmp_path).load().loaded_from_disk


# ---------------------------------------------------------------------------
# Receipt class derivation -- what the brief tells an agent
# ---------------------------------------------------------------------------


def test_receipt_class_follows_the_stream(tmp_path):
    led = _led(tmp_path)
    assert led.upsert(1, "x", "W1-deploy", lane="lane:bicep", size=3
                      ).effective_receipt_class == "deploy-path"
    assert led.upsert(2, "x", "W6-ci", lane="lane:ci", size=3
                      ).effective_receipt_class == "guard-or-test-only"
    assert led.upsert(3, "x", "W8-dataplane", lane="lane:dataplane", size=3
                      ).effective_receipt_class == "estate-behaviour"


def test_the_console_lane_is_a_ui_surface_whatever_stream_it_sits_in(tmp_path):
    led = _led(tmp_path)
    item = led.upsert(1, "x", "W9-rest", lane="lane:console", size=3)
    assert item.effective_receipt_class == "ui-surface"


def test_an_explicit_class_reaches_human_only(tmp_path):
    """`operator` is otherwise unreachable, and it is the receipt for anything
    only a person can verify."""
    led = _led(tmp_path)
    item = led.upsert(1, "tenant admin consent", "W2-security", lane="lane:ci", size=2)
    item.receipt_class = "human-only"
    assert item.effective_receipt_class == "human-only"
    led.record_receipt(1, "operator", "click-script in the issue")
    assert led.transition(1, CLOSED).state == CLOSED


# ---------------------------------------------------------------------------
# upsert -- refresh must not lose progress, and must not preserve stale labels
# ---------------------------------------------------------------------------


def test_upsert_preserves_progress(tmp_path):
    led = _led(tmp_path)
    led.upsert(1, "old title", "W6-ci", lane="lane:ci", size=2)
    led.record_receipt(1, "ci-green", "green at sha")
    led.upsert(1, "new title", "W6-ci", lane="lane:ci", size=2)
    assert led.items[1].receipt_kind == "ci-green"
    assert led.items[1].title == "new title"


def test_negative_control_a_repinned_stream_reaches_an_item_already_in_the_ledger(tmp_path):
    """`upsert` wrote title, lane and size and silently DROPPED stream -- so a
    correction to `build_inventory`'s pinned sets, which is how a
    misclassification gets fixed, never reached an item already in the ledger.
    The stream decides the receipt CLASS: #4485 was pinned to W0-harness and
    stayed W6-ci. A fix that lands one layer above where the value is stored is
    not a fix."""
    led = _led(tmp_path)
    led.upsert(4485, "x", "W6-ci", lane="lane:ci", size=1)
    assert led.items[4485].stream == "W6-ci"
    led.upsert(4485, "x", "W0-harness", lane="lane:ci", size=1)
    assert led.items[4485].stream == "W0-harness"


def test_negative_control_a_stream_downgrade_cannot_make_a_held_receipt_sufficient(tmp_path):
    """THE regression the stream write-through introduced, found independently
    by both reviewers. `effective_receipt_class` is evaluated lazily at close
    time, so once `stream` became mutable the REQUIRED RECEIPT became mutable
    with it -- and `stream` comes from live GitHub labels every tick.

    Sequence: record `ci-green` on a `ui-surface` item (refused, correctly),
    remove `lane:console` for an unrelated reason, and the SAME receipt closes
    it. The item never left `in-flight`. R2 defeated by a label edit.

    The first fix did NOT catch this: guarding "the receipt is no longer valid
    for the new class" never fires on a downgrade, because a downgrade is
    exactly where the old receipt BECOMES valid."""
    led = _led(tmp_path)
    led.upsert(1, "an editor", "W5-console", lane="lane:console", size=3)
    led.transition(1, "in-flight", "selected")
    led.record_receipt(1, "ci-green", "green at sha")
    with pytest.raises(ValueError, match="does not close"):
        led.transition(1, CLOSED)

    led.upsert(1, "an editor", "W9-rest", lane=None, size=3)   # label removed
    assert led.items[1].receipt_kind is None, "the receipt must be VOID, not carried over"
    assert led.items[1].state == NEEDS_AUDIT
    assert led.items[1].audit_reason == led_mod.AUDIT_RECLASSIFIED
    with pytest.raises(ValueError, match="without a receipt"):
        led.transition(1, CLOSED)
    assert any("VOID" in h for h in led.items[1].history), "and it must be RECORDED"


def test_negative_control_a_lane_removal_alone_cannot_make_a_receipt_sufficient(
    tmp_path,
):
    """The door the previous fix left open, and the one its own comment had
    named as the attack. `effective_receipt_class` reads THREE inputs --
    `receipt_class`, then `lane`, then `stream` -- and `lane` OUTRANKS `stream`.
    Keying the guard on `stream` therefore defended the route the reviewers
    demonstrated and left the stronger one untouched.

    Here the stream is PINNED at W2-security throughout: nothing about it moves.
    Only `lane:console` is removed, which is an ordinary relabel, and the class
    falls `ui-surface` -> `guard-or-test-only`. Eleven live items sat on a
    lane-derived class when this was measured, 8 of them W2-security whose
    required receipt would have dropped from a live browser walk to CI green.

    Kills L15."""
    led = _led(tmp_path)
    led.upsert(1, "a security surface", "W2-security", lane="lane:console", size=3)
    led.transition(1, "in-flight", "selected")
    led.record_receipt(1, "ci-green", "run/123")
    assert led.items[1].effective_receipt_class == "ui-surface"
    with pytest.raises(ValueError, match="does not close"):
        led.transition(1, CLOSED)

    led.upsert(1, "a security surface", "W2-security", lane=None, size=3)
    assert led.items[1].stream == "W2-security", "the stream must NOT have moved"
    assert led.items[1].effective_receipt_class == "guard-or-test-only"
    assert led.items[1].receipt_kind is None, "the receipt must be VOID"
    with pytest.raises(ValueError, match="without a receipt"):
        led.transition(1, CLOSED)
    # The lane move is recorded in its own right (kills L17), and the VOID line
    # names the REF -- a receipt destroyed without saying which one it was
    # leaves nothing to re-take or to dispute.
    assert any("lane lane:console -> None" in h for h in led.items[1].history)
    assert any("VOID" in h and "run/123" in h for h in led.items[1].history)


def test_negative_control_an_explicit_receipt_class_escapes_a_label_keyed_guard(
    tmp_path,
):
    """The third input, and the one that outranks both labels. A guard re-gated
    on "did a LABEL move?" reads clean here: neither `lane` nor `stream`
    changes, and the class still drops because `receipt_class` was written
    through the kwargs loop.

    This is why the comparison is taken over the CLASS -- the OUTCOME -- rather
    than over any list of its causes. The two previous versions of this guard
    were each a narrower enumeration of causes, and each was breached by the
    input it did not enumerate. Kills L18."""
    led = _led(tmp_path)
    led.upsert(1, "x", "W1-deploy", lane="lane:bicep", size=1)
    led.record_receipt(1, "ci-green", "r/1")
    assert led.items[1].effective_receipt_class == "deploy-path"

    led.upsert(1, "x", "W1-deploy", lane="lane:bicep", size=1,
               receipt_class="guard-or-test-only")
    assert led.items[1].lane == "lane:bicep"
    assert led.items[1].stream == "W1-deploy"
    assert led.items[1].receipt_kind is None
    with pytest.raises(ValueError, match="without a receipt"):
        led.transition(1, CLOSED)


def test_negative_control_kwargs_cannot_restore_a_receipt_the_same_call_voided(
    tmp_path,
):
    """Order matters. The kwargs loop writes arbitrary fields, `receipt_kind`
    among them, so a refresh that reclassifies AND supplies a receipt in one
    call must not have the write land after the void. Kills L16 -- if
    `now_class` is read before the writes it can never differ and every route
    here is open at once."""
    led = _led(tmp_path)
    led.upsert(1, "x", "W5-console", lane="lane:console", size=1)
    led.record_receipt(1, "g1-browser", "trace/1")
    led.upsert(1, "x", "W9-rest", lane=None, size=1,
               receipt_kind="ci-green", receipt_ref="r/2")
    assert led.items[1].receipt_kind is None
    with pytest.raises(ValueError, match="without a receipt"):
        led.transition(1, CLOSED)


def test_a_mid_work_reclassification_is_flagged_even_with_no_receipt_yet(tmp_path):
    """A lane holding this item is building toward a target that just moved --
    a `g1-browser` walk it no longer needs, or a `ci-green` that is no longer
    enough. It is told whether or not a receipt happened to have been taken
    first. My own probe caught this one: the earlier shape only routed to
    `needs-audit` inside the void branch, so an item reclassified BEFORE its
    receipt existed kept working to the old spec in silence. Kills L19."""
    led = _led(tmp_path)
    led.upsert(1, "x", "W5-console", lane="lane:console", size=1)
    led.transition(1, "in-flight", "selected")
    led.upsert(1, "x", "W9-rest", lane=None, size=1)
    assert led.items[1].state == NEEDS_AUDIT
    assert led.items[1].audit_reason == led_mod.AUDIT_RECLASSIFIED
    assert any("receipt class ui-surface -> guard-or-test-only" in h
               for h in led.items[1].history)


def test_a_ready_item_is_not_routed_to_needs_audit_by_a_reclassification(tmp_path):
    """The control for the one above. A `ready` item has nothing to audit; its
    receipt is void, that is recorded, and what it needs is re-work, which is
    what `ready` means.

    THIS TEST WAS PREVIOUSLY A FRAUD, caught by a reviewer: it entered from
    `needs-audit`, so the carve-out's tuple was never consulted and the `ready`
    it asserted came from the departure rescue below. Widening the tuple to
    include `READY` -- which IS the round-3 behaviour that stranded items --
    passed 262/262 over a green 117-arm matrix. A test named for a fix that
    does not exercise it is worse than no test: it reads as coverage.

    Entered from a genuinely READY item, and it asserts the receipt half of its
    own docstring too (the second reviewer's finding 2). Kills L20."""
    led = _led(tmp_path)
    led.upsert(1, "x", "W5-console", lane="lane:console", size=1)
    led.record_receipt(1, "g1-browser", "trace/5")
    assert led.items[1].state == READY, "the premise: it must START ready"

    led.upsert(1, "x", "W9-rest", lane=None, size=1)
    assert led.items[1].state == READY, "a ready item has nothing to audit"
    assert led.items[1].audit_reason is None
    assert led.items[1].receipt_kind is None, "the receipt is still VOID"
    assert any("VOID" in h and "trace/5" in h for h in led.items[1].history)


def test_negative_control_the_departure_rescue_survives_a_reclassification(tmp_path):
    """The stranding this carve-out repaired, which is a DIFFERENT case from the
    one above and used to share its test. `audit_reason` is a SCALAR: routing
    every reclassification to `needs-audit` overwrote a `departed` reason, which
    made the rescue's `elif` unmatchable and left the item unable to return to
    the queue ever -- the one-way `needs-audit` the rescue exists to prevent."""
    led = _led(tmp_path)
    it = led.upsert(1, "x", "W5-console", lane="lane:console", size=1)
    it.audit_reason = led_mod.AUDIT_DEPARTED
    led.transition(1, NEEDS_AUDIT, "gone from GitHub")
    led.upsert(1, "x", "W9-rest", lane=None, size=1)   # returns AND reclassifies
    assert led.items[1].state == READY
    assert led.items[1].audit_reason is None


def test_negative_control_a_state_kwarg_cannot_suppress_the_mid_work_routing(tmp_path):
    """`was_state`, not `existing.state`. The kwargs loop writes arbitrary
    fields, `state` among them, so reading the POST-write state let one call
    both reclassify an in-flight item and land it in `ready`, skipping the
    checkpoint. Not reachable from either production caller today -- neither
    passes `state=` -- but the class comparison two lines up was hardened
    against exactly this shape and its sibling was not. Kills L21."""
    led = _led(tmp_path)
    led.upsert(1, "x", "W5-console", lane="lane:console", size=1)
    led.transition(1, "in-flight", "selected")
    led.record_receipt(1, "g1-browser", "trace/6")
    led.upsert(1, "x", "W9-rest", lane=None, size=1, state=READY)
    assert led.items[1].state == NEEDS_AUDIT
    assert led.items[1].audit_reason == led_mod.AUDIT_RECLASSIFIED
    assert led.items[1].receipt_kind is None


def test_negative_control_a_reopen_voids_the_receipt_that_closed_it(tmp_path):
    """The SIBLING of the class-change void, and it was missed for two rounds.

    A reopen DISPUTES the receipt that closed the item, and the class has not
    moved, so the reclassification route never touches it. Measured by a
    reviewer: close on `ci-green`, reopen, and `receipt_ok()` -- which
    `merge_gate.ledger_receipt_ready` calls in production -- still returned
    True, so `--allow-close` re-closed on the very evidence in dispute with no
    new work done. The kind check is satisfied trivially there; there is nothing
    left to re-take. Kills L22."""
    led = _led(tmp_path)
    led.upsert(1, "x", "W6-ci", lane="lane:ci", size=1)
    led.record_receipt(1, "ci-green", "run/1")
    led.transition(1, CLOSED)

    led.upsert(1, "x", "W6-ci", lane="lane:ci", size=1)   # seen OPEN on GitHub
    assert led.items[1].state == NEEDS_AUDIT
    assert led.items[1].audit_reason == led_mod.AUDIT_REOPENED
    assert led.items[1].receipt_kind is None
    ok, why = led.receipt_ok(led.items[1])
    assert not ok, f"the production reader must refuse too: {why}"
    with pytest.raises(ValueError, match="without a receipt"):
        led.transition(1, CLOSED)
    assert any("VOID" in h and "run/1" in h for h in led.items[1].history)

    # ...and the audit is dischargeable without a human, per the module comment:
    # re-take the receipt and close. The control is the KIND check, not a person.
    led.record_receipt(1, "ci-green", "run/NEW")
    assert led.transition(1, CLOSED).state == CLOSED


def test_negative_control_a_receipt_is_stamped_with_the_class_it_was_taken_under(
    tmp_path,
):
    """THE INVARIANT, as opposed to the event observer.

    `upsert`'s comparison can only witness a class that moves across a call it
    makes. Two of `effective_receipt_class`'s inputs are not fields at all --
    `RECEIPT_CLASS_BY_STREAM` and `LANE_RECEIPT_CLASS` are module constants --
    so a one-line edit to either moved every held receipt's class with NOTHING
    in `history`, the identical symptom to the round-3 defect, through an input
    no `upsert` guard can see. A reviewer closed a `ui-surface` item on the
    `ci-green` that had been refused a moment earlier.

    Stamping at capture and comparing at the decision does not care HOW the
    class moved, or whether anything observed it move. Kills L23, L24."""
    led = _led(tmp_path)
    led.upsert(1, "x", "W5-console", lane=None, size=1)
    led.record_receipt(1, "ci-green", "run/2")
    assert led.items[1].receipt_taken_under == "ui-surface"
    with pytest.raises(ValueError, match="does not close"):
        led.transition(1, CLOSED)

    saved = led_mod.RECEIPT_CLASS_BY_STREAM["W5-console"]
    led_mod.RECEIPT_CLASS_BY_STREAM["W5-console"] = "guard-or-test-only"
    try:
        # The kind check now passes trivially -- this is the downgrade, and the
        # downgrade is exactly where the old receipt BECOMES valid.
        assert led.items[1].effective_receipt_class == "guard-or-test-only"
        with pytest.raises(ValueError, match="was taken under"):
            led.transition(1, CLOSED)
    finally:
        led_mod.RECEIPT_CLASS_BY_STREAM["W5-console"] = saved


def test_negative_control_a_stale_ledger_cannot_close_against_the_weaker_class(
    tmp_path,
):
    """The milder form of the same hole, and it needs no source edit at all.
    `merge_gate` LOADS `state.json` and never upserts, so adding `lane:console`
    to an issue and running `--allow-close` before the next tick evaluated the
    receipt against the stale, weaker class. `receipt_ok` is the production
    reader, so it is what the assertion is taken against."""
    led = _led(tmp_path)
    led.upsert(1, "x", "W9-rest", lane=None, size=1)
    led.record_receipt(1, "ci-green", "run/3")
    ok, _ = led.receipt_ok(led.items[1])
    assert ok

    led.items[1].lane = "lane:console"     # labelled on GitHub; no tick yet
    ok, why = led.receipt_ok(led.items[1])
    assert not ok, why


def test_negative_control_an_old_ledger_with_an_unstamped_receipt_cannot_close(
    tmp_path,
):
    """THE SERIALIZATION BOUNDARY. `receipt_taken_under` is new on a dataclass
    that round-trips through JSON, so a ledger written before it existed -- or
    a hand edit that sets `receipt_kind` and `receipt_ref` and stops, which is
    the ONLY way a receipt gets recorded today, since `record_receipt` has no
    production caller -- loads with the stamp absent.

    It refuses, and that is deliberate. It is NOT backfilled on load: inferring
    the stamp from the item's CURRENT class would manufacture exactly the
    evidence the check exists to demand, which is "invent a receipt to get past
    the receipt gate" wearing a migration's clothes.

    The message is its own, because an absent stamp and a stale stamp have
    different causes and different remedies -- and reporting the absent case as
    "taken under None" asserted a class named None that never existed (R7)."""
    path = tmp_path / "old.json"
    path.write_text(json.dumps({
        "schema": led_mod.SCHEMA,
        "items": [{
            "number": 4400, "title": "a console surface", "stream": "W5-console",
            "state": "awaiting-receipt", "lane": "lane:console", "size": 3,
            "receipt_kind": "g1-browser", "receipt_ref": "playwright trace 77",
            "history": [],
        }],
    }), encoding="utf-8")
    led = Ledger(str(path), receipts=RECEIPTS).load()
    item = led.items[4400]
    assert item.receipt_taken_under is None

    ok, why = led.receipt_ok(item)
    assert not ok
    assert "carries no `receipt_taken_under`" in why
    assert "ui-surface" in why, "the message must name what to set it TO"
    assert "None" not in why.split("carries no")[1][:80], \
        "an absent stamp must not be reported as a class named None"

    # An ordinary refresh does NOT repair it -- nothing about the class moved,
    # so there is nothing for `upsert` to observe. Only re-taking the receipt
    # does, which is the point.
    led.upsert(4400, "a console surface", "W5-console", lane="lane:console", size=3)
    assert not led.receipt_ok(led.items[4400])[0]
    led.record_receipt(4400, "g1-browser", "playwright trace 78")
    assert led.receipt_ok(led.items[4400])[0]


def test_a_receipt_re_taken_under_the_current_class_closes(tmp_path):
    """The control. The invariant must not make a reclassified item permanently
    unclosable -- re-taking the receipt under the new class is the whole
    remedy, and if that did not work the guard would be a brick."""
    led = _led(tmp_path)
    led.upsert(1, "x", "W5-console", lane="lane:console", size=1)
    led.record_receipt(1, "g1-browser", "trace/1")
    led.upsert(1, "x", "W6-ci", lane="lane:ci", size=1)
    assert led.items[1].receipt_kind is None
    led.record_receipt(1, "ci-green", "run/9")
    assert led.items[1].receipt_taken_under == "guard-or-test-only"
    assert led.transition(1, CLOSED).state == CLOSED


def test_negative_control_the_upgrade_direction_voids_the_receipt_too(tmp_path):
    """Either direction. A receipt is evidence about a QUESTION -- change the
    class and it is evidence about a different one, so `ci-green` taken while an
    item looked like a guard proves nothing once it is a deploy path."""
    led = _led(tmp_path)
    led.upsert(1, "x", "W9-rest", lane="lane:ci", size=1)
    led.record_receipt(1, "ci-green", "green")
    led.upsert(1, "x", "W1-deploy", lane="lane:ci", size=1)
    assert led.items[1].receipt_kind is None
    assert led.items[1].effective_receipt_class == "deploy-path"


def test_a_re_pin_within_one_class_keeps_its_receipt(tmp_path):
    """The control. W6-ci and W0-harness are both `guard-or-test-only`, so a
    re-pin between them changes the stream and asks no new question -- voiding
    the receipt there would make every pin correction cost a re-verification."""
    led = _led(tmp_path)
    led.upsert(4485, "x", "W6-ci", lane="lane:ci", size=1)
    led.record_receipt(4485, "ci-green", "green at sha")
    led.upsert(4485, "x", "W0-harness", lane="lane:ci", size=1)
    assert led.items[4485].stream == "W0-harness"
    assert led.items[4485].receipt_kind == "ci-green"
    assert led.transition(4485, CLOSED).state == CLOSED
    # ...and the move is RECORDED even when it costs the receipt nothing. The
    # stream decides selection order and the receipt class; a silent change to
    # it is the thing that made the downgrade invisible in the first place.
    assert any("stream W6-ci -> W0-harness" in h for h in led.items[4485].history)


def test_negative_control_a_falsy_stream_does_not_wipe_the_class(tmp_path):
    """`lane` and `size` are written unconditionally with a stated reason -- a
    label removed on GitHub must clear the ledger's copy. `stream` inherited the
    unconditional write without the reason, and an empty stream degrades to the
    WEAKEST class rather than refusing."""
    led = _led(tmp_path)
    led.upsert(1, "x", "W1-deploy", lane="lane:bicep", size=1)
    led.upsert(1, "x", "", lane="lane:bicep", size=1)
    assert led.items[1].stream == "W1-deploy"
    assert led.items[1].effective_receipt_class == "deploy-path"


def test_an_unchanged_stream_does_not_churn_the_history(tmp_path):
    """A refresh runs every tick. A history line per tick would bury the entries
    that matter under the ones that do not."""
    led = _led(tmp_path)
    led.upsert(1, "x", "W6-ci", lane="lane:ci", size=1)
    for _ in range(4):
        led.upsert(1, "x", "W6-ci", lane="lane:ci", size=1)
    assert len(led.items[1].history) == 1


def test_negative_control_a_removed_lane_label_clears_the_lane(tmp_path):
    """A label removed on GitHub must clear the ledger's copy, or the item stays
    schedulable on a lane it no longer claims -- and lanes partition by FILE, so
    that is how two lanes end up editing one file."""
    led = _led(tmp_path)
    led.upsert(1, "x", "W6-ci", lane="lane:ci", size=2)
    assert led.items[1].schedulable
    led.upsert(1, "x", "W6-ci", lane=None, size=None)
    assert led.items[1].lane is None
    assert not led.items[1].schedulable


def test_negative_control_a_reopened_item_re_enters_the_queue(tmp_path):
    """Reopening is how a false close gets disputed. A terminal item seen OPEN
    on GitHub must not stay terminal -- and must not go straight back to `ready`
    either, because whatever closed it may still be true."""
    led = _led(tmp_path)
    led.upsert(1, "x", "W6-ci", lane="lane:ci", size=2)
    led.record_receipt(1, "ci-green", "green")
    led.transition(1, CLOSED)
    led.upsert(1, "x", "W6-ci", lane="lane:ci", size=2)
    assert led.items[1].state == NEEDS_AUDIT
    assert led.items[1] in led.remaining()


def test_needs_audit_is_not_terminal(tmp_path):
    """An item whose disappearance nobody has explained is still in the queue.
    If it were terminal the drain would report itself finished over a pile of
    unexplained closes."""
    led = _led(tmp_path)
    led.upsert(1, "x", "W6-ci", lane="lane:ci", size=2)
    led.transition(1, NEEDS_AUDIT, "gone from GitHub")
    assert not led.drained()
    assert led.counts()["needs-audit"] == 1


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------


def test_save_load_roundtrip(tmp_path):
    led = _led(tmp_path)
    led.upsert(7, "a title", "W1-deploy", lane="lane:bicep", size=8)
    led.record_receipt(7, "deploy-run", "run 1, 33 steps")
    led.cycle = 4
    led.save()

    again = _led(tmp_path).load()
    assert again.cycle == 4
    assert again.items[7].receipt_kind == "deploy-run"
    assert again.items[7].size == 8


def test_a_foreign_schema_refuses_rather_than_guessing(tmp_path):
    path = tmp_path / "state.json"
    path.write_text(json.dumps({"schema": 99, "items": []}), encoding="utf-8")
    with pytest.raises(SystemExit, match="migrate deliberately"):
        _led(tmp_path).load()


def test_counts_cover_every_state(tmp_path):
    led = _led(tmp_path)
    led.upsert(1, "x", "W6-ci", lane="lane:ci", size=1)
    counts = led.counts()
    for state in led_mod.ALL_STATES:
        assert state in counts
    assert counts["total"] == 1
    assert counts[READY] == 1
    assert counts[DECLINED] == 0
