"""The drain's COMPLETION PATH -- the half of the harness that was never built.

THE DEADLOCK THIS ENDS. Measured 2026-09-14, before this module existed:

    ready: 285  in-flight: 16  awaiting-receipt: 0
    closed: 0   parked: 0      declined: 0   total: 303

Zero items had EVER reached a terminal state, and none could:

    set_state(n, CLOSED) -> _refuse_unless_receipted(item) -> raises
    receipts are set ONLY by Ledger.record_receipt()
    record_receipt() had ZERO production callers
    => no issue could EVER close

`tick.py` selects items into `in-flight` and has no return path. `Item.pr` is
read in five places and was never assigned. `AWAITING_RECEIPT` is in
`ALL_STATES`, is recognised by `merge_gate.SCHEDULED_STATES`, and nothing ever
set it. The states, guards, receipt classes and readers were all built and
tested; the WRITE side did not exist. That is why a full session of work on the
`ci-green` receipt (#4487) moved the queue by exactly zero: it improved the
QUALITY of a receipt nothing could RECORD.

WHAT THIS DOES NOT DO. It does not lower the bar. `_refuse_unless_receipted`
still decides, unchanged, and it re-checks the receipt KIND and the CLASS it was
taken under. This module's only job is to gather real evidence and hand it to
the recorder. Every adapter FAILS CLOSED: no evidence, unreadable evidence, an
adapter that raises, or a class with no adapter at all -> the item does not
close.

WHY IT CLOSES UNATTENDED. The operator authorised autonomous close-on-evidence.
That raises the bar on the adapters rather than lowering it on the gate, so:
every close writes its evidence ref into `history`, making a wrong close
traceable and reversible from the ledger alone; `--dry-run` gathers and prints
without writing; `--limit` bounds a first live run; and `--only` drains one
receipt class at a time.

Run:
    python tools/drain/complete.py --dry-run
    python tools/drain/complete.py --only guard-or-test-only --limit 1
    python tools/drain/complete.py --sweep
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

if hasattr(sys.stdout, "reconfigure"):
    # LINE BUFFERED, not block buffered. A sweep over 303 items takes many
    # minutes and makes hundreds of API calls; redirected to a file, block
    # buffering wrote NOTHING until ~8KB had accumulated, so a run that was
    # throttled or killed partway left an empty log and an unexplainable exit
    # code. The mutation runner had exactly this defect and an independent
    # reviewer found it there; it was reproduced here within the hour.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

import ledger  # noqa: E402
import merge_gate  # noqa: E402
from ledger import (  # noqa: E402
    AWAITING_RECEIPT,
    CLOSED,
    IN_FLIGHT,
    IN_REVIEW,
    READY,
    Ledger,
)

import gates  # noqa: E402

POLICY_PATH = os.path.join(HERE, "policy.json")
STATE_PATH = os.path.join(HERE, "state.json")

#: The states an item can be completed FROM -- which is EVERY non-terminal
#: state, including `READY`.
#:
#: The first version excluded `READY`, reasoning that an item nobody has worked
#: cannot have produced evidence. That is wrong for this backlog and the first
#: dry run showed why: the ledger was BOOTSTRAPPED from GitHub, so `READY` means
#: "the harness has never scheduled it", not "no work exists". Issues resolved
#: in earlier sessions sit in `READY` with merged PRs that declare `closes #N`,
#: and excluding them would leave the harness unable to notice work it did not
#: personally dispatch.
#:
#: The gate is the EVIDENCE, never the bookkeeping. A merged PR declaring a
#: close, plus an adapter that says the receipt kind is satisfied, is the whole
#: test -- and `NEEDS_AUDIT` is excluded because it means the item left GitHub
#: or disagreed with it, which is a question to answer before closing, not
#: after.
COMPLETABLE = (READY, IN_FLIGHT, IN_REVIEW, AWAITING_RECEIPT)


#: How many times one receipt kind's adapter may fault CONSECUTIVELY before the
#: sweep aborts instead of grinding on.
#:
#: This is a heuristic and is written down as one. A single raise can be a
#: transient -- `gh` rate-limiting, a dropped connection mid-`collect` -- and
#: aborting the whole sweep on one of those would be worse than useless. Three
#: in a row FOR THE SAME KIND is not a transient story any more: the adapter is
#: reaching for something that is not there. The counter resets on any reply
#: that was actually about an item, so a fault streak means consecutive, not
#: cumulative.
#:
#: What it does NOT do is prove the adapter is broken -- three consecutive
#: rate-limit errors would trip it too. That is deliberate: the abort's job is
#: to stop a silent no-op sweep, and stopping early on a transient costs a
#: re-run, while not stopping costs a queue that reports progress and drains
#: nothing.
CONSECUTIVE_FAULT_LIMIT = 3


@dataclass(frozen=True)
class Evidence:
    """What an adapter found, and why it is or is not a receipt.

    `ref` is the part that matters months later: it is what a reader follows to
    re-check a close. An adapter that returns `ok=True` with an empty `ref` is
    refused by `gather()` rather than trusted -- a receipt with no reference is
    an assertion, and this package exists because assertions were mistaken for
    measurements.

    `fault` separates "the TOOL is broken" from "the EVIDENCE says no". Both are
    `ok=False` and both must refuse the close, so the safety property is the
    same -- but the REMEDY is opposite, and so is what the sweep may conclude
    about the item. A refusal is a fact about the item (it does not yet have its
    receipt, so `AWAITING_RECEIPT` is true of it). A fault is a fact about the
    harness, and establishes NOTHING about the item -- moving it to
    `AWAITING_RECEIPT` on a fault would assert a state the code did not measure,
    which is the R7 violation this package keeps re-learning.

    Measured 2026-09-14, which is why this field exists: this branch was cut
    from `main`, where `merge_gate.collect_ci_green_evidence` does not exist yet
    (it is #4487's, unmerged). Every `ci-green` gather raised `AttributeError`
    and came back as one more indistinguishable "NO-EVIDENCE" line. A sweep over
    the live queue would have printed 93 of them, moved 93 items to
    `AWAITING_RECEIPT`, exited 0, and reported that the completion path was
    working -- with its only functioning adapter dead. A green dashboard over a
    dead pipeline.
    """

    ok: bool
    ref: str
    why: str
    #: True only when the adapter itself misbehaved -- raised, or returned
    #: something that is not `Evidence`. Never set by an adapter reporting that
    #: it looked and found nothing; that is an ordinary refusal.
    fault: bool = False


def _no_producer(kind: str, note: str) -> Evidence:
    """A declared receipt kind with no evidence producer yet.

    Stated as its own outcome rather than folded into "no evidence found",
    because the two have different remedies: one needs the item re-examined,
    the other needs a producer written. R7 -- the message must not assert a
    cause the code did not establish.
    """
    return Evidence(False, "", f"no producer for {kind!r} yet: {note}")


# -- adapters ---------------------------------------------------------------
# One per receipt KIND in policy.json's `receipts` map. Each returns Evidence
# and each fails closed.


def evidence_ci_green(repo: str, pr: int) -> Evidence:
    """A `guard-or-test-only` item closes on CI green AT THE MERGED SHA.

    This is #4487's receipt, reached programmatically rather than through its
    CLI: `collect_ci_green_evidence` gathers the merged commit, its check runs
    and its job records, and `gates.ci_green_receipt` decides. Fourteen rounds
    of independent review went into that decision; none of it was reachable
    from the ledger until now.
    """
    data = merge_gate.collect_ci_green_evidence(repo, pr)
    receipt = gates.ci_green_receipt(
        data["evidence"],
        merged_total_count=data["merged_total_count"],
        merged_changed_files=data["changed_files"],
        merged_branch=data["branch"],
        merged_sha=data["merged"],
        trees_identical=data["trees_identical"],
        policy=gates.load_policy(POLICY_PATH),
        infra_ere=merge_gate.resolve_infra_ere(data["merged"]),
    )
    sha = str(data["merged"] or "")[:12]
    if not receipt.ok:
        return Evidence(
            False, "",
            f"ci-green REFUSED at {sha}: {'; '.join(receipt.reasons[:2])[:300]}",
        )
    if not sha:
        # A green receipt over an unknown sha is not a reference to anything.
        return Evidence(False, "", "ci-green passed but the merged sha is unknown")
    return Evidence(True, f"PR #{pr} @ {sha}", f"ci-green at {sha}: {receipt.summary}")


def evidence_deploy_run(_repo: str, pr: int) -> Evidence:
    """A `deploy-path` item closes on a deploy job that actually EXECUTED.

    `cloud-parity.md` is explicit that a green run whose deploy job was skipped
    at 0 steps is NOT a receipt -- that is the GCC shape, 75 runs and zero
    executed deploy steps. So the test is `steps > 0` on a job that concluded,
    never the run's own conclusion.
    """
    return _no_producer(
        "deploy-run",
        "needs the deploy run bound to this merge; wire it after the roll fix "
        f"(PR #{pr}) so the first one is verified against a real deploy",
    )


def evidence_g1_browser(_repo: str, _pr: int) -> Evidence:
    """A `ui-surface` item closes on a LIVE BROWSER walk, never on tsc+vitest.

    `policy.json`'s `g1_assertion_rule` binds this: the assertion must key on
    something ONLY a success path can produce, and the receipt must NAME why it
    is unreachable from an error path. An assertion satisfied by
    `Error: HTTP 500` is not a receipt.
    """
    return _no_producer(
        "g1-browser",
        "needs a Playwright walk against the live console with an assertion "
        "that names why an error path cannot satisfy it (policy g1_assertion_rule)",
    )


def evidence_estate(_repo: str, _pr: int) -> Evidence:
    """An `estate-behaviour` item closes on the behaviour observed ON the estate."""
    return _no_producer(
        "estate", "needs a live-estate probe for the behaviour the item names")


def evidence_operator(_repo: str, _pr: int) -> Evidence:
    """`human-only` NEVER auto-closes, and this is not a missing producer.

    It is the one class whose receipt is a person's judgement. An automated
    close here would be the harness certifying something it cannot observe.
    """
    return Evidence(
        False, "",
        "human-only: an operator receipt is a person's judgement and is never "
        "produced automatically",
    )


#: kind -> adapter. A class whose kind is absent from this map CANNOT close:
#: `gather()` refuses rather than falling back, because a fallback here would
#: be a receipt produced by not having thought about the class.
ADAPTERS = {
    "ci-green": evidence_ci_green,
    "deploy-run": evidence_deploy_run,
    "g1-browser": evidence_g1_browser,
    "estate": evidence_estate,
    "operator": evidence_operator,
}


def gather(kind: str, repo: str, pr: int) -> Evidence:
    """Run the adapter for `kind`, failing closed on every abnormal outcome.

    An adapter that RAISES is a refusal, not a crash: the sweep must not stop
    on one unreadable item, and it must not treat an exception as evidence.

    `SystemExit` IS CAUGHT, AND IT IS THE ONE THAT MATTERS. An earlier revision
    caught `Exception`, which does not cover it -- `SystemExit` derives from
    `BaseException` -- and the only live adapter raises exactly that:
    `merge_gate.gh_json` exits on any failed `gh` call, and
    `collect_ci_green_evidence` exits when the bound PR is not merged. So the
    one exception this module was certain to meet was the one it did not catch.
    Measured by a reviewer: a sweep printed `CLOSED` for two items and then
    died, and because the ledger is saved after the loop, neither close reached
    disk. Two stdout lines asserting a state that does not exist -- the R7
    violation this package keeps re-learning, this time about its own output.

    `KeyboardInterrupt` is deliberately NOT caught: an operator interrupting a
    sweep is not an adapter fault, and swallowing it would make the run
    unstoppable.
    """
    adapter = ADAPTERS.get(kind)
    if adapter is None:
        return Evidence(
            False, "",
            f"receipt kind {kind!r} has no adapter - refusing rather than "
            "guessing what would evidence it",
        )
    try:
        found = adapter(repo, pr)
    except (Exception, SystemExit) as exc:  # a fault is a REFUSAL, never evidence
        detail = str(exc) or type(exc).__name__
        return Evidence(
            False, "", f"adapter for {kind!r} raised {type(exc).__name__}: {detail}"[:300],
            fault=True)
    if not isinstance(found, Evidence):
        return Evidence(
            False, "", f"adapter for {kind!r} returned {type(found).__name__}, not Evidence",
            fault=True)
    if found.ok and not found.ref.strip():
        # A FAULT, not a plain refusal, and that is a correction. An adapter
        # that reports evidence it cannot reference is MALFUNCTIONING by the
        # definition in `Evidence.fault` -- it is a fact about the tool, not
        # about the item -- so it must not quietly move the item to
        # `AWAITING_RECEIPT` as though the evidence had merely been absent.
        return Evidence(
            False, "",
            f"adapter for {kind!r} reported evidence with an EMPTY ref - a "
            "receipt with no reference cannot be re-checked, so it is not one",
            fault=True,
        )
    return found


# -- binding an item to the PR that resolved it -----------------------------


#: The PR number a squash commit was merged from: the LAST `(#N)` in a subject.
#:
#: The last one, not the first, and that is load-bearing. This repo's subjects
#: routinely carry the ISSUE they fix as well: `fix(ci): guard ... (#3338)
#: (#4371)` fixes issue 3338 and was merged as PR 4371. Taking the first `(#N)`
#: would bind every such item to its own issue number as though it were a PR.
_TRAILING_PR_RE = re.compile(r"\(#(\d+)\)\s*$")


@dataclass(frozen=True)
class ClosingIndex:
    """What the merged history says about which PR resolved which issue.

    TWO MAPS, DELIBERATELY SEPARATE, because they are not the same kind of
    claim and must never be merged into one "the PR for this issue" answer:

    - `prose` is THIS module's scanner over commit bodies and PR bodies. It is
      a publication guard reused for reading, and it over-matches on purpose:
      `CLOSING_RE` joins verb and reference with `\\s*`, `\\s` matches newlines,
      so a heading "## Deliberately NOT closed" followed by "#3883" reads as a
      close. Wide is right for "warn the author"; it is wrong for any decision.
    - `linked` is GITHUB's own `closingIssuesReferences`. Independently parsed,
      so it is a genuine second opinion rather than a second look by the same
      eye. Its failure mode is the safe one -- it read EMPTY while a squash
      commit closed #4361 -- so it is trustworthy as CORROBORATION and useless
      as a sole source. Measured on this queue it covers 2 of 301 items.

    Neither decides a close. `Item.pr` does. These decide only what the tool is
    willing to SUGGEST to a human, which is why the distinction is kept in the
    type rather than in a comment.
    """
    prose: dict[int, tuple[int, str, str]]
    linked: dict[int, set[int]]


def build_closing_map(repo: str) -> ClosingIndex:
    """issue -> (pr, merged_at, where), built ONCE for the whole sweep.

    THE QUERY IS INVERTED, and it had to be. The first version asked, per item,
    "is there a merged PR that closes #N?" via `gh pr list --search` -- which
    hits the SEARCH API, budgeted at **30 requests per minute**. Over 303 items
    that throttles hard, and `gh_json` aborts the run on a failed call. Aborting
    is the right behaviour (this repo has a scar from a rate-limited query being
    scored as a verdict) but it means the sweep could never finish.

    So it asks the opposite question once: "which issues do the merged PRs
    claim?" Two sources, because neither alone is complete:

    - **`git log origin/main`** -- FREE, offline, and complete for the commit
      trail. Every squash commit's body is here, which matters because
      `closingIssuesReferences` read EMPTY while a squash body closed #4361.
      Measured on this repo: 99 closing keywords in the last 400 commit bodies,
      and `closingIssuesReferences` empty on the three most recent merges.
    - **merged PR bodies** -- one paginated list on the CORE API (5000/hr), for
      closes declared in the body and nowhere else.
    """
    found: dict[int, tuple[int, str, str]] = {}
    linked: dict[int, set[int]] = {}

    # -- the commit trail, from local git --------------------------------
    rc, out, err = merge_gate.sh(
        ["git", "log", "origin/main", "--format=%x1e%cI%x1f%s%x1f%b"])
    if rc != 0:
        raise SystemExit(f"cannot read origin/main's history (rc={rc}): {err[:300]}")
    for record in out.split("\x1e"):
        if not record.strip():
            continue
        parts = record.split("\x1f")
        if len(parts) < 3:
            continue
        when, subject, body = parts[0].strip(), parts[1], parts[2]
        pr_match = _TRAILING_PR_RE.search(subject.strip())
        if pr_match is None:
            continue
        pr = int(pr_match.group(1))
        for issue in gates.scan_closing_keywords(f"{subject}\n{body}").hard:
            if issue == pr:
                continue  # a PR closing "itself" is the trailing tag, not a claim
            found.setdefault(issue, (pr, when, f"commit of PR #{pr}"))

    # -- merged PR bodies, one paginated list ----------------------------
    # THE LIMIT IS ABOVE THE POPULATION, AND THE TRUNCATION IS DETECTED.
    # It was `--limit 1000` against 3312 merged PRs, and `gh` returns exactly
    # 1000 with no indication that it stopped -- so the map silently described
    # the newest third of history while reading as though it described all of
    # it. A reviewer caught it by comparing the returned length to the real
    # count. Ask for more than exist, then refuse if the answer comes back
    # exactly at the ceiling, because that is the one length that means
    # "there may be more" rather than "this is all of them".
    ceiling = 6000
    raw = merge_gate.gh_json(
        ["gh", "pr", "list", "--repo", repo, "--state", "merged",
         "--limit", str(ceiling),
         "--json", "number,body,mergedAt,closingIssuesReferences"],
        "merged PR bodies",
    )
    if not isinstance(raw, list):
        raise SystemExit(f"unexpected shape for merged PRs: {type(raw).__name__}")
    if len(raw) >= ceiling:
        raise SystemExit(
            f"merged-PR list came back at the {ceiling} ceiling, so it may be "
            "truncated. A closing map that silently covers only the newest "
            "PRs would refuse binds it should corroborate; raise the ceiling "
            "rather than sweeping on a partial history."
        )
    for pr_row in raw:
        if not isinstance(pr_row, dict) or not isinstance(pr_row.get("number"), int):
            continue
        pr = pr_row["number"]
        when = str(pr_row.get("mergedAt") or "")
        for ref in (pr_row.get("closingIssuesReferences") or []):
            if isinstance(ref, dict) and isinstance(ref.get("number"), int):
                linked.setdefault(ref["number"], set()).add(pr)
        for issue in gates.scan_closing_keywords(str(pr_row.get("body") or "")).hard:
            if issue == pr:
                continue
            found.setdefault(issue, (pr, when, f"body of PR #{pr}"))
    return ClosingIndex(prose=found, linked=linked)


def merged_pr_for_issue(repo: str, index: ClosingIndex, item,
                        ) -> tuple[int | None, str, str]:
    """The PR this item is BOUND to, or None. A prose claim is not a binding.

    THE CORRECTION THAT MATTERS MOST IN THIS MODULE. The first version resolved
    the PR by scanning merged PR bodies and commit messages with
    `gates.scan_closing_keywords`, and on its first full run it proposed closing
    #3883 -- whose claiming PR body says, in as many words:

        ## Deliberately NOT closed
        #3883 and #3844 are deploy-path issues whose acceptance is a green
        **run**, not a merge (deploy-integrity R2). They are referenced, never
        closed.

    The scanner matched `closed` + a blank line + `#3883` across a markdown
    heading, because `CLOSING_RE` joins verb and reference with `\\s*` and `\\s`
    matches newlines. GitHub does not act on that, which is why the issue is
    still open.

    That is not a bug in the scanner -- it is a PUBLICATION GUARD, and its
    docstring says so: it exists because "the comment explaining this hazard
    would itself have closed two issues". It deliberately OVER-matches, which is
    the safe direction when warning an author before they publish, and the
    UNSAFE direction when deciding whether something is done. Reusing it here
    inverted its safety direction.

    So the binding is `Item.pr`, set deliberately by a lane that did the work
    (`--bind`), exactly as #4489's checklist prescribes. GitHub already closes
    every issue a merged PR genuinely declares closed; an issue that is still
    OPEN is open because the work is not done or because a person reopened it.
    Prose archaeology cannot distinguish those from a heading that happens to
    end in the word "closed", so it is not consulted for the decision.

    `closing` is still built and still shown, as a SUGGESTION for a human: "these
    look related, go and bind them if they are". It never decides.
    """
    if isinstance(item.pr, int) and item.pr > 0:
        # The BOUND PR's own merge time. Not the prose map's -- see
        # `bound_pr_merged_at` for the two failures that came from reading
        # prose here, one inert and one that closed an item a person reopened.
        when, refused = bound_pr_merged_at(repo, item.pr)
        if not when:
            return None, "", f"#{item.number} is bound to PR #{item.pr} but {refused}"
        return item.pr, when, f"bound to PR #{item.pr}"
    hint = ""
    if item.number in index.prose:
        pr, _when, where = index.prose[item.number]
        corroborated = pr in index.linked.get(item.number, set())
        if corroborated:
            # GitHub's OWN parser links this PR to this issue. That is a second,
            # independently-derived signal, so a paste-ready command is honest.
            hint = (f" (merged PR #{pr} mentions it in its {where.split(' of ')[0]} "
                    "AND GitHub's own closing-reference parser links them; if a "
                    f"lane really did this work, bind it: `--bind {item.number}={pr}`)")
        else:
            # NO PASTE-READY COMMAND. The only signal is this module's own
            # scanner, which is a PUBLICATION GUARD and deliberately
            # over-matches: `CLOSING_RE` joins verb and reference with `\s*`,
            # `\s` matches newlines, and that is how it read a heading reading
            # "## Deliberately NOT closed" followed by "#3883" as a close.
            # A reviewer measured that the five suggestions this tool emits over
            # the live queue are the four issues the operator personally
            # reopened plus #3883 -- i.e. handing over a command to paste
            # selected precisely for the items that must not close. Say what
            # was seen, and make the human go and read it.
            hint = (f" (merged PR #{pr} mentions it in its {where.split(' of ')[0]}, "
                    "but GitHub's own parser does NOT link them - this scanner "
                    "over-matches across line breaks, so READ THE PR before "
                    "deciding; no bind command is offered for an uncorroborated "
                    "prose match)")
    return None, "", f"#{item.number} is not bound to a PR{hint}"


def bound_pr_merged_at(repo: str, pr: int) -> tuple[str, str]:
    """When did the BOUND PR merge? Read from that PR, never from prose.

    Returns `(merged_at, why_refused)`; an empty `merged_at` means refuse, and
    `why_refused` is then non-empty.

    THIS EXISTS BECAUSE THE BINDING WAS INERT WITHOUT IT. `merged_pr_for_issue`
    used to take `merged_at` from the PROSE map even for an item bound by
    `Item.pr`, and prose covers 5 of the 301 completable items. For the other
    296 the time came back `""`, `operator_reopened_after` correctly read that
    as "a later reopen cannot be ruled out", and the item was skipped as
    REOPENED -- permanently. So `--bind`, the only producer of a binding,
    could not make 98.3% of the queue closable no matter what a lane did.

    The second failure was worse than inert. When prose DID have an entry it
    was built `setdefault` over a newest-first git log, so the newest claim
    won -- and a later unrelated PR's merge time, compared against a real
    operator reopen, made the reopen look like it happened BEFORE the merge.
    A reviewer demonstrated it with #2678's real numbers: bound to #3012,
    prose from #4300, operator reopen at 2026-08-06T16:47:29Z, and the item
    closed. The freshness guard was reading the wrong clock.

    Fails CLOSED on everything: an unreadable answer, a PR that is not MERGED,
    or a merged PR with no `mergedAt`. An open PR reaching the adapter is also
    how `collect_ci_green_evidence` raises `SystemExit`, so refusing here turns
    a sweep-killer into one printed line about one item.
    """
    try:
        data = merge_gate.gh_json(
            ["gh", "pr", "view", str(pr), "--repo", repo,
             "--json", "number,state,mergedAt"],
            f"PR #{pr}",
        )
    except (Exception, SystemExit) as exc:
        return "", (f"could not read PR #{pr} ({type(exc).__name__}: "
                    f"{str(exc) or 'no detail'}), so its merge time is unknown")
    if not isinstance(data, dict):
        return "", f"PR #{pr} returned {type(data).__name__}, not an object"
    state = str(data.get("state") or "")
    if state != "MERGED":
        return "", (f"PR #{pr} is {state or 'in an unknown state'}, not MERGED - "
                    "a close needs the work actually landed (deploy-integrity R2)")
    when = str(data.get("mergedAt") or "")
    if not when:
        return "", f"PR #{pr} reports MERGED with no mergedAt, which cannot both be true"
    return when, ""


def operator_reopened_after(repo: str, number: int, merged_at: str) -> tuple[bool, str]:
    """Did a HUMAN reopen this issue after the PR that claims to close it merged?

    THE GUARD THAT STOPS THIS OVERRIDING A PERSON, and it is not hypothetical --
    it was found by running the sweep. #2678 carries `Closes #2678.` in merged
    PR #3012's body AND in a commit body; GitHub duly closed it at
    2026-08-06T03:42:31Z; and the operator REOPENED it thirteen hours later at
    16:47:29Z. The claim was merged and the claim was wrong.

    A merged PR's `Closes #N` is a HYPOTHESIS, not a receipt. That is this
    repo's own recorded lesson -- measured twice at 7/31 and then 2/29 against
    the live sha -- and an autonomous closer that re-closes what a human
    deliberately reopened is worse than one that closes nothing.

    Fails CLOSED: an unreadable timeline is "cannot show the operator did not
    reject this", which is not "the operator did not reject this".
    """
    if not merged_at:
        return True, "the PR's merge time is unknown, so a later reopen cannot be ruled out"
    events = merge_gate.gh_json(
        ["gh", "api", f"repos/{repo}/issues/{number}/timeline?per_page=100"],
        f"timeline of #{number}",
    )
    if not isinstance(events, list):
        return True, f"unreadable timeline for #{number}, so a reopen cannot be ruled out"
    for event in events:
        if not isinstance(event, dict) or event.get("event") != "reopened":
            continue
        when = str(event.get("created_at") or "")
        if when > merged_at:
            who = ((event.get("actor") or {}) or {}).get("login") or "someone"
            return True, (
                f"{who} REOPENED #{number} at {when}, after the claiming PR merged "
                f"at {merged_at} - a merged `closes` is a hypothesis and this one "
                "was rejected by a person"
            )
    return False, ""


# -- the sweep --------------------------------------------------------------


#: ASCII digits ONLY. `str.isdigit()` is True for Arabic-Indic and other
#: Unicode digit forms, and `int()` accepts them, so a pair written in
#: Arabic-Indic numerals validated and bound. Nothing downstream can render
#: that back to a number an operator can check against GitHub.
_NUMERIC_RE = re.compile(r"\A[0-9]+\Z")


def bind(led: Ledger, pairs: list[str], repo: str,
         index: ClosingIndex | None = None) -> int:
    """Record `Item.pr` for `ISSUE=PR` pairs. The writer #4489 asks for.

    `Item.pr` has existed since the ledger was written and NOTHING wrote it,
    which left two controls in `merge_gate` inert: `poached_closes()` (it
    refuses a declared close of an item bound to a DIFFERENT PR, and returned
    `[]` for every real input) and gate 3b's strongest corroboration
    (`item.pr == pr`, the one piece of evidence the harness produced rather than
    the author typed).

    #4489 is explicit that this belongs HERE and not in the merge gate: the
    gate's worktree fallback resolves `state.json` from the PRIMARY checkout, so
    a lane running the gate from its own worktree rewrote a ledger in a
    different checkout. One writer, in the drain's own tools, with the ledger's
    own save.

    IT VALIDATES, WHICH IT DID NOT USED TO. A reviewer measured that `1=0` was
    accepted and then permanently bricked the item (every later bind refused
    with "already bound to PR #0"), that `1=99999999` was accepted, and that a
    single transposed digit -- `4396` for `4369` -- bound an item to an
    unrelated PR and CLOSED it on that PR's green CI, while the closing map
    said otherwise and nothing consulted it. The binding is the ONLY thing
    standing between prose and an unattended close, so an unchecked binding is
    an unchecked close.
    """
    bound = 0
    for pair in pairs:
        issue_s, sep, pr_s = pair.partition("=")
        if not sep or not _NUMERIC_RE.match(issue_s.strip()) or \
                not _NUMERIC_RE.match(pr_s.strip()):
            raise SystemExit(
                f"--bind expects ISSUE=PR with ASCII digits on both sides, got {pair!r}")
        issue, pr = int(issue_s), int(pr_s)
        if issue <= 0 or pr <= 0:
            raise SystemExit(
                f"--bind {pair}: issue and PR must both be positive. `0` is not a "
                "sentinel here - it would be stored as a real binding and then "
                "refuse every later attempt to correct it.")
        if issue not in led.items:
            raise SystemExit(f"--bind {pair}: #{issue} is not in the ledger")
        item = led.items[issue]
        if isinstance(item.pr, int) and item.pr != pr:
            # Rebinding is how one PR's work gets attributed to another's.
            raise SystemExit(
                f"--bind {pair}: #{issue} is already bound to PR #{item.pr}. "
                "Rebinding would move the evidence for a close; do it by hand "
                "and say why in the item's history."
            )
        # THE PR MUST EXIST AND HAVE MERGED. Checked here rather than left to
        # the adapter, because an unmerged PR reaching
        # `collect_ci_green_evidence` raises `SystemExit` and takes the whole
        # sweep down with it.
        when, refused = bound_pr_merged_at(repo, pr)
        if not when:
            raise SystemExit(f"--bind {pair}: {refused}")
        # AND THE PROSE MAP GETS A VETO -- only a veto, never a vote. It cannot
        # authorise a binding (it over-matches; that is the #3883 defect), but
        # when it names a DIFFERENT PR for this issue that disagreement is
        # exactly the signature of a typo, and refusing costs nothing but a
        # re-read. This is the check that would have caught `4396` for `4369`.
        if index is not None:
            claim = index.prose.get(issue)
            if claim and claim[0] != pr:
                raise SystemExit(
                    f"--bind {pair}: the merged history attributes #{issue} to "
                    f"PR #{claim[0]} ({claim[2]}), not PR #{pr}. That disagreement "
                    "is what a transposed digit looks like. If PR "
                    f"#{pr} really is the one, unbind-and-say-why by hand; this "
                    "refuses rather than closing an item on an unrelated PR's CI."
                )
        item.pr = pr
        item.history.append(f"{ledger._now()} bound to PR #{pr} (merged {when})")
        print(f"  #{issue} -> PR #{pr}  (merged {when})")
        bound += 1
    return bound


def sweep(led: Ledger, policy: dict, repo: str, *, dry_run: bool,
          limit: int | None, only: str | None,
          index: ClosingIndex | None = None) -> tuple[int, int]:
    """Drive every completable item to a terminal state, or say why not.

    Returns `(closed, examined)`. Writes nothing when `dry_run`.
    """
    receipts = policy.get("receipts") or {}
    if not receipts:
        raise SystemExit(
            "REFUSING: policy.json carries no `receipts` map, so no receipt "
            "KIND can be validated and every close would be unchecked"
        )
    closed = examined = 0
    faults: dict[str, int] = {}
    # AGGREGATE fault bookkeeping, separate from the consecutive streak above.
    # The streak catches a dead adapter part-way through a LONG sweep; it
    # cannot catch one at all in a SHORT sweep, and the short sweep is the one
    # this module's own docs tell an operator to run first
    # (`--only guard-or-test-only --limit 1`). A reviewer demonstrated that
    # `--limit 1` and `--limit 2` against a structurally dead adapter return
    # `closed=0`, print no abort, and exit 0 -- the exact "green over a dead
    # pipeline" outcome the fault field was introduced to prevent, surviving
    # inside the fix for it. These two counters are what the post-loop check
    # reads, so a fault is fatal at any sweep length.
    attempts: dict[str, int] = {}
    fault_total: dict[str, int] = {}
    index = index if index is not None else build_closing_map(repo)
    print(f"  {len(index.prose)} issue(s) are claimed by a merged PR's body or "
          f"commit trail; GitHub's own parser links {len(index.linked)}")
    for item in sorted(led.remaining(), key=lambda i: i.number):
        if item.state not in COMPLETABLE:
            continue
        klass = item.effective_receipt_class
        if only and klass != only:
            continue
        if limit is not None and examined >= limit:
            break
        examined += 1

        pr, merged_at, why_pr = merged_pr_for_issue(repo, index, item)
        if pr is None:
            print(f"  #{item.number:<5} {klass:<20} SKIP   {why_pr}")
            continue

        # BEFORE ANY EVIDENCE: did a person already reject this claim? Asking
        # afterwards would mean spending the evidence call to reach a refusal
        # that was decided by a human weeks ago -- and, worse, it would put the
        # close one bug away from overriding them.
        rejected, why_reopen = operator_reopened_after(repo, item.number, merged_at)
        if rejected:
            print(f"  #{item.number:<5} {klass:<20} REOPENED  {why_reopen[:120]}")
            continue

        kind = receipts.get(klass)
        if not isinstance(kind, str) or not kind:
            print(f"  #{item.number:<5} {klass:<20} REFUSE receipt class is not "
                  "in policy.json receipts - unclassifiable, so unclosable")
            continue

        found = gather(kind, repo, pr)
        attempts[kind] = attempts.get(kind, 0) + 1
        if found.fault:
            # The ADAPTER misbehaved. This says nothing about the item, so the
            # item is not moved: `AWAITING_RECEIPT` would be a state claim the
            # code did not establish (R7).
            faults[kind] = faults.get(kind, 0) + 1
            fault_total[kind] = fault_total.get(kind, 0) + 1
            print(f"  #{item.number:<5} {klass:<20} FAULT  {found.why[:120]}")
            if faults[kind] >= CONSECUTIVE_FAULT_LIMIT:
                raise SystemExit(
                    f"ABORTING: the {kind!r} adapter has faulted "
                    f"{faults[kind]} times in a row. A fault is the adapter "
                    f"failing to answer, not the item failing to qualify, so "
                    f"continuing would print a non-answer for every remaining "
                    f"{kind!r} item and exit 0 with nothing drained. This "
                    f"cannot tell a broken adapter from {faults[kind]} "
                    f"consecutive rate-limit errors, and does not claim to - "
                    f"either way the run is not measuring anything. "
                    f"Last fault: {found.why[:200]}"
                )
            continue
        faults[kind] = 0  # a reply that was ABOUT the item clears the streak
        if not found.ok:
            print(f"  #{item.number:<5} {klass:<20} NO-EVIDENCE  {found.why[:120]}")
            if not dry_run and item.state != AWAITING_RECEIPT:
                # It has a merged PR and no receipt yet. That is precisely what
                # AWAITING_RECEIPT means, and nothing has ever set it.
                led.transition(item.number, AWAITING_RECEIPT,
                               f"{why_pr}; awaiting {kind}: {found.why[:160]}")
                led.save()
            continue

        if dry_run:
            print(f"  #{item.number:<5} {klass:<20} WOULD-CLOSE  {kind} {found.ref}")
            closed += 1
            continue

        led.record_receipt(item.number, kind, found.ref)
        led.transition(item.number, CLOSED, f"{why_pr}; {found.why[:200]}")
        # SAVED BEFORE IT IS ANNOUNCED. The ledger used to be written once,
        # after the loop returned, so anything that ended the sweep early threw
        # away every close it had already printed. A reviewer measured a sweep
        # printing `CLOSED` for two items and then dying with the ledger
        # untouched: two lines of stdout asserting a state that existed
        # nowhere. Printing a claim the disk does not back is the same defect
        # as an error message naming a cause the code did not establish.
        led.save()
        print(f"  #{item.number:<5} {klass:<20} CLOSED {kind} {found.ref}")
        closed += 1

    # -- the aggregate fault verdict, read AFTER the loop --------------------
    # A sweep that never got an answer about anything must not exit 0. This is
    # length-independent on purpose: one attempt that faulted is 1 of 1, and
    # `--limit 1` is what the docs tell an operator to run first.
    dead = [k for k, n in attempts.items()
            if n > 0 and fault_total.get(k, 0) >= n]
    if dead:
        raise SystemExit(
            "ABORTING: the adapter(s) " + ", ".join(repr(k) for k in sorted(dead))
            + " faulted on EVERY call this sweep made to them "
            + ", ".join(f"{k}: {fault_total[k]}/{attempts[k]}" for k in sorted(dead))
            + ". Not one reply was about an item, so this run measured nothing "
              "about the queue and its exit status must not suggest otherwise."
        )
    stragglers = {k: n for k, n in fault_total.items() if n}
    if stragglers:
        print("\nFAULTS (adapter did not answer; the item was NOT moved): "
              + ", ".join(f"{k} {n}/{attempts[k]}" for k, n in sorted(stragglers.items())))
    return closed, examined


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true",
                        help="gather and print, write nothing")
    parser.add_argument("--limit", type=int, default=None,
                        help="examine at most N items (bounds a first live run)")
    parser.add_argument("--only", default=None,
                        help="one receipt class, e.g. guard-or-test-only")
    parser.add_argument("--sweep", action="store_true",
                        help="examine every completable item (the default)")
    parser.add_argument("--bind", action="append", metavar="ISSUE=PR", default=[],
                        help="record that a lane resolved ISSUE with PR, which "
                             "is what makes the item eligible to close. Repeatable.")
    args = parser.parse_args()

    policy = gates.load_policy(POLICY_PATH)
    repo = policy["repo"]
    led = Ledger(STATE_PATH, receipts=policy["receipts"])
    led.load()
    if not led.loaded_from_disk:
        print(f"NO LEDGER at {STATE_PATH}. This is not an empty queue, it is no "
              "queue: seed it with `python tools/drain/tick.py --bootstrap`",
              file=sys.stderr)
        return 2

    mode = "DRY RUN (nothing will be written)" if args.dry_run else "LIVE"
    print(f"COMPLETE {mode}  repo={repo}  "
          f"only={args.only or 'every class'}  limit={args.limit or 'none'}")

    # A TYPO IN `--only` USED TO BE A CLEAN PASS. `--only guard-or-test_only`
    # matched no item's class, so the sweep examined nothing, printed
    # "would close 0 of 0 examined" and exited 0 -- a run that measured nothing
    # and reported like a run that found nothing to do. Validate against the
    # classes policy.json actually declares.
    known = set((policy.get("receipts") or {}).keys())
    if args.only and args.only not in known:
        print(f"--only {args.only!r} is not a receipt class in policy.json. "
              f"Known: {', '.join(sorted(known)) or '(none)'}", file=sys.stderr)
        return 2

    # ONE index for the whole invocation: `bind` needs it for its veto and the
    # sweep needs it for its suggestions, and it costs a full merged-PR read.
    index = build_closing_map(repo)

    if args.bind:
        if args.dry_run:
            raise SystemExit("--bind writes; it cannot be combined with --dry-run")
        print(f"BINDING {len(args.bind)} item(s) to their PRs:")
        bind(led, args.bind, repo, index)
        led.save()
        if not args.sweep:
            return 0

    closed, examined = sweep(led, policy, repo, dry_run=args.dry_run,
                             limit=args.limit, only=args.only, index=index)
    if not args.dry_run:
        led.save()
    verb = "would close" if args.dry_run else "closed"
    print(f"\n{verb} {closed} of {examined} examined")
    print(json.dumps(led.counts(), indent=1))
    print("drained:", led.drained())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
