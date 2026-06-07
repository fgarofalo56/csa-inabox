# PRP — Data Factory (CSA Loom ↔ Microsoft Fabric "Data Factory" parity, Azure-native)

> **Scope.** Bring CSA Loom to **one-for-one functional parity** with the
> *Data Factory in Microsoft Fabric* experience — the Data Pipelines authoring
> surface (canvas, landing page, ribbon, parameters, variables, settings,
> output, expression builder, activity library) plus the simplified Copy Job
> and Dataflow Gen2 entry points.
>
> **Hard constraint (governing rules).** Per
> `.claude/rules/no-fabric-dependency.md`, **no item, object, or control may
> hard-gate on a real Microsoft Fabric capacity, workspace, or Power BI
> tenant.** The default backend is **Azure Data Factory (ADF)** (with
> Synapse pipeline as an alternate, OSS where a gap exists). Fabric is
> strictly opt-in via `LOOM_PIPELINE_BACKEND=fabric` + a bound workspace.
> Per `.claude/rules/no-vaporware.md`, **nothing ships unless it is functional
> end-to-end** (real REST, no mock arrays, no dead buttons). Per
> `.claude/rules/ui-parity.md`, the answer to a thin surface is **build the
> feature**, never hide a header.
>
> **Status legend (used throughout):** `built` ✅ = real-data functional ·
> `placeholder` 🟡 = renders but not wired · `stub` 🟠 = entry exists, no real
> work · `honest-gate` ⚠️ = renders + names exact infra to provision ·
> `missing` ❌ = not present.

---

## 1. Overview & Azure-native + OSS architecture

### 1.1 What this experience is

Fabric's *Data Factory* is the data-movement and orchestration workload:
visual **Data Pipelines** (the ADF/Synapse control-flow engine), the simplified
**Copy Job**, and **Dataflow Gen2** (Power Query Online). In CSA Loom the
control-flow engine maps **1:1 to Azure Data Factory pipeline JSON** — the same
schema ADF and Synapse pipelines use — so every activity, expression, parameter,
trigger, and run artifact is the genuine ADF object, themed with Fluent v9 +
Loom tokens.

### 1.2 Backend mapping (default → opt-in)

| Concern | **Azure-native DEFAULT** | OSS where needed | Fabric (opt-in only) |
|---|---|---|---|
| Pipeline definition + control flow | **ADF pipeline JSON** via ADF mgmt REST | — | Fabric pipeline item |
| Pipeline run / debug / activity runs | **ADF `createRun` / `queryActivityRuns`** | — | Fabric pipeline run |
| Schedules + event triggers | **ADF triggers** (Schedule, Tumbling, Storage/Custom-event via Event Grid) | — | Reflex/Activator |
| Data movement (Copy) | **ADF Copy activity** (90+ connectors, staging, DIU) | — | Fabric Copy |
| Copy Job (watermark) | **ADF Lookup→Copy→SetVariable pattern** + control table in **Azure SQL** | — | Fabric Copy Job |
| Mapping data flow | **ADF Mapping Data Flow** (Spark-backed) | — | Dataflow Gen2 |
| Power Query authoring | **Power Query Online (embedded)** → compiles to PQ/Mapping flow | `powerquery-formula` lib for client lint | Dataflow Gen2 runtime |
| Long-run logging | **Azure Monitor / Log Analytics** (`ADFPipelineRun`, `ADFActivityRun`) | — | Fabric monitoring |
| Expression evaluation (pre-run) | **ADF debug breakpoint run** for activity-output context | **`expr-eval` / `jsonata`** for client-side param/var/function preview | — |
| Approval gates | **Logic App (Consumption) + Office 365 approval** via ADF Webhook activity | — | Outlook/Reflex |

The pipeline definition is the genuine ADF control plane; Loom never invents a
parallel schema. This guarantees portability and round-trips to/from real ADF.

### 1.3 Cloud portability (all four cloud types)

ADF, ADLS Gen2, Event Grid, Logic Apps, Azure SQL, Log Analytics, and Monitor
are GA in every target cloud. Endpoints resolve from a single cloud-profile map
(already used by `adf-client.ts` via `azure-cloud.ts`):

