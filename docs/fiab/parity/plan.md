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
| 14 | ⚠️ preview | PowerTable tab renders an honest Preview MessageBar linking the parity spec (no stub controls). |
| 15 | ⚠️ preview | Intelligence tab — Preview MessageBar (variance is already live on the Planning sheet). |
| 16 | ⚠️ preview | InfoBridge tab — Preview MessageBar. |
| 17 | ✅ built | Project tasks tab keeps the audit-T13 approval Logic App handoff + semantic-model XMLA writeback. |
| 18 | ✅ built | Project tasks tab: task list (title/owner/due/status/dependsOn) + progress/overdue rollup. |

Zero ❌. Phase-1 is **B-grade** (Planning sheet + scenarios + variance + writeback fully functional, real backends); PowerTable / Intelligence / InfoBridge are honest Preview tabs per no-vaporware.

## Backend per control
- Plan CRUD + all cell/scenario/sheet edits → PATCH `/api/items/plan/[id]` (Cosmos). The Planning surface works fully with **only** Cosmos (no Fabric, no SQL).
- Semantic-model picker → GET `/api/items/plan/[id]/binding` (`listOwnedItems('semantic-model')`).
- Backing store provision → POST `/api/items/plan/[id]/binding` `{action:'provision'}` → `lib/azure/plan-backing-store.ts` `provisionPlanTables` (Azure SQL DDL via `azure-sql-client.executeQuery`).
- Writeback → POST `/api/items/plan/[id]/writeback` → `writebackCells` (parameterized `MERGE` via `executeParameterized`). Honest 503 gate naming `LOOM_PLAN_BACKING_SQL_*` when unconfigured; cells still saved to Cosmos.
- Variance → computed client-side from plan cells vs entered actuals (`_plan-model.computeVariance`); actuals source disclosed as the bound semantic model.
- Approval (Project tasks) → POST `/api/items/plan/[id]/approval` (Azure-native approval Logic App; audit-T13). No Fabric / Power Automate.

## Azure resources (no-fabric-dependency)
- **Default:** Cosmos `items` container (already deployed) — the entire Planning surface is functional here.
- **Opt-in writeback:** Azure SQL Database `dbo.loom_plan_cells` — `platform/fiab/bicep/modules/shared/plan-backing-sql.bicep` (serverless GP_S_Gen5_1 on the platform SQL server). Env: `LOOM_PLAN_BACKING_SQL_SERVER` + `LOOM_PLAN_BACKING_SQL_DATABASE` (emitted by `admin-plane/main.bicep`). Replaces Fabric's auto-provisioned Fabric SQL database — no Microsoft Fabric capacity required.
- **Actuals:** the bound Loom `semantic-model` (Loom-native tabular / AAS) — no Power BI workspace required.
