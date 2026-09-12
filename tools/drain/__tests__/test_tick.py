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

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import tick
from ledger import AUDIT_DEPARTED, CLOSED, IN_FLIGHT, NEEDS_AUDIT, PARKED, READY, Ledger

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