| Endpoint | Commercial | Government (GCC-High / GCC / DoD) | China (21Vianet) | Secret / Top-Secret (air-gapped) |
|---|---|---|---|---|
| ARM / ADF mgmt | `management.azure.com` | `management.usgovcloudapi.net` | `management.chinacloudapi.cn` | sovereign ARM (account-team) |
| Entra (AAD) authority | `login.microsoftonline.com` | `login.microsoftonline.us` | `login.chinacloudapi.cn` | sovereign authority |
| ADLS Gen2 (dfs) | `dfs.core.windows.net` | `dfs.core.usgovcloudapi.net` | `dfs.core.chinacloudapi.cn` | sovereign storage suffix |
| Log Analytics ingest | `ods.opinsights.azure.com` | `ods.opinsights.azure.us` | `ods.opinsights.azure.cn` | sovereign |
| ARM resource scope (token aud) | `https://management.azure.com/` | `https://management.usgovcloudapi.net/` | `https://management.chinacloudapi.cn/` | sovereign |

GCC and GCC-High workloads use the **Government** endpoints; IL5 routes through
Azure Government Secret/Top-Secret. **No code path may reference
`api.fabric.microsoft.com`, `api.powerbi.com`, or `onelake.dfs.fabric.microsoft.com`
on the default path** (`.claude/rules/no-fabric-dependency.md`).

### 1.4 Real backend wiring that already exists (grounding)

- `apps/fiab-console/lib/azure/adf-client.ts` — full ADF REST surface:
  `listPipelines/getPipeline/upsertPipeline/deletePipeline`,
  `runPipeline/debugPipeline/validatePipeline`,
  `listActivityRuns/listPipelineRuns`,
  `list/get/upsert/delete Dataset|DataFlow|Trigger|LinkedService|IntegrationRuntime`,
  `start/stopTrigger`, `start/stop/getStatus IntegrationRuntime`,
  mounted-factory read-through. Cloud-aware via `adfConfigGate()`.
- API routes under `apps/fiab-console/app/api/items/data-pipeline/`:
  `route.ts` (list/create), `[id]/route.ts` (get/put/delete),
  `[id]/run`, `[id]/debug`, `[id]/validate`, `[id]/triggers`,
  `[id]/output`, `[id]/jobs`, `[id]/publish`.
- Editor + components under `lib/editors/data-pipeline-editor.tsx`,
  `lib/components/pipeline/*` (canvas, palette, properties-panel,
  dynamic-content, expression-functions, output-pane, trigger-wizard,
  activity-catalog with 26 activity types, loom-bezier-edge, flow-layout).

This PRP closes the **gaps** against that base, not a greenfield build.

---

## 2. Feature-by-feature parity table

