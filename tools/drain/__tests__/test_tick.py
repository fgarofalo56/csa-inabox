"""Unit tests for the cycle itself -- the refresh guard and the brief.

Two of the three worst defects the first independent review found lived here,
and both were in code that had no test:

- the refresh path INVENTED a receipt (`"closed-externally"`) whose only effect
  was to satisfy the truthiness check enforcing R2, then closed every item the
  live set did not mention. `gh issue list` carried no `--repo` and `sh()` no
  `cwd`, so running the harness from another checkout returned rc=0 and a
  plausible, entirely disjoint population -- and closed all 297 in one save.
- the brief keyed its receipt off `lane == 'lane:console'`, so every deploy-path
  item -- the stream R1 says preempts all other work -- told its agent that CI
  green closes it.

Run:  python -m pytest tools/drain/__tests__/ -q
"""
from __future__ import annotations

import copy
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import ledger as ledger_module
import tick
from ledger import (
    AUDIT_DEPARTED,
    CLOSED,
    DECLINED,
    IN_FLIGHT,
    NEEDS_AUDIT,
    PARKED,
    READY,
    Ledger,
)

import gates

POLICY = gates.load_policy(os.path.join(os.path.dirname(__file__), "..", "policy.json"))


def _led(tmp_path, n=20, first=1000) -> Ledger:
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    for i in range(n):
        led.upsert(first + i, f"issue {first + i}", "W6-ci", lane="lane:ci", size=1)
    return led


def _live(numbers, labels=("lane:ci", "sp:1")):
    return [
        {"number": n, "title": f"issue {n}",
         "labels": [{"name": x} for x in labels]}
        for n in numbers
    ]


# ---------------------------------------------------------------------------
# The refresh guard -- both failures return rc=0 and valid JSON
# ---------------------------------------------------------------------------


def test_a_normal_refresh_passes_the_guard(tmp_path):
    led = _led(tmp_path)
    tick.guard_refresh(led, _live(range(1000, 1020)))


def test_one_issue_closing_normally_passes_the_guard(tmp_path):
    """The guard must not fire on ordinary progress, or it is just an outage."""
    led = _led(tmp_path)
    tick.guard_refresh(led, _live(range(1000, 1019)))


def test_negative_control_an_empty_live_set_refuses(tmp_path):
    """Zero open issues while the ledger believes twenty are open would move all
    twenty out of the queue. Rate-limited, unauthorized and wrong-repo reads can
    all produce it, and every one of them exits 0."""
    led = _led(tmp_path)
    with pytest.raises(SystemExit, match="ZERO open issues"):
        tick.guard_refresh(led, [])


def test_negative_control_a_truncated_read_refuses(tmp_path):
    """A partial response is the shape that does NOT look wrong: valid JSON, a
    plausible count, rc=0."""
    led = _led(tmp_path)
    with pytest.raises(SystemExit, match="of the 20 issues"):
        tick.guard_refresh(led, _live(range(1000, 1010)))


def test_negative_control_the_wrong_repo_refuses_despite_a_healthy_size(tmp_path):
    """THE cross-repo case, and the reason a size check alone is not enough: a
    different repository returns a full-sized, valid, entirely disjoint list.
    Only overlap distinguishes it.

    The numbers sit BELOW this ledger's ceiling on purpose -- that is the real
    shape, because two repos of similar age share a numeric range (the measured
    case was another repo's #2485 against this one's #2485)."""
    led = _led(tmp_path)
    with pytest.raises(SystemExit, match="different population"):
        tick.guard_refresh(led, _live(range(500, 530)))


def test_negative_control_a_wrong_repo_above_the_ceiling_hits_the_hard_floor(tmp_path):
    """The other shape: every foreign number is above this ledger's ceiling, so
    every one of them looks like a new ARRIVAL and the overlap clause cannot
    see it. The hard retention floor is what catches it -- which is why
    `--allow-shrink` must not be able to suppress that one."""
    led = _led(tmp_path)
    # Fifteen, so the MAGNITUDE bound (arrivals > max(floor, known)) does not
    # fire first -- this fixture is about the retention floor specifically.
    with pytest.raises(SystemExit, match="HARD floor"):
        tick.guard_refresh(led, _live(range(90000, 90015)))
    with pytest.raises(SystemExit, match="HARD floor"):
        tick.guard_refresh(led, _live(range(90000, 90015)), allow_shrink=True)


def test_negative_control_a_flood_of_arrivals_is_refused_on_magnitude(tmp_path):
    """No RATIO can separate a drained ledger meeting six genuine new issues
    from the same ledger meeting nine hundred foreign ones above its ceiling:
    in both, every live number is an arrival and nothing is believed open.
    Measured before this bound existed -- 900 foreign issues were ingested,
    the ledger grew to 940 and `drained` flipped back to false."""
    led = _led(tmp_path, n=40)
    for n in range(1000, 1040):
        led.record_receipt(n, "ci-green", "green at sha")
        led.transition(n, CLOSED)
    assert led.drained()
    with pytest.raises(SystemExit, match="floods that size"):
        tick.guard_refresh(led, _live(range(90000, 90900)))
    # ...and the legitimate end-game still passes. Without this control the
    # bound above could simply be "refuse everything".
    tick.guard_refresh(led, _live(range(90000, 90006)))


def test_negative_control_new_arrivals_do_not_halt_a_nearly_drained_run(tmp_path):
    """The END-GAME. Once most items are terminal the live set shrinks toward
    new arrivals, and this repo produces those continuously -- release-please,
    CI auto-issues, and the drain itself may open them. Counting arrivals as
    foreign exited with "check `repo` in policy.json" on a fully drained ledger
    with six new issues: a cause the code had not established, fired on the
    state the whole run exists to reach."""
    led = _led(tmp_path, n=40)
    for n in range(1000, 1040):
        led.record_receipt(n, "ci-green", "green at sha")
        led.transition(n, CLOSED)
    tick.guard_refresh(led, _live(range(5000, 5006)))  # fully drained, 6 brand-new

    led2 = _led(tmp_path, n=40)
    for n in range(1000, 1036):
        led2.record_receipt(n, "ci-green", "green at sha")
        led2.transition(n, CLOSED)
    tick.guard_refresh(led2, _live([*range(1036, 1040), *range(5000, 5005)]))


def test_negative_control_parked_items_do_not_trip_the_wrong_repo_guard(tmp_path):
    """THE guard defect: parking does NOT close an issue on GitHub, so a parked
    item is terminal here and open there. Measuring OVERLAP against the
    non-terminal set alone made every legal park lower the ratio -- 40 items
    with 25 parked scored 38% on a perfectly healthy live set, and the harness
    exited claiming the wrong repo. It fired on the drain's own definition of
    progress, in the back half of every run, and asserted a cause it had not
    established (deploy-integrity R7)."""
    led = _led(tmp_path, n=40)
    for n in range(1000, 1025):
        item = led.items[n]
        item.blocker, item.owner = "upstream", "operator"
        led.transition(n, PARKED, "blocked")
    assert len([i for i in led.items.values() if i.state == PARKED]) == 25
    tick.guard_refresh(led, _live(range(1000, 1040)))  # all 40 still open on GitHub


def test_negative_control_allow_shrink_does_not_disable_the_other_two_refusals(tmp_path):
    """The documented escape from a shrink warning used to skip the whole
    function, so reaching for it also turned off the wrong-repo and zero-issue
    refusals -- the two that prevent a mass departure."""
    led = _led(tmp_path)
    with pytest.raises(SystemExit, match="different population"):
        tick.guard_refresh(led, _live(range(500, 530)), allow_shrink=True)
    with pytest.raises(SystemExit, match="ZERO open issues"):
        tick.guard_refresh(led, [], allow_shrink=True)
    tick.guard_refresh(led, _live(range(1000, 1010)), allow_shrink=True)  # retention: suppressed


def test_the_guard_stays_quiet_on_a_small_ledger(tmp_path):
    """Under a handful of items the ratios are noise, not signal -- a guard that
    fires on the first cycle of a fresh queue would never let one start."""
    led = _led(tmp_path, n=3)
    tick.guard_refresh(led, [])


def test_negative_control_the_guard_still_watches_in_the_end_game(tmp_path):
    """The floor's OTHER side. Keyed to `believed_open`, the guard switched
    itself OFF once most items were terminal: 40 items, 31 parked, 9 left, and a
    900-issue wrong-repo read sailed through -- 900 foreign issues upserted as
    `ready` and the 9 real ones departed -- at exactly the moment the run was
    about to report drained. The floor is keyed to everything the ledger KNOWS."""
    led = _led(tmp_path, n=40)
    for n in range(1000, 1031):
        led.items[n].blocker, led.items[n].owner = "upstream", "operator"
        led.transition(n, PARKED, "blocked")
    assert len(led.remaining()) == 9
    with pytest.raises(SystemExit, match="different population"):
        tick.guard_refresh(led, _live(range(200, 1100)))


def test_negative_control_a_mostly_terminal_ledger_does_not_trip_on_a_small_live_set(tmp_path):
    """And the OVERLAP denominator's other side. With 40 known and 9 open, a
    healthy live set of those 9 must pass -- putting the ledger in the
    denominator instead of the live set scores 22% and bricks the run, the same
    defect as the numerator bug, mirrored."""
    led = _led(tmp_path, n=40)
    for n in range(1000, 1031):
        led.items[n].blocker, led.items[n].owner = "upstream", "operator"
        led.transition(n, PARKED, "blocked")
    tick.guard_refresh(led, _live(range(1031, 1040)))


# ---------------------------------------------------------------------------
# Departure: needs-audit, never a fabricated receipt
# ---------------------------------------------------------------------------


def test_negative_control_a_departed_issue_is_audited_not_closed(tmp_path):
    """It left GitHub and this code does not know why, so it does not get to
    say. `needs-audit` is non-terminal: the item stays in the queue until
    something names what closed it."""
    led = _led(tmp_path)
    added, departed = tick.refresh_from_github(led, {}, _live(range(1000, 1019)))
    assert (added, departed) == (0, 1)
    gone = led.items[1019]
    assert gone.state == NEEDS_AUDIT
    assert gone.receipt_kind is None
    assert gone in led.remaining()
    assert not led.drained()


def test_negative_control_a_departure_never_becomes_a_receipt(tmp_path):
    """Even after the audit state, closing still needs a real receipt of the
    right kind. Inventing one to get past the receipt gate is the gate defeating
    itself."""
    led = _led(tmp_path)
    tick.refresh_from_github(led, {}, _live(range(1000, 1019)))
    with pytest.raises(ValueError, match="without a receipt"):
        led.transition(1019, CLOSED)


def test_negative_control_an_item_in_any_non_terminal_state_is_audited_on_departure(tmp_path):
    """The departure loop narrowed to `item.state == READY` survives every
    fixture whose vanishing item happened to be ready -- and then an in-flight
    or in-review item that disappears is never audited at all, so a lane's work
    vanishes with it and `drained()` can still go true."""
    from ledger import AWAITING_RECEIPT, IN_REVIEW

    for state in (READY, IN_FLIGHT, IN_REVIEW, AWAITING_RECEIPT):
        led = _led(tmp_path)
        if state != READY:
            led.transition(1019, state, "in progress")
        _, departed = tick.refresh_from_github(led, {}, _live(range(1000, 1019)))
        assert departed == 1, f"a departing {state} item must be audited"
        assert led.items[1019].state == NEEDS_AUDIT


def test_a_new_issue_is_added_with_its_labels(tmp_path):
    led = _led(tmp_path)
    live = [
        *_live(range(1000, 1020)),
        {"number": 2001, "title": "new one",
         "labels": [{"name": "lane:console"}, {"name": "sp:5"}]},
    ]
    added, departed = tick.refresh_from_github(led, {2001: "W5-console"}, live)
    assert (added, departed) == (1, 0)
    assert led.items[2001].lane == "lane:console"
    assert led.items[2001].size == 5
    assert led.items[2001].stream == "W5-console"


def test_negative_control_the_stream_is_derived_without_the_pin_file(tmp_path):
    """`inventory.json` is gitignored, and the stream map was read ONLY from it.
    On a clean checkout that map was empty and every issue filed into `W9-rest`
    -- with no error, because "no pins" and "no file" look identical -- which
    collapses the W0 -> W1 -> ... ordering the PRP calls load-bearing."""
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    live = [
        {"number": 4468, "title": "the merge gate is gitignored",
         "labels": [{"name": "lane:ci"}, {"name": "sp:3"}]},
        {"number": 9001, "title": "a console editor",
         "labels": [{"name": "lane:console"}, {"name": "sp:5"}]},
        {"number": 9002, "title": "bicep drift",
         "labels": [{"name": "lane:bicep"}, {"name": "bicep-drift"}, {"name": "sp:3"}]},
    ]
    tick.refresh_from_github(led, {}, live)  # NO pin map at all
    assert led.items[4468].stream == "W0-harness"
    assert led.items[9001].stream == "W5-console"
    assert led.items[9002].stream == "W1-deploy"
    assert [i.stream for i in led.items.values()].count("W9-rest") == 0


def test_a_populated_inventory_cache_shadows_stream_for_entirely(tmp_path):
    """`tick.py` is `streams.get(number) or stream_for(...)`, so for any number
    IN `inventory.json` the classifier is NEVER CALLED. That makes #4694's
    precedence fix INERT on the live path for every cached item, and nothing
    tested it: the tests added with that fix all call `stream_for` directly, so
    a fully green suite says nothing about what a refresh does. This is the
    only test in the file that reaches the shadowing.

    Measured on the operator's box on 2026-09-24: `tools/drain/inventory.json`
    exists (gitignored, 297 entries, highest issue #4473, written 2026-09-11)
    and pins #3965, #4242 and #4408 -- the exact three items the precedence
    fix was written to move -- to `W4-receipts`. The fix only appears to work
    there because the items newly pinned in #4695 postdate the cache.

    WHAT MAKES THIS FAIL: changing `streams.get(number) or stream_for(...)` so
    the classifier wins (then the first block reads `W7-bicep`/`deploy-path`),
    or dropping the cache read entirely.

    The second block is the POSITIVE PAIR. Without it this test is satisfied by
    a `stream_for` that returns "W4-receipts" for everything, and it would also
    survive deleting the precedence fix outright -- an absence-only assertion
    (`assertion-design.md` "done" #4).

    This test DESCRIBES the shadowing; it does not endorse it. Dropping or
    regenerating the cache is a deliberate act with a blast radius far wider
    than #4695: the independent consequence review of that PR measured eleven
    further items whose CLASS changes on a no-cache refresh, independently of
    the precedence fix -- their figure, not re-derived here. Tracked separately.
    """
    # #3965's live shape: a `lane:bicep` item whose title contains "receipt".
    issue = {
        "number": 3965,
        "title": (
            "bicep-sync: cost-export.bicep is allowlisted, not wired — routing "
            "decision + Gov receipt owed by the admin-plane/main.bicep lane"
        ),
        "labels": [{"name": "lane:bicep"}, {"name": "sp:5"}],
    }

    cached = Ledger(str(tmp_path / "cached.json"), receipts=POLICY["receipts"])
    tick.refresh_from_github(cached, {3965: "W4-receipts"}, [issue])
    assert cached.items[3965].stream == "W4-receipts"
    assert cached.items[3965].effective_receipt_class == "estate-behaviour", (
        "the cached item must be the UNCLOSABLE class, or this test is not "
        "measuring the harm the shadowing causes"
    )

    uncached = Ledger(str(tmp_path / "uncached.json"), receipts=POLICY["receipts"])
    tick.refresh_from_github(uncached, {}, [issue])
    assert uncached.items[3965].stream == "W7-bicep", (
        "with no cache entry the precedence fix must route this by its lane "
        "label -- if it does not, the first block proves nothing about the CACHE"
    )
    assert uncached.items[3965].effective_receipt_class == "deploy-path"


# ---------------------------------------------------------------------------
# Reaping -- "a dead session costs at most the cycle in flight"
# ---------------------------------------------------------------------------


def test_negative_control_a_stranded_lane_is_recoverable(tmp_path):
    """Nothing moved an in-flight item back, so a killed session removed up to
    `max_lanes` items from scheduling permanently -- the opposite of the
    property the whole design claims."""
    led = _led(tmp_path)
    led.transition(1000, IN_FLIGHT, "selected in cycle 1")
    assert led.items[1000].state == IN_FLIGHT
    assert tick.select_cycle(led, POLICY), "the lane is stranded, not the whole stream"
    assert tick.reap_stranded(led, 2) == 1
    assert led.items[1000].state == READY


def test_negative_control_the_reaper_never_touches_a_terminal_item(tmp_path):
    """A reaper widened to "anything that is not ready" yanks closed and parked
    items back into the queue -- undoing every receipt the run has earned."""
    led = _led(tmp_path)
    led.record_receipt(1001, "ci-green", "green at sha")
    led.transition(1001, CLOSED)
    led.items[1002].blocker, led.items[1002].owner = "upstream", "operator"
    led.transition(1002, PARKED)
    led.transition(1003, NEEDS_AUDIT, "gone")
    led.transition(1000, IN_FLIGHT, "selected")
    assert tick.reap_stranded(led, 2) == 1
    assert led.items[1001].state == CLOSED
    assert led.items[1002].state == PARKED
    assert led.items[1003].state == NEEDS_AUDIT


def test_negative_control_a_transient_departure_returns_to_the_queue(tmp_path):
    """`needs-audit` was one-way: a flaky read departed items and no later
    refresh, no CLI and no lane could bring them back. The retention floor
    allows a 19% drop per cycle, so a flaky read could strand ~56 of 297."""
    led = _led(tmp_path)
    tick.refresh_from_github(led, {}, _live(range(1000, 1019)))
    assert led.items[1019].state == NEEDS_AUDIT
    assert led.items[1019].audit_reason == AUDIT_DEPARTED
    tick.refresh_from_github(led, {}, _live(range(1000, 1020)))  # it is back
    assert led.items[1019].state == READY
    assert led.items[1019].audit_reason is None


def test_a_reopened_terminal_item_stays_flagged(tmp_path):
    """The OTHER side of that boundary. A terminal item seen open again was
    REOPENED -- someone is disputing the close -- so it must not be swept back
    to `ready` by the same code path that rescues a transient departure."""
    led = _led(tmp_path)
    led.record_receipt(1000, "ci-green", "green")
    led.transition(1000, CLOSED)
    tick.refresh_from_github(led, {}, _live(range(1000, 1020)))
    assert led.items[1000].state == NEEDS_AUDIT
    tick.refresh_from_github(led, {}, _live(range(1000, 1020)))
    assert led.items[1000].state == NEEDS_AUDIT, "a disputed close is not self-clearing"


def test_a_park_survives_both_refresh_paths(tmp_path):
    """#4535, driven through the PRODUCTION refresh rather than `upsert` alone.

    Both cells of the parked row, in one test, because they are decided by two
    DIFFERENT expressions and a fix to either could break the other:

      - issue still OPEN -> `upsert`'s reopen branch, now keyed on
        `REOPEN_DISPUTES`. WHAT MAKES THIS FAIL: put `PARKED` back in that tuple
        (i.e. revert it to `TERMINAL`) and the first assertion reads
        `needs-audit`. That is the live defect -- #2874 lasted 13 seconds.
      - issue no longer in the live set -> the departure loop, still keyed on
        `TERMINAL`. WHAT MAKES THIS FAIL: narrow that test to `REOPEN_DISPUTES`
        and the parked item departs to `needs-audit` with reason `departed`.

    `drained()` is asserted at the end because it is what the two cells are FOR:
    it is `tick.py`'s documented stop signal, and with the demotion in place no
    ledger holding a park could ever reach it."""
    led = _led(tmp_path)
    led.items[1000].blocker = "no GCC tenant to authenticate against"
    led.items[1000].owner = "operator"
    led.transition(1000, PARKED, "re-measured at head: run 35171642605")

    # Cell 1: the issue is open on GitHub, which is where a park BELONGS.
    tick.refresh_from_github(led, {}, _live(range(1000, 1020)))
    assert led.items[1000].state == PARKED
    assert led.items[1000].audit_reason is None

    # Cell 2: the issue has left the live set. Unchanged behaviour, pinned so a
    # future edit to the departure loop cannot silently take it away.
    _, departed = tick.refresh_from_github(led, {}, _live(range(1001, 1020)))
    assert led.items[1000].state == PARKED
    assert departed == 0

    # The exit condition, over a ledger whose every remaining item is terminal.
    for n in range(1001, 1020):
        led.items[n].blocker, led.items[n].owner = "upstream", "operator"
        led.transition(n, PARKED, "blocked")
    tick.refresh_from_github(led, {}, _live(range(1000, 1020)))
    assert led.drained() is True, (
        "every item parked and every issue open is the shape a fully blocked "
        "backlog takes; the run must be able to STOP there"
    )


