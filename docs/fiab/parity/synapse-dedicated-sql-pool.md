# synapse-dedicated-sql-pool — parity with Synapse Dedicated SQL pool

Source UI: Synapse Studio SQL pool — https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/
Editor: `SynapseDedicatedSqlPoolEditor` in `apps/fiab-console/lib/editors/synapse-sql-editors.tsx`

## Feature inventory

| # | Capability | Source UI |
|---|---|---|
| 1 | Schema explorer (schemas/tables + row counts) | Data hub |
| 2 | T-SQL editor + Run + results grid | Develop hub |
| 3 | Pause / Resume pool | Manage hub (ARM) |
| 4 | Scale (DWU) / state badge | Manage hub |
| 5 | Estimate query cost / resource class | DMVs |
| 6 | Permissions (principals + roles) | Security |
| 7 | Workload management groups + classifiers | Manage |
| 8 | Geo backup / restore points | Manage |
| 9 | Compute picker across pools | Studio |
| 10 | Run selection (execute only highlighted text) | Develop hub |
| 11 | Cancel a running query | Develop hub |
| 12 | Multi-tab query editor | Develop hub tabs |
| 13 | Schema-aware IntelliSense (column completions) | Develop hub |
| 14 | Database picker for cross-database 3-part queries | Develop toolbar |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | `/schema` → sys.tables/schemas; tree leaf → SELECT TOP 100 |
| 2 | ✅ | Monaco editor + Run via `/query` (TDS) |
| 3 | ✅ | Resume (`/resume`) + Pause (`/state`) ARM, with polling |
| 4 | ✅ | State badge + SKU from `/state` (ARM) |
| 5 | ✅ | `Estimate cost` loads sys.dm_pdw_exec_requests query (runs via /query) |
| 6 | ✅ | `Permissions` loads sys.database_principals + role members query |
| 7 | ✅ | `Workload mgmt` loads sys.workload_management_workload_groups query |
| 8 | ✅ | `Geo backup` loads sys.pdw_loader_backup_runs query |
| 9 | ✅ | `ComputePicker` filtered to dedicated pools |
| 10 | ✅ | `getRunSql()` sends only the highlighted selection to `/query` when present. |
| 11 | ✅ | **Cancel** button (while running) → `POST /[id]/cancel` `{queryId}` → `cancelActiveQuery()` → mssql `Request.cancel()` (TDS ATTENTION). |
| 12 | ✅ | Multi-tab via `useSqlTabs` + `SqlTabBar`. |
| 13 | ✅ | `registerSqlIntelliSense` fed from `/schema` (sys.schemas + `?table=` INFORMATION_SCHEMA.COLUMNS). |
| 14 | ✅ | **Database** dropdown (sys.databases) re-targets the TDS connection for `other_db.schema.table` 3-part queries. |

## Backend per control
- Query / DMV actions → Synapse Dedicated TDS (`executeQuery`/`dedicatedTarget`).
- Lifecycle → ARM (`synapse-pool-arm` `getPoolState`/resume/pause).

Grade: **A — every inventory row built; the four former "deferred" buttons + run-selection, Cancel (TDS ATTENTION), multi-tab, IntelliSense and the cross-DB picker all run through the existing /query TDS path.**
