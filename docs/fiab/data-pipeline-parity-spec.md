# data-pipeline — parity with the Fabric Data Pipeline editor

> **rev.2 (2026-06-06) — rewritten against current code.** The 2026-05-26
> capture described the editor as "a thin JSON form, no canvas / no activity
> library / no properties pane." That is stale: `DataPipelineEditor`
> (`apps/fiab-console/lib/editors/data-pipeline-editor.tsx`) is now a full
> three-pane ADF-Studio-style designer (palette · React-Flow canvas over a
> resizable config dock · top tabs) wired to **real backends**. This doc is the
> honest, feature-by-feature comparison the rule (`ui-parity.md`) requires.

Source UI: **Fabric Data Pipeline** (Data Factory experience). Inventory
grounded in Microsoft Learn:
- Activities / canvas: <https://learn.microsoft.com/fabric/data-factory/activity-overview>
- Run + monitor: <https://learn.microsoft.com/fabric/data-factory/monitor-pipeline-runs>
- Schedule / triggers: <https://learn.microsoft.com/fabric/data-factory/pipeline-runs>

**Azure-native default (no real Fabric required, per `no-fabric-dependency.md`).**
The item type's canonical backend is **Azure Data Factory / Synapse pipeline**.
Every Save / Validate / Publish / Run / Debug / Schedule call resolves to ADF
REST (`Microsoft.DataFactory/factories`, api `2018-06-01`) or the Fabric
data-pipeline REST when a workspace is opted in. The Manage hub (linked services
+ datasets) is **Synapse-backed** (`ManagePanel backend="synapse"`). With
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset the designer still renders fully; the
workspace picker drives the live ADF/Synapse backing. No `return []`, no mock
arrays, no `useState(MOCK)` — the editor's single source of truth is a parsed
`PipelineSpec` round-tripped to the backend.

---

## Loom coverage — delivered editor surface

Legend: ✅ built (full 1:1 + real backend) · ⚠️ partial / honest-gate.

| Fabric capability | Loom | Backend (real REST) |
| --- | --- | --- |
| Workspace picker + pipeline tree (left rail) | ✅ `useWorkspaces` + `Tree` | `GET /api/loom/workspaces`, `GET /api/items/data-pipeline?workspaceId=` |
| Deep-link auto-resolve item → its workspace/pipeline | ✅ self-resolves on mount | `GET /api/cosmos-items/data-pipeline/[id]` |
| Create pipeline (dialog) | ✅ `New pipeline` | `POST /api/items/data-pipeline` (InlineBase64 definition) |
| Delete pipeline (ribbon, confirm) | ✅ | `DELETE /api/items/data-pipeline/[id]` |
| **Three-pane designer** (Activities palette · canvas · bottom config dock) | ✅ matches Fabric layout; canvas fills above a draggable, internally-scrolled config dock | spec from `GET .../[id]` |
| **Activities palette** — searchable, categorized | ✅ `ActivityPalette` from `ACTIVITY_CATALOG` (Move&Transform / Compute / Iteration&Conditional / Lookup&Metadata / External / Office) | n/a (client) |
| **Authoring canvas** — drag-add, drag-move, pan/zoom, minimap, snap-to-grid, show-grid, fit/reset zoom | ✅ `PipelineCanvas` on `@xyflow/react` (`CanvasHandle.fitToScreen/resetZoom`) | n/a (client) |
| Dependency edges — drag a source port to a target (cycle-guarded DAG) | ✅ success (`Succeeded`) edge via `connect()` with ancestry cycle-guard | persisted in `dependsOn[]` on Save |
| 4 dependency conditions (success / failure / completion / skip) coloured ports | ⚠️ partial — all four colours **render** from loaded `dependencyConditions` (`CONNECTOR_COLORS`); drag-create currently persists `Succeeded`; failure/completion/skip set via the activity's `dependsOn` in the config dock / raw JSON | `dependsOn[].dependencyConditions` |
| **Bottom config dock** for the selected activity (General / Source-Sink / Settings / policy) — resizable splitter, own scroll | ✅ `PropertiesPanel layout="dock"` | `PUT .../[id]` |
| Delete selected activity (cascades dependent edges) | ✅ `deleteActivity` | `PUT .../[id]` |
| **Parameters** tab (name / type {string,int,float,bool,array,object,secureString} / default / add / delete) | ✅ inline table editor | round-trips `properties.parameters` on PUT |
| **Variables** tab (name / type {String,Boolean,Array} / default / add / delete) | ✅ inline table editor | round-trips `properties.variables` on PUT |
| **Settings** tab (description, concurrency, annotations) + active-triggers list (start/stop) + raw JSON | ✅ + `MonacoTextarea` JSON view round-tripped to/from the canvas model | `PUT .../[id]`; `PUT .../triggers?...&action=start\|stop` |
| Code (JSON) view round-tripped to the canvas | ✅ Monaco (Settings tab) | `PUT .../[id]` |
| Save / Ctrl+S | ✅ ribbon + keyboard | `PUT /api/items/data-pipeline/[id]` |
| Discard (revert to last saved) | ✅ | re-`GET .../[id]` |
| Validate | ✅ ribbon | `POST /api/items/data-pipeline/[id]/validate` (ADF `validatePipeline`) |
| Publish to ADF (creates the live backing) | ✅ ribbon | `POST /api/items/data-pipeline/[id]/publish` (ADF `upsertPipeline`) |
| Run (auto-publishes then retries when no ADF backing yet — no dead-end) | ✅ ribbon | `POST /api/items/data-pipeline/[id]/run` (`createRun`) |
| Debug | ✅ ribbon | `POST /api/items/data-pipeline/[id]/debug` |
| **Schedule / Add trigger** — guided wizard, no JSON/cron | ✅ `TriggerWizard`: Schedule (Minute/Hour/Day/**Week**/**Month** + weekDays), **Tumbling window**, **Storage events**, **Custom (Event Grid) events** | `POST /api/items/data-pipeline/[id]/triggers` |
| Active triggers list + Start / Stop | ✅ Settings tab | `PUT .../triggers?...&action=start\|stop` |
| **Output / run history** pane | ✅ `OutputPane` | `GET /api/items/data-pipeline/[id]/output[?runId=]` (`queryPipelineRuns`) |
| **Manage hub** — linked services + datasets (Azure-native, Synapse-backed) | ✅ `ManagePanel backend="synapse"` | Synapse dev REST |
| Fabric-unsupported activities (DataflowGen2 refresh, Office365) flagged honestly | ✅ rendered + saveable, badged "save-only" (`ACTIVITY_CATALOG[].runnable=false`); a count badge warns they won't run on the ADF backing | n/a |
| Fabric / workspace not reachable | ⚠️ honest-gate — `MessageBar intent="error"` "Fabric not reachable" with the underlying 401/403 + hint; the full designer still renders | n/a |
| No pipeline selected yet | ⚠️ honest-gate — info `MessageBar`: design on the canvas now; pick/create a pipeline to Save/Validate/Run | n/a |

