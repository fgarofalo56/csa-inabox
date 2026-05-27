# Loom ML Experiment Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent `mlx-parity-2026-05-26`. Source: Microsoft Learn — [Machine learning experiments in Microsoft Fabric](https://learn.microsoft.com/fabric/data-science/machine-learning-experiment) and the Data Science overview pages. Cross-checked against existing Loom editor at `apps/fiab-console/lib/editors/phase4-editors.tsx::MlExperimentEditor` and the BFF route at `apps/fiab-console/app/api/items/ml-experiment/[id]/route.ts`.

## What it is

A Fabric **ML Experiment** is the primary unit of organization for related machine learning runs. It is an MLflow experiment surfaced as a first-class workspace item. Each *run* corresponds to one execution of model training code. The editor lets data scientists:

- View the **Run list** for the experiment (all child runs with status, start time, source notebook)
- Open a **Run details** view showing hyperparameters, metrics, output files, tags, logged artifacts
- **Customize columns**, **filter**, and **compare** multiple runs side-by-side
- See a **metrics comparison chart** (parallel coordinates / scatter / line)
- **Save a run as an ML Model** (registers the artifact into the workspace ML Model registry)
- Apply MLflow **tags** to organize and filter runs

The item sits in Fabric Data Science alongside Notebooks (which produce runs) and ML Models (which consume the best runs). It is MLflow-backed end-to-end.

## UI components

### Page chrome
- Title bar shows the experiment name (editable inline) plus a saved-state indicator
- Standard Fabric global bar: search, notifications, settings, help, account
- Right-side actions: **Share**, **Settings**, **View** (toggle to choose Run details / Run list / Run comparison)

### Ribbon — Home tab
| Button | Behavior |
|---|---|
| **Refresh** | Reloads run list from the MLflow tracking store |
| **Save as ML model** | On a selected run, registers its `model` artifact to the workspace ML Model registry, creating or version-incrementing a sibling ML Model item |
| **View** ▼ | Switches the main pane between Run details, Run list, and Run comparison |
| **Customize columns** | Pane to pick which metrics, params, tags, hyperparameters appear in the run-list grid |
| **Filter** | Filter pane for narrowing the run list (status, time range, metric thresholds, tags) |

### Run list view (default)
- Tabular grid: one row per run
- Default columns: **Run name**, **Source** (notebook that produced it), **Status** (Running / Completed / Failed / Killed), **Start time**, **Duration**, **Registered version** (if saved as a model), plus selected metrics/params from Customize columns
- Row click opens the Run details pane for that run
- Checkbox-multi-select feeds Run comparison view

### Run details view
- Header: run name, status badge, source notebook link, start/end time, user
- **Parameters** section: key/value table of hyperparameters (e.g. `learning_rate=0.01`, `n_estimators=100`)
- **Metrics** section: numeric metrics with sparkline if logged across steps (e.g. `loss`, `accuracy` per epoch)
- **Tags** section: key/value chips, add/edit/remove inline (subject to MLflow tag rules — no `mlflow.*`, `synapseml.*`, `trident.*` prefixes; ≤250-char names, ≤5000-char values)
- **Output files / Artifacts** browser: tree view of artifact paths (`model/`, `images/`, `data/`); files downloadable; common preview for `.png`, `.json`, `.txt`, `.yaml`
- **Registered version** indicator: if this run was saved as a model, link to the ML Model item and version

### Run comparison view
- Pick 2+ runs from the list, switch to this view
- **Parallel coordinates chart** — one polyline per run, axes are selected metrics/params, useful for spotting which hyperparameter setting gave the best metric
- **Scatter chart** — pick X and Y from metrics/params, one dot per run
- **Line chart** — for metrics logged with steps (e.g. training loss per epoch)
- Side table: each selected run's params + metrics, diffs highlighted
- Chart customization: title, viz type, X-axis, Y-axis, log/linear, legend

