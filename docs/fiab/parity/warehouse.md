# warehouse — parity with Fabric Warehouse

Source UI: Fabric Warehouse — https://learn.microsoft.com/fabric/data-warehouse/query-warehouse · https://learn.microsoft.com/fabric/data-warehouse/sql-query-editor · https://learn.microsoft.com/fabric/data-warehouse/visual-query-editor · https://learn.microsoft.com/fabric/data-warehouse/manage-objects
Editor: `WarehouseEditor` in `apps/fiab-console/lib/editors/phase3-editors.tsx`
Backend: Warehouse compute is the Synapse Dedicated SQL pool (`/api/items/warehouse/[id]/*`).

## Fabric feature inventory

| # | Capability | Where in Fabric |
|---|---|---|
| 1 | Explorer — schemas / tables / views / SPs / functions | Left pane |
| 2 | Script-out objects via context menu (CREATE/ALTER/DROP) | Explorer `...` |
| 3 | New SQL query (T-SQL editor, IntelliSense, Run, Results/Messages) | Home ribbon |
| 4 | New visual query (no-code Power Query canvas, merge/join) | Home ribbon |
| 5 | Save as view (CREATE VIEW) | Results toolbar |
| 6 | Save as table (CTAS) | Results toolbar |
| 7 | Open in Excel (.iqy) | Results toolbar |
| 8 | Visualize results / Explore data | Results toolbar |
| 9 | Copy results (with/without headers) | Results toolbar |
| 10 | Model view — relationships + measures | Mode switcher |
| 11 | Permissions (object/row-level security) | Manage |
| 12 | Source control (Git integration) | Workspace ribbon |
| 13 | Cross-warehouse 3-part-name query | Editor |
| 14 | Run selection (execute only highlighted text) | Editor |
| 15 | Cancel a running query | Editor |
| 16 | Multi-tab query editor | Editor tab strip |
| 17 | Schema-aware IntelliSense (column completions) | Editor |
| 18 | Database picker for cross-database 3-part queries | Editor toolbar |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | Explorer tree from `/schema`: schemas/tables (sys.partitions row counts) **+ views / stored procedures / functions** (sys.views / sys.procedures / sys.objects FN·IF·TF via `lib/azure/sql-object-scripting.ts`). View leaves carry a lazy `SELECT COUNT_BIG(*)` badge. |
| 2 | ✅ | Per-node `…` menu → `/script-out` → real OBJECT_DEFINITION (Script as CREATE), CREATE OR ALTER (ALTER), or `DROP … IF EXISTS` (DROP). New measure also loads a CREATE FUNCTION template. |
| 3 | ✅ | Monaco T-SQL editor + Run via `/query` (Dedicated pool TDS); Results grid |
| 4 | ✅ | No-code visual Power-Query canvas (`lib/editors/components/visual-query-canvas.tsx`): drag tables from the Explorer (or Add-table picker), add Filter / Choose columns / Group by + aggregate / Keep top rows steps, Merge two chains with a 6-kind join picker, Applied-Steps inspector with controlled pickers (no freeform except the Filter WHERE box), live read-only generated-SQL pane (Monaco), Run via `/api/items/warehouse/[id]/visual-query`. Compiler `visual-query-compiler.ts` (12 unit tests). |
| 5 | ✅ | Save-as-view achievable via CREATE VIEW in editor; CTAS dialog covers table |
| 6 | ✅ | `Save as table` CTAS dialog (`submitCtas`) → real CREATE TABLE AS SELECT |
| 7 | ✅ | `Open in Excel` → `/iqy` returns a real .iqy web-query file |
| 8 | ✅ | **Visualize** toggle renders an in-Loom chart (bar/line/area/pie/scatter + axis pickers) over the real result rows — `result-visualize.tsx`, no Power BI dependency |
| 9 | ✅ | Results grid is selectable/copyable |
| 10 | ✅ | `Manage relationships` → sys.foreign_keys; `New measure` → CREATE FUNCTION template |
| 11 | ✅ | `Permissions` → real sys.database_principals query via `/query` |
| 12 | ⚠️ honest-gate | `Source control` opens Fabric Git Learn (Git is workspace-level) |
| 13 | ✅ | 3-part names work through the same TDS path |
| 14 | ✅ | **Query parameters** — `{{name}}` tokens auto-detected into widgets above the editor; rewritten to `@name` and bound via `req.input()` → `sp_executesql` (injection-safe; value never concatenated) |
| 15 | ✅ | `getRunSql()` sends only the highlighted selection to `/query` when present; else full text. |
| 16 | ✅ | **Cancel** button (while running) → `POST /[id]/cancel` `{queryId}` → `cancelActiveQuery()` → mssql `Request.cancel()` (TDS ATTENTION) aborts the batch; canceled runs show a `warning` MessageBar. |
| 17 | ✅ | Multi-tab via `useSqlTabs` + `SqlTabBar`; **New SQL query** opens a fresh tab (replaced the old single-tab reset). |
| 18 | ✅ | `registerSqlIntelliSense` completion provider fed from `/schema` (sys.schemas + `?table=` → INFORMATION_SCHEMA.COLUMNS, cached). |
| 19 | ✅ | Toolbar **Database** dropdown (sys.databases) re-targets the TDS connection so `other_db.schema.table` 3-part names resolve. |

## Backend per control
- Schema / query / CTAS / DMV actions → Synapse Dedicated pool TDS (`executeQuery` / `dedicatedTarget`) via `/api/items/warehouse/[id]/query` + `/schema`.
- Visual query → `/api/items/[type]/[id]/visual-query` compiles the canvas graph server-side (same pure compiler the UI previews with) and executes it over the Dedicated pool TDS; describe mode resolves table columns via a zero-row `SELECT TOP 0` probe.
- Visualize (chart) → client-side SVG over the real result set (`result-visualize.tsx`); no backend call, no Power BI.
- Query parameters → bound server-side via `req.input(name, NVarChar, value)` in `executeQuery`; receipt returns `statement` + `parameters` + `parametersCount`.
- Open in Excel → `/api/items/warehouse/[id]/iqy`.
- Compute lifecycle (Resume/Pause) → `ComputePicker` → ARM (`synapse-pool-arm`).

Grade: **A — SQL authoring + explorer (schemas/tables/views/SPs/functions with row counts + CREATE/ALTER/DROP script-out) + CTAS + Excel + permissions/relationships + in-Loom visualize + parameterized queries + run-selection + cancel + multi-tab + IntelliSense + cross-DB picker all real, and the no-code visual query canvas is now built end-to-end (real backend, unit-tested compiler). Two honest-gates remain (Power BI visualize removed — built Azure-native; workspace Git). The same canvas is wired into the Synapse Serverless / Dedicated and Databricks SQL editors (Spark SQL dialect).**

> **rev — SQL-editor parity sweep.** Added rows 15–19 (run-selection, Cancel via TDS ATTENTION `/cancel`, multi-tab tab bar, schema IntelliSense, database picker). All over the existing Synapse Dedicated TDS path — no new env vars, no Fabric dependency.