# ---------------------------------------------------------------------------
# WIRING -- a guard main() does not call is a guard that does not run
# ---------------------------------------------------------------------------


def _main_over(monkeypatch, tmp_path, live, argv):
    """Drive `tick.main()` end to end with the network stubbed out."""
    seed = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    for i in range(20):
        seed.upsert(1000 + i, f"issue {1000 + i}", "W6-ci", lane="lane:ci", size=1)
    seed.save()
    monkeypatch.setattr(tick, "STATE_PATH", str(tmp_path / "state.json"))
    monkeypatch.setattr(tick, "read_live_issues", lambda _repo: live)
    monkeypatch.setattr(sys, "argv", ["tick.py", *argv])
    return tick.main()


def test_blocker_the_cycle_guards_its_save_when_state_json_was_absent(monkeypatch, tmp_path):
    """DRIVES `main()`, rather than transcribing its expression.

    The first version of this test copied `if_unchanged=led.loaded_from_disk`
    into the test body, so it agreed with its own copy and could not notice that
    the expression was wrong. A reviewer reproduced the loss end to end through
    `main()` instead: `loaded_from_disk` is False for TWO reasons -- `--bootstrap`
    AND the file simply not existing -- so an ordinary cycle over an absent
    `state.json` saved with no guard, and a concurrent lane's closed, receipted
    item vanished from the document entirely.

    Here the ledger file is DELETED after seeding, so `load()` returns early and
    `loaded_from_disk` is False on a non-bootstrap run. A competing writer then
    creates the file under the cycle. The save must REFUSE.
    """
    seed = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    for i in range(20):
        seed.upsert(1000 + i, f"issue {1000 + i}", "W6-ci", lane="lane:ci", size=1)
    seed.save()
    state = str(tmp_path / "state.json")

    real_load = Ledger.load

    def load_then_let_a_lane_write(self):
        result = real_load(self)          # reads nothing; the file is gone
        rival = Ledger(state, receipts=POLICY["receipts"])
        rival.upsert(990002, "a lane's item", "W6-ci", lane="lane:ci", size=1)
        rival.record_receipt(990002, "ci-green", "green at sha")
        rival.transition(990002, CLOSED, "the lane closed it")
        rival.save()
        return result

    os.remove(state)
    monkeypatch.setattr(Ledger, "load", load_then_let_a_lane_write)
    monkeypatch.setattr(tick, "STATE_PATH", state)
    monkeypatch.setattr(tick, "read_live_issues", lambda _repo: _live(range(1000, 1020)))
    monkeypatch.setattr(sys, "argv", ["tick.py"])

    assert tick.main() == 1, "the cycle saved over a concurrent lane's close"
    final = Ledger(state, receipts=POLICY["receipts"]).load()
    assert final.items[990002].state == CLOSED
    assert final.items[990002].receipt_kind == "ci-green"


def test_blocker_the_record_path_guards_its_save_too(monkeypatch, tmp_path):
    """The other call site. RW13 pins the CYCLE's guarded save; nothing pinned
    the RECORD path's, so `led.save(if_unchanged=True)` -> `led.save()` survived
    the suite with the comparison inside `Ledger.save` perfectly intact.

    Drives `main()` on `--record-receipt` and lets a rival writer land between
    the load and the save. The command must refuse rather than discard it.
    """
    seed = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    seed.upsert(900, "a guard", "W6-ci", lane="lane:ci", size=1)
    seed.upsert(901, "another", "W6-ci", lane="lane:ci", size=1)
    seed.save()
    state = str(tmp_path / "state.json")

    def record_then_a_rival_writes(led, _policy, _repo, number, **_kwargs):
        led.items[number].receipt_kind = "ci-green"
        led.items[number].receipt_ref = "sha"
        led.items[number].receipt_taken_under = "guard-or-test-only"
        led.transition(number, CLOSED, "recorded")
        rival = Ledger(state, receipts=POLICY["receipts"]).load()
        rival.record_receipt(901, "ci-green", "green at sha")
        rival.transition(901, CLOSED, "the rival closed it")
        rival.save()
        return tick.Recorded(summary="recorded", close_note="#900 closed on GitHub")

    monkeypatch.setattr(tick, "record_receipt_from_evidence", record_then_a_rival_writes)
    monkeypatch.setattr(tick, "STATE_PATH", state)
    monkeypatch.setattr(sys, "argv", ["tick.py", "--record-receipt", "900", "--from-pr", "1"])

    assert tick.main() == 1, "the record path saved over a rival's close"
    final = Ledger(state, receipts=POLICY["receipts"]).load()
    assert final.items[901].state == CLOSED, "the rival's verified close was discarded"


def test_positive_control_a_guarded_save_over_an_absent_ledger_succeeds(tmp_path):
    """The fresh-clone path, and the control that stops the missing-file case
    being guarded into uselessness.

    `_on_disk_digest` returns None for a missing file and `load()` leaves
    `loaded_digest` None, so the comparison passes when nothing is there. A
    constant sentinel instead of None would make this legitimate FIRST WRITE
    refuse -- which is arm RW16, and which survived until this test existed.
    """
    state = str(tmp_path / "nothing-here.json")
    led = Ledger(state, receipts=POLICY["receipts"]).load()
    assert led.loaded_from_disk is False
    led.upsert(910, "first ever item", "W6-ci", lane="lane:ci", size=1)
    led.save(if_unchanged=True)
    assert 910 in Ledger(state, receipts=POLICY["receipts"]).load().items


def test_a_rival_creating_the_ledger_first_is_still_refused(tmp_path):
    """The other half: absent at load is not a licence to clobber. If a rival
    CREATES the file while this transaction held 'absent', the guard must still
    refuse -- otherwise two fresh clones racing both write and one wins
    silently."""
    state = str(tmp_path / "race.json")
    mine = Ledger(state, receipts=POLICY["receipts"]).load()
    mine.upsert(911, "mine", "W6-ci", lane="lane:ci", size=1)

    rival = Ledger(state, receipts=POLICY["receipts"])
    rival.upsert(912, "rival", "W6-ci", lane="lane:ci", size=1)
    rival.save()

    with pytest.raises(led_changed_error()):
        mine.save(if_unchanged=True)
    assert 912 in Ledger(state, receipts=POLICY["receipts"]).load().items


def led_changed_error():
    import ledger as _l

    return _l.LedgerChangedError


