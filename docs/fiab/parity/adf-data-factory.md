# adf-data-factory — parity with the full Azure Data Factory Studio

> **rev.2 (2026-05-31) — re-verified against current code; grade unchanged at C.**
> Re-read the pipeline canvas (`canvas.tsx` + `palette.tsx` on `@xyflow/react`,
> 24 activity types, real ARM `createRun`/`validatePipeline`/`queryPipelineRuns`),
> the factory-resources tree, and the data-flow create path. The React Flow
> drag-drop canvas (PR #511) backs ONLY the **pipeline** authoring surface (and
> the Fabric Dataflow Gen2 Power-Query projection) — it does **not** add a
> Mapping Data Flow visual designer: ADF data-flow create still produces an empty
> `MappingDataFlow` editable only as raw JSON (the create dialog literally says
> so). Confirmed still genuinely absent (not stale-marked): the Mapping Data Flow
> designer, Copy Data Tool wizard (no `CopyDataTool` in the tree), the
> Add-Dynamic-Content / Expression Builder (no expression-builder component
> anywhere), connector galleries + Test Connection, source control / Publish, and
> the factory-wide Monitor hub. The ❌/⚠️ rows below are accurate.

> **rev.3 (2026-06-06) — Mapping Data Flow designer now PARTIAL, not absent.**
> Since rev.2, a real **visual Mapping Data Flow designer** shipped in the
> Mounted-ADF editor (`mounted-adf-editor.tsx` → `MappingDataFlowDesigner`):
> a React-Flow source → transform → sink graph with a transform palette and a
> per-node config pane that round-trips real **Data Flow Script** to/from the ADF
> data-flow REST on open and Save. It is graded **B−** in its own doc
> ([`adf-mapping-data-flow.md`](./adf-mapping-data-flow.md)) — 7 of ~25
> transforms, no visual expression builder, and live data-preview is an honest
> config-gate. §9 below reflects this (the marquee designer is ⚠️ partial, no
> longer ❌). The other rev.2 gaps (Copy Data Tool wizard, Expression Builder,
> connector galleries + Test Connection, source control / Publish, factory-wide
> Monitor hub) remain genuinely absent.

> **Scope:** the ENTIRE Azure Data Factory Studio experience (Home, Author,
> Monitor, Manage), not just one editor. Two finer-grained parity docs already
> exist and stay authoritative for their slice:
> [`adf-pipeline.md`](./adf-pipeline.md) (the pipeline authoring canvas) and
> [`adf-factory-resources.md`](./adf-factory-resources.md) (the Factory
> Resources navigator). **This doc is the honest top-level baseline** that rolls
> them up and exposes the Studio-wide gaps (Data Flow designer, Copy Data Tool,
> Monitor hub, source control, global parameters, managed VNet, templates).

Source UI: **Azure Data Factory Studio** (`https://adf.azure.com`)
- Author canvas: <https://learn.microsoft.com/azure/data-factory/author-visually>
- Management hub: <https://learn.microsoft.com/azure/data-factory/author-management-hub>
- Datasets / Linked services: <https://learn.microsoft.com/azure/data-factory/concepts-datasets-linked-services>
- Mapping data flows: <https://learn.microsoft.com/azure/data-factory/concepts-data-flow-overview>
- Monitor: <https://learn.microsoft.com/azure/data-factory/monitor-visually>
- Global parameters: <https://learn.microsoft.com/azure/data-factory/author-global-parameters>
- Source control: <https://learn.microsoft.com/azure/data-factory/source-control>

Backend factory: `adf-loom-default-eastus2` reached via ARM REST
(`Microsoft.DataFactory/factories`, api-version `2018-06-01`) through the Loom
Console UAMI (`uami-loom-console-eastus2`, **Data Factory Contributor**).
Honest 503 infra-gate when `LOOM_SUBSCRIPTION_ID` / `LOOM_DLZ_RG` /
`LOOM_ADF_NAME` are unset.

---

## ADF Studio feature inventory (grounded in Learn) → Loom coverage

