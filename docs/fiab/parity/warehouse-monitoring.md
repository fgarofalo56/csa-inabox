# warehouse-monitoring — parity with Databricks SQL Warehouse Monitoring + Synapse Query Activity

Source UI:
- Databricks SQL Warehouse → **Monitoring** tab — running-clusters chart + query history
  (https://learn.microsoft.com/azure/databricks/sql/admin/sql-endpoints, /azure/databricks/sql/api/sql-warehouses)
- Azure Synapse Dedicated SQL pool → **Monitoring → SQL requests** / query activity, backed by
  `sys.dm_pdw_exec_requests` (https://learn.microsoft.com/sql/relational-databases/system-dynamic-management-views/sys-dm-pdw-exec-requests-transact-sql)

This surface is the Monitoring tab inside the SQL Warehouse editor
(`databricks-sql-warehouse`), the Synapse Dedicated SQL pool editor
(`synapse-dedicated-sql-pool`), and the Fabric-alias Warehouse editor
(`warehouse`, Azure-native default = Synapse dedicated pool).

## Azure/Fabric feature inventory

| # | Capability (real UI) | Notes |
|---|----------------------|-------|
| 1 | Running-clusters over time chart | Databricks SQL warehouse Monitoring plots cluster_count from warehouse events across a time window |
| 2 | Query load over time | Synapse query activity shows request volume over time |
| 3 | Recent query / request list | id, status, query text, duration, user, submit time |
| 4 | Time-window selector | last 30 min / hour / 3h / 24h |
| 5 | Refresh | re-pull live events |
| 6 | Status filtering on the request list | filter by Running / Finished / Failed |
| 7 | KPI summary (clusters now / peak / count) | at-a-glance header tiles |

## Loom coverage

| # | Status | Where |
|---|--------|-------|
| 1 | built ✅ | `WarehouseMonitoringTab` chart series "Running clusters" — `KqlChart` timechart over `clusterTimeline` from `GET /api/2.0/sql/warehouses/{id}/events` |
| 2 | built ✅ | Synapse branch series "Queries started (5-min buckets)" from `sys.dm_pdw_exec_requests` bucket aggregate |
| 3 | built ✅ | `LoomDataTable` recent-queries: status badge, submitted, duration, user, query text |
| 4 | built ✅ | window `Dropdown` (1800/3600/10800/86400 s) → `?window=` |
| 5 | built ✅ | Refresh button re-fetches |
| 6 | built ✅ | `LoomDataTable` per-column select filter on Status, text filter on User/Query, date filter on Submitted |
| 7 | built ✅ | KPI tiles: clusters now / peak / recent-query count |
| — | honest-gate ⚠️ | missing `LOOM_DATABRICKS_HOSTNAME` / `LOOM_SYNAPSE_WORKSPACE` → 503 `not_configured` MessageBar naming the env var; paused Synapse pool → 409 `pool_paused` MessageBar with resume instruction |

Zero ❌. Zero stub banners. The "Raw events payload (receipt — first 5)" section
renders the live backend records as the no-vaporware receipt.

## Backend per control

| Control | Engine | Real backend call |
|---------|--------|-------------------|
| Running-clusters chart | Databricks | `GET /api/2.0/sql/warehouses/{warehouseId}/events` (AAD bearer, `listWarehouseEvents`) |
| Recent queries | Databricks | `GET /api/2.0/sql/history/queries` (`listQueryHistory`) |
| Query-load chart | Synapse / warehouse | TDS `executeQuery(dedicatedTarget(), synapseTimelineSql())` → `sys.dm_pdw_exec_requests` 5-min bucket aggregate |
| Recent requests | Synapse / warehouse | TDS `executeQuery(dedicatedTarget(), synapseRecentRequestsSql())` → `SELECT TOP 50 … FROM sys.dm_pdw_exec_requests ORDER BY submit_time DESC` |
| Pool-state gate | Synapse / warehouse | `getPoolState()` (ARM) — 409 when not Online |

## No-Fabric / no-vaporware compliance

- No Fabric / Power BI hosts on any path. Databricks events are Azure Databricks
  REST; Synapse DMV is Azure Synapse Analytics. Works with
  `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- No mock arrays — every value comes from a live REST/TDS response; the pure
  shaping helpers (`lib/azure/warehouse-monitoring.ts`) are unit-tested
  (`lib/azure/__tests__/warehouse-monitoring.test.ts`, 11 tests).

## Bicep sync

No new Azure resources, env vars, or role assignments. The route reuses
`LOOM_DATABRICKS_HOSTNAME`, `LOOM_SYNAPSE_WORKSPACE`, `LOOM_SYNAPSE_DEDICATED_POOL`
(already wired in `platform/fiab/bicep/modules/admin-plane/main.bicep`) and the
existing UAMI grants (Databricks workspace admin; Synapse SQL admin → `VIEW
DATABASE STATE` for the DMV). Nothing to add — no drift.

## Verification

- `npx tsc --noEmit` → 0 errors project-wide.
- `vitest run lib/azure/__tests__/warehouse-monitoring.test.ts` → 11 passed.
- Live receipt: `GET /api/items/databricks-sql-warehouse/<id>/monitoring?warehouseId=<wid>`
  returns `clusterTimeline` from real warehouse events + `rawEvents` payload;
  `GET /api/items/synapse-dedicated-sql-pool/<id>/monitoring` returns real DMV rows
  (or the documented 409/503 gate).