def test_bootstrap_still_reseeds_over_an_existing_ledger(monkeypatch, tmp_path):
    """THE OTHER HALF of `if_unchanged=not args.bootstrap`, and the half that was
    unarmed: `if_unchanged=True` survived the suite, and a reviewer measured the
    consequence by driving `main()` under that mutation -- `tick.py --bootstrap`
    over an EXISTING ledger returns rc=1 and refuses to reseed.

    It fails closed, so it is not a silent loss; it is the one operation whose
    whole purpose is to replace what is there, refusing to do so. `--bootstrap`
    is how a wiped or wrong-repo ledger gets recovered, which makes "cannot
    reseed" a bad state to be one token away from.

    DRIVES `main()` rather than transcribing its expression -- the transcription
    is what let the wrong expression stay green for a whole round.
    """
    rc = _main_over(monkeypatch, tmp_path, _live(range(1000, 1020)), ["--bootstrap"])
    assert rc == 0, "--bootstrap refused to reseed over an existing ledger"
    assert os.path.exists(str(tmp_path / "state.json") + ".bak"), "no prior-ledger backup"
    assert len(Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"]).load().items) == 20


def test_negative_control_main_actually_calls_the_refresh_guard(monkeypatch, tmp_path):
    """The unit tests above prove `guard_refresh` refuses the right inputs. They
    say nothing about whether anything CALLS it -- which is precisely the shape
    of the defect this whole harness exists to end: a control that is tested,
    correct, and unreachable."""
    with pytest.raises(SystemExit, match="different population"):
        _main_over(monkeypatch, tmp_path, _live(range(500, 530)), [])


def test_negative_control_allow_shrink_does_not_disable_the_guard_in_main(monkeypatch, tmp_path):
    """`--allow-shrink` used to skip the CALL, not a clause, so the documented
    escape from a shrink warning also turned off the wrong-repo refusal."""
    with pytest.raises(SystemExit, match="different population"):
        _main_over(monkeypatch, tmp_path, _live(range(500, 530)), ["--allow-shrink"])


def test_a_healthy_cycle_runs_through_main(monkeypatch, tmp_path):
    """The control. Without it every SystemExit above could come from anywhere."""
    assert _main_over(monkeypatch, tmp_path, _live(range(1000, 1020)), []) == 0


# ---------------------------------------------------------------------------
# Selection
# ---------------------------------------------------------------------------


def test_two_items_on_one_lane_never_run_together(tmp_path):
    """Lanes partition by FILE. A shared-file conflict must serialize."""
    led = _led(tmp_path)
    chosen = tick.select_cycle(led, POLICY)
    assert len(chosen) == 1
    assert len({i.lane for i in chosen}) == 1


def test_negative_control_an_unlaned_item_is_never_scheduled(tmp_path):
    """An item whose file footprint is unknown is unsafe to run alongside
    anything."""
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    led.upsert(1, "unlaned", "W6-ci", lane=None, size=3)
    led.upsert(2, "unsized", "W6-ci", lane="lane:ci", size=None)
    assert tick.select_cycle(led, POLICY) == []
    assert len(tick.triage_queue(led)) == 2


def test_the_wip_cap_is_a_policy_input(tmp_path):
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    for i, lane in enumerate(["lane:ci", "lane:console", "lane:bicep", "lane:dataplane"]):
        led.upsert(100 + i, "x", "W6-ci", lane=lane, size=1)
    policy = {**POLICY, "wip": {**POLICY["wip"], "max_lanes": 2}}
    assert len(tick.select_cycle(led, policy)) == 2


# ---------------------------------------------------------------------------
# The brief -- the ONLY thing a lane agent reads
# ---------------------------------------------------------------------------


def test_a_console_brief_demands_a_browser_receipt(tmp_path):
    led = _led(tmp_path)
    item = led.upsert(9, "an editor", "W5-console", lane="lane:console", size=5)
    assert "g1-browser" in tick.write_brief(item, POLICY)


def test_negative_control_a_deploy_brief_does_not_say_ci_green(tmp_path):
    """R1's stream. Keyed off the lane, `deploy-run` was unreachable and every
    deploy-path brief said `ci-green` -- `report-a-merge-as-a-fix`, emitted by
    the control that exists to prevent it."""
    led = _led(tmp_path)
    item = led.upsert(9, "a deploy lane", "W1-deploy", lane="lane:bicep", size=5)
    brief = tick.write_brief(item, POLICY)
    assert "deploy-run" in brief
    assert "ci-green" not in brief


def test_negative_control_an_estate_item_demands_an_estate_receipt(tmp_path):
    led = _led(tmp_path)
    item = led.upsert(9, "owed receipt", "W4-receipts", lane="lane:ci", size=2)
    brief = tick.write_brief(item, POLICY)
    assert "`estate`" in brief
    assert "ci-green" not in brief


def test_the_brief_states_the_review_requirement(tmp_path):
    """The lane is TOLD how many reviewers it needs, not left to infer it."""
    led = _led(tmp_path)
    console = led.upsert(9, "an editor", "W5-console", lane="lane:console", size=5)
    assert "2 reviewer(s)" in tick.write_brief(console, POLICY)
    ordinary = led.upsert(10, "a dbt model", "W8-dataplane", lane="lane:dataplane", size=3)
    assert "1 reviewer(s)" in tick.write_brief(ordinary, POLICY)


def test_negative_control_an_unlaned_item_escalates_rather_than_defaulting(tmp_path):
    """28 of 299 live items carry NO lane, so the brief passed `[""]`, matched
    nothing and asked for ONE reviewer -- including all four W0-harness items
    (every one a `tools/drain` diff by construction) and nine W1-deploy ones.
    Precisely the diffs the policy says need two. An unknown footprint is now
    the closed direction, like every sibling control in this module."""
    led = _led(tmp_path)
    for stream in ("W0-harness", "W1-deploy", "W2-security", "W9-rest"):
        item = led.upsert(900 + hash(stream) % 90, "x", stream, lane=None, size=3)
        brief = tick.write_brief(item, POLICY)
        assert "2 reviewer(s)" in brief, f"{stream} unlaned: {brief[:400]}"


def test_negative_control_every_lane_gets_the_count_its_stream_deserves(tmp_path):
    """Two arms that deleted the bicep and ci rows from LANE_PATHS both SURVIVED
    a full suite: 31 and 33 laned items would silently drop to one reviewer over
    a green matrix. Each lane is pinned individually."""
    led = _led(tmp_path)
    cases = [("lane:console", "W9-rest", 2), ("lane:bicep", "W9-rest", 2),
             ("lane:ci", "W9-rest", 2), ("lane:dataplane", "W9-rest", 1),
             ("lane:docs", "W9-rest", 1), ("lane:dataplane", "W1-deploy", 2)]
    for i, (lane, stream, expected) in enumerate(cases):
        item = led.upsert(800 + i, "x", stream, lane=lane, size=1)
        assert f"{expected} reviewer(s)" in tick.write_brief(item, POLICY), (
            f"{lane} in {stream} should be {expected}"
        )


def test_the_brief_says_a_returned_verdict_is_not_a_posted_one(tmp_path):
    """The gate reads PR COMMENTS. On 2026-09-12 the harness's own merge was
    NO-GO because two approvals had been returned to the coordinator and never
    posted -- the gate was right and the lane had to be told."""
    led = _led(tmp_path)
    item = led.upsert(9, "x", "W6-ci", lane="lane:ci", size=1)
    assert "not a verdict POSTED" in tick.write_brief(item, POLICY)


def test_the_brief_names_the_gate_as_a_command(tmp_path):
    """A gate restated as prose is an agent's judgement. The brief must name the
    program, or `gates.py` has no production caller at run time either."""
    led = _led(tmp_path)
    item = led.upsert(9, "x", "W6-ci", lane="lane:ci", size=1)
    assert "python tools/drain/merge_gate.py" in tick.write_brief(item, POLICY)


def test_negative_control_the_brief_does_not_leak_the_documentation_key(tmp_path):
    led = _led(tmp_path)
    item = led.upsert(9, "x", "W6-ci", lane="lane:ci", size=1)
    brief = tick.write_brief(item, POLICY)
    assert "Stop and ask for: _," not in brief
    assert "add_trivyignore_entry" in brief
    assert "commit-a-secret" in brief  # the `never` list is surfaced at all


# -- THE RECEIPT WRITE PATH --------------------------------------------------
#
# README recorded this as the gap for as long as the ledger has existed:
# `record_receipt` had no production caller, so every close was a hand edit to
# an untracked file and "the write path is outside the instrumented code".
# These tests are the instrument.
#
# Every refusal below names the value that would make it pass, per
# `.claude/rules/assertion-design.md`, and the POSITIVE CONTROL comes first --
# a suite of refusals proves nothing if the happy path never reaches the check,
# because then every one of them refuses for free.


def _g1_run(*, workflow="loom-ui-verify", conclusion="success", status="completed",
            step_name="Capture browser-E2E receipt (optional)", step_conclusion="success"):
    """A `loom-ui-verify` run shaped like the real `gh run view --json` output."""
    steps = [{"name": "Smoke verify", "conclusion": "success"}]
    if step_name is not None:
        steps.append({"name": step_name, "conclusion": step_conclusion})
    return {
        "databaseId": 123, "workflowName": workflow, "status": status,
        "conclusion": conclusion, "url": "https://example.invalid/runs/123",
        "jobs": [{"name": "verify", "steps": steps}],
    }


def test_positive_control_a_well_formed_g1_run_establishes_the_receipt():
    """THE CONTROL THAT MAKES THE REFUSALS BELOW MEAN ANYTHING.

    Every other test here asserts a refusal, and a fixture that never reaches
    the checks refuses for free. This one pins that the same shape, unmodified,
    is ACCEPTED -- so when a test below flips to refused, the single field it
    changed is the reason.
    """
    ref = tick.verify_run_backed_receipt("g1-browser", _g1_run(), POLICY)
    assert ref == "https://example.invalid/runs/123"


def test_an_undeclared_receipt_kind_cannot_be_recorded_from_a_run():
    """`operator` is absent from `receipt_producers` ON PURPOSE: a human-only
    receipt a program can record is not human-only. Fails closed on ANY kind the
    authority does not declare, so widening the write path is an edit to
    policy.json rather than an emergent behaviour.

    Would pass if `receipt_producers` grew an `operator` entry -- which is the
    edit this test exists to make someone justify.
    """
    with pytest.raises(tick.ReceiptRefusedError, match="no declared producer"):
        tick.verify_run_backed_receipt("operator", _g1_run(), POLICY)


def test_a_green_run_of_the_wrong_workflow_is_refused():
    """The producer is matched on the run's own `workflowName`. A green run of
    some other workflow is a fact about that workflow.

    Would pass if the workflow were `loom-ui-verify`; it is the ONLY field this
    fixture changes from the positive control.
    """
    with pytest.raises(tick.ReceiptRefusedError, match="different workflow"):
        tick.verify_run_backed_receipt(
            "g1-browser", _g1_run(workflow="loom-synthetic-monitor"), POLICY)


def test_an_unfinished_run_is_refused_as_unfinished_not_as_failed():
    """`status` is checked separately from `conclusion`, and this fixture is what
    makes that check load-bearing rather than decorative.

    THE FIXTURE IS THE POINT. With `conclusion=None` the conclusion check
    refuses the same input, so deleting the status check changes only the
    MESSAGE -- a reviewer showed the arm for it was a weak mutant for exactly
    that reason. GitHub can report a `conclusion` from a previous attempt while
    `status` is `in_progress` (a re-run in flight), and on THAT input the status
    check is the only thing standing between an unfinished run and a receipt.

    Would pass -- and does, with the check removed -- if status were ignored.
    """
    with pytest.raises(tick.ReceiptRefusedError, match="has not finished"):
        tick.verify_run_backed_receipt(
            "g1-browser", _g1_run(status="in_progress", conclusion="success"), POLICY)


def test_a_failed_run_is_refused():
    with pytest.raises(tick.ReceiptRefusedError, match="concluded 'failure'"):
        tick.verify_run_backed_receipt(
            "g1-browser", _g1_run(conclusion="failure"), POLICY)


def test_blocker_a_smoke_only_run_is_green_and_captured_nothing():
    """THE ONE THAT MATTERS, and the reason `receipt_required_steps` exists.

    `loom-ui-verify` skips its capture step when `target_route` is blank, so a
    smoke-only run CONCLUDES SUCCESS having produced no screenshot, no trace and
    no receipt -- exactly the vacuous case `receipts.g1_assertion_rule` excludes.

    THE FIXTURE SHAPE IS THE FINDING HERE. The first version modelled the skip
    as the step being ABSENT from the JSON; a reviewer checked real run
    33389868059 and it is PRESENT with `conclusion: "skipped"`. So the branch
    that version pinned was unreachable from real API output -- a test that
    could not fail on the input it named. Measured and corrected.

    Would pass if the step concluded success; that is the positive control.
    """
    with pytest.raises(tick.ReceiptRefusedError, match="not success"):
        tick.verify_run_backed_receipt(
            "g1-browser", _g1_run(step_conclusion="skipped"), POLICY)


def test_a_required_step_absent_entirely_is_refused():
    """The OTHER real shape, and it is the deploy-run one: a SKIPPED JOB reports
    no steps at all, so the step is genuinely absent rather than present-and-
    skipped. Measured on 34575500655. Both shapes must refuse, and they take
    different branches, so both are pinned."""
    with pytest.raises(tick.ReceiptRefusedError, match="never ran the step"):
        tick.verify_run_backed_receipt("g1-browser", _g1_run(step_name=None), POLICY)


def _roll_run(*, job_conclusion="success", steps=True):
    """A `loom-roll-and-validate` run. `steps=False` is the REAL vacuous shape:
    a successful run whose roll job is SKIPPED with zero steps -- measured on
    34575500655 and 34573457723, 2 of the last 25 successful runs."""
    job = {"name": "Roll image + validate live URL", "conclusion": job_conclusion}
    job["steps"] = [
        {"name": "Roll Container App to new image", "conclusion": "success"},
        {"name": "Validate live URL", "conclusion": "success"},
    ] if steps else []
    return {
        "databaseId": 34575500655, "workflowName": "loom-roll-and-validate",
        "status": "completed", "conclusion": "success",
        "url": "https://example.invalid/runs/345", "headSha": "abc123def456",
        "jobs": [job],
    }


def test_blocker_a_green_roll_whose_job_was_skipped_is_green_over_nothing():
    """MEASURED ON REAL HISTORY, and the defect an independent reviewer found:
    the first version of this feature wired `receipt_required_steps` to
    `g1-browser` alone and left `deploy-run` run-level, so it closed the defect
    at its LABEL and left it open at its other SITES.

    2 of the last 25 successful `loom-roll-and-validate` runs carry
    `Roll image + validate live URL` = skipped with steps=0 (34575500655,
    34573457723). Nothing rolled, nothing validated -- and `cloud-parity.md`
    names this shape in terms: "a green run whose deploy job was skipped at 0
    steps is not [a receipt]".

    A skipped JOB reports no steps at all, so requiring a step INSIDE it is what
    catches this. Would pass with `steps=True`, which is the positive control
    immediately below.
    """
    with pytest.raises(tick.ReceiptRefusedError, match="never ran the step"):
        tick.verify_run_backed_receipt(
            "deploy-run", _roll_run(job_conclusion="skipped", steps=False), POLICY)


def test_positive_control_a_real_roll_establishes_a_deploy_run_receipt():
    """The control for the test above: the SAME workflow, same run conclusion,
    differing only in whether the roll job actually ran its steps."""
    ref = tick.verify_run_backed_receipt("deploy-run", _roll_run(), POLICY)
    assert "345" in ref


def test_the_receipt_ref_names_the_commit_that_was_deployed():
    """`headSha` was fetched and never read, so a deploy-run receipt recorded the
    run without recording WHICH COMMIT it put live -- and 'which sha is live' is
    the question `deploy-integrity.md` R3 exists to answer."""
    ref = tick.verify_run_backed_receipt("deploy-run", _roll_run(), POLICY)
    assert "abc123def456" in ref


def test_all_required_steps_are_checked_not_merely_the_first():
    """`receipt_required_steps` holds a LIST and the contract is ALL of them.

    Nothing distinguished 2-of-2 from 1-of-2 before this: a reviewer showed
    `[:1]` and `[-1:]` both survive, because on observed history the two roll
    steps are always both green or both absent. This fixture separates them --
    the roll happened, the VALIDATION did not -- which is the shape a future
    `if:` on the validate step would produce, and exactly what the map exists
    to refuse.
    """
    run = _roll_run()
    for job in run["jobs"]:
        for step in job["steps"]:
            if step["name"] == "Validate live URL":
                step["conclusion"] = "skipped"
    with pytest.raises(tick.ReceiptRefusedError, match="Validate live URL"):
        tick.verify_run_backed_receipt("deploy-run", run, POLICY)


def test_a_kind_with_no_required_steps_is_refused_not_waved_through():
    """An empty requirement would mean 'any green run of this workflow will do',
    which is the run-level check this branch exists to replace. Fails closed so
    that adding a producer without naming its load-bearing steps cannot quietly
    re-open the vacuous-green hole."""
    thin = copy.deepcopy(POLICY)
    thin["receipt_required_steps"] = {"_": "x"}
    with pytest.raises(tick.ReceiptRefusedError, match="no required steps"):
        tick.verify_run_backed_receipt("g1-browser", _g1_run(), thin)


def test_every_run_backed_kind_declares_required_steps():
    """THE REGRESSION GUARD for the finding itself. The defect was not a missing
    check -- it was a check wired to one of three kinds. This asserts the map is
    total over the producers, so adding a fourth producer without its steps
    fails here rather than in production."""
    producers = {k for k in POLICY["receipt_producers"] if not k.startswith("_")}
    required = {k for k in POLICY["receipt_required_steps"] if not k.startswith("_")}
    assert producers == required, f"run-backed kinds without required steps: {producers - required}"


def test_the_capture_step_must_have_concluded_success_not_merely_appeared():
    """`e2e-receipt.mjs` exits 2 on UNREACHABLE and 3 on SESSION REJECTED, so a
    present-but-red step is a route that did not load or a session that bounced.
    Presence is not the property; conclusion is."""
    with pytest.raises(tick.ReceiptRefusedError, match="not success"):
        tick.verify_run_backed_receipt(
            "g1-browser", _g1_run(step_conclusion="failure"), POLICY)


# -- THE GITHUB CLOSE (#4545) ------------------------------------------------
#
# The ledger close never reached GitHub, so the next `refresh_from_github` saw a
# `closed` item open upstream, read the harness's OWN close as a reopen, demoted
# it to `needs-audit` and VOIDED the receipt. Measured on #4535, the first item
# the harness ever closed on its own evidence: it bounced on the very next
# cycle. `drained()` -- this program's exit condition -- was unreachable for
# anything the harness closed itself.
#
# Every test below fails against the code as it stood at 16b83e8ce9c, where
# `tools/drain/` contained no `gh issue close` at all: the spy records ZERO
# close calls and each assertion names that as the value that breaks it.


#: VERBATIM stderr from the REAL `gh 2.100.0`, captured 2026-09-18 by running
#: `gh issue close 4556 --repo fgarofalo56/csa-inabox` against an issue that was
#: already closed. Measured: rc=0, stdout EMPTY, state unchanged before and
#: after -- close.go :117-120 returns above BOTH the comment block (:148) and
#: the close itself (:164), so that command is a read in everything but name.
_REAL_GH_ALREADY_CLOSED_STDERR = (
    "! Issue fgarofalo56/csa-inabox#4556 (synthetic-monitor: journeys failing "
    "(Failed)) is already closed\n"
)


def _gh_already_closed_stderr(repo="o/r", number=1, title="t") -> str:
    """close.go v2.100.0 `:118` RENDERED, not a remembered sentence.

        fmt.Fprintf(opts.IO.ErrOut, "%s Issue %s#%d (%s) is already closed\\n", ...)

    Rendering it means the spy below emits a DIFFERENT line for every issue,
    exactly as `gh` does. The previous revision of this fixture held ONE
    captured string and handed it to every test -- and a measured mutant walked
    straight through that: a marker over-fitted to the captured line,
    `"(Failed)) is already closed"`, matched the single fixture and SURVIVED
    the suite, while in production it would match no other issue's stderr at
    all and every raced close would silently classify `unknown`. A probe
    anchored to one realisation of a format string tests the realisation.
    """
    return f"! Issue {repo}#{number} ({title}) is already closed\n"


def _gh_closed_stderr(repo="o/r", number=1, title="t") -> str:
    """close.go v2.100.0 `:169` RENDERED. The success half of the pair.

        fmt.Fprintf(opts.IO.ErrOut, "%s Closed issue %s#%d (%s)\\n", ...)

    NOT OBSERVED, and said so rather than implied: producing this line requires
    closing a live issue, which the already-closed capture above deliberately
    does not. The leading glyph is `cs.SuccessIconWithColor(cs.Red)` and is
    written here as an ASCII stand-in, which is safe only because the marker
    the closer keys on (`Closed issue `) does not include it -- if it ever did,
    this fixture would be agreeing with a transcription instead of with `gh`.
    """
    return f"v Closed issue {repo}#{number} ({title})\n"


#: The repository `gh` would have acted on, read from the argv the closer built.
#: `gh` prints `ghrepo.FullName(baseRepo)` in both sentences and resolves that
#: repo from `--repo` when it is pinned and FROM THE WORKING DIRECTORY when it
#: is not -- so an argv with no `--repo` must model a DIFFERENT repository, not
#: the one the caller meant. That is the whole content of arm GH22, and a spy
#: that answered the caller's repo either way would have made it unkillable.
_SPY_CWD_REPO = "cwd-org/cwd-repo"


def _argv_repo(args) -> str:
    return args[args.index("--repo") + 1] if "--repo" in args else _SPY_CWD_REPO


class _GhSpy:
    """Stub the `gh` SEAM (`tick.sh`), never the closer itself.

    The rc check, the JSON parse, the already-closed short-circuit and the
    read-back all stay in the path, so deleting any one of them is still
    visible -- the lesson from `_stub_ci_green`, where stubbing the binding
    CHECK left its call site deletable by a green suite.

    A command this spy does not recognise raises. A stub that answers
    everything cannot fail, and the harness must never reach a live `gh` from
    the suite: the numbers these tests use are real issue numbers in the real
    repository.
    """

    def __init__(self, *, state="OPEN", close_rc=0, close_err="", takes_effect=True,
                 on_close=None, raises=None, view_fails_after_close=False,
                 url_kind="issues", url_repo="", close_title="",
                 view_title_before=""):
        self.state = state
        self.states: dict[str, str] = {}
        self.close_rc = close_rc
        self.close_err = close_err
        self.takes_effect = takes_effect
        self.on_close = on_close
        self.raises = raises
        #: Which OBJECT `gh issue view` resolves the number to. `gh issue view`
        #: answers for pull requests too -- measured live on #4552, which came
        #: back `{"state":"OPEN","url":".../pull/4552"}` -- so the payload
        #: carries the url the real command returns and the closer's type guard
        #: is in the path rather than stubbed away.
        self.url_kind = url_kind
        #: Which REPOSITORY that url names, when it must differ from the one the
        #: argv asked about. Empty means "the one asked about", which is the
        #: ordinary world. A TRANSFERRED issue is the world where they differ:
        #: GitHub keeps the old number reachable and answers with the new
        #: repository's url.
        self.url_repo = url_repo
        #: The issue TITLE gh interpolates as the final `%s` of BOTH exit-0
        #: sentences. Operator-supplied data inside the string the classifier
        #: reads, so a test can make it carry gh's own words.
        self.close_title = close_title
        #: The title the PRE-CLOSE view answers, when it must differ from the
        #: one `gh` renders. Empty means "the same one", which is the ordinary
        #: world. They differ when the title is EDITED inside the close window
        #: -- the residual `_without_title_line_breaks` names, and the reason
        #: the read-back's title joins the neutralisation set as well as the
        #: pre-read's. Without this seam that second title is an unwitnessed
        #: construct: dropping it from the set survived the suite (arm GH37).
        self.view_title_before = view_title_before
        #: The 502 shape: the close LANDS and the verification read cannot be
        #: made. rc=0 from `gh issue close` plus an unreadable state.
        self.view_fails_after_close = view_fails_after_close
        self.calls: list[list[str]] = []
        self.view_titles: list[str | None] = []

    def __call__(self, args):
        self.calls.append(list(args))
        if self.raises is not None:
            raise self.raises
        if args[:3] == ["gh", "issue", "view"]:
            if self.view_fails_after_close and self.closed:
                return 1, "", "HTTP 502: Bad gateway"
            payload = {
                "state": self.states.get(args[3], self.state),
                # THE SAME TITLE THE CLOSE BRANCH RENDERS. A spy whose view
                # answered a different title from the one it interpolates into
                # stderr would make `_without_title_line_breaks` look like it
                # works while neutralising a string that is not there -- the
                # probe agreeing with itself instead of with `gh`. Both read it
                # from `self.close_title`, so a test that puts a line break in
                # the title puts it in BOTH places, exactly as GitHub does.
                "title": (
                    self.view_title_before
                    if self.view_title_before and not self.closed
                    else (self.close_title or f"issue {args[3]}")
                ),
                "url": (f"https://github.com/{self.url_repo or _argv_repo(args)}"
                        f"/{self.url_kind}/{args[3]}"),
            }
            # ANSWER ONLY WHAT WAS ASKED FOR, because that is what `gh` does --
            # `--json state,url` returns those two keys and nothing else. A spy
            # that hands back every field regardless of the argv makes DROPPING
            # a field from the argv invisible: the closer would still receive a
            # title it never requested, and the mutation that stops requesting
            # it would survive on a behaviour it never had. Same lesson as
            # `_stub_ci_green`, where stubbing the binding CHECK left its call
            # site deletable by a green suite.
            asked = args[args.index("--json") + 1].split(",") if "--json" in args else []
            answered = {k: v for k, v in payload.items() if k in asked}
            #: What this view ACTUALLY answered for `title`, so a test can
            #: establish its premise by observation rather than by repeating
            #: the spy's own configuration back at itself.
            self.view_titles.append(answered.get("title"))
            return 0, json.dumps(answered), ""
        if args[:3] == ["gh", "issue", "close"]:
            if self.on_close is not None:
                self.on_close()
            if self.close_rc != 0:
                return self.close_rc, "", self.close_err
            # EXIT-0 STDERR, MODELLED ON close.go RATHER THAN INVENTED -- and
            # the model is what makes the concurrent-closer race expressible at
            # all. `gh` re-fetches the issue (:112) and then takes ONE OF TWO
            # exits, both rc=0: the short-circuit at :117-120 when it finds the
            # issue already CLOSED, which prints "is already closed" and posts
            # NOTHING because it returns above the comment block at :148; or
            # the close at :164 followed by "Closed issue" at :169. Deriving
            # the branch from the state this spy holds AT CLOSE TIME means an
            # `on_close` that flips the state to CLOSED reproduces exactly the
            # world in which another writer won the race -- which the previous
            # spy, holding one fixed `state` for the whole call, could not
            # express, and which is why "verified by effect" went nine rounds
            # untested against the one scenario where effect and exit code
            # diverge.
            #
            # THE REPO IN THE LINE IS THE ONE THE ARGV NAMED, because gh prints
            # `ghrepo.FullName(baseRepo)` -- the repository it ACTED on. A spy
            # that printed a constant while the closer passed something else
            # would agree with itself and disagree with `gh`, and it is exactly
            # that field the classifier now reads positionally. The title is
            # `self.close_title` so a test can put gh's OWN SENTENCES inside the
            # operator-supplied field, which is the forgery the positional read
            # exists to refuse.
            title = self.close_title or f"issue {args[3]}"
            if self.states.get(args[3], self.state) == "CLOSED":
                return 0, "", self.close_err or _gh_already_closed_stderr(
                    repo=_argv_repo(args), number=args[3], title=title)
            if self.takes_effect:
                self.states[args[3]] = "CLOSED"
            return 0, "", self.close_err or _gh_closed_stderr(
                repo=_argv_repo(args), number=args[3], title=title)
        raise AssertionError(f"the closer ran an unexpected command: {args}")

    @property
    def closed(self) -> list[str]:
        """The issue NUMBERS a `gh issue close` was actually issued for."""
        return [c[3] for c in self.calls if c[:3] == ["gh", "issue", "close"]]

    @property
    def views(self) -> list[str]:
        """The issue NUMBERS a `gh issue view` was issued for.

        THE DISCRIMINATOR FOR ORDERING QUESTIONS THE CLOSE COUNT CANNOT SEE. A
        closer that runs against an ALREADY-CLOSED issue short-circuits, so it
        adds a `view` and no `close` -- which is exactly the mutant that moves
        the terminal refusal below the closer, and exactly why asserting on
        `closed` alone could not catch it.
        """
        return [c[3] for c in self.calls if c[:3] == ["gh", "issue", "view"]]

    def live(self, numbers, labels=("lane:console", "sp:1")) -> list[dict]:
        """The `gh issue list` payload FOR THIS FAKE GITHUB.

        DERIVED from the same state the closer writes, never transcribed. A
        transcribed live set is what made the first version of the end-to-end
        test below unable to fail: whether the item is still in the open set is
        the entire question, so writing the answer into the fixture tests the
        refresh's arithmetic instead of the close.
        """
        return [
            {"number": n, "title": f"issue {n}",
             "labels": [{"name": x} for x in labels]}
            for n in numbers
            if self.states.get(str(n), self.state) != "CLOSED"
        ]


def _gh(monkeypatch, **kwargs) -> _GhSpy:
    spy = _GhSpy(**kwargs)
    monkeypatch.setattr(tick, "sh", spy)
    return spy


def test_blocker_the_kind_comes_from_the_items_class_not_from_the_caller(tmp_path, monkeypatch):
    """A `--kind` flag would let a ui-surface item close on a ci-green receipt.

    This is the defect a reviewer reproduced by editing one line of
    `LANE_RECEIPT_CLASS`, and the R2 invariant does NOT catch it: R2 compares
    the class a receipt was TAKEN under against the class at the decision, so a
    caller who names the wrong kind up front is consistent with itself.

    Here a ui-surface item (kind `g1-browser`) is offered a green
    `loom-synthetic-monitor` run -- which is a perfectly valid producer for
    `estate`. It must still be refused, because this item's class does not ask
    for an estate receipt. Would pass if the kind tracked the evidence instead
    of the item.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    led.upsert(700, "a console surface", "W5-console", lane="lane:console", size=1)
    monkeypatch.setattr(
        tick, "_run_evidence",
        lambda *_: _g1_run(workflow="loom-synthetic-monitor"),
    )
    with pytest.raises(tick.ReceiptRefusedError, match="different workflow"):
        tick.record_receipt_from_evidence(
            led, POLICY, "fgarofalo56/csa-inabox", 700,
            from_pr=None, from_run="123",
        )


def test_a_refused_receipt_leaves_the_item_untouched(tmp_path, monkeypatch):
    """A refusal must not half-write. `record_receipt` sets three fields before
    `transition` can refuse, so the ordering is what keeps this true -- and
    `main()` returns without `save()` on this path."""
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(701, "a console surface", "W5-console", lane="lane:console", size=1)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run(conclusion="failure"))
    with pytest.raises(tick.ReceiptRefusedError):
        tick.record_receipt_from_evidence(
            led, POLICY, "o/r", 701, from_pr=None, from_run="123")
    assert item.state == READY
    assert item.receipt_kind is None
    assert item.receipt_ref is None


def test_a_verified_run_closes_the_item_and_stamps_the_class(tmp_path, monkeypatch):
    """The whole point: a verified receipt CLOSES the item, through
    `led.transition` so the R2 invariant runs, with `receipt_taken_under`
    stamped -- the field README warns a hand edit forgets.

    The `gh` seam is stubbed because the close path now WRITES to GitHub
    (#4545); the close itself is asserted by the tests below.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(702, "a console surface", "W5-console", lane="lane:console", size=1)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run())
    _gh(monkeypatch)
    out = tick.record_receipt_from_evidence(
        led, POLICY, "o/r", 702, from_pr=None, from_run="123")
    assert item.state == CLOSED
    assert item.receipt_kind == "g1-browser"
    assert item.receipt_taken_under == "ui-surface"
    assert "g1-browser" in out.summary


def test_an_already_terminal_item_is_not_re_receipted(tmp_path, monkeypatch):
    """Re-recording would rewrite a terminal item's evidence, so the second
    caller's run would silently replace the first one's.

    THE SECOND ASSERTION PINS THE ORDERING, and it is a CALL COUNT because the
    close count cannot see it. An independent reviewer moved
    `if item.state in TERMINAL: raise` to below the closer and all 80 tests in
    this file still passed: the closer runs, READS the already-closed issue,
    short-circuits, and issues no close -- so `spy.closed` is `["703"]` either
    way and the caption claimed something the assertion did not pin.

    The reads discriminate: **2 `gh issue view` at head** (one before the close,
    one reading back after it, both in the FIRST call -- the second call is
    refused before any `gh` runs) against **3 under that mutant**. 3 is the
    value that makes this fail.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    led.upsert(703, "a console surface", "W5-console", lane="lane:console", size=1)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run())
    spy = _gh(monkeypatch)
    tick.record_receipt_from_evidence(led, POLICY, "o/r", 703, from_pr=None, from_run="1")
    with pytest.raises(tick.ReceiptRefusedError, match="already closed"):
        tick.record_receipt_from_evidence(led, POLICY, "o/r", 703, from_pr=None, from_run="2")
    assert spy.closed == ["703"]
    assert spy.views == ["703", "703"], (
        f"the terminal refusal must come BEFORE the closer: {len(spy.views)} reads "
        "means the second call reached GitHub at all, which is the mutant that "
        "moves the refusal below the close"
    )


def test_a_ci_green_item_refuses_a_run_and_asks_for_the_pr(tmp_path):
    """ci-green is not run-backed -- it is re-measured from a MERGED PR. Offering
    a run must say so rather than falling through to the run-backed path, where
    `ci-green` has no declared producer and the message would be misleading."""
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    led.upsert(704, "a guard", "W6-ci", lane="lane:ci", size=1)
    with pytest.raises(tick.ReceiptRefusedError, match="--from-pr"):
        tick.record_receipt_from_evidence(
            led, POLICY, "o/r", 704, from_pr=None, from_run="123")


# -- THE ci-green DECIDE PATH ------------------------------------------------
#
# AN INDEPENDENT REVIEWER FOUND THIS WHOLE BRANCH UNTESTED, and the survivor was
# the worst one available: mutating `if not receipt.ok:` to `if False:` left the
# suite at 474 passed, meaning a NOT-GREEN receipt closed the item -- on the
# exact path the PR body offered as its end-to-end proof. Coverage agreed: the
# entire decide block was unexecuted by the suite.
#
# It went untested because it reaches the network twice. That is a reason to
# inject the two calls, not a reason to leave the branch unwatched.


class _FakeReceipt:
    def __init__(self, ok, summary="GREEN", reasons=()):
        self.ok, self.summary, self.reasons = ok, summary, tuple(reasons)


def _stub_ci_green(monkeypatch, *, ok, summary="GREEN (green-at-merge=15)", binds=True):
    """Inject the network calls the ci-green path makes.

    IT STUBS `gh_json_local`, NOT `_pr_references_item`. The first version
    stubbed the binding CHECK itself, so both ci-green tests ran with that
    control disarmed and deleting its CALL SITE survived the whole suite. A
    reviewer found it: the check was tested as a FUNCTION and never as a
    CONTROL. Stubbing the seam it reads through keeps the real check in the
    path, and `binds=False` drives it to refuse.
    """
    import merge_gate

    monkeypatch.setattr(
        tick, "gh_json_local",
        lambda *_a, **_k: {
            "body": "Refs #800 #801 #802 #804 #806 #807" if binds else "entirely unrelated work",
            "commits": [], "closingIssuesReferences": [],
        },
    )
    monkeypatch.setattr(
        merge_gate, "collect_ci_green_evidence",
        lambda *_: {
            "evidence": [], "merged_total_count": 1, "changed_files": [],
            "branch": "main", "merged": "deadbeefcafe", "head": "head",
            "trees_identical": True,
        },
    )
    monkeypatch.setattr(merge_gate, "resolve_infra_ere", lambda _sha: None)
    monkeypatch.setattr(
        gates, "ci_green_receipt",
        lambda *_a, **_k: _FakeReceipt(ok, summary, () if ok else ("vitest: RED at the merged sha",)),
    )


def test_blocker_the_binding_check_is_actually_called_on_the_record_path(tmp_path, monkeypatch):
    """THE CALL SITE, not the function. `test_blocker_a_pr_that_never_names_the_
    item_is_refused` calls `_pr_references_item` directly, so it passes whether
    or not anything invokes it -- and a reviewer showed deleting the call
    survived the suite at 486 passed.

    This drives the WHOLE record path with a PR body that names no item, so the
    only thing that can refuse is the call site being there. Would pass with
    `binds=True`, which is what every other ci-green test uses.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(805, "a guard", "W6-ci", lane="lane:ci", size=1)
    _stub_ci_green(monkeypatch, ok=True, binds=False)
    with pytest.raises(tick.ReceiptRefusedError, match="does not reference"):
        tick.record_receipt_from_evidence(
            led, POLICY, "o/r", 805, from_pr=4498, from_run=None)
    assert item.state == READY


def test_blocker_a_not_green_ci_green_receipt_does_not_close_the_item(tmp_path, monkeypatch):
    """THE SURVIVOR. `if not receipt.ok:` -> `if False:` left the suite green,
    so a receipt the report would print as NOT GREEN closed the item anyway.

    Would pass if the receipt were GREEN -- which is the positive control
    immediately below, differing in that one field.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(800, "a guard", "W6-ci", lane="lane:ci", size=1)
    _stub_ci_green(monkeypatch, ok=False, summary="NOT GREEN (FAIL=1)")
    with pytest.raises(tick.ReceiptRefusedError, match="NOT GREEN"):
        tick.record_receipt_from_evidence(
            led, POLICY, "o/r", 800, from_pr=4498, from_run=None)
    assert item.state == READY
    assert item.receipt_kind is None


def test_positive_control_a_green_ci_green_receipt_closes_the_item(tmp_path, monkeypatch):
    """The control for the test above: same fixture, `ok=True`."""
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(801, "a guard", "W6-ci", lane="lane:ci", size=1)
    _stub_ci_green(monkeypatch, ok=True)
    _gh(monkeypatch)
    out = tick.record_receipt_from_evidence(
        led, POLICY, "o/r", 801, from_pr=4498, from_run=None)
    assert item.state == CLOSED
    assert item.receipt_kind == "ci-green"
    assert item.receipt_taken_under == "guard-or-test-only"
    assert item.receipt_ref == "deadbeefcafe"  # the MERGED sha, not the PR number
    assert "ci-green" in out.summary


def test_blocker_a_pr_that_never_names_the_item_is_refused(tmp_path, monkeypatch):
    """The binding check. A reviewer closed an EPIC on a PR that references it
    nowhere -- `closingIssuesReferences: []`, no mention in body or commits.

    Would pass if the PR referenced the item; `_pr_references_item` is the only
    thing stubbed out in the two tests above, which is why they do not catch it.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    led.upsert(802, "a guard", "W6-ci", lane="lane:ci", size=1)
    monkeypatch.setattr(
        tick, "gh_json_local",
        lambda *_a, **_k: {"body": "unrelated work", "commits": [],
                         "closingIssuesReferences": []},
    )
    with pytest.raises(tick.ReceiptRefusedError, match="does not reference"):
        tick._pr_references_item("r", 4521, 802)


def test_an_item_not_in_the_ledger_is_refused(tmp_path):
    """Recording against a number the ledger has never seen would KeyError deep
    in `record_receipt`; it refuses up front instead."""
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    with pytest.raises(tick.ReceiptRefusedError, match="not in the ledger"):
        tick.record_receipt_from_evidence(
            led, POLICY, "o/r", 999999, from_pr=None, from_run="1")


def test_an_item_whose_class_names_no_receipt_kind_is_refused(tmp_path):
    """REACHABLE, which is why this is a test and not a disclosed equivalent
    mutant. `receipt_class` is a per-item override with NO production writer --
    README says so -- meaning the only way it is ever set is a hand edit to
    `state.json`. A hand edit is exactly where a typo lives.

    With a misspelled class, `policy.receipts.get(...)` returns None and the
    item would otherwise be recorded on whatever evidence was offered, under a
    class the policy has never heard of. Found because the arm for this branch
    SURVIVED the first time it was run -- the suite had no input that made
    `kind` falsy.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(804, "a guard", "W6-ci", lane="lane:ci", size=1)
    item.receipt_class = "guard-or-test-onlyy"  # the typo a hand edit makes
    with pytest.raises(tick.ReceiptRefusedError, match="names no receipt kind"):
        tick.record_receipt_from_evidence(
            led, POLICY, "o/r", 804, from_pr=None, from_run="1")
    assert item.state == READY


def test_a_run_backed_item_offered_no_evidence_at_all_is_refused(tmp_path):
    """Neither `--from-pr` nor `--from-run`. The symmetric half of the ci-green
    case above, and it was the fourth survivor."""
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    led.upsert(803, "a console surface", "W5-console", lane="lane:console", size=1)
    with pytest.raises(tick.ReceiptRefusedError, match="--from-run"):
        tick.record_receipt_from_evidence(
            led, POLICY, "o/r", 803, from_pr=None, from_run=None)


def test_blocker_a_ledger_close_also_closes_the_issue_on_github(tmp_path, monkeypatch):
    """#4545, THE RUN-BACKED ROUTE. Nothing in `tools/drain/` wrote to GitHub.

    FAILS against today's code on `spy.closed == []`: the ledger reached
    `closed` and the issue stayed open, which the next refresh reads as a
    reopen. The value that breaks this test is a `record_receipt_from_evidence`
    that does not call the closer -- exactly the state at 16b83e8ce9c.

    It also pins the ARGUMENTS, because a close aimed at the wrong repository
    is the same class of defect `sh`'s pinned `cwd` and the explicit `--repo`
    already exist to prevent.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(710, "a console surface", "W5-console", lane="lane:console", size=1)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run())
    spy = _gh(monkeypatch)

    out = tick.record_receipt_from_evidence(
        led, POLICY, "fgarofalo56/csa-inabox", 710, from_pr=None, from_run="123")

    assert item.state == CLOSED
    assert spy.closed == ["710"], "the ledger closed the item and GitHub never heard"
    close = next(c for c in spy.calls if c[:3] == ["gh", "issue", "close"])
    assert "--repo" in close
    assert close[close.index("--repo") + 1] == "fgarofalo56/csa-inabox"
    # THE SAME PIN ON THE READS, which had NO witness at all until round 10.
    # MEASURED in a sandbox copy: dropping `--repo` and its value from the
    # `gh issue view` argv in `_read_issue_on_github` survived 527/527, while
    # the identical drop on the CLOSE argv above went RED at this test by name
    # -- the positive control proving that survival was a real gap and not a
    # blind instrument. It is not a symmetry complaint: `sh`'s docstring says
    # `--repo` is explicit because `gh` otherwise resolves the repository from
    # the working directory, so without it the PRE-READ can short-circuit on a
    # FOREIGN repo's closed issue (receipt recorded, nothing closed, nothing
    # commented) and the READ-BACK can satisfy the verification vacuously --
    # #4545's failure mode restored through the verification instead of through
    # the write. THE VALUE THAT BREAKS THIS: a view argv built without `--repo`
    # (arm GH22).
    for view in [c for c in spy.calls if c[:3] == ["gh", "issue", "view"]]:
        assert "--repo" in view, "a read that lets gh pick the repository is unpinned"
        assert view[view.index("--repo") + 1] == "fgarofalo56/csa-inabox"
        # AND THE FIELDS, because each one puts a different guard in the path.
        # Asserted one at a time rather than as a single exact string, so a
        # failure names WHICH field went missing -- the same reason the
        # `--comment` body below is split (PT018).
        assert "--json" in view
        asked = view[view.index("--json") + 1].split(",")
        # `gh issue view` resolves PULL REQUESTS too (measured live on #4552),
        # and `gh issue close` routes a PR number to `api.PullRequestClose`
        # (close.go :175-177), so a read that asks for `state` alone cannot tell
        # the closer what it is about to close. Breaks on `--json state` (GH25).
        assert "url" in asked, (
            "the read must ask for the url, or the object's TYPE is never established"
        )
        # The TITLE is what makes gh's stderr safe to classify: it is the field
        # `_without_title_line_breaks` takes back out of the line before
        # `_close_outcome` reads it, and without it a title carrying a literal
        # LF creates a line of pure operator-supplied content that the
        # classifier then reads as gh's own. Breaks on an argv that stops
        # asking for it (GH31) -- and breaks BEHAVIOURALLY too, because the spy
        # answers only the fields the argv names, exactly as `gh` does.
        assert "title" in asked, (
            "the read must ask for the title, or the close classifier has nothing "
            "to neutralise and the issue's own title can forge the verdict"
        )
        assert "state" in asked, "the read must ask for the state it is named for"
    # THE POSITIVE PAIR for the comment. `…_no_comment_is_appended` is named
    # for the receipt comment and asserts only its ABSENCE on the
    # already-closed path -- which, per assertion-design.md "done" #4, is
    # satisfied by deleting the feature. Measured: dropping `--comment` from
    # the argv left 518/518 green (arm GH14). The comment is the receipt's only
    # trace on the artifact a human reads; without it the drain closes 334
    # issues silently, which is the R2 shape the interim workaround for #4535
    # avoided by quoting the receipt by hand.
    assert "--comment" in close, "the close carried no receipt for a human to read"
    body = close[close.index("--comment") + 1]
    # Split into two asserts (PT018) so a failure names WHICH half of the
    # detail went missing -- the workflow or the run it was taken from.
    assert "loom-ui-verify" in body, (
        "the comment must quote the RECEIPT DETAIL, not merely exist - the value "
        "that breaks this is a close whose comment does not name the evidence"
    )
    assert "123" in body, "the comment must name the RUN the receipt was measured from"
    # THE KIND AND THE CLASS, on the permanent artifact (arm GH15). Without
    # them the two routes posted IDENTICAL text and a reader of a closed issue
    # could not tell a live-estate receipt from CI green at a merged sha --
    # which is the one distinction R2 exists to draw. The value that breaks
    # these: a comment built from `detail` alone, which is what shipped.
    assert "kind=g1-browser" in body, "the comment must name the RECEIPT KIND"
    assert "class=ui-surface" in body, "the comment must name the ISSUE CLASS"
    # THE ROUTE, not merely the citation (arm GH16). `"deploy-integrity R2"`
    # below is in BOTH templates and therefore has ZERO power to tell the two
    # routes apart -- disclosed at its own site. This pair is the assertion that
    # does. THE VALUE THAT BREAKS IT: `if kind in MERGE_BASED_KINDS:` collapsing
    # to `if True:`, which renders the MERGE text here and makes this
    # `g1-browser` receipt -- taken from a run of a browser workflow -- assert
    # publicly that its evidence is "a merge, not a deploy", that "the live
    # estate was never checked", and that the reader should go obtain a
    # g1-browser receipt instead. That mutation SURVIVED 519/519 at round 6's
    # head, where neither this pair nor
    # `test_a_receipt_kind_in_neither_category_refuses_rather_than_defaulting`
    # existed. MEASURED round 7, GH16 applied to a sandbox copy: this is the
    # assertion that goes red, by name and with this message; deleting just
    # this pair leaves GH16 caught by that other test's positive pair, so the
    # two are independent killers rather than one restated. The negative is
    # paired with the positive rather than standing alone, per
    # assertion-design.md "done" #4.
    assert "an observation of something that ran, not a merge" in body, (
        "a run-backed receipt must say its evidence is an OBSERVATION - the "
        "value that breaks this is the merge-based branch's text rendered here, "
        "i.e. both routes collapsed into the template that disclaims the estate"
    )
    assert "a merge, not a deploy" not in body, (
        "a run-backed close must not disclaim its own evidence as a merge"
    )
    # CORRECTION (round 9). This block used to read: "A RUN-BACKED receipt is an
    # observation rather than a merge, so it may cite R2 as SATISFIED. The
    # ci-green route may not." The premise is sound and the conclusion is not:
    # an observation satisfies R2 only if it observed THIS item's change, and
    # nothing in the receipt path looks -- no `createdAt` is fetched, no
    # `headSha` is compared. The comment now cites R2 as the reason the class
    # takes a run RATHER THAN a merge, which is true, and discloses the binding
    # gap. Pinned by
    # `test_a_run_backed_comment_does_not_claim_an_r2_satisfaction_it_cannot_establish`.
    #
    # DISCLOSED, per assertion-design.md "done" #5: this assertion has NO power
    # to distinguish the two routes. `deploy-integrity R2` is cited by both
    # templates -- as a confinement there, as the reason for the shape here --
    # so no collapse of the split can make it fail. It pins that the citation
    # exists at all (arms GH14 and GH15 break it); the route is pinned by the
    # pair above.
    assert "deploy-integrity R2" in body
    assert "closed on GitHub" in out.summary


def test_blocker_the_github_close_happens_on_the_ci_green_route_too(tmp_path, monkeypatch):
    """THE OTHER ROUTE, and the reason it is a separate test rather than a
    parameter: the defects this package keeps producing are fixes applied to one
    side of a symmetry. A closer wired only where the author tested it -- `if
    from_pr:` -- would leave every run-backed item un-closed, and the arm that
    narrows it that way is GH2 in `mutate_gates.py`.

    Fails against today's code for the same reason as the test above, and would
    also fail if the close were reachable only from the run-backed branch.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(806, "a guard", "W6-ci", lane="lane:ci", size=1)
    _stub_ci_green(monkeypatch, ok=True)
    spy = _gh(monkeypatch)

    tick.record_receipt_from_evidence(led, POLICY, "o/r", 806, from_pr=4498, from_run=None)

    assert item.state == CLOSED
    assert spy.closed == ["806"], "the ci-green route closed the ledger only"


def test_blocker_a_ci_green_close_does_not_cite_r2_as_licence_for_closing_on_a_merge(
    tmp_path, monkeypatch
):
    """THE PERMANENT PUBLIC ARTIFACT, and the finding that mattered most.

    Both routes used to post the SAME sentence: "Closing this issue on that
    evidence (deploy-integrity R2)." On the `ci-green` route the evidence IS a
    merge, and R2's one-line form is "merged is never done" -- so the comment
    cited the rule in support of exactly what the rule forbids, on up to 334
    permanent public artifacts, while `policy.json` carries
    `report-a-merge-as-a-fix` in its `never` list.

    FOUR VALUES BREAK THIS, each named at its assertion:

    1. a comment that does not name the kind (arm GH15),
    2. a comment that does not name the class (arm GH15),
    3. a ci-green comment that carries the run-backed sentence -- i.e. the two
       branches collapsed back into one template, which is the defect (arm
       GH17, which reclassifies `ci-green` as run-backed the way editing
       `record_receipt_from_evidence`'s `if kind == "ci-green":` and not
       `MERGE_BASED_KINDS` would),
    4. a ci-green comment that drops the non-claim about the estate (arm GH18).

    CORRECTION (round 7). This docstring used to say: "The POSITIVE CONTROL for
    3 is the run-backed test above, which asserts the estate-observing sentence
    IS present on its own route." **It did not.** That test's only comment
    assertion beyond kind/class/detail was `"deploy-integrity R2" in body`, and
    that string is in BOTH templates -- zero power to tell the routes apart, so
    the named pairing did not exist. It is the same shape as the `"NOT BOUNDED"`
    correction this diff makes elsewhere: a control asserted in prose that the
    code did not provide. The positive control NOW EXISTS and is a different
    assertion: `test_blocker_a_ledger_close_also_closes_the_issue_on_github`
    pins `"an observation of something that ran, not a merge"`, a string unique
    to the run-backed template, so deleting the split in EITHER direction turns
    one of the two tests red. The other direction -- both routes collapsing into
    the MERGE text -- is arm GH16, and it survived 519/519 until that assertion
    was added.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    led.upsert(807, "a guard", "W6-ci", lane="lane:ci", size=1)
    _stub_ci_green(monkeypatch, ok=True)
    spy = _gh(monkeypatch)

    tick.record_receipt_from_evidence(led, POLICY, "o/r", 807, from_pr=4498, from_run=None)

    close = next(c for c in spy.calls if c[:3] == ["gh", "issue", "close"])
    body = close[close.index("--comment") + 1]
    assert "kind=ci-green" in body, "the comment must name the RECEIPT KIND"
    assert "class=guard-or-test-only" in body, "the comment must name the ISSUE CLASS"
    assert "a merge, not a deploy" in body, (
        "a merge-based receipt must say its evidence is a merge - the value that "
        "breaks this is the run-backed branch's sentence rendered here, i.e. the "
        "two templates collapsed back into the one that said the same wrong thing"
    )
    assert "The live estate was never checked" in body, (
        "a ci-green close must state what it did NOT look at; without it the "
        "comment implies an estate state this route never measured"
    )


def test_a_ci_green_comment_claims_no_more_than_policy_says_it_proves(
    tmp_path, monkeypatch
):
    """THE PUBLIC ARTIFACT MUST NOT OUTRUN `policy.json` (round 7).

    The merge-based text said: "It establishes that the guards and tests this
    issue is about pass in CI." Two overclaims in one sentence, both contradicted
    by the policy this very receipt is taken under:

    - `ci_green_rule.not_proven_by_this_receipt` says a green context is NOT
      evidence it measured a non-empty POPULATION -- green-over-zero-items (the
      #4451 shape) "remains an owed capability, not a claim". "the guards and
      tests pass" asserts exactly the thing the policy declines to assert.
    - "this issue is about" asserts a BINDING that
      `record_receipt_from_evidence`'s own docstring calls weaker than
      `Item.pr`: a PR that REFERENCES an item is not necessarily that item's
      lane (#4489).

    The asymmetry is what made it worth repairing rather than noting: the
    run-backed branch carries an explicit `DISCLOSED:` clause for its own
    binding gap, and the merge branch -- the route whose evidence is WEAKER --
    carried none.

    THE VALUES THAT BREAK THIS: restoring that sentence breaks both assertions
    below; deleting the `DISCLOSED:` clause while leaving the softened claim
    breaks the first. The negative is paired with a positive per
    assertion-design.md "done" #4.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    led.upsert(807, "a guard", "W6-ci", lane="lane:ci", size=1)
    _stub_ci_green(monkeypatch, ok=True)
    spy = _gh(monkeypatch)

    tick.record_receipt_from_evidence(led, POLICY, "o/r", 807, from_pr=4498, from_run=None)

    close = next(c for c in spy.calls if c[:3] == ["gh", "issue", "close"])
    body = close[close.index("--comment") + 1]
    # The policy's own words, so a future edit to either side shows up as a
    # disagreement rather than as drift nobody reads.
    assert "remains an owed capability, not a claim" in POLICY["receipts"][
        "ci_green_rule"
    ]["not_proven_by_this_receipt"], (
        "the policy text this assertion mirrors moved; re-reconcile the comment"
    )
    assert "an owed capability, not a claim" in body, (
        "a merge-based close must disclose that a green context is not proof it "
        "measured a non-empty POPULATION - the value that breaks this is the "
        "comment claiming the guards and tests PASS, which policy.json declines "
        "to claim"
    )
    assert "#4489" in body, (
        "a merge-based close must disclose that the PR-to-issue binding is by "
        "REFERENCE, not by lane"
    )
    assert "the guards and tests this issue is about pass in CI" not in body, (
        "the removed overclaim is back"
    )


def test_a_run_backed_comment_does_not_claim_an_r2_satisfaction_it_cannot_establish(
    tmp_path, monkeypatch
):
    """THE PUBLIC ARTIFACT MUST NOT ASSERT A BINDING THE CODE NEVER LOOKED FOR
    (round 9), and it is the SAME one-sided shape round 7 fixed one layer along:
    the merge branch volunteers its own gaps and the run branch volunteered one
    of three.

    The run-backed text used to end "an observation of something that ran, not a
    merge, which is what deploy-integrity R2 (merged is not done) ASKS OF THIS
    CLASS" -- an assertion that R2 is SATISFIED. Nothing in the receipt path
    establishes it. `_run_evidence` never requests `createdAt`, and
    `verify_run_backed_receipt` reads `headSha` only to interpolate it into the
    returned ref and compares it to nothing. So the run is bound to this issue
    by NOTHING: not by reference (a workflow run names no issue at all -- the
    gap the old text did disclose, #4489), not by time, not by sha.

    MEASURED RATHER THAN ARGUED, which is what makes it a blocker and not a
    style note: run `33238747458` (`loom-roll-and-validate`,
    `completed`/`success`, headSha `70ca3d136651efc01cf9b8449b0d73e609fdb071`,
    created 2026-08-29T06:33:22Z) satisfies every check this code makes, and
    147 of the 351 issues open on 2026-09-18 were filed AFTER it -- for each of
    those the run cannot have observed the behaviour the issue is about. A
    reader of the closed issue six months on takes "what R2 asks of this class"
    to mean the estate was seen carrying this change. R7 governs implication and
    the comment is unrevisable.

    WHY DISCLOSURE AND NOT THE BINDING, decided rather than defaulted: the
    binding needs the run's date, the item's date, a comparison and a refusal,
    and the item's date is not in hand -- fetching it is a new `gh` call on a
    path whose seven-shape failure behaviour was independently measured clean at
    this head. That re-derivation is #4578's work. What is NOT deferrable is the
    sentence, because it is published on every issue closed in the meantime.

    THE VALUES THAT BREAK THIS, MEASURED RATHER THAN PREDICTED. An earlier draft
    of this docstring said GH19 breaks "the second assertion" and stopped there;
    pytest reports only the FIRST failing assert in a test, so neither a 4/4
    tally nor a `--tb=line` trace can see which predicates an arm actually
    falsifies. Each arm was applied to a sandbox copy, the comment RENDERED, and
    all five predicates evaluated with no runner short-circuiting:

    - **GH19** (the old "asks of this class" sentence restored) breaks 1 AND 2 --
      it deletes the R2-as-reason clause in the act of restoring the overclaim.
      Leaves 3, 4 and 5 holding.
    - **GH20** (the DISCLOSED clause deleted, softened R2 line kept) breaks 3 AND
      4. Leaves 1, 2 and 5 holding.

    Disjoint, so neither arm can pass for the other -- which is the property the
    earlier draft asserted and had not checked. GH20 additionally turns
    `test_the_run_backed_disclosure_is_still_true_of_the_code_it_describes` red,
    so it has two independent killers.

    Assertion 5 (`#4489`) is DISCLOSED AS UN-KILLABLE by these two arms, per
    assertion-design.md "done" #5: it survives both, and it is here to pin that
    the gap the OLD text did disclose is still disclosed -- a regression guard,
    not coverage of this round's change.

    The negatives are paired with a positive per assertion-design.md "done" #4:
    assertion 1 pins that the run branch still SAYS what it establishes, without
    which deleting the whole template would satisfy every `not in` here.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    led.upsert(808, "a deploy path", "W1-deploy", lane="lane:deploy", size=1)
    monkeypatch.setattr(
        tick, "_run_evidence",
        lambda *_: _roll_run(),
    )
    spy = _gh(monkeypatch)

    tick.record_receipt_from_evidence(led, POLICY, "o/r", 808, from_pr=None, from_run="9")

    close = next(c for c in spy.calls if c[:3] == ["gh", "issue", "close"])
    body = close[close.index("--comment") + 1]
    # THE POSITIVE. R2 still appears, as the reason this class takes a run
    # rather than a merge -- which IS established, since the kind came from the
    # item's class and the producer was matched. Deleting the template breaks
    # this before it can satisfy the three negatives below.
    assert "rather than a CI-green one" in body, (
        "a run-backed close must still say WHY its class takes a run - the "
        "value that breaks this is the R2 citation removed wholesale, which "
        "would satisfy the three negatives below for free"
    )
    assert "asks of this class" not in body, (
        "the run-backed comment claims deploy-integrity R2 is SATISFIED; the "
        "code fetches no run date and compares no sha, so it cannot know"
    )
    assert "no run date is fetched and no head sha is compared" in body, (
        "a run-backed close must disclose that the run is bound to no TIME and "
        "no SHA - the value that breaks this is the DISCLOSED clause deleted "
        "while the softened R2 line stays, which reads clean and says less"
    )
    assert "#4578" in body, (
        "the time/sha gap must be TRACKED on the artifact, not merely "
        "mentioned - the value that breaks this is the issue reference dropped"
    )
    # The gap the OLD text already disclosed is still disclosed. Restoring the
    # old sentence would keep this green, which is why it is not the assertion
    # that catches arm GH19.
    assert "#4489" in body


def test_the_run_backed_disclosure_is_still_true_of_the_code_it_describes():
    """THE DISCLOSURE AND THE CODE, PINNED TOGETHER (round 9).

    The comment publishes "no run date is fetched and no head sha is compared".
    That is a claim ABOUT THIS PROGRAM, on a permanent public artifact, and the
    way it goes FALSE is not an edit to the string -- it is somebody landing
    #4578, adding the comparison, and leaving the string alone. From that moment
    the harness understates itself forever, on every issue it closes after it,
    and no existing test notices.

    The claim is therefore asserted against the argv `_run_evidence` ACTUALLY
    ISSUES, read through a spy on the `sh` seam rather than from the module's
    source text: a guard that matches raw source is satisfied by a comment
    (`csa_loom_a_guard_matching_raw_source_is_satisfied_by_a_comment`), and
    "we do not fetch the date" is exactly the kind of claim a docstring can
    keep asserting after the code stopped agreeing.

    THE VALUE THAT BREAKS THIS: `createdAt` added to the `--json` field list,
    i.e. the first step of #4578. That is INTENDED. This test is the tripwire
    that makes narrowing the published disclosure part of that change instead
    of an afterthought; it is not a vote against the binding.
    """
    seen: list[list[str]] = []

    def spy(args):
        seen.append(list(args))
        return 0, json.dumps(_roll_run()), ""

    original = tick.sh
    tick.sh = spy
    try:
        tick._run_evidence("r", "9")
    finally:
        tick.sh = original

    assert len(seen) == 1, "the run read issued something other than one command"
    argv = seen[0]
    assert argv[:3] == ["gh", "run", "view"], argv
    fields = argv[argv.index("--json") + 1].split(",")
    assert "createdAt" not in fields, (
        "`_run_evidence` now fetches the run's date, so the published sentence "
        "'no run date is fetched and no head sha is compared' is no longer "
        "true - narrow the disclosure in `_receipt_comment` in the same change "
        "(#4578)"
    )
    # The POSITIVE HALF: the field list is real and non-trivial, so this test
    # cannot be satisfied by `_run_evidence` requesting nothing at all. Split in
    # two (PT018) so a failure names WHICH field went missing.
    assert "headSha" in fields, fields
    assert "conclusion" in fields, fields
    assert "no run date is fetched and no head sha is compared" in tick._receipt_comment(
        "deploy-run", "deploy-path", "d"
    ), "the disclosure this test keeps honest is not in the comment at all"


def test_a_receipt_kind_in_neither_category_refuses_rather_than_defaulting():
    """THE THIRD CASE, which used to fall through to the RUN-BACKED text.

    `_receipt_comment`'s merge branch had an unconditional `return` as its else,
    so a kind classified in neither set got precisely the estate-observing
    sentence -- while the `#:` comment on `MERGE_BASED_KINDS` claimed a future
    merge-based kind "cannot acquire the estate-observing sentence by being
    added elsewhere". That claim was false for the exact case it named.

    Latent rather than live, and the input is named: today's five kinds are
    `ci-green`, `deploy-run`, `estate`, `g1-browser` and `operator`; `operator`
    is refused earlier by `verify_run_backed_receipt` so it never renders, and
    the other four are classified correctly. It goes LIVE the moment merge-ness
    is edited at `record_receipt_from_evidence`'s `if kind == "ci-green":` and
    not at `MERGE_BASED_KINDS` -- two declarations, one artifact, permanent.

    THE VALUE THAT BREAKS THIS: restoring the unconditional `return`, which
    turns the refusal into the run-backed text over a kind nothing classified.
    """
    assert "operator" not in tick.MERGE_BASED_KINDS | tick.RUN_BACKED_KINDS, (
        "this test's premise is that an UNCLASSIFIED kind exists to probe with"
    )
    with pytest.raises(tick.ReceiptRefusedError) as exc:
        tick._receipt_comment("operator", "guard-or-test-only", "d")
    assert "neither" in str(exc.value), (
        "the refusal must say WHY - a kind classified by nothing is not the "
        "same diagnosis as a kind the policy refuses"
    )
    # The POSITIVE PAIR: the two classified routes still render, so the refusal
    # above cannot be satisfied by making `_receipt_comment` raise on
    # everything. The value that breaks these is exactly that.
    assert "a merge, not a deploy" in tick._receipt_comment(
        "ci-green", "guard-or-test-only", "d")
    assert "an observation of something that ran, not a merge" in tick._receipt_comment(
        "g1-browser", "ui-surface", "d")


def test_blocker_the_github_close_happens_before_the_ledger_write(tmp_path, monkeypatch):
    """THE ORDERING, asserted rather than described.

    The two writes fail independently and the orderings are not symmetric.
    GitHub-first leaves, on a ledger failure, an issue closed upstream and an
    item still non-terminal here -- which the next refresh flags as `departed`,
    loudly, and which `--record-receipt` can simply re-run. Ledger-first leaves,
    on a GitHub failure, an item `closed` here and open there: #4545 verbatim,
    receipt destroyed on the next cycle.

    The spy reads the item's state AT THE MOMENT the close is issued. The value
    that breaks this assertion is `closed` -- i.e. the ledger having gone first.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(711, "a console surface", "W5-console", lane="lane:console", size=1)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run())
    seen: list[str] = []
    spy = _gh(monkeypatch, on_close=lambda: seen.append(item.state))

    tick.record_receipt_from_evidence(led, POLICY, "o/r", 711, from_pr=None, from_run="1")

    assert spy.closed == ["711"]
    assert seen == [READY], (
        f"the ledger was already {seen} when the GitHub close was issued - that is "
        "the ordering whose half-completed pair IS #4545"
    )
    assert item.state == CLOSED  # and it still finishes the job


def test_blocker_a_failed_github_close_leaves_the_item_non_terminal(tmp_path, monkeypatch):
    """FAILURE IS NOT SILENCE. A close that did not happen must not be reported
    as one, and must not be recorded as one.

    `gh` exits non-zero -- no token, a 404, a rate limit. The item must stay
    where it was, with no receipt, so the next cycle re-selects it. The value
    that breaks this: an `|| true` on the close, an ignored rc, or the ledger
    write running first.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(712, "a console surface", "W5-console", lane="lane:console", size=1)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run())
    _gh(monkeypatch, close_rc=1, close_err="HTTP 403: Resource not accessible")

    with pytest.raises(tick.IssueCloseFailedError, match="403"):
        tick.record_receipt_from_evidence(led, POLICY, "o/r", 712, from_pr=None, from_run="1")

    assert item.state == READY
    assert item.receipt_kind is None
    assert item.receipt_ref is None


def test_blocker_gh_being_unrunnable_is_a_refusal_not_a_traceback(tmp_path, monkeypatch):
    """THE ENVIRONMENT FAILURE, which is a different experiment from mutating
    the code at the site: a mutated site is still EVALUATED, so the suite sees
    it; a site that is never reached because the tool is missing is how a
    100%-killed matrix sits over a fail-open.

    `gh` absent from PATH raises `FileNotFoundError` out of `subprocess`. The
    item must stay non-terminal, and the message must say nothing was written.
    Would fail if the closer caught OSError and carried on, or if the ledger
    write had already happened.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(713, "a console surface", "W5-console", lane="lane:console", size=1)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run())
    _gh(monkeypatch, raises=FileNotFoundError("gh"))

    with pytest.raises(tick.IssueCloseFailedError, match="Nothing was written"):
        tick.record_receipt_from_evidence(led, POLICY, "o/r", 713, from_pr=None, from_run="1")

    assert item.state == READY
    assert item.receipt_kind is None


def test_blocker_a_close_that_rc0s_but_leaves_the_issue_open_is_refused(tmp_path, monkeypatch):
    """VERIFIED BY EFFECT, not by exit code. rc=0 from a wrapper that did
    nothing is a false success this repo has already paid for.

    The spy returns rc=0 and leaves the state OPEN. Reporting a close here
    would recreate #4545 one layer down: ledger `closed`, issue open, receipt
    voided next cycle. The value that breaks this assertion is dropping the
    read-back and trusting rc.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(714, "a console surface", "W5-console", lane="lane:console", size=1)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run())
    _gh(monkeypatch, takes_effect=False)

    with pytest.raises(tick.IssueCloseFailedError, match="still reads OPEN"):
        tick.record_receipt_from_evidence(led, POLICY, "o/r", 714, from_pr=None, from_run="1")

    assert item.state == READY
    assert item.receipt_kind is None