Legend: ✅ built (full 1:1 + real backend) · ⚠️ partial / honest-gate · ❌ MISSING.

### 1. Author hub — Factory Resources navigator

| ADF capability | Loom | Backend (real REST) |
| --- | --- | --- |
| Typed resource groups w/ live counts (Pipelines, Datasets, Data flows, etc.) | ✅ `factory-resources-tree.tsx` | `GET factories/{f}/{pipelines\|datasets\|dataflows\|triggers\|linkedservices\|integrationruntimes}` |
| "Add new resource" `＋` menu | ✅ menu → create dialogs | `PUT .../{type}/{name}` |
| "Filter resources by name" box | ✅ client filter | n/a |
| Per-row open / delete inline actions | ✅ | `DELETE .../{type}/{name}` |
| Trigger start/stop inline in tree | ✅ | `POST .../triggers/{n}/start\|stop` |
| Resource folders (drag resources into folders) | ❌ MISSING — `properties.folder` not surfaced in the tree | — |
| Managed private endpoints group | ⚠️ honest "Not yet wired" gate row | — |
| Power Query (wrangling) group | ⚠️ honest "Not yet wired" gate row | — |
| Change data capture group | ⚠️ honest "Not yet wired" gate row | — |
| Global parameters group | ⚠️ honest "Not yet wired" gate row | — |

### 2. Author hub — Pipeline authoring canvas

(Full detail + Vitest receipts in [`adf-pipeline.md`](./adf-pipeline.md).)

| ADF capability | Loom | Backend |
| --- | --- | --- |
| Activities pane (searchable, 3 categories) | ✅ `palette.tsx` — 24 activity types | n/a |
| Authoring canvas (drag-add, drag-move, pan/zoom/minimap) | ✅ `canvas.tsx` on React Flow | spec from `GET .../pipelines/{name}` |
| 4 dependency conditions (success/failure/completion/skip) coloured edges | ✅ `connect()` + `loom-bezier-edge.tsx` | persisted in `dependsOn[]` |
| Bottom config dock (General / Source-Sink / Settings / Params / User props / Activity policy) | ✅ `properties-panel.tsx` | `PUT .../pipelines/{name}` |
| Nested control-flow drill-in (ForEach/Until/If/Switch + breadcrumb + branch tabs + nesting limits) | ✅ `pipeline-designer.tsx` + `drill-path.ts` | round-trips inner `typeProperties.activities` |
| Pipeline Parameters / Variables / Settings panes | ✅ `pipeline-config-panes.tsx` | round-trips `properties.*` |
| Code (JSON) view | ✅ Monaco tab | `PUT .../pipelines/{name}` |
| Save / Validate / Debug / Trigger now / Add trigger | ✅ ribbon | `PUT`, `validatePipeline`, `createRun`, `triggers/*` |
| Output / run history w/ window + status filter, per-activity drill | ✅ `output-pane.tsx` / runs tab | `queryPipelineRuns`, `queryActivityruns` |
| **Add Dynamic Content / Expression Builder** (`@`-expression editor with system vars, functions, params autocomplete; `Alt+Shift+D`) | ❌ MISSING — expressions are typed raw into JSON/text fields; no builder, no function list, no IntelliSense | — |
| **Copy Data activity rich form** (connector-specific Source tab: dataset picker + query/file path + partitioning; Sink tab: write behaviour/upsert; Mapping tab w/ import schema + auto-map; Settings: staging, DIU, parallelism) | ⚠️ partial — Source/Sink rendered as **raw JSON** + a dataset dropdown for inputs/outputs; no per-connector form, no schema-mapping grid, no import-schema | dataset list `GET .../datasets`; saved in `typeProperties` |
| **Template gallery** ("Pipeline from template") | ❌ MISSING | — |

### 3. Author hub — Datasets

