# synapse-pipeline — parity with Azure Synapse pipeline (Integrate)

Source UI: Synapse Studio → Integrate → Pipelines (https://learn.microsoft.com/azure/data-factory/concepts-pipelines-activities — Synapse shares the ADF pipeline model)
Backend workspace: `syn-loom-default-eastus2` via the dev endpoint
(`{ws}.dev.azuresynapse.net`, api-version `2020-12-01`).

## The bug this fixes

Same root cause as ADF: the Loom item GUID was sent to `getPipeline()` as the
Synapse pipeline *name* → `404 PipelineNotFound` in `syn-loom-default-eastus2`.
Fixed by the resource-binding model — the Loom item binds to a real Synapse
pipeline (`state.pipelineName`), resolved server-side via `resolveBinding()`.

## Synapse feature inventory → Loom coverage

| Synapse Studio capability | Loom coverage | Backend (real REST) |
| --- | --- | --- |
| Browse pipelines in the workspace | ✅ built — left-panel tree from `listPipelines()` | `GET {ws}.dev.azuresynapse.net/pipelines` |
| Bind item to an existing pipeline | ✅ built — bind picker | `POST /api/items/synapse-pipeline/[id]/bind` → `persistBinding` (Cosmos) |
| Create a new pipeline | ✅ built — "Create & bind" | `PUT /pipelines/{name}` then bind |
| Activity canvas (DAG) | ✅ built — `PipelineDesigner` over `properties.activities[]` | spec from `GET /pipelines/{name}` |
| Add activities (Copy, Notebook, SP, Dataflow) | ✅ built — ribbon palette (SynapseNotebook etc.) | persisted via Save (PUT) |
| Edit/remove activities, dependsOn | ✅ built — designer + JSON (Monaco) tab | `PUT /pipelines/{name}` |
| Save | ✅ built — Save + Ctrl+S | `PUT /pipelines/{name}` (createOrUpdate) |
| Run (Add trigger → Trigger now) | ✅ built — Run | `POST /pipelines/{name}/createRun` |
| Debug | ✅ built — Debug | `POST /pipelines/{name}/createRun?isDebugRun=true` |
| Monitor → pipeline runs + window/status filter | ✅ built — Run history tab | `POST /queryPipelineRuns` (filtered PipelineName) |
| Triggers (list / create schedule / start / stop / delete) | ✅ built — Triggers dialog | `GET/PUT/POST /triggers`, `/triggers/{n}/start|stop` |
| Parameters / variables | ✅ built — via JSON (Monaco) spec tab | round-trips in `properties` on PUT |
| Infra-gate when workspace not provisioned | ⚠️ honest-gate — bind picker shows `listError` (e.g. "Missing env var: LOOM_SYNAPSE_WORKSPACE"); full UI still renders | n/a |

Zero ❌. Zero stub banners.

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