def test_an_already_closed_issue_is_not_closed_again_and_no_comment_is_appended(
    tmp_path, monkeypatch
):
    """IDEMPOTENCE, and it is not hypothetical: #4535 was closed BY HAND as the
    interim workaround, so the first real run of this path met an issue that was
    already closed.

    No second close, therefore no second comment on a human's issue -- and the
    ledger still reaches `closed`, because the upstream state is already what
    this transaction wanted. The value that breaks it: closing unconditionally
    (a `gh issue close` call appears), or refusing (the item stays READY).

    AND THE PRICE, ASSERTED RATHER THAN LEFT IMPLICIT (round 9). "No second
    comment" is true of a route where the harness already commented. On the
    route that actually motivated the short-circuit -- a human closed the issue
    silently -- there is no FIRST comment either, so the receipt's whole
    existence is `tools/drain/state.json`, which is untracked. All 7 items the
    live ledger holds as `closed` are in that state, so this is the route the
    current population takes. `_receipt_comment`'s docstring used to claim its
    string is the receipt's only public trace "forever", which is false here;
    posting on this route is #4579. THE VALUE THAT BREAKS THE NEW PAIR: the note
    reverted to a bare "left alone", which reports a recorded receipt with no
    hint that nothing was published (arm GH21).
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(715, "a console surface", "W5-console", lane="lane:console", size=1)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run())
    spy = _gh(monkeypatch, state="CLOSED")

    out = tick.record_receipt_from_evidence(
        led, POLICY, "o/r", 715, from_pr=None, from_run="1")

    assert spy.closed == [], "an already-closed issue was closed again"
    assert item.state == CLOSED
    assert "already closed" in out.summary
    # No comment was posted -- not by this run and, on the silent-human route,
    # not ever. The note must SAY so, because the operator's only other reading
    # is that a receipt was published.
    assert not any(c[:3] == ["gh", "issue", "comment"] for c in spy.calls), (
        "this test's premise is that nothing is published on this route"
    )
    assert "NO receipt comment was posted" in out.close_note, (
        "the already-closed note reports a recorded receipt without saying its "
        "public trace does not exist - the value that breaks this is the note "
        "reverted to a bare 'left alone' (#4579)"
    )
    assert "#4579" in out.close_note, (
        "the missing-trace gap must be TRACKED where it is disclosed"
    )


def test_the_already_closed_marker_is_pinned_to_real_gh_output_not_to_the_spy():
    """THE POSITIVE CONTROL for the two tests below, in three layers.

    Those tests feed the closer a stderr string and assert on the note it
    derives. That is circular unless the string is what `gh` actually writes --
    a marker transcribed from the same mistaken memory as the spy would agree
    with itself and disagree with reality, which is the blindness
    `assertion-design.md` "done" #3 names.

    **Layer 1 pins the RENDERER against an observation.** `_gh_already_closed_
    stderr` must reproduce, byte for byte, a line captured from the installed
    `gh 2.100.0` (provenance at the constant). THE VALUE THAT BREAKS IT: any
    drift between the format string this suite renders and the one close.go
    prints -- a lost `#`, a dropped paren, `Issue` lowercased.

    **Layer 2 pins the MARKER against MANY renderings**, and layer 1 alone was
    measured insufficient. With a single captured fixture, the mis-transcription
    `_GH_FOUND_ALREADY_CLOSED = "(Failed)) is already closed"` -- a marker
    over-fitted to that one issue's title -- SURVIVED the whole suite, while in
    production it would match no other issue's stderr and every raced close
    would silently classify `unknown`, restoring the blocker this change exists
    to fix. Varying repo, number and title kills it: the marker must be the part
    of the sentence that does not move.

    **Layer 3 pins the marker against the FIELD THAT MOVES MOST**, and layer 2
    could not: the four triples below vary repo, number and title, but NOT ONE
    of their titles contains either marker -- so nothing in layer 2
    distinguished a title-safe marker from a title-unsafe one. It varied the
    fields that do not interact with the markers while holding the one that
    does at a constant. The final `%s` of BOTH sentences is `issue.Title`, and
    a bare-substring classifier therefore lets an issue's own title forge the
    verdict on a close that was genuinely performed. Measured end to end at
    `f3a2a834460`: 1 comment posted, state CLOSED, and a note stating the
    opposite of both, written permanently into `Item.history`.

    THE TWO COLLISION CASES KILL THE TWO IDIOM ORDERINGS, which is why both are
    here and neither is redundant:

    - a PERFORMED line whose title says `is already closed` goes red against
      the already-closed-first order (round 11's head), and
    - an ALREADY-CLOSED line whose title says `Closed issue ` goes red against
      the *swapped* order -- the tempting "fix", which merely moves the
      collision onto the dangerous side where a close this run did NOT perform
      is reported as performed.

    Only a POSITIONAL read passes both, because the title can never occupy the
    start of the line (`csa_loom_parse_by_position_not_by_idiom`).
    """
    assert _gh_already_closed_stderr(
        "fgarofalo56/csa-inabox", 4556,
        "synthetic-monitor: journeys failing (Failed)",
    ) == _REAL_GH_ALREADY_CLOSED_STDERR, (
        "the renderer has drifted from the one line of real gh output this "
        "suite has actually seen"
    )
    for repo, number, title in [
        ("fgarofalo56/csa-inabox", 4556, "synthetic-monitor: journeys failing (Failed)"),
        ("o/r", 1, "t"),
        ("some-org/another-repo", 999999, "a title with (parentheses) and #4552 in it"),
        ("x/y", 7, ""),
        # LAYER 3. The two titles that carry gh's own sentences.
        ("o/r", 4545, "the refresh reports a park as though it is already closed"),
        ("o/r", 4545, "Closed issue o/r#4545 (a receipt) was the wrong sentence"),
    ]:
        assert tick._close_outcome(
            _gh_already_closed_stderr(repo, number, title), repo, number
        ) == tick.CLOSE_FOUND_ALREADY_CLOSED, (
            f"gh's short-circuit for {repo}#{number} was not recognised - a marker "
            "that only matches one issue's stderr classifies every OTHER raced "
            "close as 'unknown', which is the blocker back in a quieter form; a "
            "marker read by IDIOM and swapped to test the success sentence first "
            "reports a close this run never performed"
        )
        assert tick._close_outcome(
            _gh_closed_stderr(repo, number, title), repo, number
        ) == tick.CLOSE_PERFORMED, (
            f"gh's success line for {repo}#{number} was not recognised - an "
            "unrecognised success qualifies every ordinary close, which is the "
            "noise that gets a disclosure ignored; and a marker read by IDIOM "
            "lets this issue's own TITLE report the close as somebody else's"
        )


def test_the_close_outcome_is_read_at_a_fixed_offset_on_the_line_gh_names_us_in():
    """THE POSITIONAL PROPERTIES, each with the value that breaks it named.

    `_close_outcome` reads `{prefix}{repo}#{number} (` at the offset just past
    gh's icon token, rather than asking whether a phrase appears anywhere. Six
    consequences, all asserted here rather than argued in the docstring.
    """
    ok = _gh_closed_stderr("o/r", 1, "t")

    # 1. THE ICON IS ONE TOKEN AND IS DROPPED. Breaks if the read anchors at
    #    offset 0 instead: gh always prints a glyph and a space ahead of the
    #    marker, so an offset-0 read classifies every real line UNKNOWN.
    assert tick._close_outcome(ok, "o/r", 1) == tick.CLOSE_PERFORMED

    # 2. COLOUR ESCAPES LIVE INSIDE THAT TOKEN. On a TTY gh wraps the glyph in
    #    SGR sequences, which contain no space. Breaks if the read counts
    #    CHARACTERS rather than splitting on the first space.
    assert tick._close_outcome(
        "\x1b[0;31m✓\x1b[0m Closed issue o/r#1 (t)\n", "o/r", 1
    ) == tick.CLOSE_PERFORMED

    # 3. A WARNING AHEAD OF THE MARKER IS TOLERATED, because the scan is
    #    per-line. Breaks if the read only ever looks at the first line.
    assert tick._close_outcome(
        "a deprecation notice from gh\n" + ok, "o/r", 1
    ) == tick.CLOSE_PERFORMED

    # 4. CRLF DOES NOT GLUE A \r ONTO THE SUFFIX. Breaks if `split("\n")`
    #    replaces `splitlines()` -- the already-closed arm ends in a suffix
    #    test, and `"... is already closed\r"` fails it silently.
    assert tick._close_outcome(
        _gh_already_closed_stderr("o/r", 1, "t").replace("\n", "\r\n"), "o/r", 1
    ) == tick.CLOSE_FOUND_ALREADY_CLOSED

    # 5. THE LINE MUST NAME THE OBJECT WE ASKED ABOUT. Breaks if repo and
    #    number are dropped from the prefix: a line about a DIFFERENT issue
    #    would then answer for this one.
    assert tick._close_outcome(ok, "o/r", 2) == tick.CLOSE_OUTCOME_UNKNOWN, (
        "a success line for a different NUMBER was accepted as this close"
    )
    assert tick._close_outcome(ok, "other/repo", 1) == tick.CLOSE_OUTCOME_UNKNOWN, (
        "a success line for a different REPOSITORY was accepted as this close"
    )
    #    BOTH HALVES, because only the PERFORMED half was asserted here and the
    #    claim above covers both prefixes. Measured: dropping repo and number
    #    from the ALREADY-CLOSED prefix alone survived all 531 tests, so the
    #    comment named a value that did not in fact break it -- the forbidden
    #    case in `.claude/rules/assertion-design.md`, reporting a suite as
    #    covering a behaviour no input distinguishes. Not an equivalent mutant:
    #    under it, `"! Issue other/repo#999 (x) is already closed"` reads
    #    `found-already-closed` for `o/r#1` instead of `unknown`, so somebody
    #    else's raced close would be reported as ours (arm GH35).
    already = _gh_already_closed_stderr("o/r", 2, "t")
    assert tick._close_outcome(already, "o/r", 1) == tick.CLOSE_OUTCOME_UNKNOWN, (
        "an already-closed line for a different NUMBER was accepted as this close"
    )
    assert tick._close_outcome(
        _gh_already_closed_stderr("other/repo", 1, "t"), "o/r", 1
    ) == tick.CLOSE_OUTCOME_UNKNOWN, (
        "an already-closed line for a different REPOSITORY was accepted as this close"
    )
    #    PAIRED WITH THE POSITIVE so the already-closed arm cannot satisfy the
    #    two above by never matching anything at all.
    assert tick._close_outcome(already, "o/r", 2) == tick.CLOSE_FOUND_ALREADY_CLOSED
    # ... but case alone must not disqualify it, because GitHub resolves
    #     owner/name case-insensitively and echoes its canonical casing. Breaks
    #     if the prefix compare becomes case-sensitive, which would classify
    #     every close UNKNOWN for an operator whose policy spells the repo
    #     differently.
    assert tick._close_outcome(
        _gh_closed_stderr("O/R", 1, "t"), "o/r", 1
    ) == tick.CLOSE_PERFORMED

    # 6. A REWORDED SENTENCE FAILS HONEST, NOT OPEN. Breaks if the third arm is
    #    removed (arm GH24): a future gh that rewords :118 would then fall
    #    through to "I closed it".
    assert tick._close_outcome(
        "! Issue o/r#1 (t) has already been closed\n", "o/r", 1
    ) == tick.CLOSE_OUTCOME_UNKNOWN
    assert tick._close_outcome("", "o/r", 1) == tick.CLOSE_OUTCOME_UNKNOWN


def test_blocker_a_close_performed_by_somebody_else_is_not_reported_as_ours(
    tmp_path, monkeypatch
):
    """THE RACE THE READ-BACK CANNOT SEE, and the reason "verified by effect"
    was an over-claim for nine rounds.

    A human -- or a second lane; the drain runs four -- closes the issue in the
    window between the pre-read at the top of `close_issue_on_github` and the
    `gh issue close` below it. close.go v2.100.0 re-fetches at :112 and returns
    at :117-120, ABOVE the comment block at :148, so `gh` exits 0 having posted
    NOTHING. The read-back then reads CLOSED -- truthfully, because somebody
    else made it so -- and the head at 070a9d4f9a8 returned `#716 closed on
    GitHub`, which is false twice over: this run did not close it, and the
    receipt comment whose atomicity is the entire justification for the
    single-command argv was never published. That sentence was then written
    permanently into `Item.history`.

    THE VALUE THAT BREAKS THIS TEST is the code at head: a note keyed on the
    read-back alone rather than on `_close_outcome`, which returns
    `#716 closed on GitHub` here and fails all three assertions below (arm
    GH23). It is also broken by a classifier that keys on the WRONG string --
    see the positive control above.

    The seam is `on_close`, which fires INSIDE the spy's close before it
    decides which of gh's two exits to take: flipping the state to CLOSED there
    is precisely "another writer won".
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(716, "a console surface", "W5-console", lane="lane:console", size=1)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run())
    spy = _gh(monkeypatch)
    # The other writer, landing in the window. `takes_effect` is irrelevant
    # here and left at its default: the state is already CLOSED by the time the
    # spy's close branch looks, so it takes gh's short-circuit exit.
    spy.on_close = lambda: spy.states.__setitem__("716", "CLOSED")

    out = tick.record_receipt_from_evidence(
        led, POLICY, "o/r", 716, from_pr=None, from_run="1")

    # The close COMMAND was issued -- this is not the pre-read short-circuit,
    # which would show no close at all. What differs is what gh DID with it.
    assert spy.closed == ["716"], "this test's premise is that the close was ISSUED"
    assert "did NOT close it" in out.close_note, (
        "a close performed by somebody else was reported as this run's own - the "
        "value that breaks this is the head's read-back-only note, which says "
        "'closed on GitHub' over a close it did not perform"
    )
    assert "NO receipt comment was posted" in out.close_note, (
        "gh short-circuits above its comment block, so the receipt the argv "
        "carried does not exist - a note that omits this reports a published "
        "receipt with no public trace"
    )
    assert "#4579" in out.close_note, (
        "this route lands in the same no-public-trace world the pre-read route "
        "discloses, and must point at the same tracked gap"
    )
    # AND THE FALSE SENTENCE MUST NOT REACH THE LEDGER, which is where the head
    # wrote it. `Item.history` is the audit trail; a wrong line there outlives
    # the console output that carried it.
    assert item.state == CLOSED
    assert not any("closed on GitHub" in h for h in item.history), (
        "the history recorded a close this run did not perform"
    )


