"""Generate the PRP execution plan and the cross-program schedule from PRP frontmatter.

Usage (from anywhere; the repo root is derived from this file's location):

    python tools/prp/gen_plan.py            # writes both docs
    python tools/prp/gen_plan.py --check    # exit 1 if either doc is stale

Outputs:
    PRPs/reference/EXECUTION-PLAN-2026-11.md   dependency graph, per-program waves, kickoff prompts
    PRPs/reference/GLOBAL-SCHEDULE.md          rounds of <= WIP PRPs, at most one bicep PRP per round

The schedule is an ORDERING, not a calendar: a round is a set of PRPs that may run at the
same time because no dependency path joins them and at most one of them holds the bicep slot.
It does not prove two PRPs own disjoint files; that is what the Owns sections are for.
"""

from __future__ import annotations

import argparse
import collections
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

WIP = 4
# Programs in priority order (PRPs/MASTER-INDEX.md). Anything else sorts last, by name.
PRIORITY = [
    "loom-health-data-services",
    "loom-api-gateway-plane",
    "apim-ai-gateway",
    "estate-power-receipts",
    "governance-autopilot",
    "per-workspace-spark-identity",
    "loom-brain",
    "snowflake-parity",
    "issue-batches",
]
# Operator decision 2026-11-14: these take the bicep slot first, in this order.
BICEP_HEAD = [
    "W01b-close-deploy-receipts",
    "apim-WA-multi-endpoint-pool",
    "apim-WB1-default-on-commercial-gcc",
]
# Standing lanes: each round takes one PRP per lane where one is ready; the third lane rotates
# across its programs so none of them starves. The bicep PRP of a round occupies its own lane.
LANES = [
    ["loom-health-data-services"],
    ["loom-api-gateway-plane", "apim-ai-gateway"],
    ["estate-power-receipts", "governance-autopilot", "per-workspace-spark-identity", "loom-brain", "snowflake-parity"],
    ["issue-batches"],
]
OPEN_ITEM = {"todo", "in-progress", "verifying", "review", "blocked"}
FRONTMATTER = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n", re.S)


@dataclass
class Prp:
    name: str
    path: str
    program: str
    status: str
    order: int
    deps: list[str]
    wave: str
    branch: str
    bicep: str
    kickoff: str
    is_hub: bool
    has_open_items: bool
    cross: list[str] = field(default_factory=list)


def parse_frontmatter(text: str) -> dict[str, str] | None:
    match = FRONTMATTER.match(text)
    if not match:
        return None
    data: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" in line and not line.startswith((" ", "\t", "#")):
            key, value = line.split(":", 1)
            data[key.strip()] = value.strip().strip("'\"")
    return data


def parse_list(value: str) -> list[str]:
    value = value.strip()
    if value.startswith("["):
        value = value[1:-1]
    return [item.strip().strip("'\"") for item in value.split(",") if item.strip()]


def section(text: str, heading: str) -> str:
    pattern = r"^#{1,4}\s*(?:\d+\.\s*)?" + heading + r"[^\n]*\n(.*?)(?=^#{1,4}\s|\Z)"
    match = re.search(pattern, text, re.S | re.M | re.I)
    return match.group(1).strip() if match else ""


def open_items(text: str) -> bool:
    """True when the Execution state table has a row still to do, or there is no table."""
    table = section(text, "Execution state")
    rows = [r for r in table.splitlines() if r.startswith("|") and not set(r) <= set("|-: ")]
    if len(rows) <= 1:
        return True
    for row in rows[1:]:
        cells = [c.strip().lower() for c in row.strip("|").split("|")]
        if len(cells) > 1 and cells[1] in OPEN_ITEM:
            return True
    return False


