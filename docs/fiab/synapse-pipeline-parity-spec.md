# Loom Synapse Pipeline Editor — Studio-parity spec

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.


> Captured 2026-05-26 by catalog agent. Source: Synapse Studio Integrate hub (`https://web.azuresynapse.net`) + `learn.microsoft.com/azure/data-factory/author-visually` + `concepts-pipelines-activities` + Loom `SynapsePipelineEditor` (apps/fiab-console/lib/editors/azure-services-editors.tsx) and `synapse-dev-client.ts`.

## Overview

Synapse Pipeline is the legacy / pre-Fabric visual orchestrator embedded inside an Azure Synapse Analytics workspace. Authored from Synapse Studio → **Integrate** hub. Shares the ADF activity model (Copy, Notebook, Stored procedure, Dataflow, ForEach, etc.) but is scoped to a single Synapse workspace and runs against the workspace's own integration runtime. Pipelines are addressable via the Synapse dev endpoint (`<workspace>.dev.azuresynapse.net/pipelines`) — not via the ADF ARM provider — which is why Loom keeps a separate `synapse-pipeline` route group from `adf-pipeline`.

## UI components (Synapse Studio Integrate hub)

### Hub bar (left rail)
- **Integrate** icon (pipeline glyph) — top-level hub; sibling to Develop / Data / Monitor / Manage

### Resource explorer (left pane, inside Integrate)
- **Pipelines** folder (tree) — list of pipelines in the workspace
- **Browser gallery / Templates** — Synapse-curated pipeline templates
- **Copy data tool** — guided wizard launcher
- **Import resource** — load pipeline JSON

### Authoring canvas (center)
- Empty state: blank canvas with "drag an activity from the left to start"
- Populated: activity nodes wired by directional connectors (Success=green, Failure=red, Completion=blue, Skip=gray)
- Pencil icon on container activities (ForEach / Until / If / Switch) to drill into nested activity panel; breadcrumb back to parent pipeline
- Per-activity context menu: Cut / Copy / Paste / Delete / Disable / Add output dependency

### Activities pane (left of canvas, separate from resource explorer)
- Search box
- Activity categories per Microsoft Learn `concepts-pipelines-activities`:
  - **Move & transform** — Copy data, Data flow
  - **Synapse** — Notebook, Spark job definition
  - **Azure Data Explorer** — Azure Data Explorer Command
  - **Azure Function** — Azure Function
  - **Batch Service** — Custom
  - **Databricks** — Notebook / Jar / Python
  - **General** — Web, Webhook, Stored procedure, Lookup, GetMetadata, Set/Append Variable, Wait, Validation
  - **HDInsight** — Hive, Pig, MapReduce, Streaming, Spark
  - **Iteration & conditionals** — ForEach, Until, If Condition, Switch
  - **Machine Learning** — ML Pipeline, ML Batch Execution, ML Update Resource
- Drag-drop onto canvas

### Properties pane (right of canvas, top-level)
- Opens on resource create or via top-right pane toggle
- Fields: Name, Description, Annotations
- **Related** tab — resources that reference this pipeline (triggers, parent pipelines via Execute Pipeline)

### Configurations pane (bottom of canvas, top-level when no activity selected)
- **Parameters** — pipeline input params (Name · Type {String/Int/Bool/Float/Array/Object/SecureString} · Default value)
- **Variables** — runtime vars set via Set Variable / Append Variable
- **General** — Concurrency, Annotations, Description, Folder
- **Output** — fields surfaced as pipeline output

### Activity configuration panel (bottom of canvas, when activity selected)
- Per-activity tabs (typical): **General** (name, description, timeout, retry, retry interval, secure input/output) · **Settings** (activity-specific config) · **User properties** · **Output** (preview JSON)
- Copy activity adds: **Source** · **Sink** · **Mapping** · **Settings**

### Top toolbar (above canvas)
- **Save all** (workspace-wide publish), **Validate all**, **Publish**
- **Add trigger** dropdown — Trigger now / New or edit
- **Debug** + **Set breakpoint** ("Debug until" — empty-red-circle marker on a chosen activity)
- **Data flow debug** toggle (when a Data Flow activity is in the pipeline)
- **Code view** ({ } icon) — raw JSON edit
- Zoom in / Zoom out / Zoom to fit / Auto-layout

### Output tab (test runs)
- Per-activity row: status (Queued / In progress / Succeeded / Failed / Cancelled), duration, input/output icons, error message
- Cancel button on in-progress runs