### Monitor integration (preview)
- Runs flow into the Fabric **Monitor** hub as a unified activity list (last 30 days by default, customizable)
- From a Spark application in Monitor → **Item Snapshots** → shows the experiments/runs that application generated

### Inline MLflow widget (notebook-side, related)
- Not part of the experiment editor itself, but worth noting: the Fabric notebook ships an inline MLflow authoring widget that tracks runs per cell and offers a mini Run-comparison view inside the notebook. The experiment editor is where those runs land for full analysis.

## What Loom has

The current Loom `MlExperimentEditor` (`apps/fiab-console/lib/editors/phase4-editors.tsx` lines 194–332) is wired live to **Azure AI Foundry** (`Microsoft.MachineLearningServices/workspaces`) via the BFF route `GET /api/items/ml-experiment/[id]`. It is honest about being a read-only summary:

- Treats `id` as either a job name OR an experiment name; on miss it filters `listJobs()` by `experimentName`
- Renders a left-side **Tree** of runs with status badges (Completed → green, Failed → red, else informative)
- Main pane shows a small `Runs` table with columns: Run, Type, Status, Started, Ended
- Below the table: a "Selected run" panel showing description and a generic `properties` key/value table (which doubles as the metrics view today)
- Ribbon stub has tabs: **Runs** (Reload, Register model) and **Charts** (Parallel coordinates, Scatter) — but the chart buttons are not wired to anything; they render as labels only
- Errors surface as Fluent `MessageBar intent="error"`; no mock data anywhere

In short: Loom can list runs and inspect one run's flat properties, but has no real metrics chart, no params/metrics split, no artifact browser, no Run comparison view, no tag editor, no "Save as ML model" action.

## Gaps for parity

