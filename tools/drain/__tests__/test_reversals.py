"""`--unpark` and `--undecline` -- the way OUT of a terminal state (#4699).

## What was broken, measured 2026-09-24

`parked` and `declined` became reachable on 2026-09-24 (#4677) and were
IRREVERSIBLE the same day. There is no `--unpark`; `--reap` returns only
`in-flight` items; `REOPEN_DISPUTES` deliberately excludes `parked`; and
`record_receipt_from_evidence` refuses a terminal item outright. So the harness's
FIRST REAL PARK stranded its item:

    #2958 parked on "no in-VNet runner can start (gh-aca-runner has sat at
    maxExecutions:0 since 2026-09-13)" -- a finding carried from an earlier
    comment and not re-verified at head. Measured hours later: maxExecutions 5,
    101 executions all Succeeded. The receipt the issue owed was then captured
    (run 36037056251, 22 steps, a 5,756,355-byte artifact) and the harness said:

        RECEIPT REFUSED - NOTHING WRITTEN, ON GITHUB OR IN THE LEDGER:
        #2958 is already parked - re-recording would rewrite a terminal item's
        evidence

That refusal is CORRECT and nothing here weakens it. A park is supposed to be
cheap to make, and a cheap-to-make, impossible-to-undo terminal state is a
ratchet: every mistaken or time-limited park permanently removes an item from
the drain, and a blocker clearing is the EXPECTED case, not the exceptional one.

## The constraint that shapes the whole design

`REOPEN_DISPUTES` excludes `parked` because of **#4535**: keyed on `TERMINAL`,
every refresh demoted every park, `needs-audit` is non-terminal, and `drained()`
-- this program's documented exit condition -- became unreachable for anything
genuinely blocked. **#2874 is the ITEM that demonstrated it** -- a bicep-drift
issue, parked and demoted thirteen seconds later -- NOT the defect's tracking
issue. #4699 and several comments in this package cite `#2874` as though it were
the latter; both numbers are named here so the swap is not inherited again.

**The property that makes a park stable is the same one that makes it
irreversible.** So the remedy cannot be a looser refresh. It is an EXPLICIT
verb, and the tests below pin BOTH halves of that: the verb works, AND the
refresh and the reaper still leave a terminal item completely alone. The second
half is the arm most easily missed, because the new verb and the #4535 guard
pull in opposite directions -- `test_reopen_disputes_still_excludes_parked_and_the_verb_is_the_only_way_out`
is the negative control, and it asserts on the CONSTANT as well as on behaviour.

## What each test would fail on

Named per `assertion-design.md`. Summarised, with the arm that turns each red
(the arms live in `mutate_gates.py` as `UP1`-`UP9`):

- **UP1**, the reason check deleted: a reasonless reversal SUCCEEDS. This is a
  STRONGER mutation than the disposition arms' equivalents -- `transition(n,
  READY, why)` has no `why` refusal at all, so unlike `--decline` there is no
  ledger-level backstop. `test_a_reversal_refuses_without_a_reason` reds on
  `calls == []` for the empty and blank parameters (the mutant reaches the post)
  and on the class assertion for `None` (it dies on `None.strip()` one line
  earlier), which is the same three-way split `test_dispositions.py` measured
  rather than reasoned about.
- **UP2**, the state guard deleted: `--unpark` reverses a `declined` item, or a
  `ready` one. `test_a_reversal_refuses_an_item_in_the_wrong_state` reds.
- **UP3**, the closed-issue refusal deleted:
  `test_a_reversal_refuses_a_closed_issue` reds.
- **UP4**, the authority bar deleted:
  `test_a_reversal_is_gated_on_the_autonomy_contract` reds on its two
  verb-specific parameters.
- **UP5**, `policy.json` revokes `unpark-item`: the same test reds. This is the
  arm that proves the policy grant has a BLAST RADIUS rather than being prose.
- **UP6**, the read-back comparison deleted: a mojibaked comment is accepted.
  `test_a_reversal_refuses_when_the_posted_text_does_not_read_back` reds.
- **UP7**, the blocker/owner clear deleted: a `ready` item carries a stale
  blocker. `test_unpark_returns_the_item_to_ready_and_clears_the_stale_blocker`
  reds.
- **UP8**, the reaper widened to every non-`ready` item:
  `test_neither_a_refresh_nor_a_reap_reaches_a_terminal_item` reds.
- **UP9**, the history stops naming the prior state: the happy-path tests red.

Run: python -m pytest tools/drain/__tests__/test_reversals.py
"""
from __future__ import annotations

import json
import os
import re
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import tick
from build_inventory import stream_for
from ledger import (
    CLOSED,
    CLOSES_ON_GITHUB,
    DECLINED,
    IN_FLIGHT,
    IN_REVIEW,
    NEEDS_AUDIT,
    PARKED,
    READY,
    REOPEN_DISPUTES,
    TERMINAL,
    Ledger,
    LedgerChangedError,
)

import gates

POLICY = gates.load_policy(os.path.join(os.path.dirname(__file__), "..", "policy.json"))
REPO = "owner/repo"

#: The live case #4699 is about, used as a fixture number so the tests read as
#: the work they were written for. NOT reversed anywhere real -- these are
#: integers in a `tmp_path` ledger and no test here touches `tools/drain/state.json`.
STRANDED_BY_A_CLEARED_BLOCKER = 2958
#: The decline side, from #4677's own list.
BOT_FILED_SELF_RESOLVED = 4534

#: A comment id the stub hands back, so the read-back has something to fetch.
POSTED_COMMENT_ID = "5819347261"


def _led(tmp_path, numbers=(STRANDED_BY_A_CLEARED_BLOCKER,)) -> Ledger:
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    for n in numbers:
        led.upsert(n, f"issue {n}", "W6-ci", lane="lane:ci", size=1)
    return led


def _live(numbers, labels=("lane:ci", "sp:1")):
    return [
        {"number": n, "title": f"issue {n}", "labels": [{"name": x} for x in labels]}
        for n in numbers
    ]


def _stub_gh(
    monkeypatch, *, issue_state="OPEN", view_rc=0, comment_rc=0, comment_err="",
    comment_url=None, readback_rc=0, corrupt=None,
    view_err="could not resolve host: github.com",
):
    """Record every argv `tick.sh` is handed and answer all three sub-commands.

    THREE, not two, and that is the whole difference from `test_dispositions.py`'s
    stub: a reversal POSTS and then READS THE POST BACK, because `gh` has posted
    a UTF-8 body as cp1252 mojibake at exit 0 in this repo and the reversal's
    reason is published verbatim.

    `corrupt` is a CALLABLE applied to the body on the way back out, so a test can
    make the read-back disagree with what was sent. It is a function rather than a
    fixed string because the assertion under test is "these two differ", and a
    fixture that returned a constant could not distinguish "compares the bodies"
    from "rejects one known string".

    `view_err` IS A PARAMETER AND WAS NOT, and that omission is why a real crash
    shipped past a test written to cover it. The failed-read stderr was
    hard-coded to `"could not resolve host: github.com"` -- BRACE-FREE -- while
    the refusal it feeds was built by `.format()` over an f-string chain. Ask
    what result that instrument could not have produced: exactly the one it was
    written to catch. With `HTTP 502: {"message":"Bad gateway"}` the refusal
    raised `KeyError: '"message"'` instead, and the `ReversalRefusedError` was
    never constructed at all. A `{` in `gh`'s stderr is the value that breaks it.

    Each knob is SEPARATE (`view_rc`, `comment_rc`, `readback_rc`) so a test can
    fail exactly the call its name claims. Collapsing them is how a test comes to
    exercise a different branch than the one it is written about -- the
    fixture-never-reaches-the-rule shape `assertion-design.md` is about.
    """
    calls: list[list[str]] = []
    posted: list[str] = []

    def fake_sh(args):
        calls.append(list(args))
        if args[:3] == ["gh", "issue", "view"]:
            if view_rc != 0:
                return view_rc, "", view_err
            asked = args[args.index("--repo") + 1]
            return 0, json.dumps({
                "state": issue_state,
                "title": "an issue",
                "url": f"https://github.com/{asked}/issues/{args[3]}",
            }), ""
        if args[:3] == ["gh", "issue", "comment"]:
            if comment_rc != 0:
                return comment_rc, "", comment_err or "server error"
            posted.append(args[args.index("--body") + 1])
            asked = args[args.index("--repo") + 1]
            url = comment_url if comment_url is not None else (
                f"https://github.com/{asked}/issues/{args[3]}"
                f"#issuecomment-{POSTED_COMMENT_ID}\n"
            )
            return 0, url, ""
        if args[:2] == ["gh", "api"]:
            if readback_rc != 0:
                return readback_rc, "", "HTTP 502"
            body = posted[-1] if posted else ""
            return 0, json.dumps({"body": corrupt(body) if corrupt else body}), ""
        raise AssertionError(f"unexpected gh call: {args}")

    monkeypatch.setattr(tick, "sh", fake_sh)
    return calls, posted


def _verbs(calls) -> list[tuple[str, str]]:
    return [(c[1], c[2]) for c in calls if c[0] == "gh"]


def _refusal(call) -> BaseException:
    """Run `call`, require that it raised SOMETHING, hand the exception back.

    DELIBERATELY WIDE, for the reason `test_dispositions.py`'s twin is: under the
    very mutation a refusal test exists to kill, a NARROWER `pytest.raises` fails
    on the class mismatch and the `calls == []` assertion NEVER EXECUTES -- so the
    arm scores killed while the claim about WHICH assertion has the kill power is
    false. Catching here lets both assertions run on every arm.
    """
    with pytest.raises(Exception) as caught:  # noqa: PT011 - see the docstring
        call()
    return caught.value


# ---------------------------------------------------------------------------
# The happy paths -- state, history, the cleared blocker, and the PUBLIC record
# ---------------------------------------------------------------------------


def test_unpark_returns_the_item_to_ready_and_clears_the_stale_blocker(
    monkeypatch, tmp_path
):
    """WHAT MAKES THIS FAIL, four separate ways, and each is a real defect.

    - stop transitioning: the item stays `parked`, `drained()` stays true and
      the queue never sees it again. That is the whole of #4699.
    - stop clearing `blocker`/`owner`: the ledger reads `state=ready
      blocker='no in-VNet runner exists'`, which a cold reader cannot tell from
      a live blocker on a schedulable item -- and `ledger.transition`'s park bar
      is only that BOTH fields are truthy, so a later `--park` with no
      `--blocker` would be accepted on the STALE one. That is the `L30`
      `audit_reason` defect, one field over.
    - stop naming the PRIOR STATE in the history line: the round trip stops being
      auditable, which is half of what the issue asks for.
    - stop writing the reason into the history: the same half, other end.

    The item is built through the REAL `--park` verb rather than by setting
    `.state` directly, because what is being pinned is that a park reached the
    normal way can be reversed -- a fixture that assembled the item by hand could
    pass over a `_dispose` that recorded something the reversal cannot read.
    """
    led = _led(tmp_path)
    _stub_gh(monkeypatch)
    tick.park_item(
        led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER,
        "no in-VNet runner exists to reach the private endpoint", "operator",
    )
    assert led.drained() is True, (
        "the precondition: if the park did not land, everything below measures "
        "the wrong thing"
    )

    said = tick.unpark_item(
        led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER,
        "gh-aca-runner is at maxExecutions:5 with 101 Succeeded executions; the "
        "blocker cited at park time was already false when it was written",
    )

    item = led.items[STRANDED_BY_A_CLEARED_BLOCKER]
    assert item.state == READY
    assert item.blocker is None, (
        "a stale blocker on a schedulable item reads as a live one, and "
        "`transition`'s park bar would accept a re-park on it"
    )
    assert item.owner is None
    assert PARKED in item.history[-1], (
        "the history must name the state that was LEFT, or the round trip is "
        "not auditable"
    )
    assert "maxExecutions:5" in item.history[-1]
    assert led.drained() is False, "the item is back in the queue"
    assert f"#{STRANDED_BY_A_CLEARED_BLOCKER}" in said


