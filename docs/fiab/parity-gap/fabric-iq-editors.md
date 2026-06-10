# Parity Gap — Fabric IQ editors (v2 validator, 2026-05-26)

> Editors: `variable-library` / `plan` / `ontology` / `graph-model`
> Source: `apps/fiab-console/lib/editors/phase4-editors.tsx` (lines 540-877)
> Validator state: source-grade audit. Phase 4 live click blocked by MFA expiration.

## Critical request checks

- **"Variable Library: 9 type options visible in dropdown"** — Confirmed. `VarType` union (lines 550-559) has 9 types: `string | integer | number | bool | datetime | guid | item-ref | connection-ref | secret-ref`. `VAR_TYPE_LABELS` (564-574) maps each to a Fabric-aligned display name (String, Integer, Number, Boolean, DateTime, Guid, ItemReference, ConnectionReference, SecretReference). All 9 render as `<option>` rows in the native `<select>` (line 651) per row.
- **"Plan: progress badges visible"** — Confirmed. Lines 919-928 render `total / to-do / doing / done / overdue` badges + `pct% complete` + a percent-bar `<div>`. Real counts computed from `state.tasks`.
- **"Ontology: Materialize-as-graph-model button works"** — Confirmed in source. Lines 704-743 implement `materializeToGraphModel`: parses classes, builds nodes (one per class) + IS_A edge type (if any parent), POSTs to `/api/items/graph-model`. Button is wired (line 772 `onClick={materializeToGraphModel}`). Returns success/failure MessageBar with the new graph-model id.

## 1. `variable-library`

| Element | Fabric Variable Library | Loom | Severity |
|---|---|---|---|
| **9 variable types** | String, Integer, Number, Boolean, DateTime, Guid, ItemReference, ConnectionReference + Loom's secret-ref | ✓ 9 types in `<select>` | **A-present** ✓ |
| Value sets (default / dev / test / prod) | Tabs | TabList with 4 tabs (line 622-625) | **A-present** ✓ |
| Per-type validation | Inline | `validateVarValue` regex per type (lines 587-597) — integer, number, bool, datetime, guid | **B-present** ✓ |
| Type icons in dropdown | Yes (Fluent icons per type) | Plain text labels only | MINOR |
| New variable / Delete row | Yes | `+ New variable` button + per-row Delete | present |
| Save | Toolbar | SaveBar | present |
| Git serialization preview | Side panel showing JSON shape | absent | **MAJOR** — per csa-loom-parity-reality this is a core Fabric feature |
| Dynamic resolution downstream (`@{variables.NAME}`) | Pipelines / Notebooks resolve | MessageBar says "resolved at runtime by executor" — no implementation in this Loom build | **MAJOR** — advertised, not wired |
| Reference editor for `item-ref` / `connection-ref` | Picker dialog | plain text input with placeholder | MAJOR (advertised in placeholder, no UI) |
| Bulk import / export | Toolbar | absent | MINOR |

**Grade**: **B** — Best Fabric IQ editor. 9 types ✓, value sets ✓, per-type validation ✓, save ✓. Drops from A because of no Git serialization preview and no real downstream resolution (the variable library has no consumer in this Loom).

## 2. `plan`

| Element | Microsoft Planner / Fabric Plan | Loom | Severity |
|---|---|---|---|
| **Progress badges (total, todo, doing, done, overdue, %)** | Yes | ✓ All 6 badges + % bar | **A-present** ✓ |
| Task list with title / owner / due / status / depends-on | Grid | 5-col + delete | present |
| Inline edit per cell | Yes | Fluent Input / native select / date input | present |
| Save | Save button | SaveBar | present |
| Kanban / Board view | Yes | absent | **MAJOR** |
| Gantt / timeline | Pro | absent | MINOR (Pro tier) |
| Approvals workflow | Power Automate integration | ✓ **PlanApprovalPanel** → `POST /api/items/plan/[id]/approval` → Azure-native approval Logic App (Office 365 email); decision posted back to `/approval-callback`, stamps `approvalStatus` on the plan. No Fabric / Power Automate. (audit-T13) | **B-present** ✓ |
| Semantic model writeback (push status into semantic-model measures) | per-Plan custom | ✓ "Push plan metrics" → `POST /api/items/semantic-model/[id]/model { planMetrics }` writes `_PlanTasks` + `_PlanMetrics` (PlanDone%, PlanOverdue, ApprovalStatus) via XMLA; honest gate persists to Cosmos content when XMLA unset. On approval the callback writes back automatically. (audit-T13) | **B-present** ✓ |
| Notifications | Yes | approval email via the Logic App (other notifications absent) | MINOR |
| Bulk import / .mpp / Project | Yes | absent | MINOR |

