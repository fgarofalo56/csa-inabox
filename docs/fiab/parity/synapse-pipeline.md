# synapse-pipeline — parity with Azure Synapse pipeline (Integrate)

Source UI: Synapse Studio → Integrate → Pipelines (https://learn.microsoft.com/azure/data-factory/concepts-pipelines-activities — Synapse shares the ADF pipeline model)
Backend workspace: `syn-loom-default-eastus2` via the dev endpoint
(`{ws}.dev.azuresynapse.net`, api-version `2020-12-01`).

## The bug this fixes

Same root cause as ADF: the Loom item GUID was sent to `getPipeline()` as the
Synapse pipeline *name* → `404 PipelineNotFound` in `syn-loom-default-eastus2`.
Fixed by the resource-binding model — the Loom item binds to a real Synapse
pipeline (`state.pipelineName`), resolved server-side via `resolveBinding()`.

## Real Synapse Studio pipeline-editor inventory (grounded in Learn)

Synapse Studio's Integrate → Pipeline editor shares the ADF authoring canvas one-for-one (`author-visually#authoring-canvas` — "Synapse Analytics" panels): Activities pane (left) · authoring canvas (center, cards + 4 conditional-path arrows) · bottom configuration panel for the selected activity · pipeline configurations pane (Parameters / Variables / Settings / Output). Only difference vs ADF: Synapse validates on publish (no by-value validate REST), so the Validate button is omitted.

## Loom coverage

| Synapse Studio capability | Loom coverage | Backend (real REST) |
| --- | --- | --- |
| Browse pipelines in the workspace | ✅ built — left-panel tree from `listPipelines()` | `GET {ws}.dev.azuresynapse.net/pipelines` |
| Bind item to an existing pipeline | ✅ built — bind picker | `POST /api/items/synapse-pipeline/[id]/bind` → `persistBinding` (Cosmos) |
| Create a new pipeline | ✅ built — "Create & bind" | `PUT /pipelines/{name}` then bind |
| **Activities pane** — searchable categorized palette | ✅ built — `ActivityPalette` (search + 3 groups, 24 types) | n/a (client) |
| **Authoring canvas** — cards, drag-to-add, drag-to-move, select | ✅ built — `PipelineCanvas` + `ActivityNode`: drag-drop, reposition, pan/zoom, minimap | spec from `GET /pipelines/{name}` |
| **4 dependency conditions** (success/failure/completion/skip) | ✅ built — 4 coloured output ports per card; drag → `dependsOn` edge with that condition; colour-coded SVG arrows | persisted in `dependsOn[]` on Save |
| **Bottom configuration panel** for selected activity | ✅ built — `PropertiesPanel layout="dock"`: General / Source-Sink / Settings (policy) / Parameters / User properties | `PUT /pipelines/{name}` |
| **Pipeline Parameters / Variables / Settings panes** | ✅ built — `ParametersPane` / `VariablesPane` / `SettingsPane` (concurrency, annotations, description) | round-trips `properties.{parameters,variables,concurrency,annotations,description}` on PUT |
| **Canvas controls** — zoom in/out/fit, auto-align | ✅ built — `CanvasToolbar` + toolbar Auto align / Zoom to fit | n/a (client) |
| Code (JSON) view | ✅ built — Monaco JSON tab (round-trips to/from the canvas model) | `PUT /pipelines/{name}` |
| Save | ✅ built — toolbar Save + Ctrl+S | `PUT /pipelines/{name}` (createOrUpdate) |
| Debug | ✅ built — toolbar Debug | `POST /pipelines/{name}/createRun?isDebugRun=true` |
| Trigger now | ✅ built — toolbar Trigger now | `POST /pipelines/{name}/createRun` |
| Add trigger / Triggers (list / create schedule / start / stop / delete) | ✅ built — Add trigger dialog | `GET/PUT/POST /triggers`, `/triggers/{n}/start|stop` |
| Output / Monitor → pipeline runs + window/status filter | ✅ built — Output tab | `POST /queryPipelineRuns` (filtered PipelineName) |
| Validate | n/a — Synapse validates on publish; button omitted (`supportsValidate: false`), matching Synapse Studio | n/a |
| Infra-gate when workspace not provisioned | ⚠️ honest-gate — bind picker shows `listError` (e.g. "Missing env var: LOOM_SYNAPSE_WORKSPACE"); full UI still renders | n/a |

Zero ❌. Zero stub banners. The canvas model round-trip, palette catalog, default `typeProperties`, and 4-condition connect/merge are covered by `lib/components/pipeline/__tests__/activities-roundtrip.test.ts` (Vitest).

## Backend per control

- Binding read/list/create: `/api/items/synapse-pipeline/[id]/bind`.
- Spec GET/PUT/DELETE: `/api/items/synapse-pipeline/[id]` → `resolveBinding` → `synapse-dev-client.{getPipeline,upsertPipeline,deletePipeline}`.
- Run/Debug: `/api/items/synapse-pipeline/[id]/run|debug` → `runPipeline`/`debugPipeline`.
- Runs: `/api/items/synapse-pipeline/[id]/runs` → `queryPipelineRuns(boundName)`.
- Triggers: `/api/items/synapse-pipeline/[id]/triggers` → `listTriggersForPipeline/upsertTrigger/start/stop/delete`.

Synapse has no by-value pipeline validation REST, so the editor omits the
Validate button (`supportsValidate: false`) — matching Synapse Studio, which
validates on publish. All routes 412 `{ok:false, code:'unbound'}` when unbound;
client uses `safePipelineJson` so non-JSON responses never crash the editor.
