"""`--park` and `--decline` -- the two terminal states no program could reach (#4677).

## What was broken, measured 2026-09-23

`Ledger` has defined five states since it was written, and `drained()` -- this
program's documented exit condition -- is true only when every item is `closed`,
`parked` or `declined`. `tick.py`, the only program that owns the ledger, could
reach exactly one of the three:

    state       reachable by program?   how
    ready       yes                     refresh / --reap
    in-flight   yes                     select_cycle
    in-review   yes                     --bind-pr
    needs-audit yes                     refresh, when an item departs GitHub
    closed      yes                     --record-receipt
    parked      NO                      --
    declined    NO                      --

Both bars are enforced in `ledger.transition()` -- a park needs a named blocker
AND owner, a decline needs a recorded decision -- and neither was reachable from
a command line. So a lane that correctly concluded "blocked on X, owned by Y"
had nowhere to put that conclusion, and the item went back to `ready` on the
next reap to be redone by the next lane: #4675's failure, one state over. The
live ledger holds one parked item, reached by a path that no longer exists.

## What each test would fail on

Named per `assertion-design.md`, because a test whose breaking input cannot be
named is not coverage. The four the issue asks for, and what turns each red:

- **delete the blocker check** (`park_item`): `test_park_refuses_without_a_blocker`
  goes red three ways over its three parameters, and they are NOT the same
  failure -- measured by applying the arm and READING the failure text, not
  reasoned about (`python tools/drain/mutate_gates.py` runs DP1-DP3 as part of
  the full matrix; cited as a TRACKED path deliberately, because a scratch
  runner under `temp/` is gitignored and therefore unrunnable on a fresh clone
  -- `policy.json` records that exact mistake being made once already):
  on `--blocker ''` and `--blocker '   '` the mutant reaches
  `post_disposition_comment` and PUBLISHES a park announcement on a public
  issue before `transition` refuses it, so `calls == []` is what goes red and
  the message prints the argv that was published; on `--blocker` absent
  entirely the mutant dies one line earlier on `None.strip()`, so the CLASS
  assertion is what goes red instead. The empty/blank pair is the one that
  witnesses the real harm, and it is the reason the parameters are not one.
- **delete the owner check**: same three-way split, via
  `test_park_refuses_without_an_owner`.
- **delete the decision check** (`decline_item`): same again, via
  `test_decline_refuses_without_a_decision`. Here the mutation is STRONGER than
  the park's: `decision` is passed to `transition` as its `why` verbatim, so
  deleting this check and passing an empty string through is refused by the
  ledger -- but only after the comment.
- **add `parked` to `REOPEN_DISPUTES`**: `test_a_park_survives_a_refresh_and_a_decline_is_demoted`
  goes red on its first assertion, reading `needs-audit` where it wants
  `parked`. That is arm L26 and the #2874 regression, driven this time from the
  NEW verb rather than from a hand-built item.

The park/decline halves of that last test are in ONE test over ONE refresh
deliberately: a test that pins only the park is satisfied by an implementation
that never refreshes at all, and a test that pins only the decline is satisfied
by one that demotes everything. Neither alone would have caught #2874; the pair
distinguishes both.

## The claim about WHICH assertion kills, measured rather than reasoned

The three refusal tests catch a wide `Exception` via `_refusal` instead of using
`pytest.raises(DispositionRefusedError)`, and that is a correction rather than a
style. The first version used the narrow form with the `calls == []` assertion
AFTER it -- and under each arm the CLI check is gone, the ledger refuses with a
`ValueError`, `pytest.raises` fails on the class mismatch, and **the `calls`
assertion never executes**. Every arm still scored killed, so the matrix looked
right while the docstring's claim about which assertion had the kill power was
false. Read the mutated run, do not reason about it.

## Round 2: the case no test constructed

Two independent reviewers found the same R7 defect, and the matrix could not
have: the park body asserted "THIS ISSUE STAYS OPEN, DELIBERATELY"
unconditionally, while three of the four live items #4677 names (#4534, #4582,
#4664) are CLOSED. **No test rendered a body for a departed item** -- the
state-asymmetry test built both items `ready`, and the refresh test drove the
departed shape but asserted STATE ONLY. An arm cannot be killed in a case the
suite never constructs, which is the same class as the `_refusal` near-miss one
layer up: not a weak arm, a missing fixture.

`_dispose` now READS the issue state (the pattern `close_issue_on_github`
already uses) and the body reports what it saw. `test_a_disposition_body_reports_the_state_it_read_and_asserts_none`
is parametrised over BOTH `OPEN` and `CLOSED` for that reason: a fixture that
could only produce `OPEN` cannot distinguish "reports what it read" from
"always says OPEN", which is exactly the bug.

Run: python -m pytest tools/drain/__tests__/test_dispositions.py
"""
from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import tick
from ledger import (
    AUDIT_REOPENED,
    CLOSED,
    DECLINED,
    IN_FLIGHT,
    NEEDS_AUDIT,
    PARKED,
    READY,
    Ledger,
    LedgerChangedError,
)

import gates

POLICY = gates.load_policy(os.path.join(os.path.dirname(__file__), "..", "policy.json"))
REPO = "owner/repo"

#: The two live cases #4677 names, used as fixture numbers so the tests read as
#: the work they were written for. NOT disposed anywhere real -- the coordinator
#: decides dispositions; these are integers in a tmp_path ledger.
BLOCKED_ON_A_RUNNER = 2958      # needs an in-VNet runner; blocker + owner known
BOT_FILED_SELF_RESOLVED = 4534  # synthetic-monitor alert that auto-resolved


def _led(tmp_path, numbers=(BLOCKED_ON_A_RUNNER,)) -> Ledger:
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    for n in numbers:
        led.upsert(n, f"issue {n}", "W6-ci", lane="lane:ci", size=1)
    return led


def _live(numbers, labels=("lane:ci", "sp:1")):
    return [
        {"number": n, "title": f"issue {n}", "labels": [{"name": x} for x in labels]}
        for n in numbers
    ]


def _stub_gh(monkeypatch, *, rc=0, err="", issue_state="OPEN", view_rc=0):
    """Record every argv `tick.sh` is handed, and answer each `gh` sub-command.

    RETURNS THE LIST rather than a count. Half the assertions here are about
    WHICH command ran -- `gh issue comment` and never `gh issue close` -- and a
    counter cannot tell those apart, which is precisely the acceptance line
    ("neither closes the GitHub issue") that a count would leave unwitnessed.

    `issue_state` answers the `gh issue view` that `_dispose` makes before
    composing a body. It is a PARAMETER rather than a constant because the whole
    point of that read is that the body reports what was seen, and a fixture that
    could only produce one answer could not witness the other.

    `view_rc` and `rc` are SEPARATE so a test can fail the comment while the read
    succeeds. Collapsing them would have made `test_a_failed_comment_...` fail at
    the READ instead, i.e. exercise a different branch than its name claims --
    the fixture-never-reaches-the-rule shape `assertion-design.md` is about.
    """
    calls: list[list[str]] = []

    def fake_sh(args):
        calls.append(list(args))
        if args[:3] == ["gh", "issue", "view"]:
            if view_rc != 0:
                return view_rc, "", "could not resolve host: github.com"
            # THE URL IS BUILT FROM THE `--repo` ARGV, not from the module
            # constant. `_read_issue_on_github` compares the url it got back
            # against the repo it asked about (the transferred-issue guard), and
            # a hard-coded owner made every `main()`-driven test refuse with
            # "an issue this tool was not asked about" -- a fixture disagreeing
            # with the rule, which is the shape that makes a test measure the
            # wrong branch while looking right.
            asked = args[args.index("--repo") + 1]
            return 0, json.dumps({
                "state": issue_state,
                "title": "an issue",
                "url": f"https://github.com/{asked}/issues/{args[3]}",
            }), ""
        return rc, "", err

    monkeypatch.setattr(tick, "sh", fake_sh)
    return calls


