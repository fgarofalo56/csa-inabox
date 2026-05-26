# Loom ADF Pipeline Editor — Studio-parity spec

> Captured 2026-05-26 by catalog agent. Source: Azure Data Factory Studio (`https://adf.azure.com`) + `learn.microsoft.com/azure/data-factory/author-visually` + `concepts-pipelines-activities` + `iterative-development-debugging` + Loom `AdfPipelineEditor` (apps/fiab-console/lib/editors/azure-services-editors.tsx:717) + `adf-client.ts`.

## Overview

Azure Data Factory Pipeline is the canonical Microsoft data-orchestration unit on the ARM provider `Microsoft.DataFactory/factories/pipelines`. Authored from **Data Factory Studio → Author tab** (pencil icon). Pipelines are a logical grouping of activities that move and transform data; the same activity model is reused by Synapse pipelines and (with extensions) Fabric Data Pipelines. ADF pipelines run on the factory's Integration Runtime (Auto-resolve, self-hosted, or Azure-SSIS). Loom routes its top-level `data-pipeline` Fabric item through ADF already — this `adf-pipeline` editor exposes ADF directly without the Fabric brand wrapper.

## UI components (ADF Studio Author tab)

### Hub bar (left rail)
- **Author** (pencil), **Monitor** (gauge), **Manage** (toolbox), **Home**

### Factory resources explorer (Author tab, left pane)
- Tree with folders: **Pipelines · Datasets · Data flows · Power Query**
- Per-folder search box
- Plus sign (+) per node — New pipeline / New folder / Import from pipeline template
- Per-pipeline right-click: Open / Clone / Move to folder / Download support files / Delete

### Authoring canvas (center)
- Empty state: blank canvas with "Drag an activity here" overlay
- Populated: activity cards with directional connectors (Success / Failure / Completion / Skip)
- Per-activity status pill once a run is observed
- Right-click: Cut / Copy / Paste / Delete / Disable / Add output dependency / Activity run consumption preview
- Container activities (ForEach / Until / If / Switch) show pencil icon → drill into inner activity panel; breadcrumb back to parent

### Activities pane (left of canvas)
- Search box
- Categories per Microsoft Learn `concepts-pipelines-activities`:
  - **Move & transform** — Copy data, Data flow
  - **Azure Data Explorer** — ADX command
  - **Azure Function** — Azure Function
  - **Batch Service** — Custom
  - **Databricks** — Notebook / Jar / Python
  - **Data Lake Analytics** — U-SQL
  - **General** — Web, Webhook, Stored procedure, Lookup, GetMetadata, Set Variable, Append Variable, Wait, Validation, Execute Pipeline, Fail
  - **HDInsight** — Hive, Pig, MapReduce, Streaming, Spark
  - **Iteration & conditionals** — ForEach, Until, If Condition, Switch
  - **Machine Learning** — ML Pipeline, ML Batch Execution, ML Update Resource, Azure ML Execute Pipeline
  - **Power Query** — Power Query
  - **Synapse** — Notebook, Spark job definition

### Properties pane (top-right of canvas)
- Toggled via pane icon (top-right corner)
- Fields: Name, Description, Annotations
- **Related** tab — triggers, parent pipelines, dependent datasets

### Pipeline configurations pane (bottom, when no activity selected)
- **Parameters** — name, type, default value
- **Variables** — name, type, default
- **Settings** — Concurrency, Annotations
- **Output** — pipeline output fields

### Activity configuration panel (bottom, when activity selected)
- Per-activity tabs (Copy activity example): **General · Source · Sink · Mapping · Settings · User properties**
- **General** tab is universal: Name, Description, Timeout (default 12h, max 7d), Retry, Retry interval (sec), Secure input (bool), Secure output (bool)

### Toolbar (above canvas)
- **Save all** (factory-wide; commits all pending changes), **Validate / Validate all**, **Publish** (only in Git-integrated factories — direct-mode auto-publishes on Save)
- **Add trigger** — Trigger now / New or edit
- **Debug** (test-run without publish) + breakpoint marker ("Debug until" — red-circle on a selected activity)
- **Data flow debug** toggle (when a Data Flow activity is on canvas)
- **Code view** ({ } icon) — raw JSON edit
- Zoom + Auto-layout + Fit-to-screen

### Output tab (debug runs)
- Per-activity row: Status, Duration, Input (link), Output (link), Error (link if failed)
- Cancel button on in-progress runs

### Monitor hub (sibling of Author)
- **Pipeline runs** — list + Gantt
- Filters: pipeline name, run start, status, run ID, triggered-by
- Drill-down: per-activity timeline, inputs/outputs JSON, error stack
- Rerun (whole pipeline) and Rerun from failed activity

