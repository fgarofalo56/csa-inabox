# Parity gap — `/workspaces/[id]` detail

**Loom route:** `/workspaces/[id]` (rendered by `apps/fiab-console/app/workspaces/[id]/page.tsx`)
**Fabric reference:** Microsoft Fabric Workspace view — items list within a workspace
**Loom screenshot:** `temp/parity/page-workspace-detail-loom.png` (real `async-e2e` workspace `de489967-…`)
**Captured:** 2026-05-26 — 5 real items displayed live

## Phase 3 — Side-by-side gap matrix

| # | Fabric Workspace element | Loom element | Status | Severity |
|---|---|---|---|---|
| 1 | Workspace name as page H1 | "async-e2e" rendered as H1 from `ws.name` | present | — |
| 2 | Workspace description sub-line | `ws.description` rendered in PageShell subtitle | present | — |
| 3 | "+ New item" primary action in header | `NewItemDialog` component with `workspaceId={ws.id}` — opens 2-pane Fabric-style item-type picker | present | — |
| 4 | "Workspace settings" / gear icon | `WorkspaceSettingsDrawer` button — opens drawer to manage capacity/domain/permissions | present | — |
| 5 | "← All workspaces" back link / breadcrumb | "All workspaces" subtle button with ArrowLeft icon, links to `/workspaces` | present | — |
| 6 | Item list grid (lakehouses, notebooks, warehouses, etc.) | Card grid showing 5 real items: KQL queryset, KQL database, Eventhouse, Eventstream, Notebook — each linking to `/items/[type]/[id]` | present | — |
| 7 | Item card metadata: type, owner, last-modified, sensitivity-label, endorsement | Loom card shows type, name, description (if any), "Updated MM/DD/YYYY" | partial — missing owner, sensitivity, endorsement badges | MAJOR |
| 8 | Filter / search within workspace | Not present | missing | MAJOR |
| 9 | View toggle (list / tile / lineage) | Not present (only grid view) | missing | MINOR |
| 10 | Domain / capacity meta in header | "No capacity" + domain shown in "Items" header line | present | — |
| 11 | "Manage permissions" button | Inside Workspace settings drawer (per component name) | present via drawer | — |
| 12 | "Settings" tabs: General, Permissions, Storage, Endorsements, Git, Spark, OneLake | Inside `WorkspaceSettingsDrawer` — need to verify each tab exists | partial | MAJOR — needs deeper audit |
| 13 | "Git integration" status indicator | Not visible on the list view; presumed inside Settings drawer | unknown | — |
| 14 | "Refresh" button | Implicit React Query refetch on remount; no explicit Refresh button | missing | MINOR |
| 15 | Empty state when 0 items | "No items in this workspace yet. Click 'New item' to add one." | present | — |
| 16 | Error states | Both `wsQ.error` and `itemsQ.error` show MessageBar with the real error message (including 404 "Workspace not found" as I confirmed visiting an invalid ID) | present + honest | — |

## Phase 4 — Functional verification

| Control | Verification | Result |
|---|---|---|
| Workspace H1 | Sourced from `getWorkspace(params.id)` → GET `/api/workspaces/[id]` | OK — real Cosmos read |
| Items grid | Sourced from `listItems(params.id)` → GET `/api/workspaces/[id]/items` | OK — 5 real items displayed |
| Item card link | href=`/items/[itemType]/[id]` — real route | OK |
| "All workspaces" back | href=`/workspaces` | OK |
| New item dialog | Opens 2-pane Fabric-style modal; on select → `createItem()` mutation → POST `/api/workspaces/[id]/items` → redirect to `/items/[type]/[id]` | OK — real backend wired |
| Workspace settings drawer | Component `WorkspaceSettingsDrawer` — need to verify tabs/actions | Not deep-validated this pass |
| Error state (404) | Visiting `/workspaces/uat-sandbox` (non-existent) shows `MessageBar intent="error"` with "Failed to load workspace: 404 : Workspace not found" | OK — honest |

## Backend reality check

`apps/fiab-console/app/api/workspaces/[id]/items/route.ts` queries Cosmos `itemsContainer` filtered by `workspaceId` partition. Real query. Items the user sees were created via real `createItem()` flows during prior UAT work.

## Honest grade

**Grade: B**

Reasoning:
- Phase 3: 0 BLOCKER, 3 MAJOR (item card metadata gaps, no filter, settings drawer parity needs deeper audit), 2 MINOR.
- Phase 4: 0 BROKEN — every visible control wires to a real backend.
- Real Cosmos data populates the items grid; new-item dialog is real; back navigation works; 404 handling is honest.

Not A because:
- Item cards are minimal — missing sensitivity labels, endorsement badges, owner avatars, last-modified-by user.
- No per-workspace filter / sort controls.
- WorkspaceSettingsDrawer component exists but was not opened/walked in this validation pass (open question whether all Fabric tabs are present: General, Permissions, Storage, Endorsements, Git, Spark, OneLake).

## Recommended next actions

1. Add filter input + sort selector above the items grid.
2. Enrich item cards with sensitivity label badge + endorsement badge + owner avatar.
3. Deep-audit `WorkspaceSettingsDrawer` against Fabric's 7-tab workspace settings panel.
4. Add per-item card overflow menu (Endorse, Move, Delete, Share, Get URL).
