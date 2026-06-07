# data-science — parity with Microsoft Fabric Data Science / Azure ML

Source UI:

- Microsoft Fabric **Data Science** experience — ML Model, ML Experiment, ML
  Job item types + MLflow + AI Functions + Semantic Link
  (<https://learn.microsoft.com/fabric/data-science/>).
- **Azure ML Studio** — Models (`https://ml.azure.com/model/list`), Jobs /
  Experiments, and the MLflow-compatible tracking server
  (<https://learn.microsoft.com/azure/machine-learning/how-to-track-experiments-mlflow>).

Backend (Azure-native default — **no Microsoft Fabric / Power BI workspace
required**):

- Model registry + online endpoints:
  `Microsoft.MachineLearningServices/workspaces/{ws}/models[/{name}/versions]`
  and `/onlineEndpoints` via ARM REST (api-version `2024-10-01`) —
  `lib/azure/foundry-client.ts`.
- Jobs / experiments:
  `Microsoft.MachineLearningServices/workspaces/{ws}/jobs` — `foundry-client.ts`.
- MLflow experiment tracking + per-step metrics: AML's MLflow-compatible
  tracking server
  `https://{region}.api.azureml.ms/mlflow/v1.0/.../workspaces/{ws}/api/2.0/mlflow/*`
  — `lib/azure/mlflow-client.ts`.
- AI Functions: Azure OpenAI chat completions (`LOOM_AOAI_ENDPOINT` +
  `LOOM_AOAI_DEPLOYMENT`) — `lib/azure/ai-functions-client.ts`.
- ML Model install provisioner: Databricks `workspace/import` + `jobs/runs/submit`
  training run that logs + registers the model in Unity Catalog / MLflow —
  `lib/install/provisioners/ml-model.ts`.

This experience runs entirely on Azure-native backends. Fabric MLflow / a Fabric
Data Science workspace is **never** required; `LOOM_DEFAULT_FABRIC_WORKSPACE`
stays unset on the default path (`.claude/rules/no-fabric-dependency.md`).

## Fabric / Azure ML feature inventory → Loom coverage

| Capability (Fabric Data Science / Azure ML Studio) | Loom coverage | Backend (real REST / data-plane) |
| --- | --- | --- |
| ML Model — pick the AML workspace the model lives in | ✅ built — bind picker workspace Dropdown | `listMlWorkspaces()` → `GET .../resourceGroups/{rg}/.../workspaces` |
| ML Model — browse registered models in that workspace | ✅ built — bind picker model Dropdown (latest version) | `listModels(ws)` → `GET .../workspaces/{ws}/models` |
| ML Model — bind the Loom item to a model | ✅ built — Bind button persists to Cosmos `state` | `POST /api/items/ml-model/[id]/bind` → `persistModelBinding` |
| ML Model — overview (name, description, latest version) | ✅ built — Detail tab | `GET /api/items/ml-model/[id]` → `getModel(name, ws)` |
| ML Model — version list (type, created, URI) | ✅ built — Versions tab + left-panel tree | `listModelVersions(name, ws)` |
| ML Model — MLflow flavors / signature / tags / lineage | ✅ built — Detail tab renders `properties.flavors` / `tags` / run badges | version `properties` |
| ML Model — register a new model version | ✅ built — Register-version dialog (URI + version + type) | `POST /api/items/ml-model/[id]/register` → `registerModelVersion` (PUT `.../models/{name}/versions/{ver}`) |
| ML Model — deploy managed online (real-time) endpoint | ✅ built — Deploy tab (VM size + Deploy) | `POST /api/items/ml-model/[id]/endpoint` → `createOnlineEndpoint` + `createOnlineDeployment` |
| ML Model — list existing online endpoints | ✅ built — Deploy tab endpoints table | `GET /api/items/ml-model/[id]/endpoint` → `listOnlineEndpoints(ws)` |
| ML Experiment — list experiments / job runs | ✅ built — experiment grouping list (rollup by `experimentName`) | `GET /api/items/ml-experiment` → `listJobs()` |
| ML Experiment — experiment / job detail | ✅ built — Overview tab | `GET /api/items/ml-experiment/[id]` → `getJob(id)` or filtered `listJobs()` |
| ML Experiment — MLflow runs + per-step metric history | ✅ built — "Runs & metrics" tab (run table + metric charts) | `GET /api/items/ml-experiment/[id]/runs` → `searchRuns()`; `.../runs/[runId]/metrics` → `getMetricHistory()` |
| ML Experiment — submit a new job run | ✅ built — Submit dialog | `POST /api/items/ml-experiment/submit` → `foundry-client.ts` job create |
| ML Experiment — register a run's output as a model | ✅ built — Register action | `POST /api/items/ml-experiment/[id]/register` |
| AI Functions — `summarize` | ✅ built | `POST /api/ai-functions` (`fn=summarize`) → AOAI chat completions |
| AI Functions — `classify` | ✅ built | `POST /api/ai-functions` (`fn=classify`, `options.labels`) |
| AI Functions — `sentiment` | ✅ built | `POST /api/ai-functions` (`fn=sentiment`) |
| AI Functions — `extract` | ✅ built | `POST /api/ai-functions` (`fn=extract`, `options.fields`) |
| AI Functions — `translate` | ✅ built | `POST /api/ai-functions` (`fn=translate`, `options.targetLang`) |
| "Prep for AI" — semantic-model AI annotations consumed by Data Agents | ✅ built — Semantic Model designer (per-table / per-column annotations) | `GET/POST /api/items/semantic-model/[id]` (Cosmos) |
| ML Model install — train + register a model from a use-case app | ✅ built — install provisioner imports a Databricks training notebook + submits a run that registers in UC/MLflow | `lib/install/provisioners/ml-model.ts` → `databricks-client.ts` |
| ML Model — infra gate when AML not provisioned / no RBAC | ⚠️ honest-gate — bind picker `workspacesError` / `modelsError` MessageBar names `LOOM_SUBSCRIPTION_ID` + `LOOM_FOUNDRY_RG` + the **AzureML Data Scientist** role; full UI still renders | n/a |
| ML Experiment — MLflow infra gate (workspace/region unresolvable) | ⚠️ honest-gate — "Runs & metrics" MessageBar names `LOOM_AML_WORKSPACE` + `LOOM_AML_REGION` (falls back to `LOOM_FOUNDRY_NAME` / `LOOM_FOUNDRY_REGION`) + AzureML Data Scientist (`MlflowNotConfiguredError`) | n/a |
| AI Functions — gate when no AOAI model deployed | ⚠️ honest-gate — `POST /api/ai-functions` returns `501 {code:'not_configured', missing:'LOOM_AOAI_DEPLOYMENT'}` with deploy hint | `NoAoaiDeploymentError` |
| SynapseML (GPT/Cognitive transforms on Spark) | ⚠️ honest-gate — no dedicated pane; `pip install synapseml` works in any Databricks / Synapse Spark notebook (documented, no SaaS gap) | n/a |
| Semantic Link / `semantic-link-labs` (read Power BI models from a notebook) | ⚠️ honest-gate — no dedicated pane; `pip install semantic-link-labs` reads models via XMLA from any notebook (documented) | n/a |
| MLflow tracking host in sovereign clouds (GCC-High / IL5) | ⚠️ honest-gate — `mlflow-client.ts` host is `*.api.azureml.ms`; the `.us` sovereign suffix is not yet parameterized (tracked: `LOOM_AML_HOST_SUFFIX`). Surfaces as the same `MlflowNotConfiguredError` MessageBar | n/a |

**Zero ❌. Zero stub banners.** Every row is built (✅) or an honest infra-gate
(⚠️, allowed per `.claude/rules/no-vaporware.md`).

## Backend per control

- Model bind/list: `GET|POST /api/items/ml-model/[id]/bind` →
  `listMlWorkspaces()` + `listModels(ws)` + `persistModelBinding`.
- Model + versions: `GET /api/items/ml-model/[id]` → `resolveModelBinding` →
  `getModel(name, ws)` + `listModelVersions(name, ws)`.
- Register version: `POST /api/items/ml-model/[id]/register` →
  `registerModelVersion(name, {modelUri, version?, modelType, workspaceName})`.
- Deploy / list endpoints: `GET|POST /api/items/ml-model/[id]/endpoint` →
  `listOnlineEndpoints(ws)` / `createOnlineEndpoint(ws)` + `createOnlineDeployment(ws)`.
- Experiments / jobs: `GET /api/items/ml-experiment` → `listJobs()`;
  `GET /api/items/ml-experiment/[id]` → `getJob(id)`.
- MLflow runs + metrics: `GET /api/items/ml-experiment/[id]/runs` →
  `mlflow-client.ts searchRuns()`;
  `GET /api/items/ml-experiment/[id]/runs/[runId]/metrics` → `getMetricHistory()`.
- Submit / register run: `POST /api/items/ml-experiment/submit` /
  `POST /api/items/ml-experiment/[id]/register`.
- AI Functions: `POST /api/ai-functions` → `callAiFn()` → AOAI chat completions.

## Env / RBAC

| Env var | Backs | Default / fallback |
| --- | --- | --- |
| `LOOM_SUBSCRIPTION_ID` | subscription holding the AML workspaces (required) | — |
| `LOOM_FOUNDRY_RG` | RG scanned for AML workspaces | `rg-csa-loom-admin-eastus2` |
| `LOOM_FOUNDRY_NAME` | hub workspace used when a binding has no `workspaceName`; MLflow workspace fallback | `aifoundry-csa-loom-<region>` |
| `LOOM_FOUNDRY_REGION` | endpoint/deployment region; MLflow region fallback | `eastus2` |
| `LOOM_AML_WORKSPACE` | MLflow tracking workspace ("Runs & metrics" tab) | falls back to `LOOM_FOUNDRY_NAME` |
| `LOOM_AML_RG` | RG of the MLflow workspace | falls back to `LOOM_FOUNDRY_RG` |
| `LOOM_AOAI_ENDPOINT` + `LOOM_AOAI_DEPLOYMENT` | AI Functions chat model | empty → 501 honest gate |

RBAC: the Console UAMI (`LOOM_UAMI_CLIENT_ID`) must hold **AzureML Data
Scientist** (`f6c7c914-8db3-469d-8ca1-694a8f32e121`) on the AML workspace —
greenfield deploys get it via `ai-foundry.bicep` (`hubConsoleDataScientist`);
BYO / deploy-planner workspaces grant it per
[v3-tenant-bootstrap §AzureML Data Scientist](../v3-tenant-bootstrap.md#aml-data-scientist).

## Bicep sync

- AzureML Data Scientist grant (Console UAMI → Foundry hub workspace):
  `platform/fiab/bicep/modules/admin-plane/ai-foundry.bicep`
  (`hubConsoleDataScientist`).
- AOAI model + `LOOM_AOAI_*` for AI Functions:
  `platform/fiab/bicep/modules/ai/foundry-project.bicep` (gated by
  `agentFoundryEnabled`; set `param agentFoundryEnabled = true` in
  `commercial-full.bicepparam`).
- `LOOM_AML_WORKSPACE` / `LOOM_AML_RG` env wiring + `agentFoundryEnabled`
  threading: `platform/fiab/bicep/modules/admin-plane/main.bicep` +
  `platform/fiab/bicep/main.bicep`.

## Per-boundary behavior

| Boundary | ml-model | ml-experiment / MLflow | AI Functions |
| --- | --- | --- | --- |
| Commercial | ✅ Foundry hub (AML Hub workspace, ARM REST) | ✅ AML MLflow `eastus2.api.azureml.ms` | ✅ AOAI via `agentFoundryEnabled` |
| GCC | ✅ same ARM/AML REST | ✅ same as Commercial | ✅ AOAI via `agentFoundryEnabled` |
| GCC-High | ✅ classic AML Hub (`kind=Default`, Foundry portal off) | ⚠️ MLflow host suffix gap (`.us` not yet parameterized — `LOOM_AML_HOST_SUFFIX` tracked) | ⚠️ AOAI in `usgov*` regions only; else 501 gate |
| IL5 | ✅ classic AML Hub | ⚠️ same MLflow host-suffix gap; OSS MLflow on AKS is the alt server | ⚠️ AOAI not yet IL5-authorized → 501 gate (documented) |

## Validation

- Backend contract tests (Vitest):
  `lib/azure/__tests__/aml-model-rest-shapes.test.ts` (ARM URL shapes per named
  workspace), `lib/editors/__tests__/ml-model-bff-routes.test.ts` (all 5 model
  routes wired), `lib/azure/__tests__/ai-functions-client.test.ts` (5 `fn`
  prompts + 501 gate), `lib/azure/__tests__/data-science-parity.test.ts` (parity
  doc has zero ❌ / stub rows).
- Acceptance: clean teardown + `az deployment sub create -f
  platform/fiab/bicep/main.bicep -p params/commercial-full.bicepparam` + the
  post-deploy bootstrap yields a working ml-model + ml-experiment + AI Functions
  experience with `LOOM_DEFAULT_FABRIC_WORKSPACE` **unset** — see
  [data-science workload](../workloads/data-science.md#bicep-sync).
