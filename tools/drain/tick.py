"""One cycle of the drain. Run it, launch what it prints, run it again.

    python tools/drain/tick.py --status     # what is the queue holding?
    python tools/drain/tick.py              # advance one cycle, emit briefs
    python tools/drain/tick.py --bootstrap  # discard the ledger, reseed from GitHub
    python tools/drain/tick.py --reap       # return stranded in-flight lanes to ready

Each pass is an independent transaction against the ledger. There is no state
between passes and nothing important in any agent's context, so a dead session
costs at most the cycle that was in flight.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import subprocess
import sys
import time
import urllib.parse
from typing import NamedTuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from build_inventory import stream_for
from ledger import (
    AUDIT_DEPARTED,
    CLOSED,
    CLOSES_ON_GITHUB,
    DECLINED,
    IN_FLIGHT,
    IN_REVIEW,
    NEEDS_AUDIT,
    PARKED,
    READY,
    TERMINAL,
    Ledger,
    LedgerChangedError,
)

import gates

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
POLICY_PATH = os.path.join(HERE, "policy.json")
STATE_PATH = os.path.join(HERE, "state.json")

# Below this overlap between the live issue set and the set the ledger believes
# is open, the refresh is not a refresh -- it is a different population. The
# cross-repo case produces a large, plausible, entirely disjoint answer.
MIN_OVERLAP = 0.5
MIN_RETAINED = 0.8
MIN_RETAINED_HARD = 0.25  # --allow-shrink cannot suppress this one
GUARD_FLOOR = 10  # below this many KNOWN items the ratios are noise


def sh(args: list[str]) -> tuple[int, str, str]:
    """Run a command in the REPO ROOT and return (rc, stdout, stderr).

    `cwd` is pinned. Without it `gh` resolves the repository from whatever
    directory the caller happened to be in, so running the harness from another
    checkout returns rc=0 and a valid-looking issue list for the WRONG REPO.

    Never discards stderr. A discarded stderr once turned "I could not reach the
    registry" into "the tag does not exist" and sent two investigations down the
    wrong path (deploy-integrity R7).

    Git argv is routed through `gates.git_argv`. No git call exists here today;
    the routing is so that adding one does not reintroduce the quoting defect.
    """
    run = subprocess.run(
        gates.git_argv(args), capture_output=True, text=True,
        encoding="utf-8", errors="replace", cwd=REPO_ROOT,
    )
    return run.returncode, run.stdout, run.stderr


def read_live_issues(repo: str) -> list[dict]:
    """Read the open issues of ONE named repository.

    `--repo` is explicit on purpose: the repository is a policy input, not an
    accident of the working directory or of `GH_REPO` in the environment.
    """
    rc, out, err = sh(
        ["gh", "issue", "list", "--repo", repo, "--state", "open", "--limit", "1000",
         "--json", "number,title,labels"]
    )
    if rc != 0:
        raise SystemExit(f"cannot read GitHub for {repo} (rc={rc}): {err[:300]}")
    try:
        return json.loads(out)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"unparseable issue list for {repo}: {exc}") from exc


def guard_refresh(led: Ledger, live: list[dict], allow_shrink: bool = False) -> None:
    """Refuse a refresh whose live set is not plausibly this ledger's population.

    Departure from the live set is how an item leaves the queue, so a refresh
    that reads the WRONG or a TRUNCATED population moves items in bulk. Both
    failures return rc=0 and valid JSON; neither announces itself.

    Two independent shapes, because they fail differently -- and OVERLAP is
    tested FIRST because it is the more specific diagnosis:

    - OVERLAP: the live set names different issues. That is the wrong
      repository. A size check alone reads it as healthy, and a retention check
      alone reports it as a truncated read -- true, but it sends the reader
      looking for a pagination bug instead of at `repo` in policy.json.
    - RETAINED: the live set is a SUBSET of what the ledger believes is open.
      That is truncation, a narrower token, or the `--limit` ceiling.

    THE TWO DENOMINATORS ARE DIFFERENT, and getting that wrong bricks the run.
    OVERLAP is measured against EVERY number the ledger knows; RETENTION only
    against the ones it believes are still open. **Parking does not close an
    issue on GitHub** -- a `parked` item is terminal here and open there -- so
    measuring overlap against the non-terminal set alone made every legal park
    lower the ratio. With 40 items and 25 parked, a perfectly healthy live set
    of the same 40 numbers scored 38% and the harness exited with "that is a
    different population - check `repo`". Nothing was wrong with the repo: the
    guard fired on the drain's own definition of progress, in the back half of
    every run, and asserted a cause it had not established (R7).

    `allow_shrink` suppresses the RETENTION clause ONLY. It used to skip the
    whole function, so the documented escape from a shrink warning also turned
    off the wrong-repo and zero-issue refusals.
    """
    believed_open = {n for n, i in led.items.items() if i.state not in TERMINAL}
    known = set(led.items)
    # The floor is keyed to EVERYTHING the ledger knows, not to what is still
    # open. Keyed to `believed_open` the guard switched itself off in the
    # END-GAME: with 40 items, 31 legally parked and 9 left, a 900-issue
    # wrong-repo read sailed through -- 900 foreign issues upserted as `ready`
    # and the 9 real ones departed -- at exactly the moment the run was about to
    # report drained. Same boundary as the OVERLAP denominator, other side.
    if len(known) < GUARD_FLOOR:
        return

    live_numbers = {i["number"] for i in live}
    if not live_numbers and believed_open:
        raise SystemExit(
            f"refusing to refresh: GitHub returned ZERO open issues while the ledger "
            f"believes {len(believed_open)} are open. That would move all of them out of "
            "the queue. Confirm the repo and the token, then re-run."
        )

    # ARRIVALS ARE NOT FOREIGN. GitHub issue numbers are monotonic per repo, so
    # a genuinely new issue in THIS repo always carries a number above the
    # ledger's maximum. Counting arrivals as non-overlapping halted the run in
    # the END-GAME: once most items are terminal the live set shrinks toward new
    # arrivals, and this repo produces those continuously (release-please, CI
    # auto-issues, and the drain itself may open them). Fully drained with six
    # new issues scored 0% and exited with "check `repo` in policy.json" -- a
    # cause the code had not established, on a state that is the whole point of
    # the run. This is the same legal-state-trips-the-guard shape as the earlier
    # denominator bug, moved to the floor.
    ceiling = max(known)
    arrivals = {n for n in live_numbers if n > ceiling}
    candidates = live_numbers - arrivals

    # MAGNITUDE, because no ratio can separate these two. A fully terminal
    # ledger meeting six genuine new issues and the same ledger meeting nine
    # hundred foreign ones numbered above the ceiling are identical to every
    # fraction here: in both, every live number is an arrival and nothing is
    # believed open. Measured: 900 foreign issues were ingested (`added=900`,
    # ledger 940, `drained` flipped back to false). A bound on the SIZE of the
    # arrival set is a different instrument rather than a tuned threshold --
    # six arrivals against a 297-item ledger never trips it, nine hundred
    # always does.
    # OVERLAP first: when there ARE comparable numbers it is the more specific
    # diagnosis, and the more useful message.
    if candidates:
        overlap = len(known & candidates) / len(candidates)
        if overlap < MIN_OVERLAP:
            raise SystemExit(
                f"refusing to refresh: of the {len(candidates)} live issues numbered at or "
                f"below this ledger's highest known issue (#{ceiling}), only {overlap:.0%} "
                f"appear in it at all ({len(known)} known, {len(arrivals)} new arrivals "
                "excluded). That is a different population - check `repo` in policy.json "
                "and GH_REPO in the environment."
            )

    # MAGNITUDE, because no RATIO can separate the remaining two cases. A fully
    # terminal ledger meeting six genuine new issues and the same ledger meeting
    # nine hundred foreign ones numbered above the ceiling are identical to
    # every fraction here: in both, every live number is an arrival and nothing
    # is believed open. Measured: 900 foreign issues were ingested (`added=900`,
    # the ledger grew to 940, `drained` flipped back to false). A bound on the
    # SIZE of the arrival set is a different instrument rather than a tuned
    # threshold -- six arrivals against a 297-item ledger never trips it, nine
    # hundred always does.
    if len(arrivals) > max(GUARD_FLOOR, len(known)):
        raise SystemExit(
            f"refusing to refresh: {len(arrivals)} of the {len(live_numbers)} live issues are "
            f"numbered above this ledger's ceiling (#{ceiling}), which is more than the "
            f"{len(known)} issues it knows about. New arrivals do not come in floods that "
            "size - check `repo` in policy.json. If this repo really did gain that many, "
            "re-seed with --bootstrap rather than refreshing."
        )

    if not believed_open:
        return
    retained = len(believed_open & live_numbers) / len(believed_open)
    # A HARD floor --allow-shrink cannot suppress. A wrong-repo read whose
    # numbers all sit above the ledger's ceiling is invisible to the overlap
    # clause (every issue looks like an arrival) and is caught here instead --
    # so the escape hatch must not open that door.
    if retained < MIN_RETAINED_HARD:
        raise SystemExit(
            f"refusing to refresh: only {retained:.0%} of the {len(believed_open)} issues the "
            f"ledger believes are open are still in the live set, below the HARD floor "
            f"{MIN_RETAINED_HARD:.0%} that --allow-shrink cannot suppress. A whole population "
            "does not depart in one cycle; a truncated or foreign read does."
        )
    if retained < MIN_RETAINED and not allow_shrink:
        raise SystemExit(
            f"refusing to refresh: only {retained:.0%} of the {len(believed_open)} issues the "
            f"ledger believes are open are still in the live set (floor {MIN_RETAINED:.0%}). "
            "A partial or truncated read looks exactly like this. Re-run; if the drop is real, "
            "pass --allow-shrink (which suppresses THIS clause only)."
        )


def refresh_from_github(led: Ledger, streams: dict, live: list[dict]) -> tuple[int, int]:
    """Re-read live GitHub. New issues appear; issues closed elsewhere are AUDITED."""
    live_numbers = {i["number"] for i in live}

    added = 0
    for issue in live:
        number = issue["number"]
        labels = {label["name"] for label in issue["labels"]}
        lane = next((x for x in labels if x.startswith("lane:")), None)
        size = next(
            (int(x.split(":")[1]) for x in labels if x.startswith("sp:")), None
        )
        stream = streams.get(number) or stream_for(number, issue["title"], labels)
        if number not in led.items:
            added += 1
        led.upsert(number, issue["title"], stream, lane=lane, size=size)

    # An issue that is no longer open was closed by SOMETHING -- and this code
    # does not know what, so it does not get to say. Earlier this branch wrote
    # `receipt_kind = "closed-externally"`, a string that is not a receipt kind
    # in policy.json and whose only effect was to satisfy the truthiness check
    # that enforces R2. Inventing a receipt to get past the receipt gate is the
    # gate defeating itself.
    #
    # `needs-audit` is NON-TERMINAL on purpose: the item stays in the queue and
    # a human or a lane has to say what closed it. That is what README's
    # "reopen anything auto-closed w/o a receipt" always meant.
    #
    # THIS TEST STAYS ON `TERMINAL` -- the full three -- while `upsert`'s reopen
    # branch is on the narrower `REOPEN_DISPUTES`. They are two different
    # questions and #4535 is what conflating them cost. The whole matrix:
    #
    #   state     | seen OPEN on GitHub (upsert)      | departed (here)
    #   ----------|-----------------------------------|------------------------
    #   closed    | disputed -> needs-audit, receipt   | expected -> survives
    #             | voided                             |
    #   parked    | EXPECTED -> survives parked        | survives parked
    #   declined  | disputed -> needs-audit            | expected -> survives
    #
    # THE `closed`/OPEN CELL NOW MEANS WHAT IT SAYS (#4545). It used to fire on
    # the harness's OWN closes, because nothing closed the issue upstream -- so
    # "disputed" was a false reopen and the void destroyed a receipt taken
    # minutes earlier. `record_receipt_from_evidence` closes the GitHub issue
    # before it writes the ledger, so a `closed` item seen open again is once
    # again evidence that a HUMAN reopened it. The demotion and the void are
    # deliberately untouched: the fix is to stop manufacturing false reopens,
    # not to stop noticing real ones.
    #
    # THAT ARGUMENT RESTS ON AN ASSUMPTION, stated here because it was load-
    # bearing and unwritten: that `gh issue list`, which produces `live`, is
    # READ-AFTER-WRITE CONSISTENT with the `gh issue close` this harness just
    # issued. If a list read lagged a close by a cycle, this cell would fire on
    # the harness's own close again and void the receipt -- the original #4545
    # symptom from a different cause, and it would look identical. The risk is
    # low and not zero: `gh issue list` reads the issues endpoint rather than
    # the search index, and the closer's own read-back observed CLOSED through
    # that same endpoint before the ledger was written at all. It is NOT
    # mitigated in code. The mitigation, if a lagging read is ever observed, is
    # to require the reopen to postdate the close's own timestamp in the issue
    # history rather than to infer it from a single list read.
    #
    # The `parked`/departed cell is the one with no obvious right answer: the
    # issue being closed does not establish that the blocker lifted, and there
    # is no state meaning "park resolved", so auditing it would only reproduce
    # the unreachable-`drained()` shape from the other side. It is left
    # surviving, deliberately, and pinned by a test.
    departed = 0
    for number, item in led.items.items():
        if number not in live_numbers and item.state not in TERMINAL and item.state != NEEDS_AUDIT:
            item.audit_reason = AUDIT_DEPARTED
            led.transition(
                number, NEEDS_AUDIT,
                f"not open on GitHub at refresh, was {item.state} - what closed it?"
            )
            departed += 1
    return added, departed


def reap_stranded(led: Ledger, cycle: int) -> int:
    """Return in-flight items to ready.

    Items move to `in-flight` when a cycle selects them and nothing moves them
    back. A killed session -- and this host memory-kills processes -- therefore
    removes up to `max_lanes` items from scheduling permanently, which is the
    opposite of "a dead session costs at most the cycle in flight".
    """
    reaped = 0
    for item in led.items.values():
        if item.state == IN_FLIGHT:
            led.transition(item.number, READY, f"reaped at cycle {cycle} - lane never returned")
            reaped += 1
    return reaped


def select_cycle(led: Ledger, policy: dict) -> list:
    """Pick the next lane set: stream order, file-disjoint, WIP-capped.

    Two refusals matter here. Items sharing a lane are NOT scheduled together --
    a shared-file conflict must serialize. And unschedulable items (no lane or
    no size) are never selected for implementation; they are routed to triage,
    because scheduling an item whose file footprint is unknown is how two lanes
    end up editing the same file.
    """
    # The hard ceiling is a CONTROL, not a comment. The host carries ~66 GB
    # committed before any agent starts, which is why three things were
    # memory-killed on 2026-09-11; a WIP cap edited past the ceiling in a hurry
    # is how a run discovers that again.
    ceiling = policy["wip"]["max_lanes_hard_ceiling"]
    cap = policy["wip"]["max_lanes"]
    if cap > ceiling:
        raise SystemExit(
            f"wip.max_lanes={cap} exceeds wip.max_lanes_hard_ceiling={ceiling}. "
            "Raise the ceiling deliberately, in policy.json, or lower the cap."
        )
    order = policy["ordering"]["streams"]
    chosen: list = []
    taken_lanes: set[str] = set()

    for stream in order:
        for item in sorted(led.by_stream(stream), key=lambda i: i.number):
            if len(chosen) >= cap:
                return chosen
            if item.state != READY or not item.schedulable:
                continue
            if item.lane in taken_lanes:
                continue
            taken_lanes.add(item.lane)
            chosen.append(item)
    return chosen


def triage_queue(led: Ledger, limit: int = 12) -> list:
    """Items that cannot be scheduled until they are sized and laned.

    118 of 297 carried no lane and 153 no size at open, so this gates the
    parallelism for every other stream and runs continuously alongside them.
    """
    return [
        i for i in led.remaining() if not i.schedulable
    ][:limit]


def audit_queue(led: Ledger, limit: int = 12) -> list:
    """Items whose disappearance from GitHub nobody has explained yet."""
    return [i for i in led.items.values() if i.state == NEEDS_AUDIT][:limit]


def write_brief(item, policy: dict) -> str:
    """A brief is SELF-CONTAINED. An agent never needs the previous transcript.

    This is the context-rotation contract: the ledger is the only durable state,
    and every brief is regenerated from it. Carrying a brief forward across
    cycles is how a plan gets summarized into vagueness.

    The receipt is derived from the item's CLASS, not from whether its lane is
    the console one. Keyed on the lane, only two of policy.json's five receipt
    kinds were ever reachable, and every deploy-path brief -- the stream R1 says
    preempts all other work -- told its agent that CI green closes the issue.
    """
    receipt_class = item.effective_receipt_class
    receipt = policy["receipts"].get(receipt_class, "UNCLASSIFIED - do not close")
    stop = ", ".join(gates.stop_and_ask_actions(policy))
    never = ", ".join(policy.get("never", []))
    # The lane is TOLD its review requirement rather than left to infer it.
    # W0 ran eight posted rounds with two reviewers because it was the merge gate; an
    # ordinary lane gets one, escalating on a finding or on a guard/deploy/
    # console path.
    # The STREAM is authoritative here and the lane is only a hint: at brief
    # time the diff does not exist, so the path set is a guess. `footprint_known`
    # is False whenever the lane is missing or unmapped, which makes the guess
    # fail CLOSED instead of quietly returning the default.
    lane_path = gates.LANE_PATHS.get(item.lane or "")
    reviewers, why_reviewers = gates.review_requirement(
        policy,
        changed_paths=[lane_path] if lane_path else [],
        stream=item.stream,
        footprint_known=bool(lane_path),
    )
    return f"""### Lane {item.lane} - issue #{item.number} ({item.stream}, {item.size}pt)

