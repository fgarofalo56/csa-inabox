# Loom Plan Editor — Fabric-parity build spec

> Reference: Microsoft Learn — *What is plan (preview)?* (`/fabric/iq/plan/overview`), *What are PowerTable sheets in plan (preview)?* (`/fabric/iq/plan/powertable-overview`), *Create a planning sheet* (`/fabric/iq/plan/planning-how-to-get-started`), *Plan projects with Gantt charts* (`/fabric/iq/plan/intelligence-how-to-create-gantt-chart`), *What is Fabric IQ (preview)?* (`/fabric/iq/overview`). Documented 2026-05-26 by catalog agent.
>
> **Note on the user prompt:** the catalog brief described Plan as "release / deployment plan management" with an ARM Deployment Slots / GitHub Releases backend. That conflates two things. The real Fabric **Plan** item is the EPM/CPM (Enterprise & Corporate Performance Management) item under Fabric IQ — budgets, forecasts, scenario planning, Gantt charts, PowerTable apps — **not** Fabric deployment pipelines (which are a separate construct documented in `/fabric/cicd/deployment-pipelines/*`). This spec documents the real Fabric Plan item. Loom's current `PlanEditor` is a generic task tracker that maps to neither cleanly.

## Overview

A Fabric **Plan (preview)** is a Fabric IQ workload item that brings EPM/CPM directly into Fabric. It unifies budgeting, forecasting, scenario modeling, variance analysis, project planning, and master-data management on top of Fabric semantic models and a Fabric SQL database. The item solves the "spreadsheets-plus-CPM-tool-plus-BI" fragmentation problem by keeping the plan, the historical actuals, and the reporting layer in one governed surface.

A Plan is created from **New item → Plan (preview)**. Creating it auto-provisions a Fabric SQL database in the same workspace to store the plan's metadata. Inside a Plan, the user works with four kinds of sheets — Planning, PowerTable, Intelligence, and InfoBridge — each surfacing a distinct capability.

## Fabric Plan UX inventory

### Page chrome
- Page title shows the Plan name (editable inline)
- Capacity badge, workspace breadcrumb, global action bar
- Top-right: **Save**, **Share**, **Comments**, **Settings** (semantic-model connection, database connection)
- Left-rail navigation of sheets — Planning · PowerTable · Intelligence · InfoBridge

### New-Plan dialog
- Name input
- Optional description
- On Create: provisions a backing Fabric SQL database for plan metadata
- Prompt to connect a semantic model (required for planning + intelligence sheets)

### Planning sheets
| Element | Purpose |
|---|---|
| Sheet grid | Excel-like cell grid for budgeting / forecasting / scenario modeling |
| Dimensions axis | Bind rows/columns to semantic-model dimensions (time, geography, account, product) |
| Measures + assumption inputs | Mix of computed measures and user-entered cells; assumptions drive what-if branches |
| Scenario picker | Switch between baseline, optimistic, pessimistic, custom scenarios |
| Variance overlay | Compare plan vs actuals from the bound semantic model |
| Writeback target | Plan values write back to the Fabric SQL database created at item provisioning |

### PowerTable sheets
| Element | Purpose |
|---|---|
| Live table view | Excel-like grid bound to a database table or semantic model with two-way sync |
| Drag-and-drop builder | No-code app builder for forms, custom views, filters, lookups, calculated columns |
| Collaboration | Multi-user concurrent editing, `@mentions`, comments, threads, Teams/email notifications |
| Approval workflow | Configurable row-level approval routing |
| Permissions | Row-level + column-level security, full audit log, Type-II SCD compliance |
| Project planning view | Gantt chart, resource allocation, time tracking, task status |
| Automation | Triggers + webhooks |

### Intelligence sheets
| Element | Purpose |
|---|---|
| Variance reporting | Auto-generated variance analysis over plan-vs-actual |
| Trend / forecast widgets | Forward-looking analytics on plan data |
| Gantt chart | Project tasks with start/end, dependencies, milestones, resource assignment |
| Insights panel | AI-assisted commentary on variance + trends |

### InfoBridge
- Connects + integrates plan data with Fabric workloads + external source systems
- Keeps planning data aligned with OneLake actuals
- Settings pane for source connections, sync cadence, mapping

