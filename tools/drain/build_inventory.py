"""Derive the zero-backlog workstream inventory from live GitHub data.

A hand-written inventory goes stale the moment an issue moves. This reads the
live snapshot and emits the breakdown the PRP quotes, so every number in that
document is measured rather than recalled.

REFUSES a partition that loses an issue. A partition that silently drops one is
worse than no partition, because the item leaves the plan without leaving the
backlog -- the same failure mode the ledger refuses when it will not let you
park without an owner.

    python tools/drain/build_inventory.py

Writes PRPs/active/zero-backlog/INVENTORY.md and tools/drain/inventory.json.
"""
from __future__ import annotations

import collections
import json
import subprocess
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[2]
SNAPSHOT = ROOT / "temp" / "allissues.json"
OUT_MD = ROOT / "PRPs" / "active" / "zero-backlog" / "INVENTORY.md"
OUT_JSON = Path(__file__).resolve().parent / "inventory.json"

POINTS = {"sp:1": 1, "sp:3": 3, "sp:5": 5, "sp:8": 8, "sp:13": 13}

# Issues pinned to a stream by number because no label distinguishes "blocks the
# deploy path" from "is a feature". Everything else falls through to its lane.
# #4487 MUST be pinned: the W4 fall-through matches `"receipt" in title.lower()`
# and its title is *about* receipts ("the ci-green RECEIPT names a measurement
# the CI topology cannot produce"). Unpinned it landed in W4-receipts, whose
# class is `estate-behaviour` -- so the ledger would have demanded a LIVE ESTATE
# receipt for a path-filter fix in a workflow file and refused every other kind,
# and the cold-start KICKOFF names #4487 as the FIRST TASK. A title-substring
# heuristic classifies an issue by what it MENTIONS, not by what it IS.
#
# #4485 is pinned for ORDERING, not for that reason -- measured, it falls to
# W6-ci, whose class is already `guard-or-test-only`, so the pin changes its
# stream and not its receipt. Recorded because a comment that gives one reason
# for two entries invites the next reader to trust it for both.
HARNESS = {4466, 4467, 4468, 4469, 4485, 4487}
DEPLOY = {4451, 4461, 4464, 4471, 4472, 4473, 3676, 2958}
SECURITY = {4456, 4457, 4458, 4460, 3941, 3338}
RECEIPTS = {4470, 4432, 3720, 2626, 2583, 2581, 4361, 4183, 4405, 4406, 4387, 4442}


def stream_for(number: int, title: str, labels: set[str]) -> str:
    """Assign one issue to exactly one workstream.

    Order IS precedence: a Gov-drift issue that also blocks the deploy path
    belongs to the deploy stream, because R1 makes that the thing that preempts.
    """
    if number in HARNESS:
        return "W0-harness"
    if number in DEPLOY or "deploy-validation" in labels or "bicep-drift" in labels:
        return "W1-deploy"
    if number in SECURITY or "security" in labels:
        return "W2-security"
    if "drift-gov" in labels or "drift-commercial" in labels:
        return "W3-gov"
    if number in RECEIPTS or "receipt" in title.lower():
        return "W4-receipts"
    for lane, stream in (
        ("lane:ci", "W6-ci"),
        ("lane:bicep", "W7-bicep"),
        ("lane:dataplane", "W8-dataplane"),
        ("lane:console", "W5-console"),
    ):
        if lane in labels:
            return stream
    return "W9-rest"


DESCRIPTIONS = {
    "W0-harness": "Harness + gate integrity (the drain's own tooling)",
    "W1-deploy": "Deploy-path integrity (R1 preempts all feature work)",
    "W2-security": "Security + authz",
    "W3-gov": "Sovereign / cloud-parity",
    "W4-receipts": "Owed receipts (merged-not-verified)",
    "W5-console": "Console surfaces (ui-parity / ux-baseline)",
    "W6-ci": "CI guards + lanes",
    "W7-bicep": "Bicep / infrastructure",
    "W8-dataplane": "Data plane",
    "W9-rest": "Unclassified remainder (triage before scheduling)",
}
ORDER = list(DESCRIPTIONS)


def read_issues_from(source) -> list[dict]:
    """Refuse an EMPTY issue list, whatever produced it.

    An empty partition is total over nothing -- the one case the totality check
    cannot catch, because zero placed equals zero wanted. Separated from the
    reader so it has a negative control.
    """
    issues = source()
    if not issues:
        raise SystemExit(
            "refusing to build an inventory over ZERO issues - an empty partition is "
            "total over nothing, which is the one case the totality check cannot catch."
        )
    return issues


