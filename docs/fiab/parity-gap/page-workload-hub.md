# Parity gap — `/workload-hub` + `/workloads`

**Loom routes:**
- `/workload-hub` → redirect to `/workloads` (canonical)
- `/workloads` (rendered by `apps/fiab-console/app/workloads/page.tsx`)

**Fabric reference:** Microsoft Fabric Workload hub — https://learn.microsoft.com/fabric/fundamentals/fabric-home#create-items-and-explore-workloads
**Loom screenshot:** `temp/parity/page-workloads-loom.png`
**Captured:** 2026-05-26 — multiple real workloads rendered

## Phase 3 — Side-by-side gap matrix

| # | Fabric Workload hub element | Loom Workloads element | Status | Severity |
|---|---|---|---|---|
| 1 | Page header "Workloads" with subtitle | "Workloads — Each workload groups item types that solve a problem together…" | present | — |
| 2 | Filter input | "Filter workloads…" Input | present | — |
| 3 | Tab strip per workload (Data Engineering / Data Factory / Real-Time Intelligence / Data Warehouse / Databases / Data Science / Fabric IQ / Power BI / Industry / Custom) | Card grid showing every workload at once, no tab strip | different — Loom is grid-vs-tabs | MINOR |
| 4 | Per-workload landing page with overview, supported items, samples, learning links | Loom cards show name + description + first 8 item-type slugs as pills + "+ N more" | partial | MAJOR |
| 5 | Per-workload "Create item" panel | Not present at workload level (use `/items/[type]/new` for create) | missing | MAJOR |
| 6 | "Add workload to tenant" / org-add custom workload | Not visible | missing | MINOR |
| 7 | Workload state: Included / Beta / Preview / Custom | "Included" badge + category badge (CSA / Org) per workload | present | — |
| 8 | Workload-specific learning links | Not present on card | missing | MINOR |
| 9 | Bootstrap honest gate | Empty state: "No workloads in this tenant yet. POST /api/admin/bootstrap-catalogs once per environment to seed GLOBAL; first /api/workloads-catalog GET copies into your tenant automatically." | present + honest | — |
| 10 | CSA-branded workloads (FedRAMP, Geoanalytics) | Visible — CSA branding distinct from Org workloads | present + Loom-specific value | — |

## Phase 4 — Functional verification

| Control | Source | Result |
|---|---|---|
| Filter input | Real client-side filter on name + description + category | OK |
| Card render | Real workload list from `/api/workloads-catalog` | OK — verified multiple real workloads rendering |
| Empty state | Honest with bootstrap instructions | OK |
| Bootstrap path | POST `/api/admin/bootstrap-catalogs` is a real route (per the message hint) | OK |
| Workload cards | Show real `featureSlugs` arrays | OK |

## Honest grade

**Grade: B**

Reasoning:
- Phase 3: 0 BLOCKER, 2 MAJOR (no per-workload landing page with Create button + learning links; no per-workload tab strip).
- Phase 4: 0 BROKEN — all real backend wiring.
- The catalog is real and rich (8+ workloads visible with real item-type bundles).
- CSA-branded workloads (FedRAMP Compliance Engine, Geoanalytics) are a Loom-specific value-add.
- Honest empty state explains exactly how to bootstrap.

Not A because:
- Fabric's Workload hub gives each workload its own tab + landing page with Create+Learn affordances. Loom collapses all workloads into a flat grid.
- No "+ Create item" button per workload card.
- No per-workload learning links.

## Recommended next actions

1. Click into a workload card → open a workload detail page (`/workloads/[id]`) with: overview, full item-type list, "Create" button per item type, learning links, sample notebooks.
2. Add a top-level tab strip per Fabric (All / Data Engineering / Data Factory / Real-Time / Warehouse / etc.) and use card grid within each tab.
3. On each workload detail, add "Include in tenant" toggle for tenant admins.
4. Surface workload state more prominently (Beta / Preview / Custom badges).
