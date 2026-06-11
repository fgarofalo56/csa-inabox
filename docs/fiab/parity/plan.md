# plan — parity with Fabric IQ Plan (preview)

Source UI: Fabric IQ → **Plan (preview)** · https://learn.microsoft.com/fabric/iq/plan/overview
(Planning sheets: /fabric/iq/plan/planning-how-to-get-started · Writeback: /fabric/iq/plan/planning-writeback/planning-how-to-persist-data · PowerTable: /fabric/iq/plan/powertable-overview)

> **audit-T64 finish pass.** Fabric's **Plan** is the EPM/CPM (budgets / forecasts /
> scenario modeling / variance) Fabric IQ item — NOT a deployment plan and NOT a
> task tracker. The prior Loom editor was a flat task list (D-grade). This pass
> rebuilds it in place as a real planning surface and demotes the task list to a
> secondary "Project tasks" tab (preserving the audit-T13 approval workflow).
> Azure-native by default — works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Azure/Fabric feature inventory
| # | Capability | Source UI |
|---|------------|-----------|
| 1 | Create Plan → backing SQL database auto-provisioned | New item → Plan (preview) |
| 2 | Semantic-model connection (actuals source) | Settings → model connection |
| 3 | Database connection (writeback target) | Settings → database connection |
| 4 | Sheets left-rail (Planning / PowerTable / Intelligence / InfoBridge) | sheet navigation |
| 5 | Planning sheet grid — dimensions on rows, periods on columns | Planning sheet |
| 6 | Assumption input cells (budget/forecast values) | Planning sheet cells |
| 7 | Row / period / grand totals | Planning sheet totals |
| 8 | Scenario picker (baseline / optimistic / pessimistic / custom) | scenario switcher |
| 9 | Branch a scenario (clone assumptions) | scenario branch |
| 10 | Variance overlay (plan vs actuals, Δ, Δ%) | Intelligence / variance |
| 11 | Writeback planning cells to the SQL store | save / writeback |
| 12 | Add / rename / remove line items + periods + sheets | sheet editing |
| 13 | Region / tenant preview gating | preview availability |
| 14 | PowerTable (no-code SQL app builder, two-way writeback) | PowerTable sheet |
| 15 | Intelligence (variance reports, trends, Gantt, AI insights) | Intelligence sheet |
| 16 | InfoBridge (source-system integration / mapping) | InfoBridge sheet |
| 17 | Approval workflow on the plan | approvals |
| 18 | Project planning / task tracking | PowerTable project view |

## Loom coverage
| # | State | Notes |
|---|-------|-------|
| 1 | ✅ built | POST `/api/items/plan/[id]/binding` `{action:'provision'}` creates `dbo.loom_plan_cells` on the configured Azure SQL DB (idempotent DDL). Records `state.backingDb`. |
| 2 | ✅ built | Settings flyout Dropdown lists real owned `semantic-model` items (`listOwnedItems`); persists `state.semanticModelRef`. |
| 3 | ✅ built | Settings flyout shows backing-SQL status + Provision button. |
| 4 | ✅ built | TabList: Planning · Project tasks · PowerTable · Intelligence · InfoBridge. |
| 5 | ✅ built | Planning grid: line items (rows) × periods (columns), editable labels. |
| 6 | ✅ built | Number input cells per (line item, period, scenario) → `state.sheets[].cells`. |
| 7 | ✅ built | `rowTotal` / `periodTotal` / `grandTotal` (unit-tested in `_plan-model.test.ts`). |
| 8 | ✅ built | Scenario Dropdown; default baseline/optimistic/pessimistic seeded. |
| 9 | ✅ built | "Branch scenario" clones every sheet's cells onto a new custom scenario. |
| 10 | ✅ built | "Variance vs actuals" Switch overlays Actual / Δ / Δ% columns (`computeVariance`). |
| 11 | ✅ built | "Write back" → POST `/api/items/plan/[id]/writeback` MERGEs cells into Azure SQL (parameterized). Cosmos save runs first. |
| 12 | ✅ built | Add/rename/remove line items, periods, and sheets in the grid. |
| 13 | ⚠️ honest-gate | Catalog `preview:true` badge + Preview MessageBars; region gating mirrors Fabric. |
| 14 | ✅ built | **PowerTable** tab: no-code SQL-bound grid (`flattenPlanCells`) over every cell — filter + column sort + inline two-way edit. "Write back to SQL" MERGEs all sheets via the writeback route; "Load from SQL" reads `dbo.loom_plan_cells` back (GET on the writeback route) and flags drift. Persists to Cosmos always; Azure SQL when configured. |
| 15 | ✅ built | **Intelligence** tab: KPI strip + trend & forecast SVG chart (`forecastPeriods` OLS extrapolation, `linearFit` R²), computed `planInsights` narrative, full variance report (`computeVariance`), and a delivery Gantt (`ganttLayout`) over the Project tasks. All computed from real plan cells/tasks — no Fabric, no mock. |
| 16 | ✅ built | **InfoBridge** tab: per-line-item source mapping (semantic-model measure / warehouse / lakehouse column / manual) with real owned-item pickers (`/api/items/by-type`). Mappings persist to `state.infoBridge`; "Push to actuals" (`applyMappingsToActuals`) flows mapped values into the Planning variance overlay. Honest XMLA gate for automated live pull. |
| 17 | ✅ built | Project tasks tab keeps the audit-T13 approval Logic App handoff + semantic-model XMLA writeback. |
| 18 | ✅ built | Project tasks tab: task list (title/owner/due/status/dependsOn) + progress/overdue rollup. |