def _bodies(calls) -> list[str]:
    """Every `--body` argv element, in order. The comment calls, and only those."""
    return [c[c.index("--body") + 1] for c in calls if "--body" in c]


def _unchanged(item) -> tuple:
    """The fields a refusal must not have touched, as one comparable value."""
    return (item.state, item.blocker, item.owner, len(item.history))


def _refusal(call) -> BaseException:
    """Run `call`, require that it raised SOMETHING, and hand the exception back.

    DELIBERATELY WIDE, and the width is the fix rather than laziness. The first
    version of the three tests below used `pytest.raises(DispositionRefusedError)`
    and then asserted `calls == []` after it -- and under the very mutation each
    one exists to kill, the CLI check is gone, the LEDGER refuses instead with a
    `ValueError`, `pytest.raises` fails on the class mismatch, and the `calls`
    assertion NEVER EXECUTES. The arm still scored killed, so the matrix looked
    right, but it was killed by the exception class while the docstring claimed
    the published-comment assertion was load-bearing. That is assertion-design's
    "a test that asserts on a MESSAGE while the mutation changes only a COUNT"
    with the labels swapped: the claim about WHICH assertion has the kill power
    was false, measured by reading the mutated run rather than by reasoning.

    Catching the exception here lets BOTH assertions run on every arm, so
    `calls == []` is genuinely the one that sees a published comment, and the
    class check is genuinely the one that sees which layer refused.
    """
    with pytest.raises(Exception) as caught:  # noqa: PT011 - see the docstring
        call()
    return caught.value


# ---------------------------------------------------------------------------
# The happy paths -- state, evidence, history, and the PUBLIC record
# ---------------------------------------------------------------------------


def test_park_records_the_state_the_blocker_the_owner_and_the_reason(monkeypatch, tmp_path):
    """WHAT MAKES THIS FAIL: stop writing either field, or stop transitioning.

    They are separate halves and both are pinned, because a park that records
    the blocker but leaves the item `ready` is still schedulable and gets redone
    -- the #4489 shape one state over -- while a park that transitions without
    recording the fields is refused by `ledger.transition()` and never lands at
    all. The history assertion fails if the reason stops reaching the item's own
    record, which is half of the issue's acceptance ("write the reason into the
    item's history AND post it as an issue comment").
    """
    led = _led(tmp_path)
    _stub_gh(monkeypatch)

    said = tick.park_item(
        led, POLICY, REPO, BLOCKED_ON_A_RUNNER,
        "no in-VNet runner exists to reach the private endpoint", "operator",
    )

    item = led.items[BLOCKED_ON_A_RUNNER]
    assert item.state == PARKED
    assert item.blocker == "no in-VNet runner exists to reach the private endpoint"
    assert item.owner == "operator"
    assert "no in-VNet runner" in item.history[-1], (
        "the reason must reach the item's own history, not only the issue"
    )
    assert "operator" in item.history[-1]
    assert f"#{BLOCKED_ON_A_RUNNER}" in said
    assert PARKED in said


def test_decline_records_the_state_and_the_decision(monkeypatch, tmp_path):
    """WHAT MAKES THIS FAIL: wrap the decision instead of passing it through.

    The decision reaches `transition` VERBATIM as its `why`, and the history
    line is where that shows. Wrap it -- `f"declined: {decision}"` -- and this
    still passes, but `test_decline_refuses_without_a_decision` gains a second
    way to go red, because the ledger's own `why and why.strip()` check would be
    satisfied by the wrapper on a decision of None. The two tests pin opposite
    ends of the same choice.
    """
    led = _led(tmp_path, numbers=(BOT_FILED_SELF_RESOLVED,))
    _stub_gh(monkeypatch)

    said = tick.decline_item(
        led, POLICY, REPO, BOT_FILED_SELF_RESOLVED,
        "bot-filed synthetic-monitor alert, auto-resolved by the same bot; "
        "operational page, not backlog work",
    )

    item = led.items[BOT_FILED_SELF_RESOLVED]
    assert item.state == DECLINED
    assert "auto-resolved by the same bot" in item.history[-1]
    assert DECLINED in said


@pytest.mark.parametrize(
    ("dispose", "expect_head"),
    [
        (
            lambda led: tick.park_item(
                led, POLICY, REPO, BLOCKED_ON_A_RUNNER, "no in-VNet runner", "operator"
            ),
            tick.DISPOSITION_HEADS[PARKED],
        ),
        (
            lambda led: tick.decline_item(
                led, POLICY, REPO, BLOCKED_ON_A_RUNNER, "operator: not backlog work"
            ),
            tick.DISPOSITION_HEADS[DECLINED],
        ),
    ],
    ids=["park", "decline"],
)
def test_a_disposition_comments_on_the_issue_and_never_closes_it(
    monkeypatch, tmp_path, dispose, expect_head
):
    """THE ACCEPTANCE LINE, asserted on the argv rather than on a count.

    WHAT MAKES THIS FAIL, three separate ways, and each is a real defect:

    - route either verb through `close_issue_on_github` (or add a `gh issue
      close` of its own) and `verbs == [("issue", "comment")]` goes red. Closing
      a blocked item's issue is how a backlog lies about itself (R2, #4535);
      closing a declined one invents the `--reason not-planned` judgement no
      program made.
    - post no comment at all -- keep the disposition in `state.json`, which is
      gitignored -- and the same assertion goes red on an empty list. That is
      the other half of the acceptance: the next reader has to find the reason
      where they are.
    - drop the evidence from the body and the `expect_head`/`in body` pair goes
      red. A comment that announces a park without naming the blocker is the
      "indistinguishable from forgetting" state with extra steps.

    The head is read from `tick.DISPOSITION_HEADS` rather than transcribed, per
    assertion-design #3: a probe that carries its own copy of the string can
    disagree with the implementation and nothing notices.
    """
    led = _led(tmp_path)
    calls = _stub_gh(monkeypatch)

    dispose(led)

    verbs = [(c[1], c[2]) for c in calls if c[0] == "gh"]
    assert verbs == [("issue", "view"), ("issue", "comment")], (
        "a disposition READS the issue state, posts exactly one comment, and "
        f"closes NOTHING; the harness ran {calls}"
    )
    argv = calls[1]
    assert argv[3] == str(BLOCKED_ON_A_RUNNER)
    assert "--repo" in argv
    assert REPO in argv
    body = argv[argv.index("--body") + 1]
    assert body.startswith(expect_head)
    assert body.isascii(), (
        "the body is argv on a cp1252 console and a public artifact; a non-ASCII "
        "character here has been decoded wrong on both before"
    )