Every row above is ✅ or an honest ⚠️ gate — zero stub banners, zero dead
controls. The canvas ⇄ `properties.activities[]`/`dependsOn[]` round-trip is the
same model the ADF pipeline editor covers with Vitest
(`lib/components/pipeline/__tests__/activities-roundtrip.test.ts`).

## Backend per control (real REST, no mocks)

- List / detail / create / save / delete: `app/api/items/data-pipeline[/[id]]/route.ts` → `lib/azure/adf-client.ts` (`listPipelines`, `getPipeline`, `upsertPipeline`, `deletePipeline`) / Fabric items REST.
- Validate / Publish / Run / Debug: `app/api/items/data-pipeline/[id]/{validate,publish,run,debug}/route.ts`.
- Triggers: `app/api/items/data-pipeline/[id]/triggers/route.ts` (`upsertTrigger`, `start/stopTrigger`).
- Output / run history: `app/api/items/data-pipeline/[id]/output/route.ts` (`queryPipelineRuns`).
- Manage hub: `lib/components/pipeline/manage-panel.tsx` (`backend="synapse"`) → Synapse dev REST for linked services + datasets.
- Auth: `ChainedTokenCredential(UAMI, DefaultAzureCredential)` against `management.azure.com`.

## Beyond this editor — full Fabric Data Factory capabilities not yet built (honest)

These are genuinely absent in the Loom data-pipeline editor today (tracked, not
claimed; see also [`parity/adf-data-factory.md`](./parity/adf-data-factory.md)):

| Fabric/ADF capability | Status |
| --- | --- |
| Add Dynamic Content / Expression Builder (`@`-expression editor, function list, IntelliSense) | ❌ not built — expressions typed raw into fields/JSON |
| Per-connector Copy-data rich form (Source/Sink tabs, schema import, auto-map grid) | ❌ not built — Source/Sink edited via the config dock / JSON |
| Nested control-flow inner-canvas drill-in (ForEach/If/Switch/Until) | ❌ not built **in this editor** (the Mounted-ADF pipeline editor has it via `drill-path.ts`) |
| Empty-state assistants — Copy-data assistant, Templates gallery | ❌ not built |
| Right-click activity context menu (Copy / Rename / Clone / Disable) | ❌ not built |
| Copilot NL → pipeline build | ❌ not built (parked on AI Foundry agent) |

## Bicep / env sync

- Consumed env vars: `LOOM_ADF_NAME`, `LOOM_ADF_RG`, `LOOM_SUBSCRIPTION_ID`,
  `LOOM_DLZ_RG`, `LOOM_SYNAPSE_WORKSPACE` (the gate MessageBars name them).
- Resource: the ADF factory `adf-loom-default-<location>` deploys from
  `platform/fiab/bicep/modules/landing-zone/adf.bicep`. **Fixed 2026-06-06:**
  `main.bicep` now threads `adfPrivateDnsZoneId:
  adminPlane.outputs.privateDnsZoneIds.adf` into the DLZ, and `network.bicep`
  exposes the `adf` zone — previously the factory + SHIR modules silently
  skipped in a clean-sub deploy because `adfPrivateDnsZoneId` stayed empty. With
  the fix, `az deployment sub create -f platform/fiab/bicep/main.bicep -p
  params/commercial-full.bicepparam` provisions the factory the editor drives,
  matching the `LOOM_ADF_NAME` default (Commercial `adf.azure.com`, Gov
  `datafactory.azure.us`).
- Role: Console UAMI needs **Data Factory Contributor** on the factory
  (`adf.bicep` role assignment). No new Cosmos container.

## Verification

Per `no-vaporware.md`: Save/Validate/Publish/Run/Debug/Schedule hit real ADF
REST; the workspace-unreachable and no-pipeline states are honest gates. Live
`pnpm uat` + side-by-side against the Fabric Data Pipeline editor: confirm each
control per the no-scaffold rule (DOM strings ≠ parity).
