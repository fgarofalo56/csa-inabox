# Appendix — Microsoft Fabric **Data Science & ML** → CSA Loom parity

**Domain:** `data-science` · **Author:** Fabric→Loom Parity Architect · **Date:** 2026-06-26
**Rules honored:** `no-fabric-dependency.md`, `no-vaporware.md`, `ui-parity.md`, `web3-ui.md`,
`loom_no_freeform_config`, dual-cloud (Commercial + Government/GCC/GCC-High/IL5).

This appendix is the deep-detail companion to the condensed roadmap returned by the
parity run. It contains: (1) the **Fabric capability inventory** grounded in Microsoft
Learn, with how-it-actually-works notes + Learn URLs; (2) the **Loom coverage table**
(honest: built / stubbed / missing) traced to files; (3) for every gap a **complete build
spec** — Azure-native default + OSS, Web-5.0 UI, BFF APIs, backend services, bicep/deploy,
Commercial vs Government, day-one config, acceptance criteria.

> **North star (no-fabric-dependency):** Fabric Data Science is, at its core, *notebooks +
> Spark + MLflow + FLAML + SynapseML + Azure OpenAI* with a thin Fabric item/UX wrapper.
> Every one of those is open-source or Azure-native, so 1:1 parity is achievable with
> **zero Fabric/Power BI/OneLake dependency on the default path**. The Loom default stack is
> **Azure ML workspace (MLflow registry + AmlCompute + managed online endpoints) + Synapse
> Spark / Azure Databricks + ADLS Gen2 Delta + Azure OpenAI (Foundry) + ADX**. Fabric/Power
> BI are opt-in alternatives only, gated behind `LOOM_<ITEM>_BACKEND=fabric` + a bound
> workspace.

---

## 1. Fabric capability inventory (grounded in Microsoft Learn)

The Fabric Data Science experience (`/fabric/data-science/*`) exposes the following surfaces.
Each row: what it is, how it actually works (architecture / control flow / item model / API),
and the Learn anchor.

### A. Authoring & compute

