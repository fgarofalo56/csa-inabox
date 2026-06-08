# onelake-recycle — parity with Microsoft Fabric workspace Recycle bin

Source UI: https://learn.microsoft.com/fabric/fundamentals/workspaces-recycle-bin
(+ ADLS Gen2 blob soft-delete: https://learn.microsoft.com/azure/storage/blobs/soft-delete-blob-overview)

Azure-native by default — no Microsoft Fabric / Power BI workspace required.
Cosmos is the source of truth for soft-delete state; ADLS Gen2 (HNS) blob
soft-delete is the recoverable data backing. GA all clouds (Commercial / GCC /
GCC-High / IL5) — DFS endpoints resolve per sovereign cloud via
`cloud-endpoints.ts`.

## Fabric/Azure feature inventory

| # | Capability (Fabric recycle bin) | Notes |
|---|---------------------------------|-------|
| 1 | Deleting an item removes it from the catalog/lineage and moves it to a recycle bin | Fabric: 7-day window; tenant-configurable |
| 2 | List deleted items with name, type, deleted-on, deleted-by | Recycle bin grid |
| 3 | Retention countdown / days-remaining before permanent purge | Fabric shows time left |
| 4 | Restore a deleted item back to active (item + its data) | `recover` |
| 5 | Permanently delete (purge) an item from the bin | hard delete |
| 6 | Underlying storage soft-delete + restore of the item's data | ADLS Gen2 directory soft-delete + undeletePath |
| 7 | Configurable retention window (admin) | days-to-keep |

## Loom coverage

| # | Coverage | Where |
|---|----------|-------|
| 1 | built ✅ | `DELETE /api/onelake/[itemId]` → `softDeleteOwnedItem()` stamps `state._recycled`; `by-type` + `listOwnedItems` filter `IS_DEFINED(c.state._recycled)` so the item leaves the catalog |
| 2 | built ✅ | `GET /api/onelake/recycle` → `RecycleView` grid: Name (typed icon), Type, Location, Deleted on, Deleted by, Days remaining |
| 3 | built ✅ | Days-remaining `Badge` (amber ≤ 7 days) computed from `purgeAfter`; tooltip shows the absolute auto-purge time |
| 4 | built ✅ | `POST /api/onelake/recycle { itemId }` → `restoreOwnedItem()` clears `_recycled`, calls `unDeleteDirectory(path, deletionId)` per ADLS ref, re-indexes search + governance |
| 5 | built ✅ | `DELETE /api/onelake/recycle?itemId=` → `purgeRecycledItem()` hard-deletes the Cosmos doc + index docs; confirm dialog warns it is unrecoverable through Loom |
| 6 | built ✅ | `softDeleteDirectory()` / `unDeleteDirectory()` in `adls-client.ts` over `@azure/storage-file-datalake` (delete returns `deletionId`; `undeletePath` restores). Captured in `state._recycled.adlsRefs` |
| 7 | built ✅ | `recycleRetentionDays` Bicep param (default 30) on the storage account `deleteRetentionPolicy` + `containerDeleteRetentionPolicy`; surfaced to the Console as `LOOM_RECYCLE_RETENTION_DAYS` so the UI countdown matches the actual storage retention |

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend |
|---------|---------|
| Delete (catalog details pane) | `DELETE /api/onelake/[itemId]` → Cosmos replace (`state._recycled`) + ADLS `softDeleteDirectory` (HNS) |
| Recycle-bin list | `GET /api/onelake/recycle` → cross-partition Cosmos query (`IS_DEFINED(c.state._recycled)`) + workspace-ownership tenant gate |
| Restore | `POST /api/onelake/recycle` → Cosmos replace (drop `_recycled`) + ADLS `undeletePath` + AI Search / governance re-index |
| Purge | `DELETE /api/onelake/recycle?itemId=` → Cosmos hard delete + AI Search / governance delete |
| Retention window | Storage `blobServices` `deleteRetentionPolicy.days = recycleRetentionDays` (Bicep) → env `LOOM_RECYCLE_RETENTION_DAYS` → UI |

## Verification (real-data E2E)

- `softDeleteOwnedItem` / `restoreOwnedItem` / `purgeRecycledItem` unit-covered
  in `app/api/items/_lib/__tests__/recycle-crud.test.ts` (7 tests, green) —
  asserts `_recycled` stamp + purgeAfter math, ADLS `deletionId` capture,
  un-delete on restore, tenant-ownership gating, and hard purge.
- `tsc --noEmit` clean on all touched files.
- Bicep `az bicep build` clean for storage / landing-zone / admin-plane / top
  orchestrators; compiled ARM contains `recycleRetentionDays` +
  `LOOM_RECYCLE_RETENTION_DAYS`.
