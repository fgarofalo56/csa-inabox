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
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from build_inventory import stream_for
from ledger import (
    IN_FLIGHT,
    NEEDS_AUDIT,
    READY,
    TERMINAL,
    Ledger,
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
GUARD_FLOOR = 10  # below this many believed-open items the ratios are noise


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


def guard_refresh(led: Ledger, live: list[dict]) -> None:
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
    """
    believed_open = {n for n, i in led.items.items() if i.state not in TERMINAL}
    if len(believed_open) < GUARD_FLOOR:
        return

    live_numbers = {i["number"] for i in live}
    if not live_numbers:
        raise SystemExit(
            f"refusing to refresh: GitHub returned ZERO open issues while the ledger "
            f"believes {len(believed_open)} are open. That would close all of them. "
            "Confirm the repo and the token, then re-run."
        )

    shared = believed_open & live_numbers
    overlap = len(shared) / len(live_numbers)
    if overlap < MIN_OVERLAP:
        raise SystemExit(
            f"refusing to refresh: the live set ({len(live_numbers)} issues) overlaps the "
            f"ledger's open set ({len(believed_open)}) by only {overlap:.0%}. That is a "
            "different population - check `repo` in policy.json and GH_REPO in the environment."
        )

    retained = len(shared) / len(believed_open)
    if retained < MIN_RETAINED:
        raise SystemExit(
            f"refusing to refresh: only {retained:.0%} of the {len(believed_open)} issues the "
            f"ledger believes are open are still in the live set (floor {MIN_RETAINED:.0%}). "
            "A partial or truncated read looks exactly like this. Re-run; if the drop is real, "
            "pass --allow-shrink."
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
    departed = 0
    for number, item in led.items.items():
        if number not in live_numbers and item.state not in TERMINAL and item.state != NEEDS_AUDIT:
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
    cap = policy["wip"]["max_lanes"]
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

**Gates are a PROGRAM, not a judgement. Run it and paste the output:**

    python tools/drain/merge_gate.py <PR>

It checks base == origin/main, reduces verdicts by conjunction (a later APPROVE
does not discharge an earlier block, and an unparseable review AT HEAD blocks),
requires every required context present/green/non-hollow, scans BOTH the body
and the commit trail for closing keywords (`closingIssuesReferences` is not a
complete oracle), and prints the pre-merge open-issue count for the post-merge
audit. Clear any conflict BEFORE pushing - a push into a CONFLICTING window gets
zero check-runs, permanently.

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
        help="permit a refresh whose live set is much smaller than the ledger's open set",
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

    live = read_live_issues(repo)
    if not args.allow_shrink:
        guard_refresh(led, live)
    if args.bootstrap:
        print(f"BOOTSTRAP: discarding any prior ledger, seeding from {repo}")

    reaped = reap_stranded(led, led.cycle) if args.reap else 0
    added, departed = refresh_from_github(led, streams, live)
    led.cycle += 1
    chosen = select_cycle(led, policy)
    for item in chosen:
        led.transition(item.number, IN_FLIGHT, f"selected in cycle {led.cycle}")

    led.save()

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
