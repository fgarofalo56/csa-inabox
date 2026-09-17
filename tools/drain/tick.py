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
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from build_inventory import stream_for
from ledger import (
    AUDIT_DEPARTED,
    CLOSED,
    IN_FLIGHT,
    NEEDS_AUDIT,
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
    """
    run = subprocess.run(
        args, capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=REPO_ROOT
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


class ReceiptRefusedError(Exception):
    """The evidence offered does not establish the receipt. Never recorded."""


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


def record_receipt_from_evidence(
    led: Ledger, policy: dict, repo: str, number: int,
    *, from_pr: int | None, from_run: str | None,
) -> str:
    """Record a receipt this tool has MEASURED, then close the item. Or refuse.

    THE KIND IS DERIVED FROM THE ITEM'S CLASS, never supplied by the caller.
    That is the load-bearing choice here. A `--kind` flag would let a
    `ui-surface` item close on a `ci-green`, which is the exact defect a
    reviewer reproduced by editing one line of `LANE_RECEIPT_CLASS` -- and the
    R2 invariant catches a class that MOVED, not a caller who named the wrong
    one up front.

    `ci-green` is RE-MEASURED here rather than trusted: `merge_gate` collects
    the evidence and `gates.ci_green_receipt` decides, the same two calls the
    `--ci-green-receipt` report makes, so this path cannot record a receipt the
    report would not print. Everything else is run-backed and goes through
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
      against a second deploy-path item it never touched. That one genuinely
      waits on #4489.
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
        receipt = gates.ci_green_receipt(
            data["evidence"],
            merged_total_count=data["merged_total_count"],
            merged_changed_files=data["changed_files"],
            merged_branch=data["branch"],
            merged_sha=data["merged"],
            trees_identical=data["trees_identical"],
            policy=policy,
            infra_ere=merge_gate.resolve_infra_ere(data["merged"]),
        )
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

    # DISCLOSED AS UN-KILLABLE, per assertion-design.md #5, because a reviewer
    # spent a round confirming it and the next reader should not have to: in the
    # CURRENT call graph nothing can reach this `except`. `transition` refuses
    # on a class/kind mismatch, and the kind is DERIVED from that same class two
    # lines up, so the two always agree. There is no input that makes this
    # branch run, and no test here pretends otherwise.
    #
    # It is kept because the invariant it protects is real and the call graph is
    # not a guarantee: `record_receipt` sets three fields AND appends a history
    # line before `transition` can refuse, so any future caller that stamps a
    # class separately -- or any change that lets `transition` refuse for a new
    # reason -- lands on an item carrying a receipt it was refused on.
    #
    # THE HISTORY LINE IS PART OF THE RESTORE. A reviewer pointed out that
    # clearing the three fields alone leaves the audit record asserting a
    # receipt that does not exist, which is worse than keeping or dropping
    # both: the fields would say no receipt and the history would say there was
    # one.
    before = (item.receipt_kind, item.receipt_ref, item.receipt_taken_under)
    history_len = len(item.history)
    led.record_receipt(number, kind, ref)
    try:
        led.transition(number, CLOSED, f"receipt verified by tick: {detail}")
    except Exception:
        (item.receipt_kind, item.receipt_ref, item.receipt_taken_under) = before
        del item.history[history_len:]
        raise
    return f"#{number} closed on a {kind} receipt - {detail}"


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
    args = parser.parse_args()

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
            summary = record_receipt_from_evidence(
                led, policy, repo, args.record_receipt,
                from_pr=args.from_pr, from_run=args.from_run,
            )
        except (ReceiptRefusedError, ValueError) as exc:
            # ValueError is the ledger's own R2 refusal from `transition`. It is
            # caught here so a refusal prints as a refusal rather than a
            # traceback -- and NOTHING is saved on this path, so a refused
            # receipt leaves the ledger byte-identical.
            print(f"RECEIPT REFUSED: {exc}", file=sys.stderr)
            return 1
        try:
            # if_unchanged: refuse a LOST UPDATE rather than discard a
            # concurrent lane's close. Reproduced before this existed -- two
            # overlapping records, and the loser's item silently reverted to
            # `ready` with its receipt gone.
            led.save(if_unchanged=True)
        except LedgerChangedError as exc:
            print(f"RECEIPT NOT RECORDED: {exc}", file=sys.stderr)
            return 1
        print(summary)
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
