# ml-experiment — parity with Azure Machine Learning "Jobs / Experiments" (MLflow tracking)

Source UI: Azure ML Studio → Jobs / Experiments
(<https://ml.azure.com/experiments>) and the MLflow tracking REST contract
(<https://mlflow.org/docs/latest/rest-api.html>). AML hosts a fully
MLflow-compatible tracking server; the tracking-URI shape and auth are
documented at
<https://learn.microsoft.com/azure/machine-learning/how-to-use-mlflow-configure-tracking>
and
<https://learn.microsoft.com/azure/machine-learning/how-to-track-experiments-mlflow>.

No Microsoft Fabric / Power BI dependency: the backend is Azure Machine
Learning's MLflow tracking server. Works with `LOOM_DEFAULT_FABRIC_WORKSPACE`
unset.

## Azure/MLflow feature inventory

| # | Capability (Studio / MLflow) | Notes |
|---|------------------------------|-------|
| 1 | Browse experiments registry | name + id + last update |
| 2 | List runs for an experiment | status, start time, metrics, params |
| 3 | Sort runs by any metric / param / attribute | ascending + descending |
| 4 | Filter runs (free text) | client-side across name/param/metric |
| 5 | Filter runs (MLflow filter string) | `metrics.x > 0.9 and params.y = '...'` server-side |
| 6 | Run detail — metric step charts | per-metric step/value history |
| 7 | Run detail — params table | key/value |
| 8 | Run detail — tags table | user tags (mlflow.* system tags hidden) |
| 9 | Run detail — artifact list | recursive `artifacts/list` tree |
| 10 | Compare runs — overlaid metric chart | multiple runs, one metric |
| 11 | Compare runs — parallel coordinates | numeric metrics + numeric params |
| 12 | Compare runs — side-by-side table | status + each numeric axis |
| 13 | Open in Azure ML Studio | deep link from the browse gate |

## Loom coverage

| # | Coverage | Surface |
|---|----------|---------|
| 1 | built ✅ | `MlExperimentEditor` /new browse gate → `/api/aml/experiments` |
| 2 | built ✅ | Runs tab table → `/api/items/ml-experiment/[name]/runs` |
| 3 | built ✅ | Sortable column headers (client) + server `order_by` via `/api/aml/runs` |
| 4 | built ✅ | "Filter rows" input (`filterRunsLocal`) |
| 5 | built ✅ | "MLflow filter" input → `/api/aml/runs` POST `filter` |
| 6 | built ✅ | Detail → Metrics → `MetricStepChart` over `/api/aml/runs/[runId]/metrics` |
| 7 | built ✅ | Detail → Params table |
| 8 | built ✅ | Detail → Tags table (`userTags`) |
| 9 | built ✅ | Detail → Artifacts → `ArtifactTree` over `/api/aml/runs/[runId]/artifacts` |
| 10 | built ✅ | Compare → overlaid `MetricStepChart` (history per selected run) |
| 11 | built ✅ | Compare → `ParallelCoordinates` (`buildParallelAxes`) |
| 12 | built ✅ | Compare → side-by-side table |
| 13 | built ✅ | Browse gate "Open Azure ML Studio" |

Honest infra-gate ⚠️ (not a missing feature): when neither
`LOOM_MLFLOW_TRACKING_URI` (required in IL5 / GCC-High) nor the Commercial /
GCC auto-construction env (`LOOM_AML_WORKSPACE` + `LOOM_AML_REGION` +
`LOOM_SUBSCRIPTION_ID`) is set, every surface renders and shows a Fluent
`MessageBar intent="warning"` naming the exact variable to set. The full UI
surface still renders.

Zero ❌, zero stub banners.

## Backend per control

| Control | Real backend (via `lib/azure/mlflow-client.ts`) |
|---------|--------------------------------------------------|
| Experiment browse | `POST <mlflow-base>/api/2.0/mlflow/experiments/search` |
| Runs table | `POST .../runs/search` (by resolved experiment id) |
| Server filter / sort | `POST .../runs/search` with `filter` + `order_by` |
| Metric step chart | `GET .../metrics/get-history` |
| Latest metric/param/tag | from `runs/search` / `GET .../runs/get` |
| Artifact tree | `GET .../artifacts/list?run_id=&path=` |
| Compare overlay | `GET .../metrics/get-history` per run |

Auth: ARM bearer token from the Console UAMI
(`ChainedTokenCredential(ManagedIdentityCredential, DefaultAzureCredential)`),
same pattern as the Foundry data-plane clients. Role required on the workspace:
**AzureML Data Scientist** (`f6c7c914-8db3-469d-8ca1-694a8f32e121`).

## Per-cloud tracking URI

| Cloud | Tracking URI source | Honest gate |
|-------|---------------------|-------------|
| Commercial / GCC | auto: `https://{region}.api.azureml.ms/mlflow/v1.0/...` from `LOOM_AML_WORKSPACE` + `LOOM_AML_REGION` + `LOOM_SUBSCRIPTION_ID` | n/a |
| GCC-High / IL5 | explicit `LOOM_MLFLOW_TRACKING_URI` only (commercial host is wrong; no public alternate hostname documented) | MessageBar names `LOOM_MLFLOW_TRACKING_URI` |

## Charts: SVG, not Vega-Lite

Vega-Lite / `vega-embed` were considered for the metric step charts but are
**not** in `package.json`. To avoid adding an unvetted ~4 MB dependency in a
cleared boundary, the step chart and parallel-coordinates plot are pure SVG
(`MetricStepChart`, `ParallelCoordinates`) rendering the same step/value data
the Studio Metrics/Compare tabs do.

## Verification

- tsc: `npx tsc --noEmit -p tsconfig.json` — 0 errors.
- vitest: `lib/editors/__tests__/ml-experiment-utils.test.ts` — 14 passing
  (sort direction, missing-value ordering, MLflow `order_by` shape, axis
  normalization, filter matching).
- Bicep: `az bicep build` on `admin-plane/main.bicep` — clean; the four env
  vars (`LOOM_AML_WORKSPACE`, `LOOM_AML_REGION`, `LOOM_AML_RG`,
  `LOOM_MLFLOW_TRACKING_URI`) appear in the compiled ARM.