def test_a_close_whose_outcome_gh_did_not_name_is_reported_as_unknown_not_as_ours(
    tmp_path, monkeypatch
):
    """THE THIRD ARM, and the reason the classifier is three-valued.

    A two-valued classifier keyed on the already-closed sentence alone fails
    OPEN: a future `gh` that rewords that line falls straight through to "I
    closed it", restoring the false claim from outside this repository, where
    no test here would see it. So an stderr carrying NEITHER of gh's two
    sentences answers `unknown`, and the note says the state is settled while
    the authorship is not (deploy-integrity R7 -- an error must not state as
    fact something it did not establish).

    THE VALUE THAT BREAKS THIS: an `else` that falls through to
    `#N closed on GitHub` whenever the already-closed marker is absent (arm
    GH24). That is the two-valued version, and it is green on every other test
    in this file.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    led.upsert(717, "a console surface", "W5-console", lane="lane:console", size=1)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run())
    # A `gh` that closed the issue and said something this code does not
    # recognise -- a reworded success line, a localised build, a wrapper.
    _gh(monkeypatch, close_err="Issue #717 has been shut\n")

    out = tick.record_receipt_from_evidence(
        led, POLICY, "o/r", 717, from_pr=None, from_run="1")

    assert "CANNOT TELL" in out.close_note, (
        "an unrecognised gh exit was reported as a performed close - the value "
        "that breaks this is a two-valued classifier whose else-branch claims "
        "authorship it did not establish"
    )
    assert "MAY NOT have been posted" in out.close_note, (
        "the comment's existence is exactly as unestablished as the authorship"
    )
    # AND IT NAMES THE ONE ACTION. This branch is TERMINAL -- the ledger write
    # still runs, so the item goes `closed`, and the record route refuses a
    # terminal item -- so "I cannot tell" without a next step leaves the
    # operator stranded in a state the tool will not re-enter
    # (deploy-integrity R6). THE VALUE THAT BREAKS THIS: the note reverted to
    # ending at "MAY NOT have been posted" (arm GH27).
    assert "gh issue view 717 --repo o/r --comments" in out.close_note, (
        "the unknown-outcome note gives the operator no command to run, from a "
        "state this tool deliberately refuses to re-enter"
    )
    assert "Drain harness: receipt verified" in out.close_note, (
        "the remediation must say WHAT to look for, or 'read the comments' is "
        "an instruction with no completion condition"
    )
    assert "#4579" in out.close_note, "the gap must be TRACKED where it is disclosed"
    assert led.load().items[717].state == CLOSED, (
        "the premise of the remediation is that the item is already terminal - "
        "if this ever stops being true the note's 'will not re-enter' is false"
    )
    # PAIRED WITH THE POSITIVE, per assertion-design.md "done" #4: the ordinary
    # success path must still report unqualified, or "fails honest" would be
    # satisfied by qualifying everything.
    led2 = Ledger(str(tmp_path / "s2.json"), receipts=POLICY["receipts"])
    led2.upsert(718, "a console surface", "W5-console", lane="lane:console", size=1)
    _gh(monkeypatch)
    ok = tick.record_receipt_from_evidence(
        led2, POLICY, "o/r", 718, from_pr=None, from_run="1")
    assert ok.close_note == "#718 closed on GitHub", (
        "a genuine close must still be reported plainly - the value that breaks "
        "this is a classifier that qualifies every outcome, which would make the "
        "assertions above pass while saying nothing"
    )


def test_blocker_an_issues_own_title_cannot_forge_the_close_outcome(
    tmp_path, monkeypatch
):
    """THE TITLE IS INTERPOLATED INTO THE STRING THE CLASSIFIER READS.

    close.go v2.100.0 writes `issue.Title` as the FINAL `%s` of both exit-0
    sentences (:118, :169). The first revision of `_close_outcome` asked whether
    `"is already closed"` appeared ANYWHERE in stderr, and asked it FIRST -- so a
    close this run GENUINELY PERFORMED, on an issue whose title carries that
    phrase, classified `found-already-closed`. Measured end to end at
    `f3a2a834460` with a fake that really performs the close: comments posted =
    1 and state = CLOSED, against a note asserting "this run did NOT close it"
    and "NO receipt comment was posted", both written permanently into
    `Item.history` by `_record_close_in_ledger`. Two false statements of fact on
    the ORDINARY SUCCESS PATH -- R7 in the change whose thesis is R7.

    LATENT, and said as such: zero of the most recent 1000 issue titles in this
    repository collide (reviewer's measurement at that head; positive control on
    the same query, 19 titles contain `closed`, the nearest being #4579 --
    "drain: the already-closed route records a receipt with no public trace at
    all" -- one hyphen away). The drain's population is 334 issues titled by this
    lane in long sentences ABOUT ISSUE-CLOSING MACHINERY, so "no title says that
    today" is a property of the data, not of the code.

    THE VALUE THAT BREAKS THIS TEST is the bare-substring classifier: arm GH26
    in the head's order fails the first half below, arm GH29 -- the tempting
    "swap the two ifs" -- fails the second. The title used here is the one the
    reviewer measured with.
    """
    collides = "the refresh reports a park as though it is already closed"

    # HALF ONE: the close is genuinely PERFORMED and the title says otherwise.
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    led.upsert(4545, "a console surface", "W5-console", lane="lane:console", size=1)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run())
    spy = _gh(monkeypatch, close_title=collides)

    out = tick.record_receipt_from_evidence(
        led, POLICY, "o/r", 4545, from_pr=None, from_run="1")

    # GROUND TRUTH, read from the fake rather than from the note under test.
    assert spy.closed == ["4545"], "this test's premise is that the close was ISSUED"
    assert spy.states["4545"] == "CLOSED", "the fake really performed the close"
    comments = [c for c in spy.calls
                if c[:3] == ["gh", "issue", "close"] and "--comment" in c]
    assert len(comments) == 1, "the receipt comment really rode along with the close"

    assert out.close_note == "#4545 closed on GitHub", (
        "an issue's own TITLE forged the close outcome: the run performed the "
        "close and posted the receipt, and the note said it did neither"
    )
    assert "did NOT close it" not in led.load().items[4545].history[-1], (
        "the forged sentence was written permanently into Item.history, which is "
        "the artifact this change exists to keep honest"
    )

    # HALF TWO: the close was NOT performed and the title says it was. This is
    # the direction the tempting "swap the two ifs" fix breaks, and it is the
    # dangerous one -- reporting a close this tool did not perform.
    led2 = Ledger(str(tmp_path / "s2.json"), receipts=POLICY["receipts"])
    led2.upsert(4546, "a console surface", "W5-console", lane="lane:console", size=1)
    spy2 = _gh(monkeypatch, close_title="Closed issue o/r#4546 (x) was the wrong line")
    spy2.on_close = lambda: spy2.states.__setitem__("4546", "CLOSED")

    out2 = tick.record_receipt_from_evidence(
        led2, POLICY, "o/r", 4546, from_pr=None, from_run="1")

    assert "did NOT close it" in out2.close_note, (
        "a title containing gh's SUCCESS sentence reported a close this run "
        "never performed - the swapped-idiom failure, and the worse direction"
    )
    assert "NO receipt comment was posted" in out2.close_note


#: The code points `str.splitlines()` treats as line breaks, ASKED OF PYTHON
#: rather than transcribed from its documentation. Round 12 reasoned about this
#: set from memory, concluded the title "can never occupy the start of a line",
#: and was wrong by a factor of ten -- so the probe that tests the fix derives
#: the set the same way `tick._has_line_break` does, and a Python that grows an
#: eleventh separator grows an eleventh arm here on the same day.
#:
#: Range chosen to cover U+2028/U+2029, the two highest; nothing above U+2029
#: is a separator in any Python, and the loop costs a few milliseconds once.
_SPLITLINES_SEPARATORS = tuple(
    chr(c) for c in range(0x3000) if len(f"a{chr(c)}b".splitlines()) > 1
)


def test_the_derived_separator_set_is_the_one_the_splitter_actually_honours():
    """POSITIVE CONTROL FOR THE PROBE BELOW, run before it is believed.

    A separator set derived by a loop that silently found nothing would make
    every arm in the forgery test below vacuous -- zero iterations, green,
    proving nothing. This pins the derivation itself.

    THE VALUE THAT BREAKS IT: a derivation that misses a separator (a range
    stopping below U+2028 gives 8), or one that finds none (a predicate with
    the comparison inverted gives 0). Both leave the forgery test green.
    """
    assert len(_SPLITLINES_SEPARATORS) == 10, (
        "str.splitlines() honours ten code points on every Python this repo "
        f"runs on; the derivation found {len(_SPLITLINES_SEPARATORS)}, so the "
        "forgery arms below are iterating over the wrong set"
    )
    # The two that make the point: ordinary text characters with no reason to
    # be stripped anywhere, and the ones round 12's `splitlines()` let through.
    # Written as ESCAPES, never as literals: a literal U+2028 in a source
    # file is invisible in every diff and every review, which is a poor way
    # to spell the character this whole test is about.
    assert "\u2028" in _SPLITLINES_SEPARATORS, "LS is not in the derived set"
    assert "\u2029" in _SPLITLINES_SEPARATORS, "PS is not in the derived set"
    # ... and the one `_producer_lines` CANNOT help with, because it is gh's own.
    assert "\n" in _SPLITLINES_SEPARATORS
    # `tick` must be looking at the same set. Not a re-derivation -- an
    # agreement check between the probe and the implementation.
    for sep in _SPLITLINES_SEPARATORS:
        assert tick._has_line_break(f"a{sep}b"), (
            f"tick._has_line_break does not see U+{ord(sep):04X} as a break, so "
            "a title carrying it would not be neutralised"
        )
    assert not tick._has_line_break("an ordinary title (with parens) #4552")
    assert not tick._has_line_break(""), (
        "an empty title must not count as carrying a break, or the neutraliser "
        "calls str.replace('', ...) and shreds the line at every position"
    )


@pytest.mark.parametrize("sep", _SPLITLINES_SEPARATORS,
                         ids=lambda s: f"U+{ord(s):04X}")
def test_blocker_a_line_break_in_the_title_cannot_forge_the_close_outcome(
    sep, tmp_path, monkeypatch
):
    """THE TITLE CANNOT START A LINE GH WROTE -- BUT IT CAN CREATE ONE.

    Round 12 fixed the idiom read by reading POSITIONALLY, and claimed at
    `tick.py` that the result was "title-proof by construction: the title is
    interpolated at the END of the line, inside `(...)`, and can never occupy
    the start of one". The first clause is true and the conclusion does not
    follow. `err.splitlines()` honours TEN separators against the one `gh`
    writes with, so a title carrying any of the other nine splits gh's
    single-line record into several and the classifier reads a line whose
    entire content is operator-supplied.

    Two separators are needed, not one: the first OPENS the crafted line and
    the second TERMINATES it, so the forged line ends in the OTHER sentence's
    suffix instead of trailing off into the record's own tail. That detail is
    why a single-separator probe reads `unknown` and looks safe.

    MEASURED AT `4ce05224585`, the round-12 head: all ten separators forge, in
    BOTH directions, 20 of 20, with a plain-title control green on the same
    path. End to end through the closer, a U+2028 title returned
    `#4547 closed on GitHub` over a run that closed nothing and posted no
    comment, and `_record_close_in_ledger` wrote that sentence permanently into
    `Item.history`.

    LATENT, NOT LIVE, and the distinction is stated rather than relied on: a
    complete census of all 1065 issues in this repository (reviewer's
    measurement, cross-checked against GraphQL `totalCount` and
    positive-controlled on a synthetic U+2028 string) found ZERO titles
    carrying any of the ten. Whether GitHub would ACCEPT one is NOT
    established, in either direction -- finding out needs a write nobody made.
    The fix does not rest on the answer, which is the entire point: round 12's
    safety rested on an unmeasured property of an external service.

    THE VALUES THAT BREAK THIS TEST, one per arm:
      - `_producer_lines` back to `err.splitlines()` (GH30) -- the nine
        non-LF separators go red.
      - `_without_title_line_breaks` deleted from the call site (GH31) -- the
        LF arm goes red, because LF is gh's OWN separator and splitting
        correctly cannot help with it.
      - the neutraliser narrowed to one code point, which is round 12's error
        repeated one layer down (GH32) -- the LF arm goes red.
    """
    repo = "o/r"
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run())

    # DIRECTION A: gh took its already-closed SHORT-CIRCUIT (somebody else won
    # the race), and the title forges the PERFORMED sentence. The dangerous
    # direction -- it reports a close this run did not make, over a receipt
    # comment that does not exist.
    led = Ledger(str(tmp_path / "a.json"), receipts=POLICY["receipts"])
    led.upsert(4547, "a console surface", "W5-console", lane="lane:console", size=1)
    forge_performed = f"A{sep}x Closed issue {repo}#4547 (B){sep}C"
    spy = _gh(monkeypatch, close_title=forge_performed)
    spy.on_close = lambda: spy.states.__setitem__("4547", "CLOSED")

    out = tick.record_receipt_from_evidence(
        led, POLICY, repo, 4547, from_pr=None, from_run="1")

    # GROUND TRUTH from the fake, never from the note under test. The racer set
    # the state before gh's close branch looked, so gh took its short-circuit
    # exit at close.go :117-120 -- ABOVE the comment block at :148, which is
    # why "no receipt comment exists" is true here however the note reads.
    assert spy.closed == ["4547"], "this arm's premise is that the close was ISSUED"
    assert spy.states["4547"] == "CLOSED", "the racer won, which is the premise"
    assert "did NOT close it" in out.close_note, (
        f"a title carrying U+{ord(sep):04X} forged gh's SUCCESS sentence: the "
        "run closed nothing and posted no receipt, and the note claimed a close"
    )
    assert "closed on GitHub - left alone" not in out.close_note
    assert "did NOT close it" in led.load().items[4547].history[-1], (
        "the forged sentence went into Item.history, which is permanent"
    )

    # DIRECTION B: the close was GENUINELY PERFORMED and the receipt really
    # rode with it, and the title forges the already-closed sentence -- which
    # denies a receipt comment that does exist, on a public artifact.
    led2 = Ledger(str(tmp_path / "b.json"), receipts=POLICY["receipts"])
    led2.upsert(4548, "a console surface", "W5-console", lane="lane:console", size=1)
    forge_already = f"A{sep}x Issue {repo}#4548 (B) is already closed{sep}C"
    spy2 = _gh(monkeypatch, close_title=forge_already)

    out2 = tick.record_receipt_from_evidence(
        led2, POLICY, repo, 4548, from_pr=None, from_run="1")

    assert spy2.states["4548"] == "CLOSED", "the fake really performed the close"
    assert len([c for c in spy2.calls
                if c[:3] == ["gh", "issue", "close"] and "--comment" in c]) == 1, (
        "the receipt comment really rode along with the close"
    )
    assert out2.close_note == "#4548 closed on GitHub", (
        f"a title carrying U+{ord(sep):04X} forged gh's ALREADY-CLOSED sentence: "
        "the run performed the close and published the receipt, and the note "
        f"said it did neither -- got {out2.close_note!r}"
    )


def test_a_plain_title_still_classifies_both_outcomes_unqualified(
    tmp_path, monkeypatch
):
    """THE POSITIVE CONTROL for the arms above, per assertion-design "done" #4.

    Every assertion in `..._cannot_forge_the_close_outcome` is satisfied by a
    classifier that answers correctly for reasons unrelated to the title -- or
    by a neutraliser so aggressive it rewrites ordinary records into
    unrecognisability. Both halves of the ordinary world are pinned here.

    THE VALUE THAT BREAKS IT: an unconditional `err.replace(title, ...)`. With
    a title of `"o"` that rewrites every `o` in `Closed issue o/r#N (o)`, the
    prefix stops matching and a genuine close reports `unknown` -- a guard that
    manufactures the failure it exists to prevent. That is why
    `_without_title_line_breaks` acts only on titles that carry a break.
    """
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run())
    for number, title in [(4549, "o"), (4550, "a normal (parenthesised) title")]:
        led = Ledger(str(tmp_path / f"p{number}.json"), receipts=POLICY["receipts"])
        led.upsert(number, "a console surface", "W5-console",
                   lane="lane:console", size=1)
        _gh(monkeypatch, close_title=title)
        out = tick.record_receipt_from_evidence(
            led, POLICY, "o/r", number, from_pr=None, from_run="1")
        assert out.close_note == f"#{number} closed on GitHub", (
            f"a plain title {title!r} stopped an ordinary close being reported "
            f"plainly - got {out.close_note!r}"
        )

    # And the already-closed half, so "unqualified" cannot be achieved by
    # reporting every outcome as a performed close.
    led = Ledger(str(tmp_path / "raced.json"), receipts=POLICY["receipts"])
    led.upsert(4551, "a console surface", "W5-console", lane="lane:console", size=1)
    spy = _gh(monkeypatch, close_title="a normal title")
    spy.on_close = lambda: spy.states.__setitem__("4551", "CLOSED")
    out = tick.record_receipt_from_evidence(
        led, POLICY, "o/r", 4551, from_pr=None, from_run="1")
    assert "did NOT close it" in out.close_note


def test_a_title_edited_inside_the_close_window_is_neutralised_by_the_read_back(
    tmp_path, monkeypatch
):
    """BOTH TITLES THIS RUN READ ARE NEUTRALISED, not just the pre-close one.

    `_without_title_line_breaks` can only take out a title it was given, and
    the title it is given comes from reads -- so a title EDITED between the
    pre-close read and gh's render is not covered by that read. The read-back
    that already runs to verify the close covers it, at no extra call: here the
    pre-read sees a plain title, `gh` renders one carrying a literal LF, and
    the read-back is what supplies the string to neutralise.

    LF specifically, because LF is the one separator `_producer_lines` cannot
    help with -- it is the producer's OWN terminator, so a title carrying one
    genuinely creates a line and only knowing the title recovers the record.

    THE VALUE THAT BREAKS IT: `_without_title_line_breaks(err, before.title)`,
    the read-back's title dropped from the set (arm GH37). Measured before this
    test existed: that mutation SURVIVED the whole suite, which is why the
    construct is witnessed here rather than argued for in a docstring.

    THE RESIDUAL IS STILL REAL and is not claimed away: a title carrying a
    literal LF at gh's render and carrying none at EITHER read -- two edits
    inside the close window -- is not covered by anything here. Narrower than
    round 12's, not absent. Whether GitHub accepts an LF in a title at all is
    not established in either direction.
    """
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run())
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    led.upsert(4554, "a console surface", "W5-console", lane="lane:console", size=1)
    forged = "A\nx Issue o/r#4554 (B) is already closed\nC"
    spy = _gh(monkeypatch, close_title=forged,
              view_title_before="an ordinary title nobody edited yet")

    out = tick.record_receipt_from_evidence(
        led, POLICY, "o/r", 4554, from_pr=None, from_run="1")

    # GROUND TRUTH: the close really happened and the receipt really rode with it.
    assert spy.states["4554"] == "CLOSED"
    assert len([c for c in spy.calls
                if c[:3] == ["gh", "issue", "close"] and "--comment" in c]) == 1
    # PREMISE, OBSERVED rather than restated from the spy's configuration: the
    # two reads really did answer different titles, or this test is the
    # ordinary one-title case wearing a different name.
    assert len(spy.view_titles) == 2, (
        f"expected a pre-read and a read-back, saw {len(spy.view_titles)}"
    )
    assert spy.view_titles[1] == forged, (
        f"the read-back answered {spy.view_titles[1]!r}, not the title `gh` "
        "rendered - there is nothing for the second neutralisation to take out"
    )
    assert spy.view_titles[0] != forged, (
        "the pre-read already answered the crafted title, so this is the "
        "ordinary one-title case wearing a different name"
    )
    assert out.close_note == "#4554 closed on GitHub", (
        "a title edited inside the close window forged gh's already-closed "
        f"sentence - got {out.close_note!r}"
    )


def test_the_sentence_predicate_refuses_a_body_too_short_to_hold_both_ends():
    """THE LENGTH GUARD'S ONLY WITNESS, and the disclosure that goes with it.

    `_sentence_is`'s `len(body) >= len(prefix) + len(suffix)` is an EQUIVALENT
    MUTANT at the two (prefix, suffix) pairs `_close_outcome` supplies: an
    exhaustive differential over 200 candidate bodies -- every prefix, suffix,
    concatenation and case variant of both rendered sentences -- finds no input
    whose verdict it changes at either real pair, with a positive control on an
    artificially overlapping pair that DOES diverge. At `4ce05224585`, deleting
    it survived the whole suite. Round 12's docstring presented it as doing
    work there anyway, and cited an example that fails the suffix test with or
    without it -- a control asserted to do something it does not, in the change
    whose thesis is that controls must do something
    (`.claude/rules/assertion-design.md` "done" #5).

    It is disclosed at its site and pinned HERE, at the predicate's own
    contract rather than at a call site: `_sentence_is` takes the pair as
    PARAMETERS, so an overlapping pair is expressible even though neither
    current caller supplies one. That is a real property with a real breaking
    value, and it is not counted as coverage of `_close_outcome`.

    THE VALUE THAT BREAKS IT: the length term deleted (arm GH33). `"abc"` then
    satisfies prefix `"abc"` and suffix `"bc"` simultaneously, reading as a
    complete sentence a string that is only its opening.
    """
    # The overlapping pair. This is the divergent input the exhaustive
    # differential over the REAL pairs could not find, which is exactly why the
    # guard needs a contract-level witness rather than a call-site one.
    assert not tick._sentence_is("abc", "abc", "bc"), (
        "a body shorter than prefix+suffix satisfied both ends at once - the "
        "length guard is gone and `_sentence_is` now reads an opening fragment "
        "as a whole sentence"
    )
    # PAIRED WITH THE POSITIVE, or the guard is satisfied by refusing
    # everything: one more character and the two ends no longer overlap.
    assert tick._sentence_is("abcbc", "abc", "bc")
    # And the real pairs still read, so the guard has not been tightened into
    # rejecting the sentences it exists alongside.
    assert tick._sentence_is(
        "Closed issue o/r#1 (t)", "Closed issue o/r#1 (", ")")
    assert tick._sentence_is(
        "Issue o/r#1 (t) is already closed", "Issue o/r#1 (", " is already closed")


def test_the_close_outcome_reads_lines_the_way_gh_wrote_them():
    """`_producer_lines` splits by the PRODUCER's rule, not by Python's widest.

    `gh` terminates each record with exactly one `\\n`. Reading it back with a
    rule that honours ten separators means nine of them delimit nothing the
    producer meant -- and every one is reachable from the title. This pins the
    narrower split directly, alongside the CRLF behaviour that `splitlines()`
    was originally chosen for and which a naive `split("\\n")` would lose.

    THE VALUES THAT BREAK IT: `err.splitlines()` (GH30) makes the first
    assertion red; dropping `removesuffix("\\r")` (GH32) makes the CRLF
    assertion red. They are opposite mistakes and the pair pins both.

    DISCLOSURE, because the distinction cost round 13 a blocker. Every `err`
    here is CONSTRUCTED. The last two assertions feed shapes that `sh()` CANNOT
    DELIVER: it reads the pipe in text mode, so Python translates CRLF and lone
    CR to LF before any caller sees them, and no CR reaches `_producer_lines`
    through the real producer at all. These two arms are unit tests of the
    helper against a hypothetical caller, NOT evidence that the producer path
    handles CRLF.

    AND THE ARM THEY KILL IS **GH38**, NOT GH32. An earlier revision of this
    disclosure named GH32, which is wrong and matters: GH32 is killed by four
    entirely different tests, so filing the disclosure under it made the
    equivalent-mutant admission invisible.

    MEASURED, not transcribed (2026-09-18, sandbox copy, control green first):
    apply GH38 and deselect BOTH constructed CRLF sites -- the two assertions
    below, AND item 4 of
    `test_the_close_outcome_is_read_at_a_fixed_offset_on_the_line_gh_names_us_in`
    -- and GH38 **SURVIVES** (550 passed, 4 deselected, rc 0 — measured at this head; an
    earlier revision said 546, counted before `origin/main` was taken). A first attempt at
    this probe deselected only ONE of the two sites and wrongly concluded GH38
    had other kill power; naming the second site is the whole content of the
    finding.

    The third deselection is `test_mutate_gates.py::
    test_every_arm_anchor_is_present_and_unique_in_the_current_source`. It fails
    under EVERY arm simply because the anchor string changed, so counting it
    makes KILLED a tautology
    (`csa_loom_a_meta_test_inside_the_mutation_sandbox_makes_killed_a_tautology`).

    So GH38 is scored KILLED over an input `tick.sh` cannot emit, and that is
    disclosed here rather than counted (`.claude/rules/assertion-design.md`
    "done" #5 and #6 -- a green arm must say which it is).

    The channel itself is pinned by
    `test_gh_stderr_reaches_the_classifier_with_cr_already_translated_to_lf`,
    which is the only arm in this file that takes `err` from a real capture.
    """
    # A non-LF separator is CONTENT, not structure: one line, not two.
    assert tick._producer_lines("a\u2028b\n") == ["a\u2028b", ""]
    assert tick._producer_lines("a\x0bb\x1eC\n") == ["a\x0bb\x1eC", ""]
    # LF is structure, because gh wrote it.
    assert tick._producer_lines("a\nb\n") == ["a", "b", ""]
    # CRLF contributes exactly one CR, and it comes off -- or the already-closed
    # arm's SUFFIX test fails silently on a `\r`-terminated line.
    assert tick._producer_lines("a\r\nb\r\n") == ["a", "b", ""]
    # ... but a CR INSIDE the line is left alone, which is the difference
    # between undoing a terminator and rewriting content.
    assert tick._producer_lines("a\rb\r\n") == ["a\rb", ""]


def test_gh_stderr_reaches_the_classifier_with_cr_already_translated_to_lf():
    """THE CHANNEL, pinned from a REAL capture instead of a constructed string.

    THE GAP THAT LET THE ROUND-13 BLOCKER THROUGH. Every other arm in this file
    builds `err` by hand, so every one of them describes a producer that does
    not exist. Three rounds hardened the PARSE while the defect sat in the
    CHANNEL: `sh()` passes `text=True`, Python wraps the pipe with
    `newline=None`, and universal-newline translation turns CRLF and lone CR
    into LF before any caller sees a byte of it. The titles arrive by a
    different route (`--json title`) with their bytes intact, so a CR-bearing
    title could never match its own copy in `err` -- and no test could notice,
    because no test asked the real channel what it delivers.

    THE VALUE THAT BREAKS THIS: `sh()` switching to `newline=""`, to
    `universal_newlines=False`, or to capturing bytes and decoding by hand. Any
    of those makes `err` carry a CR again, which simultaneously invalidates
    `_as_channel_would` (it would then over-translate) and promotes
    `_producer_lines`'s `removesuffix("\\r")` from defensive to load-bearing.
    This arm is the one that would go red, and it is the reason both of those
    docstrings point at it by name.
    """
    # Write BYTES from the child so the child's own text layer cannot translate
    # anything on the way out -- otherwise this would measure the wrong end.
    prog = (
        "import sys; sys.stderr.buffer.write(b'A\\rB\\r\\nC\\n');"
        " sys.stderr.buffer.flush()"
    )
    rc, _out, err = tick.sh([sys.executable, "-c", prog])

    assert rc == 0, f"probe child failed: rc={rc} err={err!r}"
    assert "\r" not in err, (
        "sh() no longer translates CR to LF. _as_channel_would now "
        "over-translates the title, and _producer_lines's removesuffix is "
        f"load-bearing rather than defensive. Captured: {err!r}"
    )
    # Exact, not just "no CR": a lone CR becomes ONE LF and a CRLF becomes ONE
    # LF, so three written line boundaries arrive as three.
    assert err == "A\nB\nC\n", repr(err)


def test_a_cr_bearing_title_is_neutralised_against_the_translated_err():
    """A CR in the title must be matched as the LF the channel actually handed us.

    ROUND 13'S FIRST BLOCKER, end to end at the helper. The title comes from
    JSON with a real CR; `err` comes from the pipe with that CR already an LF.
    Comparing the two untranslated is a replace that cannot match, and the
    neutraliser silently does nothing on the separator a caller is most likely
    to paste.

    THE VALUE THAT BREAKS IT: deleting the `_as_channel_would` call from
    `_without_title_line_breaks`. The title then still carries `\\r`, does not
    occur in `err`, and the surviving LF leaves the record split in two.
    """
    title_from_json = "bug\rfix"
    # `err` as the CHANNEL delivers it -- the same title, CR already LF.
    err = "issue #1 (" + title_from_json.replace("\r", "\n") + ") closed\n"

    cleaned = tick._without_title_line_breaks(err, title_from_json)

    assert cleaned == "issue #1 (bug fix) closed\n", repr(cleaned)
    assert tick._producer_lines(cleaned) == ["issue #1 (bug fix) closed", ""]


def test_a_substring_title_cannot_shadow_the_longer_one():
    """Replace LONGEST FIRST: argument order is the caller's accident.

    ROUND 13'S SECOND BLOCKER, and the arm that had to be rewritten because the
    first version could not witness the thing it was named for.

    The two titles are the pre-close read and the read-back, and one title edit
    inside the close window makes one a prefix of the other. Replacing the
    shorter first consumes the text the longer needed to match, so the longer
    survives un-neutralised and its break still splits the record.

    THE FIXTURE NEEDS **THREE** BREAKS. A two-break pair degrades to the honest
    `unknown` under argument order -- no forged verdict -- so a two-break
    fixture pins only the cleaned string and would stay green against a real
    forge. An earlier revision of this test used exactly that, and an earlier
    revision of the code comment concluded from a one- and two-break search that
    no witness existed at all. The search was sound; its population could not
    contain the answer.

    THE VALUE THAT MAKES THIS FAIL: iterating `titles` in argument order. The
    pair below then classifies `performed` against a `gh` record whose ground
    truth is `found-already-closed` -- a forged verdict, which is what gets
    written permanently into `Item.history`.
    """
    # The read-back title carries a forged "Closed issue" record; the pre-close
    # title is a PREFIX of it, which is what lets argument order destroy the
    # longer one's match.
    short = "A\nC"
    longer = "A\nC\nZ Closed issue o/r#1 (q)\nB"
    err = f"! Issue o/r#1 ({longer}) is already closed\n"

    # Passed in the LOSING order on purpose -- the order the call site uses.
    cleaned = tick._without_title_line_breaks(err, short, longer)

    # THE VERDICT is the assertion that matters. Ground truth is a raced close.
    assert tick._close_outcome(cleaned, "o/r", 1) == tick.CLOSE_FOUND_ALREADY_CLOSED, (
        "a three-break read-back title forged `performed` against a genuine "
        f"already-closed record: {cleaned!r}"
    )
    # Paired positive assertion, so this cannot be satisfied by a neutraliser
    # that simply destroys the record: an ordinary performed close still reads
    # `performed` through the same path.
    perf = "✓ Closed issue o/r#1 (ordinary title)\n"
    assert tick._close_outcome(
        tick._without_title_line_breaks(perf, "ordinary title", "ordinary title"),
        "o/r", 1,
    ) == tick.CLOSE_PERFORMED

    # And the structural property the verdict rests on: one line, no survivors.
    assert "\n" not in cleaned[:-1], repr(cleaned)


def test_the_closer_refuses_an_issue_that_resolves_to_another_repository(
    tmp_path, monkeypatch
):
    """A TRANSFERRED ISSUE ANSWERS FROM SOMEWHERE ELSE.

    GitHub keeps a transferred issue's old number reachable and resolves it to
    the NEW repository's url. The type guard established that `gh issue view`
    answered about an ISSUE; nothing established it answered about an issue HERE,
    because only the kind segment was read. Measured at `f3a2a834460`:
    `https://github.com/other-org/other-repo/issues/9` read `kind='issues'` and
    was accepted.

    Narrow -- every ledger number originates in `gh issue list --repo` -- but the
    `--repo` pin on both reads (arm GH22) was argued FROM this exact hazard, and
    the url that settles it was already parsed. THE VALUE THAT BREAKS THIS: the
    owner/repo comparison deleted, leaving the argv pin as a hope rather than a
    verified effect (arm GH28).
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    led.upsert(4547, "a console surface", "W5-console", lane="lane:console", size=1)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run())
    spy = _gh(monkeypatch, url_repo="other-org/other-repo")

    with pytest.raises(tick.IssueCloseFailedError, match="answered about"):
        tick.close_issue_on_github(
            POLICY, "o/r", 4547, CLOSED, "a receipt", "g1-browser", "ui-surface")
    assert spy.closed == [], "the closer reached the write over a foreign object"

    # PAIRED WITH THE POSITIVE so the guard cannot be satisfied by refusing
    # everything, and with a CASE-SHIFTED repo so the comparison cannot be made
    # case-sensitive without going red: GitHub echoes canonical casing.
    ok_spy = _gh(monkeypatch, url_repo="O/R")
    tick.close_issue_on_github(
        POLICY, "o/r", 4548, CLOSED, "a receipt", "g1-browser", "ui-surface")
    assert ok_spy.closed == ["4548"], (
        "the guard refused an issue in the repository it was asked about, "
        "spelled in the casing GitHub echoes"
    )
    assert led.load().items[4547].state != CLOSED, (
        "the ledger moved over an object in another repository"
    )


def test_blocker_the_closer_refuses_a_number_that_resolves_to_a_pull_request(
    tmp_path, monkeypatch
):
    """`gh issue view` ANSWERS FOR PULL REQUESTS, and `gh issue close` closes them.

    Measured live on 2026-09-18, read-only:
    `gh issue view 4552 --repo fgarofalo56/csa-inabox --json state,url` returned
    `{"state":"OPEN","url":"https://github.com/fgarofalo56/csa-inabox/pull/4552"}`
    -- #4552 being the pull request this change shipped in. close.go :175-177
    then routes a PR number to `api.PullRequestClose`, so a type-blind read-first
    would let the harness close a PULL REQUEST and post the permanent receipt
    comment on it.

    LATENT TODAY, pinned anyway: every ledger number originates in
    `gh issue list --state open`, but `state.json` is hand-editable and the
    README documents hand edits, so the only thing standing between the harness
    and this is a convention outside the file. The read-first is presented as
    what makes the write safe; a read that cannot tell what it read does not.

    THE VALUE THAT BREAKS IT: a `_read_issue_on_github` that returns the state
    without inspecting the url -- which is the code at round 9's head, and is
    arm GH25. Note the close must NOT be issued: the refusal has to land on the
    PRE-read, before anything is written.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(4552, "a console surface", "W5-console", lane="lane:console", size=1)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run())
    spy = _gh(monkeypatch, url_kind="pull")

    with pytest.raises(tick.IssueCloseFailedError, match="is not an issue"):
        tick.record_receipt_from_evidence(
            led, POLICY, "o/r", 4552, from_pr=None, from_run="1")

    assert spy.closed == [], "a pull request was sent to `gh issue close`"
    assert item.state == READY, "the ledger moved on an object it could not identify"
    # PAIRED WITH THE POSITIVE so the guard cannot be satisfied by refusing
    # everything: the same path with an `issues` url still closes.
    led2 = Ledger(str(tmp_path / "s2.json"), receipts=POLICY["receipts"])
    led2.upsert(4553, "a console surface", "W5-console", lane="lane:console", size=1)
    ok_spy = _gh(monkeypatch)
    tick.record_receipt_from_evidence(
        led2, POLICY, "o/r", 4553, from_pr=None, from_run="1")
    assert ok_spy.closed == ["4553"], "the guard refused an ordinary issue"


def test_an_unrecognised_object_url_is_refused_rather_than_assumed_to_be_an_issue(
    tmp_path, monkeypatch
):
    """FAIL CLOSED on a shape `_object_kind_from_url` does not know.

    The guard reads the kind BY POSITION -- the third path segment of
    `/{owner}/{repo}/{kind}/{number}` -- rather than asking whether "pull"
    appears in the string, because a repository named `pull` would satisfy the
    substring test and answer the wrong question. A url with no such segment
    yields "", and "" must refuse: treating an unparseable url as an issue is
    the same guess the rest of this module exists to refuse.

    THE VALUE THAT BREAKS IT: `if "pull" in url:` in place of the positional
    read, which lets every unrecognised shape through -- and, on a repository
    named `pull`, refuses every legitimate issue.
    """
    assert tick._object_kind_from_url("https://github.com/o/r/pull/9") == "pull"
    assert tick._object_kind_from_url("https://github.com/o/r/issues/9") == "issues"
    # The repository literally named `pull` -- an issue, and it must read as one.
    assert tick._object_kind_from_url("https://github.com/o/pull/issues/9") == "issues"
    assert tick._object_kind_from_url("https://github.com/o/r") == ""

    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    led.upsert(719, "a console surface", "W5-console", lane="lane:console", size=1)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run())
    spy = _gh(monkeypatch, url_kind="discussions")

    with pytest.raises(tick.IssueCloseFailedError, match="is not an issue"):
        tick.record_receipt_from_evidence(
            led, POLICY, "o/r", 719, from_pr=None, from_run="1")
    assert spy.closed == []


def test_blocker_a_ledger_failure_after_the_close_is_not_reported_as_a_refusal(
    tmp_path, monkeypatch
):
    """R7 ON THE REVERSE PATH. `RECEIPT REFUSED` means "your evidence was
    rejected"; over a landed GitHub close both halves of that are false.

    The ledger write is driven to fail the way a FUTURE refusal would -- a
    `transition` that raises -- and the error must name the upstream close and
    the recovery. The value that breaks it: a bare `ValueError` escaping, which
    `main()` prints as a refusal (arm GH11).

    `_record_close_in_ledger` restores the item, so the in-memory ledger is
    untouched; that is asserted too, because "nothing was saved" is half of
    what the message claims.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(716, "a console surface", "W5-console", lane="lane:console", size=1)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run())
    spy = _gh(monkeypatch)

    def refuse(*_a, **_k):
        raise ValueError("a future R2 refusal nobody has written yet")

    monkeypatch.setattr(led, "transition", refuse)

    with pytest.raises(tick.LedgerWriteAfterCloseError) as caught:
        tick.record_receipt_from_evidence(led, POLICY, "o/r", 716, from_pr=None, from_run="1")

    assert spy.closed == ["716"], "the close must have LANDED for this to be the case under test"
    assert "closed on GitHub" in str(caught.value)
    assert "Re-run the same command" in str(caught.value)
    assert item.state == READY
    assert item.receipt_kind is None


def test_blocker_a_lost_cas_after_a_landed_close_says_so(tmp_path, monkeypatch, capsys):
    """THE FAILURE THAT WILL ACTUALLY FIRE, because the drain runs four lanes.

    A rival lane lands between this transaction's load and its save, so
    `save(if_unchanged=True)` refuses -- AFTER the issue has been closed
    upstream. The old message was `RECEIPT NOT RECORDED`, the words for
    "nothing happened", over a world where the issue IS closed.

    Driven through `main()` because that is where the message lives. The value
    that breaks it: a message that does not name the upstream close, which is
    arm GH10 -- and the assertion is on the MESSAGE, not on a count, because
    the behaviour (rc=1, nothing saved) is identical either way.
    """
    seed = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    seed.upsert(717, "a console surface", "W5-console", lane="lane:console", size=1)
    seed.upsert(718, "another", "W6-ci", lane="lane:ci", size=1)
    seed.save()
    state = str(tmp_path / "state.json")

    spy = _gh(monkeypatch)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run())
    monkeypatch.setattr(tick, "STATE_PATH", state)

    real_close = tick.close_issue_on_github

    def close_then_a_rival_writes(*args, **kwargs):
        note = real_close(*args, **kwargs)          # the upstream write LANDS
        rival = Ledger(state, receipts=POLICY["receipts"]).load()
        rival.record_receipt(718, "ci-green", "green at sha")
        rival.transition(718, CLOSED, "the rival closed it")
        rival.save()
        return note

    monkeypatch.setattr(tick, "close_issue_on_github", close_then_a_rival_writes)
    monkeypatch.setattr(sys, "argv", ["tick.py", "--record-receipt", "717", "--from-run", "1"])

    assert tick.main() == 1
    err = capsys.readouterr().err
    assert spy.closed == ["717"], "the close must have LANDED for this to be the case under test"
    assert "THE ISSUE IS CLOSED UPSTREAM" in err
    assert "RE-RUN THE SAME COMMAND" in err
    assert "RECEIPT NOT RECORDED" not in err, (
        "'not recorded' is the wording for 'nothing happened', and the issue is "
        "closed on GitHub"
    )
    final = Ledger(state, receipts=POLICY["receipts"]).load()
    assert final.items[717].state == READY, "the ledger must be the one that did not move"
    assert final.items[718].state == CLOSED, "the rival's close must survive"