1. **Params vs metrics split** — today everything is dumped into a generic `properties` table. Metrics need numeric typing (chartable) and params need string typing (filterable). MLflow exposes them on separate fields; we currently flatten them into the AML `properties` bag.
2. **Run details: artifact browser** — no UI for the run's artifact tree (`outputs/`, `model/`, etc.). MLflow exposes this via the artifact REST API; needs a `Tree` + download/preview surface.
3. **Tag editor** — read-only chips are missing entirely; adding/removing tags inline (with MLflow's prefix and length rules enforced client-side) is absent.
4. **Run comparison view** — no checkbox multi-select on the run list, no parallel coordinates / scatter / line charts. The ribbon mentions them but the buttons do nothing.
5. **Customize columns pane** — the runs table has fixed columns. Fabric lets users add metric/param columns dynamically.
6. **Filter pane** — no status, time-range, or metric-threshold filter on the run list.
7. **Save as ML model action** — ribbon stub says "Register model" but isn't wired. Needs to POST to a new Loom endpoint that calls AML's `register` flow and creates/updates the sibling ML Model item in Cosmos.
8. **Source notebook link** — Fabric run rows link back to the producing notebook; Loom has the data (`properties.mlflow.source.name`) but doesn't render the link.
9. **Run name vs run ID** — display name surfacing is patchy (today falls back to raw name when `displayName` is missing); Fabric always shows the friendly run name.
10. **Per-step metric series** — MLflow stores metrics as time series (step, value); Loom only shows the latest scalar.
11. **View toggle (Run details / Run list / Run comparison)** — Fabric has a top-level **View** switcher; Loom always shows the run-list-then-details pattern.
12. **Monitor hub integration** — out of scope for this editor wave; flag for v2.x platform work.

## Backend mapping

The current AI Foundry path works because **Microsoft Fabric Data Science experiments are stored in an Azure Machine Learning workspace under the hood when Fabric is configured with an AML link**. For a standalone Fabric workspace, the equivalent is the **Fabric MLflow tracking endpoint**. Both speak MLflow REST.

| Loom surface | Backend call (current AML / Foundry path) | Backend call (Fabric MLflow path, future) |
|---|---|---|
| Run list (experiment lookup) | `GET {arm}/.../workspaces/{ws}/jobs?api-version=2024-10-01` filtered client-side by `properties.experimentName` | `GET {fabric-mlflow}/api/2.0/mlflow/experiments/get-by-name?experiment_name=<name>` + `GET .../runs/search` |
| Run details | `GET {arm}/.../workspaces/{ws}/jobs/{id}?api-version=2024-10-01` → `properties` bag contains params + metrics + tags | `GET {fabric-mlflow}/api/2.0/mlflow/runs/get?run_id=<id>` returns split `params[]`, `metrics[]`, `tags[]` |
| Metric history (per-step) | `GET {arm}/.../jobs/{id}/metrics?metricName=...` | `GET {fabric-mlflow}/api/2.0/mlflow/metrics/get-history?run_id=<id>&metric_key=<k>` |
| Artifact browser | `GET {arm}/.../jobs/{id}/artifacts` + signed-URL download | `GET {fabric-mlflow}/api/2.0/mlflow-artifacts/artifacts?path=<p>&run_id=<id>` |
| Tag CRUD | `PATCH {arm}/.../jobs/{id}` with merged `properties.tags` | `POST .../runs/set-tag`, `POST .../runs/delete-tag` |
| Save as ML model | `POST {arm}/.../workspaces/{ws}/models/{name}/versions/{ver}` registering the run's `model/` artifact | `POST .../model-versions/create` with `source = runs:/<run-id>/model`, `name = <model>` |
| Compare-charts data | Same as Run details + per-step metric history; charts are client-side (Recharts / Plotly / Echarts) | Same |

The existing Loom client at `apps/fiab-console/lib/azure/foundry-client.ts` already implements `listJobs()` and `getJob()`. New helpers required: `getJobMetricsHistory`, `listJobArtifacts`, `setJobTag`, `deleteJobTag`, `registerModelFromJob`.

## Required Azure resources

- **Azure AI Foundry hub** (= `Microsoft.MachineLearningServices/workspaces` of kind `Hub`) — already provisioned as `aifoundry-csa-loom-eastus2` (env `LOOM_FOUNDRY_NAME`). The current path uses ARM under `/jobs/*`, which works for AML-linked Fabric workspaces.
- **AML compute target** (optional) — to actually *run* jobs from the editor; today Loom only reads existing jobs, doesn't trigger new runs.
- **Storage** — the AML workspace's attached storage account (created with the workspace) holds run artifacts; signed-URL download requires the editor's identity to have **Storage Blob Data Reader** on that account or the workspace's data-access role.
- **App Insights** — already wired to the workspace; metrics history queries hit it indirectly through ARM.
- **(Future, for true Fabric-native path)**: a Fabric workspace + capacity where the Fabric MLflow tracking server is the source. This requires a Power BI / Fabric tenant connection that the Loom orchestrator does not yet provision; surface honestly with a `MessageBar intent="warning"` if `LOOM_FABRIC_WORKSPACE_ID` is unset.

## Estimated effort

**2 focused sessions** to reach grade B (production-grade — works, looks good, real data, real backend):

- **Session N+1 (~2 hrs):** Run details split (params vs metrics), tag editor with MLflow rules, source-notebook link, View toggle (Run details / Run list), Customize columns pane, basic Filter pane.
- **Session N+2 (~2-3 hrs):** Run comparison view with parallel coordinates + scatter + line charts (Recharts), artifact browser tree + preview, per-step metric history, "Save as ML model" wired to a new `POST /api/items/ml-experiment/[id]/register?runId=...` route.

A third session can land grade A+ (tests + bicep): Vitest unit coverage on the comparison chart data shaping, a Playwright walk against a seeded AML workspace, and a bicep module addition that documents the required `Microsoft.MachineLearningServices/workspaces` SKU + storage role assignment.