def load(root: Path) -> list[Prp]:
    prps: list[Prp] = []
    for base in ("active", "backlog"):
        for path in sorted((root / "PRPs" / base).rglob("*.md")):
            text = path.read_text(encoding="utf-8", errors="replace")
            meta = parse_frontmatter(text)
            if not meta or "name" not in meta:
                continue
            wave = re.search(r"\*{0,2}Wave\*{0,2}\s*[:\-]\s*\**\s*([0-9]+)", text)
            branch = re.search(r"Branch\*{0,2}\s*[:\-]\s*\**\s*`([^`]+)`", text)
            bicep = re.search(r"touches_bicep\s*[:=]\s*`?(yes|no)", text, re.I)
            order = meta.get("order", "0")
            prps.append(
                Prp(
                    name=meta["name"],
                    path=path.relative_to(root).as_posix(),
                    program=path.parent.name,
                    status=meta.get("status", "?"),
                    order=int(order) if order.lstrip("-").isdigit() else 0,
                    deps=parse_list(meta.get("depends_on", "[]")),
                    wave=wave.group(1) if wave else "-",
                    branch=branch.group(1) if branch else "-",
                    bicep=bicep.group(1).lower() if bicep else "-",
                    kickoff=section(text, "Kickoff prompt"),
                    is_hub=path.name == "PRP.md",
                    has_open_items=open_items(text),
                )
            )
    names = {p.name for p in prps}
    for prp in prps:
        text = (root / prp.path).read_text(encoding="utf-8", errors="replace")
        for line in text.splitlines():
            if "cross-program order" in line.lower():
                for token in re.findall(r"`([A-Za-z0-9_.\-]+)`", line):
                    if token in names and token != prp.name and token not in prp.deps:
                        prp.cross.append(token)
    return prps


def program_rank(program: str) -> tuple[int, str]:
    return (PRIORITY.index(program) if program in PRIORITY else len(PRIORITY), program)


def lane_of(program: str) -> int:
    for index, programs in enumerate(LANES):
        if program in programs:
            return index
    return len(LANES)


def schedule(prps: list[Prp]) -> tuple[list[list[Prp]], list[Prp], list[Prp], list[Prp]]:
    """Return (rounds, blocked, merged_awaiting_receipts, unschedulable)."""
    by_name = {p.name: p for p in prps}
    done = {p.name for p in prps if p.status in ("shipped", "abandoned")}
    blocked = [p for p in prps if p.status == "blocked" and not p.is_hub]
    awaiting = [
        p for p in prps if not p.is_hub and p.status not in ("shipped", "abandoned", "blocked") and not p.has_open_items
    ]
    done |= {p.name for p in awaiting}
    todo = [p for p in prps if not p.is_hub and p.name not in done and p.status != "blocked"]
    rounds: list[list[Prp]] = []
    rotate = 0
    lane_turn = [0] * len(LANES)
    head_prereqs: set[str] = set()
    frontier = [n for n in BICEP_HEAD if n in by_name]
    while frontier:
        current = by_name[frontier.pop()]
        for dep in current.deps + current.cross:
            if dep in by_name and dep not in head_prereqs:
                head_prereqs.add(dep)
                frontier.append(dep)
    while todo:
        ready = [p for p in todo if all(d in done or d not in by_name for d in p.deps + p.cross)]
        if not ready:
            break
        ready.sort(key=lambda p: (program_rank(p.program), p.order, p.name))
        picked: list[Prp] = []
        bicep_ready = [p for p in ready if p.bicep == "yes"]
        head = [by_name[n] for n in BICEP_HEAD if n in by_name and by_name[n] in bicep_ready]
        if head:
            picked.append(head[0])
        elif bicep_ready:
            programs = sorted({p.program for p in bicep_ready}, key=program_rank)
            chosen = programs[rotate % len(programs)]
            rotate += 1
            picked.append(next(p for p in bicep_ready if p.program == chosen))
        others = [p for p in ready if p.bicep != "yes"]
        filled = {lane_of(p.program) for p in picked}
        for lane, programs in enumerate(LANES):  # one PRP per standing lane first
            if lane in filled or len(picked) >= WIP:
                continue
            candidates = [p for p in others if p.program in programs]
            if not candidates:
                continue
            urgent = [p for p in candidates if p.name in head_prereqs]
            if urgent:  # unblock the head of the bicep queue before anything else in the lane
                picked.append(urgent[0])
                continue
            present = sorted({p.program for p in candidates}, key=program_rank)
            chosen = present[lane_turn[lane] % len(present)]
            lane_turn[lane] += 1
            picked.append(next(p for p in candidates if p.program == chosen))
        for prp in others:  # then fill any idle lane by priority
            if len(picked) >= WIP:
                break
            if prp not in picked:
                picked.append(prp)
        rounds.append(picked)
        done |= {p.name for p in picked}
        todo = [p for p in todo if p.name not in done]
    return rounds, blocked, awaiting, todo