### Monitor hub integration
- Triggered pipeline runs surface in **Monitor → Pipeline runs**
- List view + Gantt chart toggle
- Drill-down: per-activity status + diagnostic logs

## What Loom has today

- `SynapsePipelineEditor` (`apps/fiab-console/lib/editors/azure-services-editors.tsx:390`) — pipeline list, JSON spec editor (textarea), Save, Run, Run history table
- Backend: `apps/fiab-console/lib/azure/synapse-dev-client.ts` → real Synapse dev endpoint REST (`listPipelines`, `getPipeline`, `upsertPipeline`, `runPipeline`, `listPipelineRuns`)
- Routes: `/api/items/synapse-pipeline/list`, `/api/items/synapse-pipeline/[id]` (GET/PUT), `/api/items/synapse-pipeline/[id]/run`, `/api/items/synapse-pipeline/[id]/runs`
- Two-tab UI: **Spec (JSON)** + **Run history**
- Ribbon stub: Home group with Copy data / Notebook / Stored procedure / Mapping data flow / Run / Debug / Triggers — buttons render but do not wire to activity add or debug
- **No** canvas, **no** activity drag-drop, **no** properties pane, **no** activity configuration panel, **no** debug-until breakpoint

## Gaps for Studio parity

1. **Visual canvas (DAG)** — drag-drop activity graph with directional connectors
2. **Activities pane** — 10+ category tree with search and drag-source
3. **Activity configuration panel** — bottom-pane tabs per activity type (General / Settings / Mapping / Source / Sink / User properties / Output)
4. **Properties pane** — top-right name/description/annotations + Related tab
5. **Configurations pane** — Parameters / Variables / General / Output tabs at pipeline level
6. **Debug + breakpoints** — "Debug until" red-circle marker, in-canvas run status overlay
7. **Save all / Publish** semantics — workspace-wide publish vs single-pipeline upsert
8. **Trigger attach UI** — "Add trigger → New or edit" inline dialog
9. **Nested activity drill-down** — ForEach/Until/If/Switch pencil → inner canvas with breadcrumb
10. **Code view toggle** — keep JSON editor as a "{ }" mode alongside canvas (Loom already has the JSON side)
11. **Run history drill-down** — per-activity expansion, input/output JSON, diagnostic logs (currently flat row list)

## Backend mapping

- Synapse dev endpoint REST (`{workspace}.dev.azuresynapse.net`):
  - `GET /pipelines?api-version=2020-12-01` — list (wired)
  - `GET/PUT /pipelines/{name}?api-version=2020-12-01` — get/upsert (wired)
  - `POST /pipelines/{name}/createRun?api-version=2020-12-01` — run (wired)
  - `POST /queryPipelineRuns?api-version=2020-12-01` — run history (wired)
  - `POST /pipelines/{name}/createRun?isRecovery=true` — rerun from failed activity (gap)
  - `GET /pipelineruns/{runId}/queryActivityruns` — per-activity drill-down (gap)
  - `POST /pipelineruns/{runId}/cancel` — cancel in-progress (gap)
- Trigger attach lives in `/triggers/{name}` on the same dev endpoint (covered by separate Synapse Trigger item, deferred)
- Activity DAG ↔ pipeline JSON translation: canvas → `properties.activities[]` with `dependsOn` edges; same JSON shape as ADF, no schema fork

## Required Azure resources

- Azure Synapse Analytics workspace (`Microsoft.Synapse/workspaces`)
- Workspace Integration Runtime (AutoResolveIntegrationRuntime is default)
- UAMI granted **Synapse Contributor** or **Synapse Artifact Publisher** at workspace scope
- Storage Blob Data Contributor on workspace's primary ADLS Gen2 account (for Copy / staging)
- Optional: managed VNet + managed private endpoints to data sources

## Estimated effort

**4-5 sessions.** MVP path (2 sessions): activity-quick-add buttons in ribbon + per-activity bottom config panel + parameters/variables tabs, keeping JSON code view as fallback. Visual DAG canvas + nested drill-down + debug-until is the heavy half (2-3 sessions).

## Notes

- Activity JSON shape is identical to ADF — the canvas/translation work is reusable across `adf-pipeline` and `synapse-pipeline` editors
- Synapse Studio Integrate hub is being deprecated in favor of Fabric Data Factory pipelines; Loom keeps it for workspaces that haven't migrated and for Gov regions where Fabric isn't GA
- Copilot NL → pipeline build is a Studio preview feature — parked until Loom AI Foundry agent path is wired