def test_the_park_comment_refuses_the_declines_escape_and_the_decline_names_it(
    monkeypatch, tmp_path
):
    """The bodies are UNREVISABLE once posted, so the asymmetry is pinned.

    WHAT MAKES THIS FAIL: swap the two bodies, or collapse them into one shared
    template. The park and the decline differ on the single fact a reader of the
    issue most needs — what the harness will and will not do to the ISSUE — and
    a shared template is exactly how `_receipt_comment`'s two routes came to say
    the same wrong thing (its own docstring records it).

    The decline body naming `--reason not-planned` is not decoration: while the
    issue is open, the next refresh WILL demote the item, and without the escape
    stated at the artifact the reader is standing on, that demotion reads as the
    harness undoing itself. The park body must NOT name it, because a park has
    no such escape and offering one invites the close #4535 refused.
    """
    led = _led(tmp_path, numbers=(BLOCKED_ON_A_RUNNER, BOT_FILED_SELF_RESOLVED))
    calls = _stub_gh(monkeypatch)

    tick.park_item(led, POLICY, REPO, BLOCKED_ON_A_RUNNER, "no runner", "operator")
    tick.decline_item(led, POLICY, REPO, BOT_FILED_SELF_RESOLVED, "operator: self-resolved")

    park_body, decline_body = _bodies(calls)

    assert "WILL NOT CLOSE THIS ISSUE" in park_body
    assert "not-planned" not in park_body, (
        "a park has no close at all; offering the decline's disposal would invite "
        "exactly the close #4535 refused"
    )
    assert "--reason not-planned" in decline_body, (
        "the decline's demotion by the next refresh is correct behaviour, and the "
        "escape that makes the decline stand has to be named where the reader is"
    )
    assert "needs-audit" in decline_body


@pytest.mark.parametrize(
    ("dispose", "label"),
    [
        (
            lambda led, n: tick.park_item(led, POLICY, REPO, n, "no runner", "operator"),
            "park",
        ),
        (
            lambda led, n: tick.decline_item(led, POLICY, REPO, n, "operator: self-resolved"),
            "decline",
        ),
    ],
    ids=["park", "decline"],
)
@pytest.mark.parametrize("state", [READY, IN_FLIGHT, NEEDS_AUDIT], ids=lambda s: str(s))
@pytest.mark.parametrize("issue_state", ["OPEN", "CLOSED"])
def test_a_disposition_body_reports_the_state_it_read_and_asserts_none(
    monkeypatch, tmp_path, dispose, label, state, issue_state
):
    """MUTATION ARM: DP4 — the park body asserts the issue is open again.

    THE REVIEW BLOCKER THIS EXISTS FOR, raised independently by both reviewers,
    and the gap it fills is a MISSING CASE rather than a weak arm. The park body
    used to open, unconditionally, with "THIS ISSUE STAYS OPEN, DELIBERATELY" —
    a claim about the ISSUE'S state that nothing on this path established. It is
    reachable on exactly the population #4677 serves: `_dispose` refuses only an
    unknown or already-terminal item, so a `needs-audit`/departed item gets here,
    and `refresh_from_github`'s own matrix carries the cell
    `parked | departed -> survives parked` — the ledger explicitly contemplates a
    parked item whose issue is closed.

    Measured 2026-09-24 on the four cases #4677 names: #2958 OPEN, but #4534,
    #4582 and #4664 all CLOSED. Three of four would have published a sentence
    that was false at the moment it posted (R7, unrevisable artifact). Cheap to
    fix only because no real item has been disposed yet.

    **Why 366 arms did not catch it.** Nothing rendered a body for a departed
    item. The old state-asymmetry test built both items `ready`, and the refresh
    test drove the departed shape but asserted STATE ONLY. A matrix cannot kill
    an arm in a case no test constructs — the same class as this file's other
    disclosed near-miss (`_refusal`), one layer up.

    WHAT MAKES EACH ASSERTION FAIL:
    - `issue_state in body` — hard-code either state into the body (that IS
      DP4), or stop passing the read through, and the `CLOSED` parameter goes
      red while `OPEN` stays green. **That asymmetry is the whole design of this
      parametrisation**: a fixture that could only produce `OPEN` could not
      distinguish "reports what it read" from "always says OPEN", which is
      precisely the bug.
    - `STATE_READ_DISCLOSURE in body` — drop the observation framing and assert
      the present tense instead. The read happens a moment before the post and
      the issue can close a second later, so a standing claim is the same R7
      error one step down the road.

    `NEEDS_AUDIT` is the item-state parameter that fills the reviewer's gap;
    `READY` and `IN_FLIGHT` are here so the claim is about EVERY non-terminal
    origin rather than about one.
    """
    led = _led(tmp_path)
    calls = _stub_gh(monkeypatch, issue_state=issue_state)
    if state != READY:
        if state == NEEDS_AUDIT:
            led.items[BLOCKED_ON_A_RUNNER].audit_reason = "departed"
        led.transition(BLOCKED_ON_A_RUNNER, state, "fixture")

    dispose(led, BLOCKED_ON_A_RUNNER)
    body = _bodies(calls)[0]

    # LIFTED from the module, never transcribed (assertion-design #3): a probe
    # carrying its own copy of the sentence can drift from the implementation.
    assert tick.STATE_READ_DISCLOSURE in body, (
        f"the {label} body must frame the state as an OBSERVATION it read, not "
        "as a standing claim; the issue can change a second after the post"
    )
    assert f"{tick.STATE_READ_DISCLOSURE} {issue_state}." in body, (
        f"the body must report the state it actually READ ({issue_state}); "
        "three of the four items #4677 names are CLOSED, and a body hard-coded "
        "to OPEN is false on all three"
    )
    # Both cells stay documented whichever was observed, because a reader who
    # closes this issue tomorrow needs to know what happens then.
    assert "while this issue is OPEN" in body
    assert "if this issue is CLOSED" in body

    # ABSENCE, PAIRED with the positives above (assertion-design #4) and
    # DECLARED FOR WHAT IT IS: this is a REGRESSION GUARD on the exact sentence
    # that was reverted, not a discovery instrument. It cannot find the same
    # claim reworded — the positive assertions above are what do that — and a
    # clean result here is not evidence the body is honest.
    assert "THIS ISSUE STAYS OPEN" not in body


def test_a_disposition_refuses_when_the_issue_state_cannot_be_read(monkeypatch, tmp_path):
    """UNREADABLE IS NOT "OPEN" (deploy-integrity R7), and the body needs to know.

    WHAT MAKES THIS FAIL: default the state to `OPEN` when the read fails, or
    swallow the read error. Either publishes a permanent sentence reporting a
    state the tool never observed — the roll that said "the tag does not exist"
    when the truth was "I could not reach the registry", on an artifact that
    cannot be edited afterwards.

    `_comments == []` is the assertion that sees it: the read is the FIRST `gh`
    call, so a failure here must leave the issue with no comment at all.
    """
    led = _led(tmp_path)
    calls = _stub_gh(monkeypatch, view_rc=1)
    before = _unchanged(led.items[BLOCKED_ON_A_RUNNER])

    exc = _refusal(lambda: tick.park_item(
        led, POLICY, REPO, BLOCKED_ON_A_RUNNER, "no runner", "operator"))

    assert _bodies(calls) == [], "an unreadable state must not publish a guess"
    assert isinstance(exc, tick.DispositionCommentFailedError)
    assert "UNKNOWN" in str(exc)
    assert _unchanged(led.items[BLOCKED_ON_A_RUNNER]) == before


