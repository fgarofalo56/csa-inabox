"""How many live items actually escalate to two reviewers, and why?

    python tools/drain/operating_point.py

`policy.json` says ONE independent reviewer is the default. This measures what
that means over the real queue, because a default nobody reaches is a different
policy from the one written down -- and the first measurement found 93%, which
the operator was shown before deciding to leave the list alone.

TRACKED, not in `temp/`. Two entries in `policy.json` used to instruct a
re-measure with `temp/w0/operating_point.py`, which is gitignored: on a fresh
clone the instruction was unrunnable and the file was one `git clean` from gone.
That is #4468's thesis -- a gitignored path hiding the thing that decides --
reached one door over, in the authority file itself.

TWO MEASUREMENT POINTS, AND THEY ARE NOT COMPARABLE.

- BRIEF TIME (what this script measures): the decision is taken from a LANE,
  before the diff exists, so the path set is a guess and `footprint_known` is
  False for every unlaned item. That is the 93% figure.
- MERGE TIME (`merge_gate` gate 3b): the diff is a fact and the STREAM has to be
  resolved from the ledger. Different inputs, different number. Quoting one as
  "up from" the other reads as a single number that moved.

`--merge-gate` measures the second one instead.
"""
from __future__ import annotations

import argparse
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ledger import Ledger

import gates

HERE = os.path.dirname(os.path.abspath(__file__))


def brief_time(policy: dict, led: Ledger) -> tuple[Counter, Counter, dict]:
    """What `tick.py`'s briefs will say, item by item."""
    counts: Counter = Counter()
    by_reason: Counter = Counter()
    per_stream: dict[str, Counter] = {}
    for item in led.items.values():
        lane_path = gates.LANE_PATHS.get(item.lane or "")
        needed, why = gates.review_requirement(
            policy,
            changed_paths=[lane_path] if lane_path else [],
            stream=item.stream,
            footprint_known=bool(lane_path),
        )
        counts[needed] += 1
        by_reason[why.split(" - ")[0]] += 1
        per_stream.setdefault(item.stream, Counter())[needed] += 1
    return counts, by_reason, per_stream


def merge_time(policy: dict, led: Ledger) -> Counter:
    """What gate 3b will say for a PR that DECLARES a close of each item.

    The most favourable case for one reviewer: the PR names the item, declares
    the close, and the diff touches nothing that escalates by path. Anything
    less needs two. So this is an UPPER BOUND on the one-reviewer population.
    """
    counts: Counter = Counter()
    for item in led.items.values():
        ok, _why = led.receipt_ok(item)
        # `--allow-close` is refused without a receipt of the right kind, and
        # gate 6 blocks an undeclared close -- so no receipt means no
        # one-reviewer path at all, whatever the stream says.
        stream_known = ok and (
            item.pr is not None or item.state in ("in-flight", "in-review",
                                                  "awaiting-receipt")
        )
        needed, _why = gates.review_requirement(
            policy,
            changed_paths=["docs/x.md"],
            stream=item.stream if stream_known else None,
            footprint_known=True,
            stream_known=stream_known,
        )
        counts[needed] += 1
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--merge-gate", action="store_true",
                        help="measure gate 3b instead of the brief")
    args = parser.parse_args()

    policy = gates.load_policy(os.path.join(HERE, "policy.json"))
    path = os.path.join(HERE, "state.json")
    if not os.path.exists(path):
        print(f"NO LEDGER at {path} - seed it with `tick.py --bootstrap`")
        return 2
    led = Ledger(path, receipts=policy["receipts"]).load()

    if args.merge_gate:
        counts = merge_time(policy, led)
        total = sum(counts.values()) or 1
        print(f"MERGE-GATE operating point over {total} live items")
        print("(upper bound on one-reviewer: assumes every PR declares its "
              "close and touches no escalating path)")
        for needed in sorted(counts):
            print(f"  {needed} reviewer(s): {counts[needed]:3d}  "
                  f"({counts[needed] / total:.0%})")
        receipted = sum(1 for i in led.items.values() if led.receipt_ok(i)[0])
        print(f"\nitems holding a valid receipt: {receipted} of {total}")
        print("This is the number that has to move before the merge gate can "
              "ever ask for one reviewer. Nothing records a receipt "
              "automatically -- `record_receipt` has no production caller.")
        return 0

    counts, by_reason, per_stream = brief_time(policy, led)
    total = sum(counts.values()) or 1
    print(f"BRIEF-TIME operating point over {total} live items")
    for needed in sorted(counts):
        print(f"  {needed} reviewer(s): {counts[needed]:3d}  "
              f"({counts[needed] / total:.0%})")
    print("\nwhy:")
    for why, count in by_reason.most_common():
        print(f"  {count:3d}  {why}")
    print("\nper stream (1 / 2):")
    for stream in sorted(per_stream):
        slot = per_stream[stream]
        print(f"  {stream:14} {slot[1]:3d} / {slot[2]:3d}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
