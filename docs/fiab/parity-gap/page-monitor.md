# Parity gap — `/monitor`

**Loom route:** `/monitor` (rendered by `apps/fiab-console/app/monitor/page.tsx` → `ActivityFeedPane`)
**Fabric reference:** Microsoft Fabric Monitor hub — https://learn.microsoft.com/fabric/admin/monitoring-hub
**Loom screenshot:** `temp/parity/page-monitor-loom.png`
**Captured:** 2026-05-26 — 3 real events from Cosmos

## Phase 3 — Side-by-side gap matrix

| # | Fabric Monitor hub element | Loom Monitor element | Status | Severity |
|---|---|---|---|---|
| 1 | Page header "Monitor" | "Monitor" with subtitle "Live job, edit, and share activity for every item in your tenant" | present | — |
| 2 | Filter by item type / status / submitter / time range | Not present | missing | MAJOR |
| 3 | Table view: Item name, Item type, Submitter, Status, Submitted time, Duration, Item subtype, Run | Single linear list — not tabular | different | MAJOR |
| 4 | Run status badges (Succeeded / Failed / In progress / Queued) | Activity-feed format only — no run-state coloring | different | MAJOR |
| 5 | Action: View error / View run details / Cancel / Re-run | Each entry links to item page but no per-row "cancel/re-run" action | missing | MAJOR |
| 6 | Pagination / load-more | Not visible (whatever fits in the feed) | missing | MAJOR |
| 7 | Group by / sort by | Not present | missing | MINOR |
| 8 | Refresh button | Not present (implicit React refetch) | missing | MINOR |
| 9 | Real-time stream toggle (auto-refresh) | Not present | missing | MINOR |
| 10 | Stats cards (RECENT EVENTS / IN LAST 24H / ACTIVE USERS) | Present — 3 / 0 / 1 from live feed | Loom richer here | — |

## Phase 4 — Functional verification

| Control | Source | Result |
|---|---|---|
| Activity feed | `ActivityFeedPane` → `/api/activity` Cosmos query joining audit + comments + shares | OK — 3 real events rendered |
| Item links | Each entry links to `/items/[type]/[id]` | OK |
| Stats cards | Computed client-side from the live feed | OK — no fake numbers |
| Empty state | Honest (no fake activity injected) | OK |

## Critical observation

**`/monitor` and `/governance` (main) render the same `ActivityFeedPane` component.** They are duplicate surfaces. Fabric distinguishes "Monitor hub" (jobs / scheduled runs / errors — operations-focused) from "Activity log" (audit trail — governance-focused). Loom currently conflates them.

Fabric Monitor hub specifically lists Spark jobs, Pipeline runs, Notebook executions, Dataflow refreshes — **per-run rows with state**. Loom's activity feed lists **per-event lines** (someone commented, someone shared) but no actual *running jobs* or *recent run states*.

## Honest grade

**Grade: C**

Reasoning:
- The page is real (no vaporware).
- It reuses the live activity feed correctly.
- BUT it does NOT show what Fabric Monitor hub shows: pipeline runs, notebook executions, dataflow refreshes with status / duration / submitter / error link.
- It overlaps 100% with `/governance` (same component).
- The "Monitor" branding promises operations-level visibility that the page doesn't deliver.

Not D because the page is honest and the underlying data is real. Not B because it's effectively a duplicate of `/governance` and misses the core Monitor-hub UX (per-run table with status badges).

## Recommended next actions

1. Diverge `/monitor` from `/governance` by adding a **runs table** — query `/api/runs` (would need a new endpoint) that surfaces pipeline / notebook / dataflow runs with status / duration / submitter / error.
2. Add per-row Cancel + Re-run actions (gated by no-vaporware MessageBar if the run backend isn't deployed).
3. Add filter chips: All / Failed / In progress / Succeeded / Cancelled.
4. Add time-range selector (Last hour / Last 24h / Last 7 days).
5. Add "Refresh" + "Auto-refresh every 30s" toggle.
6. Keep the existing activity feed as a secondary section ("Recent activity") below the runs table.
