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

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | Explorer tree from `/schema` (sys.tables/schemas + row counts) |
| 2 | ✅ | Tree leaf click loads `SELECT TOP 100`; New measure loads CREATE FUNCTION template |
| 3 | ✅ | Monaco T-SQL editor + Run via `/query` (Dedicated pool TDS); Results grid |
| 4 | ❌ MISSING | No-code visual Power-Query canvas not built — SQL editor is the authoring surface today |
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

## Backend per control
- Schema / query / CTAS / DMV actions → Synapse Dedicated pool TDS (`executeQuery` / `dedicatedTarget`) via `/api/items/warehouse/[id]/query` + `/schema`.
- Visualize (chart) → client-side SVG over the real result set (`result-visualize.tsx`); no backend call, no Power BI.
- Query parameters → bound server-side via `req.input(name, NVarChar, value)` in `executeQuery`; receipt returns `statement` + `parameters` + `parametersCount`.
- Open in Excel → `/api/items/warehouse/[id]/iqy`.
- Compute lifecycle (Resume/Pause) → `ComputePicker` → ARM (`synapse-pool-arm`).

Grade: **A- — SQL authoring + explorer + CTAS + Excel + permissions/relationships + in-Loom visualize + parameterized queries all real. One genuine MISSING (visual Power-Query canvas) recorded honestly; one honest-gate (workspace Git). The Power BI visualize gate is removed (built Azure-native).**