| # | Fabric feature | Azure-native backend | Loom UI | Portability | Current Loom status | Work needed |
|---|---|---|---|---|---|---|
| F1 | Pipeline Canvas (DAG) | ADF pipeline JSON; React Flow render | `pipeline/canvas.tsx`, `pipeline-dag-view.tsx`, `flow-layout.ts` — nodes w/ icon, name, delete/view-JSON/copy/add-connection, bezier dependency edges, pan/zoom/fit/auto-align, search, breadcrumb | ADF GA all clouds | **built ✅** | Add keyboard map (Shift+arrows pan, I/O zoom, F fit, A align) + "updated canvas" inline nested-preview for containers; large-graph virtualization |
| F2 | Pipeline Landing Page | ADF create wizard; ADLS Gen2 sample data | `data-pipeline-editor.tsx` landing cards (Copy Data, Practice w/ sample, Templates, Activity library) | ADF + ADLS all clouds | **built ✅** | Wire "Practice with sample data" to a real ADLS Gen2 seed + auto-generated copy pipeline run (no mock) |
| F3 | Home-tab Toolbar (Run/Schedule/Trigger/Template/Export/Import/Save/Validate) | ADF REST: `createRun`, triggers, `validate`, pipeline GET/PUT | `data-pipeline-editor.tsx` ribbon | ADF REST all clouds | **built ✅** (Export/Import/Template gallery partial) | Add Export→.zip (GET JSON → package), Import←.zip (POST), Template gallery flyout with real templates |
| F4 | Pipeline Parameters (≤50; String/Int/Float/Bool/Array/Object/SecureString) | ADF `parameters` key | Parameters tab; `types.ts` `paramsFromSpec/paramsToSpec` | identical all clouds | **built ✅** | Add schedule-time override UI backed by Key Vault / App Config trigger parameterization (Variable-library substitute) |
| F5 | Pipeline Variables (String/Bool/Array, mutable) | ADF `variables`; Set/Append Variable | Variables tab; `varsFromSpec/varsToSpec` | identical | **built ✅** | Add "not thread-safe in parallel ForEach" banner when Set Variable nested in parallel ForEach |
| F6 | Pipeline Settings (concurrency, logging) | ADF `concurrency`, session-log path | `properties-panel.tsx` Settings tab | identical | **built ✅** | none material (verify logging ADLS path validated) |
| F7 | Pipeline Output Tab | ADF `queryActivityRuns`; Log Analytics for retention | `output-pane.tsx` — poll, status, in/out JSON modal, filter, column options, CSV export, Load More | ADF REST all clouds; LA Gov `ods.opinsights.azure.us` | **built ✅** | Add Log Analytics fallback query (ADFActivityRun) when run >45 days old |
| F8 | Expression Builder / Dynamic Content | ADF expression language (server-evaluated) | `dynamic-content.tsx`, `expression-functions.ts` — categorized funcs, params/vars/activity-output insert, @{} interpolation, Monaco IntelliSense | identical | **built ✅** | none (surface only; ADF evaluates) |
| F9 | Evaluate Expression (pre-run debugger) | client preview (`expr-eval`/`jsonata`) + ADF debug for activity-output ctx | `dynamic-content.tsx` editor exists, **no Evaluate button** | identical | **placeholder 🟡** | Add Evaluate button: editable sample values for params/vars/system-vars → preview; activity-output → minimal ADF debug run |
| F10 | Pipeline System Variables | ADF `@pipeline().*` | `expression-functions.ts` System Variables list (read-only) | identical | **built ✅** | none |
| F11 | Activity General Settings (Name/Desc/Timeout/Retry/Secure I-O/State) | ADF activity `policy` | `properties-panel.tsx` General tab + `activity-forms.tsx` | identical | **built ✅** | none |
| F12 | Dependency / Control-flow edges (Success/Failed/Completed/Skipped) | ADF `dependsOn` + condition | `loom-bezier-edge.tsx` colored edges; `flow-activity-node.tsx` connector DnD | identical | **built ✅** | none |
| F13 | Copy Data activity (90+ connectors, staging, mapping, DIU) | ADF Copy activity | `activity-catalog.ts` Copy; `activity-forms.tsx` (no Source/Sink/Mapping tabs) | identical | **partial 🟡** | Build Source / Sink / Mapping / Settings tabbed config (dataset+linkedService picker, staging, DIU, fault tolerance) — replace manual JSON |
| F14 | Copy Job (simplified wizard, watermark) | ADF Lookup→Copy→SetVariable + Azure SQL control table | none dedicated | identical | **stub 🟠** | Build copy-job wizard (Source→Dest→Mode Full/Incremental→Update Append/Overwrite/Merge→Mapping→Review); generate ADF pipeline; persist watermark in Azure SQL control table |
| F15 | Dataflow Gen2 activity (Power Query Online, 300+ M funcs) | ADF Mapping Data Flow + embedded Power Query Online | `dataflow-gen2-editor.tsx` fetches Fabric workspace; RefreshDataflow `runnable:false` | PQ Online + Mapping flow all clouds | **honest-gate ⚠️ → must become built** | Embed Power Query Online; compile to PQ/Mapping-flow activity; remove Fabric dependency from default path |
| F16 | Notebook activity (Databricks/HDInsight Spark) | ADF Databricks Notebook via linked service | `activity-catalog.ts` Notebook; `activity-forms.tsx` notebookPath | identical | **built ✅** | none |
| F17 | HDInsight activity (Hive/Spark/MapReduce/Streaming) | ADF HDInsight linked service | not in catalog | identical | **stub 🟠** | Add 4 HDInsight activity entries + forms (job type, script path, args, cluster) |
| F18 | Spark Job Definition activity | ADF Synapse/Databricks Spark Job | `activity-catalog.ts` SparkJob | identical | **built ✅** | none |
| F19 | Stored Procedure activity | ADF SqlServerStoredProcedure | catalog + form | identical | **built ✅** | none |
| F20 | Script activity (SQL) | ADF Script activity | catalog + form (Monaco SQL) | identical | **built ✅** | none |
| F21 | Delete Data activity | ADF Delete activity | catalog + form | identical | **built ✅** | none |
| F22 | Set/Append/Filter/ForEach/If/Switch/Until/Wait | ADF control activities | catalog (all present) + forms | identical | **built ✅** | verify ForEach/Switch/Until nested-canvas drill works (breadcrumb) |
| F23 | Lookup / Get Metadata | ADF Lookup, GetMetadata | catalog + forms | identical | **built ✅** | none |
| F24 | Web / Webhook / Fail / Validation | ADF Web/Webhook/Fail/Validation | catalog + forms | identical | **built ✅** | none |
| F25 | Approval activity (Office 365 + Logic App) | Logic App Consumption + O365 approval via ADF Webhook | not present | Logic Apps all clouds | **missing ❌** | Build Approval activity: Webhook → Logic App template (deployable via bicep), poll callback |
| F26 | Invoke (Execute) Pipeline | ADF ExecutePipeline | catalog + form | identical | **built ✅** | none |
| F27 | Triggers (Schedule, Tumbling, Storage-event, Custom-event) | ADF triggers + Event Grid | `trigger-wizard.tsx`; `[id]/triggers` route | Event Grid all clouds | **built ✅** (verify storage-event subscription) | Confirm Event Grid system-topic subscription created on storage-event trigger; no Reflex |
| F28 | Templates gallery | curated ADF pipeline JSON templates | flyout (partial) | identical | **partial 🟡** | Ship real template set (Copy, ForEach-Copy, Incremental, Metadata-driven) installable to canvas |

