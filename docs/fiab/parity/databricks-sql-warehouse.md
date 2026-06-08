# databricks-sql-warehouse — parity with Azure Databricks SQL Warehouse

Source UI: Databricks SQL — https://learn.microsoft.com/azure/databricks/sql/
Editor: `DatabricksSqlWarehouseEditor` in `apps/fiab-console/lib/editors/databricks-editors.tsx`

## Feature inventory

| # | Capability |
|---|---|
| 1 | Warehouse picker |
| 2 | Catalog / schema / table explorer (Unity Catalog) |
| 3 | SQL editor + Run + results grid |
| 4 | Start / Stop warehouse |
| 5 | Query history |
| 6 | New SQL query |
| 7 | Edit / scale warehouse (size, min/max clusters, auto-stop, type, serverless) |
| 8 | Run selection (execute only highlighted text) |
| 9 | Cancel a running query |
| 10 | Multi-tab query editor |
| 11 | Schema-aware IntelliSense (catalog/schema/table/column completions) |
| 12 | Catalog picker for 3-/4-part cross-catalog queries |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | `/warehouses` picker |
| 2 | ✅ | `/schema?warehouseId=&catalog=&schema=` lazy tree (Unity Catalog) |
| 3 | ✅ | `/query` (statement-execution REST) + results grid |
| 4 | ✅ | `/start` + `/state` (warehouses REST) |
| 5 | ✅ | `/query-history` with filters |
| 6 | ✅ | `New SQL query` resets editor |
| 7 | ✅ | **Edit / scale built.** Ribbon + toolbar **Edit** opens a dialog pre-filled from the live warehouse state (size/min-max clusters/auto-stop/type/serverless); **Save** → `POST /api/items/databricks-sql-warehouse/[id]/edit?warehouseId=` (`databricks-editors.tsx:359-385`) → route `app/api/items/databricks-sql-warehouse/[id]/edit/route.ts` → `editWarehouse()` → real `POST /api/2.0/sql/warehouses/{id}/edit` (`databricks-client.ts:175-196`, reads existing to preserve name/type, enum errors surfaced verbatim). |
| 8 | ✅ | `getRunSql()` (`sql-run-selection.ts`) — if Monaco has a non-empty selection, only that text is sent to `/query`; else the full editor text (SSMS / ADS behaviour). |
| 9 | ✅ | **Cancel** button (visible while a query runs) → `POST /[id]/cancel` `{clientQueryId}` → `cancelByClientId()` resolves the registered `statement_id` → `POST /api/2.0/sql/statements/{id}/cancel`. Canceled runs surface as a `warning` MessageBar. |
| 10 | ✅ | Multi-tab via `useSqlTabs` + `SqlTabBar` (`sql-editor-kit.tsx`) — per-tab SQL/result/loading/queryId; `+` adds, `×` closes. |
| 11 | ✅ | `registerSqlIntelliSense` (`sql-intellisense.ts`) Monaco completion provider fed from `/schema` (SHOW CATALOGS/SCHEMAS/TABLES + DESCRIBE TABLE columns, cached per warehouse). |
| 12 | ✅ | Toolbar **Catalog** dropdown sets query context; 3-/4-part `catalog.schema.table` resolves natively in Unity Catalog. |

## Backend per control
- All controls → Databricks SQL Statement Execution + Warehouses REST via Console UAMI.

Grade: **A (warehouse lifecycle + edit/scale + UC explorer + query + history + run-selection + cancel + multi-tab + schema IntelliSense + catalog picker all real Databricks REST).**

> **rev.2 — corrected against current code (PR #545).** Added row 7 (edit/scale warehouse) as ✅ built — the editor now has a real Edit dialog POSTing `/sql/warehouses/{id}/edit` through a real route + client. Grade unchanged (already A); inventory now reflects the scale capability.
>
> **rev.3 — SQL-editor parity sweep.** Added rows 8–12 (run-selection, Cancel via Statement Execution `/cancel`, multi-tab tab bar, schema-aware IntelliSense, catalog picker for cross-catalog queries). All Azure-native (Unity Catalog REST); no Fabric/Power BI on the default path.