## What Loom has today

- `AdfPipelineEditor` (`apps/fiab-console/lib/editors/azure-services-editors.tsx:717`) — pipeline tree, JSON spec editor (textarea), Save, Run, Run-history table, + New pipeline (skeleton with empty activities)
- Backend: `apps/fiab-console/lib/azure/adf-client.ts` — real ARM REST against `Microsoft.DataFactory/factories/{adf}` (UAMI + Data Factory Contributor)
- Routes: `/api/items/adf-pipeline` (GET list, POST create), `/api/items/adf-pipeline/[id]` (GET/PUT/DELETE), `/api/items/adf-pipeline/[id]/run` (POST), `/api/items/adf-pipeline/[id]/runs` (GET)
- Ribbon stub: Home group with Copy data / Notebook / Stored procedure / Mapping data flow / Run / Debug / Triggers — buttons render but do not wire
- Two-tab UI: **Spec (JSON)** + **Run history**
- **Shares** the Loom `data-pipeline` editor's ADF backend — same ARM provider, same `loom-adf-default-eastus2` instance. `data-pipeline` writes pipelines named `loom_<wsHash>_<displayName>`; `adf-pipeline` exposes the raw ADF names

## Gaps for Studio parity

1. **Visual canvas (DAG)** — drag-drop activity graph; the highest-value missing piece
2. **Activities pane** — 12-category tree with search and drag-source
3. **Activity configuration panel** — bottom-pane tabs per activity type (General / Source / Sink / Mapping / Settings / User properties)
4. **Properties pane** — top-right Name/Description/Annotations + Related tab
5. **Pipeline configurations pane** — Parameters / Variables / Settings / Output tabs at pipeline level
6. **Debug + breakpoints** — "Debug until" red-circle marker, in-canvas run status overlay
7. **Trigger attach UI** — "Add trigger → New or edit" inline dialog (covered partially by separate `adf-trigger` editor)
8. **Save all / Publish** — direct-mode is fine, but Git-mode factories need a publish queue UI
9. **Nested activity drill-down** — ForEach/Until/If/Switch pencil → inner canvas with breadcrumb
10. **Run history drill-down** — per-activity expansion, inputs/outputs JSON, error stack (currently flat run list only)
11. **Rerun from failed activity** — ADF supports it via `referencePipelineRunId` + `startActivityName` (gap)
12. **Cancel in-progress run** — `POST /pipelineruns/{runId}/cancel` not wired

## Backend mapping

- ARM REST under `https://management.azure.com/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.DataFactory/factories/{factory}`:
  - `GET /pipelines?api-version=2018-06-01` — list (wired in `adf-client.ts:listPipelines`)
  - `GET/PUT/DELETE /pipelines/{name}?api-version=2018-06-01` — get/upsert/delete (wired)
  - `POST /pipelines/{name}/createRun?api-version=2018-06-01` — run (wired in `runPipeline`)
  - `POST /queryPipelineRuns` with `lastUpdatedAfter`/`Before` + filters — run history (wired in `listPipelineRuns`)
  - `POST /pipelineruns/{runId}/queryActivityruns` — per-activity drill-down (gap)
  - `POST /pipelineruns/{runId}/cancel` — cancel (gap)
  - `POST /createRun?referencePipelineRunId={id}&startActivityName={name}` — rerun-from-failed (gap)
- Canvas ↔ JSON: same `properties.activities[]` + `dependsOn[]` shape used by Synapse and Fabric — translation layer is shareable

## Required Azure resources

- ADF instance (`Microsoft.DataFactory/factories`) — Loom already provisions `loom-adf-default-<region>`
- UAMI granted **Data Factory Contributor** at the factory scope (already wired — see `adf-client.ts:9`)
- Linked services + integration runtime configured for the data sources you plan to touch (Auto-resolve IR is the default)
- Managed private endpoints from ADF to backing stores (Storage, Synapse, SQL, Cosmos) where the data plane requires PE-only access

## Estimated effort

**4-5 sessions.** MVP (2 sessions): activity-quick-add buttons that append valid activity JSON skeletons + per-activity bottom config panel + Parameters/Variables tabs. Visual DAG canvas + nested drill-down + debug-until is the heavy half (2-3 sessions). Cancel + rerun-from-failed are small wins to land first (half a session each).

## Notes

- `adf-pipeline` and `data-pipeline` share an ADF backend — DAG translation layer should live in `lib/azure/` and be reused by both editors
- Activity JSON shape is the same across ADF / Synapse / Fabric — Loom's three pipeline editors can share a single canvas component
- Git-mode factories (with Azure Repos / GitHub integration) add a Publish button + branch dropdown — Loom currently assumes direct-mode (no Git)
