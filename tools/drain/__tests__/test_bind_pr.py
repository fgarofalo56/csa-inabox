"""`--bind-pr` — the writer for `Item.pr`, and the lane's way to report back (#4489).

## What was broken, measured 2026-09-22

`Item.pr` had existed since the ledger was written and nothing wrote it, and
`tick.py` exposed no verb by which a lane could report progress at all. The only
exits from `in-flight` were `--record-receipt` (terminal, and it demands a MERGED
PR or a concluded run) and `--reap` (back to `ready`). A lane that did its work
and opened a PR had nowhere to put that fact.

On the live ledger that cost real work:

    #4495  state=ready  pr=None  "reaped at cycle 13 - lane never returned"
           ... while PR #4564 (fix/4495-op19-function-apps) was OPEN
    #4619  state=ready  pr=None  never laned at all
           ... while PR #4621 (fix/4619-server-derived-scope) was OPEN

Both returned to `ready` and schedulable again, so the next cycle could pay for
the same work twice. Across 14 cycles the ledger recorded 46 "lane never
returned" events and nothing reached a terminal state after 2026-09-17.

## What each test would fail on

Named per `assertion-design.md`, because a test whose breaking input cannot be
named is not coverage:

- the happy path fails if the writer stops setting `pr` OR stops moving the
  state — those are two separate halves and the suite pins both, since a bind
  that records the PR but leaves the item `in-flight` still gets reaped;
- the refusals fail if any guard is dropped, and each asserts NOTHING WAS
  WRITTEN rather than only that an exception was raised — a refusal that still
  mutates is the defect that matters;
- `test_unreadable_pr_is_not_absent` fails if a failed `gh` read is treated as
  "no such PR" (deploy-integrity R7);
- `test_bind_is_idempotent` fails if a re-bind of the SAME pr raises, which
  would punish a lane for retrying after a dropped connection.

Run: python -m pytest tools/drain/__tests__/test_bind_pr.py
"""
from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import tick
from ledger import IN_FLIGHT, IN_REVIEW, NEEDS_AUDIT, READY, Ledger, LedgerChangedError

import gates

POLICY = gates.load_policy(os.path.join(os.path.dirname(__file__), "..", "policy.json"))
REPO = "owner/repo"


def _led(tmp_path, numbers=(1000,)) -> Ledger:
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    for n in numbers:
        led.upsert(n, f"issue {n}", "W6-ci", lane="lane:ci", size=1)
    return led


def _stub_gh(monkeypatch, *, pr_rc=0, pr_state="OPEN", references=True,
             expect_refs_args=None):
    """Answer the two reads `bind_pr_for_item` makes.

    `references` drives `_pr_references_item`, which is stubbed rather than fed
    synthetic API payloads: it has its own suite, and re-implementing its two
    surfaces here would test the fixture instead of the writer.
    """
    def fake_sh(args):
        if args[:3] == ["gh", "pr", "view"]:
            if pr_rc != 0:
                return pr_rc, "", "could not resolve host: github.com"
            return 0, json.dumps(
                {"number": int(args[3]), "state": pr_state, "headRefName": "fix/x"}
            ), ""
        raise AssertionError(f"unexpected command: {args}")

    monkeypatch.setattr(tick, "sh", fake_sh)

    def fake_refs(_repo, pr_number, item):
        # PIN THE ARGUMENT ORDER. Production calls
        # `_pr_references_item(repo, pr, number)` against a signature of
        # `(repo, pr_number, item)`. A stub that ignores its arguments cannot
        # witness a swap, so `(repo, number, pr)` — asking whether PR #1000
        # references issue #4564 — would pass every test here while checking
        # the wrong thing entirely. This assertion is what makes the swap red.
        assert expect_refs_args is None or (pr_number, item) == expect_refs_args, (
            f"_pr_references_item called with {(pr_number, item)}, "
            f"expected {expect_refs_args} — arguments swapped?"
        )
        if not references:
            raise tick.ReceiptRefusedError(f"PR #{pr_number} does not name #{item}")

    monkeypatch.setattr(tick, "_pr_references_item", fake_refs)


# ---------------------------------------------------------------------------
# The happy path — BOTH halves


def test_bind_records_the_pr_and_moves_the_state(tmp_path, monkeypatch):
    """BREAKS ON: removing `item.pr = pr`, or removing the transition.

    The two are pinned separately on purpose. A writer that records the PR but
    leaves the item `in-flight` is still reaped as "lane never returned", which
    is the whole defect; and a transition without the binding leaves gate 3b's
    corroboration inert, which is #4489's.
    """
    led = _led(tmp_path)
    led.transition(1000, IN_FLIGHT, "selected")
    _stub_gh(monkeypatch, expect_refs_args=(4564, 1000))

    said = tick.bind_pr_for_item(led, REPO, 1000, 4564)

    assert led.items[1000].pr == 4564, "the PR must be recorded on the item"
    assert led.items[1000].state == IN_REVIEW, (
        "an in-flight item must leave in-flight, or the reaper takes it back"
    )
    assert "4564" in said
    assert any("4564" in h for h in led.items[1000].history), (
        "the bind must leave a history line; a binding with no record of when "
        "it happened is not auditable"
    )