def test_dispose_refuses_a_state_it_does_not_record(monkeypatch, tmp_path):
    """REVIEW FINDING: `_dispose(..., CLOSED, ...)` used to raise a bare KeyError.

    It raised from `DISPOSITION_HEADS[target_state]` while the composed call's
    ARGUMENTS were being evaluated — fail-closed (a reviewer measured
    `gh calls: []`) but unreadable, and it meant `post_disposition_comment`'s
    `CLOSES_ON_GITHUB` mirror guard could never fire through this route at all.

    WHAT MAKES THIS FAIL: remove the target-state check and the refusal reverts
    to `KeyError: 'closed'`, which `main()` does not catch and which tells the
    operator nothing about what it should have passed instead.
    """
    led = _led(tmp_path)
    calls = _stub_gh(monkeypatch)

    exc = _refusal(lambda: tick._dispose(
        led, POLICY, REPO, BLOCKED_ON_A_RUNNER, CLOSED, [("X", "y")], "why"))

    assert isinstance(exc, tick.DispositionRefusedError), (
        f"a bad target state must refuse like everything else here, not raise "
        f"{type(exc).__name__}"
    )
    assert "--record-receipt" in str(exc), "and it must name what to use instead"
    assert calls == []


# ---------------------------------------------------------------------------
# The refusals -- and the whole point is that they are SILENT UPSTREAM
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("missing", [None, "", "   "], ids=["none", "empty", "blank"])
def test_park_refuses_without_a_blocker(monkeypatch, tmp_path, missing):
    """MUTATION ARM: delete the blocker check in `park_item` (DP1).

    WHAT MAKES THIS FAIL, measured against the arm rather than reasoned about
    (`python tools/drain/mutate_gates.py`, arm DP1), and the three parameters do
    NOT fail the same way:

    - `''` and `'   '` -- `calls == []` goes red. The mutant reaches
      `post_disposition_comment` and PUBLISHES a park announcement on a public
      issue; `transition` then refuses, and no re-run removes the comment. That
      is the only outcome the ledger's own identical bar cannot protect, which
      is why this check exists at all, and these two parameters are the ones
      that witness it.
    - absent -- the CLASS assertion goes red instead, because the mutant dies
      one line earlier on `None.strip()`. Still a defect (a traceback where a
      refusal belongs) but not a publication, and saying otherwise would claim
      a harm this input does not produce.

    The blank variant is not decoration: `--blocker '   '` satisfies a bare
    truthiness test and names nothing.
    """
    led = _led(tmp_path)
    calls = _stub_gh(monkeypatch)
    before = _unchanged(led.items[BLOCKED_ON_A_RUNNER])

    exc = _refusal(lambda: tick.park_item(
        led, POLICY, REPO, BLOCKED_ON_A_RUNNER, missing, "operator"))

    assert calls == [], (
        "a refused park must not publish anything on the issue - with the CLI "
        f"check gone the ledger still refuses, but only after {calls}"
    )
    assert isinstance(exc, tick.DispositionRefusedError), (
        f"the CLI must refuse, not the ledger; got {type(exc).__name__}: {exc}"
    )
    assert "BLOCKER" in str(exc)
    assert _unchanged(led.items[BLOCKED_ON_A_RUNNER]) == before


@pytest.mark.parametrize("missing", [None, "", "   "], ids=["none", "empty", "blank"])
def test_park_refuses_without_an_owner(monkeypatch, tmp_path, missing):
    """MUTATION ARM: delete the owner check in `park_item` (DP2).

    A SEPARATE check rather than a conjunction, for exactly this reason:
    `transition` can only say "one of these is missing", and an arm that deletes
    the owner half alone has to be visible on its own. The three parameters
    split the same way the blocker's do -- `''` and `'   '` go red on
    `calls == []` with the published argv in the message, absent goes red on the
    class.

    A park with no owner is how an item leaves the queue without leaving the
    backlog -- `ledger.transition()`'s own words for it.
    """
    led = _led(tmp_path)
    calls = _stub_gh(monkeypatch)
    before = _unchanged(led.items[BLOCKED_ON_A_RUNNER])

    exc = _refusal(lambda: tick.park_item(
        led, POLICY, REPO, BLOCKED_ON_A_RUNNER, "no runner", missing))

    assert calls == [], (
        f"a refused park must not publish anything on the issue; ran {calls}"
    )
    assert isinstance(exc, tick.DispositionRefusedError), (
        f"the CLI must refuse, not the ledger; got {type(exc).__name__}: {exc}"
    )
    assert "OWNER" in str(exc)
    assert _unchanged(led.items[BLOCKED_ON_A_RUNNER]) == before


@pytest.mark.parametrize("missing", [None, "", "   "], ids=["none", "empty", "blank"])
def test_decline_refuses_without_a_decision(monkeypatch, tmp_path, missing):
    """MUTATION ARM: delete the decision check in `decline_item` (DP3).

    WHAT MAKES THIS FAIL: on `''` and `'   '`, `calls == []` -- the decision is
    handed to `transition` verbatim, so the ledger would still refuse the
    decline, after the comment had been posted announcing one nobody recorded a
    reason for. On an absent decision the mutant dies on `None.strip()` and the
    class assertion is what sees it.

    'Will not do' with no recorded reason is how a backlog declines itself
    drained: `drained()` is this program's stop signal, and 297 items could have
    reached it on zero evidence before the ledger grew this bar.
    """
    led = _led(tmp_path, numbers=(BOT_FILED_SELF_RESOLVED,))
    calls = _stub_gh(monkeypatch)
    before = _unchanged(led.items[BOT_FILED_SELF_RESOLVED])

    exc = _refusal(lambda: tick.decline_item(
        led, POLICY, REPO, BOT_FILED_SELF_RESOLVED, missing))

    assert calls == [], (
        f"a refused decline must not publish anything on the issue; ran {calls}"
    )
    assert isinstance(exc, tick.DispositionRefusedError), (
        f"the CLI must refuse, not the ledger; got {type(exc).__name__}: {exc}"
    )
    assert "DECISION" in str(exc)
    assert _unchanged(led.items[BOT_FILED_SELF_RESOLVED]) == before


def test_a_disposition_refuses_an_item_the_ledger_does_not_hold(monkeypatch, tmp_path):
    """WHAT MAKES THIS FAIL: `led.items[number]` on an unknown number raises
    `KeyError` AFTER the comment, so a typo in the issue number would put a park
    announcement on somebody else's issue. `calls == []` is the assertion that
    sees it, and `_refusal` is what lets it run when the class changes."""
    led = _led(tmp_path)
    calls = _stub_gh(monkeypatch)

    exc = _refusal(lambda: tick.park_item(led, POLICY, REPO, 999999, "a blocker", "an owner"))

    assert calls == [], f"a typo must not comment on a stranger's issue; ran {calls}"
    assert isinstance(exc, tick.DispositionRefusedError)
    assert "not in the ledger" in str(exc)


