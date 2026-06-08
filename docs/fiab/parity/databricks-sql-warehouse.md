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
| 8 | Explorer: views + user functions nodes (Unity Catalog) |
| 9 | Row-count badge on views |
| 10 | Script object as CREATE / DROP |

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
| 8 | ✅ | `/schema` leaf level adds `SHOW VIEWS` + `SHOW USER FUNCTIONS`; tree shows Eye/MathFormula leaves. Views subtracted from `SHOW TABLES` so each appears once. |
| 9 | ✅ | View count: lazy `SELECT COUNT(*)` via `/query` on expand (real statement-execution). |
| 10 | ✅ | `…` menu → `/script-out` → `SHOW CREATE TABLE` (views) / `SHOW CREATE FUNCTION` (UDFs) for CREATE; server-built `DROP … IF EXISTS` for DROP. |

## Backend per control
- All controls → Databricks SQL Statement Execution + Warehouses REST via Console UAMI.
- Object enumeration → `SHOW VIEWS` / `SHOW USER FUNCTIONS`; script-out → `SHOW CREATE TABLE` / `SHOW CREATE FUNCTION`.

Grade: **A (warehouse lifecycle + edit/scale + UC explorer with views/functions + row counts + script-out + query + history all real Databricks REST).**

> **rev.2 — corrected against current code (PR #545).** Added row 7 (edit/scale warehouse) as ✅ built — the editor now has a real Edit dialog POSTing `/sql/warehouses/{id}/edit` through a real route + client. Grade unchanged (already A); inventory now reflects the scale capability.
> **rev.3 — Explorer completion.** Added rows 8–10: views + user functions nodes, lazy view row-counts, and CREATE/DROP script-out over `SHOW CREATE TABLE`/`SHOW CREATE FUNCTION`.