def link(prp: Prp) -> str:
    return f"[`{prp.name}`](../{prp.path.split('/', 1)[1]})"


def render_schedule(prps: list[Prp]) -> str:
    rounds, blocked, awaiting, stuck = schedule(prps)
    out: list[str] = []
    add = out.append
    add("# Global schedule: what runs together, across programs\n")
    add("Generated by `python tools/prp/gen_plan.py`. Do not hand-edit; change the PRP frontmatter and regenerate.\n")
    add(
        f"Rules: at most **{WIP}** PRPs per round (WIP limit), at most **one** bicep PRP per round "
        "(the bicep slot, [`INTERLOCK.md`](INTERLOCK.md) section 1), and a PRP enters a round only when every "
        "`depends_on` and `Cross-program order` PRP is in an earlier round. A round is an ordering, not a calendar: "
        "start the next round's PRP in a lane as soon as that lane's PRP merges and its dependencies are met.\n"
    )
    add(
        "What this does NOT establish: that two PRPs in a round own disjoint files. That is checked from the "
        "`Owns` sections. Per-program wave numbers are local to a program and are shown only for reference.\n"
    )
    add(
        "After every round: `make validate` and `python -S -E ~/.claude/kits/orchestrated-prp/prp_index.py check --root .` "
        "must both exit 0 on `main`. Done means deployed and verified live; until then report merged, not deployed.\n"
    )
    add("## Rounds\n")
    add("| Round | Bicep slot | Lane | Lane | Lane | Lane |\n|---|---|---|---|---|---|")
    for index, picked in enumerate(rounds, 1):
        bicep = [p for p in picked if p.bicep == "yes"]
        rest = [p for p in picked if p.bicep != "yes"]
        cells = [link(bicep[0]) if bicep else "-"] + [link(p) for p in rest]
        cells += [""] * (5 - len(cells))
        add(f"| {index} | " + " | ".join(cells[:5]) + " |")
    add("")
    add("## Bicep queue (the order the single slot is taken)\n")
    add("| # | PRP | Program | Round |\n|---|---|---|---|")
    position = 0
    for index, picked in enumerate(rounds, 1):
        for prp in picked:
            if prp.bicep == "yes":
                position += 1
                add(f"| {position} | {link(prp)} | {prp.program} | {index} |")
    add("")
    add("## Blocked (not scheduled)\n")
    add("\n".join(f"- {link(p)} ({p.program})" for p in blocked) or "_none_")
    add("")
    add("## Built, all items merged; deploy receipts still owed (treated as done for ordering only)\n")
    add("\n".join(f"- {link(p)} ({p.program})" for p in awaiting) or "_none_")
    add("")
    add("## Not schedulable (waits on a blocked PRP or an unmet dependency)\n")
    lines = []
    for prp in stuck:
        lines.append(f"- {link(prp)} waits on: {', '.join(prp.deps + prp.cross)}")
    add("\n".join(lines) or "_none_")
    add("")
    return "\n".join(out)