def test_undecline_returns_a_declined_item_to_ready(monkeypatch, tmp_path):
    """The sibling, and it is a SEPARATE test rather than a parameter.

    WHAT MAKES THIS FAIL: key the reversal on `PARKED` anywhere -- the authority
    action, the head, the state guard -- and this goes red while the unpark test
    stays green. Bundling the two into one parametrised case would let a
    park-only implementation close the finding by its LABEL while the decline
    half stayed open, which is the error `assertion-design.md` names and the
    reason `L27` exists beside `L26`.
    """
    led = _led(tmp_path, numbers=(BOT_FILED_SELF_RESOLVED,))
    _stub_gh(monkeypatch)
    tick.decline_item(
        led, POLICY, REPO, BOT_FILED_SELF_RESOLVED,
        "operator: bot-filed synthetic-monitor alert, auto-resolved",
    )

    tick.undecline_item(
        led, POLICY, REPO, BOT_FILED_SELF_RESOLVED,
        "operator 2026-09-24: the alert recurred, so it is backlog work after all",
    )

    item = led.items[BOT_FILED_SELF_RESOLVED]
    assert item.state == READY
    assert DECLINED in item.history[-1]
    assert "recurred" in item.history[-1]


@pytest.mark.parametrize(
    ("from_state", "seed", "reverse"),
    [
        (
            PARKED,
            lambda led: tick.park_item(
                led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "no runner", "operator"
            ),
            lambda led: tick.unpark_item(
                led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "the runner is up"
            ),
        ),
        (
            DECLINED,
            lambda led: tick.decline_item(
                led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "operator: not backlog"
            ),
            lambda led: tick.undecline_item(
                led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "operator: it recurred"
            ),
        ),
    ],
    ids=["unpark", "undecline"],
)
def test_a_reversal_comments_read_it_back_and_never_touch_the_issue_state(
    monkeypatch, tmp_path, from_state, seed, reverse
):
    """THE ACCEPTANCE LINE, asserted on the argv rather than on a count.

    WHAT MAKES THIS FAIL, three ways:

    - add a `gh issue close` / `gh issue reopen` of its own and the verb list
      goes red. A reversal adjudicates the LEDGER, never the issue's state: the
      issue was open before (the verb refuses a closed one) and stays open.
    - post no comment and the same list goes red on a missing entry. The park's
      own comment says "the harness will not re-select this item on its own",
      and after a reversal that sentence is FALSE -- a reversal recorded only in
      the gitignored `state.json` leaves a wrong sentence standing on a public
      issue (R7).
    - skip the read-back and the `("api",)` entry disappears. That call is the
      only thing standing between a mojibaked correction and the permanent
      record.

    The head is READ from `tick.REVERSAL_HEADS` rather than transcribed, per
    assertion-design #3: a probe carrying its own copy of the string can disagree
    with the implementation and nothing notices.
    """
    led = _led(tmp_path)
    calls, posted = _stub_gh(monkeypatch)
    seed(led)
    calls.clear()
    posted.clear()

    reverse(led)

    assert _verbs(calls) == [
        ("issue", "view"),
        ("issue", "comment"),
        ("api", f"repos/{REPO}/issues/comments/{POSTED_COMMENT_ID}"),
    ], f"a reversal READS, posts ONE comment, and READS IT BACK; ran {calls}"
    assert len(posted) == 1
    assert posted[0].startswith(tick.REVERSAL_HEADS[from_state])


def test_the_reversal_comment_carries_the_reason_verbatim_and_names_the_prior_state(
    monkeypatch, tmp_path
):
    """THE PERMANENT PUBLIC RECORD, and the reason it must not be summarised.

    WHAT MAKES THIS FAIL: truncate, summarise or re-word the reason on the way
    into the body. The park's BLOCKER is published verbatim; a reversal that held
    its own justification to a weaker standard would leave the two halves of one
    public record inconsistent.

    THE UNICODE IS DELIBERATE AND IT IS THE POINT OF THE NEXT TEST: `£` and `é`
    are exactly the characters that survive a cp1252 round trip differently, and
    a reason made only of ASCII could not witness the defect the read-back
    exists for.

    WHAT MAKES THE SECOND ASSERTION FAIL: stop naming the state that was left.
    A correction that does not say what it corrects is not a correction.
    """
    reason = "operator: the runner came back (cost was £0, café-test rerun clean)"
    led = _led(tmp_path)
    _, posted = _stub_gh(monkeypatch)
    tick.park_item(led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "no runner", "op")

    tick.unpark_item(led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, reason)

    body = posted[-1]
    assert reason in body, "the reason is published VERBATIM or not at all"
    assert f"PRIOR STATE: {PARKED}" in body
    assert "NO RECEIPT IS RECORDED BY THIS" in body, (
        "the issue's acceptance: unpark returns it to the queue, closing still "
        "requires the normal receipt path"
    )


# ---------------------------------------------------------------------------
# The read-back -- `gh` has posted UTF-8 as cp1252 mojibake at exit 0 here
# ---------------------------------------------------------------------------


def test_a_reversal_refuses_when_the_posted_text_does_not_read_back(
    monkeypatch, tmp_path
):
    """MUTATION ARM UP6: delete the comparison and a mojibaked correction stands.

    WHAT MAKES THIS FAIL: compare nothing, compare lengths, or compare a prefix.
    The corruption applied here is the MEASURED one -- UTF-8 bytes decoded as
    cp1252 -- and it changes no line ending and no length in characters, so an
    assertion that watched either would witness nothing.

    WHAT IS PINNED BESIDES THE REFUSAL, and it is the half that matters: the
    LEDGER IS UNTOUCHED. The item is still `parked`, so a re-run is legal and the
    operator has not silently lost the park while a wrong comment sits on a
    public issue.

    WHAT THIS INSTRUMENT COULD NOT HAVE PRODUCED, per the note at
    `post_reversal_comment`: a corruption whose exact inverse is applied on the
    READ path would round-trip and agree. This test cannot witness that and does
    not claim to; it witnesses the one-directional shape that was measured.
    """
    corrupt = lambda body: body.encode("utf-8").decode("cp1252", "replace")  # noqa: E731
    led = _led(tmp_path)
    _stub_gh(monkeypatch)
    tick.park_item(led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "no runner", "op")
    _stub_gh(monkeypatch, corrupt=corrupt)
    before = led.items[STRANDED_BY_A_CLEARED_BLOCKER].state

    exc = _refusal(lambda: tick.unpark_item(
        led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER,
        "operator: the runner came back (café, £0)",
    ))

    assert isinstance(exc, tick.ReversalUnverifiedError), (
        "not a plain refusal: a comment IS on the issue, so 'nothing was posted' "
        "would be false"
    )
    assert "does NOT read back" in str(exc)
    assert led.items[STRANDED_BY_A_CLEARED_BLOCKER].state == before == PARKED, (
        "the ledger must be untouched, so the item is still terminal and a "
        "re-run is legal"
    )


def test_a_reversal_refuses_when_the_posted_text_cannot_be_read_back(
    monkeypatch, tmp_path
):
    """The OTHER half, and it is a different claim (R7).

    WHAT MAKES THIS FAIL: report an unreadable read-back as corruption, or as
    success. A 502 on the read-back establishes neither that the text is intact
    nor that it is wrong -- `ReversalUnverifiedError`'s whole name is that
    distinction, and the message must say UNKNOWN rather than pick one.

    Paired with the test above rather than parametrised with it, because the two
    assert on DIFFERENT message content: an absence-only assertion here would be
    satisfied by deleting the read-back entirely (assertion-design #4).
    """
    led = _led(tmp_path)
    _stub_gh(monkeypatch)
    tick.park_item(led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "no runner", "op")
    _stub_gh(monkeypatch, readback_rc=1)

    exc = _refusal(lambda: tick.unpark_item(
        led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "operator: runner is up",
    ))

    assert isinstance(exc, tick.ReversalUnverifiedError)
    assert "UNKNOWN" in str(exc), (
        "an unreadable read-back is not a corrupted one, and saying so asserts a "
        "cause the code did not establish (R7)"
    )
    assert "POSTED" in str(exc), "a comment IS on the issue and the message says so"
    assert led.items[STRANDED_BY_A_CLEARED_BLOCKER].state == PARKED


def test_a_reversal_refuses_when_the_post_returns_no_readable_comment_url(
    monkeypatch, tmp_path
):
    """WHAT MAKES THIS FAIL: fall back to "assume it was fine" on an odd url.

    `gh issue comment` has no `--json`, so the comment id is parsed out of its
    stdout and that is the only route to a read-back. A url shape this tool does
    not recognise means the read-back CANNOT BE PERFORMED, which is a refusal --
    not a pass, and not a claim that the text is broken.
    """
    led = _led(tmp_path)
    _stub_gh(monkeypatch)
    tick.park_item(led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "no runner", "op")
    _stub_gh(monkeypatch, comment_url="https://example.invalid/not-a-comment\n")

    exc = _refusal(lambda: tick.unpark_item(
        led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "operator: runner is up",
    ))

    assert isinstance(exc, tick.ReversalUnverifiedError)
    assert "could NOT be read back" in str(exc)
    assert led.items[STRANDED_BY_A_CLEARED_BLOCKER].state == PARKED


@pytest.mark.parametrize(
    ("url", "expect"),
    [
        ("https://github.com/o/r/issues/1#issuecomment-42\n", "42"),
        ("https://github.com/o/r/issues/1#issuecomment-42", "42"),
        ("https://github.com/o/r/issues/1", ""),
        ("https://github.com/o/r/issues/1#issuecomment-not-a-number", ""),
        ("", ""),
    ],
    ids=["trailing-newline", "bare", "no-fragment", "non-numeric", "empty"],
)
def test_the_comment_id_parser_fails_closed_on_every_shape_it_cannot_read(url, expect):
    """WHAT MAKES THIS FAIL: a `split("-")[-1]` that returns `number` from the
    no-fragment case, or an `isdigit` check that is dropped so `not-a-number`
    comes back as a truthy id and the read-back then 404s with a confusing
    message about corruption.

    The non-numeric and no-fragment rows are the ones with kill power; the two
    positive rows are what stop a fix for them from returning "" always
    (assertion-design #4 -- an absence-only set is satisfied by deleting the
    feature).
    """
    assert tick._comment_id_from_url(url) == expect


# ---------------------------------------------------------------------------
# The refusals -- each one SILENT UPSTREAM
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("missing", [None, "", "   "], ids=["none", "empty", "blank"])
@pytest.mark.parametrize("verb", ["unpark", "undecline"], ids=["unpark", "undecline"])
def test_a_reversal_refuses_without_a_reason(monkeypatch, tmp_path, missing, verb):
    """MUTATION ARM UP1, and it is STRONGER than the disposition arms' twins.

    `--decline`'s CLI check has a ledger-level backstop: `transition` refuses a
    decline whose `why` is empty. A reversal transitions to `READY`, and
    `transition` has NO refusal for `READY` at all -- so deleting this check does
    not merely move WHEN the refusal happens, it removes the refusal entirely and
    a reasonless reversal SUCCEEDS.

    WHAT MAKES THIS FAIL, and it differs by parameter, measured rather than
    reasoned: on `""` and `"   "` the mutant runs to completion and a comment is
    PUBLISHED, so `calls == []` is the assertion that goes red; on `None` the
    mutant dies at `None.strip()` one line later, so the message assertion is
    what goes red instead. The empty/blank pair witnesses the real harm and is
    the reason the parameters are not one.
    """
    led = _led(tmp_path)
    _stub_gh(monkeypatch)
    state = PARKED if verb == "unpark" else DECLINED
    if verb == "unpark":
        tick.park_item(led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "b", "o")
        call = lambda: tick.unpark_item(  # noqa: E731
            led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, missing)
    else:
        tick.decline_item(led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "d")
        call = lambda: tick.undecline_item(  # noqa: E731
            led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, missing)
    calls, _ = _stub_gh(monkeypatch)

    exc = _refusal(call)

    assert calls == [], f"a refused reversal must publish nothing; ran {calls}"
    assert "REASON" in str(exc)
    assert led.items[STRANDED_BY_A_CLEARED_BLOCKER].state == state, (
        "the item stays terminal - a refused reversal changes nothing"
    )


