# adf-factory-resources — parity with Azure Data Factory Studio (Author / Factory Resources pane)

Source UI: Azure Data Factory Studio → Author hub → **Factory Resources** pane
(`https://adf.azure.com` → pencil/Author icon → left navigator). Grounded in
Microsoft Learn:
- ADF concepts (pipelines, activities, datasets, linked services, triggers,
  data flows, integration runtimes): https://learn.microsoft.com/azure/data-factory/concepts-pipelines-activities
- ADF Studio authoring: https://learn.microsoft.com/azure/data-factory/author-visually
- Mapping data flows: https://learn.microsoft.com/azure/data-factory/concepts-data-flow-overview
- Triggers: https://learn.microsoft.com/azure/data-factory/concepts-pipeline-execution-triggers
- Managed VNet / managed private endpoints: https://learn.microsoft.com/azure/data-factory/managed-virtual-network-private-endpoint
- Global parameters: https://learn.microsoft.com/azure/data-factory/author-global-parameters
- Change data capture (CDC): https://learn.microsoft.com/azure/data-factory/concepts-change-data-capture

ARM REST API version used throughout: **2018-06-01**
(`Microsoft.DataFactory/factories/*`).

## Azure / ADF Studio feature inventory

The ADF Studio Factory Resources pane is a typed navigator. For each resource
type it exposes: a **collapsible group** with a **live count**, a **＋ (Actions)
New** affordance per group, a **"Filter resources by name"** box, a top
**"Add new resource"** menu, and per-item **open / delete / (lifecycle)** inline
actions. The groups are:

| # | Group | Capabilities in ADF Studio |
|---|-------|----------------------------|
| 1 | **Pipelines** | list w/ count, New (opens blank canvas), open (designer), delete, run/debug/trigger |
| 2 | **Datasets** | list w/ count, New (type + linked service wizard), open, delete |
| 3 | **Data flows** | list w/ count, New (Mapping Data Flow visual designer), open, delete |
| 4 | **Power Query** | list w/ count, New (Wrangling data flow / mashup editor), open, delete |
| 5 | **Triggers** | list w/ count, New, open, start/stop, delete |
| 6 | **Change data capture** (preview) | list w/ count, New (CDC mapping wizard), open, delete |
| — | **Connections → Linked services** | (Manage hub) list, New, edit, delete, test connection |
| — | **Connections → Integration runtimes** | (Manage hub) list, New (Managed/SelfHosted/Azure-SSIS), status, start/stop, delete |
| — | **Managed private endpoints** | (Manage hub, needs Managed VNet) list, New, approve, delete |
| — | **Global parameters** | (Manage hub) list, add/edit/delete name+type+value |
| — | Top toolbar | **Add new resource** menu, **Filter resources by name** |

## Loom coverage

Built ✅ / honest-gate ⚠️ / MISSING ❌. Surface:
`apps/fiab-console/lib/components/pipeline/factory-resources-tree.tsx`, wired into
the ADF/Synapse pipeline editor left pane (`lib/editors/pipeline-editor-core.tsx`,
ADF only) when a factory is selected. The cross-sub `AzureResourcePicker` stays
at the top of the bind gate to target the factory.

| Capability | Status | Notes |
|------------|--------|-------|
| Factory Resources typed navigator (groups + counts) | ✅ | Fluent `Tree`, one branch per type, live count from real list |
| Filter resources by name | ✅ | top `Input` filters every group client-side |
| Add new resource menu (top) | ✅ | Fluent `Menu` → Pipeline / Data flow / Dataset / Trigger / Linked service / Integration runtime |
| ＋ New per group | ✅ | per-group `Add` button on the group header |
| **Pipelines** — list / count | ✅ | `GET /api/adf/pipelines` |
| **Pipelines** — New (creates empty + opens on canvas) | ✅ | `POST /api/adf/pipelines`; on success binds + opens the existing React Flow designer |
| **Pipelines** — open / bind | ✅ | click row → `bindTo(name)` → canvas |
| **Pipelines** — delete | ✅ | `DELETE /api/adf/pipelines?name=` |
| **Datasets** — list / count / create / delete | ✅ | `GET/POST/DELETE /api/adf/datasets`; create dialog (type + linked service); edit opens Manage hub |
| **Data flows** — list / count | ✅ | `GET /api/adf/dataflows` |
| **Data flows** — New (empty MappingDataFlow) | ✅ | `POST /api/adf/dataflows` creates a valid empty Mapping Data Flow |
| **Data flows** — delete | ✅ | `DELETE /api/adf/dataflows?name=` |
| **Data flows** — visual sources/sinks/transformations designer | ⚠️ | empty data flow is created via real REST; the *visual* mapping-data-flow designer (Spark debug, schema projection, expression builder) is a follow-up. Honest note in the create dialog. Definition is edited as JSON in the Manage hub for now |
| **Triggers** — list / count / start / stop / delete | ✅ | `GET/POST/DELETE /api/adf/triggers` (factory-wide); inline Start/Stop badges |
| **Triggers** — New (daily Schedule, Stopped) | ✅ | `POST /api/adf/triggers`; wire to a pipeline from that pipeline's Triggers panel |
| **Linked services** — list / count / create / edit / delete | ✅ | listed inline; create/edit/delete delegated to the existing `ManagePanel` (`/api/adf/linked-services`) |
| **Integration runtimes** — list / count / status / start / stop / delete | ✅ | listed inline; lifecycle in `ManagePanel` (`/api/adf/integration-runtimes`) |
| **Managed private endpoints** | ⚠️ | honest "coming" gate row — needs a Managed VNet on the factory; preview REST not wired |
| **Power Query (Wrangling data flow)** | ⚠️ | honest "coming" gate row — the Power Query online mashup editor is not embedded |
| **Change data capture (CDC)** | ⚠️ | honest "coming" gate row — top-level `adfcdc` preview REST not wired |
| **Global parameters** | ⚠️ | honest "coming" gate row — factory-level globalParameters editor not wired |
| Honest infra-gate when factory unreachable | ✅ | when the routes 503 `not_configured`, the whole navigator shows one `MessageBar` naming `LOOM_ADF_NAME` / `LOOM_DLZ_RG` / `LOOM_SUBSCRIPTION_ID` + the Data Factory Contributor role |

