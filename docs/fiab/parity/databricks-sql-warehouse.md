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

## Backend per control
- All controls → Databricks SQL Statement Execution + Warehouses REST via Console UAMI.

Grade: **A (warehouse lifecycle + edit/scale + UC explorer + query + history all real Databricks REST).**

> **rev.2 — corrected against current code (PR #545).** Added row 7 (edit/scale warehouse) as ✅ built — the editor now has a real Edit dialog POSTing `/sql/warehouses/{id}/edit` through a real route + client. Grade unchanged (already A); inventory now reflects the scale capability.

> **T9 — Visualize + query parameters.** Added a **Visualize** toggle that renders an in-Loom chart (bar/line/area/pie/scatter + axis pickers) over the real result rows (`result-visualize.tsx`, client-side SVG — no Power BI). Added **query parameters**: `{{name}}` tokens auto-detected into widgets above the editor, rewritten to `:name` and sent in the Statement Execution API `parameters[]` array (bound by Databricks, never concatenated — injection-safe). Receipt returns `statement` + `parameters` + `parametersCount`. Grade unchanged (A).
