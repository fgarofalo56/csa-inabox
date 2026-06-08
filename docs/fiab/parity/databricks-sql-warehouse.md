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
| 11 | Save as table (CTAS) — materialize a SELECT into a Unity Catalog managed Delta table |
| 12 | Clone table (Delta SHALLOW = zero-copy / DEEP = full copy) |

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
| 11 | ✅ | **Save as table (CTAS) built.** Ribbon **Save as table** opens a catalog/schema/name dialog; **Create** → `POST /api/items/databricks-sql-warehouse/[id]/ctas` → `executeStatement()` runs `CREATE TABLE \`cat\`.\`sch\`.\`name\` USING DELTA AS <SELECT>` via `/api/2.0/sql/statements`; success receipt shows the created FQN. |
| 12 | ✅ | **Clone built (zero-copy verified).** Ribbon **Clone table** + per-table hover Clone button open a dialog (SHALLOW/DEEP + replace toggle); **Clone** → `POST /api/items/databricks-sql-warehouse/[id]/clone` → `CREATE [OR REPLACE] TABLE <target> [SHALLOW|DEEP] CLONE <source>`. The route surfaces `num_copied_files` from the CLONE metrics row, so SHALLOW proves zero-copy (0 files duplicated). SHALLOW dialog warns about VACUUM-on-source dependency. |

## Backend per control
- All controls → Databricks SQL Statement Execution + Warehouses REST via Console UAMI.
- Object enumeration → `SHOW VIEWS` / `SHOW USER FUNCTIONS`; script-out → `SHOW CREATE TABLE` / `SHOW CREATE FUNCTION`.

Grade: **A (warehouse lifecycle + edit/scale + UC explorer with views/functions + row counts + script-out + query + history all real Databricks REST).**

> **rev.2 — corrected against current code (PR #545).** Added row 7 (edit/scale warehouse) as ✅ built — the editor now has a real Edit dialog POSTing `/sql/warehouses/{id}/edit` through a real route + client. Grade unchanged (already A); inventory now reflects the scale capability.
> **rev.3 — Explorer completion.** Added rows 8–10: views + user functions nodes, lazy view row-counts, and CREATE/DROP script-out over `SHOW CREATE TABLE`/`SHOW CREATE FUNCTION`.

> **T9 — Visualize + query parameters.** Added a **Visualize** toggle that renders an in-Loom chart (bar/line/area/pie/scatter + axis pickers) over the real result rows (`result-visualize.tsx`, client-side SVG — no Power BI). Added **query parameters**: `{{name}}` tokens auto-detected into widgets above the editor, rewritten to `:name` and sent in the Statement Execution API `parameters[]` array (bound by Databricks, never concatenated — injection-safe). Receipt returns `statement` + `parameters` + `parametersCount`. Grade unchanged (A).
