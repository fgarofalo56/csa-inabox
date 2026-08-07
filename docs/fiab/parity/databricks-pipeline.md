# databricks-pipeline — parity with Azure Databricks Lakeflow Declarative Pipelines

**Source UI:** Azure Databricks — Lakeflow Pipelines Editor (formerly Delta Live Tables / DLT)
<https://learn.microsoft.com/azure/databricks/ldp/multi-file-editor>
Supporting: <https://learn.microsoft.com/azure/databricks/ldp/monitoring-ui>
· <https://learn.microsoft.com/azure/databricks/ldp/configure-pipeline>
· <https://learn.microsoft.com/azure/databricks/ldp/expectations>
· <https://learn.microsoft.com/azure/databricks/ldp/pipeline-mode>
· <https://learn.microsoft.com/azure/databricks/ldp/monitor-event-logs>

**Surface file:** `apps/fiab-console/lib/editors/databricks/pipeline-editor.tsx` (869 lines)
**Compiler:** `apps/fiab-console/lib/editors/databricks/dlt-spec.ts`
**Route:** `/items/databricks-pipeline/[id]` · Wave 10, DBX-3.

## Scoping note

Per `no-fabric-dependency.md`, Loom's **Azure-native default** ETL surface is the
Synapse/ADF `data-pipeline` item. `databricks-pipeline` is the *Databricks-backed
alternative* — it is opt-in by nature (it needs a bound Databricks workspace) and
honest-gates when unwired. Nothing in Loom hard-requires it. That is the correct
posture and is not counted as a gap below.

Loom's design deliberately **inverts** the Databricks authoring model: Databricks
is a **code-first multi-file IDE** (write Python/SQL, the service infers the DAG);
Loom is a **canvas-first designer** (draw the DAG, Loom compiles the SQL). Per
`loom_no_freeform_config` that inversion is intentional. Rows below therefore
distinguish "Loom does this differently, deliberately" (⚠️ with the reason) from
"Loom cannot do this" (❌).

## Feature inventory and Loom coverage

### Authoring

| # | Databricks capability | Loom | Evidence / gap |
|---|---|---|---|
| A1 | Create pipeline (3 entry points; UC + Current channel + Serverless defaults) | ✅ | Created as a Loom item; the editor binds/creates the real pipeline via `POST /spec`. |
| A2 | Multi-file tabbed code editor (many `.py` + `.sql` per pipeline) | ⚠️ **by design** | Loom authors on a canvas; the compiled SQL is one generated notebook. Deliberate per `loom_no_freeform_config` — but it means an existing multi-file DLT repo **cannot be opened** in this editor. Import is one-way (Loom → Databricks). |
| A3 | Pipeline asset browser (Pipeline / All files tabs, include-in-pipeline, move) | ❌ | No file tree. Consequence of A2. |
| A4 | Default folder scaffold (`transformations/`, `explorations/`, `utilities/`) | ❌ | Consequence of A2. |
| A5 | Root-folder management (configure / rename / move) | ❌ | Consequence of A2. |
| A6 | Editor context switcher (Workspace / SQL Editor / recent pipelines) | ❌ | Not applicable to Loom's item model — but no equivalent cross-pipeline switcher exists either. |
| A7 | Streaming tables + materialized views as dataset types | ✅ | Both node types on the canvas, compiled to real DLT SQL. |
| A8 | Source declaration | ✅ | Source nodes on the canvas. |
| A9 | Data-quality **expectations** (`expect` / `expect_or_drop` / `expect_or_fail`) | ✅ | Expectation nodes attach to datasets; compiled to `CONSTRAINT … EXPECT (…) ON VIOLATION …`. |
| A10 | Grouped expectations (`expect_all*`) | ❌ | One condition per expectation node; no grouped form. |
| A11 | Read-only view of the compiled code | ✅ | **SQL** tab renders the compiled DLT SQL read-only. |
| A12 | Genie Code (NL pipeline creation / edit / quick fix / diagnose) | ❌ | No NL authoring on this surface. |
| A13 | Source control (Git folder / Declarative Automation Bundles) | ❌ | Item state lives in Cosmos; no Git binding, no config versioning. |

### Canvas / graph