{item.title}

**Read the issue first**: `gh issue view {item.number}` - and treat every claim
in it as a HYPOTHESIS to re-verify at head. Issues here go stale fast.

**Check for supersession before fixing anything.** An issue sat blocked while
another PR had already delivered three quarters of it; merging would have
advertised work the diff no longer contained.

**Receipt required to close: `{receipt}`** (class `{receipt_class}`). Per
deploy-integrity R2 a merge is NOT a receipt, and the ledger enforces the KIND,
not merely that some receipt is attached - `ledger.transition()` refuses any
other kind for this class. If this is a UI surface, the G1 assertion must key on
something only a success path can produce, and you must name why it is
unreachable from an error path - an assertion satisfied by `Error: HTTP 500` is
not a receipt.

**Ask of any guard fix: what is the OTHER side of this boundary?** The dominant
defect of the last drain was a correct fix applied to one side of a symmetry -
consumer but not producer, one predicate of four, one call site of two - and
every one shipped with a green mutation matrix, because authors mutate the thing
they just fixed.

**Independent review: {reviewers} reviewer(s)** - {why_reviewers}. The reviewer is
read-only, so writer != verifier is enforced by TOOL ACCESS, not by instruction.
Escalate to a second reviewer if the first returns REQUEST-CHANGES or
CANNOT-ASSESS. A verdict RETURNED to you is not a verdict POSTED - `gh pr comment`
it, or the gate cannot see it and will say so.

**Gates are a PROGRAM, not a judgement. Run it and paste the output:**

    python tools/drain/merge_gate.py <PR>

It checks the PR is known-MERGEABLE, base == origin/main (from the API, not a
stale local ref), reduces verdicts by conjunction (a later APPROVE does not
discharge an earlier block, and an unparseable review AT HEAD blocks), requires
every required context present and green with none SKIPPED, blocks an UNDECLARED
auto-close found in EITHER the body or the commit trail (`closingIssuesReferences`
is not a complete oracle and is never subtracted from the scan), and writes the
pre-merge open-issue NUMBERS for the post-merge set audit. Clear any conflict
BEFORE pushing - a push into a CONFLICTING window gets zero check-runs,
permanently.

**Writing the review verdict so it REGISTERS**: the comment's FIRST non-empty
line, at indent zero, BEGINNING with `Independent review` or
`Independent re-review` and carrying the token. Position, not formatting -- a
header in a quote, a fence, an indent or a `<details>` is a CITATION and never a
decision. Tokens on that line are read worst-first, so a hedged header resolves
to the block. In a comment whose first line announces NOTHING, a blocking token
anywhere in the window blocks anyway: formatting never reduces a block.

