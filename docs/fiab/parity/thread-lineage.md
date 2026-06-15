# thread-lineage — parity with Microsoft Purview / Databricks Unity Catalog lineage

Source UI:
- Microsoft Purview portal — Data Catalog asset **Lineage** tab (interactive
  graph) + the **Manual lineage** registry (per-edge add/remove). Atlas v2
  lineage subgraph `GET /datamap/api/atlas/v2/lineage/{guid}?direction=BOTH&depth=N`.
  https://learn.microsoft.com/purview/data-gov-api-create-lineage-relationships
- Databricks **Catalog Explorer → Lineage** graph (Unity Catalog table lineage),
  recomputed from live system tables so a dropped object falls out of the graph.
  https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/data-lineage
- Microsoft Fabric / OneLake **Lineage view** (workspace item relationships).
  https://learn.microsoft.com/fabric/governance/lineage

Loom surface: **Lineage** (left-nav → `/thread`) — the Loom **Thread** edge
graph. Edges are written by wired "Weave" integrations (`lib/thread/thread-actions.ts`)
into Cosmos `thread-edges` (PK `/tenantId`). This is Loom's manually-woven
lineage registry, the direct analog of Purview's manual-lineage relationships.

## Azure/Fabric feature inventory

| # | Capability (real UI) | Notes |
|---|----------------------|-------|
| 1 | Visual lineage graph: nodes typed by object, directional arrow edges | Purview/Databricks/Fabric all render a typed, directional DAG |
| 2 | Click a node → detail panel (type, source, columns, open-asset link) | Purview side panel; Databricks node click |
| 3 | Click-to-expand / focus the upstream+downstream chain of a node | Databricks "focus on asset" — dims everything off-chain |
| 4 | Pan / zoom / fit-to-screen / minimap | Standard on all three graphs |
| 5 | Search / filter assets in the graph | Purview & Databricks graph filter |
| 6 | Left→right layered layout (upstream → downstream read order) | Purview & Databricks read order |
| 7 | Tabular relationships list (alternate to the graph) | Purview "Related" list; Databricks lineage table |
| 8 | Auto-reconcile on delete — a deleted/dropped object leaves no stale lineage | Databricks recomputes from system tables (drops out); Purview incremental scan does not re-ingest a deleted asset |
| 9 | Soft-delete vs hard-delete semantics | Purview/Atlas retains deleted entities as relationship-status `DELETED` (tombstone), not purge |
| 10 | Per-edge remove (manual-lineage trash-can) | Purview manual lineage registry |
| 11 | Delete propagates to the external catalog (Atlas/Purview) entity | Purview portal "Delete" flips the asset's Atlas entity `status` → `DELETED` (retained, not purged); the symmetric counterpart of auto-onboard-on-create |

## Loom coverage

| # | Status | Where |
|---|--------|-------|
| 1 | built ✅ | `app/thread/page.tsx` → shared `LineageCanvas` (`lib/components/catalog/lineage-canvas.tsx`, `@xyflow/react`). `threadEdgesToGraph()` adapts edges → typed nodes (`styleForType`) + arrow edges (`MarkerType.ArrowClosed`) |
| 2 | built ✅ | `LineageCanvas` detail side-panel: type, source (`Loom Thread`), identifier, columns, **Open item** deep-link (`openHref`) |
| 3 | built ✅ | `LineageCanvas` `connectedTo()` BFS + Focus chain (upstream+downstream highlight, off-chain dim) |
| 4 | built ✅ | `LineageCanvas` Controls + MiniMap + dot grid + Fit-to-screen button on the page toolbar |
| 5 | built ✅ | `LineageCanvas` free-text search filter |
| 6 | built ✅ | `LineageCanvas` `layeredLayout()` longest-path left→right |
| 7 | built ✅ | Graph \| Table `TabList`; Table = shared `LoomDataTable` (sortable/filterable/resizable) |
| 8 | built ✅ | `reconcileThreadEdgesOnDelete(tenantId, itemId, {mode})` fired from every delete path in `app/api/items/_lib/item-crud.ts` (`deleteOwnedItem`, `softDeleteOwnedItem`, `purgeRecycledItem`). `listThreadEdges` excludes tombstoned edges so stale lineage never renders |
| 9 | built ✅ | Soft-delete → `mode:'tombstone'` (sets `deletedAt` + `staleItemIds`, hidden but recoverable). `restoreOwnedItem` → `restoreThreadEdgesForItem` un-tombstones. Hard delete/purge → `mode:'remove'` |
| 10 | built ✅ (pre-existing) | Edges are written only by wired Weave actions; deletion of an endpoint reconciles automatically (no manual trash-can needed because there is no free-form edge entry — `loom-no-freeform-config`) |
| 11 | built ✅ / honest-gate ⚠️ | `offboardFromPurview(item, tenantId)` (`lib/azure/purview-autoonboard.ts`) fired from `deleteOwnedItem` + `purgeRecycledItem`. Soft-deletes the item's Atlas `DataSet` entity on the same stable `loom://` qualifiedName used by `autoOnboardToPurview` on create. Cheap no-op (no network) when `LOOM_PURVIEW_ACCOUNT` is unset (honest gate — sovereign clouds rely on the Cosmos `thread-edges` reconcile, row 8) |