| # | Databricks capability | Loom | Evidence / gap |
|---|---|---|---|
| G1 | Interactive pipeline graph (DAG) with node states | ✅ | canvas-node-kit + React Flow DAG designer. |
| G2 | Node context menu / hover toolbar | ✅ | canvas-node-kit standard. |
| G3 | Zoom + vertical/horizontal layout toggle | ✅ | `CanvasRightRail` + ELK auto-layout (Loom's Wave-2 canvas layer). |
| G4 | Undo/redo | ✅ **exceeds** | `useCanvasHistory` — Databricks' graph is read-only, so Loom's editable canvas with undo is genuinely richer. |
| G5 | Copy/paste, align/distribute, shortcut sheet | ✅ **exceeds** | Wave-2 canvas standards. |
| G6 | Resizable panes | ✅ | `SplitPane` (`:543-607`) — **G3 compliant**. |
| G7 | **List view** (dataset rows + filters on name/type/status/has-streaming-metrics) | ❌ | Graph only. For a large pipeline there is no readable fallback — Databricks added List precisely for graphs too big to read. |
| G8 | Click node → data preview (sample rows, filter, sort) | ❌ | Selecting a node shows its config, not its data. **The most-missed daily affordance** — "did this table come out right?" cannot be answered without leaving Loom. |
| G9 | Nodes from the open file highlighted | n/a | No file concept (A2). |

### Run / operate

| # | Databricks capability | Loom | Evidence / gap |
|---|---|---|---|
| R1 | Run pipeline | ✅ | `POST /api/items/databricks-pipeline/:id/start` → Pipelines REST. |
| R2 | Run with **full table refresh** | ⚠️ | The start route accepts a body; whether the canvas exposes a full-refresh toggle is not evident from the ribbon. Treated as ⚠️ pending the click-walk. |
| R3 | Stop / cancel an update | ✅ | `POST …/stop`. |
| R4 | **Dry run** (validate, no data) | ❌ | No validate-without-running path. |
| R5 | **Run file** / **Run table** / **Run selected code** (selective execution) | ❌ | Whole-pipeline only. Iterating on one table means a full run. |
| R6 | Update history drop-down (view an older update's graph + events) | ⚠️ | **Run history** tab lists updates (`GET …/updates`), but selecting a historical update does **not** re-render the graph as it was — history is a grid, not a time machine. |
| R7 | **Event log** panel | ✅ | **Event log** tab from `GET …/events` — real `flow_progress` / `flow_definition` events. |
| R8 | Publish event log to a UC catalog table | ❌ | Read-only consumption; cannot configure `Publish to catalog`. |
| R9 | **Data quality** tab: `passed_records` / `failed_records` / `dropped_records` per dataset | ⚠️ | Expectation pass/fail counts are surfaced from the event log per the module docstring, but not as a dedicated per-dataset Data-quality panel with the three named metrics. |
| R10 | **Tables** panel incl. **Incrementalization** column for MVs | ❌ | No per-table metrics panel; no incrementalization reporting. |
| R11 | **Performance** panel (query history + query profiles) | ❌ | Not built. |
| R12 | **Issues** panel (aggregated errors/warnings, jump-to-line, Diagnose error) | ❌ | Errors surface as `MessageBar`s; no aggregated issues list, no jump-to-source. |
| R13 | Inline red squiggles + **Quick fix** | ❌ | Consequence of A2/A11 (SQL is read-only). |
| R14 | Streaming metrics charts (backlog seconds/bytes/records/files, 48 h) | ❌ | Not built. For a continuous pipeline this is the primary health signal. |

### Configuration

| # | Databricks capability | Loom | Evidence / gap |
|---|---|---|---|
| C1 | Triggered / continuous / real-time mode | ⚠️ | Typed controls exist in the spec model; the docstring does not evidence a real-time mode. Pending click-walk. |
| C2 | Serverless vs classic compute (cluster policy, mode, min/max workers, Photon, worker+driver types, tags) | ❌ | No compute configuration surface. The pipeline runs on whatever the workspace default is. |
| C3 | Unity Catalog target catalog + schema | ✅ | Bound via the spec. |
| C4 | Product edition (Core/Pro/Advanced) + channel (Current/Preview) | ❌ | Not exposed. |
| C5 | Pipeline **Parameters** (key-value, overridable at run) | ❌ | Not exposed. |
| C6 | Spark **Configuration** entries (e.g. `pipelines.enzyme.enabled`) | ❌ | Not exposed. |
| C7 | Tags | ❌ | Not exposed. |
| C8 | Pipeline environment / dependency management | ❌ | Not exposed. |
| C9 | **Schedule** dialog (materialized as a Job) | ❌ | No scheduling. A Loom-authored pipeline can only be run by hand or by an external trigger. |
| C10 | **Share** / permissions / Run-as owner | ❌ | Loom item RBAC governs the *item*; the Databricks pipeline's own ACL and Run-as are not manageable here. |
| C11 | **Notifications** (email on success / any failure / fatal / single-flow failure) | ❌ | Not exposed. |
| C12 | JSON view of the pipeline spec | ⚠️ **by design** | Deliberately absent per `loom_no_freeform_config`. Recorded because some advanced options are JSON-only in Databricks and are therefore unreachable from Loom (compounds C4-C8). |
| C13 | Bind to an existing pipeline | ✅ | `GET …/pipelines` lists real pipelines for binding. |
| C14 | Honest gate when Databricks is unwired | ⚠️ | `MessageBar intent="warning"` (`:464`, `:739`) — **not** the shared `HonestGate`, so no inline **Fix it** and no gate-registry entry (**G2** defect). |

## Totals

**11 ✅ (3 of them exceeding Databricks) · 8 ⚠️ · 29 ❌ · 1 n/a — 49 rows.**

Discounting the 6 rows that are ❌ purely as a *consequence of the deliberate
canvas-first inversion* (A3, A4, A5, A6, R13, and A2's ⚠️), the honest gap is
still **23 ❌**, concentrated in **operate** (R4-R14) and **configuration**
(C2, C4-C11).

## Backend per control

| Control | Call | Real backend |
|---|---|---|
| Load item / bound pipeline | `GET /api/items/databricks-pipeline/:id` | Cosmos DB |
| Pipeline picker (bind) | `GET …/pipelines` | Databricks **Pipelines REST** `/api/2.0/pipelines` |
| Save canvas → compile → deploy | `POST …/spec` | Compiles to DLT SQL → **imports as a workspace notebook** → creates/updates the pipeline via Pipelines REST |
| Start / Stop | `POST …/start`, `POST …/stop` | Pipelines REST update lifecycle |
| Run history | `GET …/updates?pipelineId=` | Pipelines REST updates |
| Event log | `GET …/events?pipelineId=` | Pipelines REST events (real `flow_progress` / `flow_definition`) |

Real backend on every control. No mocks. No Fabric/OneLake host contacted.

## Verdict

**Not A-grade.** The authoring half is strong and in places genuinely better than
Databricks (an editable DAG with undo/redo, align, ELK layout, and a real
compiler behind it — Databricks' graph is read-only). The **operate** half is
where it falls short, and that is the half a pipeline lives in after day one:

1. **G8 (no data preview on a node)** — the single most-used affordance in the
   Databricks pipeline UI, absent here.
2. **R14 + R10 + R11 (no streaming metrics, no per-table metrics, no query
   profiles)** — a continuous pipeline's health is not observable from Loom.
3. **C9 (no schedule)** — a pipeline you cannot schedule is a pipeline you run
   by hand.
4. **C2 (no compute config)** — cost and performance are not tunable here.
5. **R5 (no selective execution)** — every iteration is a full pipeline run.

`ui-parity.md` grades this **C**: rich canvas, real backend, but a large share
of the source UI's inventory is genuinely missing and several ❌ rows are
day-to-day workflow blockers rather than long-tail features.

## Verification

- **V3 (in-browser click-walk): OWED.** `loom-ui-verify` red since 2026-08-04
  (FINISHLINE C13); Actions degraded. When recovered:
  ```bash
  gh workflow run loom-ui-verify.yml --ref main -f target_route=/items/databricks-pipeline/<id>
  ```
  The walk must settle the ⚠️ rows: R2 (full-refresh control present?), R6
  (does selecting a historical update change the graph?), R9 (are the three
  named DQ metrics rendered?), C1 (which trigger modes are selectable?).
- Coverage read from source; static evidence only (`no_scaffold_claims`).