| ADF capability | Loom | Backend |
| --- | --- | --- |
| List datasets | ✅ tree + Manage panel | `GET .../datasets` |
| New dataset (name + type + linked-service) | ✅ create dialog / Manage form | `PUT .../datasets/{name}` |
| Delete dataset | ✅ | `DELETE .../datasets/{name}` |
| **New-dataset connector gallery** (pick from 90+ connectors, then format: DelimitedText/JSON/Parquet/…) | ⚠️ partial — fixed dropdown of ~5 types (`DelimitedText, Json, Parquet, Binary, AzureSqlTable`), no searchable connector gallery, no format step | — |
| **Connection / Schema / Parameters tabs** on a dataset (browse path, preview, import schema, dataset parameters) | ❌ MISSING — `typeProperties` (location/format) editable only as **raw JSON** in Manage; no schema grid, no Browse, no preview | location saved in `typeProperties` |
| **Preview data** on a dataset | ❌ MISSING | — |

### 4. Manage hub — Linked services

| ADF capability | Loom | Backend |
| --- | --- | --- |
| List / create / delete linked services | ✅ `manage-panel.tsx` Linked services tab | `GET/PUT/DELETE .../linkedservices/{name}` |
| New linked service: Blob / Azure SQL form (connection string) + raw-JSON "Advanced" fallback for any connector | ✅ (2 typed forms + advanced JSON) | `PUT .../linkedservices/{name}` |
| **Connector gallery** (searchable 90+ connectors w/ icons, grouped by Azure/Database/File/Generic) | ❌ MISSING — only 2 typed connectors; everything else is raw JSON | — |
| **Test connection** button | ❌ MISSING — ADF Studio tests the LS before save; Loom saves blind | — |
| AutoResolve / specific integration-runtime selector on the LS | ⚠️ partial — settable only via advanced JSON, no dropdown | — |
| Parameterize linked service (LS parameters) | ⚠️ partial — advanced JSON only | — |
| Key Vault secret reference picker | ❌ MISSING — only via advanced JSON | — |

### 5. Manage hub — Integration runtimes

| ADF capability | Loom | Backend |
| --- | --- | --- |
| List IRs with live state | ✅ Manage panel (enriched via `getStatus`) | `GET .../integrationruntimes` + `getStatus` |
| Create Managed (AutoResolve) / Self-Hosted IR | ✅ | `PUT .../integrationruntimes/{name}` |
| Start / Stop Self-Hosted node set | ✅ | `POST .../integrationruntimes/{n}/start\|stop` |
| Delete (guards AutoResolveIntegrationRuntime) | ✅ | `DELETE .../integrationruntimes/{name}` |
| **Self-Hosted setup wizard** (auth keys, "install gateway", node monitoring grid, express/manual install, shared IR) | ❌ MISSING — IR created in NeedRegistration with a text note; no auth-key reveal, no node grid | — |
| **Managed VNet IR + DIU / TTL config form** | ⚠️ partial — basic Managed create only; no compute/TTL/VNet form | — |
| **Azure-SSIS IR** (provision node size/count, custom setup, licensing) | ❌ MISSING | — |
| **Linked / shared self-hosted IR** | ❌ MISSING | — |

### 6. Manage hub — Triggers (factory-wide)

| ADF capability | Loom | Backend |
| --- | --- | --- |
| List / create / start / stop / delete triggers | ✅ tree + per-pipeline dialog | `GET/PUT .../triggers`, `start\|stop`, `DELETE` |
| **Schedule trigger** w/ recurrence builder (frequency, interval, time, days, end) | ⚠️ partial — creates a **daily** ScheduleTrigger (hour/minute only); no weekly/monthly/advanced recurrence UI | recurrence saved in `typeProperties` |
| **Tumbling window trigger** (window size, delay, concurrency, retry, dependencies) | ❌ MISSING — type exists in the client interface but no create UI | — |
| **Storage event trigger** (blob created/deleted, container/path filter) | ❌ MISSING | — |
| **Custom event trigger** (Event Grid topic, subject filters) | ❌ MISSING | — |
| Wire trigger → pipeline with parameters | ⚠️ partial — pipeline reference set server-side; no parameter-mapping UI | — |

### 7. Manage hub — Source control & CI/CD

