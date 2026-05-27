# Loom ML Model Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent `mlm-parity-2026-05-26`. Source: Microsoft Learn — [Machine learning model in Microsoft Fabric](https://learn.microsoft.com/fabric/data-science/machine-learning-model), [Model scoring with PREDICT](https://learn.microsoft.com/fabric/data-science/model-scoring-predict), [Real-time model endpoints (Preview)](https://learn.microsoft.com/fabric/data-science/model-endpoints). Cross-checked against existing Loom editor at `apps/fiab-console/lib/editors/phase4-editors.tsx::MlModelEditor` and the BFF route at `apps/fiab-console/app/api/items/ml-model/[id]/route.ts`.

## What it is

A Fabric **ML Model** is an MLflow-registered model surfaced as a first-class workspace item. It holds a collection of **versions** (each is an immutable artifact registered from an experiment run). The editor lets data scientists:

- See every **version** of the model with its training metadata
- Inspect a version's **schema/signature**, **parameters**, **metrics**, **tags**, and **logged artifacts**
- **Compare multiple versions** visually (params/metrics across versions)
- **Apply** a version for scoring — either as **batch PREDICT** (Spark, via wizard or copy-paste code template) or as a **real-time endpoint** (Preview)
- **Activate / deactivate / manage** real-time endpoints per version (set default version, toggle auto-sleep)
- **Preview predictions** against an active endpoint via form or JSON

The item sits downstream of ML Experiments — a run becomes a model version via "Save as ML model" — and upstream of Lakehouse/Warehouse consumers (PREDICT writes scored rows to Delta tables).

## UI components

### Page chrome
- Title bar shows the model name plus a saved-state indicator
- Standard Fabric global bar (search, notifications, settings, help, account)
- Right-side actions: **Share**, **Settings**, **View** (toggle Version details / Model list / Comparison)

### Ribbon — Home tab
| Group | Buttons | Behavior |
|---|---|---|
| **Versions** | **Refresh** | Reloads versions from MLflow registry |
| **Versions** | **Customize columns** | Pick which params/metrics/tags appear in the version list |
| **Versions** | **Filter** | Filter by tag, time range, or metric threshold |
| **Apply** | **Apply this version** ▼ | Two options: **Apply this model in wizard** (guided PREDICT) or **Copy code to apply** (paste-into-notebook template) |
| **Endpoint** | **Activate version endpoint** | (Preview) Spins up a real-time online endpoint for the selected version |
| **Endpoint** | **Deactivate version endpoint** | Tears down the endpoint, releasing CU |
| **Endpoint** | **Preview predictions** | Opens form/JSON dialog to call the endpoint with sample inputs |
| **Endpoint** | **Manage endpoints** | Pane listing all active version endpoints, set **Default version**, toggle **Auto sleep** per endpoint |

### Version list view
- One row per version: **Version**, **Time created**, **Run name** (source experiment run), **Status**, **Endpoint status** (Inactive / Activating / Active / Deactivating / Failed), **Default** badge if it is the default version, plus selected metrics/params columns
- Multi-select feeds the Comparison view

### Version details view
- Header: `v{N}` badge, latest/default markers, time created, link back to source run + experiment
- **Schema / Signature** panel — the MLflow model signature: input columns with name + type (e.g. `feature_1: double`, `category: string`) and output columns with name + type. Required for PREDICT to work.
- **Hyperparameters** key/value table (from the originating run)
- **Metrics** key/value table with optional sparkline if step-history was logged
- **Tags** chips with inline add/edit/remove (key-value, same MLflow rules as experiment tags)
- **Logged files / Artifacts** tree: `model/` directory + any other artifacts; common previews for `MLmodel`, `conda.yaml`, `requirements.txt`, `model.pkl`
- **Endpoint details** panel (Preview): Default version (Yes/No), Status, Auto sleep, Scoring URI (e.g. `.../models/{name}/versions/{v}/score`), Swagger URI

### Comparison view
- Pick 2+ versions, switch to comparison
- Metrics/params overlay (parallel coordinates / scatter / line)
- Side table with diffs highlighted (e.g. `learning_rate: 0.01 → 0.001`)

### "Apply this version" — Wizard (5 steps)
1. **Select input table** — pick a Lakehouse + Delta table from the current workspace
2. **Map input columns** — match table column names to the model signature's input fields; types must match. Wizard auto-maps when names line up.
3. **Create output table** — destination Lakehouse + new table name; defaults to same Lakehouse as input
4. **Map output columns** — name the prediction columns appended to the output table
5. **Configure notebook** — name the new notebook that holds the generated PREDICT code; preview the generated code
6. **Review and finish** — creates the notebook in the workspace with code populated, opens it for the user to run

