# sql-database-performance — parity with Azure SQL **Query Performance Insight** / SSMS **Query Store**

Source UI:
- Azure portal → SQL database → *Intelligent Performance* → **Query Performance Insight**
  (https://learn.microsoft.com/azure/azure-sql/database/query-performance-insight-use)
- SSMS → Database → **Query Store** dashboards (Top Resource Consuming Queries,
  Tracked Queries, Overall Resource Consumption)
  (https://learn.microsoft.com/sql/relational-databases/performance/monitoring-performance-by-using-the-query-store)

Backend: 100% Azure-native over the real Query Store catalog views
(`sys.query_store_*`) via live TDS. **No Microsoft Fabric / Power BI dependency.**
Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

Loom surface:
- Editor tab `Performance` on `unified-sql-database-editor.tsx` (Azure SQL family)
- Component `lib/editors/components/sql-performance-dashboard.tsx`
- BFF `POST /api/items/azure-sql-database/[id]/performance`
- Data-plane `lib/azure/sql-objects-client.ts` (`queryStoreStatus`,
  `topQueriesByMetric`, `queryTimeSeries`, `queryStorePlan`, `enableQueryStore`)

## Azure/Fabric feature inventory (Query Performance Insight + Query Store)

| # | Capability in the Azure portal / SSMS | Notes |
|---|----------------------------------------|-------|
| 1 | Top-N resource-consuming queries over a window | ranked list/bar chart |
| 2 | Metric selector: CPU, Duration, Logical reads, Execution count | drives ranking |
| 3 | Custom / preset time range (1h / 6h / 24h / 7d / 30d) | trailing window |
| 4 | Per-query drill-through to runtime-stats time series | select a query |
| 5 | Query text for the selected query | normalized SQL |
| 6 | Execution plan (showplan XML) for the query | plan store |
| 7 | Aggregate metric summary per query (CPU/duration/reads/execs) | tiles |
| 8 | Query Store status / operation mode (READ_WRITE/READ_ONLY/OFF) | health |
| 9 | Enable Query Store when OFF (ALTER DATABASE … QUERY_STORE = ON) | admin action |
| 10 | Capture mode + storage usage display | ALL/AUTO/NONE/CUSTOM, MB used/quota |

## Loom coverage

| # | Capability | State | How |
|---|------------|-------|-----|
| 1 | Top-N queries | ✅ | `action:'top-queries'` → `topQueriesByMetric` (CSS horizontal-bar chart, clickable) |
| 2 | Metric selector | ✅ | Fluent `Dropdown` (cpu/duration/logical-reads/executions) → `ORDER BY` alias |
| 3 | Time range | ✅ | Fluent `Dropdown` 1/6/24/168/720 h, clamped to `[1,720]` |
| 4 | Runtime-stats time series | ✅ | `action:'time-series'` → `queryTimeSeries`, inline SVG sparkline |
| 5 | Query text | ✅ | `LEFT(query_sql_text, 4000)` in the top-queries row, monospace pane + copy |
| 6 | Execution plan | ✅ | `action:'query-plan'` → `queryStorePlan` (`TRY_CAST(query_plan AS nvarchar(MAX))`), collapsible + copy |
| 7 | Aggregate summary tiles | ✅ | CPU/Duration/Logical reads/Executions chips in the detail pane |
| 8 | Query Store status badge | ✅ | `action:'status'` → `queryStoreStatus` (actual_state_desc) |
| 9 | Enable when OFF | ✅ | honest `MessageBar` gate → `action:'enable'` `confirm:true` → `enableQueryStore` DDL |
| 10 | Capture mode + storage | ✅ | `query_capture_mode_desc` + `current/max_storage_size_mb` in the status badge |

Top-N (Azure SQL only). PostgreSQL shows an honest `pg_stat_statements`
info MessageBar (that is its native equivalent — no Fabric).

Zero ❌, zero stub banners.

## Backend per control

| Control | Catalog views / DDL |
|---------|---------------------|
| Status badge / gate | `sys.database_query_store_options` (actual_state_desc, readonly_reason, *_storage_size_mb, query_capture_mode_desc) |
| Enable Query Store | `ALTER DATABASE CURRENT SET QUERY_STORE = ON (OPERATION_MODE = READ_WRITE)` |
| Top-N bar chart | `sys.query_store_query` ⋈ `_query_text` ⋈ `_plan` ⋈ `_runtime_stats` ⋈ `_runtime_stats_interval`, `SUM(avg_* * count_executions)`, `WHERE rsi.start_time >= DATEADD(HOUR, -N, GETUTCDATE())` |
| Time series | `sys.query_store_runtime_stats` ⋈ `_runtime_stats_interval` ⋈ `_plan` filtered by `query_id` (`@p0`) |
| Execution plan | `sys.query_store_plan` latest by `last_compile_start_time` for `query_id` (`@p0`) |

## Security / clamping

- `windowHours` clamped to `[1,720]`, `topN` to `[1,50]` as integer literals;
  `metric` resolves to a fixed column-alias map. The only per-row user value
  (`query_id`) is bound as `@p0` — no string-injection path.
- Reads require `VIEW DATABASE STATE` (subset of `db_datareader`); the enable
  DDL requires `ALTER` on the database. Failures surface verbatim (no fake
  success, no Fabric gate).

## Bicep / bootstrap

No new Azure resources, env vars, or role assignments. Reuses the existing
console UAMI → AAD-admin TDS pool and `LOOM_AZURE_SQL_HOST_SUFFIX`
(Commercial `database.windows.net`, Gov `database.usgovcloudapi.net`) already
wired for the Query / Schema tabs. Query Store is ON by default on Azure SQL
Database in all clouds; the enable path covers manually-disabled databases.

## Verification

`vitest run lib/azure/__tests__/sql-objects-perf-client.test.ts` covers the SQL
construction (views joined, metric ORDER BY, TOP/window clamping, `@p0`
parameter binding) and result shaping. Live receipt: a real `sys.query_store_*`
top-queries response with true CPU/duration metrics, a selected query's text +
runtime series, and the OFF→enable gate.
