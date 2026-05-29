# adf-pipeline — parity with Azure Data Factory pipeline (Author / Integrate)

Source UI: ADF Studio → Author → Pipelines (https://learn.microsoft.com/azure/data-factory/concepts-pipelines-activities)
Backend factory: `adf-loom-default-eastus2` via ARM REST (`Microsoft.DataFactory/factories`, api-version `2018-06-01`).

## The bug this fixes

The Loom pipeline item is a **Cosmos GUID**. The old routes passed that GUID
straight to `getPipeline()` as the Azure pipeline *name* → ADF returned
`404 PipelineNotFound`, and the missing `/runs` route returned a 404 **HTML**
page that crashed `res.json()`. Fixed by a **resource-binding model**: the Loom
item binds to a real ADF pipeline (persisted in `state.pipelineName`); every
route resolves the bound name via `resolveBinding()` instead of the route id.

## Azure feature inventory → Loom coverage

| ADF Studio capability | Loom coverage | Backend (real REST) |
| --- | --- | --- |
| Pick a pipeline from the factory tree | ✅ built — left-panel tree from `listPipelines()` | `GET factories/{f}/pipelines` |
| Bind item to an existing pipeline | ✅ built — bind picker (Dropdown + Bind) | `POST /api/items/adf-pipeline/[id]/bind` → `persistBinding` (Cosmos) |
| Create a new pipeline | ✅ built — "Create & bind" | `PUT factories/{f}/pipelines/{name}` then bind |
| Activity canvas (DAG) | ✅ built — `PipelineDesigner` reads `properties.activities[]`, renders dependsOn edges | spec from `GET .../pipelines/{name}` |
| Add activities (Copy, Dataflow, Notebook, SP) | ✅ built — ribbon palette templates activity JSON | persisted via Save (PUT) |
| Edit/remove activities, dependsOn | ✅ built — designer + JSON (Monaco) tab | `PUT .../pipelines/{name}` |
| Save / Publish | ✅ built — Save + Ctrl+S | `PUT factories/{f}/pipelines/{name}` (createOrUpdate) |
| Validate | ✅ built — Validate button | `POST .../pipelines/{name}/validate` or `POST factories/{f}/validatePipeline` |
| Run (trigger now) | ✅ built — Run | `POST .../pipelines/{name}/createRun` |
| Debug | ✅ built — Debug | `POST .../pipelines/{name}/createRun?isRecovery=false` |
| Run history (Monitor) + window/status filter | ✅ built — Run history tab | `POST factories/{f}/queryPipelineRuns` (filtered PipelineName) |
| Triggers (list / create schedule / start / stop / delete) | ✅ built — Triggers dialog | `GET/PUT/POST .../triggers`, `.../triggers/{n}/start|stop` |
| Parameters / variables editing | ✅ built — via JSON (Monaco) spec tab | round-trips in `properties` on PUT |
| Infra-gate when factory not provisioned | ⚠️ honest-gate — bind picker shows `listError` (e.g. "Missing env var: LOOM_ADF_NAME"); full UI still renders | n/a |

Zero ❌. Zero stub banners.

## Backend per control

- Binding read/list/create: `/api/items/adf-pipeline/[id]/bind` (GET lists real pipelines, POST binds/creates).
- Spec GET/PUT/DELETE: `/api/items/adf-pipeline/[id]` → `resolveBinding` → `adf-client.{getPipeline,upsertPipeline,deletePipeline}`.
- Run/Debug: `/api/items/adf-pipeline/[id]/run|debug` → `runPipeline`/`debugPipeline` (createRun).
- Runs: `/api/items/adf-pipeline/[id]/runs` → `listPipelineRuns(boundName)` (queryPipelineRuns).
- Validate: `/api/items/adf-pipeline/[id]/validate` → `validatePipeline`.
- Triggers: `/api/items/adf-pipeline/[id]/triggers` → `listTriggers/upsertTrigger/start/stop/delete`.

All routes 412 with `{ok:false, code:'unbound'}` when the item has no
`state.pipelineName`, so the editor shows its bind picker. Every `res.json()`
on the client goes through `safePipelineJson` (content-type guard) so a non-JSON
error page never crashes the editor.
