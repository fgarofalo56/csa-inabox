# ml-model — parity with Azure Machine Learning registered models (Models)

Source UI: Azure ML Studio → Models (https://ml.azure.com/model/list) and the
model registry REST (https://learn.microsoft.com/azure/machine-learning/how-to-manage-rest).
Backend: `Microsoft.MachineLearningServices/workspaces/{ws}/models[/{name}/versions[/{ver}]]`
+ `/onlineEndpoints` via ARM REST (api-version `2024-10-01`). MLflow model
flavors/signature surface through the version `properties`/`flavors`.

## The bug this fixes

The Loom ml-model item is a **Cosmos GUID**. The old route passed that GUID
straight to `getModel()` as the AML registered-model *name* →
`GET /api/items/ml-model/<guid>` returned `404 {"ok":false,"error":"not found"}`
and the editor crashed on load. Fixed by a **resource-binding model** (same
pattern as the pipeline fix #476): the Loom item binds to a real AML model —
`state.modelName` + optional `state.workspaceName` / `state.version` — and every
route resolves the bound name via `resolveModelBinding()` instead of the route
id. Unbound items render a full bind picker (workspace + model from the real AML
registry), never a 404 crash. Every client `res.json()` goes through
`safeModelJson` (content-type guard) so an HTML 404 can't blank the editor.

## Azure ML feature inventory → Loom coverage

| Azure ML Studio capability | Loom coverage | Backend (real REST) |
| --- | --- | --- |
| Pick the AML workspace the model lives in | ✅ built — bind picker workspace Dropdown | `listMlWorkspaces()` → `GET .../resourceGroups/{rg}/.../workspaces` |
| Browse registered models in that workspace | ✅ built — bind picker model Dropdown (with latest version) | `listModels(ws)` → `GET .../workspaces/{ws}/models` |
| Bind the Loom item to a model | ✅ built — Bind button persists to Cosmos `state` | `POST /api/items/ml-model/[id]/bind` → `persistModelBinding` |
| Re-bind / change model | ✅ built — Re-bind ribbon action + inline button | reopens the bind picker |
| Model overview (name, description, latest version) | ✅ built — Detail tab | `getModel(name, ws)` |
| Version list (all versions, type, created, URI) | ✅ built — Versions tab table + left-panel tree | `listModelVersions(name, ws)` |
| Version detail: MLflow flavors / signature | ✅ built — Detail tab renders `flavors` JSON | version `properties.flavors` |
| Version detail: tags | ✅ built — Detail tab tag badges | version `properties.tags` |
| Lineage / run that produced the version | ✅ built — Detail tab shows the MLflow `run_id` as a "Source run (lineage)" badge + "Open run" link to the experiment editor; ARM `properties` also rendered | MLflow `getMlflowModelVersion().run_id` (canonical) + version `properties` |
| Model stage (None / Staging / Production / Archived) | ✅ built — Stage column in the Versions table, stage badge + "Transition stage" in Detail/ribbon, left-tree stage badge | `searchMlflowModelVersions()` → MLflow `model-versions/search` (`current_stage`) |
| Transition a version's stage | ✅ built — Transition dialog (target stage Dropdown + "archive existing" switch) shows the registry receipt | `POST /api/items/ml-model/[id]/stage` → `transitionModelVersionStage` (MLflow `model-versions/transition-stage`) |
| Register a new model version (from artifact/run URI) | ✅ built — Register-version dialog (URI + version + type) | `POST /api/items/ml-model/[id]/register` → `registerModelVersion` (PUT `.../models/{name}/versions/{ver}`) |
| Register a version FROM a run (capture lineage) | ✅ built — Register dialog "Source run ID" field switches to the MLflow path | `POST /api/items/ml-model/[id]/register` (runId) → `createMlflowModelVersion` (MLflow `model-versions/create` with `run_id`) |
| Deploy → managed online (real-time) endpoint | ✅ built — Deploy tab (VM size + Deploy) | `POST /api/items/ml-model/[id]/endpoint` → `createOnlineEndpoint` + `createOnlineDeployment` (PUT `.../onlineEndpoints/...`) |
| List existing online endpoints | ✅ built — Deploy tab endpoints table (name/state/auth/scoringUri) | `GET /api/items/ml-model/[id]/endpoint` → `listOnlineEndpoints(ws)` |
| Open in Azure ML Studio | ✅ built — `/new` create-gate intro + Studio link convention | https://ml.azure.com/model/list |
| Infra-gate when AML not provisioned / no RBAC | ⚠️ honest-gate — bind picker shows `workspacesError` / `modelsError` naming `LOOM_SUBSCRIPTION_ID` + `LOOM_FOUNDRY_RG` and the **AzureML Data Scientist** role; full UI still renders | n/a |
| Infra-gate when MLflow registry (stages) unconfigured | ⚠️ honest-gate — Versions tab MessageBar names the missing env vars; ARM versions + register/deploy still work, stages just read "None" | `code:'mlflow_unconfigured'` from `/stage` |

Zero ❌. Zero stub banners.

> **Stages are an MLflow-layer concept** — Microsoft Learn
> ("how-to-manage-models-mlflow"): *"You can access stages only by using the
> MLflow SDK. They aren't visible in the Azure Machine Learning studio. You
> can't retrieve stages by using the AML SDK, CLI, or REST API."* ARM model
> versions carry no stage, so Loom decorates the (ARM-sourced) version table
> from the AML-hosted **MLflow** registry REST. Sovereign-cloud aware host:
> `<region>.api.azureml.ms` (Commercial/GCC) vs `<region>.api.ml.azure.us`
> (GCC-High / IL5) — see `cloud-endpoints.amlDataPlaneHost`.

## Backend per control

- Binding read/list: `GET /api/items/ml-model/[id]/bind` → `listMlWorkspaces()` + `listModels(ws)` + current binding from `state`.
- Bind: `POST /api/items/ml-model/[id]/bind` → `persistModelBinding` (Cosmos `items` replace).
- Model + versions: `GET /api/items/ml-model/[id]` → `resolveModelBinding` → `getModel(name, ws)` + `listModelVersions(name, ws)`.
- Stages + lineage: `GET /api/items/ml-model/[id]/stage` → `searchMlflowModelVersions(name, ws)` (MLflow `current_stage` + `run_id`); `POST` → `transitionModelVersionStage(name, ver, stage, {workspace})` (real MLflow `model-versions/transition-stage`; the returned model version is the receipt).
- Register version: `POST /api/items/ml-model/[id]/register` → `registerModelVersion(...)` (ARM PUT) — or, when `runId` is supplied, `createMlflowModelVersion(name, {source, runId}, ws)` (MLflow `model-versions/create`, captures run lineage).
- Deploy / list endpoints: `GET|POST /api/items/ml-model/[id]/endpoint` → `listOnlineEndpoints(ws)` / `createOnlineEndpoint(ws)` + `createOnlineDeployment(ws)`.

All action routes 412 `{ok:false, code:'unbound'}` when the item has no
`state.modelName`, so the editor shows its bind picker instead of erroring. The
model-registry/endpoint REST is parameterized by the bound `workspaceName`
(falls back to the Foundry hub when blank), so a Loom model item can bind to a
model in ANY AML workspace the Console UAMI can read.

## Env / RBAC

- `LOOM_SUBSCRIPTION_ID` — subscription holding the AML workspaces (required).
- `LOOM_FOUNDRY_RG` — resource group scanned for AML workspaces (default `rg-csa-loom-admin-eastus2`).
- `LOOM_FOUNDRY_NAME` — the hub workspace used when a binding has no `workspaceName` (default `aifoundry-csa-loom-eastus2`).
- `LOOM_FOUNDRY_REGION` — region for endpoint/deployment bodies + the AML data-plane / MLflow host (default `eastus2`).
- `LOOM_AML_WORKSPACE` / `LOOM_AML_REGION` / `LOOM_AML_RG` — optional MLflow-registry overrides; fall back to the `LOOM_FOUNDRY_*` hub vars. A bound model's `workspaceName` is threaded into the MLflow base URI so stages target the bound workspace.
- `LOOM_AML_DATAPLANE_HOST` — optional override of the AML data-plane host suffix (private-link workspaces / clouds not enumerated).
- Console UAMI (`LOOM_UAMI_CLIENT_ID`) must hold **AzureML Data Scientist** (read/register/deploy **and** MLflow stage transitions) on the RG / workspace. The Hub grant is wired in `platform/fiab/bicep/modules/admin-plane/ai-foundry.bicep` (`hubConsoleDataScientist`, gated on `consolePrincipalId`); without it the MLflow `transition-stage` call 403s.

## Per-cloud (sovereign) note

The AML data plane + MLflow registry host differs by cloud:
`<region>.api.azureml.ms` in Commercial/GCC vs `<region>.api.ml.azure.us` in
GCC-High / IL5 (`AzureUSGovernment` / `AzureDOD`). Both `mlflow-client` and
`foundry-client` build this via `cloud-endpoints.amlDataPlaneHost(region)`, so
stage transitions work in Gov without code changes (the old hard-coded
`api.azureml.ms` silently failed there).

## Validation

- Backend contract tests (Vitest):
  - `lib/azure/__tests__/model-binding.test.ts` — binding resolution uses `state.modelName` not the route id; unbound → 412; missing/cross-tenant → 404; persist write + state preservation; error mapping.
  - `lib/azure/__tests__/aml-model-rest-shapes.test.ts` — `listMlWorkspaces` / `listModels(ws)` / `getModel(ws)` / `listModelVersions(ws)` / `registerModelVersion(ws)` / `createOnlineEndpoint(ws)` / `createOnlineDeployment(ws)` hit the correct ARM URLs under the **named workspace** (not the hub); plus the MLflow registry surfaces `transitionModelVersionStage` / `getMlflowModelVersion` / `createMlflowModelVersion` hit the right MLflow REST routes under the bound workspace with correct method/body.
  - `lib/editors/__tests__/model-fetch.test.ts` — content-type guard (HTML 404 → ok:false, no throw).
  - `lib/editors/__tests__/ml-model-bff-routes.test.ts` — all 6 routes exist (incl. `[id]/stage`), import a real backend, GET `[id]` resolves the binding (never `getModel(id)`), the stage route wires `transitionModelVersionStage`, and register has a register-from-run (`createMlflowModelVersion`) branch.
  - `lib/editors/__tests__/ml-model.test.tsx` — editor mounts (create gate) + a bound model renders its MLflow stage badge.
- `pnpm build` clean.
- Live browser probe deferred (no minted session in the worktree); per the bug
  receipt the previous `GET /api/items/ml-model/<guid>` returned a 404 crash —
  the route now returns `412 {code:'unbound'}` (bind picker) for a fresh item
  and real model JSON once bound.