@pytest.mark.parametrize(
    "state", [READY, IN_FLIGHT, IN_REVIEW, NEEDS_AUDIT, CLOSED, DECLINED],
    ids=lambda s: str(s),
)
def test_a_reversal_refuses_an_item_in_the_wrong_state(monkeypatch, tmp_path, state):
    """MUTATION ARM UP2: delete the state guard and `--unpark` reverses anything.

    WHAT MAKES THIS FAIL: accept any state. The `DECLINED` parameter is the one
    with the most teeth -- an `--unpark` that silently reversed a DECLINE would
    record "reversed from parked" in the history of an item that was never
    parked, which is a false line in the only audit trail there is (R7). The
    non-terminal parameters matter for a different reason: they are a typo'd
    issue number, and absorbing one would return somebody else's in-flight item
    to `ready` under a lane that is still working on it.

    `CLOSED` is included deliberately even though a closed item's issue would
    also fail the closed-issue check: the state guard runs FIRST, so this is
    refused before any GitHub call, and `calls == []` is what witnesses that.
    """
    led = _led(tmp_path)
    item = led.items[STRANDED_BY_A_CLEARED_BLOCKER]
    item.state = state  # set directly: several of these are unreachable via a verb
    calls, _ = _stub_gh(monkeypatch)

    exc = _refusal(lambda: tick.unpark_item(
        led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "operator: runner is up",
    ))

    assert calls == [], f"refused before any GitHub call; ran {calls}"
    assert isinstance(exc, tick.ReversalRefusedError)
    assert f"is {state}, not {PARKED}" in str(exc)
    assert led.items[STRANDED_BY_A_CLEARED_BLOCKER].state == state


@pytest.mark.parametrize(
    ("held", "typed"), [(PARKED, DECLINED), (DECLINED, PARKED)],
    ids=["parked-item-typed-undecline", "declined-item-typed-unpark"],
)
def test_the_wrong_state_refusal_names_the_right_verb_for_the_right_state(
    monkeypatch, tmp_path, held, typed
):
    """The mirror, and the MESSAGE is the deliverable -- in BOTH directions.

    WHAT MAKES THIS FAIL: let either verb reverse either state. The two carry
    DIFFERENT justifications -- an unpark says a blocker lifted, an undecline says
    a judgement was withdrawn -- so absorbing the wrong one would publish the
    wrong story verbatim on a public issue.

    WHAT MAKES THE ATTRIBUTION ASSERTION FAIL, and this is the half that shipped
    broken: hard-code `declined` as the noun. `_reverse` computed the other FLAG
    correctly and then named the other STATE from a constant, so `--undecline`
    on a PARKED item said *"A declined item is reversed by --unpark"* -- whose
    second clause contradicts its own first, and hands an operator who typed the
    wrong verb an inverted contract (R7). The predecessor of this test asserted
    only `"--unpark" in str(exc)` and PASSED with the false attribution: a bare
    membership check cannot see which noun the flag was attached to, which is
    the shape this PR rejected one function over and then committed here.

    Both the state and the flag are read from `tick.REVERSAL_FLAGS` rather than
    transcribed (assertion-design #3), so the probe cannot disagree with the
    implementation, and the `held`/`typed` pair makes each direction assert the
    sentence the OTHER direction would also satisfy -- a hard-coded noun passes
    one parameter and reds the other.
    """
    led = _led(tmp_path)
    _stub_gh(monkeypatch)
    if held == PARKED:
        tick.park_item(led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "no runner", "op")
    else:
        tick.decline_item(
            led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "op decided: bot-filed")
    calls, _ = _stub_gh(monkeypatch)
    verb = {PARKED: tick.unpark_item, DECLINED: tick.undecline_item}[typed]

    exc = _refusal(lambda: verb(
        led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "operator: reversed",
    ))

    assert calls == []
    assert isinstance(exc, tick.ReversalRefusedError)
    assert f"is {held}, not {typed}" in str(exc), "diagnose the mismatch"
    assert f"A {held} item is reversed by {tick.REVERSAL_FLAGS[held]}" in str(exc), (
        f"the operator typed {tick.REVERSAL_FLAGS[typed]} at a {held} item and "
        f"needs {tick.REVERSAL_FLAGS[held]} attributed to {held} -- naming the "
        "right flag beside the wrong state is an inverted contract, and a bare "
        "membership check on the flag passes straight through it"
    )
    assert f"A {typed} item is reversed by {tick.REVERSAL_FLAGS[held]}" not in str(exc), (
        "the exact false sentence that shipped: the other state's noun wearing "
        "this state's verb"
    )
    assert led.items[STRANDED_BY_A_CLEARED_BLOCKER].state == held


def test_a_reversal_refuses_a_closed_issue(monkeypatch, tmp_path):
    """MUTATION ARM UP3, and the acceptance line #4699 names by itself.

    WHAT MAKES THIS FAIL: proceed on `CLOSED`. A terminal item whose issue is
    closed has had something happen that the harness did not record -- an
    out-of-band close, the decline's own documented `--reason not-planned`
    disposal, a transfer. Returning it to the queue papers over that, and the
    next refresh would flag the item `departed` anyway, so the re-queue is not
    even durable.

    WHAT IS PINNED BESIDES THE REFUSAL: NO COMMENT WAS POSTED. The read that
    establishes the state happens first, so the refusal costs exactly one
    read-only `gh issue view` and publishes nothing -- asserting `calls == []`
    here would be asserting a property this path does not have, so the assertion
    is on the VERBS.
    """
    led = _led(tmp_path)
    _stub_gh(monkeypatch)
    tick.park_item(led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "no runner", "op")
    calls, posted = _stub_gh(monkeypatch, issue_state="CLOSED")

    exc = _refusal(lambda: tick.unpark_item(
        led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "operator: runner is up",
    ))

    assert isinstance(exc, tick.ReversalRefusedError)
    assert "CLOSED on GitHub" in str(exc)
    assert posted == [], "a refused reversal publishes nothing"
    assert _verbs(calls) == [("issue", "view")], (
        f"one read-only call and no write; ran {calls}"
    )
    assert led.items[STRANDED_BY_A_CLEARED_BLOCKER].state == PARKED


@pytest.mark.parametrize(
    "view_err",
    [
        "could not resolve host: github.com",
        'HTTP 502: {"message":"Bad gateway"}',
        "HTTP 500: {}",
        "gh: {unexpected",
    ],
    ids=["brace-free", "json-body", "empty-braces", "unbalanced-brace"],
)
def test_a_reversal_refuses_when_the_issue_state_cannot_be_read(
    monkeypatch, tmp_path, view_err
):
    """WHAT MAKES THIS FAIL: treat an unreadable issue as open.

    The verb REFUSES a closed issue, so it cannot proceed on an unread one
    either -- "I could not reach GitHub" is not "it is open" (R7, the roll that
    reported "the tag does not exist" over a permission denial).

    WHAT MAKES THE BRACE-BEARING PARAMETERS FAIL, and they are the reason this
    test is parametrised at all: build the refusal with `.format()` over an
    f-string chain. Python concatenates adjacent literals BEFORE the method
    call, so `.format()` then runs over the already-interpolated `{exc}` --
    which carries `gh`'s stderr verbatim. Measured end-to-end through
    `unpark_item`: `KeyError: '"message"'` on the json-body parameter,
    `IndexError: Replacement index 1 out of range` on empty-braces, and
    `ValueError` on the unbalanced one. In every case the `ReversalRefusedError`
    is NEVER CONSTRUCTED, so `isinstance` reds -- and in production `main()`'s
    reversal branch, which catches only the four reversal exceptions, lets the
    bare builtin escape as a traceback.

    THE BRACE-FREE PARAMETER IS THE POSITIVE CONTROL and is not redundant: it is
    the exact string this stub hard-coded before, and it passes against the
    defect. Keeping it beside the others is what makes the pair say "the
    fixture reaches the rule" rather than "the rule is gone".
    """
    led = _led(tmp_path)
    _stub_gh(monkeypatch)
    tick.park_item(led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "no runner", "op")
    calls, posted = _stub_gh(monkeypatch, view_rc=1, view_err=view_err)

    exc = _refusal(lambda: tick.unpark_item(
        led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "operator: runner is up",
    ))

    assert isinstance(exc, tick.ReversalRefusedError), (
        f"a {type(exc).__name__} escaped instead of the refusal; main() catches "
        "only the four reversal exceptions, so this reaches the operator as a "
        f"traceback. stderr was {view_err!r}"
    )
    assert "UNKNOWN" in str(exc)
    assert view_err in str(exc), (
        "the refusal must carry gh's own stderr verbatim - a message that drops "
        "what actually went wrong is the R7 shape this file keeps finding"
    )
    assert f"the item is still {PARKED}." in str(exc), (
        "the tail is the segment `.format()` used to mangle; assert it RENDERED "
        "rather than merely that something was raised"
    )
    assert posted == []
    assert _verbs(calls) == [("issue", "view")], (
        f"the failed read is the ONLY call; ran {calls}"
    )
    assert led.items[STRANDED_BY_A_CLEARED_BLOCKER].state == PARKED


def test_a_reversal_refuses_an_item_the_ledger_does_not_hold(monkeypatch, tmp_path):
    """WHAT MAKES THIS FAIL: `led.items[number]` on a missing key, which is a
    `KeyError` traceback rather than a refusal, and a mistyped issue number is
    the most ordinary input this verb takes."""
    led = _led(tmp_path)
    calls, _ = _stub_gh(monkeypatch)

    exc = _refusal(lambda: tick.unpark_item(led, POLICY, REPO, 999999, "a reason"))

    assert calls == []
    assert isinstance(exc, tick.ReversalRefusedError)
    assert "not in the ledger" in str(exc)


def test_a_failed_comment_leaves_the_ledger_untouched(monkeypatch, tmp_path):
    """WHAT MAKES THIS FAIL: write the ledger before posting, or swallow the
    post failure. The comment goes FIRST precisely so that a failure here leaves
    the item terminal and the record consistent -- the reverse ordering would
    leave an item back in the queue with a public record still calling it
    parked, in a file that is gitignored."""
    led = _led(tmp_path)
    _stub_gh(monkeypatch)
    tick.park_item(led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "no runner", "op")
    _stub_gh(monkeypatch, comment_rc=1, comment_err="HTTP 500")

    exc = _refusal(lambda: tick.unpark_item(
        led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "operator: runner is up",
    ))

    assert isinstance(exc, tick.DispositionCommentFailedError)
    item = led.items[STRANDED_BY_A_CLEARED_BLOCKER]
    assert item.state == PARKED
    assert item.blocker == "no runner", "the park's fields survive a failed reversal"


def test_a_ledger_write_that_fails_after_the_comment_restores_the_item(
    monkeypatch, tmp_path
):
    """WHAT MAKES THIS FAIL: leave the item half-reversed.

    The rollback restores `blocker`/`owner` and truncates the history, so
    `main()` saves an object identical to the one it loaded. Without it the item
    sits with its blocker cleared and its state still `parked` -- and a later
    re-park would be accepted by `transition` on fields that are now None, or
    worse, the history carries a reversal line for a reversal that did not
    happen.
    """
    led = _led(tmp_path)
    _stub_gh(monkeypatch)
    tick.park_item(led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "no runner", "op")
    _stub_gh(monkeypatch)
    before = (
        led.items[STRANDED_BY_A_CLEARED_BLOCKER].state,
        led.items[STRANDED_BY_A_CLEARED_BLOCKER].blocker,
        led.items[STRANDED_BY_A_CLEARED_BLOCKER].owner,
        len(led.items[STRANDED_BY_A_CLEARED_BLOCKER].history),
    )

    def boom(*_a, **_k):
        raise RuntimeError("transition exploded")

    monkeypatch.setattr(led, "transition", boom)
    exc = _refusal(lambda: tick.unpark_item(
        led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "operator: runner is up",
    ))

    assert isinstance(exc, tick.LedgerWriteAfterCommentError)
    assert "the correction is on the issue" in str(exc).lower()
    item = led.items[STRANDED_BY_A_CLEARED_BLOCKER]
    assert (item.state, item.blocker, item.owner, len(item.history)) == before