### "Apply this version" — Copy code template
Returns a code snippet with placeholders (`<INPUT_TABLE>`, `<INPUT_COLS>`, `<OUTPUT_COLS>`, `<MODEL_NAME>`, `<MODEL_VERSION>`, `<OUTPUT_TABLE>`) using `synapse.ml.predict.MLFlowTransformer` — three flavors: Transformer API, Spark SQL, PySpark UDF.

### Preview predictions dialog (active endpoint only)
- Form view: input fields auto-generated from the model signature; **Autofill** populates random sample values; add multiple input rows; **Get predictions** posts to the scoring URI and renders the response
- JSON view toggle: raw payload editor for users who prefer to paste structured requests

### Manage endpoints pane
- Table of active version endpoints: Version, Status, Default (radio — exactly one), Auto sleep (toggle), Scoring URI
- Bulk **Deactivate** action across multiple selected versions
- Limit: up to **5 active endpoints per model**; UI warns when the 6th is attempted
- Status flow: `Inactive → Activating → Active → Deactivating → Inactive`. `Failed` if container provisioning errors.

## What Loom has

The current Loom `MlModelEditor` (`apps/fiab-console/lib/editors/phase4-editors.tsx` lines 61–177) is wired live to **Azure AI Foundry** (`Microsoft.MachineLearningServices/workspaces`) via the BFF route `GET /api/items/ml-model/[id]`. Honest baseline:

- Calls `getModel(id)` (`GET /models/{id}`) for the container and `listModelVersions(id)` (`GET /models/{id}/versions`) for versions
- Left side panel: **Versions** tree with `v{N}` and a `latest` badge against `model.latestVersion`
- Main pane: model name + description, `Latest: v{N}` and `{count} version(s)` badges, then a **Versions table** with columns Version, Type (`modelType`), Created, URI (`modelUri`)
- Below the table: a "Selected: v{N}" block with description + Tag chips (read-only)
- Ribbon stub has tabs: **Versions** (Reload, Compare versions) and **Apply** (Apply (PREDICT), Real-time endpoint) — none of those action buttons are wired; they render as labels only
- Errors surface as Fluent `MessageBar intent="error"`; no mock data anywhere

In short: Loom lists model versions and shows flat metadata. No signature view, no metrics, no artifact browser, no comparison, no PREDICT wizard, no endpoint surface.

## Gaps for parity

1. **Signature / schema view** — the most important missing piece. MLflow returns `signature.inputs[]` and `signature.outputs[]`; we don't render them. Without this the PREDICT wizard cannot be built.
2. **Params + metrics from the source run** — the version row shows `modelType` and URI; missing is the originating run's hyperparams and metrics. Need to follow `run_id` back into the experiment and pull them.
3. **Logged-files / artifact browser** — no UI for the `model/` directory (`MLmodel`, `conda.yaml`, `requirements.txt`, `model.pkl`). Needs a tree + preview.
4. **Tag editor** — read-only today; needs inline add/edit/remove with MLflow rules.
5. **Version comparison view** — ribbon says "Compare versions" but does nothing. Need multi-select on the version list + a comparison pane (parallel coords / scatter / diff table).
6. **Apply this model in wizard** — entire 5-step wizard missing. This is the highest-value Fabric UX for non-coders and a major parity gap.
7. **Copy PREDICT code template** — the Transformer / Spark SQL / UDF snippets are documented and parameterizable; producing them client-side is a 1-hour task. Missing today.
8. **Activate version endpoint** — real-time endpoint provisioning is Preview but documented; the `onlineEndpoints` and `deployments` ARM surfaces are already mapped in `foundry-client.ts` (`listOnlineEndpoints`, `listDeployments`). No activate/deactivate calls yet.
9. **Endpoint properties panel** — Scoring URI, Swagger URI, Status, Default-version flag, Auto-sleep toggle: none surfaced.
10. **Preview predictions dialog** — form + JSON view against the scoring URI does not exist.
11. **Manage endpoints pane** — bulk endpoint management + default-version selector missing.
12. **Customize columns / Filter** on the version list — fixed columns today, no filter.
13. **View toggle (Version details / Model list / Comparison)** — Fabric has a top-level View switcher; Loom lacks it.
14. **5-endpoint limit guardrail** — when activate is wired, the UI must warn at the 6th attempt.

## Backend mapping

The current ARM path works for AML-linked workspaces; for native Fabric MLflow the equivalent REST endpoints are noted in parentheses.