| # | Capability | How it actually works | Learn |
|---|-----------|------------------------|-------|
| A1 | **Notebook (DS item)** | Web interactive surface; live PySpark / Spark SQL / SparkR / sparklyr / Scala / pure-Python cells. Backed by a Spark session (Livy) on a Fabric capacity or a single-node Python kernel. `spark` + `display()` are pre-bound. | [how-to-use-notebook](https://learn.microsoft.com/fabric/data-engineering/how-to-use-notebook) |
| A2 | **`%%configure` session magic** | First-cell JSON magic sizes driver/executor vCores+memory, mount points, attached environment, default lakehouse; can pull from Variable Library. Applies at session init. | [author-execute-notebook](https://learn.microsoft.com/fabric/data-engineering/author-execute-notebook#spark-session-configuration-magic-command) |
| A3 | **Language magics** (`%%pyspark`,`%%sparkr`,`%%sql`,`%%configure`,`%run`) | Per-cell language switch; `%run` chains notebooks; `notebookutils`/MSSparkUtils for fs/secrets/notebook orchestration. | [python-overview](https://learn.microsoft.com/fabric/data-science/python-guide/python-overview) |
| A4 | **`display()` rich viz** | Renders Spark/pandas DF → interactive table (10k row profile) + no-code chart builder (filter, column summary, free selection). | [notebook-visualization](https://learn.microsoft.com/fabric/data-engineering/notebook-visualization) |
| A5 | **Variable explorer** | View-pane table of name/type/length/value for current Python session. | [author-execute-notebook](https://learn.microsoft.com/fabric/data-engineering/author-execute-notebook#run-notebooks) |
| A6 | **Environment item / library mgmt** | Workspace Environment defines Spark runtime, pool, public (PyPI/conda) + custom libs; attached per notebook. | [r-library-management](https://learn.microsoft.com/fabric/data-science/r-library-management) |
| A7 | **Copilot in notebook** (chat / in-cell / Fix-with-Copilot / inline completion) | Context-aware code-gen, refactor, validate; approval-based Fix for failed cells. Powered by AOAI via Fabric tenant. | [how-to-use-notebook](https://learn.microsoft.com/fabric/data-engineering/how-to-use-notebook) |

### B. Data preparation

| # | Capability | How it actually works | Learn |
|---|-----------|------------------------|-------|
| B1 | **Data Wrangler** | Notebook-launched immersive grid over a pandas/Spark DF: summary stats, per-column distribution, **operation gallery** (filter, drop, one-hot, fillna, dedupe, sort, group, rename, type-cast, split, scale, formulas) with **live preview** + auto-generated pandas code; Spark DFs translate the pandas-sample code → PySpark on export. Exports a **reusable function** back to a notebook cell; never overwrites source DF. | [data-wrangler](https://learn.microsoft.com/fabric/data-science/data-wrangler), [data-wrangler-spark](https://learn.microsoft.com/fabric/data-science/data-wrangler-spark) |
| B2 | **Data Wrangler AI** (Copilot + AI Functions + rule-based suggestions) | NL prompt → transform with preview ("remove rows w/ missing values"); built-in AI Functions as operations; uses Fabric built-in AOAI endpoint. | [data-wrangler-ai](https://learn.microsoft.com/fabric/data-science/data-wrangler-ai) |
| B3 | **SemPy / Semantic Link** | `sempy.fabric`: `list_datasets/tables/columns/measures`, `read_table`, `evaluate_measure`, `evaluate_dax`, `add_measure`; `FabricDataFrame` subclasses pandas + carries Power BI metadata (data categories, relationships, hierarchies) and propagates it through merge/concat. Spark native connector (PySpark/SparkSQL/R/Scala). Relationship discovery/validation (`find_relationships`, `list_relationship_violations`, `plot_relationship_metadata`). | [semantic-link-overview](https://learn.microsoft.com/fabric/data-science/semantic-link-overview) |

### C. Experimentation & training

| # | Capability | How it actually works | Learn |
|---|-----------|------------------------|-------|
| C1 | **ML Experiment item + MLflow tracking** | Fabric experiment == MLflow experiment; runs log params/metrics/tags/artifacts. `mlflow.set_experiment` + autolog. UI: run list, run detail, **Run comparison** (charts). | [machine-learning-experiment](https://learn.microsoft.com/fabric/data-science/machine-learning-experiment) |
| C2 | **MLflow autologging** | `mlflow.autolog()` captures inputs/outputs without manual logging. | [mlflow-autologging](https://learn.microsoft.com/fabric/data-science/mlflow-autologging) |
| C3 | **ML Model item + registry** | MLflow-powered registry: versions, metadata, custom tags, visual + API model-version compare, "Save run as ML model". | [machine-learning-model](https://learn.microsoft.com/fabric/data-science/machine-learning-model) |
| C4 | **MLflow 3 LoggedModels + GenAI Traces** | `log_model()` → LoggedModel entity linked to run/params/metrics/datasets/env; experiment page **Logged Models** section + **Traces** tab (GenAI inputs/outputs/latency/tokens/span tree); compare via line/scatter/parallel-coords; register LoggedModel → model item. | [mlflow-3-overview](https://learn.microsoft.com/fabric/data-science/mlflow-3-overview) |
| C5 | **AutoML — low-code wizard** | UI wizard: data source (lakehouse table/file CSV/XLS/JSON) → ML task (regression / binary / multiclass / forecasting) → AutoML mode (Quick Prototype / Interpretable / Best Fit / Custom) → training-data setup (prediction col, dtypes, imputation, auto-featurize) → exec mode (parallel pandas vs sequential Spark) → names → **generated notebook** that logs to experiment+model. | [low-code-automl](https://learn.microsoft.com/fabric/data-science/low-code-automl) |
| C6 | **AutoML — FLAML code** | `flaml.AutoML().fit(dataframe, label, task, **settings)`; resource-aware search; `to_pandas_on_spark`; nested MLflow run. | [how-to-use-automated-machine-learning-fabric](https://learn.microsoft.com/fabric/data-science/how-to-use-automated-machine-learning-fabric) |
| C7 | **Hyperparameter tuning (`flaml.tune`)** | Economical HPO inside notebook; search space + budget. | [hyperparameter-tuning-fabric](https://learn.microsoft.com/fabric/data-science/hyperparameter-tuning-fabric) |
| C8 | **SynapseML** | OSS MMLSpark library: scalable ML pipelines, LightGBM/EBM, Foundry-Tools integration, `MLFlowTransformer` for PREDICT. | [data-science-overview](https://learn.microsoft.com/fabric/data-science/data-science-overview) |

### D. Operationalization & inference

| # | Capability | How it actually works | Learn |
|---|-----------|------------------------|-------|
| D1 | **PREDICT batch scoring** | Scalable Spark scoring over an MLflow model (signature required). Invoked via SynapseML `MLFlowTransformer` (Transformer API / Spark SQL / PySpark UDF). Flavors: CatBoost/Keras/LightGBM/ONNX/Prophet/PyTorch/Sklearn/Spark/Statsmodels/TensorFlow/XGBoost. Writes Delta to lakehouse. | [model-scoring-predict](https://learn.microsoft.com/fabric/data-science/model-scoring-predict) |
| D2 | **PREDICT guided UI wizard** | From model item page → "Apply this model in wizard": select input table → **map input columns to model signature** (auto-maps on name match, dtype-checked) → output table → generates a PREDICT notebook. | [model-scoring-predict](https://learn.microsoft.com/fabric/data-science/model-scoring-predict#generate-predict-code-from-an-ml-model's-item-page) |
| D3 | **Real-time model endpoints (Preview)** | Each registered version gets an online endpoint URL (`/versions/N/score`). Status: Inactive/Activating/Active/Deactivating/Failed; **Auto-sleep** scales to zero after 5 min idle; activate/deactivate from ribbon; up to 5 active versions. **Preview predictions** form (autofill, multi-input, JSON payload view). | [model-endpoints](https://learn.microsoft.com/fabric/data-science/model-endpoints) |
| D4 | **Direct Lake consumption** | Predictions written to OneLake Delta are read by Power BI Direct Lake (no copy). | [data-science-overview](https://learn.microsoft.com/fabric/data-science/data-science-overview) |

### E. Prebuilt / generative AI (Foundry Tools)

| # | Capability | How it actually works | Learn |
|---|-----------|------------------------|-------|
| E1 | **AI Functions** | One-line DataFrame methods (pandas `synapse.ml.aifunc` / PySpark `synapse.ml.spark.aifunc`): `ai.analyze_sentiment`, `ai.classify`, `ai.embed`, `ai.extract` (JSON-schema/Pydantic `ExtractLabel`), `ai.fix_grammar`, `ai.generate_response`, `ai.similarity`, `ai.summarize`, `ai.translate`. Default built-in Fabric LLM endpoint (`gpt-5-mini`), concurrency 200; configurable to AOAI/Foundry. Also in SQL & Dataflow Gen2. | [ai-functions/overview](https://learn.microsoft.com/fabric/data-science/ai-functions/overview) |
| E2 | **Azure OpenAI in Fabric** | Built-in AOAI endpoint via `get_openai_httpx_sync_client`; REST / Python SDK / SynapseML; chat + responses + embeddings. | [how-to-use-openai-python-sdk](https://learn.microsoft.com/fabric/data-science/ai-services/how-to-use-openai-python-sdk) |
| E3 | **Text Analytics (prebuilt)** | Language detection, sentiment, key-phrase extraction, PII entity recognition+redaction, NER, entity linking. REST + SynapseML. | [ai-services-overview](https://learn.microsoft.com/fabric/data-science/ai-services/ai-services-overview#prebuilt-ai-models-in-fabric-preview) |
| E4 | **Translator (prebuilt)** | Translate + transliterate. REST + SynapseML. | [ai-services-overview](https://learn.microsoft.com/fabric/data-science/ai-services/ai-services-overview) |

### F. Workload home & end-to-end

| # | Capability | How it actually works | Learn |
|---|-----------|------------------------|-------|
| F1 | **Data Science home** | Workload landing: recents, create tiles (notebook/experiment/model/AutoML), tutorials/samples. | [data-science-overview](https://learn.microsoft.com/fabric/data-science/data-science-overview) |
| F2 | **E2E DS scenario** | Ingest (lakehouse/semantic model/Spark sources/shortcuts) → explore/clean (Data Wrangler, SemPy, seaborn) → train+track (MLflow) → register → PREDICT batch → report. | [tutorial-data-science-introduction](https://learn.microsoft.com/fabric/data-science/tutorial-data-science-introduction) |

**Feature count (inventory rows): 30.**

---

## 2. Loom coverage (honest, file-traced)

Legend: ✅ built (real backend) · ⚠️ partial / honest-gate · ❌ missing · 🅂 stubbed (renders, no real backend).

| Fabric capability | Loom surface / file | Backend | Status |
|-------------------|---------------------|---------|--------|
| A1 Notebook | `lib/editors/notebook-editor.tsx` (2184 LOC) | Synapse Livy / Databricks / AML-CI execute routes | ✅ built |
| A2 `%%configure` | notebook-editor "Configure session" dialog → real Livy session sizing | Synapse Livy | ✅ built |
| A3 Language magics | notebook-editor magic parsing (`%%pyspark/%%sql/%%sparkr`), routes per backend | Synapse/Databricks | ✅ built |
| A4 `display()` viz | notebook display + `delta-preview-grid.tsx` | Spark result render | ✅ built |
| A5 Variable explorer | notebook-editor "Variables" View pane | Livy session state | ✅ built |
| A6 Environment / libs | `spark-environment-editor.tsx`, `aml-environment-conda.ts` | AML env / Synapse pool | ✅ built |
| A7 Notebook Copilot | in-cell / fix-with-copilot / inline (parity docs `notebook-*-copilot.md`) | AOAI orchestrator | ✅ built |
| B1 **Data Wrangler** | — (only `delta-preview-grid` read-only) | — | ❌ **missing** |
| B2 **Data Wrangler AI** | — | — | ❌ **missing** |
| B3 SemPy / Semantic Link | `tabular_*` copilot tools + `tabular-eval-client.ts`; parity `tabular-semantic-link.md` | Cosmos model meta + Synapse DAX→T-SQL (AAS opt-in) | ⚠️ partial (constrained DAX; no notebook `FabricDataFrame`/relationship-plot surface) |
| C1 ML Experiment + MLflow | `ml-experiment-editor.tsx` (846), runs/metrics/compare routes | MLflow REST | ✅ built |
| C2 Autologging | documented in experiment editor seed notebooks | MLflow | ✅ built |
| C3 ML Model + registry | `ml-model-editor.tsx` (784): versions, MLflow stages, register-from-run | AML ARM + MLflow REST | ✅ built |
| C4 **MLflow 3 LoggedModels + Traces** | — | — | ❌ **missing** |
| C5 AutoML low-code wizard | `automl-editor.tsx` (786): task/dataset/compute/settings/review/runs | AML AutoML job (ARM) | ✅ built |
| C6 FLAML code | covered by notebook + AutoML seed | FLAML | ✅ built |
| C7 **Hyperparameter tuning surface** | code-only (notebook); no low-code tune wizard | — | ⚠️ partial (no dedicated surface) |
| C8 SynapseML | available in Spark runtime (supercharge bundles) | Spark | ✅ built |
| D1 PREDICT batch (code) | supercharge-ml bundle notebooks | Spark `MLFlowTransformer` | ✅ built (code) |
| D2 **PREDICT guided wizard** | — (no model item-page "apply in wizard") | — | ❌ **missing** |
| D3 Real-time endpoints | ml-model Deploy tab: create online endpoint + blue deployment | AML managed online endpoint (ARM) | ⚠️ partial (deploy only; **no test/query console, no auto-sleep toggle, no activate/deactivate, no per-version mgmt**) |
| D4 Direct Lake consume | report/semantic-model Direct-Lake-equivalent surfaces | Synapse/ADLS | ✅ built (sibling domain) |
| E1 **AI Functions (full set)** | `ai-functions-helper.tsx` + `ai-functions-client.ts`: 5 of 9 (sentiment/classify/translate/summarize/extract) | Databricks `ai_query` / AOAI | ⚠️ partial (**missing embed, similarity, fix_grammar, generate_response**; SQL-only entry, no pandas/PySpark notebook affordance) |
| E2 Azure OpenAI in Fabric | foundry-playground + AOAI orchestrator | AOAI | ✅ built |
| E3 **Text Analytics prebuilt** | — (no language-detect / key-phrase / PII / NER / entity-linking surface) | — | ❌ **missing** |
| E4 **Translator prebuilt** | — (no translate/transliterate surface; translate exists only inside AI Functions) | — | ⚠️ partial |
| F1 Data Science home | `data-science-home-editor.tsx` (63) + home-content | recents (Cosmos) | ⚠️ partial (thin; no tutorials/samples/AutoML tile parity) |
| F2 E2E scenario | supercharge bundles + use-case apps | Azure-native | ✅ built |

**Loom status (domain): partial — strong core (notebook, experiment, model, AutoML, MLflow,
SemPy-lite), but four named Fabric DS surfaces are missing/partial: Data Wrangler, PREDICT
guided wizard, real-time endpoint test console, and the full AI-Functions + prebuilt
Text-Analytics/Translator set.**

---

## 3. Gap build specs

Each gap: architecture (in words) → Web-5.0 UI → BFF APIs → Azure services → bicep/deploy →
Commercial vs Government → day-one config → acceptance criteria.

---

### GAP 1 — Data Wrangler (P0, missing) — `data-wrangler` surface

**Goal:** 1:1 with Fabric Data Wrangler: an immersive grid over a tabular dataset with an
operation gallery, live preview, auto-generated pandas/PySpark code, NL (Copilot) operations,
and "export reusable function to notebook."

**Architecture (Azure-native default, no Fabric):**
- Data source = an ADLS Gen2 Delta/Parquet/CSV path or a lakehouse table (Loom lakehouse =
  ADLS Gen2 + Delta). A **Spark session** (the existing notebook Livy backend: Synapse Spark
  or Azure Databricks) loads a bounded **sample** (default 10k rows) into a pandas DF on the
  driver for interactive preview; full apply runs as PySpark.
- Each UI operation appends to an ordered **operation pipeline** (immutable steps). The server
  compiles the pipeline → idempotent pandas code (sample preview) and → PySpark code (full
  export). Preview executes the pandas code against the sample over the Livy session and
  returns the new grid + summary stats. **Never mutates the source DF.**
- Copilot operation: NL string → server prompts AOAI with the DF schema + sample to emit a
  single safe pandas transform step (validated against an allowlisted op AST), then previews it.
- Export: emits a named function (e.g. `clean_data(df)`) into a new notebook cell (writes to
  the notebook item's content via the existing notebook BFF), or copies to clipboard, or
  downloads cleaned sample CSV.

**Operation gallery (parity set):** filter rows, drop/keep columns, drop duplicates, drop
missing, fill missing (impute mean/median/mode/constant/ffill), one-hot encode, label encode,
rename, change type, sort, group-by aggregate, split column, find/replace, scale/normalize
(min-max/standard), bin, string ops (lower/upper/trim/extract), date parse, formula (pandas
expression — the single allowed freeform, mirroring Fabric "Custom code"/Formulas).

**Web-5.0 UI** (`lib/editors/data-wrangler-editor.tsx`): three-pane Fluent v9 surface —
left **operation panel** (categorized accordions w/ Fluent icons), center **rich data grid**
(`delta-preview-grid` upgraded: column headers show dtype + mini-histogram, click → Summary
panel), right **Summary + Generated code** (Monaco read-only, pandas↔PySpark tab toggle).
Top: dataset picker (lakehouse table / ADLS path), sample-size SpinButton, **Copilot box**
("describe a transformation"), step breadcrumb chips (undo/reorder/remove). All Loom tokens,
`TileGrid`/`EmptyState`/`Spinner`. No raw JSON; the only freeform = the Formula op cell.

**BFF APIs** (`app/api/items/data-wrangler/...`):
- `GET  /sources` → lakehouse tables + datastores (reuse AutoML options).
- `POST /preview` `{source, sample, steps[]}` → `{rows, columns(dtype+stats), pandasCode}` (executes sample on Livy).
- `POST /suggest` `{schema, sample, prompt}` → one validated op step (AOAI).
- `POST /export` `{steps[], target:{notebookId|clipboard|csv}, fnName}` → writes cell / returns code / returns CSV.
All return `{ok, data, error}`; real Spark/AOAI calls, no mocks.

**Azure services:** Synapse Spark (default) or Azure Databricks (Livy); ADLS Gen2; AOAI
(Foundry) for Copilot. Reuses `synapse-livy-client`, `databricks` client, `aoai` orchestrator.

**Bicep / deploy:** no new resource — rides existing Spark + AOAI deployed day-one. Add
`data-wrangler` to catalog-meta + `registry.ts` editor map. Add provisioner
`provisioners/data-wrangler.ts` (creates the Cosmos item, no Azure infra).

**Commercial vs Government:**
- Commercial/GCC: Synapse Spark or Databricks; AOAI `gpt-4o`/`gpt-5-mini`.
- GCC-High/IL5: Synapse Spark in Azure Government (`.usgovcloudapi.net`); AOAI Gov (`gpt-4o`
  Gov deployment) — if a Gov region lacks the model, Copilot op degrades to an honest
  MessageBar while the non-AI operation gallery stays fully functional (rule-based ops need
  no LLM). OSS substitute if no Spark licensed: pandas-only mode on the single-node Python
  kernel (already a Loom notebook backend) for ≤sample-size data.

**Day-one ON:** surface enabled at deploy; Spark + AOAI already provisioned; user can disable
the Copilot box via setting but the gallery is always live.

**Acceptance:** open Data Wrangler on a seeded lakehouse table with `LOOM_DEFAULT_FABRIC_WORKSPACE`
unset → apply fill-missing + one-hot + filter → live preview updates → generated PySpark shown
→ export function into a notebook → run the cell → identical cleaned DF. Receipt: `/preview`
response first 300 chars + grid screenshot.

---

### GAP 2 — PREDICT guided batch-scoring wizard (P0, missing) — on the ML Model item

**Goal:** 1:1 with Fabric "Apply this model in wizard": select input table → map columns to the
model signature → choose output table → generate + run a batch-scoring job.

**Architecture (Azure-native):**
- Reads the **MLflow model signature** of the bound AML registered model version (`/stage`
  surface already resolves MLflow versions). Required input fields come from the signature.
- Input table = lakehouse Delta table (ADLS Gen2). Wizard auto-maps source columns → signature
  fields on name match; flags dtype mismatches.
- Scoring runs as a **Synapse Spark / Databricks job** using SynapseML `MLFlowTransformer`
  (`model.transform(df)`), writing Delta to the chosen output path — exactly the Fabric PREDICT
  code path, but the model is loaded from the **AML/MLflow registry** (or OSS MLflow on AKS in
  Gov), not the Fabric registry. Job submission reuses the existing Spark execute/run route;
  status polled like AutoML runs.

**Web-5.0 UI** (new tab "Batch score" in `ml-model-editor.tsx`, + `predict-wizard.tsx`):
stepper — (1) Version + input table (dropdowns), (2) **column-mapping grid** (signature field →
source column dropdowns, dtype badges, auto-filled), (3) output table + write-mode (overwrite/
append), (4) Review + "Generate notebook" / "Run now". Runs tab shows job status + output-table
link. Tokens/cards/Spinner; no JSON.

**BFF APIs** (`app/api/items/ml-model/[id]/predict/...`):
- `GET  /signature` → model signature fields (from MLflow) + lakehouse tables.
- `POST /score` `{version, inputTable, mapping, outputTable, mode}` → submits Spark job → `{jobId}`.
- `GET  /score/[jobId]` → status + output rowcount.
(Reuses `mlflow-client`, `synapse-livy-client`/databricks, ADLS client.)

**Azure services:** AML/MLflow registry, Synapse Spark or Databricks, ADLS Gen2 Delta.

**Bicep / deploy:** no new resource (AML + Spark + ADLS already day-one). Add `predict`
sub-routes; extend ml-model editor.

**Commercial vs Government:** Commercial/GCC = AML managed MLflow + Synapse/Databricks.
GCC-High/IL5 = OSS MLflow tracking server (AKS/ACA + Postgres + ADLS artifact store, see GAP 4
substitute) as the registry source; Synapse Spark Gov for scoring. Model load is MLflow-format
either way, so the transform code is identical.

**Day-one ON:** enabled with the ml-model editor. **Acceptance:** bind a registered model →
batch-score a seeded input table → output Delta table written with a `prediction` column →
rowcount matches input; `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. Receipt: `/score` job
Succeeded + output table preview.

---

### GAP 3 — Real-time endpoint test/query console + lifecycle (P1, partial) — ML Model Deploy tab

**Goal:** complete the Fabric model-endpoint parity: per-version endpoint, **activate/deactivate**,
**auto-sleep** toggle, status chip (Inactive/Activating/Active/Deactivating/Failed), and a
**Preview predictions** console (form fields from signature + Autofill + multi-input + JSON
payload view + Get predictions).

**Architecture (Azure-native):** AML **managed online endpoints** already deployed by the
existing route. Add: (a) **invoke** — server calls the endpoint `scoring_uri` with the key
(key auth, server-held), returns predictions; (b) **lifecycle** — deactivate = delete the
deployment / set instance-count 0; activate = (re)create blue deployment; auto-sleep maps to
AML deployment `scale_settings` (or a Loom idle-monitor that scales the deployment to 0 after
5 min via Azure Monitor + a scheduled job). Status from ARM `provisioningState` + deployment
traffic.

**Web-5.0 UI:** Deploy tab gains an **Endpoints table** (version, status chip, auto-sleep
Switch, Activate/Deactivate buttons) + a **Test panel**: signature-driven form (`Field` per
input, **Autofill** random sample, "add input set"), a **JSON payload** Monaco toggle, and a
**Get predictions** button rendering a results table. Loom tokens; status chips colored.

**BFF APIs** (`app/api/items/ml-model/[id]/endpoint/...`):
- `POST /invoke` `{version, inputs[]}` → predictions (server signs with endpoint key).
- `POST /activate` / `POST /deactivate` `{version}` → manage deployment.
- `PATCH /autosleep` `{version, enabled}` → scale settings.
- `GET /` (extend) → per-version status + auto-sleep state.

**Azure services:** AML managed online endpoints/deployments (ARM data plane), Azure Monitor
(idle scale-down), Key Vault (endpoint key, server-side only).

**Bicep / deploy:** AML workspace + ACR + managed online endpoint compute quota already in
`ml-workspace.bicep`; add Console UAMI role for endpoint invoke (AzureML Data Scientist covers
it). Idle scale-down = a small ACA cron job or Monitor alert (reuse activator pattern).

**Commercial vs Government:** Commercial/GCC = AML managed online endpoints. GCC-High/IL5 =
AML managed online endpoints available in Azure Government; if unavailable in a target region,
**OSS substitute**: containerize the MLflow model (`mlflow models build-docker`) → push to ACR →
deploy as an **Azure Container App** (scale-to-zero native = auto-sleep) fronting `/score`.
Same invoke contract.

**Day-one ON:** endpoint deploy + test console enabled; auto-sleep default ON (matches Fabric).
**Acceptance:** deploy a version → status reaches Active → Autofill + Get predictions returns a
score → deactivate → status Inactive → reactivate. Receipt: `/invoke` response + screenshot.

---

### GAP 4 — AI Functions full set + prebuilt Text Analytics / Translator (P1, partial) — `ai-models` surface + notebook affordance

**Goal:** (a) complete the 9 Fabric AI Functions (add **embed, similarity, fix_grammar,
generate_response**); (b) expose them in **pandas/PySpark notebook** affordance (not only the
SQL editor); (c) add a dedicated **Prebuilt AI models** surface for **Text Analytics**
(language detection, key-phrase, PII recognition+redaction, NER, entity linking) and
**Translator** (translate + transliterate).

**Architecture (Azure-native):**
- AI Functions: extend `ai-functions-client.ts` `AiFn` union + handlers. Default backend:
  Databricks `ai_query`/`ai_*` in-DB where a SQL warehouse exists; else **AOAI-direct**
  (chat/embeddings) — `embed`/`similarity` use `text-embedding-3-large` (or `ada-002`),
  `similarity` = server cosine over two columns, `fix_grammar`/`generate_response` = chat.
- Prebuilt models: **Azure AI Language** (Text Analytics) + **Azure AI Translator** Cognitive
  resources, called server-side via REST (SynapseML parity). These are the same services
  Fabric's "Foundry Tools" wrap — Loom calls them directly, no Fabric.
- Notebook affordance: a "Add AI Function" ribbon action in `notebook-editor.tsx` inserts a
  validated pandas/PySpark `df.ai.<fn>(...)` cell wired to the Loom AOAI endpoint
  (`get_openai_httpx_sync_client` equivalent server helper).

**Web-5.0 UI:**
- Extend `ai-functions-helper.tsx`: 9 functions in the picker, each with a typed param form
  (extract → JSON-schema/Pydantic builder; classify → labels chips; translate → language
  dropdown; embed/similarity → column pickers). Preview rows inline.
- New `lib/editors/ai-models-editor.tsx` (`ai-models` item): tabbed **Text Analytics** /
  **Translator** with a sample-text box or column picker, run, and a results grid (entities
  highlighted, PII redacted preview, language + confidence, key phrases as chips).

**BFF APIs:**
- Extend `POST /api/items/[type]/[id]/ai-function` with the 4 new fns.
- `POST /api/ai-models/text-analytics` `{op, text|column}` → AI Language REST.
- `POST /api/ai-models/translate` `{op:translate|transliterate, to, text}` → Translator REST.

**Azure services:** Azure AI Language, Azure AI Translator, AOAI (embeddings + chat),
Databricks SQL (optional in-DB path).

**Bicep / deploy:** add `ai-language.bicep` + `ai-translator.bicep` (Cognitive Services
accounts), grant Console UAMI **Cognitive Services User**, wire `LOOM_AI_LANGUAGE_ENDPOINT` /
`LOOM_AI_TRANSLATOR_ENDPOINT` into `admin-plane/main.bicep` env; deployed **day-one**.

**Commercial vs Government:** Commercial/GCC = global AI Language/Translator + AOAI.
GCC-High/IL5 = Azure Government Cognitive Services (`.us`) — AI Language + Translator are
available in Azure Government; AOAI Gov for embeddings/chat. If a Gov region lacks embeddings,
**OSS substitute**: sentence-transformers on the Spark/ACA runtime for `embed`/`similarity`;
spaCy/Presidio (OSS PII) on ACA for NER/PII if AI Language is unavailable. Honest MessageBar
only if neither managed nor OSS is deployed (but bicep deploys them day-one, so the default is ON).

**Day-one ON:** AI Language + Translator + AOAI deployed and enabled at deploy; all 9 AI
Functions live. **Acceptance:** run `embed`+`similarity` on two text columns → cosine scores;
run PII recognition → redacted output; translate+transliterate a phrase. Receipt per surface.

---

### GAP 5 — MLflow 3 LoggedModels + GenAI Traces (P2, missing) — ML Experiment editor

**Goal:** add the MLflow-3 **Logged Models** section + **Traces** tab to the experiment editor.

**Architecture:** AML's MLflow 3 tracking exposes LoggedModel entities + traces over the same
MLflow REST already used by `ml-experiment-editor`. Add `loggedModels` + `traces` reads; render
compare (line/scatter/parallel-coords — the SVG charts already exist) and a trace span viewer
(inputs/outputs/latency/tokens/span tree). Register-LoggedModel → reuse existing register route.

**Web-5.0 UI:** two new tabs in the experiment editor — **Logged Models** (list + multi-select
compare reusing existing chart components) and **Traces** (span tree + timing). Tokens/cards.

**BFF APIs:** `GET /api/items/ml-experiment/[id]/logged-models`, `.../traces`. MLflow REST.

**Azure services:** AML MLflow 3 (Commercial/GCC) / OSS MLflow ≥3 on AKS-ACA (Gov).
**Bicep:** none new (rides AML / OSS MLflow). **Day-one ON.** **Acceptance:** a run that calls
`log_model()` shows a LoggedModel; a GenAI run shows a trace; compare renders.

---

### GAP 6 — Hyperparameter-tuning low-code surface + DS-home enrichment (P2, partial)

- **HPO surface:** a light wizard (search space per param, metric, budget) that generates a
  `flaml.tune` notebook + logs to the experiment — mirror the AutoML wizard pattern; backend =
  same Spark + MLflow. Optional; notebook code path already works.
- **DS home:** enrich `data-science-home` to Fabric parity — create tiles (notebook, experiment,
  model, **AutoML**, **Data Wrangler**, **AI models**), recents, and a tutorials/samples gallery
  (link the supercharge bundles + use-case apps). Pure navigation + Cosmos recents; no infra.
  **Day-one ON.**

---

## 4. Cross-cutting deployment & day-one summary

| Concern | Commercial / GCC | Government (GCC-High / IL5/6) |
|---------|------------------|------------------------------|
| Spark compute | Synapse Spark / Azure Databricks | Synapse Spark (Gov) / Databricks (Gov where licensed) / single-node Python fallback |
| MLflow registry | AML managed MLflow | OSS MLflow ≥3 on AKS/ACA + Postgres + ADLS artifacts |
| Real-time serving | AML managed online endpoints | AML managed endpoints (Gov) or MLflow→ACR→ACA scale-to-zero |
| LLM (Copilot/AI Fns) | AOAI `gpt-5-mini`/`gpt-4o`, `text-embedding-3-large` | AOAI Gov; OSS sentence-transformers/Presilio fallback |
| Prebuilt AI | Azure AI Language + Translator (global) | Azure AI Language + Translator (`.us`); Presidio/spaCy OSS fallback |
| Networking | private endpoints optional | private-only, no public egress; `.usgovcloudapi.net` / `.us` endpoints |
| Fabric/Power BI | opt-in only (`LOOM_*_BACKEND=fabric`) | blocked (`isGovCloud()` forces Azure-native) |

**Everything is deployed + enabled day-one by bicep** (Spark, AML workspace, AOAI, AI Language,
AI Translator). No capability ships dark; users disable what they don't want. The only honest
gates are genuine missing-infra cases that bicep is intended to deploy (e.g. a Gov region
lacking AOAI embeddings → OSS fallback, then MessageBar only if neither is present).

## 5. Verification (per no-vaporware + ui-parity)
For each gap PR: install the item with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET → drive the primary
action against the real Azure backend → attach endpoint response (first 300 chars) + screenshot
+ bicep diff. Side-by-side click-through vs the Fabric DS UI for the named surface.

## Sources (Microsoft Learn)
See inline Learn URLs in §1. Key anchors: data-science-overview, data-wrangler(+spark/+ai),
semantic-link-overview, machine-learning-experiment, machine-learning-model, mlflow-3-overview,
low-code-automl, automated-machine-learning-fabric, hyperparameter-tuning-fabric,
model-scoring-predict, model-endpoints, ai-functions/overview, ai-services-overview,
how-to-use-openai-python-sdk, author-execute-notebook, notebook-visualization.