@pytest.mark.parametrize(
    ("revoke", "verb"),
    [
        ("unpark-item", "unpark"),
        ("undecline-item", "undecline"),
        ("comment", "unpark"),
        ("comment", "undecline"),
    ],
    ids=["unpark-item", "undecline-item", "comment-blocks-unpark", "comment-blocks-undecline"],
)
def test_a_reversal_is_gated_on_the_autonomy_contract(
    monkeypatch, tmp_path, revoke, verb
):
    """MUTATION ARMS UP4 (the call deleted) and UP5 (`policy.json` revokes it).

    `gates.action_is_permitted` FAILS CLOSED so that a capability arrives by a
    deliberate edit to `policy.json` rather than as emergent behaviour. Returning
    an item to the SCHEDULABLE QUEUE is a capability, and riding it on `comment`
    -- the most general write permission in the file -- is the shape a reviewer
    blocked for the dispositions one issue ago.

    WHY THE ACTIONS ARE SEPARATE FROM `park-item`/`decline-item`, and it is the
    inverse of that argument: if an unpark rode on `park-item`, revoking the
    authority to PARK would silently revoke the authority to UNPARK, and every
    already-parked item would be stranded permanently. That is #4699's own
    ratchet, reintroduced by its fix.

    THE POSITIVE CONTROL IS LOAD-BEARING: without it, an action that was never
    granted in the live policy would make this test pass over a permission that
    does not exist -- and `unpark-item` is NEW, so that is not hypothetical.

    `calls == []` for the two verb actions pins that the authority bar runs
    BEFORE the state read, so an unpermitted verb costs zero GitHub calls.
    `comment` is checked at the post, downstream of the read, so it legitimately
    spends one read-only `gh issue view`; asserting `calls == []` there would be
    asserting a property it does not have.
    """
    led = _led(tmp_path)
    _stub_gh(monkeypatch)
    state = PARKED if verb == "unpark" else DECLINED
    if verb == "unpark":
        tick.park_item(led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "b", "o")
    else:
        tick.decline_item(led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "d")

    assert revoke in POLICY["permitted_unattended"], (
        f"positive control: {revoke!r} must be GRANTED in the live policy, or "
        "this test passes over a permission that was never there"
    )
    revoked = dict(POLICY)
    revoked["permitted_unattended"] = [
        a for a in POLICY["permitted_unattended"] if a != revoke
    ]
    calls, posted = _stub_gh(monkeypatch)
    fn = tick.unpark_item if verb == "unpark" else tick.undecline_item

    exc = _refusal(lambda: fn(
        led, revoked, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "operator: reversed"))

    assert posted == [], f"a revoked {revoke!r} must publish nothing; ran {calls}"
    if revoke != "comment":
        assert calls == [], f"an unpermitted {revoke!r} must not even read; ran {calls}"
    assert revoke in str(exc), "the message must name the action that was refused"
    assert led.items[STRANDED_BY_A_CLEARED_BLOCKER].state == state


# ---------------------------------------------------------------------------
# THE #4535 NEGATIVE CONTROL -- the new verb must be the ONLY route out
# ---------------------------------------------------------------------------


def test_reopen_disputes_still_excludes_parked_and_the_verb_is_the_only_way_out(
    monkeypatch, tmp_path
):
    """THE ARM MOST LIKELY TO BE MISSED (#4699 says so by name), because the new
    verb and the #4535 guard pull in OPPOSITE directions.

    #4535: `REOPEN_DISPUTES` was keyed on `TERMINAL`, so every refresh demoted
    every park to `needs-audit` -- which is non-terminal -- and `drained()`
    became unreachable for anything genuinely blocked. **#2874 is the ITEM that
    demonstrated it**, demoted thirteen seconds after it was parked; it is a
    bicep-drift issue and NOT the defect's tracking issue, which is what #4699
    calls it. The obvious way to make a park reversible is to loosen that guard,
    and loosening it restores #4535 exactly.

    SO THIS TEST ASSERTS BOTH HALVES OVER ONE LEDGER, and neither half alone
    would be coverage:

    - `parked` is NOT in `REOPEN_DISPUTES` -- the CONSTANT, read at runtime
      rather than transcribed (assertion-design #3). WHAT MAKES IT FAIL: arm
      `L26`, `REOPEN_DISPUTES = (CLOSED, PARKED, DECLINED)`.
    - a refresh over an OPEN issue leaves the park exactly where it was. WHAT
      MAKES IT FAIL: the same arm, through behaviour rather than through the
      constant, so a future implementation that reads the population from
      somewhere else is still caught.
    - and THEN the explicit verb moves it. WHAT MAKES IT FAIL: a verb that does
      not work. Without this third clause the first two are satisfied by
      deleting the reversal entirely -- an absence-only pair, which is what
      assertion-design #4 forbids and is precisely the pre-#4699 state of the
      world.
    """
    assert PARKED not in REOPEN_DISPUTES, (
        "#4535: a park is BLOCKED, not done - its issue is SUPPOSED to be open, "
        "so being open disputes nothing and a refresh must leave it alone. If "
        "this is how the reversal was implemented, the reversal is wrong."
    )
    assert PARKED in TERMINAL, (
        "the positive half: `parked` is still terminal, so `drained()` still "
        "counts it. A park that stopped being terminal would satisfy the "
        "assertion above for the wrong reason"
    )

    led = _led(tmp_path)
    _stub_gh(monkeypatch)
    tick.park_item(
        led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "no in-VNet runner", "operator",
    )

    # The issue is OPEN, which is a park's EXPECTED condition -- the verb never
    # closes one. Two refreshes, because a demotion that needs two cycles is
    # still a demotion and a single-pass assertion would not see it.
    for _ in range(2):
        tick.refresh_from_github(led, {}, _live((STRANDED_BY_A_CLEARED_BLOCKER,)))
        assert led.items[STRANDED_BY_A_CLEARED_BLOCKER].state == PARKED, (
            "a refresh must NOT be a route out of a park (#4535)"
        )
        assert led.drained() is True

    tick.unpark_item(
        led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER,
        "operator: the runner cleared; re-verified at head",
    )

    assert led.items[STRANDED_BY_A_CLEARED_BLOCKER].state == READY, (
        "the EXPLICIT verb is the route out, and it is the only one"
    )
    assert led.drained() is False


def test_neither_a_refresh_nor_a_reap_reaches_a_terminal_item(monkeypatch, tmp_path):
    """MUTATION ARM UP8: widen the reaper past `in-flight`.

    `--reap` exists to return items a dead lane left `in-flight`. WHAT MAKES
    THIS FAIL: `if item.state != READY:` in `reap_stranded` -- the obvious
    generalisation -- which sweeps `parked`, `declined` AND `in-review` back to
    `ready`, silently undoing every disposition and every PR binding in one
    command that prints only a count.

    THE `in-review` ITEM IS THE POSITIVE CONTROL for the reaper: without it a
    reaper that did nothing at all would satisfy the terminal assertions, and an
    absence-only pair is what assertion-design #4 forbids. The `in-flight` item
    proves the reaper still does its job.
    """
    led = _led(tmp_path, numbers=(STRANDED_BY_A_CLEARED_BLOCKER, BOT_FILED_SELF_RESOLVED,
                                  7001, 7002))
    _stub_gh(monkeypatch)
    tick.park_item(led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "no runner", "op")
    tick.decline_item(led, POLICY, REPO, BOT_FILED_SELF_RESOLVED, "operator: not work")
    led.transition(7001, IN_FLIGHT, "selected in cycle 1")
    led.transition(7002, IN_FLIGHT, "selected in cycle 1")
    led.transition(7002, IN_REVIEW, "lane opened PR 1")

    reaped = tick.reap_stranded(led, led.cycle)
    tick.refresh_from_github(
        led, {}, _live((STRANDED_BY_A_CLEARED_BLOCKER, BOT_FILED_SELF_RESOLVED, 7001, 7002))
    )

    assert reaped == 1, "exactly the in-flight item, and nothing else"
    assert led.items[STRANDED_BY_A_CLEARED_BLOCKER].state == PARKED
    assert led.items[7001].state == READY, "the reaper still does its job"
    assert led.items[7002].state == IN_REVIEW, "a bound lane is not reaped"
    # The decline IS demoted by the refresh, and that is #4535's documented
    # asymmetry rather than a leak: a declined item seen OPEN again means the
    # decline never reached GitHub or somebody is disputing it. It is asserted
    # here so this test cannot be read as claiming the refresh never moves
    # anything terminal -- it moves exactly one thing, for a recorded reason.
    assert led.items[BOT_FILED_SELF_RESOLVED].state == NEEDS_AUDIT


def test_a_reversal_records_no_receipt_and_reopens_the_receipt_path(
    monkeypatch, tmp_path
):
    """THE END-TO-END SHAPE #4699's last acceptance line asks for.

    Before the reversal, `record_receipt_from_evidence` refuses with the
    terminal-item message -- which is the exact refusal the operator hit on
    #2958 with a valid `run 36037056251` in hand. After it, that refusal is
    GONE and the item is refused for the ordinary reason instead (it was offered
    no evidence). The two messages are different sentences, and asserting on
    WHICH one comes back is what distinguishes "the reversal worked" from "the
    receipt path is broken in some other way".

    WHAT MAKES THIS FAIL:
    - the reversal does not move the state -> the terminal message comes back
      after, and the second assertion reds;
    - the reversal records a receipt on the way past -> `receipt_kind` is not
      None and the third assertion reds. #4699 is explicit that it must not:
      unpark returns the item to the queue, closing still requires the normal
      receipt path (deploy-integrity R2).
    """
    led = _led(tmp_path)
    _stub_gh(monkeypatch)
    tick.park_item(led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "no runner", "op")

    before = _refusal(lambda: tick.record_receipt_from_evidence(
        led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, from_pr=None, from_run=None))
    assert "already parked" in str(before), (
        "the precondition, and the exact refusal #2958 hit with a valid receipt"
    )

    tick.unpark_item(
        led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "operator: runner cleared")

    after = _refusal(lambda: tick.record_receipt_from_evidence(
        led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, from_pr=None, from_run=None))
    assert "already parked" not in str(after), (
        "the terminal refusal is gone - the receipt path is reachable again"
    )
    assert led.items[STRANDED_BY_A_CLEARED_BLOCKER].receipt_kind is None, (
        "a reversal records NO receipt; closing still needs one"
    )


def _published_surfaces() -> dict[str, str]:
    """Every string this package puts in front of a reader, rendered.

    FOUR POSTED BODIES, EVERY HELP LINE THE PARSER CARRIES, THE README AND
    `policy.json` -- because a surface is not a file, it is every SITE within
    it. The round that introduced the defect below swept the two disposition
    bodies and missed that `build_parser()` carries the same sentence to anyone
    who types `--help`.

    THE HELP LINES ARE ENUMERATED FROM `build_parser()`, NOT LISTED, and that
    is a repair. The first version of this helper iterated the literal tuple
    `("unpark", "undecline")` -- 2 of the parser's 18 flags -- while the PR
    describing it claimed a sweep BY CLASS. Measured by a reviewer and
    re-measured here with nothing mutated on disk: wrap `build_parser` so a
    false universal lands on one help line, and the scan goes RED on `--unpark`
    (which the tuple named) and stays GREEN on `--park`, `--decline`,
    `--record-receipt` and `--reap` (which it did not). A hand-maintained list
    cannot see its own gaps -- the exact hazard
    `test_every_value_flag_the_parser_knows_is_refused_without_its_verb`
    enumerates the parser to avoid, applied there and not here.

    THE ARM MATTERS MORE THAN THE FIX. UP16 poisons `--unpark`'s help line,
    which the literal tuple already named, so it proves the helper renders THAT
    line and cannot prove the helper enumerates the parser -- nothing in it
    varies the listing. UP19 poisons `--park`, a flag no list names, and is the
    arm that witnesses this paragraph.

    `README.md` AND `policy.json` ARE SURFACES TOO, and were blind for the same
    reason one file over: the README's `--unpark` paragraph carries the claim
    class in prose and no instrument read it. UP20 witnesses that one does now.
    They are read as raw text rather than parsed; the scans below are regexes
    over published prose and markdown/JSON structure is not in their way.

    WHAT THIS STILL CANNOT SEE, stated so a clean run is not over-read: ONE
    PHRASING. Its callers scan `only route out of <X>`. A false universal spelt
    any other way passes -- UP11's own replacement text spells one *"a demoted
    decline has a legal way out and a park has none"*, and it is a sibling test
    rather than this scan that catches it. A clean result is evidence that this
    phrasing is absent, not that the class is.
    """
    parser = tick.build_parser()
    helps = {
        f"--help[{action.option_strings[0].lstrip('-')}]": action.help
        for action in parser._actions
        if action.help and action.option_strings
    }
    here = os.path.dirname(os.path.abspath(__file__))
    docs = {}
    for name in ("README.md", "policy.json"):
        with open(os.path.join(here, "..", name), encoding="utf-8") as handle:
            docs[name] = handle.read()
    return {
        f"disposition[{PARKED}]": tick._disposition_comment(
            PARKED, [("EVIDENCE", "x")], "OPEN"),
        f"disposition[{DECLINED}]": tick._disposition_comment(
            DECLINED, [("EVIDENCE", "x")], "OPEN"),
        f"reversal[{PARKED}]": tick._reversal_comment(PARKED, "why", "OPEN"),
        f"reversal[{DECLINED}]": tick._reversal_comment(DECLINED, "why", "OPEN"),
        **helps,
        **docs,
    }


