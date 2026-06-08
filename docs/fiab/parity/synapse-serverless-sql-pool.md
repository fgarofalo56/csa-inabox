# synapse-serverless-sql-pool — parity with Synapse Serverless SQL pool

Source UI: Synapse Studio Serverless SQL — https://learn.microsoft.com/azure/synapse-analytics/sql/on-demand-workspace-overview
Editor: `SynapseServerlessSqlEditor` in `apps/fiab-console/lib/editors/synapse-serverless-sql-editor.tsx`
Object explorer: `apps/fiab-console/lib/components/synapse-sql-object-explorer.tsx`

## Feature inventory

| # | Capability | Source UI |
|---|---|---|
| 1 | Database explorer (master + user DBs) | Data hub |
| 2 | Object explorer — Views / Procs / TVFs / External tables / Data sources | Data hub |
| 3 | T-SQL editor + Run + Run selection + results grid | Develop hub |
| 4 | Column + object IntelliSense (sys.* catalog) | Develop |
| 5 | Connect-to (database) dropdown | Develop |
| 6 | Messages pane (PRINT / RAISERROR / DDL receipt / errors) | Develop |
| 7 | CREATE OR ALTER VIEW / PROCEDURE / iTVF templates | Develop |
| 8 | ALTER (edit definition) / DROP from object explorer | Data hub context menu |
| 9 | External tables / data sources browsing | Develop |
| 10 | Bytes-processed cost telemetry | Monitor |
| 11 | Cost cap / data-processed limit | Manage |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | `/schema` databases → Connect-to dropdown; switching reloads objects |
| 2 | ✅ | `/objects` (sys.views/procedures/objects/external_tables) → explorer tree |
| 3 | ✅ | Monaco editor + Run + Run selection via `/query` (serverless TDS); Ctrl+Enter / Ctrl+S |
| 4 | ✅ | Monaco completion provider over `/objects` columns + objects + T-SQL keywords |
| 5 | ✅ | Connect-to `<Dropdown>` (master + user DBs) drives query + objects database |
| 6 | ✅ | Results \| Messages TabList; messages from TDS `info` events + DDL receipt |
| 7 | ✅ | New view/procedure/function ribbon → `CREATE OR ALTER` templates in `[reports]` schema |
| 8 | ✅ | Explorer context menu: ALTER loads definition; DROP → confirm dialog → real `DROP … IF EXISTS` |
| 9 | ✅ | External tables + data sources branches; click inserts `SELECT TOP 100` |
| 10 | ✅ | `Bytes processed` loads sys.dm_external_data_processed query |
| 11 | ✅ | `Cost cap` loads sys.configurations + sp_set_data_processed_limit template |

> Scalar UDFs are intentionally absent — Synapse Serverless SQL pool does **not**
> support `CREATE FUNCTION … RETURNS <scalar>`. The "New function" template emits
> an inline table-valued function (iTVF) and documents the limitation inline.

## Backend per control
- Query / Run / Run selection / DDL → Synapse Serverless TDS (`executeQuery`/`serverlessTarget`) via `/api/items/synapse-serverless-sql-pool/[id]/query`.
- Object explorer + IntelliSense → `/api/items/synapse-serverless-sql-pool/[id]/objects` (sys.* catalog).
- Connect-to / endpoint badge → `/api/items/synapse-serverless-sql-pool/[id]/schema`.
- Cloud portability: `getSynapseSqlSuffix()` + `LOOM_SYNAPSE_SQL_SUFFIX` / `LOOM_SYNAPSE_SQL_TOKEN_SCOPE` (admin-plane bicep wires per boundary).

Grade: **A — every inventory row built; IntelliSense, view/proc/iTVF CRUD, Messages pane and DROP-with-confirm all run against the real serverless TDS endpoint. Azure-native by default (no Fabric/Power BI); honest MessageBar gate when `LOOM_SYNAPSE_WORKSPACE` is unset.**

> **rev — SQL-editor parity sweep.** The sibling `SynapseServerlessSqlPoolEditor`
> (`lib/editors/synapse-sql-editors.tsx`) was brought onto the shared
> `sql-editor-kit` + `sql-intellisense` primitives, adding run-selection,
> multi-tab tabs, a **Cancel** button (`POST /[id]/cancel` `{queryId}` →
> `cancelActiveQuery()` → mssql `Request.cancel()` TDS ATTENTION), schema-aware
> column completions (`/schema?table=` → INFORMATION_SCHEMA.COLUMNS) and a
> database picker for 3-part cross-DB queries — all over the same serverless TDS
> path, no new env vars.

> **T9 — Visualize + query parameters.** Added a **Visualize** toggle (in-Loom SVG chart: bar/line/area/pie/scatter + axis pickers over the real result rows, `result-visualize.tsx`) and **query parameters** (`{{name}}` widgets → `@name` bound via `req.input()` → `sp_executesql`, injection-safe). Receipt returns `statement` + `parameters` + `parametersCount`. Grade unchanged (A).