def test_bind_while_ready_also_leaves_the_schedulable_pool(tmp_path, monkeypatch):
    """#4619's shape: a PR exists for an item the ledger never laned.

    The FIRST version of this test asserted the opposite — that a `ready` item
    keeps its state — on the reasoning that inventing a lane that never ran
    would be a lie. A reviewer measured what that costs: `select_cycle` skips
    anything `!= READY`, so a bound `ready` item stays SELECTABLE, the next
    cycle hands it to a second lane, and that lane cannot even report back
    because a re-bind to a DIFFERENT PR is refused. "Pay for the work twice" —
    the exact harm this writer exists to stop — on the exact case #4489 cites.

    BREAKS ON: restoring the state-preserving branch for `ready` items. The
    assertion below then reads `ready` and the item is schedulable again.
    """
    led = _led(tmp_path)
    _stub_gh(monkeypatch, expect_refs_args=(4621, 1000))

    tick.bind_pr_for_item(led, REPO, 1000, 4621)

    assert led.items[1000].pr == 4621
    assert led.items[1000].state == IN_REVIEW, (
        "a bound ready item must leave the schedulable pool, or a second lane "
        "redoes the work and then cannot report it"
    )
    assert not led.items[1000].schedulable or led.items[1000].state != READY


def test_a_bound_item_is_not_handed_to_a_second_lane(tmp_path, monkeypatch):
    """The property finding 2 is really about, pinned through `select_cycle`.

    Asserting the STATE is a proxy; asserting that the selector does not pick
    the item is the thing that matters, and it is what fails if anyone later
    makes `in-review` schedulable again.

    BREAKS ON: the bind leaving a `ready` item in `ready` (the original bug —
    `select_cycle` then returns it), or `select_cycle` being widened past
    `state == READY`.
    """
    led = _led(tmp_path)
    _stub_gh(monkeypatch, expect_refs_args=(4621, 1000))

    before = [i.number for i in tick.select_cycle(led, POLICY)]
    assert 1000 in before, (
        "control: the item must be selectable BEFORE the bind, or this test "
        "would pass against a selector that never returns anything"
    )

    tick.bind_pr_for_item(led, REPO, 1000, 4621)

    after = [i.number for i in tick.select_cycle(led, POLICY)]
    assert 1000 not in after, "a bound item must not be handed to a second lane"


def test_binding_a_needs_audit_item_does_not_empty_the_audit_queue(tmp_path, monkeypatch):
    """A bind must not discharge a receipt dispute as a side effect.

    This is the gap a reviewer found in the PREVIOUS round's fix, and the
    coverage gap that let it through: the fix made EVERY bind transition to
    `in-review`, which silently moved a `needs-audit` item out of the audit
    queue — and it never returns, because `upsert`'s reopen branch fires only
    from a TERMINAL `was_state`. `transition()` clears `audit_reason` only on
    terminal, so the item also kept an orphaned reason. No test in the suite
    witnessed the difference in either direction, which is why the round-2 fix
    passed 652 tests while introducing it.

    BREAKS ON: widening the guard back to an unconditional
    `led.transition(number, IN_REVIEW, ...)`. The item then reads `in-review`
    and leaves `audit_queue()`.
    """
    led = _led(tmp_path)
    led.items[1000].audit_reason = "reopened"
    led.transition(1000, NEEDS_AUDIT, "receipt disputed")
    _stub_gh(monkeypatch, expect_refs_args=(4564, 1000))

    assert [i.number for i in tick.audit_queue(led)] == [1000], (
        "control: the item must be IN the audit queue before the bind, or this "
        "test would pass against a queue that is always empty"
    )

    tick.bind_pr_for_item(led, REPO, 1000, 4564)

    assert led.items[1000].pr == 4564, "the binding itself is still recorded"
    assert led.items[1000].state == NEEDS_AUDIT, (
        "a disputed receipt is not discharged by a lane opening a PR"
    )
    assert [i.number for i in tick.audit_queue(led)] == [1000], (
        "the item must still be queued for audit"
    )


def test_bind_is_idempotent_for_the_same_pr(tmp_path, monkeypatch):
    """BREAKS ON: refusing a re-bind of the SAME pr.

    A lane whose connection drops mid-command must be able to re-run without
    first working out whether the write landed.
    """
    led = _led(tmp_path)
    led.transition(1000, IN_FLIGHT, "selected")
    _stub_gh(monkeypatch)

    tick.bind_pr_for_item(led, REPO, 1000, 4564)
    tick.bind_pr_for_item(led, REPO, 1000, 4564)  # must not raise

    assert led.items[1000].pr == 4564