@pytest.mark.parametrize("terminal", [PARKED, DECLINED, CLOSED], ids=lambda s: str(s))
def test_a_disposition_refuses_an_already_terminal_item(monkeypatch, tmp_path, terminal):
    """Re-disposing a terminal item rewrites the evidence the first disposition
    rests on -- the refusal `record_receipt_from_evidence` makes at its own top.

    WHAT MAKES THIS FAIL: drop the terminal guard and a second `--park` on an
    already-parked item overwrites its blocker and owner with new ones, posts a
    second comment, and leaves the first disposition's history line asserting a
    reason no field still carries.

    This is ALSO what bounds the duplicate-comment window: `post_disposition_comment`
    has no read-before-write short circuit (de-duplicating against the comment
    list is #4579's open problem), so this guard is the only thing standing
    between a re-run and a second announcement.
    """
    led = _led(tmp_path)
    item = led.items[BLOCKED_ON_A_RUNNER]
    if terminal == CLOSED:
        led.record_receipt(BLOCKED_ON_A_RUNNER, "ci-green", "green at sha")
        led.transition(BLOCKED_ON_A_RUNNER, CLOSED)
    else:
        item.blocker, item.owner = "the first blocker", "the first owner"
        led.transition(BLOCKED_ON_A_RUNNER, terminal, "the first disposition")
    before = _unchanged(item)
    calls = _stub_gh(monkeypatch)

    with pytest.raises(tick.DispositionRefusedError, match="terminal"):
        tick.park_item(led, POLICY, REPO, BLOCKED_ON_A_RUNNER, "a new blocker", "a new owner")

    assert calls == []
    assert _unchanged(item) == before


# ---------------------------------------------------------------------------
# The two writes fail independently -- which one moved, and what it costs
# ---------------------------------------------------------------------------


def test_a_failed_comment_leaves_the_ledger_untouched(monkeypatch, tmp_path):
    """The comment goes FIRST, so its failure is the cheap one.

    WHAT MAKES THIS FAIL: treat a non-zero `gh` exit as success. The item would
    go terminal with no public trace at all and `state.json` is gitignored, so
    the disposition's whole existence would be a local file -- and `_dispose`
    refuses a terminal item, so no re-run ever repairs it. Permanent and silent.
    """
    led = _led(tmp_path)
    _stub_gh(monkeypatch, rc=1, err="HTTP 502")
    before = _unchanged(led.items[BLOCKED_ON_A_RUNNER])

    with pytest.raises(tick.DispositionCommentFailedError, match="502"):
        tick.park_item(led, POLICY, REPO, BLOCKED_ON_A_RUNNER, "no runner", "operator")

    assert _unchanged(led.items[BLOCKED_ON_A_RUNNER]) == before
    assert led.items[BLOCKED_ON_A_RUNNER].state == READY, (
        "the item stays in the queue, which is the recoverable direction"
    )


def test_a_ledger_write_that_fails_after_the_comment_restores_the_item(monkeypatch, tmp_path):
    """THE REVERSE PATH, and the rollback has to include the HISTORY.

    WHAT MAKES THIS FAIL: drop the `del item.history[history_len:]` and the item
    reads `state=ready blocker=None` while its history asserts a park -- the
    fields say one thing and the record says another, which a reviewer of
    `_record_close_in_ledger` identified as worse than keeping or dropping both.
    Drop the field restore and a later `--park` inherits a stale blocker.

    The exception class is pinned because it is what tells the operator that the
    COMMENT IS PUBLISHED. A refusal-shaped message here would say "nothing was
    written" over a public artifact that exists (R7).
    """
    led = _led(tmp_path)
    _stub_gh(monkeypatch)
    item = led.items[BLOCKED_ON_A_RUNNER]
    before = _unchanged(item)

    def transition_that_fails(*_args, **_kwargs):
        raise RuntimeError("the ledger refused")

    monkeypatch.setattr(led, "transition", transition_that_fails)

    with pytest.raises(tick.LedgerWriteAfterCommentError, match="STILL ready"):
        tick.park_item(led, POLICY, REPO, BLOCKED_ON_A_RUNNER, "no runner", "operator")

    assert _unchanged(item) == before, "the rollback restores the fields AND the history"
    assert item.blocker is None
    assert item.owner is None


def test_post_disposition_comment_refuses_a_state_that_closes_on_github(tmp_path):
    """The MIRROR of `close_issue_on_github`'s guard, called DIRECTLY.

    DISCLOSED, in the form that function's own test uses: no production caller
    reaches this branch. `_dispose` is called only with `PARKED` and `DECLINED`,
    so this is a fail-closed precondition for callers that do not exist yet, and
    it is not counted as coverage of any live path.

    WHAT IT WOULD FAIL ON IF ONE EXISTED: a future route that commented on a
    `closed` item without closing it would produce the #4545 artifact -- a
    ledger close with no upstream one -- and this refuses it before any argv is
    built. Asserted over `CLOSES_ON_GITHUB` rather than the literal `closed`, so
    a state ADDED to that tuple inherits the guard instead of quietly escaping
    it.
    """
    del tmp_path
    for state in tick.CLOSES_ON_GITHUB:
        with pytest.raises(tick.DispositionCommentFailedError, match="close the issue"):
            tick.post_disposition_comment(POLICY, REPO, 1, state, "body")


# ---------------------------------------------------------------------------
# THE LOAD-BEARING PAIR -- the park survives a refresh, the decline does not
# ---------------------------------------------------------------------------


