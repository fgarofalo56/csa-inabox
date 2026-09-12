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

import merge_gate
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


def merge_time(policy: dict, led: Ledger, pr: int | None = None
               ) -> tuple[Counter, int, int]:
    """What GATE 3b will say for a PR that DECLARES a close of each item.

    Returns `(counts, one_reviewer, receipted_of_those)`. `pr` is the PR the
    hypothetical is about; `None` models the ordinary case where no binding
    names it.

    TWO GATES, MEASURED SEPARATELY. The first version ANDed `receipt_ok` into
    `stream_known` and called the result "what gate 3b will say" -- but 3b's
    corroboration test reads `item.pr` and `item.state` and nothing else;
    `receipt_ok` lives on `--allow-close` in `main()`, which is gate 6's
    business. A reviewer measured the difference: over the live 299 the model
    said `{2: 299}` and the real composition says `{2: 298, 1: 1}` -- #2626 is
    in-flight, so 3b asks for ONE reviewer today with zero receipts anywhere.

    The conflation also inverted the label: ANDing a second condition in makes
    this UNDER-count the one-reviewer population, so it was a lower bound while
    calling itself an upper one.

    So: `counts` is gate 3b alone. `receipted_of_those` is how many of the
    one-reviewer items could actually reach GO, because gate 6 refuses an
    undeclared close and `--allow-close` is refused without a receipt. Those
    are different gates and the operator should see both numbers.
    """
    counts: Counter = Counter()
    one_reviewer = receipted = 0
    for item in led.items.values():
        # `ledger_stream`'s corroboration test, IMPORTED rather than restated.
        #
        # The first version said "exactly ... and nothing else" and was not: it
        # read `item.pr is not None` where the real test is `item.pr == pr`, so
        # an item bound to ANOTHER PR modelled as one-reviewer where the gate
        # says two. Both reviewers found it. Latent (nothing writes `Item.pr`)
        # and it arms on #4489 -- the same condition under which the wording
        # fixes in `merge_gate` were made, applied one file over this time.
        #
        # `SCHEDULED_STATES` is imported for the same reason: the states were
        # hardcoded here, so a fourth one would diverge the model in silence.
        stream_known = (
            item.pr == pr if item.pr is not None
            else item.state in merge_gate.SCHEDULED_STATES
        )
        needed, _why = gates.review_requirement(
            policy,
            changed_paths=["docs/x.md"],
            stream=item.stream if stream_known else None,
            footprint_known=True,
            stream_known=stream_known,
        )
        counts[needed] += 1
        if needed == 1:
            one_reviewer += 1
            receipted += 1 if led.receipt_ok(item)[0] else 0
    return counts, one_reviewer, receipted


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
        counts, one_reviewer, receipted = merge_time(policy, led)
        total = sum(counts.values()) or 1
        print(f"GATE 3b over {total} live items, assuming every PR DECLARES its "
              "close and touches no escalating path")
        for needed in sorted(counts):
            print(f"  {needed} reviewer(s): {counts[needed]:3d}  "
                  f"({counts[needed] / total:.0%})")
        print("\nGATE 6 is a different gate, and today it is the binding one.")
        print(f"  of the {one_reviewer} item(s) 3b would let through on one "
              f"reviewer, {receipted} hold a receipt")
        print("  an undeclared close is refused by gate 6, and `--allow-close` "
              "is refused without a receipt of the item's kind - so the rest "
              "cannot reach GO however many reviewers approve.")
        print("  Nothing records a receipt automatically: `record_receipt` has "
              "no production caller (#4489).")
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
