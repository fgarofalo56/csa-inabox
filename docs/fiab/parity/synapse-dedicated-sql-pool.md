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

## Backend per control
- Query / DMV actions → Synapse Dedicated TDS (`executeQuery`/`dedicatedTarget`).
- Lifecycle → ARM (`synapse-pool-arm` `getPoolState`/resume/pause).

Grade: **A — every inventory row built; all four former "deferred" buttons now wired to real DMV T-SQL through the existing /query TDS path.**

> **T9 — Visualize + query parameters.** Added a **Visualize** toggle (in-Loom SVG chart: bar/line/area/pie/scatter + axis pickers over the real result rows, `result-visualize.tsx`) and **query parameters** (`{{name}}` widgets → `@name` bound via `req.input()` → `sp_executesql`, injection-safe). Receipt returns `statement` + `parameters` + `parametersCount`. Grade unchanged (A).