Zero ❌. Zero stub banners. The Planning sheet (scenarios + variance + writeback),
PowerTable (SQL-bound two-way grid), Intelligence (trend/forecast/variance/Gantt),
and InfoBridge (source mappings → actuals) are all functional with real backends —
**A-grade**. PowerTable / Intelligence / InfoBridge math is unit-tested in
`lib/editors/__tests__/plan-model.test.ts` (flatten/filter/sort, OLS fit + forecast,
Gantt layout, mapping reconciliation, insights). Only #13 (preview region gating)
remains an honest gate, matching Fabric's own preview availability.

## Backend per control
- Plan CRUD + all cell/scenario/sheet edits → PATCH `/api/items/plan/[id]` (Cosmos). The Planning surface works fully with **only** Cosmos (no Fabric, no SQL).
- Semantic-model picker → GET `/api/items/plan/[id]/binding` (`listOwnedItems('semantic-model')`).
- Backing store provision → POST `/api/items/plan/[id]/binding` `{action:'provision'}` → `lib/azure/plan-backing-store.ts` `provisionPlanTables` (Azure SQL DDL via `azure-sql-client.executeQuery`).
- Writeback → POST `/api/items/plan/[id]/writeback` → `writebackCells` (parameterized `MERGE` via `executeParameterized`). Honest 503 gate naming `LOOM_PLAN_BACKING_SQL_*` when unconfigured; cells still saved to Cosmos.
- **PowerTable read-back** → GET `/api/items/plan/[id]/writeback` → `readPlanCells` (parameterized `SELECT` of `dbo.loom_plan_cells`). Same honest 503 gate; PowerTable binds to Cosmos cells when SQL is absent.
- **Intelligence** → pure client compute over plan cells/tasks (`_plan-model`: `periodSeries`, `forecastPeriods`/`linearFit` OLS, `computeVariance`, `ganttLayout`, `planInsights`). No backend call — the data is already the real plan.
- **InfoBridge** → real owned-item pickers via GET `/api/items/by-type`; mappings persisted on the plan (PATCH `/api/items/plan/[id]`); "Push to actuals" writes mapped values into `sheet.actuals` (Cosmos) feeding the Planning variance overlay.
- Variance → computed from plan cells vs actuals (`_plan-model.computeVariance`); actuals come from manual entry or InfoBridge mappings (bound semantic model disclosed as the source).
- Approval (Project tasks) → POST `/api/items/plan/[id]/approval` (Azure-native approval Logic App; audit-T13). No Fabric / Power Automate.

## Azure resources (no-fabric-dependency)
- **Default:** Cosmos `items` container (already deployed) — the entire Planning surface is functional here.
- **Opt-in writeback:** Azure SQL Database `dbo.loom_plan_cells` — `platform/fiab/bicep/modules/shared/plan-backing-sql.bicep` (serverless GP_S_Gen5_1 on the platform SQL server), **invoked by `admin-plane/main.bicep` (module `planBackingSql`, gated on a non-empty `loomPlanBackingSqlServer`, scoped to the SQL server's RG)**. Env: `LOOM_PLAN_BACKING_SQL_SERVER` + `LOOM_PLAN_BACKING_SQL_DATABASE` (emitted by `admin-plane/main.bicep`). Replaces Fabric's auto-provisioned Fabric SQL database — no Microsoft Fabric capacity required.
- **Actuals:** the bound Loom `semantic-model` (Loom-native tabular / AAS) — no Power BI workspace required.