---

## 3. Azure / OSS services used — full surface to rebuild 1:1

### 3.1 Azure Data Factory (primary engine)
Native UIs to mirror (ADF Studio):
- **Author canvas** — activities palette, drag/drop, dependency connectors,
  zoom/fit/auto-align, validate-all, annotations.
- **Activity config tabs** — General, Source, Sink, Mapping, Settings,
  User properties (per activity type).
- **Parameters / Variables / Settings** panes on pipeline background.
- **Add dynamic content** dialog (expression builder, function reference).
- **Debug** with breakpoints; **Output** with input/output peek.
- **Triggers** — New/Edit (Schedule, Tumbling window, Storage event, Custom event).
- **Linked services / Datasets / Integration runtimes** manager.
- **Monitor** — pipeline runs, activity runs, trigger runs, rerun, gantt.
REST: `Microsoft.DataFactory/factories/pipelines|datasets|dataflows|triggers|linkedServices|integrationRuntimes` + `createRun`, `queryActivityRuns`, `queryPipelineRuns`, `validate`.

### 3.2 Power Query Online (Dataflow Gen2 substitute)
Surfaces: query editor (steps pane, formula bar, data preview grid, ribbon
Transform/Add column/View), connector gallery, M editor (Advanced editor),
diagram view. Embed the same component ADF uses; compile to PQ/Mapping flow.
OSS lint via `powerquery-formula` parser client-side.

### 3.3 Azure Event Grid (event triggers)
System topics on the storage account; event subscriptions filter
`Microsoft.Storage.BlobCreated/BlobDeleted`. UI: subject begins/ends-with,
event-type filter. REST: `Microsoft.EventGrid/systemTopics/eventSubscriptions`.

### 3.4 Azure Logic Apps (Consumption) — approvals
Surface: designer (we ship a fixed approval workflow template), run history.
ADF Webhook activity posts to the trigger URL with a `callBackUri`; the Logic
App sends an O365 "Start and wait for an approval" and POSTs the result back.

### 3.5 Azure SQL Database — Copy Job control table
A `dbo.copy_watermark` table (`source`, `table`, `last_value`, `updated_utc`).
Lookup reads the high-watermark; Copy uses it in a parameterized query;
SetVariable + StoredProcedure persists the new max. Real TDS execution.

### 3.6 Azure Monitor / Log Analytics — long-run history
Diagnostic settings route `PipelineRuns`/`ActivityRuns` to a workspace;
output-pane falls back to `ADFActivityRun` KQL when a run is older than ADF's
45-day native window.

---

## 4. Sequenced task list (implementation-ready)

Each task: **Goal · Files · Backend/REST · Bicep/portability · UI surface ·
Acceptance (zero stubs/mocks)**. Tasks are ordered to land highest-value gaps
first and to keep `main` green at every step.