| Loom surface | Backend call (current AML / Foundry path) | Backend call (Fabric MLflow path, future) |
|---|---|---|
| Model + versions | `GET {arm}/.../workspaces/{ws}/models/{name}` and `.../models/{name}/versions?api-version=2024-10-01` | `GET {fabric-mlflow}/api/2.0/mlflow/registered-models/get?name=<m>` + `/model-versions/search?filter=name='<m>'` |
| Version signature | Pull from `properties.signature` on the version, fallback to fetching `MLmodel` artifact and parsing YAML | Same — MLflow's `MLmodel` artifact holds the signature |
| Source-run params/metrics | Resolve `properties.runId` → `GET .../jobs/{runId}` → reuse experiment Run-details mapping | `GET {fabric-mlflow}/api/2.0/mlflow/runs/get?run_id=<id>` |
| Artifact browser | `GET .../models/{name}/versions/{v}/artifacts` + signed download | `GET {fabric-mlflow}/api/2.0/mlflow-artifacts/artifacts?path=model&run_id=<id>` |
| Tag CRUD | `PATCH .../models/{name}/versions/{v}` merging `properties.tags` | `POST .../model-versions/set-tag`, `POST .../model-versions/delete-tag` |
| Activate endpoint (Preview) | `PUT .../onlineEndpoints/{name}` then `PUT .../onlineEndpoints/{name}/deployments/{depName}` with `model = .../models/{name}/versions/{v}` and `instanceType` | Fabric public REST: `POST {fabric}/v1/workspaces/{wsId}/models/{modelId}/versions/{v}/endpoint:activate` (per [Fabric Model Endpoint API](https://aka.ms/fabric/model-endpoint-api)) |
| Deactivate endpoint | `DELETE .../onlineEndpoints/{name}/deployments/{depName}` (and endpoint if last) | `POST {fabric}/v1/.../endpoint:deactivate` |
| Scoring URI for preview | From `onlineEndpoint.properties.scoringUri` (set when endpoint is `Active`) | Returned in the endpoint property bag |
| Predict (Preview-predictions form) | `POST {scoringUri}` with `azureml-token` bearer, body = `{ "input_data": { "columns": [...], "data": [[...]] } }` | `POST {fabric-scoring-uri}` with workspace token; same input-data shape |
| PREDICT wizard — generate notebook code | Client-side template; the runtime call from the generated notebook uses `from synapse.ml.predict import MLFlowTransformer` and reads via Spark from the Loom Lakehouse item | Same; SynapseML is the runtime regardless of registry |

The existing client (`apps/fiab-console/lib/azure/foundry-client.ts`) already implements `getModel`, `listModelVersions`, `listOnlineEndpoints`, `listDeployments`. Missing: `getModelVersion`, `getModelVersionArtifacts`, `setModelVersionTag`, `activateEndpoint`, `deactivateEndpoint`, `getScoringUri`, `invokeScoringEndpoint`.

## Required Azure resources

- **Azure AI Foundry hub** (= `Microsoft.MachineLearningServices/workspaces`, kind `Hub`) — already provisioned as `aifoundry-csa-loom-eastus2` (env `LOOM_FOUNDRY_NAME`).
- **AML compute target** for online endpoints — managed compute (e.g. `Standard_DS3_v2`) attached to the workspace. The endpoint provisioner needs at minimum one available SKU; **without it the "Activate version endpoint" button must show a `MessageBar intent="warning"`** naming the missing compute and the bicep module that would deploy it.
- **Workspace identity role assignments**:
  - **AcrPull** on the workspace's attached Container Registry (so the endpoint can pull the inference image)
  - **Storage Blob Data Contributor** on the workspace's storage account (model artifact read + scoring-log write)
- **Application Insights** (already provisioned) — endpoint request/latency telemetry lands here when `appInsightsEnabled = true` on the deployment
- **Key Vault** (workspace-attached) — holds the endpoint's auth key (when `authMode = key`)
- **(Future, native Fabric)** A Fabric workspace + F-SKU capacity with the **ML Model Endpoint** tenant switch enabled. The `LOOM_FABRIC_WORKSPACE_ID` env var must be present; if not, surface honestly in the editor.

## Estimated effort

**2-3 focused sessions** to reach grade B (production-grade with real data + real backend):

- **Session N+1 (~2-3 hrs):** Version details split — Signature view (inputs/outputs with types), params + metrics from source run, tag editor with MLflow rules, View toggle (Version details / Model list / Comparison), artifact tree + `MLmodel`/`conda.yaml`/`requirements.txt` preview.
- **Session N+2 (~3 hrs):** PREDICT — Copy-code template (Transformer / Spark SQL / UDF flavors), then the full 5-step **Apply this model in wizard** writing a real notebook back to the Loom Workspace (uses existing `/api/items/notebook` POST). Version comparison view with parallel coordinates chart.
- **Session N+3 (~3 hrs):** Real-time endpoints — Endpoint details panel, Activate/Deactivate buttons calling new `POST /api/items/ml-model/[id]/versions/[v]/activate` and `…/deactivate` routes, Manage endpoints pane, Preview predictions form + JSON dialog calling the scoring URI through a BFF proxy. Guardrail for the 5-active-endpoints limit.

A fourth session for A+: Vitest coverage on the signature-driven form generator and the PREDICT code generator, a Playwright walk against the live AI Foundry workspace, and bicep additions to document the AcrPull / Storage role assignments and the managed-compute SKU choice.
