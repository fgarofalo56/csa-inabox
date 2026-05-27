# Parity gap — `/onelake` OneLake catalog

**Loom route:** `/onelake` (rendered by `apps/fiab-console/app/onelake/page.tsx` → `ItemsByTypePane`)
**Fabric reference:** Microsoft Fabric OneLake catalog — https://learn.microsoft.com/fabric/onelake/onelake-catalog
**Loom screenshot:** `temp/parity/page-onelake-loom.png` — 5 real data items rendered
**Captured:** 2026-05-26

## Phase 3 — Side-by-side gap matrix

| # | Fabric OneLake catalog element | Loom OneLake catalog element | Status | Severity |
|---|---|---|---|---|
| 1 | Page header "OneLake catalog" | Present with full subtitle | present | — |
| 2 | Filter input | "Filter items by name or description…" input with search icon | present | — |
| 3 | + New item button | `NewItemDialog` (2-pane Fabric-style picker) | present | — |
| 4 | Item card grid: lakehouses, warehouses, KQL stores, eventhouses, mirrored DBs | 5 real items rendered: KQL database, Eventhouse, Lakehouse (RAG agent platform - Document corpus), Warehouse (test_DW), Lakehouse (test lakehous) | present + live data | — |
| 5 | Item type badge | "Real-Time Intelligence" / "Data Engineering" / "Data Warehouse" category badge per card | present | — |
| 6 | Last-modified date | "Updated MM/DD/YYYY" per card | present | — |
| 7 | "Browse" / "Open" action on each card | Card itself is a `Link` to `/items/[type]/[id]` | present | — |
| 8 | Endorsement badges (Promoted / Certified) | Not visible | missing | MAJOR |
| 9 | Sensitivity label per item | Not visible | missing | MAJOR |
| 10 | Owner avatar + name per item | Not visible | missing | MINOR |
| 11 | Domain badge | Not visible (workspace info not surfaced on card) | missing | MINOR |
| 12 | Type filter (lakehouse vs warehouse vs eventhouse) | Single text filter, no type-chip filter | partial | MINOR |
| 13 | "Get URL" / "Copy OneLake path" per item | Not present | missing | MAJOR |
| 14 | Lineage hint / icon | Not present (lineage is under `/governance/lineage`) | acceptable | — |
| 15 | Empty state | "No data items in this tenant yet" with hint to create via + New | present | — |

## Phase 4 — Functional verification

| Control | Source | Result |
|---|---|---|
| Filter input | Real client-side filter via `useMemo` on `displayName + description` | OK |
| + New item dialog | `NewItemDialog` opens Fabric-style 2-pane picker | OK |
| Item card link | href `/items/[type]/[id]` resolves to per-item editor | OK |
| Backend | `/api/items/by-type?type=lakehouse&type=warehouse&...` — real Cosmos query against itemsContainer with `IN` filter on itemType | OK |
| Auth handling | 401/403 → renders `SignInRequired` instead of error | OK — honest |

## Honest grade

**Grade: B**

Reasoning:
- Phase 3: 0 BLOCKER, 3 MAJOR (no endorsement, sensitivity, copy-OneLake-path), 4 MINOR.
- Phase 4: 0 BROKEN — every visible control wires to a real backend, 5 live items are real Cosmos records.
- Cards are clickable and resolve. Filter is functional. + New is real.

Not A because Fabric OneLake catalog surfaces endorsement + sensitivity prominently (key governance metadata) and offers "Copy OneLake path" as a primary card action. Also missing per-card owner.

## Recommended next actions

1. Add endorsement badge (Promoted / Certified) per card.
2. Add sensitivity label chip.
3. Add per-card overflow menu with "Copy OneLake path", "View lineage", "Get URL".
4. Add type-chip filter row above the search input.
5. Add owner avatar + workspace+domain on each card.