def test_a_park_survives_a_refresh_and_a_decline_is_demoted(monkeypatch, tmp_path):
    """MUTATION ARM: add `parked` to `REOPEN_DISPUTES` (arm L26, the #2874 bug).

    ONE refresh, over BOTH items, deliberately. Taken apart:

    - the park half alone is satisfied by an implementation that never refreshes
      at all, so it would witness nothing;
    - the decline half alone is satisfied by one that demotes every terminal
      item, which IS #2874 -- every refresh demoted every park, `needs-audit` is
      non-terminal, and `drained()` became unreachable for anything genuinely
      blocked. It lasted thirteen seconds.

    Together they pin the asymmetry rather than either behaviour, and the
    asymmetry is the thing `REOPEN_DISPUTES` encodes.

    WHAT MAKES EACH ASSERTION FAIL:
    - `parked` in `REOPEN_DISPUTES` -> the first assertion reads `needs-audit`.
    - `declined` out of it -> the second reads `declined` and `audit_reason` is
      None, and a decline that never reached GitHub would never be questioned.

    Driven from the NEW VERBS, not from a hand-built item. `test_tick.py`
    already pins the ledger-level behaviour on an item assembled by setting
    `.blocker`/`.owner` directly; what was never pinned is that a park reached
    THROUGH `--park` lands in a shape the refresh leaves alone -- which is the
    whole of this issue's fifth acceptance line.
    """
    led = _led(tmp_path, numbers=(BLOCKED_ON_A_RUNNER, BOT_FILED_SELF_RESOLVED))
    _stub_gh(monkeypatch)

    tick.park_item(
        led, POLICY, REPO, BLOCKED_ON_A_RUNNER,
        "no in-VNet runner exists", "operator",
    )
    tick.decline_item(
        led, POLICY, REPO, BOT_FILED_SELF_RESOLVED,
        "operator: bot-filed alert, auto-resolved; operational page",
    )
    assert led.drained() is True, (
        "both items terminal is the precondition; if this is already false the "
        "two assertions below are measuring the wrong thing"
    )

    # BOTH ISSUES STILL OPEN ON GITHUB -- which is a park's EXPECTED condition
    # and a decline's unresolved one, because neither verb closes anything.
    tick.refresh_from_github(
        led, {}, _live((BLOCKED_ON_A_RUNNER, BOT_FILED_SELF_RESOLVED))
    )

    park = led.items[BLOCKED_ON_A_RUNNER]
    assert park.state == PARKED, (
        "a park is BLOCKED, not done - its issue is supposed to stay open, so "
        "being open disputes nothing (#2874)"
    )
    assert park.audit_reason is None
    assert park.blocker == "no in-VNet runner exists"
    assert park.owner == "operator"

    decline = led.items[BOT_FILED_SELF_RESOLVED]
    assert decline.state == NEEDS_AUDIT, (
        "a declined item still OPEN upstream means the decline never reached "
        "GitHub or somebody is disputing it - both want a look (#4535)"
    )
    assert decline.audit_reason == AUDIT_REOPENED
    assert led.drained() is False, "needs-audit is non-terminal"


def test_the_declines_documented_escape_actually_restores_drained(monkeypatch, tmp_path):
    """The other end of that asymmetry: a park has no way out, a decline does.

    The comment this verb posts tells the reader to close the issue by hand with
    `--reason not-planned`, and this pins that the advice WORKS -- an escape
    named in a permanent public artifact that did not restore the decline would
    be a false claim on an unrevisable surface (R7).

    WHAT MAKES THIS FAIL: narrow the departure loop in `refresh_from_github`
    from `TERMINAL` to `REOPEN_DISPUTES` and the hand-closed declined item is
    flagged `departed` instead of surviving, so `drained()` never comes back and
    the escape is a dead end.
    """
    led = _led(tmp_path, numbers=(BLOCKED_ON_A_RUNNER, BOT_FILED_SELF_RESOLVED))
    _stub_gh(monkeypatch)
    tick.park_item(led, POLICY, REPO, BLOCKED_ON_A_RUNNER, "no runner", "operator")
    tick.decline_item(led, POLICY, REPO, BOT_FILED_SELF_RESOLVED, "operator: not backlog work")

    # Somebody performs the disposal the comment names: the issue leaves the
    # open set. The park's issue stays open, because a park's does.
    _, departed = tick.refresh_from_github(led, {}, _live((BLOCKED_ON_A_RUNNER,)))

    assert departed == 0, "a terminal item that left the open set is expected, not audited"
    assert led.items[BOT_FILED_SELF_RESOLVED].state == DECLINED
    assert led.items[BLOCKED_ON_A_RUNNER].state == PARKED
    assert led.drained() is True, (
        "this is the exit condition #4677 exists to make attainable: a backlog "
        "whose remainder is genuinely blocked or genuinely will-not-do must be "
        "able to STOP"
    )


# ---------------------------------------------------------------------------
# WIRING -- a verb main() does not dispatch is a verb that does not exist
# ---------------------------------------------------------------------------


def _main_over(monkeypatch, tmp_path, argv, *, seed=True):
    """Drive `tick.main()` end to end with the network stubbed out.

    `read_live_issues` is stubbed to RAISE rather than to return a list: a
    disposition must return before it, for the reason `--record-receipt` does,
    and here it matters more than anywhere -- the refresh is what demotes a
    declined item, so a `--decline` that fell through to it would be undone by
    the very command that recorded it. An empty-list stub would let that happen
    silently.
    """
    state = str(tmp_path / "state.json")
    if seed:
        led = Ledger(state, receipts=POLICY["receipts"])
        for n in (BLOCKED_ON_A_RUNNER, BOT_FILED_SELF_RESOLVED):
            led.upsert(n, f"issue {n}", "W6-ci", lane="lane:ci", size=1)
        led.save()
    monkeypatch.setattr(tick, "STATE_PATH", state)

    def refuse(_repo):
        raise AssertionError("a disposition must return before read_live_issues")

    monkeypatch.setattr(tick, "read_live_issues", refuse)
    monkeypatch.setattr(sys, "argv", ["tick.py", *argv])
    return tick.main(), state


def test_main_parks_an_item_and_persists_it(monkeypatch, tmp_path):
    """WHAT MAKES THIS FAIL: dispatch the verb and never save.

    The assertion re-READS the file rather than inspecting the in-memory ledger,
    because those are different claims and only the second one survives the
    process. A `--park` that mutates memory and exits 0 loses the disposition
    entirely and the item is selectable again next cycle.
    """
    calls = _stub_gh(monkeypatch)
    rc, state = _main_over(monkeypatch, tmp_path, [
        "--park", str(BLOCKED_ON_A_RUNNER),
        "--blocker", "no in-VNet runner exists",
        "--owner", "operator",
    ])

    assert rc == 0
    persisted = Ledger(state, receipts=POLICY["receipts"]).load()
    assert persisted.items[BLOCKED_ON_A_RUNNER].state == PARKED
    assert persisted.items[BLOCKED_ON_A_RUNNER].owner == "operator"
    assert [c[1:3] for c in calls] == [["issue", "view"], ["issue", "comment"]]


def test_main_declines_an_item_and_persists_it(monkeypatch, tmp_path):
    """The sibling. WHAT MAKES THIS FAIL: the same, for the other verb -- and
    the two dispatch through one `if`, so a branch that handled only `--park`
    would exit 0 having done nothing at all for `--decline`."""
    _stub_gh(monkeypatch)
    rc, state = _main_over(monkeypatch, tmp_path, [
        "--decline", str(BOT_FILED_SELF_RESOLVED),
        "--decision", "operator: bot-filed alert, auto-resolved by the same bot",
    ])

    assert rc == 0
    persisted = Ledger(state, receipts=POLICY["receipts"]).load()
    assert persisted.items[BOT_FILED_SELF_RESOLVED].state == DECLINED


@pytest.mark.parametrize(
    "argv",
    [
        ["--park", "1", "--blocker", "b", "--owner", "o", "--decline", "2", "--decision", "d"],
        ["--park", "1", "--blocker", "b", "--owner", "o", "--record-receipt", "2"],
        ["--park", "1", "--blocker", "b", "--owner", "o", "--bind-pr", "2", "--pr", "3"],
    ],
    ids=["park+decline", "park+record", "park+bind"],
)
def test_main_refuses_two_write_verbs_in_one_invocation(monkeypatch, tmp_path, argv):
    """WHAT MAKES THIS FAIL: let one verb win silently.

    That is the defect the old pairwise `--bind-pr`/`--record-receipt` check
    named in its own comment -- "one transaction and no hint that the other was
    dropped" -- and with four write verbs the pairwise form needs six
    comparisons nobody would remember to add. `calls == []` pins that the
    refusal happens before any GitHub write, so a rejected argv cannot leave a
    comment behind.
    """
    calls = _stub_gh(monkeypatch)
    rc, _state = _main_over(monkeypatch, tmp_path, argv)
    assert rc == 2
    assert calls == []