### Task 1 — Copy Data activity: Source / Sink / Mapping / Settings tabs
- **Goal:** Replace manual JSON for the Copy activity with a tabbed config
  surface at ADF parity (F13).
- **Files (edit):** `lib/components/pipeline/activity-forms.tsx`,
  `lib/components/pipeline/properties-panel.tsx`,
  `lib/components/pipeline/activity-catalog.ts`; (new)
  `lib/components/pipeline/copy/source-tab.tsx`, `sink-tab.tsx`,
  `mapping-tab.tsx`, `copy-settings-tab.tsx`,
  `lib/components/pipeline/dataset-picker.tsx`.
- **Backend/REST:** `adf-client.ts` `listDatasets`, `listLinkedServices`,
  `getDataset`; persist into Copy activity `typeProperties.source/sink`,
  `enableStaging`, `dataIntegrationUnits`, `translator` (column mapping).
- **Bicep/portability:** none new (uses existing ADF). Confirm dataset picker
  resolves via cloud profile.
- **UI:** four tabs in properties pane when a Copy node is selected; dataset +
  linked-service dropdowns (real lists), staging toggle + ADLS path, DIU slider,
  fault-tolerance, mapping grid w/ import-schemas.
- **Acceptance:** Select a Copy node → pick a real source dataset and sink
  dataset from the live ADF account → Save (PUT) → Run → Output shows rows
  copied. No JSON textarea required for the happy path; no mock dataset list.

### Task 2 — Evaluate Expression (pre-run debugger) (F9)
- **Goal:** Add an **Evaluate** button to the dynamic-content modal that previews
  expression output.
- **Files (edit):** `lib/components/pipeline/dynamic-content.tsx`; (new)
  `lib/components/pipeline/evaluate-expression.ts`,
  `app/api/items/data-pipeline/[id]/evaluate/route.ts`.
- **Backend/REST:** client-side `expr-eval`/`jsonata` for
  param/var/function/system-var contexts; for `@activity(...).output` context,
  POST to evaluate route → `debugPipeline` minimal breakpoint run via
  `adf-client.ts`.
- **Bicep/portability:** none.
- **UI:** "Evaluate" button; component breakdown table with editable Value fields
  for runtime-only values (trigger time, run ID, activity outputs); result panel.
- **Acceptance:** Author `@concat(pipeline().parameters.env,'-',variables('x'))`,
  enter sample values, Evaluate → correct string shown. An activity-output
  expression triggers a real debug run and shows the resolved value. No fake
  output.

### Task 3 — Dataflow Gen2 → Azure-native Power Query Online (remove Fabric dep) (F15)
- **Goal:** Make Dataflow Gen2 authoring + the RefreshDataflow activity work on
  the **default Azure path** with **no Fabric workspace** (no-fabric-dependency).
- **Files (edit):** `lib/editors/dataflow-gen2-editor.tsx`,
  `lib/components/pipeline/activity-catalog.ts` (RefreshDataflow → runnable);
  (new) `lib/components/pipeline/dataflow/power-query-host.tsx`,
  `app/api/items/dataflow-gen2/[id]/run/route.ts`.
- **Backend/REST:** embed Power Query Online; compile authored M to an ADF
  **Mapping Data Flow** (`upsertDataFlow`) or Power Query activity; run via ADF
  Spark. Fabric path only when `LOOM_PIPELINE_BACKEND=fabric` + bound workspace.
- **Bicep/portability:** ensure a Spark-capable IR / Mapping-flow compute is
  available; add `LOOM_DATAFLOW_BACKEND` env (default `adf`).
- **UI:** Power Query editor (steps, preview, ribbon); destination picker
  (ADLS/Azure SQL).
- **Acceptance:** With `LOOM_DEFAULT_FABRIC_WORKSPACE` **unset**, author a 2-step
  query, set ADLS destination, Run → real rows written to ADLS Delta. Receipt
  shows ADF Mapping-flow run, not a Fabric call.

### Task 4 — Copy Job wizard + watermark (F14)
- **Goal:** Simplified, guided incremental copy at Fabric Copy-Job parity.
- **Files (new):** `lib/editors/copy-job-editor.tsx`,
  `lib/components/pipeline/copy-job/wizard.tsx`,
  `app/api/items/copy-job/route.ts`, `app/api/items/copy-job/[id]/route.ts`,
  `app/api/items/copy-job/[id]/run/route.ts`; (edit) `lib/catalog/*` to register.
