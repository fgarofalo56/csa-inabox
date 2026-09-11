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
