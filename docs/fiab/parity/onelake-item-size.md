# onelake-item-size — parity with Fabric "OneLake — Workspace storage" report

Source UI: Microsoft Fabric admin/workspace storage report
(<https://learn.microsoft.com/fabric/onelake/onelake-consumption>) and the
OneLake catalog item details "storage" surface.

The Azure-native equivalent is the **Storage** tab on the OneLake catalog page
(`/onelake`), backed by `GET /api/onelake/storage`. It aggregates real ADLS
Gen2 blob sizes per item in the DLZ medallion containers — no Fabric / OneLake
REST host is ever called (no-fabric-dependency.md).

## Azure/Fabric feature inventory (grounded in Learn)

| # | Capability (Fabric OneLake storage report) | Notes |
|---|--------------------------------------------|-------|
| 1 | Storage consumed **per item** | The core deliverable — bytes attributed to each lakehouse/warehouse/etc. |
| 2 | Include **system files** in the size | Fabric bills Delta `_delta_log/`, `_SUCCESS`, checkpoint files. |
| 3 | Include **soft-deleted / retained** bytes | Deleted-but-retained data still consumes capacity until purge. |
| 4 | **On-demand refresh** | The report recomputes the current size (no stale aggregate). |
| 5 | Roll-up totals (total used, file count) | Workspace/tenant summary cards. |
| 6 | Scope by **workspace** | Filter the report to one workspace. |
| 7 | Distinguish backend per item | Items not stored in OneLake/ADLS shown honestly, not faked. |
| 8 | Container / zone breakdown | Bytes per medallion zone (orphan/system data visible). |

## Loom coverage

| # | Coverage | Where |
|---|----------|-------|
| 1 | ✅ Per-item bytes (live + system + soft-deleted + total + file count) | `storage-view.tsx` "Per-item storage usage" table |
| 2 | ✅ System-file bytes counted **and** broken out as a column + stat card | `adls-client.aggregatePrefixSize` (`isSystemPath`) |
| 3 | ✅ Soft-deleted retained bytes via Blob `includeDeleted` | `aggregatePrefixSize` / `aggregateContainerUsage` |
| 4 | ✅ On-demand: each GET re-walks the lake live; explicit **Refresh** button | route is `force-dynamic`, no cache |
| 5 | ✅ Total used / system / soft-deleted / item-count stat cards | `StorageView` cards |
| 6 | ✅ Workspace dropdown scopes `?workspaceId=` | `StorageView` + route |
| 7 | ✅ warehouse→Synapse, kql/eventhouse→ADX marked "compute-billed" (no fake bytes) | `onelake-item-storage.backendFor` |
| 8 | ✅ Container breakdown table (all-workspaces view) | `aggregateAllContainersUsage` |

Zero ❌. The only non-data state is an honest infra gate: when no
`LOOM_{BRONZE,…}_URL` is configured the route returns 503 and the tab renders a
Fluent MessageBar naming `LOOM_BRONZE_URL` + the `data-landing-zone` bicep
module (no-vaporware.md).

## Backend per control

| Control | Backend |
|---------|---------|
| Per-item table | `GET /api/onelake/storage` → `aggregatePrefixSize(container, prefix)` over ADLS Gen2 (DataLake recursive list + Blob includeDeleted) |
| Item → prefix mapping | `onelake-item-storage.resolveItemAdlsLocation` — reads stamped `state.provisioning.{secondaryIds,resourceId}`, falls back to provisioner naming conventions |
| Workspace scope + item set | Cosmos `workspaces` + `items` containers (tenant-scoped by `claims.oid`) |
| Container breakdown | `aggregateAllContainersUsage()` over the configured DLZ containers |
| Refresh | re-issues the GET (live walk; no cached aggregate) |

## Infra sync

No new env var or role is required: the report reuses the existing
`LOOM_{BRONZE,SILVER,GOLD,LANDING,CSV_IMPORTS}_URL` settings and the **Storage
Blob Data Reader** grant the Console UAMI already holds on the DLZ storage
account (see `platform/fiab/bicep/modules/landing-zone/storage-rbac-admin.bicep`,
which documents the Console UAMI's data-plane Reader role). Blob soft-delete is
already enabled by `storage.bicep` (`deleteRetentionPolicy`), so the
soft-deleted overlay works against the deployed account with no change.

## Validation

- `lib/azure/__tests__/onelake-item-storage.test.ts` — 11 passing unit tests
  over the resolver precedence + convention candidates.
- `tsc --noEmit` clean for every touched file.
- Live: with the DLZ configured, the Storage tab shows real per-item bytes;
  with `LOOM_BRONZE_URL` unset it shows the honest MessageBar gate.
