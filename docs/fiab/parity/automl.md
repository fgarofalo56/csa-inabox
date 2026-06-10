# automl — parity with Azure ML Studio "Automated ML"

Source UI: Azure ML Studio → Authoring → Automated ML → "New Automated ML job"
wizard. Grounded in Microsoft Learn:
- What is AutoML: https://learn.microsoft.com/azure/machine-learning/concept-automated-ml
- Set up AutoML training (tabular): https://learn.microsoft.com/azure/machine-learning/how-to-configure-auto-train
- Forecasting setup: https://learn.microsoft.com/azure/machine-learning/how-to-auto-train-forecast
- AutoMLJob ARM shape: https://learn.microsoft.com/javascript/api/@azure/arm-machinelearning/automljob

Fabric note: Microsoft Fabric has **no AutoML item** (Build 2026 item #37 has no
Fabric counterpart). The Azure-native AML AutoML surface is therefore the DEFAULT
and only path — no Fabric / Power BI dependency, works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset (per no-fabric-dependency.md).

## Azure feature inventory (every capability the Studio wizard exposes)

| # | Capability | Notes |
|---|-----------|-------|
| 1 | Task type picker: Classification / Regression / Forecasting | Classification covers binary + multi-class (auto-detected from label) |
| 2 | Dataset selection (MLTable) from a datastore | AutoML v2 ingests tabular data as an MLTable folder |
| 3 | Target (label) column | The column AutoML predicts |
| 4 | Compute selection (AmlCompute cluster) | Sweeps run on a cluster |
| 5 | Primary metric (per task) | The metric AutoML optimizes when ranking models |
| 6 | Limits: experiment timeout, max trials, max concurrent trials | `limitSettings` on the job |
| 7 | Cross-validation folds | classification/regression; used when no validation split given |
| 8 | Forecasting settings: time column, forecast horizon, time-series IDs | required for the forecasting task |
| 9 | Experiment name + run display name | groups + labels the run |
| 10 | Submit the job | real ARM PUT of an AutoML job |
| 11 | Run monitoring: list runs, status, primary metric, created time | the Studio "Jobs" list filtered to AutoML |
| 12 | Cancel a running run | Studio "Cancel" action |
| 13 | Open run in Studio | deep link to the run's Studio page |

## Loom coverage

| # | Capability | Status | Where |
|---|-----------|--------|-------|
| 1 | Task picker (3 tiles, multi-class badge) | built ✅ | `automl-editor.tsx` step "Task" |
| 2 | Dataset (datastore dropdown + MLTable folder → abfss:// URI) | built ✅ | step "Dataset" + `/api/items/automl/options` |
| 3 | Target column | built ✅ | step "Dataset" |
| 4 | Compute cluster dropdown (AmlCompute only) | built ✅ | step "Compute" + options route |
| 5 | Primary metric dropdown (task-scoped) | built ✅ | step "Settings" |
| 6 | Limits (timeout / max trials / concurrency spinners) | built ✅ | step "Settings" |
| 7 | CV folds spinner | built ✅ | step "Settings" (non-forecasting) |
| 8 | Forecasting time column / horizon / series IDs | built ✅ | step "Dataset" + "Settings" |
| 9 | Experiment + display name | built ✅ | step "Settings" |
| 10 | Submit AutoML job | built ✅ | `POST /api/items/automl/submit` → `submitAutoMlJob()` |
| 11 | Runs table (status icon, metric, experiment, created) | built ✅ | Runs tab + `GET /api/items/automl/jobs` |
| 12 | Cancel run | built ✅ | `DELETE /api/items/automl/jobs/[name]` → `cancelAutoMlJob()` |
| 13 | Open in Studio | built ✅ | `services.Studio.endpoint` deep link |
| — | AML workspace not configured | honest-gate ⚠️ | Fluent MessageBar naming `LOOM_AML_WORKSPACE + LOOM_AML_REGION` |

Zero ❌, zero stub banners.

## Backend per control

All controls call real ARM REST against
`Microsoft.MachineLearningServices/workspaces/<ws>` (api-version 2024-10-01) via
`lib/azure/aml-automl-client.ts` (auth + cloud routing inherited from the shared
`resolve-aml-target.ts`):

- options (compute clusters + datastores): `GET .../computes`, `GET .../datastores` (`aml-client.ts`)
- submit: `PUT .../jobs/{name}` with `{ properties: { jobType:'AutoML', taskDetails, computeId, experimentName } }`
- list runs: `GET .../jobs?$filter=jobType eq 'AutoML'`
- poll run: `GET .../jobs/{name}`
- cancel run: `POST .../jobs/{name}/cancel`

RBAC: the Console UAMI holds **AzureML Data Scientist**
(`f6c7c914-8db3-469d-8ca1-694a8f32e121`) on the workspace, granted by
`platform/fiab/bicep/modules/deploy-planner/ml-workspace.bicep` (already deployed
for the existing AML data-science items — no new role or env var needed for
AutoML).