def test_no_published_surface_claims_a_verb_is_the_only_route_out_of_a_state_the_refresh_demotes():
    """MUTATION ARM UP11. THE CLASS, not the sentence that was caught.

    WHAT SHIPPED, and it was introduced by the fix for three sentences of
    exactly this kind. The decline body ended *"An explicit verb is the only
    route out of a terminal state"* -- two paragraphs after the SAME body said
    *"while this issue is OPEN, the next refresh demotes the ledger item to
    `needs-audit`"*. Measured: `declined` IS in `REOPEN_DISPUTES`,
    `needs-audit` is NOT in `TERMINAL`, and one `upsert` over an open issue
    moves it. So the refresh is a second route out, the body supplies its own
    counterexample, and it republished verbatim on every decline.

    WHAT MAKES THIS FAIL: write "only route out of <X>" anywhere in any
    published surface where `<X>` is not a terminal state the refresh leaves
    alone. The generic "a terminal state" reds because `a` is not a state at
    all; `declined` reds because it is in `REOPEN_DISPUTES`; deleting the claim
    from the park body reds the positive control below, which is what stops
    this being satisfiable by saying nothing.

    THE PATTERN IS LIFTED, NOT TRANSCRIBED in the sense that matters: the states
    it is checked against come from `ledger`'s own constants at runtime, so
    adding a state to `REOPEN_DISPUTES` re-aims this test automatically. The
    scan is CASE-INSENSITIVE, which the first version of the probe was not --
    it scored the park body clean because that body spells it "the ONLY route
    out", a needle narrower than the string it meant to find.

    WHICH ARM WITNESSES WHICH CLAUSE, named rather than left to luck. The
    `in TERMINAL` clause is covered by UP10, UP15, UP16 and UP19. The
    `not in REOPEN_DISPUTES` clause has NO arm in the UP series at all -- a
    reviewer was about to record it as unwitnessed and then found that **L26**
    covers it: that arm adds `parked` to `REOPEN_DISPUTES` itself, and this
    test reds with *"disposition[parked] claims to be the only route out of
    'parked', but 'parked' is in REOPEN_DISPUTES"*. A transcribed copy of the
    constant could not have moved, so L26 is also the proof that the runtime
    read above is live. Written down here because "an arm exists somewhere" is
    not something the next reader can check.

    WHAT THIS SCAN CANNOT SEE: ONE PHRASING -- see `_published_surfaces()`.
    UP11's own replacement text carries a false universal spelt differently
    ("a demoted decline has a legal way out and a park has none") and a sibling
    test, not this one, catches it. A clean result here is evidence about this
    phrasing, not about the class.
    """
    claim = re.compile(r"only route out of\s+(\S+)", re.IGNORECASE)
    scoped_to: dict[str, list[str]] = {}
    for name, body in _published_surfaces().items():
        for found in claim.finditer(body):
            state = found.group(1).strip("`.,;:-")
            scoped_to.setdefault(name, []).append(state)
            assert state in TERMINAL, (
                f"{name} claims to be the only route out of {state!r}, which is "
                f"not a terminal state at all. The states are {TERMINAL}; "
                '"a terminal state" as the object of that phrase is the '
                "universal claim that was false for the sibling state"
            )
            assert state not in REOPEN_DISPUTES, (
                f"{name} claims to be the only route out of {state!r}, but "
                f"{state!r} is in REOPEN_DISPUTES -- one refresh over an open "
                f"issue demotes it to {NEEDS_AUDIT}, which is not terminal, so "
                "the refresh is a second route and the claim is false"
            )

    assert scoped_to.get(f"disposition[{PARKED}]") == [PARKED], (
        "THE POSITIVE HALF, so this test is not satisfied by deleting every "
        "claim. The park body must still make the claim AND scope it to "
        f"{PARKED!r} -- parks are the one state the refresh and --reap both "
        f"leave alone, so it is true there and nowhere else. Got "
        f"{scoped_to.get(f'disposition[{PARKED}]')!r}"
    )
    assert f"disposition[{DECLINED}]" not in scoped_to, (
        "the decline body must make no such claim at all: a decline seen open "
        "is demoted by the very next refresh"
    )


def test_the_decline_body_names_the_undecline_window_and_both_refusals():
    """MUTATION ARM UP12. The instruction must not promise a route that refuses.

    MEASURED, with a positive control in the same run (see
    `test_undecline_is_refused_in_both_branches_the_decline_body_names`): the
    decline body told the reader to close the issue with `--reason not-planned`
    to make the decline stand, and ALSO to run `--undecline` to reverse it --
    and doing the first makes the second REFUSE (closed-issue guard), while not
    doing it defers the item to the next refresh's demotion (state guard). On
    the live ledger at the time, all four declined items had CLOSED issues, so
    the verb had ZERO reachable targets.

    "PERMANENTLY FORECLOSES" IS WHAT THIS DOCSTRING USED TO SAY, AND IT IS
    FALSE. Round 1's F2 said it, the round-3 brief repeated it, and both
    round-2 reviewers independently disproved it rather than accepting it: a
    closed issue is a PREREQUISITE the operator controls, not a strand. Re-open
    the issue and the verb is available again -- measured end to end, refusal
    first (ledger untouched, zero gh writes), then re-open, then a successful
    reversal to `ready`. And if a refresh intervenes the item is
    `needs-audit`/`reopened`, which `audit_queue()` selects and which needs no
    verb at all. Neither order dead-ends. A word that overstates the guard by
    one adverb is the same defect class as the claims this file is full of, and
    it survived two rounds because nobody attacked the adverb.

    Each guard is right on its own; the published instruction is what created
    the pincer. So the body must name the WINDOW and both refusals rather than
    the verb alone.

    WHAT MAKES THIS FAIL: go back to a bare "to reverse this decline, run
    --undecline" with no window. Each assertion below names a specific fact the
    reader needs in order not to be sent at a refusal.
    """
    body = tick._disposition_comment(DECLINED, [("EVIDENCE", "x")], "OPEN")

    assert f"{tick.REVERSAL_FLAGS[DECLINED]} <n>" in body, (
        "the runnable form is still there - naming the window must not cost the "
        "instruction"
    )
    assert "STILL OPEN AND THE LEDGER STILL `declined`" in body, "name the window"
    assert f"`{NEEDS_AUDIT}`" in body, (
        f"name the refresh branch by its state: once demoted the item is in "
        f"the audit queue and {NEEDS_AUDIT} is not terminal"
    )
    assert "nothing to reverse" in body, (
        "and say what that means for the verb - it refuses a demoted item, and "
        "should, so the reader must not be sent at it"
    )
    assert "Re-open the issue first" in body, (
        "name the prerequisite on the branch this body itself tells the reader "
        "to take - closing the issue is the documented disposal"
    )
    assert "`departed`" in body, (
        "say WHY loosening the closed-issue guard would not help: the next "
        "refresh demotes the re-queued item again, so it buys one cycle"
    )


def test_undecline_is_refused_in_both_branches_the_decline_body_names(
    monkeypatch, tmp_path
):
    """THE MEASUREMENT behind the body above, run rather than asserted in prose.

    WHAT MAKES THIS FAIL: loosen either guard. Both refusals are deliberate and
    this test is the record that they compose into a narrow window -- which is
    the fact the published body is now required to state.

    THE WINDOW HAS NEVER DESCRIBED THE LIVE POPULATION, and saying so is the
    difference between a guard and a story about a guard. Measured from two
    instruments rather than one, against ledger blob `a8ec1fc5` -- the GitHub
    issues API for the close, the ledger's own history lines for the decline:

        #4534  closed 2026-09-17T11:46Z  declined 2026-09-24T15:47Z
        #4582  closed 2026-09-18T20:01Z  declined 2026-09-24T15:47Z
        #4664  closed 2026-09-22T16:49Z  declined 2026-09-24T15:47Z
        #4670  closed 2026-09-23T16:48Z  declined 2026-09-24T18:53Z

    Every one was shut on GitHub DAYS BEFORE the harness declined it, so none
    of them ever sat in the open-issue window this test pins. All four land on
    the closed-issue refusal from the first moment they were declined, and the
    route back for all four is re-open-then-reverse. The window is a real
    property of the guards AND an empty set on that ledger; those are different
    claims and only the first is what this test establishes. The figures are
    anchored to a blob rather than to "today" because a figure with no ref
    reads as current forever.

    THE THIRD LEG IS THE POSITIVE CONTROL and it is not decoration: without it
    the first two are satisfied by a verb that refuses everything, which is the
    absence-only shape `assertion-design.md` #4 forbids.
    """
    def _declined(numbers=(BOT_FILED_SELF_RESOLVED,)):
        led = _led(tmp_path, numbers=numbers)
        _stub_gh(monkeypatch)
        tick.decline_item(
            led, POLICY, REPO, numbers[0], "op decided: bot-filed, self-resolved")
        return led

    # (1) the issue CLOSED -- the disposal the body itself names.
    led = _declined()
    _stub_gh(monkeypatch, issue_state="CLOSED")
    exc = _refusal(lambda: tick.undecline_item(
        led, POLICY, REPO, BOT_FILED_SELF_RESOLVED, "operator: withdrawn"))
    assert "CLOSED on GitHub" in str(exc)

    # (2) the issue OPEN, one refresh later -- demoted, so nothing to reverse.
    led = _declined()
    led.upsert(BOT_FILED_SELF_RESOLVED, "issue", "W6-ci", lane="lane:ci", size=1)
    assert led.items[BOT_FILED_SELF_RESOLVED].state == NEEDS_AUDIT, (
        "the premise: one refresh over an open issue demotes a decline"
    )
    _stub_gh(monkeypatch)
    exc = _refusal(lambda: tick.undecline_item(
        led, POLICY, REPO, BOT_FILED_SELF_RESOLVED, "operator: withdrawn"))
    assert f"is {NEEDS_AUDIT}, not {DECLINED}" in str(exc)

    # (3) THE WINDOW ITSELF -- open, not yet refreshed. The verb WORKS.
    led = _declined()
    _stub_gh(monkeypatch)
    tick.undecline_item(led, POLICY, REPO, BOT_FILED_SELF_RESOLVED, "operator: withdrawn")
    assert led.items[BOT_FILED_SELF_RESOLVED].state == READY, (
        "the window is real; a verb that refused here would be dead code"
    )

    # (4) THE PREREQUISITE THE BODY NAMES. Closing the issue is the disposal a
    # decline's own comment describes, and the body tells a reader who wants to
    # withdraw the judgement to RE-OPEN it first. That instruction has to work,
    # or it is the pincer again one step further along: the ledger state is
    # untouched by a GitHub close, so a re-opened issue puts the item back in
    # the window. Measured here rather than asserted in the prose.
    led = _declined()
    _stub_gh(monkeypatch, issue_state="CLOSED")
    _refusal(lambda: tick.undecline_item(
        led, POLICY, REPO, BOT_FILED_SELF_RESOLVED, "operator: withdrawn"))
    assert led.items[BOT_FILED_SELF_RESOLVED].state == DECLINED, (
        "the refused attempt left the ledger where it was, which is what makes "
        "the re-open instruction runnable at all"
    )
    _stub_gh(monkeypatch, issue_state="OPEN")   # the operator re-opened it
    tick.undecline_item(led, POLICY, REPO, BOT_FILED_SELF_RESOLVED, "operator: withdrawn")
    assert led.items[BOT_FILED_SELF_RESOLVED].state == READY, (
        "re-open then reverse is the route the published body promises; if this "
        "reds, the decline body is sending readers at a dead end again"
    )


