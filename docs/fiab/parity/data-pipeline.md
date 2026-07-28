# data-pipeline — parity with Fabric Data pipeline (Data Factory in Fabric)

Source UI: Fabric → Data Factory → Data pipeline editor
(https://learn.microsoft.com/fabric/data-factory/pipeline-overview,
https://learn.microsoft.com/fabric/data-factory/activity-overview,
https://learn.microsoft.com/fabric/data-factory/pipeline-runs).

Azure-native backend (per `no-fabric-dependency.md`): **Azure Data Factory /
Synapse pipelines** via ARM REST (`Microsoft.DataFactory/factories` /
`Microsoft.Synapse/workspaces`, api-version `2018-06-01`). No Fabric capacity or
workspace is required — the flagship `DataPipelineEditor` renders fully and
runs against ADF by default. The `adf` / `synapse` runtime presets delegate to
`AdfPipelineEditor` / `SynapsePipelineEditor` (PipelineEditorCore-backed) so
bind/save/validate/run/debug/triggers reuse the existing
`/api/items/{adf-pipeline|synapse-pipeline}/{id}/*` routes; the `fabric` preset
is the only path that touches a Fabric workspace and is strictly opt-in.

## Fabric Data pipeline editor inventory (grounded in Learn)

The real Fabric pipeline editor exposes:

1. **Activities pane / +Add pane** — categorized, searchable activity gallery:
   Move & transform (Copy data, Dataflow Gen2, Mapping data flow); Orchestration
   (Notebook, Spark Job, Invoke pipeline, Databricks, HDInsight, ML); Control
   flow (Set/Append variable, Filter, ForEach, If, Switch, Until, Wait, Fail,
   Validation); Lookup, Get metadata, Delete, Script, Stored procedure, Web,
   Webhook, Functions, Office 365 Outlook.
2. **Authoring canvas** — activity cards with icons; drag-to-add, drag-to-move,
   select; dependency arrows on four conditions (**On success / On failure / On
   completion / On skip**); container activities (ForEach/If/Switch/Until) drill
   into inner sub-canvases.
3. **Bottom configuration panel** — per selected activity: General + Source/Sink
   /Settings + activity policy (timeout, retry, retryInterval, secureOutput).
4. **Pipeline configuration tabs** — Parameters, Variables, Settings, Output
   (run monitor / run history below the canvas).
5. **Home ribbon** — Save, Run, Schedule, Add trigger, Validate, Debug, plus
   View controls (grid, snap, fit, reset zoom). **Run/Schedule/Trigger** produce
   a run ID monitored in the Output tab. Event/scheduled/on-demand triggers.
6. **Templates** gallery and **Copilot** authoring assist.

## Loom coverage

| Fabric capability | Loom coverage | Backend (real REST) |
| --- | --- | --- |
| Workspace + pipeline picker | ✅ built — Loom workspace select + pipeline list/create | `GET /api/loom/workspaces`, `GET/POST /api/items/data-pipeline` (ADF listPipelines/upsert) |
| **Activities palette** — searchable, 3 categories | ✅ built — `ActivityPalette` over `ACTIVITY_CATALOG` (Copy, Dataflow Gen2, Mapping data flow, Lookup, Get metadata, Delete, Notebook, Spark Job, Invoke pipeline, Script, Stored procedure, HDInsight ×5, Synapse/Databricks notebooks, Azure Function, ML ×2, U-SQL, Web, Webhook, Approval/Logic App, Fail, Validation, Office 365, Set/Append variable, Filter, ForEach, If, Switch, Until, Wait) | n/a (client) |
| **Authoring canvas** — cards, drag-add/move, select, pan/zoom | ✅ built — `PipelineCanvas` + `CanvasHandle` | spec from `GET /api/items/data-pipeline/[id]` |
| **4 dependency conditions** (success/failure/completion/skip) | ✅ built — colour-coded output ports → `dependsOn[]` | persisted on Save (PUT) |
| Nested control-flow sub-canvases (ForEach/If/Switch/Until drill) | ✅ built — same drill/breadcrumb model as `adf-pipeline` core | inner activities round-trip in `typeProperties.activities` / branch arrays |
| **Bottom configuration dock** for selected activity | ✅ built — `PropertiesPanel` in resizable `configDock` (General/Source-Sink/Settings/policy) | `PUT /api/items/data-pipeline/[id]` |
| **Parameters / Variables / Settings / Output** tabs | ✅ built — `TopTabs` (Pipeline \| Parameters \| Variables \| Settings \| Output) | round-trips `properties.{parameters,variables,…}` |
| Save | ✅ built — Home → Save (+Ctrl+S) | `PUT /api/items/data-pipeline/[id]` (createOrUpdate) |
| Validate | ✅ built — Home → Validate | `POST /api/items/data-pipeline/[id]/validate` |
| Run (on-demand) | ✅ built — Home → Run | `POST /api/items/data-pipeline/[id]/run` (createRun) |
| Debug | ✅ built — Home → Debug | `POST /api/items/data-pipeline/[id]/debug` |
| Schedule / Add trigger (list/create/start/stop) | ✅ built — `TriggerWizard` | `GET/POST/DELETE /api/items/data-pipeline/[id]/triggers` |
| Output / run history (monitor) | ✅ built — Output pane | `GET /api/items/data-pipeline/[id]/output[?runId]`, `.../jobs` |
| **In-canvas Debug/Output overlay** — per-activity run-status glyphs on the nodes, floating run strip (status/progress), eyeglass → run detail (input/output/error JSON) | ✅ built — U13 `pipeline-debug-overlay` painted by the shared `PipelineCanvas` (both canvases: this editor AND `PipelineDesigner`); in-canvas Output dock below the graph; kill-switch `u13-pipeline-run-overlay` | same `GET .../output?runId=` (queryActivityRuns) — one run path |
| **Rerun from failed activities / rerun from activity** (ADF recovery run) | ✅ built — run strip + eyeglass dialog + Debug tab button | `POST /api/items/data-pipeline/[id]/debug` (createRun `isRecovery=true` + `startFromFailure` / `startActivityName`) |
| Publish | ✅ built | `POST /api/items/data-pipeline/[id]/publish` |
| Import / Export pipeline JSON | ✅ built | `POST /api/items/data-pipeline/import`, `GET .../[id]/export` |
| Manage connections / Integration runtimes | ✅ built — `PipelineManageHub` / `ManagePanel` | `GET .../[id]/connections`, `.../integration-runtimes` |
| Templates gallery | ✅ built — `TemplateGalleryFlyout` over `PIPELINE_TEMPLATES` | client → same PUT on apply |
| Pipeline **Copilot** (NL → spec) | ✅ built — `PipelineCopilotPane`, SSE | `POST /api/items/data-pipeline/[id]/copilot` (AOAI/ADF) |
| Approval step (Fabric Outlook approval) | ✅ built — Approval activity via Logic App | `POST /api/items/data-pipeline/[id]/approval-logicapp` |
| Practice / sample pipeline seed | ✅ built — start-card "Practice" | `POST /api/items/data-pipeline/practice-seed` |
| Activities with no ADF equivalent (Dataflow Gen2 refresh, Office 365 email) | ⚠️ honest-gate — saveable but flagged "Save-only" with a MessageBar | n/a |
| Factory / Synapse workspace not provisioned | ⚠️ honest-gate — list error names the missing env var (`LOOM_ADF_NAME`); full UI still renders | n/a |

Zero ❌. Zero stub banners. The default path is Azure Data Factory — no Fabric
workspace is read unless `LOOM_PIPELINE_BACKEND=fabric` is explicitly set.

## Backend per control

- Workspaces / list / create: `/api/loom/workspaces`, `/api/items/data-pipeline`.
- Spec GET/PUT/DELETE: `/api/items/data-pipeline/[id]` → ADF `getPipeline`/`upsertPipeline`.
- Validate / Run / Debug / Publish: `/api/items/data-pipeline/[id]/{validate,run,debug,publish}`.
- Triggers: `/api/items/data-pipeline/[id]/triggers` (list/create/start/stop/delete).
- Output / jobs: `/api/items/data-pipeline/[id]/{output,jobs}` (queryPipelineRuns).
- Import / export: `/api/items/data-pipeline/import`, `/api/items/data-pipeline/[id]/export`.
- Connections / IRs: `/api/items/data-pipeline/[id]/{connections,integration-runtimes}`.
- Copilot: `/api/items/data-pipeline/[id]/copilot` (SSE orchestrator, ADF backend).
- Approval: `/api/items/data-pipeline/[id]/approval-logicapp` (Azure Logic App).
- `adf` / `synapse` presets delegate to `/api/items/{adf-pipeline|synapse-pipeline}/[id]/*`.
