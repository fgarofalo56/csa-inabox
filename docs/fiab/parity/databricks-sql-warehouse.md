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
| 8 | Save as table (CTAS) — materialize a SELECT into a Unity Catalog managed Delta table |
| 9 | Clone table (Delta SHALLOW = zero-copy / DEEP = full copy) |

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
| 8 | ✅ | **Save as table (CTAS) built.** Ribbon **Save as table** opens a catalog/schema/name dialog; **Create** → `POST /api/items/databricks-sql-warehouse/[id]/ctas` → `executeStatement()` runs `CREATE TABLE \`cat\`.\`sch\`.\`name\` USING DELTA AS <SELECT>` via `/api/2.0/sql/statements`; success receipt shows the created FQN. |
| 9 | ✅ | **Clone built (zero-copy verified).** Ribbon **Clone table** + per-table hover Clone button open a dialog (SHALLOW/DEEP + replace toggle); **Clone** → `POST /api/items/databricks-sql-warehouse/[id]/clone` → `CREATE [OR REPLACE] TABLE <target> [SHALLOW|DEEP] CLONE <source>`. The route surfaces `num_copied_files` from the CLONE metrics row, so SHALLOW proves zero-copy (0 files duplicated). SHALLOW dialog warns about VACUUM-on-source dependency. |

## Backend per control
- All controls → Databricks SQL Statement Execution + Warehouses REST via Console UAMI.

Grade: **A (warehouse lifecycle + edit/scale + UC explorer + query + history all real Databricks REST).**

> **rev.2 — corrected against current code (PR #545).** Added row 7 (edit/scale warehouse) as ✅ built — the editor now has a real Edit dialog POSTing `/sql/warehouses/{id}/edit` through a real route + client. Grade unchanged (already A); inventory now reflects the scale capability.