**Grade**: **B** — progress badges ✓, inline edit ✓, Cosmos save ✓, **approval-workflow handoff ✓** (Azure-native approval Logic App + callback) and **semantic-model writeback ✓** (TMSL `_PlanTasks` + `_PlanMetrics` over XMLA, Cosmos-content fallback) are wired end-to-end (audit-T13). Remaining gaps to A: Kanban/board view, Gantt, bulk .mpp import.

## 3. `ontology`

| Element | OWL / Turtle editor | Loom | Severity |
|---|---|---|---|
| Source editor | Monaco with Turtle/OWL syntax + ontology validation | **`<textarea>`** | **BLOCKER** ❌ |
| Parsed class hierarchy preview | Tree view with parent/child | `Tree` rendering flat list (no actual hierarchy nesting) | **MAJOR** — parser ignores nesting, just shows "Class : Parent" |
| **Materialize as graph-model** | n/a (custom) | ✓ Button wired (lines 704-743, 772) — calls `/api/items/graph-model` POST | **B-present** ✓ |
| Lakehouse / Warehouse entity binding | Side panel | MessageBar "still deferred" | **MAJOR** |
| Activator trigger hooks | Side panel | MessageBar "still deferred" | MINOR |
| Class property editor | Form | absent (regex parser only) | **BLOCKER** for real OWL |
| Reasoner / Inference | Compute button | absent | BLOCKER (Pro feature) |
| Save | Yes | SaveBar | present |

**Grade**: **C** — Materialize-as-graph-model fix is real and adds end-to-end flow (ontology → graph-model → ADX). `<textarea>` blocks A. Parser is a regex shim not real OWL. The Cosmos save + graph-model handoff is what saves it from D.

## 4. `graph-model`

| Element | n/a (Loom-native) | Loom | Severity |
|---|---|---|---|
| Target ADX database | Input | `<Input>` | present |
| Node types editor | Schema designer / form | **`<textarea>`** (JSON) | **BLOCKER** for parity with a real schema designer |
| Edge types editor | Schema designer / form | **`<textarea>`** (JSON) | **BLOCKER** |
| **Materialize to ADX** | n/a | Button → POST `/api/items/graph-model/[id]/materialize` | **B-present** ✓ |
| Materialize result list (per-node/edge with [ok]/[err]) | n/a | MessageBar with success/error list | present |
| lastMaterializedAt timestamp | n/a | shown in Caption1 | present |
| Save | Yes | SaveBar | present |
| Visual diagram of node/edge graph | n/a | absent | MAJOR |
| Schema validation (ADX-table-name uniqueness, type compatibility) | n/a | absent | MAJOR |

**Grade**: **C** — Materialize ✓ is real end-to-end (creates KQL tables). Save ✓. Two `<textarea>` for JSON editing block higher. The author "Add entity"/"Add relationship" ribbon buttons are labels only — they don't open a form.

## Phase 4 (click-every-button)

| Button | Status |
|---|---|
| variable-library Save / + New variable / per-row Delete | ✓ all wired |
| variable-library TabList default/dev/test/prod | ✓ wired |
| variable-library ribbon "New variable" / "Save" / value-set tabs | dead labels |
| plan Save / + New task / per-row Delete | ✓ all wired |
| plan ribbon "New task" / "Save" | dead labels |
| ontology Save / Materialize button | ✓ wired |
| ontology ribbon "Author" / "Add entity" / "Add relationship" / "Save" / "Materialize" | dead labels |
| graph-model Save / Materialize / per-textarea blur=parse | ✓ wired |
| graph-model ribbon "Author" / "Add entity" / "Add relationship" / "Save" / "Materialize" | dead labels |

The "Add entity / Add relationship" ribbon labels in graph-model + ontology are particularly misleading — they imply form-based authoring that doesn't exist.

## Summary

| Editor | Grade | Reason |
|---|---|---|
| variable-library | **B** | 9 types ✓ + 4 value sets ✓ + per-type validation ✓ + save ✓; no Git preview, no consumer wiring |
| plan | **B** | Progress badges ✓ + inline edit ✓ + approval-workflow handoff ✓ (Azure-native Logic App + callback) + semantic-model writeback ✓ (XMLA `_PlanTasks`/`_PlanMetrics`, Cosmos fallback); remaining: board view, Gantt, .mpp import (audit-T13) |
| ontology | **C** | Materialize fix ✓ end-to-end; `<textarea>` + regex parser (not real OWL) + dead ribbon labels |
| graph-model | **C** | Materialize ✓; two `<textarea>` for schema, no visual diagram, no validation |
