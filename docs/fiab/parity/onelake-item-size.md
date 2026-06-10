# onelake-item-size — parity with Fabric OneLake item storage

**Source UI:** Microsoft Fabric — OneLake catalog / workspace storage usage per
item ("OneLake — item storage"). Background:
- https://learn.microsoft.com/fabric/onelake/onelake-consumption
- https://learn.microsoft.com/fabric/enterprise/metrics-app-storage-page
- https://learn.microsoft.com/azure/storage/blobs/soft-delete-blob-overview

Loom surface: **OneLake catalog → Storage tab** (`/onelake`, `pageTab=storage`).
Source Fabric Build 2026 ask **#9** (item-level storage usage incl. system +
soft-deleted, on-demand refresh).

## Azure/Fabric feature inventory

| # | Capability (Fabric OneLake item storage) | Notes |
|---|------------------------------------------|-------|
| 1 | Per-item storage usage (bytes) across the workspace's data items | Lakehouse / Warehouse / DB / Mirrored / KQL |
| 2 | System / metadata files counted toward item storage | Delta `_delta_log/`, checkpoints, `_SUCCESS` markers |
| 3 | Soft-deleted data still billed during the retention window | Surfaced separately from live data |
| 4 | Workspace roll-up totals (total billed storage) | Sum across items |
| 5 | On-demand refresh of the figures | Walk re-runs on request |
| 6 | Largest-consumers ordering for cleanup | Sort by total size |
| 7 | Drill to the item / its storage location | Location string per item |

## Loom coverage

| # | Capability | Status | How |
|---|------------|--------|-----|
| 1 | Per-item usage | ✅ built | `aggregatePrefixUsage()` recursive ADLS Gen2 `listPaths` over each item's `state.provisioning.secondaryIds.{container,rootPath}` prefix |
| 2 | System files included + broken out | ✅ built | `SYSTEM_PATH_RE` tags `_delta_log/`, checkpoints, `_SUCCESS`, `_metadata`, `_committed_*`, `_started_*`, `_temporary`; included in `liveBytes`, also reported as `systemBytes` |
| 3 | Soft-deleted bytes | ✅ built | blob `listBlobsFlat({ prefix, includeDeleted:true })` summing `deleted` blobs' `contentLength` (HNS blob soft-delete, enabled by `storage.bicep`) |
| 4 | Roll-up totals | ✅ built | route computes `totals` (live/system/deleted/total + file counts); UI score cards + composition bar |
| 5 | On-demand refresh | ✅ built | `force-dynamic` + `cache:'no-store'` + a **Refresh** button that re-walks live storage; `refreshedAt` timestamp shown |
| 6 | Largest-first ordering | ✅ built | route sorts items by `totalBytes` desc |
| 7 | Item location | ✅ built | `location = "<container>/<rootPath>"` column; null for items with no DLZ ADLS backing (honest per-item reason) |
| — | DLZ not deployed | ⚠️ honest-gate | 503 `adls_not_configured` → Fluent MessageBar naming `LOOM_BRONZE_URL` + `data-landing-zone.bicep` |
| — | RBAC missing | ⚠️ honest-gate | per-item 403 → reason naming **Storage Blob Data Reader** on the DLZ account |

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend |
|---------|---------|
| Refresh / initial load | `GET /api/onelake/storage[?workspaceId=]` → Cosmos item query (tenant-scoped by workspace ownership) → per-item `aggregatePrefixUsage()` |
| Live-bytes walk | `@azure/storage-file-datalake` `DataLakeFileSystemClient.listPaths({recursive:true})` on the `.dfs` host |
| Soft-deleted walk | `@azure/storage-blob` `ContainerClient.listBlobsFlat({includeDeleted:true})` on the `.blob` host |
| Item → ADLS prefix | resolved server-side from Cosmos `state` (secondaryIds → resourceId → legacy state → abfss URI) |

## No-Fabric / no-vaporware compliance

- **No Fabric dependency:** works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. Both
  walks hit the DLZ storage account on sovereign-correct `.dfs` / `.blob` hosts
  (parsed from `LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL`). No `api.fabric.microsoft.com`,
  no OneLake REST host.
- **Real backend:** every figure comes from a live storage walk; no mock arrays,
  no `return []`. The only non-functional state is the honest infra/RBAC gate.

## Bicep / bootstrap sync

No new Azure resource, env var, role assignment, or Cosmos container. The feature
reuses infrastructure already deployed:
- **ADLS Gen2 containers** + `.dfs`/`.blob` endpoints — `landing-zone/storage.bicep`
  (`LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL`).
- **Blob soft-delete** (`deleteRetentionPolicy.enabled = true`) — already set in
  `landing-zone/storage.bicep`; this is what makes soft-deleted bytes enumerable.
- **Storage Blob Data Reader/Contributor** for the Console UAMI on the DLZ account
  — already granted by the landing-zone RBAC modules.