- **Backend/REST:** generate ADF pipeline `Lookup → Copy → StoredProcedure`
  (watermark) via `upsertPipeline`; `runPipeline`; control table in Azure SQL via
  `synapse-sql-client.ts`/SQL client.
- **Bicep/portability:** `platform/fiab/bicep/modules/data/copy-job-control.bicep`
  creates `dbo.copy_watermark`; add to orchestrator; `LOOM_COPYJOB_CONTROL_SQL`
  env in `admin-plane/main.bicep`.
- **UI:** wizard steps Source → Destination → Mode (Full/Incremental) → Update
  (Append/Overwrite/Merge) → Mapping → Review; run + history.
- **Acceptance:** Configure incremental copy on a real source table; first run
  full-loads; insert new source rows; second run copies only the delta;
  watermark row updated in Azure SQL. No mock watermark.

### Task 5 — Approval activity (Logic App + O365) (F25)
- **Goal:** Add the Approval activity missing from the catalog.
- **Files (edit):** `lib/components/pipeline/activity-catalog.ts`,
  `activity-forms.tsx`; (new)
  `app/api/items/data-pipeline/[id]/approval-logicapp/route.ts`.
- **Backend/REST:** Approval = ADF **Webhook** activity → Logic App trigger URL;
  Logic App runs O365 "approval" + POSTs `callBackUri`. Route provisions/links the
  Logic App.
- **Bicep/portability:** `modules/integration/approval-logicapp.bicep` (Consumption
  Logic App + O365 API connection); wire to orchestrator; `LOOM_APPROVAL_LOGICAPP`
  honest-gate env if not deployed.
- **UI:** Approval activity node + form (approvers, title, timeout); MessageBar
  honest-gate naming the bicep module if the Logic App isn't deployed.
- **Acceptance:** Run a pipeline with an Approval activity → real approval email;
  approve → pipeline continues; reject → fails the branch. If Logic App absent,
  warning MessageBar names the exact module/env — not a dead button.

### Task 6 — HDInsight activities (Hive/Spark/MapReduce/Streaming) (F17)
- **Goal:** Add the four HDInsight activity types.
- **Files (edit):** `activity-catalog.ts`, `activity-forms.tsx`,
  `activity-icons.tsx`.
- **Backend/REST:** ADF HDInsight linked-service references; persist
  `typeProperties` (job type, script path, args, defines, cluster).
- **Bicep/portability:** none required (BYO HDInsight); honest-gate if no HDI
  linked service exists (`LOOM_HDINSIGHT_LINKED_SERVICE`).
- **UI:** four catalog entries; forms for job type, script linked-service +
  path, arguments, cluster.
- **Acceptance:** Add a Hive activity referencing a real HDI linked service →
  Save → Validate passes → Run executes the Hive job (or honest-gate names the
  missing linked service). No placeholder catalog entry.

### Task 7 — Export / Import / Template gallery (F3, F28)
- **Goal:** Real Export (.zip), Import (.zip), and a working template gallery.
- **Files (edit):** `data-pipeline-editor.tsx`; (new)
  `lib/components/pipeline/templates/gallery.tsx`,
  `lib/components/pipeline/templates/catalog.ts`,
  `app/api/items/data-pipeline/[id]/export/route.ts`,
  `app/api/items/data-pipeline/import/route.ts`.
- **Backend/REST:** Export = `getPipeline` → JSON → zip; Import = unzip → validate
  → `upsertPipeline`; templates ship as curated ADF JSON.
- **Bicep/portability:** none.
- **UI:** Export/Import ribbon buttons; gallery flyout (Copy, ForEach-Copy,
  Incremental, Metadata-driven) → instantiate onto canvas.
- **Acceptance:** Export a real pipeline → .zip downloads → Import into a new
  pipeline → identical canvas → Save (PUT) succeeds. Template instantiates real
  nodes. No empty gallery.

### Task 8 — Canvas keyboard + updated-canvas nested previews (F1) & ForEach drill (F22)
- **Goal:** Keyboard map (Shift+arrows pan, I/O zoom, F fit, A align), inline
  nested-activity previews in container nodes, verified breadcrumb drill.