def read_issues() -> list[dict]:
    """Read the live issue list, falling back to a hand-made snapshot.

    This used to REQUIRE `temp/allissues.json` -- a gitignored file nothing in
    the harness creates; the script only printed the command that would make
    one. So on any clean checkout the inventory could not be regenerated, and
    `tick.py` (which reads this script's output) filed all 297 issues into
    `W9-rest`, silently collapsing the W0 -> W1 -> ... execution order the PRP
    calls load-bearing. Fetch it.
    """
    if SNAPSHOT.exists():
        print(f"using snapshot {SNAPSHOT}")
        return read_issues_from(lambda: json.loads(SNAPSHOT.read_text(encoding="utf-8")))

    policy = json.loads((Path(__file__).resolve().parent / "policy.json").read_text("utf-8"))
    repo = policy["repo"]
    print(f"no snapshot; reading {repo} live")

    def fetch() -> list[dict]:
        run = subprocess.run(
            ["gh", "issue", "list", "--repo", repo, "--state", "open", "--limit", "1000",
             "--json", "number,title,labels,createdAt"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=ROOT,
        )
        if run.returncode != 0:
            raise SystemExit(
                f"cannot read issues for {repo} (rc={run.returncode}): {run.stderr[:300]}"
            )
        return json.loads(run.stdout)

    return read_issues_from(fetch)


def assert_partition_is_total(issues: list, rows: dict[str, list]) -> None:
    """REFUSE a partition that loses an issue -- PRP §8's acceptance box.

    A partition that silently drops one is worse than no partition: the item
    leaves the plan without leaving the backlog, which is the same failure the
    ledger refuses when it will not let you park without an owner. Extracted
    from `main()` so it has a negative control; inline it had none, and an
    acceptance criterion with no test is an assertion about untested code.

    Both directions are checked. Counting alone passes a SWAP -- one issue lost
    and one counted twice sum to the right total.
    """
    placed = [row["n"] for bucket in rows.values() for row in bucket]
    want = [issue["number"] for issue in issues]
    lost = sorted(set(want) - set(placed))
    dupes = sorted({n for n in placed if placed.count(n) > 1})
    if lost or dupes or len(placed) != len(want):
        raise SystemExit(
            f"REFUSING -- partition is not total: {len(want)} issues in, {len(placed)} placed"
            + (f"; LOST {lost}" if lost else "")
            + (f"; DUPLICATED {dupes}" if dupes else "")
        )


def main() -> int:
    issues = read_issues()
    rows: dict[str, list] = {key: [] for key in ORDER}

    for issue in issues:
        labels = {entry["name"] for entry in issue["labels"]}
        key = stream_for(issue["number"], issue["title"], labels)
        rows[key].append(
            {
                "n": issue["number"],
                "t": issue["title"],
                "pts": next((POINTS[x] for x in labels if x in POINTS), None),
                "epic": "epic" in labels,
                "blocked": "sprint:blocked" in labels,
                "lane": next((x for x in labels if x.startswith("lane:")), None),
            }
        )

    assert_partition_is_total(issues, rows)

    out = [
        "# Zero-backlog inventory (generated -- do not hand-edit)",
        "",
        f"Source: `gh issue list --state open --limit 1000`, {len(issues)} issues.",
        "Regenerate: `python tools/drain/build_inventory.py`",
        "",
        "| stream | what | issues | sized pts | unsized | epics | blocked |",
        "|---|---|---:|---:|---:|---:|---:|",
    ]
    totals: collections.Counter = collections.Counter()
    for key in ORDER:
        items = rows[key]
        pts = sum(row["pts"] for row in items if row["pts"])
        unsized = sum(1 for row in items if row["pts"] is None)
        epics = sum(1 for row in items if row["epic"])
        blocked = sum(1 for row in items if row["blocked"])
        totals.update(n=len(items), pts=pts, unsized=unsized, epics=epics, blocked=blocked)
        out.append(
            f"| `{key}` | {DESCRIPTIONS[key]} | {len(items)} | {pts} | "
            f"{unsized} | {epics} | {blocked} |"
        )
    out.append(
        f"| **total** | | **{totals['n']}** | **{totals['pts']}** | "
        f"**{totals['unsized']}** | **{totals['epics']}** | **{totals['blocked']}** |"
    )
    out.append("")

    for key in ORDER:
        items = rows[key]
        if not items:
            continue
        out.append(f"## `{key}` -- {DESCRIPTIONS[key]}  ({len(items)})")
        out.append("")
        for row in sorted(items, key=lambda r: (-(r["pts"] or 0), r["n"])):
            size = f"`{row['pts']}pt`" if row["pts"] else "`unsized`"
            flags = "".join(["E" if row["epic"] else "", "B" if row["blocked"] else ""])
            flag = f" `{flags}`" if flags else ""
            out.append(f"- **#{row['n']}** {size}{flag} -- {row['t'][:100]}")
        out.append("")

    OUT_MD.parent.mkdir(parents=True, exist_ok=True)
    OUT_MD.write_text("\n".join(out), encoding="utf-8")
    OUT_JSON.write_text(json.dumps(rows, indent=1), encoding="utf-8")

    for key in ORDER:
        items = rows[key]
        print(
            f"  {key:<14} {len(items):3d} issues  "
            f"{sum(r['pts'] for r in items if r['pts']):4d} pts  "
            f"{sum(1 for r in items if r['pts'] is None):3d} unsized"
        )
    print()
    print(
        f"TOTAL {totals['n']} issues, {totals['pts']} pts, {totals['unsized']} unsized "
        "-- partition is total (no issue lost)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