@pytest.mark.parametrize(
    ("argv", "flag"),
    [
        (["--decline", "1", "--decision", "d", "--blocker", "b"], "--blocker"),
        (["--decline", "1", "--decision", "d", "--owner", "o"], "--owner"),
        (["--park", "1", "--blocker", "b", "--owner", "o", "--decision", "d"], "--decision"),
        (["--record-receipt", "1", "--pr", "2"], "--pr"),
    ],
    ids=["blocker-on-decline", "owner-on-decline", "decision-on-park", "pr-on-record"],
)
def test_main_refuses_a_value_flag_whose_verb_was_not_passed(
    monkeypatch, tmp_path, argv, flag, capsys
):
    """WHAT MAKES THIS FAIL: drop the check and the value is discarded in
    silence -- `--park N --decision 'we will not do this'` parks the item and
    throws the decision away, which is the same defect one level down from the
    two-verbs case and reads to the operator as if it had been recorded.

    The message is asserted to NAME the offending flag, because with four of
    them a generic 'unexpected argument' sends the reader back to `--help` to
    work out which.
    """
    _stub_gh(monkeypatch)
    rc, _state = _main_over(monkeypatch, tmp_path, argv)
    assert rc == 2
    assert flag in capsys.readouterr().err


@pytest.mark.parametrize(
    "argv",
    [
        ["--status", "--park", "1", "--blocker", "b", "--owner", "o"],
        ["--status", "--decline", "1", "--decision", "d"],
        ["--status", "--record-receipt", "1"],
        ["--status", "--bind-pr", "1", "--pr", "2"],
    ],
    ids=["park", "decline", "record", "bind"],
)
def test_main_refuses_a_write_verb_passed_beside_status(monkeypatch, tmp_path, argv):
    """REVIEW FINDING: `--status` is a READ and returns FIRST.

    WHAT MAKES THIS FAIL: drop the check and `--status --park N --blocker x
    --owner y` prints the counts and exits **0 having parked nothing** — the
    operator is told the queue's state and never told their transaction was
    discarded. Exactly the silent-drop defect the two-verb and value-with-no-verb
    checks exist for, through a THIRD door nobody had closed.

    `rc == 2` is the assertion that sees it: the unfixed code exits 0.
    `calls == []` additionally pins that nothing was published before the
    refusal.
    """
    calls = _stub_gh(monkeypatch)
    rc, _state = _main_over(monkeypatch, tmp_path, argv)
    assert rc == 2, "an unfixed --status swallows the write verb and exits 0"
    assert calls == []


def test_main_refuses_a_disposition_with_no_ledger(monkeypatch, tmp_path):
    """WHAT MAKES THIS FAIL: fall through to a fresh `Ledger` and refuse with
    `not in the ledger`, which is a different -- and wrong -- diagnosis. "No
    queue" and "an item this queue does not hold" send the reader to different
    remedies, and `--status` already refuses on exactly this distinction."""
    calls = _stub_gh(monkeypatch)
    rc, _state = _main_over(monkeypatch, tmp_path, [
        "--park", str(BLOCKED_ON_A_RUNNER), "--blocker", "b", "--owner", "o",
    ], seed=False)
    assert rc == 2
    assert calls == []


def test_main_refuses_to_save_a_disposition_over_a_rival_write(monkeypatch, tmp_path):
    """The CAS, on this path too. RW14's lesson was that a guarded save in one
    branch says nothing about another, and this branch is a third one.

    WHAT MAKES THIS FAIL: `_save_refusing_lost_update(led)` -> `led.save()`.
    `Ledger.save()` serialises the WHOLE document from memory, so an unguarded
    save here does not conflict with a rival lane's close -- it erases it, and
    the erased item reverts to `ready` with its receipt gone.

    DELIBERATELY NOT RETRIED, unlike `--bind-pr`: a retry would re-enter
    `_dispose` and post a SECOND comment on every attempt, so the property that
    makes a bind safe to retry has no analogue here. The cost of refusing is one
    operator re-run and one duplicate comment; the cost of retrying is three.
    """
    _stub_gh(monkeypatch)
    state = str(tmp_path / "state.json")
    seed = Ledger(state, receipts=POLICY["receipts"])
    for n in (BLOCKED_ON_A_RUNNER, BOT_FILED_SELF_RESOLVED):
        seed.upsert(n, f"issue {n}", "W6-ci", lane="lane:ci", size=1)
    seed.save()

    real_park = tick.park_item

    def park_then_a_rival_writes(led, *args, **kwargs):
        said = real_park(led, *args, **kwargs)
        rival = Ledger(state, receipts=POLICY["receipts"]).load()
        rival.record_receipt(BOT_FILED_SELF_RESOLVED, "ci-green", "green at sha")
        rival.transition(BOT_FILED_SELF_RESOLVED, CLOSED, "the rival closed it")
        rival.save()
        return said

    monkeypatch.setattr(tick, "park_item", park_then_a_rival_writes)
    monkeypatch.setattr(tick, "STATE_PATH", state)
    monkeypatch.setattr(tick, "read_live_issues", lambda _repo: [])
    monkeypatch.setattr(sys, "argv", [
        "tick.py", "--park", str(BLOCKED_ON_A_RUNNER), "--blocker", "b", "--owner", "o",
    ])

    assert tick.main() == 1, "the disposition path saved over a rival's close"
    final = Ledger(state, receipts=POLICY["receipts"]).load()
    assert final.items[BOT_FILED_SELF_RESOLVED].state == CLOSED, (
        "the rival's verified close was discarded"
    )
    assert final.items[BLOCKED_ON_A_RUNNER].state == READY, (
        "and the park did not land either - which is the point of refusing"
    )


def test_the_save_failure_arm_names_the_published_comment(monkeypatch, tmp_path, capsys):
    """WHAT MAKES THIS FAIL: report the save failure as "nothing was written".

    It is false in the half the operator has to act on: the COMMENT IS ON THE
    ISSUE. A narrow `except LedgerChangedError` would also fail this, because a
    `PermissionError` out of `os.replace` would escape `main()` as a traceback
    about a file rename that never mentions the published comment -- the #4545
    shape inside the change meant to make it legible.

    The exception TYPE is asserted present so a lost CAS (the expected one with
    four lanes live) stays distinguishable from a filesystem failure rather than
    flattened into one story the code cannot tell apart.

    The seed is written BEFORE `Ledger.save` is patched, deliberately: patch
    first and the FIXTURE dies on the patched save, so the test would exercise
    the no-ledger branch while appearing to exercise this one.
    """
    state = str(tmp_path / "state.json")
    seed = Ledger(state, receipts=POLICY["receipts"])
    seed.upsert(BLOCKED_ON_A_RUNNER, "issue", "W6-ci", lane="lane:ci", size=1)
    seed.save()
    _stub_gh(monkeypatch)
    monkeypatch.setattr(tick, "STATE_PATH", state)
    monkeypatch.setattr(tick, "read_live_issues", lambda _repo: [])
    monkeypatch.setattr(sys, "argv", [
        "tick.py", "--park", str(BLOCKED_ON_A_RUNNER), "--blocker", "b", "--owner", "o",
    ])

    def save_that_fails(_self, **_kwargs):
        raise PermissionError("state.json is held by another process")

    monkeypatch.setattr(Ledger, "save", save_that_fails)

    assert tick.main() == 1
    err = capsys.readouterr().err
    assert "THE COMMENT IS ON THE ISSUE" in err
    assert "PermissionError" in err, (
        "a lost CAS and a filesystem failure must stay distinguishable"
    )
    assert "LedgerChangedError" not in err, (
        "and the message must not assert a cause it did not establish (R7)"
    )