- **Files (edit):** `lib/components/pipeline/canvas.tsx`,
  `flow-activity-node.tsx`, `flow-layout.ts`, `drill-path.ts`.
- **Backend/REST:** none (client DAG).
- **Bicep/portability:** none.
- **UI:** keyboard handlers; container nodes render a mini nested preview; drill
  into ForEach/If/Switch/Until updates breadcrumb + canvas.
- **Acceptance:** All shortcuts work; double-click a ForEach → inner canvas with
  breadcrumb → back returns to parent; large (200-node) pipeline pans smoothly.

### Task 9 — "Practice with sample data" real seed (F2)
- **Goal:** Make the landing-page card actually seed ADLS + run a copy.
- **Files (edit):** `data-pipeline-editor.tsx`; (new)
  `app/api/items/data-pipeline/practice-seed/route.ts`.
- **Backend/REST:** write a sample CSV to the configured ADLS Gen2 account, build
  a copy pipeline, `runPipeline`, surface the run in Output.
- **Bicep/portability:** uses workspace ADLS; honest-gate if `LOOM_SAMPLE_ADLS`
  unset.
- **UI:** card → progress → "open the generated pipeline" + Output rows.
- **Acceptance:** Click the card → real file lands in ADLS → copy pipeline runs →
  Output shows rows. No simulated success.

### Task 10 — Schedule-time parameter overrides (Variable-library substitute) (F4)
- **Goal:** Supply parameter values at scheduled-run time from Key Vault / App
  Configuration.
- **Files (edit):** `trigger-wizard.tsx`, `[id]/triggers/route.ts`; (new)
  `lib/components/pipeline/param-source-picker.tsx`.
- **Backend/REST:** ADF trigger `parameters` with Direct value or Key Vault / App
  Config reference resolved at trigger creation.
- **Bicep/portability:** `LOOM_PARAM_KEYVAULT` / `LOOM_PARAM_APPCONFIG` env;
  grant trigger MI `get` on KV.
- **UI:** per-parameter picker (Direct value | Key Vault ref | App Config ref).
- **Acceptance:** Create a schedule that supplies a parameter from a real Key
  Vault secret → trigger fires → run uses the resolved value (visible in run
  input). No hard-coded value.

### Task 11 — Output-tab Log Analytics fallback + variable thread-safety banner (F7, F5)
- **Goal:** Retrieve runs older than 45 days from Log Analytics; warn on unsafe
  Set Variable in parallel ForEach.
- **Files (edit):** `output-pane.tsx`, `[id]/output/route.ts`,
  `properties-panel.tsx`.
- **Backend/REST:** KQL against `ADFActivityRun`/`ADFPipelineRun` via Log
  Analytics query API (cloud-aware endpoint) when ADF returns nothing.
- **Bicep/portability:** diagnostic settings module routing ADF logs to a
  workspace; `LOOM_ADF_LOG_ANALYTICS_WORKSPACE` env; Gov ingest
  `ods.opinsights.azure.us`.
- **UI:** seamless older-run rows; banner when Set Variable nested in
  `isSequential:false` ForEach.
- **Acceptance:** Query a >45-day run → rows returned from Log Analytics. Place a
  Set Variable in a parallel ForEach → banner appears. No empty/mock fallback.

### Task 12 — Docs + parity doc + bicep sync close-out
- **Goal:** Update `docs/fiab/parity/adf-pipeline.md` (+ adf-data-factory),
  `docs/fiab/data-pipeline-parity-spec.md`, `copy-job-parity-spec.md`,
  `dataflow-parity-spec.md` to show every row ✅/⚠️ with backend-per-control;
  ensure all new env vars/resources are in bicep.
- **Files (edit):** the parity docs above; `platform/fiab/bicep/**` modules from
  Tasks 4/5/10/11; `admin-plane/main.bicep` env list.
- **Backend/REST:** n/a.
- **Bicep/portability:** `az deployment sub create -f platform/fiab/bicep/main.bicep`
  must deploy the control table, approval Logic App, diagnostic settings, and all
  env wiring.
- **UI:** n/a.
- **Acceptance:** Parity doc shows zero ❌ and zero stub banners; clean-sub deploy
  produces a working Data Factory experience identical to the live one.

---

## 5. Claude Code DEV-LOOP per task

Run this four-agent loop **per numbered task**, iterating until acceptance
passes. State carried in `.harness/state.json`; one task = one PR.