| ADF capability | Loom | Backend |
| --- | --- | --- |
| Git configuration (Azure Repos / GitHub: repo, collaboration & root branch, last published commit) | ❌ MISSING | — |
| Publish (ARM template generation) / Publish branch | ❌ MISSING — Loom is "live mode" only (direct `PUT`) | — |
| Parameterization template (`arm-template-parameters-definition.json`) | ❌ MISSING | — |
| ARM template export / import | ❌ MISSING | — |

### 8. Manage hub — Global parameters & misc

| ADF capability | Loom | Backend |
| --- | --- | --- |
| Global parameters (create/edit/type/value, "Include in ARM template") | ❌ MISSING — honest gate row only | — |
| Managed private endpoints (create/approve to data stores) | ❌ MISSING — honest gate row | — |
| Customer-managed key / managed identity / security settings | ❌ MISSING | — |

### 9. Author hub — Mapping Data Flows

| ADF capability | Loom | Backend |
| --- | --- | --- |
| List / create / delete data flows | ✅ tree | `GET/PUT/DELETE .../dataflows/{name}` |
| **Visual transformation designer** (Source → Select/Filter/DerivedColumn/Join/Aggregate/Pivot/Window/SurrogateKey/Sink graph; add-transformation `＋`; per-transform inspector; column mapping; expression builder) | ⚠️ partial — real React-Flow source→transform→sink **designer** in the Mounted-ADF editor (`MappingDataFlowDesigner`); 7 of ~25 transforms (source/select/filter/join/aggregate/derive/sink), round-trips Data Flow Script. Graded **B−** in [`adf-mapping-data-flow.md`](./adf-mapping-data-flow.md). No visual expression builder; remaining transforms still raw JSON | data-flow create-or-update (DFS) via `…/factories/{f}/dataflows` |
| **Data flow debug** (turn on debug cluster, **Data preview** tab per transform, column stats) | ⚠️ honest-gate — "Data preview" names `createDataFlowDebugSession` / `executeDataFlowDebugCommand` (debug helper not wired); debug-session toggle MISSING | — |
| Data flow Script / Settings / Optimize (partitioning) | ❌ MISSING | — |
| ExecuteDataFlow activity *references* a data flow in a pipeline | ⚠️ partial — activity exists & saves; references a flow by name (no inline authoring) | `PUT .../pipelines/{name}` |

> Note: a separate **Dataflow Gen2 (Power Query)** editor exists
> (`dataflow-gen2-editor.tsx` + `dataflow-diagram.tsx`) — that is the **Fabric**
> low-code object, NOT the ADF mapping data flow. It projects an M-script graph
> and is graded in its own Fabric doc; it does not satisfy ADF mapping-data-flow
> parity.

### 10. Copy Data Tool (guided wizard)

| ADF capability | Loom | Backend |
| --- | --- | --- |
| **Copy Data Tool** — multi-step wizard (Properties → Source dataset/store + config → Destination → Settings/mapping → Review → Deploy; optionally schedules a trigger and builds the pipeline) | ❌ MISSING — no wizard; user hand-builds a Copy activity and edits Source/Sink JSON | — |

### 11. Monitor hub

| ADF capability | Loom | Backend |
| --- | --- | --- |
| Pipeline-runs grid (status, params, window/status filter) | ✅ per-pipeline runs tab + Output pane | `queryPipelineRuns` |
| Per-activity-run drill (input/output/error, duration) | ✅ Output pane expand | `queryActivityruns` |
| Rerun / rerun-from-activity / cancel a run | ❌ MISSING — runs are read-only in Loom | — |
| **Factory-wide Monitor hub** (all pipelines, Trigger runs tab, Gantt timeline view, consumption/DIU report) | ❌ MISSING — monitoring is scoped to one bound pipeline; no factory-wide trigger-run grid or Gantt | — |
| Data flow monitoring (cluster startup, transformation timings, partition stats) | ❌ MISSING | — |
| **Alerts & metrics** (alert rules, metric charts) | ❌ MISSING (lives in Azure Monitor anyway, but ADF surfaces it in-Studio) | — |

### 12. Cross-factory & lifecycle