def test_a_refusal_before_the_close_still_says_nothing_was_written(tmp_path, monkeypatch, capsys):
    """THE CONTROL FOR THE TWO ABOVE, and the reason the wording can be trusted:
    a genuine pre-close refusal must still print the refusal words, and must
    NOT claim an upstream close.

    Would fail if every path printed the post-close message -- i.e. if the fix
    for R7 on the reverse path had been to change one string for all of them.
    """
    seed = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    seed.upsert(719, "a console surface", "W5-console", lane="lane:console", size=1)
    seed.save()
    spy = _gh(monkeypatch)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run(conclusion="failure"))
    monkeypatch.setattr(tick, "STATE_PATH", str(tmp_path / "state.json"))
    monkeypatch.setattr(sys, "argv", ["tick.py", "--record-receipt", "719", "--from-run", "1"])

    assert tick.main() == 1
    err = capsys.readouterr().err
    assert "RECEIPT REFUSED - NOTHING WRITTEN, ON GITHUB OR IN THE LEDGER" in err
    assert "CLOSED UPSTREAM" not in err
    assert spy.calls == [], "a refused receipt must not have reached GitHub at all"


def test_blocker_a_non_cas_save_failure_after_a_landed_close_is_not_silent(
    tmp_path, monkeypatch, capsys
):
    """A SILENT FAILURE INSIDE THE FIX FOR SILENT FAILURES, found by a reviewer.

    The save arm used to catch `LedgerChangedError` only. With `os.replace`
    raising `PermissionError` -- an antivirus scan, a locked file, a full disk
    -- the exception escaped `main()` UNCAUGHT while the issue was closed
    upstream: #4545 with extra steps, the two records disagreeing and nothing
    saying so.

    CORRECTION (round 7). This docstring, and five other sites, said the escape
    left an **empty stderr**. It does not. `tick.py` ends in
    `raise SystemExit(main())`, so an exception that escapes `main()` escapes to
    the interpreter and prints a traceback; the emptiness was an artifact of
    measuring through `capsys`. Measured as a real process against a sandbox
    copy carrying arm GH12: exit 1 and ~650 bytes of traceback naming
    `led.save(if_unchanged=True)` and `os.replace`, against ~520 bytes of the
    intended message on the unmutated source. Those byte totals are
    ENVIRONMENT-DEPENDENT -- they move with sandbox path length and run id, and
    an independent re-measurement on a different sandbox read 647 / 579 -- so
    they are orders of magnitude, not constants. The invariant is that the exit
    code is 1 EITHER WAY. What is actually wrong under the
    narrow bound is that the operator is handed a file-rename traceback that
    never mentions the issue being closed upstream, at the SAME exit code.

    THE VALUE THAT MAKES THIS FAIL is therefore `tick.main()` RAISING instead of
    returning 1, and the `try` below is what turns that into a named failure
    rather than an error four lines from the assertion that claims to catch it.
    It also fails if the message stops naming the exception TYPE -- a lost CAS
    and a filesystem failure are different diagnoses and this code cannot tell
    the reader apart otherwise.
    """
    seed = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    seed.upsert(722, "a console surface", "W5-console", lane="lane:console", size=1)
    seed.save()
    state = str(tmp_path / "state.json")

    spy = _gh(monkeypatch)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run())
    monkeypatch.setattr(tick, "STATE_PATH", state)
    monkeypatch.setattr(sys, "argv", ["tick.py", "--record-receipt", "722", "--from-run", "1"])

    def no_replace(*_a, **_k):
        raise PermissionError(13, "The process cannot access the file")

    # THE REAL SAVE PATH RUNS; only the last syscall fails. Patching `save`
    # itself would test the except clause against a stub rather than against
    # the failure the reviewer measured.
    monkeypatch.setattr(ledger_module.os, "replace", no_replace)

    try:
        rc = tick.main()
    except BaseException as exc:  # the ESCAPE is the defect this arm produces
        pytest.fail(
            f"main() let {type(exc).__name__} ESCAPE instead of returning 1 "
            "(arm GH12). The operator gets an unhandled traceback naming "
            "os.replace and NOTHING saying the issue is closed upstream, at the "
            "same exit code as the handled path."
        )
    err = capsys.readouterr().err
    assert rc == 1
    assert spy.closed == ["722"], "the close must have LANDED for this to be the case under test"
    # DISCLOSED, NOT COUNTED (assertion-design.md "done" #5). This assertion has
    # NO KILL POWER AGAINST GH12: under the narrow bound the `try` above fails
    # the test first, so `readouterr()` is never reached on that input. It is a
    # regression guard against a DIFFERENT shape -- an arm that keeps `return 1`
    # and drops the `print` -- which no arm in `mutate_gates.py` expresses
    # today. It is not evidence for the width of the `except`; the `try` above
    # is.
    assert err.strip(), "a `return 1` with no message would be a silent failure"
    assert "THE ISSUE IS CLOSED UPSTREAM" in err
    assert "PermissionError" in err, "a lost CAS and a filesystem failure are different diagnoses"
    final = Ledger(state, receipts=POLICY["receipts"]).load()
    assert final.items[722].state == READY, "the ledger must be the one that did not move"