1. **Coding agent** (`harness-coder`)
   - Read this PRP row + the named files. Implement against the **real** ADF
     client / API route (no mock arrays, no `return []`, no dead buttons).
   - Add the env var / bicep module if the task introduces infra.
   - Commit on a feature branch; open a draft PR.

2. **Validation / test agent** (`harness-tester`)
   - `pnpm --filter fiab-console tsc --noEmit` — zero errors.
   - `pnpm --filter fiab-console vitest run <touched specs>` — unit/forms green.
     (Note `fiab_console_vitest_harness_broken` memory: gate UI primarily on
     `next build`; fix or skip env-broken render specs, don't fake green.)
   - `pnpm --filter fiab-console build` (`next build`) — must compile.
   - **Real-data E2E**: mint a session cookie, hit the task's endpoint(s)
     (e.g. `/api/items/data-pipeline/[id]/run`), capture first 300 chars of the
     **real** response; for canvas tasks, Playwright-walk the surface and click
     every new control. Attach the receipt.
   - On failure → bounce back to the coding agent with the exact error.

3. **Docs agent** (`code-documenter` / docs)
   - Update the parity doc row(s) and the relevant `*-parity-spec.md`; record
     backend-per-control; add bicep diff. Per `docs_source_of_truth` memory,
     docs land in the **same** PR as the feature. No clarifying-question text in
     product/docs (`no_questions_in_product`).

4. **UAT agent** (`verify` / `harness-reviewer`)
   - Side-by-side against the real ADF Studio surface for the feature; click
     every control; confirm same workflow + outcome (`no_scaffold_claims` —
     DOM strings ≠ parity). Confirm it works with
     `LOOM_DEFAULT_FABRIC_WORKSPACE` **unset** (no-fabric-dependency).
   - Grade F→A+. Only **B+ with real-data receipt** may merge; target **A/A+**.

**Loop exit:** all acceptance bullets pass, receipt attached, parity row flips to
✅/⚠️, reviewer approves. Then close-out (Task 12) reconciles docs + bicep.

---

## 6. Definition of done (whole experience)

The Data Factory experience is **done** when **every row in §2 is `built` ✅ or
`honest-gate` ⚠️ — zero `placeholder`, zero `stub`, zero `missing`, zero dead
buttons, zero mock arrays** — and all of the following hold:

1. **No-Fabric proof.** Every surface installs and every control works with
   `LOOM_DEFAULT_FABRIC_WORKSPACE` **unset**; no default code path touches
   `api.fabric.microsoft.com` / `api.powerbi.com` / `onelake.dfs.fabric`.
   `grep -rn "needs a Fabric workspace" apps/fiab-console/{lib,app}` → zero on
   default paths.
2. **No-vaporware proof.**
   `grep -rE "(return \[\]|return \{\}|useState\(\[\{)" apps/fiab-console/lib/editors apps/fiab-console/app/api`
   and `grep -rE "(MOCK_|SAMPLE_|TODO|FIXME)" apps/fiab-console/lib/components/pipeline`
   show no live violations. Every Copy/Copy-Job/Dataflow/Approval/HDInsight
   control calls a real backend or shows an honest infra-gate.
3. **Parity proof.** `docs/fiab/parity/adf-pipeline.md` (+ adf-data-factory,
   copy-job, dataflow) shows every inventory row built ✅ or honest-gate ⚠️ —
   zero ❌. Side-by-side UAT against real ADF Studio passes per surface.
4. **Real-data receipts.** Each merged PR carries an endpoint hit + first-300-char
   real response + browser screenshot/Playwright trace + bicep diff.
5. **Bicep-synced.**
   `az deployment sub create -f platform/fiab/bicep/main.bicep -p params/commercial-full.bicepparam`
   + bootstrap reproduces the full experience (control table, approval Logic App,
   diagnostic settings, all env vars) in a clean sub — Commercial **and** Gov.
6. **Cloud portability.** All endpoints resolve from the cloud profile for
   Commercial, Government (GCC/GCC-High/DoD), China, and sovereign Secret/TS;
   no hard-coded `management.azure.com` / `*.core.windows.net` in new code.
7. **Quality gates.** `tsc --noEmit`, `next build`, and touched `vitest` specs
   green in CI; promote the fiab-console build to a required check.

**Target grade: A / A+ for every surface before the next major release.**