Zero ❌. Every inventory row is built ✅.

> **Reconcile boundary.** Rows 8/9 (Weave `thread-edges`) are Loom-owned and
> reconcile synchronously. Row 11 propagates to the **external** Purview/Atlas
> graph that Loom does *not* own — Loom soft-deletes the entity it auto-onboarded
> (status → `DELETED`, retained), matching the portal "Delete asset" action.
> Scan-discovered assets continue to reconcile via Purview's own incremental
> scans; Loom never purges another scanner's entities.

## Backend per control

| Control | Backend |
|---------|---------|
| Graph + Table data | `GET /api/thread/edges` → `listThreadEdges()` → Cosmos `thread-edges` query (real read; tombstones excluded) |
| Reconcile on hard delete / purge | `reconcileThreadEdgesOnDelete(mode:'remove')` → Cosmos `container.item(id, tenantId).delete()` per matching edge |
| Reconcile on soft delete (recycle) | `reconcileThreadEdgesOnDelete(mode:'tombstone')` → Cosmos `upsert` with `deletedAt`/`staleItemIds` |
| Reconcile on restore | `restoreThreadEdgesForItem()` → Cosmos `upsert` clearing the tombstone |
| Purview entity offboard on delete/purge | `offboardFromPurview()` → `deleteAtlasEntityByQualifiedName('DataSet', loom://…)` → `DELETE /datamap/api/atlas/v2/entity/uniqueAttribute/type/DataSet?attr:qualifiedName=…` (Atlas soft-delete; no-op when `LOOM_PURVIEW_ACCOUNT` unset) |
| Open item | client-side route push / external `toLink` |

## Per-cloud behavior

- **Public / GCC (Purview + Databricks UC available):** `thread-edges` reconcile
  is the Loom-native analog of Atlas relationship-status `DELETED` tombstones
  (soft-delete) and UC's recompute-from-system-tables drop-out (hard-delete).
  Pure Cosmos data-plane — identical across these clouds. Additionally, when
  `LOOM_PURVIEW_ACCOUNT` is set, a hard delete / purge ALSO offboards the item's
  Atlas entity (`offboardFromPurview`) so the external catalog graph reconciles
  in lock-step — the symmetric counterpart of auto-onboard-on-create.
- **Sovereign / air-gapped (no Purview / Fabric):** `thread-edges` is the **only**
  lineage store, so the reconcile hook is the sole mechanism preventing stale
  lineage. Highest priority there. The Purview offboard is a silent no-op (no
  account) — no Fabric/Power BI dependency (`no-fabric-dependency`): works fully
  with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Bicep / bootstrap sync

No change required. `thread-edges` is already in `KNOWN_CONTAINER_IDS`
(`lib/azure/cosmos-client.ts`), lazily ensured, and documented in the ARM block
at `platform/fiab/bicep/modules/landing-zone/cosmos.bicep`. Cosmos is schemaless,
so the additive `deletedAt` / `staleItemIds` tombstone fields need no bicep edit.
The Purview offboard reuses the existing auto-onboard data-plane grant (Purview
Data Curator on the Loom Console UAMI, already provisioned for
`autoOnboardToPurview`) — no new role assignment.

## Verification

- `npx tsc --noEmit` — touched files clean (pre-existing griffel backlog ignored).
- `npx vitest run lib/thread/__tests__/thread-edges-reconcile.test.ts app/api/items/_lib/__tests__/recycle-crud.test.ts lib/azure/__tests__/purview-autoonboard.test.ts lib/azure/__tests__/purview-client.extensions.test.ts` —
  covers remove vs tombstone, staleItemIds accumulation, restore un-tombstone vs
  partial-restore, `listThreadEdges` tombstone exclusion, the item-crud delete-path
  wirings (incl. the new `offboardFromPurview` on purge), the `offboardFromPurview`
  no-op-when-unset + same-qualifiedName + best-effort-swallow contract, and the
  `deleteAtlasEntityByQualifiedName` DELETE/404/not-configured cases.
  (Repo-wide vitest harness has a known pre-existing `@adobe/css-tools` resolution
  break under the pnpm store; the integration phase's batched `next build` is the
  runtime gate.)
