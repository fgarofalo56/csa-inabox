"""One cycle of the drain. Run it, launch what it prints, run it again.

    python tools/drain/tick.py --status     # what is the queue holding?
    python tools/drain/tick.py              # advance one cycle, emit briefs
    python tools/drain/tick.py --bootstrap  # first run: seed from live GitHub

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

from ledger import (
    IN_FLIGHT,
    READY,
    TERMINAL,
    Ledger,
)

import gates

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
POLICY_PATH = os.path.join(HERE, "policy.json")
INVENTORY = os.path.join(HERE, "..", "..", "PRPs", "active", "zero-backlog", "INVENTORY.md")


def sh(args: list[str]) -> tuple[int, str, str]:
    """Run a command and return (rc, stdout, stderr).

    Never discards stderr. A discarded stderr once turned "I could not reach the
    registry" into "the tag does not exist" and sent two investigations down the
    wrong path (deploy-integrity R7).
    """
    run = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return run.returncode, run.stdout, run.stderr


def refresh_from_github(led: Ledger, streams: dict) -> tuple[int, int]:
    """Re-read live GitHub. New issues appear; issues closed elsewhere leave."""
    rc, out, err = sh(
        ["gh", "issue", "list", "--state", "open", "--limit", "1000",
         "--json", "number,title,labels"]
    )
    if rc != 0:
        raise SystemExit(f"cannot read GitHub (rc={rc}): {err[:300]}")
    live = json.loads(out)
    live_numbers = {i["number"] for i in live}

    added = 0
    for issue in live:
        number = issue["number"]
        labels = {label["name"] for label in issue["labels"]}
        lane = next((x for x in labels if x.startswith("lane:")), None)
        size = next(
            (int(x.split(":")[1]) for x in labels if x.startswith("sp:")), None
        )
        stream = streams.get(number, "W9-rest")
        if number not in led.items:
            added += 1
        led.upsert(number, issue["title"], stream, lane=lane, size=size)

    # An issue closed outside the drain is DONE, not lost. Record it rather than
    # leaving a phantom in the queue -- but never invent a receipt for it.
    departed = 0
    for number, item in led.items.items():
        if number not in live_numbers and item.state not in TERMINAL:
            item.receipt_kind = item.receipt_kind or "closed-externally"
            item.receipt_ref = item.receipt_ref or "not open on GitHub at refresh"
            led.transition(number, "closed", "closed outside the drain")
            departed += 1
    return added, departed


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


def write_brief(item, policy: dict) -> str:
    """A brief is SELF-CONTAINED. An agent never needs the previous transcript.

    This is the context-rotation contract: the ledger is the only durable state,
    and every brief is regenerated from it. Carrying a brief forward across
    cycles is how a plan gets summarized into vagueness.
    """
    receipt = policy["receipts"].get(
        "ui-surface" if item.lane == "lane:console" else "guard-or-test-only"
    )
    stop = ", ".join(sorted(policy["stop_and_ask"].keys()))
    return f"""### Lane {item.lane} - issue #{item.number} ({item.stream}, {item.size}pt)

{item.title}

**Read the issue first**: `gh issue view {item.number}` - and treat every claim
in it as a HYPOTHESIS to re-verify at head. Issues here go stale fast.

**Check for supersession before fixing anything.** An issue sat blocked while
another PR had already delivered three quarters of it; merging would have
advertised work the diff no longer contained.

**Receipt required to close: `{receipt}`.** Per deploy-integrity R2 a merge is
NOT a receipt. If this is a UI surface, the G1 assertion must key on something
only a success path can produce, and you must name why it is unreachable from an
error path - an assertion satisfied by `Error: HTTP 500` is not a receipt.

**Ask of any guard fix: what is the OTHER side of this boundary?** The dominant
defect of the last drain was a correct fix applied to one side of a symmetry -
consumer but not producer, one predicate of four, one call site of two - and
every one shipped with a green mutation matrix, because authors mutate the thing
they just fixed.

**Gates**: merge only on GO; scan closing keywords in BOTH the body and the
commit trail (`closingIssuesReferences` is not a complete oracle); clear any
conflict BEFORE pushing (a push into a CONFLICTING window gets zero check-runs,
permanently).

**Stop and ask for**: {stop}.
"""


def emit(led: Ledger, policy: dict, chosen: list, triage: list) -> str:
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
    parser.add_argument("--bootstrap", action="store_true", help="seed from live GitHub")
    args = parser.parse_args()

    policy = gates.load_policy(POLICY_PATH)
    led = Ledger(os.path.join(HERE, "state.json")).load()

    streams: dict = {}
    inv = os.path.join(HERE, "inventory.json")
    if os.path.exists(inv):
        with open(inv, encoding="utf-8") as handle:
            for stream, rows in json.load(handle).items():
                for row in rows:
                    streams[row["n"]] = stream

    if args.status:
        print(json.dumps(led.counts(), indent=1))
        print("drained:", led.drained())
        return 0

    added, departed = refresh_from_github(led, streams)
    led.cycle += 1
    chosen = select_cycle(led, policy)
    for item in chosen:
        led.transition(item.number, IN_FLIGHT, f"selected in cycle {led.cycle}")

    led.save()

    print(emit(led, policy, chosen, triage_queue(led)))
    print()
    print(f"refresh: +{added} new, {departed} closed elsewhere")
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