**Stop and ask for**: {stop}.
**Never, regardless**: {never}.
"""


def emit(led: Ledger, policy: dict, chosen: list, triage: list, audit: list) -> str:
    counts = led.counts()
    lines = [
        f"# Drain cycle {led.cycle}",
        "",
        "| state | n |",
        "|---|---:|",
    ]
    for key, value in counts.items():
        lines.append(f"| {key} | {value} |")
    lines += ["", f"## Selected lanes ({len(chosen)})", ""]
    lines += [write_brief(i, policy) for i in chosen] or ["_none schedulable_"]
    if audit:
        lines += [
            "",
            f"## Needs audit ({len(audit)} shown) - left GitHub with no receipt",
            "",
            "Each of these was open and is not any more, and the harness does not know why.",
            "Find what closed it, attach the receipt its class requires, or reopen it.",
            "",
        ]
        lines += [f"- #{i.number} {i.title[:88]}" for i in audit]
    if triage:
        lines += [
            "",
            f"## Triage queue ({len(triage)} shown) - unlaned or unsized, blocks scheduling",
            "",
        ]
        lines += [f"- #{i.number} {i.title[:88]}" for i in triage]
    return "\n".join(lines)


def _save_refusing_lost_update(led: Ledger) -> None:
    """Persist the ledger, REFUSING a lost update rather than overwriting.

    A one-line helper with a real job: `Ledger.save()` serialises the whole
    document from memory, so a plain save by a second lane does not merge the
    first lane's transitions -- it erases them. `if_unchanged=True` turns that
    into a `LedgerChangedError` the caller reports. Two independent reviewers
    blocked the earlier `merge_gate.bind_pr` attempt over exactly this (#4489),
    so the safe form is named rather than left to each call site to remember.
    """
    led.save(if_unchanged=True)  # CAS - refuse a lost update, never overwrite


class PrBindRefusedError(Exception):
    """The PR offered does not bind to this item. NOTHING is written.

    A distinct class from `ReceiptRefusedError` because the two say different
    things (deploy-integrity R7): a refused receipt means the evidence did not
    establish that the work is DONE; a refused bind means the harness will not
    record WHO is holding the item. Neither writes, and conflating them in one
    message would make a bind refusal read as a completion failure.
    """


def bind_pr_for_item(led: Ledger, repo: str, number: int, pr: int) -> str:
    """Record that a lane opened PR `pr` for item `number` (#4489).

    THE GAP THIS CLOSES, measured 2026-09-22. `Item.pr` has existed since the
    ledger was written and nothing wrote it, and `tick.py` exposed no verb by
    which a lane could report progress at all. The only ways out of `in-flight`
    were `--record-receipt` (which demands a MERGED PR or a concluded run, i.e.
    terminal) and `--reap` (back to `ready`). A lane that did its work and
    opened a PR had nowhere to put that fact, so the item sat `in-flight` until
    the next cycle reaped it as "lane never returned".

    That is not a bookkeeping nit; it loses work. On the live ledger:

        #4495  state=ready  pr=None  "reaped at cycle 13 - lane never returned"
               ... while PR #4564 (fix/4495-op19-function-apps) was OPEN
        #4619  state=ready  pr=None  never laned at all
               ... while PR #4621 (fix/4619-server-derived-scope) was OPEN

    Both were returned to `ready` and are schedulable again, so the next cycle
    may hand the same item to a second lane and pay for the work twice. Across
    14 cycles the ledger records **46** "lane never returned" events and no item
    has reached a terminal state since 2026-09-17.

    WHY HERE AND NOT IN `merge_gate.py`. It was tried there once (`bind_pr`) and
    two independent reviewers blocked it: the worktree fallback resolves
    `state.json` from the PRIMARY checkout, so a lane running the gate from its
    own worktree rewrote a ledger it does not own; and it was an unlocked
    read-modify-write on the only durable record with up to four lanes live,
    which both reviewers reproduced as a lost update (`Ledger.save()` serialises
    the whole document from memory, so the loser's transitions do not merge --
    they vanish). `tick.py` is the single writer by design, and the caller here
    saves with `if_unchanged=True`, so a concurrent write is REFUSED rather than
    silently overwriting. That is #4489's "do not reintroduce an unlocked
    read-modify-write" acceptance line, satisfied structurally.

    Refuses, writing nothing, when:
      - the item is unknown to the ledger;
      - the item is already terminal (binding a PR to a closed item would
        assert work is in flight that is not);
      - the PR cannot be read from GitHub -- UNREADABLE is not "does not
        exist", and reporting the second over the first is the R7 error this
        package keeps paying for;
      - the item is already bound to a DIFFERENT PR. That is the poaching case
        `merge_gate.poached_closes()` exists to catch, and it is refused here at
        the source rather than left for the gate to notice later.

    Re-binding the SAME pr is a no-op that still succeeds, so a lane that re-runs
    the command after a dropped connection does not have to reason about whether
    the first call landed.
    """
    # Phrased as a membership test on the ledger rather than `item is None`, and
    # the terminal check via a named flag rather than `if item.state in
    # TERMINAL:`, because mutation arms RW8 and RW5 anchor on those exact lines
    # elsewhere in this file. An anchor that matches twice silently disarms the
    # arm (the runner needs a unique site), so duplicating one here would retire
    # a live witness to buy nothing. Same reason `_save_refusing_lost_update`
    # exists below instead of an inline `led.save(if_unchanged=True)` (RW14).
    if number not in led.items:
        raise PrBindRefusedError(
            f"#{number} is not in the ledger, so there is nothing to bind PR "
            f"#{pr} to. Refresh first, or check the number."
        )
    item = led.items[number]
    already_terminal = item.state in TERMINAL
    if already_terminal:
        raise PrBindRefusedError(
            f"#{number} is {item.state} - terminal. Refusing to bind PR #{pr} to "
            "an item that is not in flight; reopen it first if that is wrong."
        )
    if item.pr is not None and item.pr != pr:
        raise PrBindRefusedError(
            f"#{number} is already bound to PR #{item.pr}; refusing to re-bind it "
            f"to #{pr}. Two PRs claiming one item is exactly what "
            "`merge_gate.poached_closes()` refuses at merge time - resolve which "
            "PR owns this item before continuing."
        )

    # READ THE PR BEFORE WRITING. A number that does not resolve must not become
    # a binding: the whole value of `Item.pr` to gate 3b is that the HARNESS
    # produced it, so recording an unverified integer would make the gate's
    # strongest corroboration as weak as the author's own typing.
    rc, out, err = sh(
        ["gh", "pr", "view", str(pr), "--repo", repo, "--json", "number,state,headRefName"]
    )
    if rc != 0:
        raise PrBindRefusedError(
            f"could not read PR #{pr} from {repo} (rc={rc}), so whether it exists is "
            f"UNKNOWN - not 'no'. Nothing written. gh stderr: {err[:200]}"
        )
    try:
        meta = json.loads(out)
    except json.JSONDecodeError as exc:
        raise PrBindRefusedError(
            f"PR #{pr} read returned unparseable JSON ({exc}); nothing written."
        ) from exc

    # THE PR MUST NAME THE ITEM. Without this the binding is only an integer the
    # caller typed, which is precisely the weakness #4489 says `Item.pr` exists
    # to remove -- a binding worth trusting at gate 3b has to be a fact the
    # harness established, not a claim it transcribed. `_pr_references_item`
    # already reads BOTH surfaces (`closingIssuesReferences` and a verb-agnostic
    # body/commit scan, so a bare `Refs #N` counts) and its own docstring notes
    # it is weaker than this binding -- which is the right way round: it is the
    # evidence, this is the record.
    try:
        _pr_references_item(repo, pr, number)
    except ReceiptRefusedError as exc:
        raise PrBindRefusedError(
            f"PR #{pr} does not name #{number} anywhere in its body, its commit "
            f"trail or its closing references, so it is not evidence of a lane "
            f"holding this item. Nothing written. ({exc})"
        ) from exc

    was = item.state
    item.pr = pr
    note = f"bound PR #{pr} ({meta.get('state', '?')}, {meta.get('headRefName', '?')})"
    # EVERY bind moves the item to `in-review`, including one that was `ready`.
    #
    # The first version left a `ready` item's state alone, on the reasoning that
    # a PR can appear before the ledger lanes the item (#4619's exact shape) and
    # inventing a lane that never ran would be a lie. A reviewer measured what
    # that actually costs, and the reasoning was wrong in the direction that
    # matters: `select_cycle` skips anything `!= READY`, so a bound `ready` item
    # stays SELECTABLE. Lane A opens the PR and binds it; the next cycle hands
    # the same item to lane B; lane B redoes the work and then cannot report at
    # all, because this function refuses a re-bind to a DIFFERENT PR. That is
    # "pay for the work twice" -- the precise harm this writer exists to stop --
    # reproduced on the one case the issue cites.
    #
    # `in-review` is also simply true of a `ready` item that has a PR: the work
    # exists and is waiting on review. Being unschedulable is the point, not a
    # side effect.
    #
    # SCOPED TO `in-flight` AND `ready`, because the unconditional version this
    # replaced was over-broad by two states and a reviewer measured the cost.
    # `transition()` clears `audit_reason` only on TERMINAL (ledger.py:565), so
    # binding a `needs-audit` item moved it to `in-review` carrying an orphaned
    # `audit_reason` and SILENTLY EMPTIED the audit queue -- and it never comes
    # back, because `upsert`'s reopen branch fires only from a TERMINAL
    # `was_state`. A `needs-audit` item is one whose receipt is IN DISPUTE; a
    # lane binding a PR to it must not discharge that dispute as a side effect.
    # `awaiting-receipt` is the same shape and currently unreachable (no
    # production writer for it), but it is excluded on the same reasoning rather
    # than on the accident of being unreachable.
    if was in (IN_FLIGHT, READY):
        led.transition(number, IN_REVIEW, why=note)
    else:
        item.history.append(f"{note} (state left at {was}: not a schedulable state)")
    return f"#{number}: {note}; state {was} -> {item.state}"


class DispositionRefusedError(Exception):
    """A park or a decline did not meet its bar. NOTHING is written, ANYWHERE.

    Its own class, not `ReceiptRefusedError`, for the reason `PrBindRefusedError`
    has one (deploy-integrity R7): a refused receipt says the evidence did not
    establish that the work is DONE. A refused disposition says the opposite kind
    of thing -- the work is NOT done and the reason offered for stopping is not
    good enough. Printing one over the other names the wrong half of the ledger.

    "Nothing, anywhere" is structural rather than aspirational: every check that
    raises this runs BEFORE `post_disposition_comment`, so a refusal cannot leave
    a comment on a public issue. That ordering is the whole value of these checks
    over the ones `ledger.transition()` already enforces -- see `_dispose`.
    """


class DispositionCommentFailedError(Exception):
    """The disposition comment was NOT posted, so NOTHING was written anywhere.

    Separate from `DispositionRefusedError` because the bar may have been met
    perfectly and the WRITE failed. The ledger side is established on every
    route here: `_dispose` posts before it transitions, so a failure at this
    point leaves the item exactly as it was.
    """


class LedgerWriteAfterCommentError(Exception):
    """The comment LANDED and the ledger write that should follow did not.

    The sibling of `LedgerWriteAfterCloseError`, and it needs its own word for
    the same reason: the two records disagree, and which one moved is the first
    thing the operator has to know. Here the public artifact carries the
    disposition and the ledger does not, so the item is STILL IN THE QUEUE --
    which is the recoverable direction, because a re-run is legal and its only
    cost is a duplicate comment.
    """


#: THE FIRST LINE OF EVERY DISPOSITION COMMENT, held as a constant because it is
#: what a future reader (or a future de-duplicating read, the #4579 shape) would
#: have to match on. `_receipt_comment`'s equivalent prefix is embedded in its
#: f-string and is transcribed into `close_issue_on_github`'s remediation text by
#: hand; one of those two copies is the kind of thing that drifts.
DISPOSITION_HEADS = {
    PARKED: "Drain harness: PARKED - blocked, not done.",
    DECLINED: "Drain harness: DECLINED - will not do.",
}


def _disposition_comment(target_state: str, evidence: list[tuple[str, str]]) -> str:
    """The comment a park or a decline posts. THE PERMANENT PUBLIC RECORD.

    Like `_receipt_comment`, this is unrevisable once posted, so the two bodies
    are written out in full rather than assembled from a shared template: a
    shared template is how the two receipt routes came to say the same wrong
    thing, and the park/decline pair differs on the one fact that matters most
    -- what happens to the ISSUE.

    **WHAT EACH BODY MUST NOT CLAIM.** The comment is posted BEFORE the ledger
    write (see `_dispose`), so it cannot say "this item is parked in the ledger"
    -- on the write-failed path that is false, published rather than printed,
    which is the R7 defect `close_issue_on_github` already paid for once. Both
    bodies therefore state the DISPOSITION and its EVIDENCE, which are true at
    the moment of posting because they are the caller's own input, and say in
    terms that the ledger write follows.

    **AND WHY THE DECLINE BODY DOCUMENTS ITS OWN DEMOTION.** A declined item
    whose issue is still open is demoted to `needs-audit` by the next refresh
    (`REOPEN_DISPUTES` includes `declined`). That is deliberate and is the
    documented behaviour, but from the outside it reads as the harness undoing
    itself -- so the comment names the escape (`gh issue close --reason
    not-planned`, by hand) at the place the next reader is standing.
    """
    head = DISPOSITION_HEADS[target_state]
    facts = "\n".join(f"{label}: {value}" for label, value in evidence)
    tail = (
        "WHAT THIS DOES NOT ESTABLISH: nothing here adjudicates the reason above. "
        "The harness records a disposition supplied by a lane or an operator; it "
        "does not verify that the blocker is real or that the decision was the "
        "right one. This comment is posted BEFORE the ledger write, so if that "
        "write did not land the item is still in the queue and a re-run posts "
        "this again."
    )
    if target_state == PARKED:
        return (
            f"{head}\n\n{facts}\n\n"
            "THIS ISSUE STAYS OPEN, DELIBERATELY. `parked` is a terminal state in "
            "the drain ledger and it is NOT a close: the work is blocked, not "
            "done, and closing a blocked item's issue is how a backlog lies about "
            "itself (deploy-integrity R2). The harness will not close it -- "
            "`CLOSES_ON_GITHUB` is `closed` and nothing else -- and the refresh "
            "leaves a park alone for the same reason, because `REOPEN_DISPUTES` "
            "deliberately excludes `parked` (#2874, where every refresh demoted "
            "every park and the drain's exit condition became unreachable for "
            "anything genuinely blocked).\n\n"
            "TO UNPARK IT: resolve the blocker and say so here. The park is "
            "terminal, so the harness will not re-select this item on its own.\n\n"
            f"{tail}"
        )
    return (
        f"{head}\n\n{facts}\n\n"
        "THIS ISSUE IS NOT CLOSED BY THE HARNESS, and that is not an oversight. "
        "A decline's disposal is `gh issue close --reason not-planned` -- a "
        "different close, with a different reason, resting on a judgement no "
        "program made -- so `CLOSES_ON_GITHUB` excludes `declined` and this tool "
        "does not perform it.\n\n"
        "WHAT HAPPENS NEXT, SO IT IS NOT READ AS A BUG: while this issue stays "
        "OPEN, the next refresh demotes the ledger item to `needs-audit`, because "
        "a declined item seen open again means either the decline never reached "
        "GitHub or somebody is disputing it (#4535) -- both want a look. Closing "
        "this issue by hand with `--reason not-planned` is what makes the decline "
        "stand. A park has no such escape; a decline does, which is exactly why "
        "the two states are treated differently.\n\n"
        f"{tail}"
    )


def post_disposition_comment(
    policy: dict, repo: str, number: int, target_state: str, body: str
) -> str:
    """Post the disposition on the ISSUE, and never touch its open/closed state.

    THE MIRROR OF `close_issue_on_github`'S GUARD, and it is here for the same
    reason that one is: so a future route cannot acquire the wrong behaviour by
    forgetting. That function refuses to CLOSE anything outside
    `CLOSES_ON_GITHUB`; this one refuses to be used FOR a state inside it. A
    `closed` item's public record is posted by the closer, in the same argv as
    the close, and a second route that commented without closing would produce
    exactly the artifact #4545 is about -- a ledger close with no upstream one.

    DISCLOSED, in the form `close_issue_on_github` uses: no reachable caller
    passes a `CLOSES_ON_GITHUB` state today. `_dispose` is called only with
    `PARKED` and `DECLINED`. It is a fail-closed precondition for the callers
    that do not exist yet, and the test that pins it calls this function
    directly and says so at its site.

    NOT IDEMPOTENT, and not pretending to be. `close_issue_on_github` reads the
    issue first and short-circuits; there is no equivalent read here, because
    the thing that would have to be read is the COMMENT LIST, and de-duplicating
    against it is #4579's open problem rather than a solved one. What bounds the
    duplication instead is the caller: `_dispose` refuses a TERMINAL item, so the
    only way to post twice is a ledger write that failed after the comment
    landed -- which is a visible, reported state, not a silent one.
    """
    if target_state in CLOSES_ON_GITHUB:
        raise DispositionCommentFailedError(
            f"refusing to comment-without-closing on #{number} for state "
            f"{target_state!r}: {list(CLOSES_ON_GITHUB)} close the issue, and the "
            "comment for those states is posted by `close_issue_on_github` in the "
            "same argv as the close (#4545)"
        )
    permitted, why = gates.action_is_permitted("comment", policy)
    if not permitted:
        raise DispositionCommentFailedError(
            f"refusing to comment on #{number}: `comment` is {why}"
        )
    try:
        rc, _out, err = sh(
            ["gh", "issue", "comment", str(number), "--repo", repo, "--body", body]
        )
    except OSError as exc:
        raise DispositionCommentFailedError(
            f"cannot run `gh` to comment on #{number}: {exc}. Nothing was written."
        ) from exc
    if rc != 0:
        raise DispositionCommentFailedError(
            f"`gh issue comment {number}` failed (rc={rc}): {err[:200]}. Nothing was "
            "written to the ledger and the item is unchanged. WHETHER THE COMMENT "
            "LANDED IS NOT ESTABLISHED BY THIS: a mutation that reached the server "
            "and whose response did not reach the client exits the same way as one "
            "that never left (R7). Re-running is safe and its worst case is a "
            "duplicate comment on an issue that is still in the queue"
        )
    return f"#{number}: disposition comment posted"


def _dispose(
    led: Ledger, policy: dict, repo: str, number: int, target_state: str,
    evidence: list[tuple[str, str]], why: str,
) -> str:
    """Record a park or a decline: comment on the issue, then write the ledger.

    THE TWO TERMINAL STATES THAT NO PROGRAM COULD REACH (#4677). `Ledger` has
    defined five states since it was written and `drained()` -- this program's
    documented exit condition -- is true only when every item is `closed`,
    `parked` or `declined`. `tick.py` could reach exactly one of the three. A
    lane that correctly concluded "blocked on X, owned by Y" had nowhere to put
    that conclusion, so the item returned to `ready` on the next reap to be
    redone by the next lane: #4675's failure, one state over. The live ledger
    holds one parked item, reached by a path that no longer exists.

    THE COMMENT GOES FIRST, AND THE ORDERING IS ARGUED RATHER THAN INHERITED.
    `record_receipt_from_evidence` also writes GitHub first, but for a DIFFERENT
    reason -- there, the ledger-first ordering IS #4545, because a ledger close
    with the issue still open is read as a reopen and voids the receipt. Neither
    of these states is closed upstream, so that argument does not carry, and the
    two orderings have to be compared on their own terms:

    - **comment, then ledger** (this one). If the ledger write fails, the issue
      carries a comment stating a disposition and the item is still in the
      queue. Nothing false has been published -- the comment states the
      disposition and its evidence, which were true when posted, and says in
      terms that the ledger write follows it. The item is re-selectable and a
      re-run costs one duplicate comment.
    - **ledger, then comment.** If the comment fails, the item is TERMINAL with
      no public trace at all, and `state.json` is gitignored -- so the whole
      existence of the disposition is a local file. Worse, it is PERMANENT:
      `_dispose` refuses a terminal item, so no re-run ever repairs it. That is
      the shape `close_issue_on_github` names as the reason its close and its
      comment share one argv, and it is exactly what this issue's acceptance
      ("the next reader finds it where they are, not in a gitignored local
      file") forbids.

    Silent-and-unrepairable versus loud-and-duplicated, the same trade the
    closer took, decided the same way.

    REFUSES, WRITING NOTHING AND POSTING NOTHING, when the item is unknown or is
    already terminal. Re-disposing a terminal item would rewrite the evidence a
    previous disposition rests on, which is the refusal
    `record_receipt_from_evidence` makes at its own top.
    """
    if number not in led.items:
        raise DispositionRefusedError(
            f"#{number} is not in the ledger, so there is nothing to record a "
            f"{target_state} against. Refresh first, or check the number."
        )
    item = led.items[number]
    # Via a named flag rather than `if item.state in TERMINAL:`, and via
    # `_save_refusing_lost_update` rather than an inline guarded save below, for
    # the reason `bind_pr_for_item` gives at its own copy of both: mutation arms
    # RW5 and RW14 anchor on those exact lines elsewhere in this file, and an
    # anchor that matches twice silently DISARMS the arm -- the runner needs a
    # unique site. Measured here: adding the obvious spellings broke both.
    already_terminal = item.state in TERMINAL
    if already_terminal:
        raise DispositionRefusedError(
            f"#{number} is already {item.state} - terminal. Refusing to re-dispose "
            f"it as {target_state}; that would rewrite the evidence the existing "
            "disposition rests on."
        )

    note = post_disposition_comment(
        policy, repo, number, target_state, _disposition_comment(target_state, evidence)
    )

    # EVERYTHING FROM HERE IS A POST-COMMENT FAILURE and is reported as one. The
    # rollback restores the item, so `main()` saves nothing -- but the COMMENT IS
    # PUBLISHED, and a message that says "nothing was written" without saying so
    # is false in the half the operator has to act on (R7).
    was = item.state
    before = (item.blocker, item.owner)
    history_len = len(item.history)
    try:
        if target_state == PARKED:
            # The ledger's own bar (`transition` refuses a park without BOTH)
            # reads these fields, so they are set before the call rather than
            # recorded after it.
            item.blocker, item.owner = evidence[0][1], evidence[1][1]
        led.transition(number, target_state, why)
    except Exception as exc:
        (item.blocker, item.owner) = before
        del item.history[history_len:]
        raise LedgerWriteAfterCommentError(
            f"#{number}: the disposition comment was posted and the ledger write "
            f"that should have followed failed: {exc}. The item is STILL {was} "
            "here and the comment is on the issue; nothing was saved. Re-run the "
            "same command - the only cost is a second comment, and the item is "
            "still in the queue until one of them is followed by a write."
        ) from exc
    return f"#{number}: {target_state} ({note}); state {was} -> {item.state}"


def park_item(
    led: Ledger, policy: dict, repo: str, number: int,
    blocker: str | None, owner: str | None,
) -> str:
    """Record that this item is genuinely BLOCKED, naming the blocker and owner.

    THE BAR IS THE LEDGER'S, SURFACED AT THE CLI, AND THE DUPLICATION IS THE
    POINT. `ledger.transition()` already refuses a park without both fields, so
    these two checks change no outcome for the LEDGER -- delete them and a
    missing blocker still ends in a refusal. What they change is WHEN the refusal
    happens: before `_dispose` posts anything. Without them a `--park` with no
    owner publishes a permanent comment on a public issue announcing a park that
    is then refused, and no re-run removes it.

    So the value these checks carry is not "the park is refused" -- it is "the
    refusal is silent upstream", and the test that pins them asserts exactly that
    (zero `gh` calls), because an assertion that only watched the exception would
    be satisfied by the ledger's own refusal and would witness nothing.

    THEY ARE TWO CHECKS, NOT ONE CONJUNCTION, deliberately. `transition` asks
    `not (blocker and owner)` and can only say "one of these is missing"; a lane
    that passed `--blocker` and forgot `--owner` needs to be told WHICH. It also
    gives the mutation matrix two separate anchors, so deleting the owner check
    alone is a mutation the suite can see.
    """
    if not blocker or not blocker.strip():
        raise DispositionRefusedError(
            f"#{number}: refusing to park without a named BLOCKER - pass "
            "--blocker '<what is blocking it>'. A park with no blocker is "
            "indistinguishable from forgetting, and nothing was written or posted."
        )
    if not owner or not owner.strip():
        raise DispositionRefusedError(
            f"#{number}: refusing to park without a named OWNER - pass "
            "--owner '<who owns clearing it>'. A park with no owner is how an "
            "item leaves the queue without leaving the backlog, and nothing was "
            "written or posted."
        )
    blocker, owner = blocker.strip(), owner.strip()
    return _dispose(
        led, policy, repo, number, PARKED,
        [("BLOCKER", blocker), ("OWNER", owner)],
        f"blocked on {blocker}; owner {owner}",
    )


def decline_item(
    led: Ledger, policy: dict, repo: str, number: int, decision: str | None
) -> str:
    """Record that this item WILL NOT BE DONE, on a recorded decision.

    THE DECISION TEXT IS PASSED TO `transition` VERBATIM as its `why`, rather
    than wrapped in a sentence. That is load-bearing rather than tidy: the
    ledger's own refusal tests `why and why.strip()`, so any wrapper -- even
    `f"declined: {decision}"` -- makes that check pass on a decision of None,
    and the ledger's bar would be satisfied by this function's own prose. Passing
    it through means the CLI check and the ledger check are testing the SAME
    string, and deleting the one here leaves the other genuinely guarding.

    What the check here still buys is the same thing the park's two buy: the
    refusal happens before `_dispose` publishes anything. Its test asserts zero
    `gh` calls for that reason.

    THIS DOES NOT CLOSE THE ISSUE, and the comment says so at length. A
    decline's disposal is `gh issue close --reason not-planned` -- a judgement no
    program made -- so `CLOSES_ON_GITHUB` excludes `declined` and the next
    refresh will demote this item to `needs-audit` while the issue stays open.
    That asymmetry with `parked` is the documented behaviour (#4535), it is
    pinned by a test alongside the park's survival, and the escape is named in
    the comment where the next reader will be standing.
    """
    if not decision or not decision.strip():
        raise DispositionRefusedError(
            f"#{number}: refusing to decline without a recorded DECISION - pass "
            "--decision '<who decided, and on what grounds>'. 'Will not do' with "
            "no recorded reason is how a backlog declines itself drained, and "
            "nothing was written or posted."
        )
    decision = decision.strip()
    return _dispose(
        led, policy, repo, number, DECLINED, [("DECISION", decision)], decision,
    )


class ReceiptRefusedError(Exception):
    """The evidence offered does not establish the receipt. Never recorded."""


class IssueCloseFailedError(Exception):
    """The GitHub close was NOT CONFIRMED, so NOTHING was written to the ledger.

    A separate class from `ReceiptRefusedError` on purpose (deploy-integrity
    R7): a refusal says the evidence was not good enough, and printing that
    over a network failure asserts a cause the code did not establish. Here the
    receipt may have been perfectly sound and the WRITE failed.

    "NOT CONFIRMED" rather than "did not happen", because one of the three
    routes here is a read-back that could not be READ -- `gh issue close`
    returning 0 and the verification hitting a 502 means the close LANDED and
    this tool cannot say so. The one thing established on every route is the
    ledger side: nothing was written.
    """


class LedgerWriteAfterCloseError(Exception):
    """The GitHub close LANDED and the ledger write that should follow failed.

    THE REVERSE PATH, and it needs its own word for the same reason
    `IssueCloseFailedError` does. A reviewer found both sibling messages saying
    the opposite of what had happened: a lost CAS after a successful upstream
    close printed `RECEIPT NOT RECORDED`, which reads as "nothing happened",
    and a ledger refusal after that same close printed `RECEIPT REFUSED`, which
    reads as "your evidence was rejected". Neither is true -- the issue is
    closed on GitHub and the evidence was fine.

    The state of the world when this is raised: **issue closed upstream, ledger
    NOT written, nothing saved**. That is the recoverable half of the ordering
    argued in `record_receipt_from_evidence` -- re-running the same command is
    safe and is the remedy, because the closer reads the issue state first,
    sees CLOSED and short-circuits.
    """


def _object_kind_from_url(url: str) -> str:
    """The `issues` / `pull` segment of a github.com object URL, BY POSITION.

    `.../{owner}/{repo}/{kind}/{number}` -- the kind is the third path segment,
    read positionally rather than by asking whether "pull" appears anywhere in
    the string. A repository legitimately named `pull` would satisfy the
    substring test and answer the wrong question, which is the shape recorded
    in `csa_loom_parse_by_position_not_by_idiom`.

    Returns "" when the URL has no such segment, so the caller fails CLOSED on
    a shape this function does not recognise rather than guessing "issues".
    """
    parts = [p for p in urllib.parse.urlparse(url).path.split("/") if p]
    return parts[2] if len(parts) >= 4 else ""


def _object_repo_from_url(url: str) -> str:
    """The `{owner}/{repo}` of a github.com object URL, BY POSITION.

    THE OTHER HALF OF THE SAME READ, and it was missing. `_object_kind_from_url`
    established that `gh issue view` answered about an ISSUE; nothing
    established that it answered about an issue in the repository this tool
    asked about. A TRANSFERRED issue is exactly that gap: GitHub keeps the old
    number reachable and answers with the NEW repository's url, so the pre-read
    could short-circuit -- or the read-back could satisfy the verification -- on
    an object living somewhere else entirely. Measured on the round-11 head:
    `https://github.com/other-org/other-repo/issues/9` read `kind='issues'` and
    was accepted.

    Narrow today, because every ledger number originates in
    `gh issue list --repo`. Fixed anyway for the reason arm GH22 exists: the
    `--repo` pin on both reads was argued from "the pre-read can short-circuit
    on a FOREIGN repo's issue", and the url that settles it was already parsed.
    An argv pin is a hope about what `gh` will do; comparing the url it answered
    with is the same claim verified by effect.

    Returns "" when the URL has no such pair, so the caller fails CLOSED on a
    shape this function does not recognise rather than guessing the caller's own
    repository.
    """
    parts = [p for p in urllib.parse.urlparse(url).path.split("/") if p]
    return f"{parts[0]}/{parts[1]}" if len(parts) >= 4 else ""


class _IssueRead(NamedTuple):
    """What ONE `gh issue view` established, carried together.

    The TITLE rides along with the state because it is not decoration: it is
    operator-supplied data that `gh` interpolates into the very stderr line
    `_close_outcome` classifies, and knowing its value is what lets the caller
    take it back out again before reading `gh`'s prose. It costs no extra call
    -- one more field on a `--json` list that was already being fetched.
    """

    state: str
    title: str


def _read_issue_on_github(repo: str, number: int) -> _IssueRead:
    """Read ONE issue's OPEN/CLOSED state AND title. Raises rather than guessing.

    Never discards stderr and never turns an unreadable answer into a
    convenient one -- the roll that reported "the tag does not exist" when the
    truth was "I could not reach the registry" is the shape being avoided here
    (deploy-integrity R7).

    IT ALSO ESTABLISHES THAT THE NUMBER IS AN ISSUE, which the state alone does
    not. `gh issue view` RESOLVES A PULL REQUEST -- measured live on 2026-09-18,
    `gh issue view 4552 --json state,url` answered
    `{"state":"OPEN","url":".../pull/4552"}` -- and `gh issue close` then routes
    that number to `api.PullRequestClose` (close.go v2.100.0 :175-177). So a
    type-blind read would let the harness close a PULL REQUEST and post the
    permanent receipt comment on it.

    LATENT TODAY and fixed anyway, because this read is the thing the write is
    justified by: every ledger number originates in `gh issue list --state open`
    via `build_inventory`, but `state.json` is hand-editable and the README
    documents hand edits, so the only barrier is a convention outside this file.
    A read-first that cannot tell what it read does not make a write safe.

    IT ALSO CARRIES THE TITLE BACK, which is what makes `_close_outcome`'s
    classification title-safe without a second `gh` call: see
    `_without_title_line_breaks`. `title` is read as `--json title`, so it is
    the value GitHub holds, not a value parsed back out of gh's prose -- parsing
    it out of the prose would be reading the attacker's data to decide how to
    read the attacker's data.
    """
    rc, out, err = sh(
        ["gh", "issue", "view", str(number), "--repo", repo,
         "--json", "state,title,url"]
    )
    if rc != 0:
        raise IssueCloseFailedError(
            f"cannot read the state of #{number} in {repo} (rc={rc}): {err[:200]}. "
            "This tool does not know whether the issue is open, so it will not "
            "act as though it does."
        )
    try:
        parsed = json.loads(out)
    except json.JSONDecodeError as exc:
        raise IssueCloseFailedError(f"unparseable state for #{number}: {exc}") from exc
    url = str((parsed or {}).get("url") or "")
    kind = _object_kind_from_url(url)
    if kind != "issues":
        raise IssueCloseFailedError(
            f"#{number} in {repo} is not an issue: `gh issue view` resolved it to "
            f"{url!r} ({kind or 'an unrecognised shape'}). `gh issue close` would "
            "route a pull-request number to `api.PullRequestClose` and post the "
            "receipt comment on the PR, so this tool refuses to act on an object "
            "whose type it has not established"
        )
    # AND THAT IT IS THIS REPOSITORY'S ISSUE. The `--repo` pin above says which
    # repository was ASKED; the url says which one ANSWERED, and a transferred
    # issue makes those differ. Compared case-insensitively because GitHub
    # resolves owner/name case-insensitively and answers in canonical casing,
    # so a policy written `FGarofalo56/...` must not read as a foreign repo.
    answered = _object_repo_from_url(url)
    if answered.casefold() != repo.casefold():
        raise IssueCloseFailedError(
            f"#{number} was requested in {repo} but `gh issue view` answered about "
            f"{answered or 'an unrecognised shape'} ({url!r}) - a transferred issue "
            "keeps its old number reachable and resolves to the NEW repository, so "
            "acting here would close, and permanently comment on, an object in a "
            "repository this tool was not asked about"
        )
    state = str((parsed or {}).get("state") or "").upper()
    if state not in ("OPEN", "CLOSED"):
        raise IssueCloseFailedError(
            f"#{number} reported state {state!r}, which is neither OPEN nor CLOSED - "
            "an answer this tool cannot interpret is not an answer"
        )
    # The title is NOT validated, deliberately: any string GitHub holds is a
    # legitimate title, and there is nothing here to refuse. It is neutralised
    # at the point of USE instead (`_without_title_line_breaks`), because the
    # hazard is not the value -- it is the value being read as structure.
    return _IssueRead(state, str((parsed or {}).get("title") or ""))


#: The receipt kinds whose evidence is a MERGE rather than an observation of
#: anything running. `ci-green` is the only one today; the membership is
#: declared here rather than inferred from a name so a future merge-based kind
#: cannot acquire the estate-observing sentence by being added elsewhere.
MERGE_BASED_KINDS = frozenset({"ci-green"})

#: The receipt kinds whose evidence IS an observation of something that ran.
#: Declared as a POSITIVE set rather than left implicit as `_receipt_comment`'s
#: else-branch, because merge-ness is stated in TWO places -- here and the
#: `if kind == "ci-green":` branch in `record_receipt_from_evidence` -- and an
#: else-branch default means editing only the second one publishes "an
#: observation of something that ran, not a merge" over a merge, permanently
#: and on up to 334 public artifacts. A kind in NEITHER set now RAISES rather
#: than rendering either sentence: the same fail-closed shape
#: `verify_run_backed_receipt` already uses, and the reason the `#:` comment
#: above can claim what it claims.
RUN_BACKED_KINDS = frozenset({"deploy-run", "estate", "g1-browser"})


def _receipt_comment(kind: str, issue_class: str, detail: str) -> str:
    """The comment `gh issue close --comment` posts. THE PERMANENT PUBLIC RECORD.

    This string is the receipt's only trace on the artifact a human reads
    whenever a comment is posted at all, on up to 334 issues, and it is not
    revisable, so it is built deliberately rather than formatted in place.

    **WHERE NO COMMENT IS POSTED, AND THE SENTENCE ABOVE USED TO DENY IT.** That
    sentence read "is the receipt's only trace on the artifact a human reads, on
    up to 334 issues, forever", with no qualifier. It is FALSE on the
    already-closed short-circuit in `close_issue_on_github`: that route issues
    `gh issue view` and nothing else, so no comment exists, and
    `tools/drain/state.json` is untracked -- the receipt's whole existence is a
    local gitignored file. Not a corner, and that is why the claim mattered: all
    7 items the live ledger holds as `closed` are in exactly that state, and the
    route is the one `close_issue_on_github`'s own docstring names as
    motivating. Posting the receipt there too is #4579, deliberately not done
    here; the claim is corrected rather than left standing over the route the
    whole current population takes.

    **WHY IT NAMES `kind` AND `issue_class`.** The previous text was identical on
    both routes and cited `deploy-integrity` R2 on both: "Closing this issue on
    that evidence (deploy-integrity R2)." A reader of a closed issue could not
    tell whether it closed on a live-estate receipt or on CI green at a merged
    sha -- which is the ONE distinction R2 exists to draw.

    **AND WHY THE R2 CITATION IS NOW CONDITIONAL, which is the real defect.** R2
    is "merged is never done". On the `ci-green` route the evidence IS a merge,
    so the old sentence cited that rule in support of precisely what it forbids,
    while `policy.json` carries `report-a-merge-as-a-fix` in its `never` list.
    A merge-based receipt therefore says what it establishes and, explicitly,
    what it did not look at; R2 appears as the reason such a receipt is
    confined to one class, never as the licence for the close.

    **AND WHY THE RUN-BACKED BRANCH NO LONGER CLAIMS R2 SATISFIED.** It used to
    end "an observation of something that ran, not a merge, which is what
    deploy-integrity R2 (merged is not done) asks of this class" -- an assertion
    of SATISFACTION, and the code does not establish it. `_run_evidence` never
    requests `createdAt` and `verify_run_backed_receipt` never compares
    `headSha` to anything, so the run is bound to this issue by nothing at all:
    not by reference, not by time, not by sha. Measured rather than argued --
    run `33238747458` (`loom-roll-and-validate`, 2026-08-29, headSha `70ca3d1`)
    passes every check today, and 147 of the 351 currently-open issues were
    filed AFTER it. An outside reader six months from now takes "what R2 asks of
    this class" to mean the estate was observed carrying this issue's change;
    R7 governs implication and the artifact is unrevisable. The asymmetry was
    the tell: the merge branch volunteers its own two gaps and the run branch --
    the one whose binding is WEAKER, since `--from-pr` at least goes through
    `_pr_references_item` -- volunteered one of three. R2 now appears on this
    branch as the reason the class takes a run rather than a merge, which is
    true, and the binding gap is disclosed in the comment with #4578 tracking
    the repair (fetch the run's date, compare it to the item's, refuse a run
    that predates it; the sha half is bound by neither, and #4489 did not
    deliver it -- that writer records WHICH PR, not which sha).

    The two branches are written out rather than assembled from fragments: a
    sentence this permanent should be readable in full at the place it is
    decided, and a shared template is how the two routes came to say the same
    wrong thing in the first place.

    **AND WHY A THIRD KIND RAISES.** Until round 7 the merge branch's else was
    an unconditional `return` of the run-backed text, so a kind in neither
    category got precisely the estate-observing sentence -- while the comment on
    `MERGE_BASED_KINDS` claimed a future merge-based kind "cannot acquire" it.
    That claim was false for the case it named. Latent, not live: the four
    renderable kinds are classified correctly and `operator` is refused earlier
    by `verify_run_backed_receipt`. It goes live the moment a second merge-based
    kind is added at `record_receipt_from_evidence`'s `if kind == "ci-green":`
    and not here. Failing closed is chosen over correcting the docstring because
    the output is PERMANENT and PUBLIC: a loud refusal before anything is
    written is recoverable, and a wrong sentence on a closed issue is not.
    """
    head = f"Drain harness: receipt verified (kind={kind}, class={issue_class}) - {detail}."
    if kind in MERGE_BASED_KINDS:
        return (
            f"{head} WHAT THIS ESTABLISHES, AND WHAT IT DOES NOT: the evidence is "
            "CI green at the MERGED sha - a merge, not a deploy. It establishes "
            "that every required context that could run at the merged sha was green. "
            "The live estate was never checked and nothing here claims anything "
            "about it. "
            "DISCLOSED: a green context is not evidence it measured a non-empty "
            "POPULATION - green-over-zero-items stays invisible to this receipt "
            "and remains an owed capability, not a claim - and the PR is bound "
            "to this issue by REFERENCE, not by lane (#4489). "
            "Per deploy-integrity R2 (merged is not done) a merge-based receipt "
            f"closes only the {issue_class} class; an issue about deployed "
            "behaviour takes a deploy-run, estate or g1-browser receipt instead. "
            "Closing this issue on that evidence, and on nothing wider than it."
        )
    if kind not in RUN_BACKED_KINDS:
        raise ReceiptRefusedError(
            f"receipt kind {kind!r} is in neither MERGE_BASED_KINDS nor "
            "RUN_BACKED_KINDS, so this tool cannot say whether its evidence is a "
            "merge or an observation of something that ran - refusing to post a "
            "permanent public comment that would assert one of them by default"
        )
    return (
        f"{head} WHAT THIS ESTABLISHES, AND WHAT IT DOES NOT: the evidence is a "
        f"completed run of the only workflow policy accepts as the {kind} "
        "producer, with every step that kind requires observed green. It "
        "establishes that THAT RUN ran and that those steps passed - an "
        "observation of something that ran, not a merge, which is why "
        f"deploy-integrity R2 (merged is not done) makes the {issue_class} class "
        "take a receipt of this shape rather than a CI-green one. "
        "DISCLOSED, and this is the part R2 would additionally need: nothing "
        "here establishes the run carried THIS issue's change. The run is not "
        "bound to the issue - a workflow run names no issue at all, and that "
        "binding is #4489 - and it is bound to no TIME and no SHA either: no "
        "run date is fetched and no head sha is compared, so a run that "
        "PREDATES this issue is accepted exactly as one that postdates it "
        "(#4578). Read this as 'the declared producer ran green', not as 'the "
        "estate was observed carrying this change'. "
        "Closing this issue on that evidence, and on nothing wider than it."
    )


#: `gh`'s OWN WORDS for the two things `gh issue close` can do, both written to
#: stderr, BOTH AT EXIT 0. Lifted from cli/cli v2.100.0
#: `pkg/cmd/issue/close/close.go` -- :118 for the first, :169 for the second --
#: and MEASURED against the installed `gh 2.100.0` on 2026-09-18 by running
#: `gh issue close 4556 --repo fgarofalo56/csa-inabox` against an issue that was
#: already closed: rc=0, stdout EMPTY, stderr
#: `! Issue fgarofalo56/csa-inabox#4556 (...) is already closed`, state
#: unchanged. The success sentence is not exercised that way for the obvious
#: reason -- it would require closing a live issue to watch it print.
#:
#: HELD AS PREFIX/SUFFIX PAIRS, NOT AS FREE SUBSTRINGS, and the split is the
#: whole point (see `_close_outcome`):
#:
#:     :118  "%s Issue %s#%d (%s) is already closed"
#:     :169  "%s Closed issue %s#%d (%s)"
#:
#: The FINAL `%s` in both is `issue.Title` -- operator-supplied data
#: interpolated into the very string the classifier reads.
_GH_ALREADY_CLOSED_PREFIX = "Issue "
_GH_ALREADY_CLOSED_SUFFIX = " is already closed"
_GH_PERFORMED_PREFIX = "Closed issue "
_GH_PERFORMED_SUFFIX = ")"

#: The three answers `_close_outcome` can give. `UNKNOWN` is not a failure
#: mode; it is the honest answer when `gh` said neither sentence.
CLOSE_PERFORMED = "performed"
CLOSE_FOUND_ALREADY_CLOSED = "found-already-closed"
CLOSE_OUTCOME_UNKNOWN = "unknown"


def _sentence_is(body: str, prefix: str, suffix: str) -> bool:
    """`body` is that sentence, read at its FIXED OFFSETS rather than anywhere.

    The prefix compare is case-insensitive because the only variable inside it
    is `{repo}#{number}`: GitHub resolves owner/name case-insensitively and
    prints its canonical casing, so a policy that spells the repository
    differently must still be recognised rather than silently classified
    `UNKNOWN`. Case has no bearing on the forgery this read exists to stop --
    POSITION does.

    The length guard keeps prefix and suffix from OVERLAPPING on a body too
    short to hold both, so a string that is only the beginning of a sentence
    cannot satisfy both ends of it.

    DISCLOSED, because the previous revision of this paragraph presented that
    guard as doing work here and it does none: at the two (prefix, suffix)
    pairs `_close_outcome` actually passes, the guard is an EQUIVALENT MUTANT.
    Measured two ways at `4ce05224585` -- an exhaustive differential over 200
    candidate bodies (every prefix, suffix, concatenation and case variant of
    both rendered sentences) against both real pairs found ZERO inputs whose
    verdict the guard changes, positive control first on an artificially
    overlapping pair that DOES diverge; and deleting it survived the whole
    suite. The example the old paragraph cited was wrong on its own terms:
    `"Issue o/r#1 ("` fails `endswith(" is already closed")` whether the guard
    is there or not, so the guard is not what refuses it.
    (`.claude/rules/assertion-design.md` "done" #5 -- an un-killable construct
    is disclosed, not counted.)

    It is KEPT, and it is not counted as coverage of the call sites. It is a
    precondition of THIS FUNCTION'S OWN CONTRACT -- `_sentence_is` takes the
    pair as parameters, so an overlapping pair is expressible even though
    neither current call site supplies one -- and that contract is now what
    `test_the_sentence_predicate_refuses_a_body_too_short_to_hold_both_ends`
    pins, with an overlapping pair that DOES diverge (arm GH33). So the "it
    survived the suite" measurement above is a statement about the head this
    was found at, not about this one: the guard is killable from here on,
    at the contract, and still an equivalent mutant at the two call sites.
    """
    return (
        len(body) >= len(prefix) + len(suffix)
        and body[:len(prefix)].casefold() == prefix.casefold()
        and body.endswith(suffix)
    )


def _has_line_break(text: str) -> bool:
    """Does `text` carry a code point `str.splitlines()` treats as a break?

    ASKED OF THE SPLITTER ITSELF rather than transcribed from its
    documentation. `str.splitlines()` honours TEN separators -- LF, CR, VT, FF,
    FS, GS, RS, NEL, LS, PS -- and a transcribed list of them is a probe that
    can disagree with the implementation it is supposed to describe, which is
    the defect `.claude/rules/assertion-design.md` "done" #3 forbids. Round 12
    reasoned about this set from memory and got the SIZE of the hazard wrong by
    a factor of ten.

    Exact, including the two cases that look like corners: a TRAILING separator
    is detected (`"a\\n"` -> `["a"]`, which rejoins to `"a"`), and the empty
    string is not (`""` -> `[]` -> `""`), which is what keeps
    `_without_title_line_breaks` from ever calling `str.replace("", ...)` --
    an empty needle matches at every position and would shred the line.
    """
    return "".join(text.splitlines()) != text


def _as_channel_would(text: str) -> str:
    """Apply the newline translation `sh()`'s pipe ALREADY applied to `err`.

    THE ROUND-13 BLOCKER, and the reason three rounds of careful parse-hardening
    walked straight past it: the defect was never in the parse, it was in the
    CHANNEL. `sh()` runs `subprocess.run(..., text=True)`, and text mode means
    UNIVERSAL NEWLINES -- Python wraps the pipe in a `TextIOWrapper` with
    `newline=None`, which translates CRLF and lone CR to LF on the way in. So by
    the time `gh`'s stderr reaches any of this code, it contains no CR at all.

    The TITLES did not come through that channel. They arrive as JSON string
    values from `--json title`, bytes intact. A title carrying a CR therefore
    cannot match its own copy inside `err` -- `err` has an LF where the title
    has a CR -- and `err.replace(title, ...)` silently does nothing. The
    neutraliser was a no-op on exactly the separator a caller is most likely to
    paste, while every test in the suite passed, because no test took `err` from
    a real capture.

    WHAT VALUE MAKES THIS FAIL: a title containing `"\\r"`. Before this
    translation it is returned unchanged and the caller's replace misses; after
    it, the CR reads as the LF the channel actually delivered. `"\\r\\n"` is
    handled first so a CRLF collapses to ONE LF rather than two.
    """
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _producer_lines(err: str) -> list[str]:
    """Split `err` the way `gh` JOINED it, not the way Python can split it.

    THIS IS THE ROUND-12 BLOCKER'S FIX, one of two halves. `gh` writes each
    record with a single trailing `\\n` (`fmt.Fprintf(..., "...\\n", ...)` at
    close.go :118 and :169) -- so `\\n` is the producer's entire separator
    alphabet. Round 12 read those records back with `str.splitlines()`, which
    honours TEN separators, and the extra nine are all reachable from the
    issue TITLE that `gh` interpolates into the record. A title carrying one
    split gh's single-line record into several, and the classifier then read a
    line whose whole content was operator-supplied -- forging the verdict in
    BOTH directions, measured 20/20 at `4ce05224585`.

    Reading with a WIDER rule than the writer wrote with is the general shape:
    the extra separators do not delimit anything the producer meant, so every
    one of them is a place the data can pretend to be structure.

    CRLF, AND THE DISCLOSURE THAT GOES WITH IT. `removesuffix("\\r")` takes off
    exactly the one CR a CRLF terminator contributes, so a CR *inside* a title
    would be an ordinary character rather than a line boundary. That is the
    right shape -- but through `sh()` it is UNREACHABLE, and saying so is the
    point. `sh()` reads the pipe in text mode, i.e. universal newlines, so
    Python has already translated every CRLF and every lone CR to LF before this
    function sees `err`; there is no CR left to strip. See `_as_channel_would`.

    So: this `removesuffix` is DEFENSIVE, not coverage. No input reachable
    through `sh()` distinguishes it from a bare `split("\\n")`, which makes it an
    equivalent mutant under any arm that feeds `err` from the real producer, and
    it is not counted toward the claim that CRLF is handled
    (`.claude/rules/assertion-design.md` "done" #5). It is kept because a future
    caller passing `newline=""`, or reading a file, or capturing bytes and
    decoding by hand, WOULD deliver a CR -- and then it is load-bearing. An arm
    that pins it must construct `err` directly and say that it does, rather than
    claiming to exercise the producer.
    """
    return [line.removesuffix("\r") for line in err.split("\n")]


def _without_title_line_breaks(err: str, *titles: str) -> str:
    """Take the TITLE's line breaks back out of `err` before anything reads it.

    THE OTHER HALF OF THE ROUND-12 BLOCKER'S FIX, and the half that covers LF
    -- the one separator `_producer_lines` cannot help with, because LF is the
    producer's own. If GitHub accepts a literal LF in an issue title, then a
    title carrying one genuinely creates a line in gh's output, indistinguishable
    by position from a line gh wrote itself. No amount of careful splitting
    recovers that; the only thing that does is knowing what the title was.

    WE DO KNOW: `_read_issue_on_github` fetches `--json state,title,url` on a
    call the closer was already making, so the titles arrive free. Each one
    that carries a break is replaced, in `err`, by ITSELF WITH THE BREAKS TURNED
    INTO SPACES -- structure removed, content and surrounding punctuation left
    exactly where `gh` put them, so the record collapses back to the single line
    it was written as.

    ONLY TITLES THAT CARRY A BREAK ARE TOUCHED, which matters more than it
    looks. An unconditional `err.replace(title, ...)` on an ordinary title like
    `"o"` would rewrite every `o` in the record and turn a true verdict into
    `UNKNOWN` -- a guard that manufactures the failure it exists to prevent.
    A title with no break needs no neutralising, so the ordinary path is
    byte-for-byte untouched.

    WHAT THIS DOES NOT ESTABLISH, said plainly rather than left implied:

    - **Whether GitHub accepts any of those ten code points in a title at all.**
      Establishing it requires WRITING an issue; that was not done, so it is not
      claimed in either direction. The fix does not rest on the answer, which is
      the point -- round 12's safety rested on an unmeasured property of an
      external service and called itself "title-proof by construction".
    - **A title CHANGED between this run's reads and gh's render.** Both titles
      this run observed are neutralised -- the pre-close read's and the
      read-back's -- so defeating it needs the title to carry a break at the
      instant `gh` rendered its record while carrying none at EITHER read. An
      earlier revision of this paragraph said that took TWO edits inside the
      close window; measured, ONE suffices, because the two titles are replaced
      against a single `err` and the ordering below is what decides whether the
      second one still matches. The count was wrong; the residual is real and is
      stated as a residual.
    """
    # TRANSLATE FIRST. `err` arrived through a universal-newlines pipe and the
    # titles did not -- see `_as_channel_would`. Comparing untranslated titles
    # against translated `err` is the round-13 blocker.
    #
    # LONGEST FIRST, and de-duplicated. The two titles are the pre-close read
    # and the read-back. If one is a SUBSTRING of the other, replacing the
    # shorter first consumes the text the longer needed to match, and the longer
    # title survives un-neutralised, leaving a break in the record.
    #
    # THIS IS A SOUNDNESS FIX, NOT A PRECISION ONE, and the history of this
    # comment is worth more than the claim. Round 12 said argument order forges
    # the verdict. Round 16 "corrected" that to "no witness exists: a search
    # over 35,000+ candidate straddles with ONE- AND TWO-BREAK titles found zero
    # forges under either ordering." Both halves of that sentence are true and
    # the conclusion is false: a witness needs THREE breaks, so the declared
    # population could not have contained one. The instrument could not have
    # produced the finding, which makes its silence worthless as evidence -- the
    # same defect as a grep whose --include excludes the answer's file type.
    #
    # The witness, reproduced 2026-09-18:
    #   T1 (pre-close read) = "A\nC"
    #   T2 (read-back)      = "A\nC\nZ Closed issue o/r#1 (q)\nB"
    #   err                 = gh's already-closed record carrying T2
    # T1 is a PREFIX of T2, so in argument order T1's replace destroys the text
    # T2 needed to match; T2 survives, its forged "Closed issue" line stands, and
    # a genuine already-closed classifies `performed`. Longest-first returns
    # `found-already-closed`. Exhaustive linear frame, 634,336 title pairs:
    # argument order 7,264 forges, longest-first 0.
    #
    # The two-break shapes the old search DID cover classify `unknown` under
    # argument order -- honest degradation, no forge. That is exactly why the
    # search came back empty, and why "empty" meant nothing.
    #
    # WHAT VALUE MAKES THE TEST FAIL: the three-break pair above. The earlier
    # two-break fixture `("x\\ny", "x\\ny\\nz")` pins the cleaned string but
    # cannot witness a forged verdict, because that shape has none to witness.
    for title in sorted({_as_channel_would(t) for t in titles}, key=len, reverse=True):
        if _has_line_break(title):
            err = err.replace(title, " ".join(title.splitlines()))
    return err


def _close_outcome(err: str, repo: str, number: int) -> str:
    """Which of the two exit-0 outcomes `gh issue close` just had.

    THE DISTINCTION THE READ-BACK CANNOT DRAW, and the reason this function
    exists. Reading the state back establishes a property of the WORLD -- the
    issue is closed -- not an effect of THIS invocation. A concurrent writer
    supplies that property for free: close.go v2.100.0 re-fetches the issue at
    :112 and, at :117-120, prints "is already closed" and `return nil`s. That
    early return sits ABOVE the comment block at :148. So when a human or a
    second lane takes the issue in the window between this tool's pre-read and
    its close, `gh` exits 0 having posted NOTHING, the read-back reads CLOSED
    because somebody else made it so, and "verified by effect" reports a close
    that this invocation did not perform and a receipt comment that does not
    exist. Measured end-to-end by a reviewer with only `tick.sh` stubbed: 0
    comments posted, `state=closed`, and the false note written permanently
    into `Item.history`.

    READ BY POSITION, NOT BY IDIOM -- and the first revision of this function
    got that wrong in the commit that fixed the race. It asked whether
    `"is already closed"` appeared ANYWHERE in stderr, tested first, over a
    sentence whose final `%s` is `issue.Title`. So a close this run GENUINELY
    PERFORMED, on an issue whose title happens to contain that phrase,
    classified `found-already-closed` and the caller then stated two things
    that were false -- "this run did NOT close it" and "NO receipt comment was
    posted" -- and `_record_close_in_ledger` wrote them permanently into
    `Item.history`. Measured end to end at `f3a2a834460` by a reviewer with a
    fake that really performs the close: ground truth 1 comment posted and
    state CLOSED, against a note asserting neither happened. R7 reached from
    the ORDINARY SUCCESS PATH, in the change whose thesis is R7.

    SWAPPING THE TWO TESTS IS NOT THE FIX -- it moves the collision onto the
    dangerous side, where an already-closed line whose title contains
    `Closed issue ` reports a close this run did not perform, which is the
    defect the round-10 arm GH23 models. Both sentences differ at a FIXED
    OFFSET, immediately after gh's icon token, so they are read there. That is
    the discipline `_object_kind_from_url` applies earlier in this module
    (`csa_loom_parse_by_position_not_by_idiom`).

    A POSITIONAL READ IS NOT TITLE-PROOF ON ITS OWN, and round 12's docstring
    claimed here that it was -- "the title is interpolated at the END of the
    line, inside `(...)`, and can never occupy the start of one". FALSE, and
    structurally rather than at the margin: the title cannot START a line gh
    wrote, but it can CREATE one, and then it starts that one. Round 12 read
    the records back with `str.splitlines()`, which honours ten separators
    against the producer's one, so any of the other nine inside a title split
    gh's single-line record into several and handed the classifier a line that
    was entirely operator-supplied. Measured at `4ce05224585`: all ten forge,
    in BOTH directions, 20 of 20, with a plain-title positive control green on
    the same path -- and end to end through the closer, a U+2028 title returned
    `#4547 closed on GitHub` over a run that closed nothing and posted no
    comment, written permanently into `Item.history`. R7 restored through the
    title field for the third round running.

    So the title is dealt with WHERE IT IS DATA rather than argued about here.
    THIS FUNCTION REQUIRES ITS CALLER TO HAVE NEUTRALISED IT: the production
    call site passes `err` through `_without_title_line_breaks` with both
    titles this run read, and `_producer_lines` below splits by the producer's
    rule rather than Python's wider one. Neither is optional, and neither is
    stated as a property of this function -- arms GH30 and GH31 delete them
    independently and the separator-set test goes red for each.

    The repo and number are interpolated into both prefixes, so the read
    additionally establishes that `gh` acted on the object this tool asked
    about, and the two prefixes (`Closed issue ` / `Issue `) discriminate
    completely at that offset -- which is why the ORDER of the two tests below
    no longer carries any meaning. The scan is PER LINE, so a warning ahead of
    the marker is tolerated.

    NO NEW `gh` CALL. `err` is already captured at the close call site and was
    being discarded on the rc=0 path; the two sentences above are the only
    signal `gh` offers, and they are free.

    WHY STDERR RATHER THAN THE ALTERNATIVES, decided rather than inherited:

    - **A pre-close state read** cannot help. That read already happens, and
      the race window is precisely BETWEEN it and the close.
    - **Reading the comments back** would answer directly, but it is a new `gh`
      call on the write path -- a new failure route added to the route the
      whole current population takes, which is the same cost this change
      declined to pay for #4579.
    - **`closedAt`** is second-granular and has no pre-value to compare against
      on an open issue, so it would trade one race for a narrower one.

    FAILS HONEST, NOT OPEN, which is the whole reason this is three-valued
    rather than two. Keying only on the already-closed sentence would mean a
    future `gh` that rewords it falls through to "I closed it" -- the false
    claim restored by a change outside this repository. So an stderr carrying
    NEITHER sentence answers `UNKNOWN`, and the caller says it does not know
    (deploy-integrity R7: an error message must not state as fact something it
    did not establish). The cost is a qualified note if `gh` ever stops writing
    to stderr at all, or reformats the line, or reports a different repo/number
    than the one asked for; that is noise the operator sees immediately, rather
    than a false statement they do not.
    """
    already = f"{_GH_ALREADY_CLOSED_PREFIX}{repo}#{number} ("
    performed = f"{_GH_PERFORMED_PREFIX}{repo}#{number} ("
    for line in _producer_lines(err):
        # DROP gh'S ICON, which is one whitespace-delimited token and the only
        # thing ahead of the marker: `cs.Yellow("!")` at :118 and
        # `cs.SuccessIconWithColor(cs.Red)` at :169, each followed by a literal
        # space in the format string.
        #
        # WHAT THIS ESTABLISHES IS THE COLOUR HALF ONLY, and the previous
        # revision of this comment concluded more than it showed -- it said
        # "the marker starts at the same offset on a TTY and under NO_COLOR
        # alike", which reads as robustness to the token's SHAPE. It is true of
        # the SGR escapes, which contain no space and so cannot move the split
        # (verified: a real coloured check-glyph line classifies `performed`).
        # It says nothing about the icon being ABSENT or differently spaced,
        # and those are not handled -- they are merely handled HONESTLY: no
        # icon at all, two spaces after the icon, a tab after it, and a
        # localised icon-plus-word prefix all answer `unknown` rather than
        # guessing, which is the third arm doing its job. Arm GH34 deletes this
        # drop entirely.
        body = line.split(" ", 1)[1] if " " in line else line
        if _sentence_is(body, performed, _GH_PERFORMED_SUFFIX):
            return CLOSE_PERFORMED
        if _sentence_is(body, already, _GH_ALREADY_CLOSED_SUFFIX):
            return CLOSE_FOUND_ALREADY_CLOSED
    return CLOSE_OUTCOME_UNKNOWN


def close_issue_on_github(
    policy: dict, repo: str, number: int, target_state: str, detail: str,
    kind: str, issue_class: str,
) -> str:
    """Close the GitHub issue for an item the ledger is about to make terminal.

    THE WRITE THAT WAS MISSING (#4545). `tick.py` read GitHub and never wrote to
    it, so a ledger close was invisible upstream and the next refresh read it as
    a reopen.

    **Only `CLOSES_ON_GITHUB` states get a close**, and the guard is here rather
    than at the call site so a future park/decline route cannot acquire one by
    forgetting. A park is meant to stay open (#4535); closing it would re-create
    the lie that issue refused.

    DISCLOSED: the only production caller passes `CLOSED`, so no input reachable
    from `--record-receipt` today makes that guard fire. It is a fail-closed
    precondition for the callers that do not exist yet, and the test that pins
    it calls this function directly and says so at its site.

    Idempotent by READING FIRST: an issue already closed is left alone entirely
    -- no second close, no second comment, no noise on an issue a human may have
    closed by hand (which is exactly how #4535 was worked around).

    THE PRICE OF THAT, DISCLOSED because the route is the COMMON one and the
    cost is invisible from here: on the already-closed path this function issues
    `gh issue view` and NOTHING ELSE, so no receipt comment is posted -- and
    `tools/drain/state.json` is untracked, which leaves the receipt existing
    solely in a local gitignored file. All 7 items the live ledger currently
    holds as `closed` are in that state. The short-circuit conflates two worlds:
    *the harness already commented here*, correct to skip, and *a human closed
    it silently*, where no comment exists and none ever will. Posting the
    receipt on this route -- read the comments, post with `gh issue comment`
    when none begins `Drain harness: receipt verified` -- is #4579 and is
    deliberately NOT done in this change: it adds two `gh` calls, hence two new
    failure routes, to the one route the entire current population takes, and
    that route's seven-shape failure behaviour was independently measured clean
    at this head. Re-deriving that matrix over a new write is its own work. What
    IS done here is that the returned note says so, rather than reporting a
    receipt whose public trace does not exist.

    Verified BY EFFECT AS FAR AS THAT IS POSSIBLE, and the qualification is
    load-bearing. The state is read back after the close, because rc=0 from a
    wrapper that did nothing is a false success this repo has already paid for;
    if the issue is not closed afterwards, this raises, because silence is not
    an option a close may take. But a read-back establishes a property of the
    WORLD, not an effect of THIS invocation -- a concurrent closer supplies
    CLOSED for free while `gh` short-circuits above its comment step. So the
    returned note is keyed on `_close_outcome`, which reads `gh`'s own sentence
    for which of the two things it did, and says it does not know when `gh`
    said neither. An earlier revision of this docstring said "Verified BY
    EFFECT, not by exit code" flatly, which over-claimed in exactly the
    direction this change exists to remove.
    """
    if target_state not in CLOSES_ON_GITHUB:
        raise IssueCloseFailedError(
            f"refusing to close #{number} on GitHub for state {target_state!r}: only "
            f"{list(CLOSES_ON_GITHUB)} close an issue. A parked item is BLOCKED, not "
            "done, and its issue is supposed to stay open (#4535)"
        )
    permitted, why = gates.action_is_permitted("close-on-receipt", policy)
    if not permitted:
        raise IssueCloseFailedError(
            f"refusing to close #{number} on GitHub: `close-on-receipt` is {why}"
        )

    try:
        before = _read_issue_on_github(repo, number)
        if before.state == "CLOSED":
            # THE NOTE SAYS WHAT DID NOT HAPPEN. "left alone" alone reads as
            # "nothing needed doing", which is true of the close and false of
            # the receipt: no comment is posted on this route, so the operator
            # would otherwise be told a receipt was recorded with no hint that
            # its only trace is a gitignored local file (#4579).
            return (
                f"#{number} was already closed on GitHub - left alone, so NO "
                "receipt comment was posted: on this route the receipt exists "
                "only in the local ledger, which is untracked (#4579)"
            )
        # THE COMMENT CLAIMS ONLY WHAT IS TRUE WHEN IT IS POSTED, because `gh`
        # posts it BEFORE it closes anything (#4545 finding 11; cli/cli
        # `pkg/cmd/issue/close/close.go` at v2.100.0 -- `CommentableRun` :158,
        # then `apiClose` :164, and a comment failure `return err`s so the close
        # is never attempted). It used to read "Closed by the drain harness on a
        # verified receipt", which on the comment-landed/close-failed path is a
        # FALSE STATEMENT sitting on a public artifact -- the R7 defect this
        # change is about, published rather than printed.
        #
        # ARGV ORDERING, DECIDED RATHER THAN INHERITED. The alternative is to
        # close first and post the receipt with a SECOND command. Rejected:
        # a second command is a second failure window, and its failure mode is
        # WORSE and PERMANENT -- a closed issue whose receipt comment never
        # landed is never repaired, because the next run reads CLOSED and
        # short-circuits above without ever reaching the comment. Silent and
        # unrepairable beats loud and duplicated in exactly the wrong
        # direction. So the single command stays, and the sentence is what got
        # fixed.
        #
        # RESIDUAL, disclosed: on the comment-landed/close-failed path a re-run
        # posts the note again, because the issue is still OPEN. VISIBLE -- the
        # ledger stays non-terminal, the operator sees GITHUB CLOSE NOT
        # CONFIRMED, and the item stays in the queue -- and every copy is a true
        # statement about a receipt rather than a false one about a close.
        #
        # NOT "BOUNDED", and an earlier revision of this comment said that word.
        # Nothing in the CODE bounds it: under a persistent close failure each
        # operator re-run adds a copy. What limits it is the call graph --
        # `--record-receipt` has no cron, no loop and no driver, its only
        # reference outside the tests being `operating_point.py`, which prints
        # the command rather than running it -- so the ceiling is operator
        # patience, not an invariant. Saying "bounded" claimed a control that
        # does not exist, which is the R7 defect this change is about, in the
        # comment explaining the change.
        #
        # TWO LANES RACING THE SAME ITEM SPLIT INTO TWO SUB-CASES, and an
        # earlier revision of this comment named only the benign one -- it said
        # they "can both pass the already-closed read above and post two
        # comments", which is the OPPOSITE of what close.go produces in the
        # sub-case that matters. If the first close FAILS, yes: both post. If
        # the first close LANDS, close.go :117 short-circuits the loser ABOVE
        # its comment block at :148, so the loser posts ZERO comments and exits
        # 0 over an issue somebody else closed. That is the outcome
        # `_close_outcome` exists to name, two lines above the citation of the
        # very function that decides it.
        rc, _out, err = sh(
            ["gh", "issue", "close", str(number), "--repo", repo,
             "--comment", _receipt_comment(kind, issue_class, detail)]
        )
        if rc != 0:
            raise IssueCloseFailedError(
                f"`gh issue close {number}` failed (rc={rc}): {err[:200]}. The ledger "
                "was NOT written and the item stays non-terminal. THE UPSTREAM STATE "
                "IS NOT ESTABLISHED BY THIS: `gh` comments first and closes second "
                "(close.go v2.100.0 - CommentableRun :158, apiClose :164), so rc!=0 "
                "is most often a close that did NOT land, with the receipt comment "
                "already posted on a still-open issue; but a close whose mutation "
                "reached the server and whose response did not reach the client "
                "exits the same way with the issue CLOSED. Re-run - the read-first "
                "short circuit settles which of the two happened. NOT CLASSIFIED AND "
                "NOT RETRIED, deliberately and as a known gap: a secondary rate "
                "limit, a 502 and a revoked token all land here identically, and "
                "the advice to re-run walks a rate limit straight back into it. "
                "Failing closed with the ledger untouched is the right default -- "
                "an unattended backoff loop against a write path is a worse first "
                "version -- but this says 're-run' without knowing whether now is "
                "a good time, and that is a limitation rather than a verdict"
            )
        # THE READ-BACK COMES FIRST so its title joins the neutralisation set.
        # The order of these two statements is not cosmetic: `_close_outcome`
        # classifies gh's prose, and the titles this run observed are what make
        # that prose safe to read. Taking BOTH -- the pre-close read's and this
        # one's -- means a title carrying a literal LF has to be present at
        # gh's render and absent at both reads to survive, rather than merely
        # absent at one of them. Neither read costs an extra call; the title is
        # one more field on a `--json` list that was already fetched.
        after = _read_issue_on_github(repo, number)
        outcome = _close_outcome(
            _without_title_line_breaks(err, before.title, after.title),
            repo, number,
        )
    except OSError as exc:
        # `gh` missing or unexecutable. Without this the record path dies on a
        # traceback from inside `subprocess`, which is loud but says nothing
        # about what the harness did or did not write.
        raise IssueCloseFailedError(
            f"cannot run `gh` to close #{number}: {exc}. Nothing was written."
        ) from exc
    if after.state != "CLOSED":
        raise IssueCloseFailedError(
            f"`gh issue close {number}` returned 0 but the issue still reads "
            f"{after.state} - reporting a close this tool cannot observe would be "
            "the defect #4545 is about, one layer down"
        )
    if outcome == CLOSE_FOUND_ALREADY_CLOSED:
        # THE RACE LANDED ON US. Somebody closed it between the pre-read and
        # this close, so `gh` short-circuited above its comment step: the issue
        # is closed, but not BY this run, and the receipt comment the argv
        # carried was never posted. Reporting "closed on GitHub" here would be
        # #4545's own defect restored through the verification -- a close
        # reported that this tool did not perform, with the sentence then
        # written permanently into `Item.history`.
        return (
            f"#{number} was ALREADY CLOSED by the time `gh` looked - this run did "
            "NOT close it and NO receipt comment was posted (`gh` short-circuits "
            "above its comment step), so the receipt exists only in the local "
            "ledger, which is untracked (#4579)"
        )
    if outcome == CLOSE_OUTCOME_UNKNOWN:
        # `gh` exited 0 and said NEITHER of its two sentences. The state is
        # settled; the authorship is not. Saying which would be asserting a
        # cause this code did not establish (deploy-integrity R7).
        #
        # AND IT NAMES THE ONE ACTION, because this branch is TERMINAL: the
        # ledger write below still runs, so the item goes `closed`, and
        # `record_receipt_from_evidence` refuses a terminal item at its top.
        # Re-running the command is therefore not a remedy, and a note that
        # says only "I do not know" from a state the tool will not re-enter
        # leaves the operator with no next step (deploy-integrity R6).
        return (
            f"#{number} is closed on GitHub, but this run CANNOT TELL whether it "
            "performed the close or found it already closed: `gh` exited 0 without "
            "either sentence it uses to say which (close.go v2.100.0 :118 / :169), "
            "so the receipt comment MAY NOT have been posted. DO THIS: read the "
            f"issue's comments (`gh issue view {number} --repo {repo} --comments`) "
            "and, if none begins `Drain harness: receipt verified`, post the "
            "receipt by hand - this tool will not re-enter the path, because the "
            "ledger write below makes the item terminal and the record route "
            "refuses a terminal item (#4579 tracks closing that gap in code)"
        )
    return f"#{number} closed on GitHub"


def _run_evidence(repo: str, run_id: str) -> dict:
    """Read ONE workflow run and its jobs, by id, from the named repository.

    `--repo` is explicit for the same reason `read_live_issues` makes it
    explicit: the repository is a policy input, not an accident of the working
    directory. Never discards stderr (deploy-integrity R7).
    """
    rc, out, err = sh(
        ["gh", "run", "view", run_id, "--repo", repo,
         "--json", "databaseId,workflowName,conclusion,status,headSha,url,jobs"]
    )
    if rc != 0:
        raise ReceiptRefusedError(
            f"cannot read run {run_id} in {repo} (rc={rc}): {err[:200]}. "
            "A run this tool cannot read is not evidence - it is an unanswered question."
        )
    try:
        return json.loads(out)
    except json.JSONDecodeError as exc:
        raise ReceiptRefusedError(f"unparseable run {run_id}: {exc}") from exc


def verify_run_backed_receipt(kind: str, run: dict, policy: dict) -> str:
    """Refuse unless this RUN establishes a receipt of this KIND. Returns the ref.

    FAILS CLOSED AT EVERY STEP, because the whole value of a receipt is that it
    was refused when it could not be taken:

    1. **The kind must be declared** in `policy.receipt_producers`. An undeclared
       kind cannot be auto-recorded at all -- `operator` is absent on purpose,
       since a human-only receipt a program can record is not human-only.
    2. **The workflow must be the declared producer**, matched on the run's own
       `workflowName`. A green run of some *other* workflow is a fact about that
       workflow, not about this item.
    3. **The run must have CONCLUDED success.** `status` is checked separately
       from `conclusion` so an in-progress run is refused as unfinished rather
       than as failed -- two different states, and rounding them together is how
       a still-running job gets read as a verdict.
    4. **Where the kind declares required STEPS, every one of them must itself
       have concluded success.** This is `receipts.g1_assertion_rule` in code,
       and it applies to EVERY run-backed kind rather than to one of them: the
       first version wired it to `g1-browser` alone, which closed the defect at
       its label and left it open at two other sites. Measured on real history
       -- 2 of the last 25 successful `loom-roll-and-validate` runs carry
       `Roll image + validate live URL` = skipped with steps=0, and
       `cloud-parity.md` names that shape exactly: a green run whose deploy job
       was skipped at 0 steps is not a receipt. A skipped JOB reports no steps,
       so requiring a step INSIDE it catches the skipped-job case and the
       skipped-step case through one mechanism.

       A kind with NO declared steps is REFUSED rather than waved through. An
       empty requirement would mean "any green run of this workflow will do",
       which is the run-level check this whole branch exists to replace.
    """
    producers = policy.get("receipt_producers", {})
    expected = producers.get(kind)
    if not expected:
        raise ReceiptRefusedError(
            f"receipt kind {kind!r} has no declared producer in policy.receipt_producers, "
            "so it cannot be recorded from a run. Take it deliberately, or declare a "
            "producer in policy.json after taking one from that workflow by hand."
        )

    actual = run.get("workflowName")
    if actual != expected:
        raise ReceiptRefusedError(
            f"run is from workflow {actual!r}, but {kind!r} is only produced by "
            f"{expected!r} - a green run of a different workflow says nothing about this item"
        )

    if run.get("status") != "completed":
        raise ReceiptRefusedError(
            f"run has status {run.get('status')!r} - it has not finished, so it is "
            "not yet a verdict either way"
        )
    if run.get("conclusion") != "success":
        raise ReceiptRefusedError(
            f"run concluded {run.get('conclusion')!r}, not success"
        )

    required_steps = (policy.get("receipt_required_steps", {}) or {}).get(kind)
    if not required_steps:
        raise ReceiptRefusedError(
            f"receipt kind {kind!r} declares no required steps in "
            "policy.receipt_required_steps, so a green run of its producer could be "
            "green over nothing - refusing rather than accepting a run-level check"
        )

    by_name: dict[str, list[dict]] = {}
    for job in (run.get("jobs") or []):
        for step in (job.get("steps") or []):
            by_name.setdefault(str(step.get("name")), []).append(step)

    for required in required_steps:
        found = by_name.get(required) or []
        if not found:
            raise ReceiptRefusedError(
                f"the run never ran the step {required!r}, which is part of what "
                f"actually establishes a {kind} receipt - a green run without it did "
                "not do the work (a SKIPPED job reports no steps at all)"
            )
        bad = [s for s in found if s.get("conclusion") != "success"]
        if bad:
            raise ReceiptRefusedError(
                f"the step {required!r} concluded "
                f"{bad[0].get('conclusion')!r}, not success"
            )

    sha = run.get("headSha")
    ref = str(run.get("url") or run.get("databaseId"))
    return f"{ref} (headSha {sha})" if sha else ref


def _pr_references_item(repo: str, pr_number: int, item: int) -> None:
    """Refuse unless PR #pr_number actually NAMES this item. Raises or returns None.

    THE BINDING CHECK, and the first version of this feature did not have one:
    it disclosed "this does not verify the evidence is ABOUT the item" and left
    it there. A reviewer showed that disclosure was OVERSTATED for the `--from-pr`
    path by closing an EPIC on a PR that references it nowhere -- so the
    limitation was real but the remedy was cheap and already in the package.

    Both surfaces are read, because neither alone is an oracle:

    - `closingIssuesReferences` is the API's own view, and it is NOT complete --
      it has read empty while a squash commit closed an issue, which is why
      `merge_gate` reports it BESIDE its own scan rather than trusting it.
    - `gates.referenced_issues` scans the body and the commit trail and is
      verb-agnostic, so it sees `Refs #N` -- which is how nearly every PR in
      this repo names the item it is work on, and which carries no closing verb.

    This is WEAKER than `Item.pr` (#4489) and is not a substitute for it: a PR
    that references an item is not necessarily that item's lane. It is strictly
    better than nothing, which is what was here before.
    """
    pr = gh_json_local(
        ["gh", "pr", "view", str(pr_number), "--repo", repo,
         "--json", "body,commits,closingIssuesReferences"],
        f"PR #{pr_number} references",
    )
    closing = [i["number"] for i in (pr.get("closingIssuesReferences") or [])]
    messages = [
        (c.get("messageHeadline", "") + "\n" + c.get("messageBody", ""))
        for c in (pr.get("commits") or [])
    ]
    mentioned = gates.referenced_issues(pr.get("body") or "", messages, repo)
    if item not in set(closing) | set(mentioned):
        raise ReceiptRefusedError(
            f"PR #{pr_number} does not reference #{item} anywhere - not in "
            f"closingIssuesReferences {closing}, not in its body, not in its commit "
            "trail. A receipt measured from a PR that never names the item is a "
            "receipt about a different piece of work."
        )


def gh_json_local(args: list[str], what: str) -> dict:
    """`sh` + JSON, kept here so this module does not depend on merge_gate for it."""
    rc, out, err = sh(args)
    if rc != 0:
        raise ReceiptRefusedError(f"cannot read {what} (rc={rc}): {err[:200]}")
    try:
        parsed = json.loads(out)
    except json.JSONDecodeError as exc:
        raise ReceiptRefusedError(f"unparseable {what}: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ReceiptRefusedError(f"unexpected shape for {what}")
    return parsed


def _record_close_in_ledger(
    led: Ledger, item, number: int, kind: str, ref: str, why: str
) -> None:
    """Attach the receipt and move the item to `closed`, or leave it untouched.

    DISCLOSED AS UN-KILLABLE, per assertion-design.md #5, because a reviewer
    spent a round confirming it and the next reader should not have to: in the
    CURRENT call graph nothing can reach this `except`. `transition` refuses on
    a class/kind mismatch, and the kind is DERIVED from that same class in the
    caller, so the two always agree. There is no input that makes this branch
    run, and no test here pretends otherwise.

    It is kept because the invariant it protects is real and the call graph is
    not a guarantee: `record_receipt` sets three fields AND appends a history
    line before `transition` can refuse, so any future caller that stamps a
    class separately -- or any change that lets `transition` refuse for a new
    reason -- lands on an item carrying a receipt it was refused on.

    THE HISTORY LINE IS PART OF THE RESTORE. A reviewer pointed out that
    clearing the three fields alone leaves the audit record asserting a receipt
    that does not exist, which is worse than keeping or dropping both: the
    fields would say no receipt and the history would say there was one.

    WHAT AN UNREACHABLE-TODAY FAILURE HERE WOULD LEAVE, now that the GitHub
    close runs FIRST: an issue closed upstream and an item still non-terminal
    here. That is the recoverable half of the pair -- the next refresh sees the
    item gone from the live set and flags it `departed`/`needs-audit` (loudly,
    with NO receipt, because nothing was written: the rollback below restores
    the three fields and `main()` never saves). The UPSTREAM EVIDENCE is
    untouched and the receipt is re-takeable, which is the property that
    matters -- `--record-receipt` re-measures it from the PR or the run and
    succeeds, because `needs-audit` is not terminal. Measured by a reviewer:
    `state=needs-audit reason=departed receipt=None`, then a re-run gives
    rc=0, `state=closed`, and one comment. The other ordering has no such half:
    it is #4545 itself.
    """
    before = (item.receipt_kind, item.receipt_ref, item.receipt_taken_under)
    history_len = len(item.history)
    led.record_receipt(number, kind, ref)
    try:
        led.transition(number, CLOSED, why)
    except Exception:
        (item.receipt_kind, item.receipt_ref, item.receipt_taken_under) = before
        del item.history[history_len:]
        raise


class Recorded(NamedTuple):
    """What a successful record produced, with the two HALVES kept apart.

    `summary` is the whole-operation line -- "#N closed on a <kind> receipt ...
    (<close_note>)" -- and `close_note` is the UPSTREAM half alone, either
    "#N closed on GitHub" or the already-closed note, which says both that the
    issue was left alone AND that no receipt comment was posted on it (#4579).

    They are separate because `main()`'s save-failure arm needs the upstream
    half and only the upstream half. It used to interpolate `summary` under the
    label "The upstream side is settled", and `summary` leads with the LEDGER
    close -- which on that exact path is the half that did NOT persist. In a
    change whose thesis is that every message says which of the two records
    moved, that was the one message with the label backwards. Returning the
    halves separately makes the wrong one unreachable rather than merely
    discouraged.
    """

    summary: str
    close_note: str


def record_receipt_from_evidence(
    led: Ledger, policy: dict, repo: str, number: int,
    *, from_pr: int | None, from_run: str | None,
) -> Recorded:
    """Record a receipt this tool has MEASURED, close the issue, close the item.

    THE CLOSE IS ONE TRANSACTION ACROSS BOTH RECORDS (#4545). Before this, the
    ledger close never reached GitHub, so the next refresh read the harness's
    own close as a REOPEN and voided the receipt -- every self-closed item
    un-closed itself one cycle later. The ordering is asymmetric and is argued
    at the call site below; the short form is that the GitHub close goes first,
    because the half-completed pair the other way round IS the defect.

    THE KIND IS DERIVED FROM THE ITEM'S CLASS, never supplied by the caller.
    That is the load-bearing choice here. A `--kind` flag would let a
    `ui-surface` item close on a `ci-green`, which is the exact defect a
    reviewer reproduced by editing one line of `LANE_RECEIPT_CLASS` -- and the
    R2 invariant catches a class that MOVED, not a caller who named the wrong
    one up front.

    `ci-green` is RE-MEASURED here rather than trusted, and since #4676 it is
    literally the SAME CALL the report makes: `merge_gate.collect_ci_green_evidence`
    then `merge_gate.receipt_from_evidence`, which is the one place
    `gates.ci_green_receipt` is invoked outside the tests. It used to be "the
    same two calls" -- two hand-maintained argument lists that happened to
    agree, so "this path cannot record a receipt the report would not print"
    was a hope rather than a property. One shared call site makes it the
    property, and `test_the_receipt_call_has_exactly_one_non_test_site` keeps
    it at one. Everything else is run-backed and goes through
    `verify_run_backed_receipt`.

    This is deliberately NOT "record whatever the operator says". `tick.py`'s
    own refresh comment already names the failure mode -- inventing a receipt to
    get past the receipt gate is the gate defeating itself -- and the difference
    between that and this is that every fact recorded here was read back from
    GitHub by this function.

    WHAT THIS DOES AND DOES NOT ESTABLISH about the BINDING -- that the evidence
    is ABOUT this item -- stated precisely, because the first version of this
    docstring overstated the gap and a reviewer proved it by closing an EPIC on
    a PR that references it nowhere:

    - `--from-pr` IS bound: `_pr_references_item` refuses unless the PR names
      the item in `closingIssuesReferences`, its body, or its commit trail.
      Weaker than `Item.pr` (#4489) -- a PR that references an item is not
      necessarily that item's lane -- but no longer absent.
    - `--from-run` is NOT bound, and cannot be from here: a workflow run carries
      no issue reference at all. Nothing stops a green roll being recorded
      against a second deploy-path item it never touched. `Item.pr` (#4489)
      now records which PR a lane opened, but this path does not consult it.
    """
    item = led.items.get(number)
    if item is None:
        raise ReceiptRefusedError(f"#{number} is not in the ledger")
    if item.state in TERMINAL:
        raise ReceiptRefusedError(
            f"#{number} is already {item.state} - re-recording would rewrite a "
            "terminal item's evidence"
        )

    issue_class = item.effective_receipt_class
    kind = (policy.get("receipts", {}) or {}).get(issue_class)
    if not kind:
        raise ReceiptRefusedError(
            f"#{number} resolves to class {issue_class!r}, which names no receipt kind"
        )

    if kind == "ci-green":
        if from_pr is None:
            raise ReceiptRefusedError(
                f"#{number} is {issue_class!r} and needs a ci-green receipt, which is "
                "measured from a MERGED PR - pass --from-pr"
            )
        import merge_gate  # local: only this path needs it, and it imports gates

        _pr_references_item(repo, from_pr, number)
        data = merge_gate.collect_ci_green_evidence(repo, from_pr)
        # THE SAME CALL `--ci-green-receipt` MAKES, not a second copy of it.
        # The README's claim for this path is that it "cannot record a receipt
        # `--ci-green-receipt` would not print"; two hand-maintained argument
        # lists made that a hope. #4676's `declared_at` was the ninth argument.
        receipt = merge_gate.receipt_from_evidence(data, policy)
        if not receipt.ok:
            raise ReceiptRefusedError(
                f"ci-green receipt for PR #{from_pr} is {receipt.summary}; "
                + "; ".join(receipt.reasons)[:400]
            )
        ref = data["merged"]
        detail = f"{receipt.summary} at {ref} (PR #{from_pr})"
    else:
        if not from_run:
            raise ReceiptRefusedError(
                f"#{number} is {issue_class!r} and needs a {kind} receipt, which is "
                "established by a workflow run - pass --from-run"
            )
        run = _run_evidence(repo, from_run)
        ref = verify_run_backed_receipt(kind, run, policy)
        detail = f"{run.get('workflowName')} run {from_run} concluded success"

    # THE GITHUB CLOSE RUNS FIRST, AND THE ORDER IS THE FIX (#4545).
    #
    # The two writes can fail independently, and the two orderings are NOT
    # symmetric, so this is stated rather than chosen silently:
    #
    # - **GitHub, then the ledger** (this one). If the ledger write fails, the
    #   issue is closed upstream and the item is still non-terminal here. The
    #   next refresh sees it gone from the live set, flags it `departed` ->
    #   `needs-audit` -- loudly, non-terminal, and holding NO receipt, because
    #   nothing was written -- and `--record-receipt` can simply be re-run,
    #   because it refuses only on a TERMINAL item. The upstream EVIDENCE is
    #   untouched, so the receipt is re-takeable. Recoverable, and visible
    #   while it is not.
    # - **The ledger, then GitHub.** If the GitHub write fails, the item is
    #   `closed` here and open there, which is EXACTLY #4545: the next refresh
    #   reads it as a reopen, demotes it, and VOIDS the receipt that was just
    #   verified. The half-completed pair is indistinguishable from the bug this
    #   change exists to remove, so that ordering is not available.
    #
    # The close raises rather than returning a flag, so the ledger write below
    # is unreachable unless the issue is observably closed on GitHub.
    close_note = close_issue_on_github(
        policy, repo, number, CLOSED, detail, kind, issue_class)
    # EVERY FAILURE FROM HERE ON IS A POST-CLOSE FAILURE, and it is wrapped so
    # it cannot be reported as a refusal. `_record_close_in_ledger` restores the
    # item, so the in-memory ledger is untouched and `main()` saves nothing --
    # but the ISSUE IS CLOSED, and a message that says "nothing recorded"
    # without saying that is false in the half that matters (R7).
    #
    # This wrap is also what makes the `ValueError` arm in `main()` honest: with
    # it in place, a bare ValueError can only escape from BEFORE the close.
    try:
        _record_close_in_ledger(
            led, item, number, kind, ref, f"receipt verified by tick: {detail}; {close_note}"
        )
    except Exception as exc:
        raise LedgerWriteAfterCloseError(
            f"#{number}: {close_note}, and the ledger write that should have "
            f"followed failed: {exc}. The issue is closed UPSTREAM and this item "
            "is NOT terminal here; nothing was saved. Re-run the same command - "
            "the closer reads the issue state first, sees CLOSED and "
            "short-circuits, so there is no second close and no second comment."
        ) from exc
    return Recorded(
        summary=f"#{number} closed on a {kind} receipt - {detail} ({close_note})",
        close_note=close_note,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--status", action="store_true", help="report, change nothing")
    parser.add_argument(
        "--bootstrap", action="store_true",
        help="discard the ledger and reseed from live GitHub",
    )
    parser.add_argument(
        "--reap", action="store_true",
        help="return in-flight items to ready before selecting",
    )
    parser.add_argument(
        "--allow-shrink", action="store_true",
        help="suppress the RETENTION clause only; the wrong-repo and zero-issue "
             "refusals still apply",
    )
    parser.add_argument(
        "--bind-pr", type=int, metavar="ITEM",
        help="record that a lane opened a PR for this item (needs --pr) and move "
             "it in-flight -> in-review, so the reaper stops taking it back",
    )
    parser.add_argument(
        "--pr", type=int, metavar="PR",
        help="for --bind-pr: the PR the lane opened for that item",
    )
    parser.add_argument(
        "--record-receipt", type=int, metavar="ITEM",
        help="verify a receipt for this item from the evidence below and CLOSE it",
    )
    parser.add_argument(
        "--from-pr", type=int, metavar="PR",
        help="for a ci-green item: the MERGED PR to re-measure the receipt from",
    )
    parser.add_argument(
        "--from-run", metavar="RUN_ID",
        help="for a run-backed item: the workflow run that establishes the receipt",
    )
    parser.add_argument(
        "--park", type=int, metavar="ITEM",
        help="record this item as PARKED - genuinely blocked (needs --blocker AND "
             "--owner; refused without both). Does NOT close the GitHub issue: a "
             "park is blocked, not done, and its issue is supposed to stay open",
    )
    parser.add_argument(
        "--blocker", metavar="TEXT",
        help="for --park: WHAT is blocking it",
    )
    parser.add_argument(
        "--owner", metavar="WHO",
        help="for --park: WHO owns clearing the blocker",
    )
    parser.add_argument(
        "--decline", type=int, metavar="ITEM",
        help="record this item as DECLINED - will not do (needs --decision). Does "
             "NOT close the GitHub issue; a decline's disposal is `gh issue close "
             "--reason not-planned`, by hand, on a judgement no program made",
    )
    parser.add_argument(
        "--decision", metavar="TEXT",
        help="for --decline: WHO decided and on what grounds",
    )
    args = parser.parse_args()

    # ONE WRITE VERB PER INVOCATION, CHECKED OVER THE WHOLE SET.
    #
    # This replaces the pairwise `--bind-pr` / `--record-receipt` check that used
    # to sit inside the bind branch, and the generalisation is the point: that
    # check was written when there were two write verbs, and adding a third and a
    # fourth to it pairwise is three more comparisons nobody would remember to
    # make. The failure it exists to stop is the one that check named -- two
    # transactions passed, one silently dropped, no hint to the operator.
    write_verbs = [
        ("--bind-pr", args.bind_pr),
        ("--record-receipt", args.record_receipt),
        ("--park", args.park),
        ("--decline", args.decline),
    ]
    named = [flag for flag, value in write_verbs if value is not None]
    if len(named) > 1:
        print(f"{' and '.join(named)} are separate transactions; pass one at a time",
              file=sys.stderr)
        return 2
    # A VALUE WITH NO VERB IS DROPPED SILENTLY OTHERWISE, which is the same defect
    # one level down: `--park 5 --decision x` would park the item and discard the
    # decision without a word.
    for value, flag, verb, verb_value in (
        (args.blocker, "--blocker", "--park", args.park),
        (args.owner, "--owner", "--park", args.park),
        (args.decision, "--decision", "--decline", args.decline),
        (args.pr, "--pr", "--bind-pr", args.bind_pr),
    ):
        if value is not None and verb_value is None:
            print(f"{flag} is only read by {verb}, which was not passed - refusing "
                  "rather than dropping it silently", file=sys.stderr)
            return 2

    policy = gates.load_policy(POLICY_PATH)
    repo = policy["repo"]
    led = Ledger(STATE_PATH, receipts=policy["receipts"])
    if not args.bootstrap:
        led.load()

    # `inventory.json` is an OPTIONAL cache, never a dependency. It is
    # gitignored, so requiring it meant a clean checkout filed every issue into
    # `W9-rest` and silently collapsed the execution order the PRP calls
    # load-bearing -- with no error, because "no pins" and "no file" looked the
    # same. `refresh_from_github` falls through to `stream_for()`, which derives
    # the stream from the issue's own labels and title.
    streams: dict = {}
    inv = os.path.join(HERE, "inventory.json")
    if os.path.exists(inv):
        with open(inv, encoding="utf-8") as handle:
            for stream, rows in json.load(handle).items():
                for row in rows:
                    streams[row["n"]] = stream

    if args.status:
        # An absent ledger is the ABSENCE of a measurement. Reporting its counts
        # would print `total: 0, drained: true` -- and `drained: true` is this
        # program's documented exit condition, so a wiped scratch file would end
        # the run with 297 issues open.
        if not led.loaded_from_disk:
            print(
                f"NO LEDGER at {STATE_PATH}. This is not an empty queue, it is no queue: "
                "the drain has not been seeded, or the file was deleted.\n"
                "Seed it with:  python tools/drain/tick.py --bootstrap",
                file=sys.stderr,
            )
            return 2
        print(json.dumps(led.counts(), indent=1))
        print("drained:", led.drained())
        return 0

    if args.bind_pr is not None:
        # RETURNS BEFORE `read_live_issues`, for the same reason
        # `--record-receipt` does: this is a transaction about ONE item, and a
        # refresh rewrites every item's state.
        if not led.loaded_from_disk:
            print(
                f"NO LEDGER at {STATE_PATH} - nothing to bind against. "
                "Seed it with:  python tools/drain/tick.py --bootstrap",
                file=sys.stderr,
            )
            return 2
        if args.pr is None:
            print("--bind-pr needs --pr <PR>", file=sys.stderr)
            return 2
        # BOUNDED RETRY, because contention here is routine rather than
        # exceptional. An ordinary tick holds its read across a full refresh of
        # some four hundred issues, and this bind holds one across a pair of
        # GitHub reads, so the two overlap often with four lanes live. Losing
        # the CAS and exiting would
        # leave the item unbound and reaped next cycle -- the original defect,
        # recurring under exactly the concurrency the design exists to survive.
        #
        # Safe by construction: a re-bind of the SAME pr is idempotent (pinned
        # by `test_bind_is_idempotent_for_the_same_pr`), and each attempt
        # RE-READS the ledger, so a retry cannot double-write or resurrect a
        # state another writer has since changed. A different-PR bind still
        # refuses on the re-read, which is the behaviour we want to keep.
        attempts = 3
        for attempt in range(1, attempts + 1):
            if attempt > 1:
                # BACKOFF WITH JITTER, not an immediate retry. A reviewer noted
                # the first version fired all three attempts back to back,
                # separated only by two GitHub reads -- against a rival window
                # measured in tens of seconds that is three losses, not three
                # chances, and two lanes retrying in lockstep can livelock.
                # Jitter breaks the lockstep; the growing term gives the rival
                # time to finish.
                time.sleep(random.uniform(0.5, 1.5) * attempt)
                led = Ledger(STATE_PATH, receipts=policy["receipts"]).load()
            try:
                said = bind_pr_for_item(led, repo, args.bind_pr, args.pr)
            except PrBindRefusedError as exc:
                print(f"BIND REFUSED - NOTHING WRITTEN: {exc}", file=sys.stderr)
                return 1
            try:
                _save_refusing_lost_update(led)
            except LedgerChangedError as exc:
                if attempt < attempts:
                    print(
                        f"ledger changed under this bind (attempt {attempt}/{attempts}) "
                        "- re-reading and retrying",
                        file=sys.stderr,
                    )
                    continue
                print(
                    f"LEDGER CHANGED UNDER THIS BIND - NOTHING WRITTEN: {exc}\n"
                    f"  Lost the CAS {attempts} times; another writer is very "
                    "busy. Re-run it; the bind re-reads and a same-PR re-bind "
                    "is a no-op.",
                    file=sys.stderr,
                )
                return 1
            print(said)
            return 0
        # UNREACHABLE while `attempts` is a positive literal -- every path in
        # the loop returns. Present because every other branch of `main()`
        # returns explicitly, and without it a restructure (or `attempts = 0`)
        # would fall through past the record-receipt branch into the NORMAL TICK
        # PATH: refresh, reap, select, save, for a command invoked as
        # `--bind-pr`. Fail closed instead.
        return 1

    if args.record_receipt is not None:
        # RETURNS BEFORE `read_live_issues`, deliberately. Recording a receipt is
        # a transaction about ONE item; a refresh rewrites every item's state and
        # can move things to `needs-audit`. Bolting the two together would mean a
        # receipt could not be recorded without also accepting whatever the
        # refresh decided that minute -- and the refresh is the operation this
        # package already has a memory about erasing a queue.
        if not led.loaded_from_disk:
            print(
                f"NO LEDGER at {STATE_PATH} - nothing to record against. "
                "Seed it with:  python tools/drain/tick.py --bootstrap",
                file=sys.stderr,
            )
            return 2
        try:
            recorded = record_receipt_from_evidence(
                led, policy, repo, args.record_receipt,
                from_pr=args.from_pr, from_run=args.from_run,
            )
        except IssueCloseFailedError as exc:
            # A DIFFERENT DIAGNOSIS FROM A REFUSAL, and it gets a different
            # word (R7). The receipt may have been sound; the WRITE failed.
            #
            # `NOT CONFIRMED`, NOT `DID NOT COMPLETE`, and the difference is a
            # real false claim a reviewer measured: with `gh issue close`
            # returning 0 and the read-back hitting a 502, the close LANDED --
            # so a headline saying it did not complete is as false as the
            # "still open" claim the body is careful not to make. The body says
            # the tool does not know; the headline now says the same thing.
            #
            # What IS established either way is the ledger side: nothing was
            # written, the item is non-terminal.
            print(
                f"GITHUB CLOSE NOT CONFIRMED - NOTHING WRITTEN TO THE LEDGER: {exc}\n"
                "  Re-running is safe: the closer reads the issue state first and "
                "short-circuits if it is already closed.",
                file=sys.stderr,
            )
            return 1
        except LedgerWriteAfterCloseError as exc:
            # THE REVERSE PATH. The message the item's operator needs is the
            # state of the world, and the world is asymmetric here: GitHub took
            # the write, the ledger did not.
            print(f"LEDGER NOT WRITTEN - THE ISSUE IS CLOSED UPSTREAM: {exc}\n"
                  "  Nothing was saved, so the ledger file is byte-identical.",
                  file=sys.stderr)
            return 1
        except (ReceiptRefusedError, ValueError) as exc:
            # ValueError is the ledger's own R2 refusal from `transition`. It is
            # caught here so a refusal prints as a refusal rather than a
            # traceback.
            #
            # "BEFORE THE GITHUB WRITE" IS NOW STRUCTURAL, not a hope: every
            # failure after the close is wrapped in `LedgerWriteAfterCloseError`
            # by `record_receipt_from_evidence`, so anything reaching this arm
            # happened while both records were still untouched. That is what
            # makes the words "nothing was written" true here -- they were
            # printed over a landed GitHub close before a reviewer caught it.
            #
            # THE CLAIM IS TRUE WHERE IT IS MADE AND NOT BEYOND IT: it covers
            # the CALL, not `main()`'s save step below, which is its own arm for
            # exactly that reason.
            print(
                f"RECEIPT REFUSED - NOTHING WRITTEN, ON GITHUB OR IN THE LEDGER: {exc}",
                file=sys.stderr,
            )
            return 1
        try:
            # if_unchanged: refuse a LOST UPDATE rather than discard a
            # concurrent lane's close. Reproduced before this existed -- two
            # overlapping records, and the loser's item silently reverted to
            # `ready` with its receipt gone.
            led.save(if_unchanged=True)
        except Exception as exc:  # the WIDTH is the point, see below
            # BOUND TO `Exception`, NOT TO `LedgerChangedError`, and the width
            # is the fix rather than sloppiness.
            #
            # CORRECTION (round 7, and the original justification is left in
            # view rather than edited away). Rounds 1-6 of this comment, plus
            # five other sites and the PR body, said the narrow bound let
            # `PermissionError` escape `main()` "with an EMPTY stderr". That is
            # FALSE, and it was an artifact of measuring through pytest's
            # `capsys`: the module tail is `raise SystemExit(main())`, so an
            # exception that escapes `main()` escapes to the interpreter, which
            # prints a traceback. Measured as a REAL PROCESS in a sandbox copy
            # carrying arm GH12, `os.replace` raising `PermissionError`:
            # **exit 1, ~650 bytes of traceback** naming `led.save(if_unchanged=
            # True)` and `os.replace` in `ledger.py`. Positive control, same
            # driver against the unmutated source: exit 1, ~520 bytes of the
            # intended `LEDGER NOT WRITTEN - THE ISSUE IS CLOSED UPSTREAM`.
            # THE BYTE TOTALS ARE ENVIRONMENT-DEPENDENT, not constants: they
            # move with sandbox PATH LENGTH (the traceback quotes absolute
            # paths) and with the run id in the message. An independent
            # reviewer re-ran the same measurement on a different sandbox and
            # got 647 / 579. What is invariant, and what the argument rests on,
            # is the pair below: **exit 1 either way**, and a traceback about a
            # file rename versus the intended sentence.
            #
            # THE REAL REASON FOR THE WIDTH is what those two outputs differ
            # ON, not silence. Under the narrow bound the operator gets a
            # traceback about a FILE RENAME that never mentions the issue being
            # closed upstream, and the exit code is 1 either way -- so neither
            # the status nor the text tells them the two records now disagree.
            # That is #4545 with extra steps, inside the change whose purpose is
            # to make that state legible. The asymmetry that allowed it: the
            # wrap inside `record_receipt_from_evidence` catches `Exception` and
            # this did not, so a failure one line later had a different fate
            # than the same failure one line earlier.
            #
            # THE STATE CLAIM HOLDS FOR ANY EXCEPTION FROM `save()`, which is
            # what licenses the width (R7): the write is a temp file plus an
            # `os.replace`, so either the replace happened -- and nothing after
            # it can raise -- or the file on disk is untouched. "LEDGER NOT
            # WRITTEN" is therefore true whatever came out.
            #
            # ESTABLISHED BY MEASUREMENT, NOT BY CONSTRUCTION, and the
            # difference is tracked in **#4559**. A reviewer lifted the source
            # at runtime (exactly one statement follows `os.replace`; `blob` is
            # already-materialised bytes; `hashlib.sha256` is bound at import;
            # `Ledger` is non-slotted so the bind cannot dispatch into user
            # code) and injected failures at `makedirs`, `mkstemp`, `fsync` and
            # `replace` -- each left the target byte-identical. That is a
            # measurement of TODAY'S `ledger.save()`, which lives in another
            # module this diff does not touch, so the invariant asserted here
            # is not enforced where it is implemented. #4559 carries the
            # structural version: COMPUTE the digest before the replace and
            # BIND it after. Binding before is the wrong shape -- a failed
            # replace would leave the object holding a digest for bytes that
            # never landed, and every later guarded save would refuse itself.
            #
            # THE CAUSE IS NOT GUESSED. The exception's TYPE is printed, so a
            # lost CAS (`LedgerChangedError`, the expected one with four lanes
            # live) and a filesystem failure are distinguishable by the reader
            # rather than flattened into one story this code cannot tell apart.
            print(f"LEDGER NOT WRITTEN - THE ISSUE IS CLOSED UPSTREAM: "
                  f"{type(exc).__name__}: {exc}\n"
                  f"  The upstream side is settled - {recorded.close_note} - and "
                  "only the ledger write did not happen, so the two records "
                  "disagree until this is re-run. RE-RUN THE SAME COMMAND: the "
                  "closer reads the issue state first, sees CLOSED and "
                  "short-circuits - no second close, no second comment - and the "
                  "ledger then records the receipt.\n"
                  f"  The receipt that did not persist: {recorded.summary}",
                  file=sys.stderr)
            return 1
        print(recorded.summary)
        return 0

    if args.park is not None or args.decline is not None:
        # RETURNS BEFORE `read_live_issues`, for the reason the two branches
        # above do: a disposition is a transaction about ONE item, and a refresh
        # rewrites every item's state. It matters more here than anywhere -- the
        # refresh is the operation that DEMOTES a declined item, so bolting the
        # two together would let a `--decline` be undone by the same command that
        # recorded it.
        if not led.loaded_from_disk:
            print(
                f"NO LEDGER at {STATE_PATH} - nothing to dispose. "
                "Seed it with:  python tools/drain/tick.py --bootstrap",
                file=sys.stderr,
            )
            return 2
        try:
            if args.park is not None:
                said = park_item(led, policy, repo, args.park, args.blocker, args.owner)
            else:
                said = decline_item(led, policy, repo, args.decline, args.decision)
        except DispositionRefusedError as exc:
            # THE STRONG CLAIM, and it is structural: every check that raises
            # this runs before `_dispose` posts, so no comment exists.
            print(
                f"DISPOSITION REFUSED - NOTHING WRITTEN, ON GITHUB OR IN THE LEDGER: {exc}",
                file=sys.stderr,
            )
            return 1
        except DispositionCommentFailedError as exc:
            # A DIFFERENT DIAGNOSIS AND A DIFFERENT WORD (R7). The disposition
            # may have been perfectly well-formed and the WRITE failed. "NOT
            # CONFIRMED" rather than "not posted", because `gh` exiting non-zero
            # over a mutation that reached the server looks identical to one that
            # never left. The ledger half IS established: untouched.
            print(
                f"COMMENT NOT CONFIRMED - NOTHING WRITTEN TO THE LEDGER: {exc}",
                file=sys.stderr,
            )
            return 1
        except LedgerWriteAfterCommentError as exc:
            print(f"LEDGER NOT WRITTEN - THE COMMENT IS ON THE ISSUE: {exc}",
                  file=sys.stderr)
            return 1
        try:
            # if_unchanged, and NO RETRY LOOP -- unlike `--bind-pr`, which
            # retries three times. The difference is that a retry here would
            # re-enter `_dispose` and POST A SECOND COMMENT on every attempt, so
            # the thing that makes a bind safe to retry (a same-PR re-bind is a
            # no-op) has no analogue. Losing the CAS costs one re-run by the
            # operator and one duplicate comment; retrying would cost three.
            _save_refusing_lost_update(led)
        except Exception as exc:
            # BOUND TO `Exception` for the reason the record path's twin is: the
            # STATE CLAIM holds for any exception out of `save()` -- the write is
            # a temp file plus an `os.replace`, so either the replace landed and
            # nothing after it can raise, or the file on disk is untouched -- and
            # under a narrow bound the operator would get a traceback about a file
            # rename that never mentions the comment now sitting on a public
            # issue. The exception TYPE is printed so a lost CAS (the expected
            # one, with four lanes live) is distinguishable from a filesystem
            # failure rather than flattened into one story.
            print(f"LEDGER NOT WRITTEN - THE COMMENT IS ON THE ISSUE: "
                  f"{type(exc).__name__}: {exc}\n"
                  f"  The upstream side is settled - {said} - and only the ledger "
                  "write did not happen, so the item is STILL IN THE QUEUE and "
                  "will be re-selected. RE-RUN THE SAME COMMAND: its only cost is "
                  "a duplicate comment, and nothing is terminal until a write "
                  "follows one of them.",
                  file=sys.stderr)
            return 1
        print(said)
        return 0

    live = read_live_issues(repo)
    guard_refresh(led, live, allow_shrink=args.allow_shrink)
    if args.bootstrap and os.path.exists(STATE_PATH):
        # Back it up first. The ledger is the ONLY record of what has already
        # been verified -- GitHub carries which issues are open, never which
        # were receipted -- and `.gitignore` says so in as many words.
        backup = STATE_PATH + ".bak"
        shutil.copy2(STATE_PATH, backup)
        print(f"BOOTSTRAP: prior ledger copied to {backup}")
    if args.bootstrap:
        print(f"BOOTSTRAP: discarding any prior ledger, seeding from {repo}")

    reaped = reap_stranded(led, led.cycle) if args.reap else 0
    added, departed = refresh_from_github(led, streams, live)
    led.cycle += 1
    chosen = select_cycle(led, policy)
    for item in chosen:
        led.transition(item.number, IN_FLIGHT, f"selected in cycle {led.cycle}")

    # GUARDED ON THE REFRESH PATH TOO, and it has to be: CAS on the record side
    # alone protects nothing if the REFRESH is the writer doing the clobbering.
    # A cycle that loaded before a lane recorded a receipt would write a
    # document in which that receipt never existed, reverting a closed item to
    # `ready` -- the same loss, from the other direction.
    #
    # `if_unchanged` is keyed to the BOOTSTRAP FLAG, not to `loaded_from_disk`.
    # Those are not the same question and the difference is a real loss:
    # `loaded_from_disk` is False for TWO reasons -- `--bootstrap`, which is
    # intended, and THE FILE SIMPLY NOT EXISTING, which is not. `load()` returns
    # early on a missing file, so an ordinary cycle over an absent `state.json`
    # -- a fresh clone, or the deleted-scratch-file event this package already
    # has a memory about -- ran with no guard at all. Reproduced through
    # `main()`: a concurrent lane closed #2002 with a ci-green receipt, the
    # cycle saved, rc=0, and #2002 was GONE from the document entirely.
    #
    # `not args.bootstrap` exempts only what was meant. A missing file is safe
    # to guard: `_on_disk_digest()` returns None, `loaded_digest` is None, so
    # the comparison passes when nothing is there and REFUSES if another writer
    # created it in the meantime.
    try:
        led.save(if_unchanged=not args.bootstrap)
    except LedgerChangedError as exc:
        print(f"CYCLE NOT SAVED: {exc}", file=sys.stderr)
        return 1

    print(emit(led, policy, chosen, triage_queue(led), audit_queue(led)))
    print()
    print(f"refresh: +{added} new, {departed} left GitHub -> needs-audit, {reaped} reaped")
    if led.drained():
        print("DRAINED - every item is closed, parked or declined.")
        return 0
    if not chosen:
        print(
            f"NOTHING SCHEDULABLE. {len(led.remaining())} item(s) remain but carry "
            "no lane or no size - run triage before implementation can proceed."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
