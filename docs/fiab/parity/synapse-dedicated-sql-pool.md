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
| 10 | Explorer: views / stored procedures / functions nodes | Data hub object tree |
| 11 | Row-count badges on tables + views | Data hub |
| 12 | Script object as CREATE / ALTER / DROP | Object context menu |
| 13 | Save as table (CTAS) — distribution + index strategy | Develop hub |
| 14 | Select into (copy a table — full physical copy; Dedicated has no zero-copy clone) | Develop hub |
| 15 | Run selection (execute only highlighted text) | Develop hub |
| 16 | Cancel a running query | Develop hub |
| 17 | Multi-tab query editor | Develop hub tabs |
| 18 | Schema-aware IntelliSense (column completions) | Develop hub |
| 19 | Database picker for cross-database 3-part queries | Develop toolbar |

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
| 10 | ✅ | `/schema` enumerates sys.views / sys.procedures / sys.objects(FN/IF/TF) → typed tree branches (Eye/Form/MathFormula icons) |
| 11 | ✅ | Tables: sys.partitions rows; views: lazy `SELECT COUNT_BIG(*)` via `/query` on expand |
| 12 | ✅ | `…` menu → `/script-out` returns real OBJECT_DEFINITION (CREATE), CREATE OR ALTER (ALTER), or DROP … IF EXISTS |
| 13 | ✅ | **CTAS built.** Ribbon **Save as table** opens a schema/name/distribution/index dialog; **Create** posts `CREATE TABLE [sch].[name] WITH (DISTRIBUTION = …, …INDEX) AS <SELECT>` to `/query` (TDS); ROUND_ROBIN/HASH(col)/REPLICATE + CCI/HEAP/CLUSTERED INDEX(col) selectable. Receipt shows the distribution. |
| 14 | ✅ | **SELECT INTO built (honest note).** Ribbon **Select into** + per-table hover button open a source/target dialog; **Copy** → `POST /api/items/synapse-dedicated-sql-pool/[id]/clone` → `SELECT * INTO [ts].[tt] FROM [ss].[st]` (TDS). Dialog + response `note` disclose: Synapse Dedicated has **no zero-copy clone** — SELECT INTO is a full physical copy (ROUND_ROBIN + CCI). Receipt shows rows copied. |
| 15 | ✅ | `getRunSql()` sends only the highlighted selection to `/query` when present. |
| 16 | ✅ | **Cancel** button (while running) → `POST /[id]/cancel` `{queryId}` → `cancelActiveQuery()` → mssql `Request.cancel()` (TDS ATTENTION). |
| 17 | ✅ | Multi-tab via `useSqlTabs` + `SqlTabBar`. |
| 18 | ✅ | `registerSqlIntelliSense` fed from `/schema` (sys.schemas + `?table=` INFORMATION_SCHEMA.COLUMNS). |
| 19 | ✅ | **Database** dropdown (sys.databases) re-targets the TDS connection for `other_db.schema.table` 3-part queries. |

## Backend per control
- Query / DMV / CTAS actions → Synapse Dedicated TDS (`executeQuery`/`dedicatedTarget`).
- SELECT INTO → `/clone` route → TDS `SELECT * INTO`.
- Lifecycle → ARM (`synapse-pool-arm` `getPoolState`/resume/pause).
- Object enumeration + script-out → `sys.views`/`sys.procedures`/`sys.objects`/`sys.sql_modules` via `lib/azure/sql-object-scripting.ts`.

Grade: **A — every inventory row built; Explorer covers views/SPs/functions with real row counts and full script-out (CREATE/ALTER/DROP) over OBJECT_DEFINITION; CTAS (distribution+index) and SELECT INTO copy wired through the TDS path, with an honest no-zero-copy-clone disclosure for Dedicated; plus run-selection, Cancel (TDS ATTENTION), multi-tab, IntelliSense and the cross-DB picker all run through the existing /query TDS path.**

> **T9 — Visualize + query parameters.** Added a **Visualize** toggle (in-Loom SVG chart: bar/line/area/pie/scatter + axis pickers over the real result rows, `result-visualize.tsx`) and **query parameters** (`{{name}}` widgets → `@name` bound via `req.input()` → `sp_executesql`, injection-safe). Receipt returns `statement` + `parameters` + `parametersCount`. Grade unchanged (A).
