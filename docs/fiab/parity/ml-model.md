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
| Lineage / run that produced the version | ✅ built — Detail tab "Properties (lineage / run)" badges | version `properties` (azureml.runId etc.) |
| Register a new model version (from artifact/run URI) | ✅ built — Register-version dialog (URI + version + type) | `POST /api/items/ml-model/[id]/register` → `registerModelVersion` (PUT `.../models/{name}/versions/{ver}`) |
| Deploy → managed online (real-time) endpoint | ✅ built — Deploy tab (VM size + Deploy) | `POST /api/items/ml-model/[id]/endpoint` → `createOnlineEndpoint` + `createOnlineDeployment` (PUT `.../onlineEndpoints/...`) |
| List existing online endpoints | ✅ built — Deploy tab endpoints table (name/state/auth/scoringUri) | `GET /api/items/ml-model/[id]/endpoint` → `listOnlineEndpoints(ws)` |
| Open in Azure ML Studio | ✅ built — `/new` create-gate intro + Studio link convention | https://ml.azure.com/model/list |
| Infra-gate when AML not provisioned / no RBAC | ⚠️ honest-gate — bind picker shows `workspacesError` / `modelsError` naming `LOOM_SUBSCRIPTION_ID` + `LOOM_FOUNDRY_RG` and the **AzureML Data Scientist** role; full UI still renders | n/a |

Zero ❌. Zero stub banners.

## Backend per control

- Binding read/list: `GET /api/items/ml-model/[id]/bind` → `listMlWorkspaces()` + `listModels(ws)` + current binding from `state`.
- Bind: `POST /api/items/ml-model/[id]/bind` → `persistModelBinding` (Cosmos `items` replace).
- Model + versions: `GET /api/items/ml-model/[id]` → `resolveModelBinding` → `getModel(name, ws)` + `listModelVersions(name, ws)`.
- Register version: `POST /api/items/ml-model/[id]/register` → `registerModelVersion(name, {modelUri, version?, modelType, workspaceName})`.
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
- `LOOM_FOUNDRY_REGION` — region for endpoint/deployment bodies (default `eastus2`).
- Console UAMI (`LOOM_UAMI_CLIENT_ID`) must hold **AzureML Data Scientist** (read/register/deploy) or at least Reader (read-only) on the RG / workspace.

## Validation

- Backend contract tests (Vitest):
  - `lib/azure/__tests__/model-binding.test.ts` — binding resolution uses `state.modelName` not the route id; unbound → 412; missing/cross-tenant → 404; persist write + state preservation; error mapping.
  - `lib/azure/__tests__/aml-model-rest-shapes.test.ts` — `listMlWorkspaces` / `listModels(ws)` / `getModel(ws)` / `listModelVersions(ws)` / `registerModelVersion(ws)` / `createOnlineEndpoint(ws)` / `createOnlineDeployment(ws)` hit the correct ARM URLs under the **named workspace** (not the hub), with correct method/body.
  - `lib/editors/__tests__/model-fetch.test.ts` — content-type guard (HTML 404 → ok:false, no throw).
  - `lib/editors/__tests__/ml-model-bff-routes.test.ts` — all 5 routes exist, import a real backend, and GET `[id]` resolves the binding (never `getModel(id)`).
- `pnpm build` clean.
- Live browser probe deferred (no minted session in the worktree); per the bug
  receipt the previous `GET /api/items/ml-model/<guid>` returned a 404 crash —
  the route now returns `412 {code:'unbound'}` (bind picker) for a fresh item
  and real model JSON once bound.