def test_blocker_an_unreadable_verification_is_not_confirmed_not_did_not_complete(
    tmp_path, monkeypatch, capsys
):
    """R7 IN THE HEADLINE, the mirror of the care already taken in the body.

    `gh issue close` returns 0 and the read-back hits a 502: the close LANDED
    and this tool cannot say so. A headline reading "DID NOT COMPLETE" is as
    false as the "still open" claim the body is careful not to make -- it just
    fails in the other direction.

    The value that makes this fail is the word: `DID NOT COMPLETE` in the
    headline (arm GH13). The body's own honesty is asserted alongside it --
    "does not know" must still be there, so the fix cannot be a swap of one
    false claim for another.
    """
    seed = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    seed.upsert(723, "a console surface", "W5-console", lane="lane:console", size=1)
    seed.save()
    state = str(tmp_path / "state.json")

    spy = _gh(monkeypatch, view_fails_after_close=True)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run())
    monkeypatch.setattr(tick, "STATE_PATH", state)
    monkeypatch.setattr(sys, "argv", ["tick.py", "--record-receipt", "723", "--from-run", "1"])

    assert tick.main() == 1
    err = capsys.readouterr().err
    assert spy.closed == ["723"], "the close must have LANDED for this to be the case under test"
    assert "GITHUB CLOSE NOT CONFIRMED" in err
    assert "DID NOT COMPLETE" not in err, (
        "the close landed; saying it did not complete is a false claim in the "
        "opposite direction from 'still open'"
    )
    assert "does not know whether the issue is open" in err
    final = Ledger(state, receipts=POLICY["receipts"]).load()
    assert final.items[723].state == READY
    assert final.items[723].receipt_kind is None