| ADF capability | Loom | Backend |
| --- | --- | --- |
| Pick which Data Factory (across subscriptions) backs the pipeline item | ✅ `AzureResourcePicker` (Resource Graph) | `Microsoft.ResourceGraph` |
| Drive an externally-referenced factory (MountedDataFactory) — list pipelines/triggers/runs, trigger-now | ✅ `mounted-adf-editor.tsx` | external-base ARM REST |
| Create a NEW Data Factory resource from Loom | ❌ MISSING — assumes the factory already exists (env-pinned or referenced) | — |

---

## Honest summary of the biggest gaps

The **pipeline authoring canvas** and the **Manage hub CRUD** (linked services /
datasets / integration runtimes / triggers — list/create/delete/start/stop) are
genuinely **B-grade**: real ARM REST, no mocks, faithful three-pane layout,
nested control-flow drill-in, run monitoring with per-activity drill. Those
slices are production-usable.

But "full ADF Studio parity" it is **not**. The following high-value surfaces are
**entirely missing** (not gated — absent), and each is a first-class ADF Studio
experience:

1. **Mapping Data Flow visual designer** — the marquee ADF transformation
   surface. Now **partial (B−)**: a real source→transform→sink designer shipped
   ([`adf-mapping-data-flow.md`](./adf-mapping-data-flow.md)) with 7 of ~25
   transforms and DFS round-trip, but no visual expression builder and data
   preview is a config-gate. Short of full parity, no longer absent.
2. **Copy Data Tool wizard** — the #1 onboarding path in ADF. Absent.
3. **Source control / CI-CD** (Git config, Publish, ARM templates) — absent;
   Loom is live-mode only.
4. **Add Dynamic Content / Expression Builder** — every ADF field has it; Loom
   has none. This alone blocks most real pipelines.
5. **Connector galleries** for linked services & datasets (90+ connectors) —
   reduced to 2 typed forms + raw JSON, no Test Connection.
6. **Rich Copy activity form** (Source/Sink/Mapping tabs, import schema,
   auto-map) — raw JSON only.
7. **Advanced trigger types** (tumbling window, storage event, custom event) and
   a real schedule recurrence builder.
8. **Factory-wide Monitor hub** (trigger runs, Gantt, rerun/cancel,
   consumption).
9. **Global parameters**, **managed private endpoints**, **Azure-SSIS IR**,
   **self-hosted IR setup wizard** — gated or absent.

Because the rule (`ui-parity.md`) defines A-grade as *"every inventory row built
✅ or honest-gate ⚠️ — zero ❌"*, and this consolidated inventory has many ❌
rows on flagship surfaces, **the Data Factory service as a whole is C** — a
strong, real-backend pipeline editor sitting inside an otherwise heavily
incomplete Studio. The two narrow docs (`adf-pipeline`, `adf-factory-resources`)
remain individually B; this top-level roll-up is the honest number.

## Backend per control (real REST, no mocks)

- Factory-level CRUD: `lib/azure/adf-client.ts` →
  `list/upsert/delete{Pipelines,Datasets,DataFlows,Triggers,LinkedServices,IntegrationRuntimes}`,
  `runPipeline`, `debugPipeline`, `validatePipeline`, `listPipelineRuns`,
  `listActivityRuns`, `start/stopTrigger`, `start/stop/getStatus IR`.
- BFF routes: `app/api/adf/{pipelines,datasets,dataflows,triggers,linked-services,integration-runtimes}/route.ts`
  (factory navigator + Manage hub) and
  `app/api/items/adf-pipeline/[id]/{bind,run,debug,validate,runs,triggers,output}`
  (the bound-pipeline editor).
- Cross-factory: `getMountedFactory`, `listMountedFactory{Pipelines,Triggers,Runs}`,
  `runMountedFactoryPipeline`.
- All calls auth via `ChainedTokenCredential(UAMI, DefaultAzureCredential)`
  against `management.azure.com`, api-version `2018-06-01`. No mock arrays;
  `return []` only reflects an honestly-empty ARM list.