# ---------------------------------------------------------------------------
# The refusals — each asserts NOTHING WAS WRITTEN, not merely that it raised


def test_unknown_item_is_refused(tmp_path, monkeypatch):
    """BREAKS ON: dropping the membership check — `led.items[number]` would
    raise `KeyError` and print a traceback instead of a refusal."""
    led = _led(tmp_path)
    _stub_gh(monkeypatch)
    with pytest.raises(tick.PrBindRefusedError, match="not in the ledger"):
        tick.bind_pr_for_item(led, REPO, 9999, 4564)


def test_terminal_item_is_refused_and_nothing_written(tmp_path, monkeypatch):
    """BREAKS ON: dropping the terminal guard. Binding a PR to a closed item
    asserts work is in flight that is not."""
    led = _led(tmp_path)
    led.transition(1000, "declined", why="out of scope, decided by the operator")
    _stub_gh(monkeypatch)

    with pytest.raises(tick.PrBindRefusedError, match="terminal"):
        tick.bind_pr_for_item(led, REPO, 1000, 4564)
    assert led.items[1000].pr is None, "a refusal must not write"


def test_rebinding_to_a_different_pr_is_refused(tmp_path, monkeypatch):
    """BREAKS ON: dropping the poach check.

    Two PRs claiming one item is what `merge_gate.poached_closes()` refuses at
    merge time; refusing it at the source is cheaper and names the conflict
    while both PRs are still open.
    """
    led = _led(tmp_path)
    led.transition(1000, IN_FLIGHT, "selected")
    _stub_gh(monkeypatch)
    tick.bind_pr_for_item(led, REPO, 1000, 4564)

    with pytest.raises(tick.PrBindRefusedError, match="already bound"):
        tick.bind_pr_for_item(led, REPO, 1000, 9999)
    assert led.items[1000].pr == 4564, "the original binding must survive"


def test_unreadable_pr_is_not_absent(tmp_path, monkeypatch):
    """BREAKS ON: treating a non-zero `gh` exit as 'no such PR'.

    deploy-integrity R7, and the exact shape this repo has paid for twice: a
    discarded or misread stderr turned 'I could not reach the registry' into
    'the tag does not exist'. The message must say UNKNOWN and nothing may be
    written.
    """
    led = _led(tmp_path)
    led.transition(1000, IN_FLIGHT, "selected")
    _stub_gh(monkeypatch, pr_rc=1)

    with pytest.raises(tick.PrBindRefusedError, match="UNKNOWN"):
        tick.bind_pr_for_item(led, REPO, 1000, 4564)
    assert led.items[1000].pr is None
    assert led.items[1000].state == IN_FLIGHT, "state must not move on a failed read"


def test_pr_that_does_not_name_the_item_is_refused(tmp_path, monkeypatch):
    """BREAKS ON: dropping the `_pr_references_item` call.

    Without it the binding is only an integer the caller typed — which is the
    precise weakness #4489 says `Item.pr` exists to remove, so a writer that
    skips it records something no stronger than the author's own claim.
    """
    led = _led(tmp_path)
    led.transition(1000, IN_FLIGHT, "selected")
    _stub_gh(monkeypatch, references=False)

    with pytest.raises(tick.PrBindRefusedError, match="does not name"):
        tick.bind_pr_for_item(led, REPO, 1000, 4564)
    assert led.items[1000].pr is None


# ---------------------------------------------------------------------------
# Concurrency — #4489's "do not reintroduce an unlocked read-modify-write"


def test_save_helper_refuses_a_lost_update(tmp_path):
    """BREAKS ON: `_save_refusing_lost_update` calling `save()` without
    `if_unchanged=True`.

    `Ledger.save()` serialises the whole document from memory, so a second
    lane's plain save does not merge the first lane's transitions — it erases
    them. Both reviewers of the earlier `merge_gate.bind_pr` attempt reproduced
    that independently, which is why the write moved here.
    """
    state = str(tmp_path / "state.json")
    seed = Ledger(state, receipts=POLICY["receipts"])
    seed.upsert(1000, "issue 1000", "W6-ci", lane="lane:ci", size=1)
    seed.save()

    mine = Ledger(state, receipts=POLICY["receipts"]).load()

    rival = Ledger(state, receipts=POLICY["receipts"]).load()
    rival.upsert(1001, "issue 1001", "W6-ci", lane="lane:ci", size=1)
    rival.save()

    mine.items[1000].pr = 4564
    with pytest.raises(LedgerChangedError):
        tick._save_refusing_lost_update(mine)

    with open(state, encoding="utf-8") as fh:
        on_disk = json.load(fh)
    assert {i["number"] for i in on_disk["items"]} == {1000, 1001}, (
        "the rival's write must survive; a lost update is the failure this pins"
    )