### Settings flyout
- Semantic-model connection (owner permission required on the model)
- Database connection (the auto-provisioned Fabric SQL database)
- Tenant + capacity feature toggles (Plan requires specific tenant settings to be enabled)
- Region availability check (Plan is preview, gated by region)

### Permissions
Aligned with workspace roles. Connection-owner permission required on the bound semantic model. Database access governed by the auto-provisioned Fabric SQL database's permissions.

## What Loom has today

Loom's `PlanEditor` (`apps/fiab-console/lib/editors/phase4-editors.tsx` line 774) is **D-grade** — renders but bears no relationship to the Fabric Plan item:

- Single tab: a flat task list (`title / owner / due / status / dependsOn`)
- Status enum: `todo | doing | done`
- Persists `tasks[]` to Cosmos via the standard item-crud lib
- A MessageBar acknowledges: *"v2.1: task list persisted. Plan rows save to Cosmos. Semantic-model writeback and approval workflows are deferred to v2.x."*
- No semantic-model connection, no Fabric-SQL backing store, no planning sheets, no PowerTable, no intelligence sheets, no Gantt, no InfoBridge
- No scenario modeling, no variance analysis, no writeback

The current editor is closer to a project-management to-do list than to Fabric Plan. Reusing it as the Plan editor risks a vaporware violation (per `.claude/rules/no-vaporware.md`) — the surface looks plausible but the item is fundamentally a different thing.

## Gaps for parity

