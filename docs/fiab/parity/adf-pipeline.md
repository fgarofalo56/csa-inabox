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

## Real ADF Studio pipeline-editor inventory (grounded in Learn)

Source: `author-visually#authoring-canvas` + `concepts-pipelines-activities#creating-a-pipeline-with-ui` + `tutorial-pipeline-failure-error-handling`. The real editor has four regions:

1. **Activities pane (left)** — searchable, categorized tree of every activity (Move & transform, Orchestration/Synapse-Databricks, General, Iteration & conditionals, …). Drag onto canvas to add.
2. **Authoring canvas (center)** — activity cards (icon + name + type); drag from palette to add, drag to reposition, click to select. Dependency arrows between cards in the four conditional-path colours: **Upon Success (green), Upon Failure (red), Upon Completion (blue), Upon Skip (gray)** — each activity exposes the four output ports.
3. **Bottom configuration panel** — when an activity is selected, the *panel at the bottom of the canvas* edits it (General + activity-specific Source/Sink/Settings + User properties + Activity policy: timeout/retry/retryInterval/secureOutput).
4. **Pipeline configurations pane** — Parameters, Variables, (General) Settings (concurrency, annotations, description), Output (run monitor).
5. **Toolbar** — Save, Validate, Debug, Trigger now / Add trigger; **canvas controls** zoom in/out/fit/auto-align.

## Loom coverage

| ADF Studio capability | Loom coverage | Backend (real REST) |
| --- | --- | --- |
| Pick a pipeline from the factory tree | ✅ built — left-panel tree from `listPipelines()` | `GET factories/{f}/pipelines` |
| Bind item to an existing pipeline | ✅ built — bind picker (Dropdown + Bind) | `POST /api/items/adf-pipeline/[id]/bind` → `persistBinding` (Cosmos) |
| Create a new pipeline | ✅ built — "Create & bind" | `PUT factories/{f}/pipelines/{name}` then bind |
| **Activities pane** — searchable categorized palette | ✅ built — `ActivityPalette`: search + 3 collapsible groups, 24 activity types | n/a (client) |
| **Authoring canvas** — cards, drag-to-add, drag-to-move, select | ✅ built — `PipelineCanvas` + `ActivityNode`: absolute-positioned cards, palette drag-drop, node reposition, pan/zoom, minimap | spec from `GET .../pipelines/{name}` |
| **4 dependency conditions** (success/failure/completion/skip) | ✅ built — each card has 4 coloured output ports; drag a port → another card draws a `dependsOn` edge with that `dependencyCondition`; SVG arrows colour-coded | persisted in `dependsOn[]` on Save |
| **Bottom configuration panel** for selected activity | ✅ built — `PropertiesPanel layout="dock"`: General / Source-Sink / Settings (policy: timeout, retry, retryInterval, secureOutput) / Parameters / User properties tabs | `PUT .../pipelines/{name}` |
| **Pipeline Parameters pane** | ✅ built — `ParametersPane`: add/type/default/delete | round-trips `properties.parameters` on PUT |
| **Pipeline Variables pane** | ✅ built — `VariablesPane`: add/type/default/delete | round-trips `properties.variables` on PUT |
| **Pipeline Settings pane** (concurrency, annotations, description) | ✅ built — `SettingsPane` | round-trips `properties.{concurrency,annotations,description}` on PUT |
| **Canvas controls** — zoom in/out/fit, auto-align | ✅ built — `CanvasToolbar` (bottom-right) + toolbar Auto align / Zoom to fit | n/a (client) |
| Code (JSON) view | ✅ built — Monaco JSON tab (round-trips to/from the canvas model) | `PUT .../pipelines/{name}` |
| Save / Publish | ✅ built — toolbar Save + Ctrl+S | `PUT factories/{f}/pipelines/{name}` (createOrUpdate) |
| Validate | ✅ built — toolbar Validate | `POST .../pipelines/{name}/validate` or `POST factories/{f}/validatePipeline` |
| Debug | ✅ built — toolbar Debug | `POST .../pipelines/{name}/createRun?isRecovery=false` |
| Trigger now | ✅ built — toolbar Trigger now | `POST .../pipelines/{name}/createRun` |
| Add trigger / Triggers (list / create schedule / start / stop / delete) | ✅ built — Add trigger dialog | `GET/PUT/POST .../triggers`, `.../triggers/{n}/start|stop` |
| Output / Run history (Monitor) + window/status filter | ✅ built — Output tab | `POST factories/{f}/queryPipelineRuns` (filtered PipelineName) |
| Deep activity config needing a linked service / dataset that isn't provisioned | ⚠️ honest-gate — Source/Sink + dataset reference fields render; the `referenceName` is empty with guidance; Fabric-only activities (Dataflow Gen2, Office 365) marked Save-only with remediation | n/a |
| Infra-gate when factory not provisioned | ⚠️ honest-gate — bind picker shows `listError` (e.g. "Missing env var: LOOM_ADF_NAME"); full UI still renders | n/a |

Zero ❌. Zero stub banners. The cards/edges ⇄ `properties.activities[]`/`dependsOn[]` round-trip, the palette catalog, the per-type default `typeProperties`, and the 4-condition connect/merge are covered by `lib/components/pipeline/__tests__/activities-roundtrip.test.ts` (Vitest).

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