def test_a_receipt_survives_a_reversal_and_the_body_says_so(monkeypatch, tmp_path):
    """MUTATION ARM UP13. The decision, pinned so it cannot drift back silently.

    A receipt survives a park: nothing on either disposition path voids one, so
    after a reversal it is STILL attached and `Ledger.receipt_ok()` -- which
    `merge_gate.ledger_receipt_ready` calls -- is True.

    THE REASON, RESTATED, because the first version of this docstring gave one
    that is false on the sibling state. It said *"a reopen disputes the very
    claim the receipt closed on"* -- and `CLOSES_ON_GITHUB` is `(CLOSED,)`, so
    a DECLINE never shuts its issue and no close ever happened for the state
    that argument was reused on. The reason that survives measurement is
    narrower: a reversal disputes the DISPOSITION and says nothing about
    evidence taken while the item was still non-terminal, and voiding would be
    a NEW asymmetry rather than the removal of one -- `reap_stranded` and
    `upsert`'s departed-rescue both reach `ready` without voiding anything.

    A SECOND LEG OF THE ORIGINAL ARGUMENT WAS VACUOUS AND IS DROPPED.
    *"`record_receipt_from_evidence` refuses a terminal item, so any receipt a
    terminal item holds was taken validly beforehand"* is true and does no
    work: `Ledger.record_receipt` is the only writer of `receipt_kind` and its
    only non-test caller pairs it with `transition(CLOSED)` under a rollback,
    so no tool path produces a receipted park or decline at all. Census of the
    live ledger, whole file, at blob `a8ec1fc5`: 416 items, 11 hold a receipt,
    all 11 `closed`, 0 parked or declined -- the two parked items are #2874 and
    #2958 and neither holds one. The population this decision governs is empty
    BY CONSTRUCTION, not by luck; this test reaches the shape by writing the
    fields directly, which is what a hand-edited `state.json` does.

    WHAT MAKES THIS FAIL: void the receipt in `_reverse` (the first assertion),
    or leave the published body saying only "closing it still requires the
    normal receipt path", which reads as "it comes back owing one" (the
    second). The body anchors are read per-state rather than as one literal --
    the two states say different true things now, and a single shared anchor is
    what produced the defect this docstring is about.
    """
    led = _led(tmp_path)
    item = led.items[STRANDED_BY_A_CLEARED_BLOCKER]
    item.receipt_kind = POLICY["receipts"][item.effective_receipt_class]
    item.receipt_ref = "run-36037056251"
    item.receipt_taken_under = item.effective_receipt_class
    _stub_gh(monkeypatch)
    tick.park_item(led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "no runner", "op")
    assert led.receipt_ok(item)[0], "the precondition: a terminal item CAN hold one"

    _stub_gh(monkeypatch)
    out = tick.unpark_item(
        led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "operator: runner is up")

    assert item.state == READY
    assert (item.receipt_kind, item.receipt_ref, item.receipt_taken_under) == (
        POLICY["receipts"][item.effective_receipt_class],
        "run-36037056251",
        item.effective_receipt_class,
    ), "all three fields survive, not merely the kind"
    assert led.receipt_ok(item)[0], (
        "so merge_gate.ledger_receipt_ready is satisfied on the way back in"
    )
    park_body = tick._reversal_comment(PARKED, "why", "OPEN")
    assert f"NO ROUTE OUT OF `{PARKED}` VOIDS ONE" in park_body, (
        "the published body must SAY the receipt is kept - otherwise 'closing "
        "still requires the normal receipt path' reads as 'it comes back owing "
        "one', which is false in exactly this case. The park's claim is the "
        "STRONG one (no route out of `parked` voids anything) because `parked` "
        "is not in REOPEN_DISPUTES"
    )
    decline_body = tick._reversal_comment(DECLINED, "why", "OPEN")
    assert "THIS VERB VOIDS NONE" in decline_body, (
        "and the decline's is the WEAK one, scoped to the verb, because the "
        "refresh is a second route out of `declined` and it DOES void"
    )
    assert f"NO ROUTE OUT OF `{DECLINED}` VOIDS ONE" not in decline_body, (
        "the park's strong claim must NOT be published on the decline, which "
        "is the shared-template defect this whole function keeps re-finding"
    )
    assert "THIS VERB VOIDED NONE" in out, "and so must what the operator sees on stdout"


def test_the_two_routes_out_of_a_reopen_disputed_state_disagree_about_the_receipt(
    tmp_path,
):
    """MUTATION ARM UP17. The divergence THIS PR CREATES, measured not argued.

    Before this PR a `declined` item had exactly one route out -- the refresh's
    demotion -- so there was nothing for it to disagree with. `--undecline` is
    a second route, and the two reach opposite `deploy-integrity` R2 outcomes
    from one start state in one window. That is a consequence of the keep
    decision and it was published nowhere and pinned by nothing.

    DRIVEN THROUGH THE REAL `refresh_from_github`, not through a paraphrase of
    it, with the issue OPEN -- which for a decline is its ORDINARY condition,
    since `CLOSES_ON_GITHUB` is `(CLOSED,)` and nothing shuts a decline's
    issue. The park control is in the same test because a control that lives in
    another file is one an arm can retire without anyone noticing:

        PATH A  do nothing, one refresh  -> needs-audit  receipt=None  ok=False
        PATH B  the reversal's own write -> ready        receipt kept  ok=True
        CONTROL park + one refresh       -> parked       receipt kept  ok=True

    WHAT MAKES THIS FAIL: void the receipt on the reversal (PATH B's kept-check
    reds), stop voiding it on the refresh (PATH A's None-check reds), put
    `parked` into `REOPEN_DISPUTES` so the control acquires a second route (the
    control reds), or delete the divergence sentence from the published decline
    body (the last two assertions red). The states are read from `ledger`'s own
    constants at runtime, so changing `REOPEN_DISPUTES` re-aims this test
    rather than leaving a transcribed claim behind.

    THE POPULATION IS EMPTY BY CONSTRUCTION and this test says so rather than
    implying otherwise: `Ledger.record_receipt`'s only non-test caller pairs it
    with `transition(CLOSED)`, so no tool path produces a receipted decline.
    This reaches the shape the way a hand-edited `state.json` does -- which the
    README documents as a supported move, which is why this is worth pinning
    at all rather than dismissing as unreachable.
    """
    assert DECLINED in REOPEN_DISPUTES, (
        "the premise, lifted from the constant rather than transcribed: this "
        f"test is about the states in {REOPEN_DISPUTES} that a reversal verb "
        "also reaches"
    )
    assert PARKED not in REOPEN_DISPUTES, (
        "and `parked` is the control precisely because it is OUT -- it has no "
        "second route out to disagree with its reversal verb"
    )
    assert DECLINED not in CLOSES_ON_GITHUB, (
        "and the reason the OLD justification was false: a decline never shuts "
        "its issue, so 'the very claim that receipt closed on' named an event "
        "that cannot have happened for this state"
    )

    def _receipted(state: str, why: str) -> tuple[Ledger, object]:
        # THE STREAM IS THE ONE THE REFRESH WILL RECOMPUTE, and that is not
        # cosmetic. Seeded with `_led`'s `W6-ci` this test RED with the receipt
        # `None` on PATH B as well -- and the cause was not the reversal: the
        # refresh re-derives the stream from the title via `stream_for`, got
        # `W1-deploy`, and `upsert`'s CLASS-CHANGE branch voided the receipt
        # before the reopen branch was ever reached. Both paths would have
        # shown `None` for a reason that has nothing to do with the divergence
        # this test is about, and the DIVERGENCE assertion would have been the
        # one that reported it. Seeding the settled stream removes the
        # confound; the assertion below proves it is gone rather than assuming.
        led = Ledger(str(tmp_path / state / "state.json"),
                     receipts=POLICY["receipts"])
        led.upsert(STRANDED_BY_A_CLEARED_BLOCKER,
                   f"issue {STRANDED_BY_A_CLEARED_BLOCKER}",
                   stream_for(STRANDED_BY_A_CLEARED_BLOCKER,
                              f"issue {STRANDED_BY_A_CLEARED_BLOCKER}",
                              ["lane:ci", "sp:1"]),
                   lane="lane:ci", size=1)
        item = led.items[STRANDED_BY_A_CLEARED_BLOCKER]
        item.receipt_kind = POLICY["receipts"][item.effective_receipt_class]
        item.receipt_ref = "run-36037056251"
        item.receipt_taken_under = item.effective_receipt_class
        if state == PARKED:
            item.blocker, item.owner = "no runner", "op"
        led.transition(STRANDED_BY_A_CLEARED_BLOCKER, state, why)
        assert led.receipt_ok(item)[0], f"the precondition for {state}"
        return led, item

    live = _live((STRANDED_BY_A_CLEARED_BLOCKER,))

    led_a, item_a = _receipted(DECLINED, "operator decided: will not do")
    class_before = item_a.effective_receipt_class
    tick.refresh_from_github(led_a, {}, live)
    assert item_a.effective_receipt_class == class_before, (
        "THE ANTI-CONFOUND, asserted rather than assumed: `upsert` voids a "
        "receipt on a CLASS CHANGE as well as on a reopen, and if the class "
        "moved under this refresh the `receipt_kind is None` below would be "
        "witnessing the wrong branch. It moved on the first draft of this test"
    )
    assert item_a.state == NEEDS_AUDIT, (
        "PATH A: one refresh over the open issue demotes it -- `declined` is "
        f"in REOPEN_DISPUTES. Got {item_a.state!r}"
    )
    assert item_a.receipt_kind is None, (
        "PATH A: and VOIDS the receipt. If this stops being true the published "
        "divergence sentence becomes false in the other direction"
    )
    assert led_a.receipt_ok(item_a)[0] is False, (
        "so merge_gate.ledger_receipt_ready goes False on PATH A -- the R2 "
        "outcome that PATH B does not reach"
    )

    led_b, item_b = _receipted(DECLINED, "operator decided: will not do")
    led_b.transition(STRANDED_BY_A_CLEARED_BLOCKER, READY, "reversed from declined")
    tick.refresh_from_github(led_b, {}, live)
    assert item_b.state == READY, "PATH B: and a later refresh leaves it there"
    assert item_b.receipt_kind == POLICY["receipts"][item_b.effective_receipt_class], (
        "PATH B: the verb KEEPS the receipt. This is the decision, and the "
        "assertion that would red if it were reversed to void-for-symmetry"
    )
    assert led_b.receipt_ok(item_b)[0] is True, (
        "THE DIVERGENCE: same start state, same window, opposite R2 outcomes. "
        f"PATH A -> {led_a.receipt_ok(item_a)} / PATH B -> "
        f"{led_b.receipt_ok(item_b)}"
    )

    led_c, item_c = _receipted(PARKED, "parked on a measured blocker")
    tick.refresh_from_github(led_c, {}, live)
    assert (item_c.state, item_c.receipt_kind is None) == (PARKED, False), (
        "THE CONTROL, and it is what makes the park body's STRONGER claim "
        "true: `parked` is not in REOPEN_DISPUTES, the refresh leaves it "
        f"alone, so there is no second route to disagree with. Got "
        f"{item_c.state!r} receipt={item_c.receipt_kind!r}"
    )

    # THE VOID THAT IS NOT A ROUTE OUT, measured because the park body's claim
    # is scoped to routes out and an earlier draft of it was not. Same parked
    # item, same refresh, only the LANE LABEL moves -- which moves the receipt
    # CLASS, and `upsert` voids on a class change without touching the state.
    led_d, item_d = _receipted(PARKED, "parked on a measured blocker")
    class_before = item_d.effective_receipt_class
    tick.refresh_from_github(led_d, {}, _live((STRANDED_BY_A_CLEARED_BLOCKER,),
                                              labels=("lane:console", "sp:1")))
    assert item_d.effective_receipt_class != class_before, (
        "the precondition for this leg: the lane label must actually MOVE the "
        f"receipt class. Got {class_before!r} both times, so the leg below "
        "would be witnessing nothing"
    )
    assert item_d.state == PARKED, (
        "it did NOT leave `parked` -- which is what makes this a counterexample "
        "to the wider reading of the park claim rather than a second route out"
    )
    assert item_d.receipt_kind is None, (
        "and its receipt is GONE. So 'nothing voids one on this route or any "
        "other out of `parked`' is true only on a careful reading of its own "
        "scope, and the published body now discloses this case explicitly "
        "instead of relying on that reading"
    )

    body = tick._reversal_comment(DECLINED, "why", "OPEN")
    assert "REOPEN_DISPUTES" in body, (
        "THE PUBLISHED HALF: the decline body must NAME the other route, not "
        "merely be silent about it. A measurement nobody can read off the "
        "artifact is not a disclosure"
    )
    assert NEEDS_AUDIT in body, (
        "and must say where that route LANDS, which is the half that makes it "
        "actionable rather than ominous"
    )
    assert "VOIDS the receipt" in body, (
        "and must say what the other route does to the receipt. Silence here "
        "is what let the false 'UNLIKE a reopen' sentence stand for two rounds"
    )
    assert "this verb keeps it" in body, (
        "and what THIS one does, so the two are legible as a divergence "
        "rather than as one fact stated twice"
    )