1. **Auto-provision a backing SQL store** — on Plan creation, provision an Azure SQL database (or a Synapse Serverless SQL view, depending on tier) to hold plan metadata + writeback values. Equivalent of Fabric's auto-created Fabric SQL database. Recorded as `state.backingDb = { kind, serverId, dbName }`.
2. **Semantic-model binding** — picker that selects a semantic-model item (Loom's existing `semantic-model` catalog item). Surface dimensions, measures, scenarios as bindable for planning sheets.
3. **Sheet container** — left-rail of sheets with the four kinds (Planning, PowerTable, Intelligence, InfoBridge). Persist `state.sheets[] = { id, kind, name, definition }`.
4. **Planning sheet** — grid editor with dimensions on rows/columns, measures + user-entered assumption cells, scenario picker (baseline / optimistic / pessimistic / custom), variance overlay, writeback to backing SQL.
5. **PowerTable sheet** — live grid bound to a SQL table or semantic-model entity; drag-and-drop column builder; forms + filters + custom views; lookups + calculated columns; multi-user editing; comments + `@mentions`; approval workflow with row routing; row-level + column-level security; audit log; Gantt + resource-allocation views; trigger/webhook automation.
6. **Intelligence sheet** — auto-generated variance reports, trend/forecast widgets, Gantt chart with dependencies + milestones, AI insights panel (Copilot Studio agent over plan data).
7. **InfoBridge** — connection picker + mapping UX that pulls actuals from OneLake / Synapse / external sources into the plan's backing SQL.
8. **Scenario modeling** — branch a plan into named scenarios sharing dimensions but differing on assumption cells; compare side-by-side.
9. **Variance + writeback** — at save, write planning-cell values back to backing SQL and trigger variance recomputation against the bound semantic model.
10. **Approval workflow** — configurable per-row routing tied to Loom RBAC + (optionally) Power Automate flows.
11. **Audit log** — append-only change history per row; surface as a side pane.
12. **Region + tenant gating** — Plan is preview-only and region-gated in Fabric; Loom should mirror this with a MessageBar when the workspace's region isn't on the allow list.
13. **Disclosure about scope** — given the size of the Plan item, ship a Phase-1 (planning sheet + backing SQL + variance) with a MessageBar marking PowerTable, Intelligence, InfoBridge as **Preview / coming soon** rather than stubbing them. Per the no-vaporware rule, anything not wired must be a Preview badge with a link to the implementation ticket — not a static tab.

## Backend mapping

| Fabric concept | Loom backend |
|---|---|
| Create Plan item | ✅ `/api/items/plan` (Cosmos CRUD via item-crud lib) — **EXTEND** to also provision the backing SQL database |
| Backing SQL database | **NEW** Azure SQL or Synapse Serverless DB provisioned via ARM at item-creation time. Record `state.backingDb` on the Plan doc. |
| Semantic-model binding | **NEW** `state.semanticModelRef = { workspaceId, itemId }`; UI picker reads from Loom catalog `/api/items/list?type=semantic-model` |
| Sheets collection | **NEW** `state.sheets[] = { id, kind: 'planning'|'powertable'|'intelligence'|'infobridge', name, definition }` |
| Planning-sheet cell values | **NEW** `POST .../[id]/sheets/[sheetId]/writeback` body `{ cells: [{ dimKey, scenario, value }] }` → TDS execute against backing SQL |
| Scenario branch | **NEW** `POST .../[id]/scenarios` body `{ name, baseScenario }` → copies assumption cells into a new scenario |
| Variance compute | **NEW** `GET .../[id]/variance?scenario=...` → joins plan SQL with semantic-model DAX query (via the existing semantic-model executor) |
| PowerTable definition + edits | **NEW** `state.sheets[].definition = { sourceTable, columns, views, approvals, security }`; row-level edits POST to a TDS endpoint against the backing SQL with row-level-security enforcement |
| Approval routing | **NEW** `POST .../[id]/approvals/[rowId]/route` → integrates with Loom RBAC; optionally fires a Power Automate flow (existing `power-automate-flow` editor) |
| Audit log | **NEW** `state.auditLog[]` append-only, or separate `audit` Cosmos container scoped by Plan id |
| Intelligence Gantt | **NEW** read-only render of sheet rows with `startDate / endDate / dependsOn` columns; reuse the existing Loom dashboard rendering for variance charts |
| InfoBridge connections | **EXTEND** `/api/connections/[id]` to allow registering a connection as a Plan source; persist mappings in `state.sheets[].definition.sources[]` |
| Region + tenant gating | **EXTEND** workspace doc with `region`; Plan editor reads workspace.region against a hard-coded allow list and gates with MessageBar |

## Required Azure resources

- ✅ Loom Cosmos `items` container (already)
- **NEW** Azure SQL Database **OR** Synapse Serverless SQL Pool to host backing planning data — provisioned per Plan item at create time. Bicep: extend `platform/fiab/bicep/modules/sql.bicep` with a `planBackingDb` module. Connection string written to Key Vault, referenced via managed identity.
- **NEW** Optional Copilot Studio agent for the Intelligence sheet's AI insights panel — reuse the existing `copilot-studio-agent` editor + provisioning.
- **NEW** Optional Power Automate flow integration for approval routing — reuse the existing `power-automate-flow` editor.
- ✅ Loom semantic-model editor + executor (already) — Plan reuses this for variance + dimension/measure resolution.
- ✅ Azure Key Vault for backing-SQL connection strings (already in bicep)

## Estimated effort

**4 focused sessions** — Plan is genuinely large; Phase-1 ships planning sheet + backing SQL + variance only.

- **Session 1 (~3h):** Backend Phase-1 — backing SQL provisioning at item-create, semantic-model binding, sheets collection schema, planning-sheet writeback endpoint, variance compute endpoint, scenario branching. Cosmos schema migration. Bicep module + KV wiring.
- **Session 2 (~3h):** Frontend Phase-1 — left-rail sheets navigation, planning-sheet grid editor with dimensions + scenarios + variance overlay, semantic-model picker, settings flyout (model + DB connections), region/tenant gate MessageBar. PowerTable / Intelligence / InfoBridge tabs surface a Preview MessageBar with link to the Phase-2 ticket.
- **Session 3 (~3h):** PowerTable Phase-2 — live SQL-bound grid, column/view/form builder, row-level + column-level security, approval routing (Power Automate flow integration), audit log side pane, Gantt + resource-allocation views.
- **Session 4 (~2.5h):** Intelligence + InfoBridge Phase-3 — variance reports, trend widgets, Gantt with dependencies, Copilot Studio agent integration for AI insights, InfoBridge connection mapping UX. UAT harness coverage + A11y audit across all four sheet kinds.

Drops Loom Plan from **D** (renders a generic task list that bears no relationship to Fabric Plan) to **A** (real semantic-model-backed EPM/CPM surface with planning + writeback + variance). Honest disclosure: Phase-1 is **B-grade** until PowerTable + Intelligence + InfoBridge ship in Phases 2-3.