def test_a_lost_cas_is_reported_as_one(monkeypatch, tmp_path, capsys):
    """The positive control for the width of that `except`.

    WHAT MAKES THIS FAIL: the arm printing a fixed cause instead of the real
    exception type. Bound to `Exception`, the expected failure -- a lost CAS
    with four lanes live -- must still be NAMED as itself, or widening the catch
    would have bought legibility for the rare case by losing it for the common
    one.
    """
    state = str(tmp_path / "state.json")
    seed = Ledger(state, receipts=POLICY["receipts"])
    seed.upsert(BLOCKED_ON_A_RUNNER, "issue", "W6-ci", lane="lane:ci", size=1)
    seed.save()
    _stub_gh(monkeypatch)
    monkeypatch.setattr(tick, "STATE_PATH", state)
    monkeypatch.setattr(tick, "read_live_issues", lambda _repo: [])
    monkeypatch.setattr(sys, "argv", [
        "tick.py", "--park", str(BLOCKED_ON_A_RUNNER), "--blocker", "b", "--owner", "o",
    ])

    def save_that_lost_the_cas(_self, **_kwargs):
        raise LedgerChangedError("it changed since this transaction read it")

    monkeypatch.setattr(Ledger, "save", save_that_lost_the_cas)

    assert tick.main() == 1
    err = capsys.readouterr().err
    assert "LedgerChangedError" in err
    assert "THE COMMENT IS ON THE ISSUE" in err


@pytest.mark.parametrize(
    ("revoke", "dispose"),
    [
        ("comment", "park"),
        ("comment", "decline"),
        ("park-item", "park"),
        ("decline-item", "decline"),
    ],
    ids=["comment-blocks-park", "comment-blocks-decline", "park-item", "decline-item"],
)
def test_a_disposition_is_gated_on_the_autonomy_contract(
    monkeypatch, tmp_path, revoke, dispose
):
    """`gates.action_is_permitted` FAILS CLOSED, and BOTH bars are checked.

    THE REVIEW FINDING: the first shape had only `comment`, so two new
    TERMINAL-STATE capabilities arrived under the most general write permission
    in `policy.json` with no edit to that file at all. `action_is_permitted`'s
    own docstring is written against exactly that — "adding a new capability is
    a deliberate edit to policy.json rather than an emergent behaviour" — and
    `policy.json` records finding the mirror defect (an authority whose value
    changed nothing) in itself twice.

    WHAT MAKES EACH PARAMETER FAIL:
    - `park-item` / `decline-item` — delete the `action_is_permitted` call in
      `_dispose` and the verb runs with no authority bar at all. These are also
      the arms that prove the policy edit has BLAST RADIUS: removing the entry
      from `policy.json` alone must refuse the verb, or the file is prose.
    - `comment` — delete the gate in `post_disposition_comment` and a revoked
      comment permission stops refusing.

    `calls == []` pins that every refusal is SILENT UPSTREAM, which is the
    property the whole ordering of `_dispose` exists to give.

    The POSITIVE CONTROL below matters: if the action were already absent from
    the live policy, this test would pass over a file that never granted it.
    """
    led = _led(tmp_path)
    calls = _stub_gh(monkeypatch)
    assert revoke in POLICY["permitted_unattended"], (
        f"positive control: {revoke!r} must be GRANTED in the live policy, or "
        "this test passes over a permission that was never there"
    )
    revoked = dict(POLICY)
    revoked["permitted_unattended"] = [
        a for a in POLICY["permitted_unattended"] if a != revoke
    ]

    if dispose == "park":
        call = lambda: tick.park_item(led, revoked, REPO, BLOCKED_ON_A_RUNNER, "b", "o")  # noqa: E731
    else:
        call = lambda: tick.decline_item(led, revoked, REPO, BLOCKED_ON_A_RUNNER, "d")  # noqa: E731
    exc = _refusal(call)

    assert _bodies(calls) == [], (
        f"a revoked {revoke!r} must publish nothing; ran {calls}"
    )
    if revoke != "comment":
        # THE AUTHORITY BAR RUNS BEFORE THE STATE READ, so an unpermitted verb
        # costs zero GitHub calls. `comment` is checked inside
        # `post_disposition_comment`, which is downstream of the read, so that
        # parameter legitimately spends one READ-ONLY `gh issue view`. Asserting
        # `calls == []` for it would be asserting a property it does not have,
        # and a read is not a publication -- the claim that matters is the one
        # above.
        assert calls == [], f"an unpermitted {revoke!r} must not even read; ran {calls}"
    assert revoke in str(exc), "the message must name the action that was refused"
    assert led.items[BLOCKED_ON_A_RUNNER].state == READY


def test_a_disposition_reaches_an_in_flight_or_audited_item(monkeypatch, tmp_path):
    """The non-terminal states a real disposition actually arrives from.

    WHAT MAKES THIS FAIL: gate the verbs on `state == READY`. The two live cases
    #4677 names are not `ready` -- a lane that concludes "blocked" is holding an
    `in-flight` item, and the bot-filed alerts sit in `needs-audit`, which is
    where `drained()` is currently held false. A disposition that could not
    reach either state would leave the issue's own motivating cases unreachable.
    """
    led = _led(tmp_path, numbers=(BLOCKED_ON_A_RUNNER, BOT_FILED_SELF_RESOLVED))
    _stub_gh(monkeypatch)
    led.transition(BLOCKED_ON_A_RUNNER, IN_FLIGHT, "selected in cycle 1")
    led.items[BOT_FILED_SELF_RESOLVED].audit_reason = "departed"
    led.transition(BOT_FILED_SELF_RESOLVED, NEEDS_AUDIT, "left GitHub")

    tick.park_item(led, POLICY, REPO, BLOCKED_ON_A_RUNNER, "no runner", "operator")
    tick.decline_item(led, POLICY, REPO, BOT_FILED_SELF_RESOLVED, "operator: self-resolved")

    assert led.items[BLOCKED_ON_A_RUNNER].state == PARKED
    assert led.items[BOT_FILED_SELF_RESOLVED].state == DECLINED
    assert led.items[BOT_FILED_SELF_RESOLVED].audit_reason is None, (
        "a terminal item carries no audit reason - otherwise the ledger reads "
        "`state=declined reason=departed` and a cold reader cannot tell that "
        "label from a live one"
    )
