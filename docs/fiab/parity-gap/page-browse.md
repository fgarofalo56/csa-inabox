# Parity gap — `/browse`

**Loom route:** `/browse` (rendered by `apps/fiab-console/app/browse/page.tsx`)
**Fabric reference:** Microsoft Fabric Browse — https://learn.microsoft.com/fabric/fundamentals (Browse pane shows Recent, Favorites, Shared with me, My data)
**Loom screenshot:** `temp/parity/page-browse-loom.png`
**Captured:** 2026-05-26

## Phase 3 — Side-by-side gap matrix

| # | Fabric Browse element | Loom Browse element | Status | Severity |
|---|---|---|---|---|
| 1 | Page header "Browse" | "Browse" page header with subtitle | present | — |
| 2 | "Recent" tab (items recently opened) | `RecentItems` component (reused from Home) — pulls from `/api/items/recent` | present | — |
| 3 | "Favorites" / starred items | Not surfaced as separate tab | missing | MAJOR |
| 4 | "Shared with me" tab | Not present — Loom doesn't have explicit "shared" surface yet | missing | MAJOR |
| 5 | "My data" tab (datasets owned by user) | Not present | missing | MINOR |
| 6 | "Endorsed in your org" tab | Not present | missing | MINOR |
| 7 | "Pinned" section | "Pinned" section — loads from `/api/user-prefs?key=pinnedItems`, shows pin grid with label/type per pin | present | — |
| 8 | Filter by type / time / owner | Not present | missing | MAJOR |
| 9 | Sort columns | Not present (single column view) | missing | MINOR |
| 10 | Empty states (per section) | "Nothing pinned yet" empty state + Recent items handles empty internally | present | — |
| 11 | View toggle (list/tile) | Not present | missing | MINOR |
| 12 | Bulk select / batch action | Not present | missing | MINOR |

## Phase 4 — Functional verification

| Control | Source | Result |
|---|---|---|
| Pin grid links | Each pin's `href` is loaded from `/api/user-prefs?key=pinnedItems` — real Cosmos read | OK |
| Recent items | `RecentItems` component → `/api/items/recent` | OK (verified 200 in initial session) |
| Loading state | `<Spinner size="tiny" label="Loading pins…">` | OK |
| Empty state | Honest "Nothing pinned yet" with explanation | OK |

## Honest grade

**Grade: C+**

Reasoning:
- Phase 3: 0 BLOCKER, 3 MAJOR (no Favorites/Shared-with-me/Filter), 4 MINOR.
- Phase 4: 0 BROKEN — what's there works.
- The page renders correctly, calls real APIs, shows honest empty states.
- BUT the page is **incomplete relative to Fabric**: Fabric's Browse has 4-5 distinct sections (Recent, Favorites, Shared with me, My data, Endorsed). Loom Browse has just 2 (Pinned + Recent), of which Recent is the same component as Home.
- It feels like a "lite" version of Home rather than a distinct Browse surface.

Not D because the controls that exist are real and the page is honest. Not B+ because the section count is half of Fabric's.

## Recommended next actions

1. Add a 4-tab structure: Recent / Favorites / Shared with me / My data — backed by real Cosmos queries per scope.
2. Add filter input + type filter chip + time filter (Today / This week / This month).
3. Add "Endorsed in your org" if endorsement metadata is tracked on items.
4. Add bulk-select with batch Move / Endorse / Pin / Delete actions.