def test_blocker_a_park_is_never_closed_on_github(monkeypatch):
    """#4535 FROM THE OTHER SIDE, and the constraint this change must not break.

    A park is BLOCKED, not done: its issue is supposed to stay open, and a
    harness that closed it would re-create the lie that issue refused. Same for
    a decline, which has no unattended path and whose disposal carries a
    `--reason` no program decided.

    DISCLOSED: no production caller passes anything but `closed` today, so this
    test drives the closer DIRECTLY. It is a fail-closed precondition for the
    park/decline routes that do not exist yet, and the value that breaks it is
    `CLOSES_ON_GITHUB` growing a second member -- which is arm GH3.
    """
    spy = _gh(monkeypatch)
    for state in (PARKED, DECLINED):
        with pytest.raises(tick.IssueCloseFailedError, match="only"):
            tick.close_issue_on_github(
                POLICY, "o/r", 4535, state, "blocked on a tenant",
                "g1-browser", "ui-surface")
    assert spy.calls == [], "the closer reached GitHub before deciding it must not"


def test_the_close_is_refused_when_the_policy_does_not_permit_it(monkeypatch):
    """`policy.permitted_unattended` is the authority, and a policy key read by
    nothing is prose. `gates.action_is_permitted` FAILS CLOSED, so removing
    `close-on-receipt` must stop the write.

    The value that breaks this: a closer that never asks. Note the policy is
    DEEP-COPIED -- the live file keeps the permission, which is the positive
    control every other test in this block runs under.
    """
    thin = copy.deepcopy(POLICY)
    thin["permitted_unattended"] = [
        a for a in thin["permitted_unattended"] if a != "close-on-receipt"
    ]
    spy = _gh(monkeypatch)
    with pytest.raises(tick.IssueCloseFailedError, match="close-on-receipt"):
        tick.close_issue_on_github(
            thin, "o/r", 4545, CLOSED, "a receipt", "ci-green", "guard-or-test-only")
    assert spy.calls == []


def test_blocker_a_harness_close_survives_the_next_refresh(tmp_path, monkeypatch):
    """THE DEFECT END TO END, and the reason this issue is P0 for the drain.

    THE LIVE SET IS DERIVED FROM THE FAKE GITHUB, not written into the fixture.
    The first version of this test transcribed it -- and PASSED against the
    defect, because the refresh's arithmetic was never the broken part. What
    breaks it is the item still being OPEN upstream after the harness closed it
    in the ledger, which is the pre-fix world exactly: #4535 went to
    `needs-audit` with `receipt_kind=None` one cycle after it was closed.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(720, "a console surface", "W5-console", lane="lane:console", size=1)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run())
    spy = _gh(monkeypatch)
    tick.record_receipt_from_evidence(led, POLICY, "o/r", 720, from_pr=None, from_run="1")

    tick.refresh_from_github(led, {}, spy.live([720, 730]))

    assert item.state == CLOSED, "the harness's own close bounced back to needs-audit"
    assert item.receipt_kind == "g1-browser", "the receipt was voided by a false reopen"


def test_positive_control_a_real_reopen_still_voids_the_receipt(tmp_path, monkeypatch):
    """THE HALF THAT MUST NOT BE WEAKENED. `ledger.py`'s void is correct and
    load-bearing; the fix is to stop MANUFACTURING false reopens, not to stop
    noticing real ones.

    Same item, same close -- and then a HUMAN reopens it upstream, so the
    derived live set carries it again. It must be demoted and its receipt
    voided. This is the assertion the test above would satisfy trivially if
    someone 'fixed' #4545 by deleting the dispute branch (arm L5), and the value
    that breaks it is the reopen no longer registering.

    DISCLOSED: this one also passes against the pre-fix code, by construction --
    it pins behaviour this change deliberately leaves alone. It is the control
    for the test above, not additional evidence for the fix.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(721, "a console surface", "W5-console", lane="lane:console", size=1)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1_run())
    spy = _gh(monkeypatch)
    tick.record_receipt_from_evidence(led, POLICY, "o/r", 721, from_pr=None, from_run="1")
    assert item.state == CLOSED

    spy.states["721"] = "OPEN"          # a human reopened it
    tick.refresh_from_github(led, {}, spy.live([721]))

    assert item.state == NEEDS_AUDIT
    assert item.audit_reason == "reopened"
    assert item.receipt_kind is None
