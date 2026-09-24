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
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import tick
from ledger import (
    CLOSED,
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
                return view_rc, "", "could not resolve host: github.com"
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


def test_undecline_refuses_a_parked_item_and_names_the_other_verb(
    monkeypatch, tmp_path
):
    """The mirror, and the message is the deliverable.

    WHAT MAKES THIS FAIL: let either verb reverse either state. The two carry
    DIFFERENT justifications -- an unpark says a blocker lifted, an undecline says
    a judgement was withdrawn -- so absorbing the wrong one would publish the
    wrong story verbatim on a public issue.

    WHAT MAKES THE SECOND ASSERTION FAIL: refuse without naming `--unpark`. The
    operator who typed the wrong verb needs the right one, not a diagnosis.
    """
    led = _led(tmp_path)
    _stub_gh(monkeypatch)
    tick.park_item(led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "no runner", "op")
    calls, _ = _stub_gh(monkeypatch)

    exc = _refusal(lambda: tick.undecline_item(
        led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "operator: reversed",
    ))

    assert calls == []
    assert "--unpark" in str(exc), "name the verb that WOULD have worked"
    assert led.items[STRANDED_BY_A_CLEARED_BLOCKER].state == PARKED


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


def test_a_reversal_refuses_when_the_issue_state_cannot_be_read(monkeypatch, tmp_path):
    """WHAT MAKES THIS FAIL: treat an unreadable issue as open.

    The verb REFUSES a closed issue, so it cannot proceed on an unread one
    either -- "I could not reach GitHub" is not "it is open" (R7, the roll that
    reported "the tag does not exist" over a permission denial).
    """
    led = _led(tmp_path)
    _stub_gh(monkeypatch)
    tick.park_item(led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "no runner", "op")
    calls, posted = _stub_gh(monkeypatch, view_rc=1)

    exc = _refusal(lambda: tick.unpark_item(
        led, POLICY, REPO, STRANDED_BY_A_CLEARED_BLOCKER, "operator: runner is up",
    ))

    assert isinstance(exc, tick.ReversalRefusedError)
    assert "UNKNOWN" in str(exc)
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
    `--unpark` exists.

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