@pytest.mark.parametrize("state", [PARKED, DECLINED], ids=[PARKED, DECLINED])
def test_no_published_surface_asserts_a_close_that_never_happened(state):
    """MUTATION ARM UP18. THE CLASS, one turn on from the `only route` scan.

    WHAT SHIPPED, and it was introduced by the fix for the same class twice
    over. Both reversal bodies carried *"that is deliberately UNLIKE a reopen,
    which voids the receipt because a reopen disputes the very claim that
    receipt closed on"*. `CLOSES_ON_GITHUB` is `(CLOSED,)`. A DECLINE never
    shuts its issue, so for the state that sentence was published on, NOTHING
    EVER CLOSED -- the clause presupposes an event that cannot have happened.
    It sat on three surfaces (the posted body, the docstring, `README.md`) and
    the round-2 class scan could not see it, because that scan reads
    `only route out of <X>` and this is a different phrasing of the same
    defect: a universal true of one state, republished on its sibling.

    WHAT MAKES THIS FAIL: write any past-tense close claim -- "closed on",
    "the close", "when it was closed" -- into a surface rendered for a state
    that is not in `CLOSES_ON_GITHUB`. Reinstating the old sentence verbatim
    (UP18) reds `[declined]` and leaves `[parked]` green, which is the shape
    that makes this a class test rather than a string check: the same text is
    legitimate for a state the harness really does close.

    THE POSITIVE HALF IS NOT DECORATION. Without it this is satisfiable by
    deleting every mention of receipts from both bodies, which is exactly the
    absence-only failure `assertion-design.md` #4 names. Each body must still
    make its receipt claim, scoped to what is true of its own state.

    THE STATES COME FROM THE CONSTANT at runtime, so adding `declined` to
    `CLOSES_ON_GITHUB` -- which its own comment says a future decline path
    would do -- retires this parameter automatically instead of leaving a stale
    assertion asserting the opposite of the code.

    WHAT THIS DOES NOT SCAN, disclosed so a clean run is not over-read: it
    reads the POSTED BODIES only, not `README.md`, `policy.json` or this
    package's docstrings. All three of those now carry the retracted sentence
    as a QUOTATION -- "what this paragraph deliberately no longer says is ..."
    -- and a scan that cannot tell a quotation from an assertion would either
    red on the retraction or need a heuristic nobody could trust. Classified by
    hand this round: 5 hits of the close-claim across `tick.py`, `README.md`
    and `policy.json`, of which 4 are retraction quotations and 1 is the
    published NEGATION ("is NOT a dispute about a claim some close rested on").
    Zero live assertions. That is a hand check, not an instrument, and it is
    named here rather than left implied.
    """
    body = tick._reversal_comment(state, "why", "OPEN")
    if state not in CLOSES_ON_GITHUB:
        closed_claims = re.findall(
            r"receipt closed on|claim the receipt closed|"
            r"the close (?:it|this item) rested on",
            body,
            re.IGNORECASE,
        )
        assert not closed_claims, (
            f"the {state!r} reversal body asserts a CLOSE that never happened: "
            f"{closed_claims}. {state!r} is not in {list(CLOSES_ON_GITHUB)}, so "
            "nothing here shut the issue and there is no claim a close rested "
            "on. This is the published-universal-falsified-by-the-sibling-"
            "state class, in a phrasing the `only route out of` scan cannot see"
        )

    assert "NO RECEIPT IS RECORDED BY THIS" in body, (
        "THE POSITIVE HALF, so this is not satisfied by saying nothing about "
        "receipts at all. Every reversal body must still make the claim"
    )
    strong = f"NO ROUTE OUT OF `{state}` VOIDS ONE"
    if state in REOPEN_DISPUTES:
        assert strong not in body, (
            f"{state!r} HAS a second route out (the refresh) and it voids, so "
            "the strong no-route-voids-it claim is false here"
        )
        assert "THIS VERB VOIDS NONE" in body, (
            "it must make the WEAK claim instead, scoped to the verb"
        )
    else:
        assert strong in body, (
            f"{state!r} is not in REOPEN_DISPUTES, so the strong claim is true "
            "and the body should make it rather than under-claiming"
        )
    assert "WITHOUT LEAVING THIS STATE AT ALL" in body, (
        "AND BOTH BODIES MUST DISCLOSE THE ONE VOID THAT IS NOT A ROUTE OUT. "
        "An earlier draft of the park text read 'NOTHING VOIDS ONE ON THIS "
        "ROUTE OR ANY OTHER OUT OF `parked`' -- true as written, false as "
        "read. Measured while attacking it: a parked item holding a "
        "`deploy-run` receipt, lane label moved `lane:bicep` -> "
        "`lane:console`, one refresh, and the receipt is None with the item "
        "still `parked`. `upsert`'s class-change void is not gated on state, "
        "so this clause is SHARED between the two branches on purpose -- "
        "shared text is the defect when the states differ and the right answer "
        "when they do not"
    )


@pytest.mark.parametrize("state", [PARKED, DECLINED], ids=[PARKED, DECLINED])
def test_the_reversal_body_quotes_only_what_its_own_disposition_actually_says(state):
    """MUTATION ARM UP14. The shared-template hazard, one function over.

    `_disposition_comment`'s docstring argues at length that the park and
    decline bodies are written out in full rather than assembled from a shared
    template, because a shared template is how two receipt routes came to say
    the same wrong thing. `_reversal_comment` then used one anyway: both halves
    said *"The `<state>` comment above this one says the harness will not
    re-select this item on its own."*

    Measured: NEITHER disposition body contains that sentence. This PR rewrote
    the park's to "until somebody runs it", and the decline's never said
    anything of the kind -- so on an `--undecline` the correction attributed to
    the comment above it a sentence that is not there, on the unrevisable
    surface this function exists to keep honest.

    THE ATTRIBUTION MUST HOLD FOR A COMMENT POSTED BEFORE THIS VERB EXISTED,
    which is the second round of the same defect and was caught by reading the
    live artifact rather than the source. A round-2 draft said *"the `parked`
    comment above this one ... says the harness will not re-select this item
    until somebody runs `--unpark`"* -- and #2958's actual park comment, live on
    GitHub, reads *"TO UNPARK IT: resolve the blocker and say so here. The park
    is terminal, so the harness will not re-select this item on its own."* It
    names no verb, because none existed. So the repair for a false attribution
    asserted a new false attribution about the ONE item this whole PR is for.
    Both corrections now name both vintages.

    WHAT MAKES THIS FAIL: collapse the two corrections back into one, or quote
    a sentence the sibling body does not carry. The assertion is not "these
    strings differ" -- it is that each reversal body's quoted fragment is
    FOUND IN its own disposition body, which is a claim only the real pair can
    satisfy.

    WHICH ASSERTIONS HERE ACTUALLY HAVE KILL POWER, disclosed rather than
    counted (assertion-design #5), because the measurement disagreed with the
    intent. Under UP14 `shipped not in reversal` reds on BOTH parameters and is
    the load-bearing one; `anchor in reversal` reds on `[declined]` only (the
    shared paragraph happens to contain the park's anchor). The remaining three
    -- the "which comment" clause, `anchor in mine` and `anchor not in theirs`
    -- are REGRESSION GUARDS: no arm in the matrix removes the anchor from
    either disposition body, so nothing shows them failing and they must not be
    counted as coverage. They are kept because they are the assertions that
    would catch a FUTURE edit to a disposition body silently invalidating the
    correction that quotes it, which is the exact drift this test exists for.
    """
    reversal = tick._reversal_comment(state, "why", "OPEN")
    other = DECLINED if state == PARKED else PARKED
    mine = tick._disposition_comment(state, [("EVIDENCE", "x")], "OPEN")
    theirs = tick._disposition_comment(other, [("EVIDENCE", "x")], "OPEN")

    shipped = (
        f"The `{state}` comment above this one says the harness will not "
        "re-select this item on its own."
    )
    assert shipped not in reversal, (
        f"that exact attribution shipped in BOTH halves and neither disposition "
        f"body contains the sentence it attributes. Measured: "
        f"{'will not re-select this item on its own' in mine=}"
    )
    assert f"The `{state}` comment above this one" in reversal, (
        "it must still say WHICH comment it corrects"
    )

    # The anchor each correction leans on, and the whole point is that it is
    # FOUND IN its own disposition and ABSENT from the sibling's. One shared
    # paragraph cannot satisfy both parameters, which is what makes this red
    # under UP14 rather than merely differ from it.
    anchor = {
        PARKED: "will not re-select this item",
        DECLINED: "will not do",
    }[state]
    assert anchor in reversal, f"the {state} correction must lean on {anchor!r}"
    assert anchor in mine, (
        f"and {anchor!r} must actually be IN the {state} disposition body - this "
        "is the assertion the shipped version could not have passed"
    )
    assert anchor not in theirs, (
        f"{anchor!r} is absent from the {other} body, which is exactly why one "
        "shared correction paragraph could not be true for both"
    )


@pytest.mark.parametrize(
    ("state", "other"), [(PARKED, DECLINED), (DECLINED, PARKED)], ids=[PARKED, DECLINED]
)
def test_the_disposition_body_names_the_verb_that_reverses_it(state, other):
    """MUTATION ARM UP10: the park body goes back to naming no mechanism.

    THE DEFECT THIS CHANGE WOULD OTHERWISE HAVE CREATED. Before #4699 the park
    comment said *"TO UNPARK IT: resolve the blocker and say so here. The park is
    terminal, so the harness will not re-select this item on its own."* -- true
    when written, because there was no verb. Shipping `--unpark` without touching
    that sentence leaves a permanent public artifact telling every future reader
    there is no mechanism, when there is one. That is R7 on an unrevisable
    surface, and it republishes on EVERY park the harness performs.

    The decline half is the mirror, and its own stale claim was *"a demoted
    decline has a legal way out and a park has none"* -- false the moment
    `--unpark` exists. ARM UP11 is that mirror and reverts the whole decline
    block to exactly that pre-#4699 text, so the `[declined]` parameter here is
    RUN against the defect rather than merely written for it -- which it was
    not in the first round, and the reviewers said so.

    WHAT MAKES THIS FAIL: remove the verb name from either body, or name the
    WRONG one. The flag is read from `tick.REVERSAL_FLAGS` rather than
    transcribed (assertion-design #3), so a probe cannot disagree with the
    implementation, and the `other` parameter pins that each body gives ITS OWN
    verb as the runnable instruction -- a body that told the reader to run the
    other one would pass a bare membership check. Both bodies MENTION the
    sibling flag in passing, which is why the assertion is on the `<n>`
    placeholder form: that is the one a reader copies.

    THE CITATION ASSERTION IS SEPARATE AND IS NOT COSMETIC. The park body cited
    `#2874` for the rule that `REOPEN_DISPUTES` excludes `parked`. Measured:
    #4535 is the DEFECT ("a parked item cannot stay parked", CLOSED); #2874 is
    "bicep-drift (Gov (GCC-High)): 17 unmanaged delta(s)" (OPEN) -- the ITEM that
    was parked and demoted thirteen seconds later. The decline branch of the very
    same function already cited #4535 correctly, so the two adjacent branches
    disagreed. WHAT MAKES IT FAIL: cite #2874 as the defect again.
    """
    body = tick._disposition_comment(state, [("EVIDENCE", "x")], "OPEN")
    mine = f"{tick.REVERSAL_FLAGS[state]} <n>"
    theirs = f"{tick.REVERSAL_FLAGS[other]} <n>"

    assert mine in body, (
        f"a {state} body that names no runnable way out tells every future "
        "reader there is no mechanism, permanently and publicly"
    )
    assert theirs not in body, (
        f"the {state} body must give {mine!r} as the instruction, never {theirs!r}"
    )
    assert "#4535" in body, (
        "the REOPEN_DISPUTES rule is #4535 (the defect); #2874 is the bicep-drift "
        "ITEM that demonstrated it"
    )
    if state == PARKED:
        assert "#2874 is the ITEM" in body, (
            "#2874 is kept only with its actual role named - dropping it entirely "
            "would lose the measurement, and naming it alone misattributes"
        )