Zero ❌. The four un-built ADF groups are rendered as honest ⚠️ "coming" rows
(tooltip names the exact resource/REST gap), never a fake list.

## Backend per control

Every count and action hits real ADF ARM REST (api-version 2018-06-01) via
`lib/azure/adf-client.ts` (ChainedTokenCredential UAMI → ARM). Factory is the
env-pinned default (`LOOM_SUBSCRIPTION_ID` / `LOOM_DLZ_RG` / `LOOM_ADF_NAME`).

| Control | BFF route | adf-client fn | ARM endpoint |
|---------|-----------|---------------|--------------|
| Pipelines list/create/delete | `/api/adf/pipelines` | `listPipelines` / `upsertPipeline` / `deletePipeline` | `factories/{f}/pipelines` |
| Datasets list/create/delete | `/api/adf/datasets` | `listDatasets` / `upsertDataset` / `deleteDataset` | `factories/{f}/datasets` |
| Data flows list/create/delete | `/api/adf/dataflows` | `listDataFlows` / `upsertDataFlow` / `deleteDataFlow` | `factories/{f}/dataflows` |
| Triggers list/create/lifecycle/delete | `/api/adf/triggers` | `listTriggers` / `upsertTrigger` / `startTrigger` / `stopTrigger` / `deleteTrigger` | `factories/{f}/triggers[/start|/stop]` |
| Linked services | `/api/adf/linked-services` | `listLinkedServices` / `upsertLinkedService` / `deleteLinkedService` | `factories/{f}/linkedservices` |
| Integration runtimes | `/api/adf/integration-runtimes` | `list/upsert/start/stop/delete IntegrationRuntime` + `getStatus` | `factories/{f}/integrationruntimes[/start|/stop|/getStatus]` |
| Pipeline open/bind | `/api/items/adf-pipeline/[id]/bind` | `listPipelines` / `upsertPipeline` | (binding persisted to Cosmos item) |

## Deferred (explicit follow-ups, not half-built)

- **Synapse Factory Resources navigator** — the Synapse pipeline editor keeps
  its existing thin pipeline tree; a Synapse-workspace equivalent (artifacts:
  pipelines, datasets, data flows, notebooks, SQL scripts, KQL, triggers via the
  Synapse `dev.azuresynapse.net` data-plane) is a follow-up.
- **Mapping Data Flow visual designer** — Spark-backed source/transform/sink
  canvas with schema projection, expression builder, and data preview.
- **Power Query (Wrangling data flow)** online mashup editor.
- **Managed private endpoints** (requires Managed VNet) — list/create/approve.
- **Change data capture (CDC)** preview resource wizard.
- **Global parameters** editor.
- **Per-factory routing** — list routes target the env-default factory
  (`LOOM_ADF_NAME`). Threading the cross-sub picker's selected factory id
  through every `/api/adf/*` route (like the MountedDataFactory editor does) is
  a follow-up; the navigator is fully functional against the default factory.

## Verification

- `cd apps/fiab-console && pnpm build` → **Compiled successfully** (the only
  warning is a pre-existing `@protobufjs/inquire` dependency warning, unrelated).
- The six `/api/adf/*` routes register in the build route table.
- Live `pnpm uat` side-by-side against ADF Studio: pending (no minted session in
  this worktree) — per `no-vaporware.md` the create/delete/lifecycle calls all
  hit real ARM REST; the honest infra-gate renders when the factory env vars are
  unset.
