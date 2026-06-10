# automl — parity with Azure ML Studio "Automated ML"

Source UI: https://ml.azure.com → Authoring → Automated ML → "New Automated ML job"
Learn: https://learn.microsoft.com/azure/machine-learning/concept-automated-ml ,
https://learn.microsoft.com/azure/machine-learning/how-to-configure-auto-train

Azure-native by default (Microsoft.MachineLearningServices control plane). No
Fabric / Power BI dependency — works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Azure feature inventory (Studio Automated-ML job wizard)

| # | Capability | Studio surface |
|---|------------|----------------|
| 1 | Select task type — Classification (binary + multi-class), Regression, Time-series forecasting | Step "Task type and data" |
| 2 | Pick training dataset (registered MLTable data asset) | Step "Task type and data" → Dataset dropdown |
| 3 | Set target / label column | Step "Task type and data" |
| 4 | Forecasting: time column + forecast horizon | Forecasting-specific settings |
| 5 | Optional validation dataset (else auto split / CV) | "Validation and test" |
| 6 | Select compute (AmlCompute cluster) | Step "Compute" |
| 7 | Primary metric (per task) | "Additional configuration settings" |
| 8 | Limits — max trials, max concurrent trials, experiment timeout, per-trial timeout, early termination | "Limits" panel |
| 9 | Model explainability for the best model | "Additional configuration" toggle |
| 10 | Submit the job | "Finish" |
| 11 | Monitor job status (NotStarted → Running → Completed/Failed) | Jobs / Automated-ML run list |
| 12 | Cancel an in-flight job | Run detail → Cancel |
| 13 | Register the best model | Best-model tab → Register (covered by the existing `ml-model` editor) |

## Loom coverage

| # | Status | Where |
|---|--------|-------|
| 1 | ✅ built | Wizard step 1 — three task cards (Classification card flags binary + multi-class) |
| 2 | ✅ built | Wizard step 2 — data-asset dropdown from `GET /api/aml/data-assets` |
| 3 | ✅ built | Wizard step 2 — target column field (required) |
| 4 | ✅ built | Wizard step 2 — time column + horizon (forecasting only) |
| 5 | ✅ built | Wizard step 2 — optional validation MLTable URI |
| 6 | ✅ built | Wizard step 3 — compute dropdown from `GET /api/aml/computes` filtered to AmlCompute |
| 7 | ✅ built | Wizard step 4 — primary-metric dropdown (per-task enum) |
| 8 | ✅ built | Wizard step 4 — max trials / concurrent / timeouts / early termination |
| 9 | ✅ built | Wizard step 4 — explainability switch |
| 10 | ✅ built | Wizard step 5 — review + Submit → `POST /api/aml/automl` (real ARM PUT) |
| 11 | ✅ built | Monitor tab — runs table with 15s live polling while a run is in flight |
| 12 | ✅ built | Monitor tab — Cancel → `DELETE /api/aml/automl/[name]` |
| 13 | ✅ built (sibling) | The best registered model appears in the existing `ml-model` editor |
| — | ⚠️ honest-gate | When the AML workspace env is unset, a Fluent MessageBar names the exact vars; the wizard surface still renders |

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend |
|---------|---------|
| Task / dataset / settings → Submit | `submitAutoMLJob()` → `PUT <ws>/jobs/{name}` body `{ properties: { jobType: 'AutoML', taskDetails: { taskType, trainingData (mltable), targetColumnName, primaryMetric, limitSettings, trainingSettings, [forecastingSettings] } } }` (api-version 2024-10-01) |
| Monitor list | `listAutoMLJobs()` → `GET <ws>/jobs` filtered to `jobType == AutoML` |
| Poll one run | `getAutoMLJob()` → `GET <ws>/jobs/{name}` |
| Cancel | `cancelAmlJob()` → `POST <ws>/jobs/{name}/cancel` |
| Dataset dropdown | `listDataAssets()` → `GET <ws>/data`; `getDataAssetVersion()` → `GET <ws>/data/{name}/versions/{version}` |
| Compute dropdown | `listComputes()` → `GET <ws>/computes` filtered to `computeType == AmlCompute` |

All via `lib/azure/aml-client.ts`, ChainedTokenCredential(ManagedIdentity, Default)
against the ARM `.default` scope, sovereign-cloud-aware (`armBase()`/`armScope()`).

## Infra (no new bicep required)

AutoML reuses the existing AML workspace + RBAC already provisioned by
`platform/fiab/bicep/modules/deploy-planner/ml-workspace.bicep`:

- Env: `LOOM_AML_WORKSPACE` + `LOOM_AML_REGION` + `LOOM_SUBSCRIPTION_ID` (or the
  `LOOM_FOUNDRY_*` fallback) — already wired into `admin-plane/main.bicep`.
- Role: the Console UAMI's **AzureML Data Scientist** grant
  (`f6c7c914-8db3-469d-8ca1-694a8f32e121`) already covers `jobs/write`,
  `jobs/cancel`, `data/read`, and `computes/read` — the exact actions AutoML
  needs. No additional role assignment.

The only runtime prerequisite for a *successful* run (beyond the env/role above)
is a registered MLTable data asset and an AmlCompute cluster, both honest-gated
in the wizard with the exact `az ml …` command to create them.