def render_plan(prps: list[Prp]) -> str:
    out: list[str] = []
    add = out.append
    names = {p.name for p in prps}
    ids = {p.name: f"n{i}" for i, p in enumerate(prps)}
    add("# Execution plan (generated from PRP frontmatter)\n")
    add("Generated by `python tools/prp/gen_plan.py`. Do not hand-edit; change the PRP and regenerate.")
    add(
        f"Population: **{len(prps)}** PRP files with frontmatter under `PRPs/active` and `PRPs/backlog`. "
        "Cross-program ordering and the bicep queue: [`GLOBAL-SCHEDULE.md`](GLOBAL-SCHEDULE.md). "
        "Shared rules: [`INTERLOCK.md`](INTERLOCK.md).\n"
    )
    add("## Dependency graph\n")
    add("Solid edges are `depends_on`; dotted edges are `Cross-program order` lines.\n")
    add("```mermaid\nflowchart LR")
    for prp in prps:
        if not prp.is_hub:
            add(f'  {ids[prp.name]}["{prp.name}"]')
    for prp in prps:
        if prp.is_hub:
            continue
        for dep in prp.deps:
            if dep in names:
                add(f"  {ids[dep]} --> {ids[prp.name]}")
        for dep in prp.cross:
            add(f"  {ids[dep]} -.-> {ids[prp.name]}")
    add("```\n")
    add("## Per-program waves (wave numbers are local to each program)\n")
    grouped: dict[str, list[Prp]] = collections.defaultdict(list)
    for prp in prps:
        grouped[prp.program].append(prp)
    for program in sorted(grouped, key=program_rank):
        add(f"### {program}\n")
        add("| PRP | Status | Wave | Blocked-by | Bicep | Branch |\n|---|---|---|---|---|---|")
        members = sorted(
            (p for p in grouped[program] if not p.is_hub),
            key=lambda p: (int(p.wave) if p.wave.isdigit() else 999, p.order, p.name),
        )
        for prp in members:
            deps = ", ".join(prp.deps + [f"{c} (cross-program)" for c in prp.cross]) or "-"
            add(f"| {link(prp)} | {prp.status} | {prp.wave} | {deps} | {prp.bicep} | `{prp.branch}` |")
        add("")
    add("## Kickoff prompts\n")
    add("Lifted verbatim from each PRP's own `Kickoff prompt` section. One PRP per fresh session.\n")
    missing: list[str] = []
    for prp in prps:
        if prp.is_hub:
            continue
        if not prp.kickoff:
            missing.append(prp.name)
            continue
        add(f"### {prp.name}\n")
        add("```text\n" + prp.kickoff.strip("`").strip() + "\n```\n")
    if missing:
        add("## PRPs with no Kickoff prompt section\n")
        add(", ".join(f"`{name}`" for name in missing) + "\n")
    return "\n".join(out)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="exit 1 if a generated doc is stale")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]  # tools/prp/gen_plan.py -> repo root
    prps = load(root)
    if not prps:
        print(f"no PRPs with frontmatter found under {root / 'PRPs'}", file=sys.stderr)
        return 2
    targets = {
        root / "PRPs/reference/EXECUTION-PLAN-2026-11.md": render_plan(prps),
        root / "PRPs/reference/GLOBAL-SCHEDULE.md": render_schedule(prps),
    }
    stale = False
    for path, content in targets.items():
        content = content.rstrip() + "\n"
        current = path.read_text(encoding="utf-8").replace("\r\n", "\n") if path.exists() else None
        if current == content:
            continue
        if args.check:
            print(f"stale: {path.relative_to(root).as_posix()}", file=sys.stderr)
            stale = True
        else:
            path.write_text(content, encoding="utf-8", newline="\n")
            print(f"wrote {path.relative_to(root).as_posix()}")
    return 1 if stale else 0


if __name__ == "__main__":
    sys.exit(main())