# ---------------------------------------------------------------------------
# WIRING -- a verb main() does not dispatch is a verb that does not exist
# ---------------------------------------------------------------------------


def _main_over(monkeypatch, tmp_path, argv, *, seed=True, park=True):
    """Drive `tick.main()` end to end with the network stubbed out.

    `read_live_issues` is stubbed to RAISE rather than to return a list: a
    reversal must return before it, and here that matters more than anywhere --
    the refresh is the thing that must never reach a terminal item, so running
    one inside the only verb that legitimately does would make the two
    indistinguishable in any log. An empty-list stub would let that pass
    silently.
    """
    state = str(tmp_path / "state.json")
    if seed:
        led = Ledger(state, receipts=POLICY["receipts"])
        for n in (STRANDED_BY_A_CLEARED_BLOCKER, BOT_FILED_SELF_RESOLVED):
            led.upsert(n, f"issue {n}", "W6-ci", lane="lane:ci", size=1)
        if park:
            led.items[STRANDED_BY_A_CLEARED_BLOCKER].blocker = "no in-VNet runner"
            led.items[STRANDED_BY_A_CLEARED_BLOCKER].owner = "operator"
            led.transition(STRANDED_BY_A_CLEARED_BLOCKER, PARKED, "blocked on a runner")
            led.transition(BOT_FILED_SELF_RESOLVED, DECLINED, "operator: not backlog")
        led.save()
    monkeypatch.setattr(tick, "STATE_PATH", state)

    def refuse(_repo):
        raise AssertionError("a reversal must return before read_live_issues")

    monkeypatch.setattr(tick, "read_live_issues", refuse)
    monkeypatch.setattr(sys, "argv", ["tick.py", *argv])
    return tick.main(), state


def test_main_unparks_an_item_and_persists_it(monkeypatch, tmp_path):
    """WHAT MAKES THIS FAIL: dispatch the verb and never save.

    The assertion re-READS the file rather than inspecting the in-memory ledger,
    because those are different claims and only the second survives the process.
    An `--unpark` that mutates memory and exits 0 leaves the item parked on disk
    and the operator believing it is back in the queue -- with a public comment
    on the issue saying so.
    """
    calls, _ = _stub_gh(monkeypatch)
    rc, state = _main_over(monkeypatch, tmp_path, [
        "--unpark", str(STRANDED_BY_A_CLEARED_BLOCKER),
        "--reason", "operator: gh-aca-runner is at maxExecutions:5, 101 Succeeded",
    ])

    assert rc == 0
    persisted = Ledger(state, receipts=POLICY["receipts"]).load()
    item = persisted.items[STRANDED_BY_A_CLEARED_BLOCKER]
    assert item.state == READY
    assert item.blocker is None
    # THE REPO IS READ FROM THE LIVE POLICY, not from this module's `REPO`.
    # `main()` takes `policy["repo"]`, so transcribing `owner/repo` here made the
    # assertion compare a fixture's idea of the repository against the real one
    # and red for the wrong reason -- a probe disagreeing with the implementation
    # (assertion-design #3). The read-back URL is derived the same way the code
    # derives it, so a change to either follows the other.
    assert _verbs(calls) == [
        ("issue", "view"),
        ("issue", "comment"),
        ("api", f"repos/{POLICY['repo']}/issues/comments/{POSTED_COMMENT_ID}"),
    ]


def test_main_undeclines_an_item_and_persists_it(monkeypatch, tmp_path):
    """The sibling. WHAT MAKES THIS FAIL: the same, for the other verb -- and
    the two dispatch through ONE `if`, so a branch handling only `--unpark`
    would exit 0 having done nothing at all for `--undecline`."""
    _stub_gh(monkeypatch)
    rc, state = _main_over(monkeypatch, tmp_path, [
        "--undecline", str(BOT_FILED_SELF_RESOLVED),
        "--reason", "operator 2026-09-24: the alert recurred",
    ])

    assert rc == 0
    persisted = Ledger(state, receipts=POLICY["receipts"]).load()
    assert persisted.items[BOT_FILED_SELF_RESOLVED].state == READY


@pytest.mark.parametrize(
    "argv",
    [
        ["--unpark", "1", "--reason", "r", "--undecline", "2"],
        ["--unpark", "1", "--reason", "r", "--park", "2", "--blocker", "b", "--owner", "o"],
        ["--unpark", "1", "--reason", "r", "--record-receipt", "2"],
        ["--undecline", "1", "--reason", "r", "--bind-pr", "2", "--pr", "3"],
    ],
    ids=["unpark+undecline", "unpark+park", "unpark+record", "undecline+bind"],
)
def test_main_refuses_two_write_verbs_in_one_invocation(monkeypatch, tmp_path, argv):
    """WHAT MAKES THIS FAIL: let one verb win silently.

    `unpark+park` is the parameter with the most teeth: those two are exact
    inverses, so whichever one lost would leave the operator with the opposite of
    what they asked for and a comment on the issue announcing it.
    """
    calls, _ = _stub_gh(monkeypatch)
    rc, _ = _main_over(monkeypatch, tmp_path, argv)

    assert rc == 2
    assert calls == [], "a refused invocation touches nothing"


def test_main_refuses_reason_without_a_verb_that_reads_it(monkeypatch, tmp_path):
    """WHAT MAKES THIS FAIL: leave `--reason` out of `VALUE_FLAGS`.

    `tick.py --reason 'the runner came back'` would then fall through to
    `read_live_issues` and run an ordinary refresh cycle, silently discarding
    the reason -- the exact defect measured for `--from-pr`. The stub for
    `read_live_issues` RAISES, so a fall-through is a hard failure here rather
    than a quiet pass.
    """
    rc, _ = _main_over(monkeypatch, tmp_path, ["--reason", "the runner came back"])
    assert rc == 2


def test_every_value_flag_the_parser_knows_is_refused_without_its_verb():
    """THE GUARD ON THE GUARD, because `VALUE_FLAGS`' failure mode is OMISSION.

    WHAT MAKES THIS FAIL: add a value-taking flag to `build_parser()` and no row
    to `VALUE_FLAGS`. That flag is then accepted, read by nothing, and DROPPED
    SILENTLY -- which is the defect the whole refusal loop exists to prevent,
    reintroduced one flag at a time. A hand-maintained list cannot see its own
    gaps, so the parser is enumerated instead of trusted.

    The write verbs are excluded because they ARE verbs, and `store_true` /
    `--help` are excluded because they carry no value to drop. Both exclusions
    are derived from the parser's own action objects rather than from a
    transcribed list, so a verb renamed in one place and not the other still
    reds.
    """
    write_flags = {flag for flag, _attr in tick.WRITE_VERBS}
    covered = {flag for flag, _attr, _verb, _verbs in tick.VALUE_FLAGS}
    takes_a_value = {
        opt
        for action in tick.build_parser()._actions
        if action.nargs != 0 and action.option_strings
        for opt in action.option_strings
        if opt != "--help"
    }
    assert takes_a_value - write_flags - covered == set(), (
        "every value-taking flag must be in VALUE_FLAGS or be a write verb, or "
        "it is accepted and silently discarded"
    )
    # The positive control: the sets are not empty and the test is not passing
    # over an empty enumeration (the `_actions` API could change shape).
    assert "--reason" in takes_a_value
    assert covered <= takes_a_value, "VALUE_FLAGS names a flag the parser does not"


@pytest.mark.parametrize(
    "argv",
    [
        ["--status", "--unpark", "1", "--reason", "r"],
        ["--status", "--undecline", "1", "--reason", "r"],
    ],
    ids=["unpark", "undecline"],
)
def test_main_refuses_a_reversal_passed_beside_status(monkeypatch, tmp_path, argv):
    """WHAT MAKES THIS FAIL: let `--status` return first.

    It is a READ and it returns before any write, so the reversal would be
    silently discarded -- the counts print, the exit code is 0, and nothing
    happened. Measured for `--park` in review; the same door, two verbs later.
    """
    calls, _ = _stub_gh(monkeypatch)
    rc, _ = _main_over(monkeypatch, tmp_path, argv)

    assert rc == 2
    assert calls == []


def test_main_refuses_a_reversal_with_no_ledger(monkeypatch, tmp_path):
    """WHAT MAKES THIS FAIL: proceed over an absent ledger.

    `state.json` is gitignored and has been deleted by accident in this package
    before. Without the guard, `led.items` is empty, the reversal refuses with
    "not in the ledger", and the operator is told their issue number is wrong
    when the truth is that the queue is gone.
    """
    calls, _ = _stub_gh(monkeypatch)
    rc, _ = _main_over(
        monkeypatch, tmp_path, ["--unpark", "2958", "--reason", "r"], seed=False)

    assert rc == 2
    assert calls == []


def test_main_refuses_to_save_a_reversal_over_a_rival_write(monkeypatch, tmp_path):
    """WHAT MAKES THIS FAIL: `led.save()` without `if_unchanged`.

    Four lanes share this ledger. A reversal that loaded before a rival lane
    wrote would save a document in which the rival's transition never happened
    -- the lost-update shape reproduced in this package before the CAS existed.

    WHAT IS ALSO PINNED: the comment WAS posted, so the message must not say
    nothing was written anywhere (R7). The operator has to know a public
    artifact exists before they re-run.
    """
    _, posted = _stub_gh(monkeypatch)

    def lost(_led):
        raise LedgerChangedError("another writer got there first")

    monkeypatch.setattr(tick, "_save_refusing_lost_update", lost)
    rc, state = _main_over(monkeypatch, tmp_path, [
        "--unpark", str(STRANDED_BY_A_CLEARED_BLOCKER), "--reason", "operator: up",
    ])

    assert rc == 1
    assert len(posted) == 1, "the comment went out before the save was attempted"
    persisted = Ledger(state, receipts=POLICY["receipts"]).load()
    assert persisted.items[STRANDED_BY_A_CLEARED_BLOCKER].state == PARKED, (
        "nothing was saved, so the item is still terminal on disk"
    )


def test_the_lost_cas_message_names_the_published_comment(monkeypatch, tmp_path, capsys):
    """WHAT MAKES THIS FAIL: print "nothing was written" over a landed comment.

    That sentence is true of the LEDGER and false of the ISSUE, and the half the
    operator has to act on is the false one -- a permanent comment now sits on a
    public issue announcing a reversal the ledger does not carry. This is the
    same R7 correction `_dispose`'s save arm already carries.
    """
    _stub_gh(monkeypatch)

    def lost(_led):
        raise LedgerChangedError("another writer got there first")

    monkeypatch.setattr(tick, "_save_refusing_lost_update", lost)
    _main_over(monkeypatch, tmp_path, [
        "--unpark", str(STRANDED_BY_A_CLEARED_BLOCKER), "--reason", "operator: up",
    ])

    err = capsys.readouterr().err
    assert "THE CORRECTION IS ON THE ISSUE" in err
    assert "LedgerChangedError" in err, (
        "the exception TYPE is printed, so a lost CAS is distinguishable from a "
        "filesystem failure rather than flattened into one story"
    )
    assert "STILL TERMINAL" in err
