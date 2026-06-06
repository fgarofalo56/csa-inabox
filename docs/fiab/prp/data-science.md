# PRP — CSA Loom Data Science Experience (Azure-native, full Fabric parity)

> **Status:** Implementation-ready feature-requirement prompt (PRP).
> **Scope:** Bring CSA Loom to **one-for-one parity with the Microsoft Fabric
> "Data Science" experience**, built entirely on **Azure-native + OSS**
> backends. **No hard dependency on real Microsoft Fabric / Power BI.**
> **Governing rules:** `.claude/rules/no-fabric-dependency.md`,
> `.claude/rules/no-vaporware.md`, `.claude/rules/ui-parity.md`,
> `.claude/rules/loom_no_freeform_config.md`, `.claude/rules/loom_design_standards.md`.
> **Date:** 2026-06-06.

---

## 0. Operating constraints (read before any task)

1. **Azure-native is the DEFAULT path.** Every feature must work with
   `LOOM_DEFAULT_FABRIC_WORKSPACE` **UNSET**. Fabric is opt-in only behind
   `LOOM_DATASCIENCE_BACKEND=fabric` + a bound workspace.
2. **No vaporware.** No `return []`, no `useState(MOCK_DATA)`, no buttons
   without handlers, no tabs that render empty. Every control hits a real
   backend (Azure ML REST / Azure OpenAI / MLflow REST / Jupyter Server
   protocol) or shows an honest Fluent `MessageBar intent="warning"` naming the
   exact env var / role / resource to provision.
3. **No freeform/JSON config** except 1:1 ADF/Synapse expression builders
   (not applicable to most of this experience). Session config, schedules, etc.
   use dropdowns/sliders/wizards.
4. **Fluent v9 + Loom tokens** for every surface; cards, icons, spacing,
   keyboard nav per `loom_design_standards.md`.
5. **Every PR carries a "real-data E2E receipt"** per `no-vaporware.md`:
   endpoint hit, first 300 chars of the real response, browser screenshot /
   Playwright trace, bicep diff if infra changed.

---

## 1. Overview & Azure-native + OSS architecture

### 1.1 What the Fabric Data Science experience is

Fabric Data Science = a dedicated experience (switcher target) composed of
**Notebook**, **ML Experiment**, **ML Model**, and **Spark Job Definition**
item types, with a deeply integrated **Copilot** (chat pane, inline completion,
in-cell, fix-with-copilot), MLflow tracking + model registry, a zero-setup
Spark session, the `display()` rich-viz widget, a variable explorer, Pylance
IntelliSense, environments/library management, and notebook scheduling.

### 1.2 Azure-native + OSS backing (the 1:1 replacement)

| Concern | Azure-native (DEFAULT) | OSS used | Fabric (opt-in only) |
|---|---|---|---|
| Notebook compute | **Azure ML Compute Instance** (managed single-node VM, JupyterLab + Jupyter Server) | JupyterLab, `nbformat`, `ipykernel` | Fabric notebook kernel |
| Spark cells | **AML Serverless Spark** (Synapse-backed) → fallback **attached Synapse Spark pool** (Gov) | Apache Spark / PySpark | Fabric Spark |
| Code editor / IntelliSense | **Monaco** client-side + **Pylance LSP over WebSocket** to the running Compute Instance | Monaco, Pylance, `jupyter-lsp` | Fabric Monaco |
| Experiment tracking | **Azure ML + MLflow** (AML is an MLflow tracking server) | **MLflow** (OSS server on AKS for IL5) | Fabric MLflow |
| Model registry | **Azure ML Model Registry** | MLflow Model Registry | Fabric ML Model item |
| Copilot (chat/inline/in-cell/fix) | **Azure OpenAI** (`gpt-4o` / `gpt-4.1`) via existing `/apps/copilot` backend | Semantic Kernel / LangChain for context + slash routing | Fabric Copilot |
| Datastore browsing | **AML Datastore REST** (ADLS Gen2 / Blob) + `delta-rs` for Delta schema | `delta-rs` (deltalake py) | Fabric Lakehouse Explorer |
| Rich viz (`display()`) | Browser-rendered grid + charts from a Loom-injected helper | **TanStack Table**, **Vega-Lite**, `@dnd-kit` | Fabric `display()` |
| Scheduling | **Azure ML Job schedule** (recurrence) or notebook-as-pipeline-activity | — | Fabric scheduler |
| Environments / libraries | **AML Environment** (curated/custom Docker + conda) | conda, pip | Fabric Environment item |

### 1.3 Four-cloud portability summary

| Cloud | AML Studio endpoint | Azure OpenAI | Key gaps / workarounds |
|---|---|---|---|
| **Commercial** | `*.api.ml.azure.com` (GA all regions) | GA, many regions | Full parity. VS Code for Web available. |
| **Azure Government (GCC / GCC-High)** | `usgovvirginia.api.ml.azure.us`, `usgovarizona.api.ml.azure.us` (GA) | `openai.azure.us` GA in USGovArizona + USGovVirginia (`gpt-4o`, `gpt-4o-mini`, `gpt-35-turbo`, embeddings; **batch NOT available**) | **VS Code integration NOT available in Gov** → use in-browser Monaco + Pylance-over-WS; **AML Serverless Spark data-wrangling marked NO** in US-Virginia/US-Arizona → **attach dedicated Synapse Spark pool** (supported). AI Foundry portal `ai.azure.us`. |
| **IL4 / IL5 (US DoD)** | AML in FedRAMP High + IL4/IL5 PA scope in **US Gov regions** (CMK on associated storage for IL5) | Azure OpenAI FedRAMP-High authorized in Gov; no IL5-specific exclusion noted | DoD-dedicated regions (US DoD Central/East) do **not** list AML — route IL5 AML workloads to **US Gov Virginia/Arizona**. Synapse Analytics is FedRAMP-High scoped for the Spark-pool path. For full air-gap, OSS MLflow-on-AKS + attached Synapse Spark pool. |

All endpoint resolution flows through a single helper, `resolveAmlTarget()`
(new) mirroring the existing `resolveAoaiTarget()` so cloud is a config concern,
never hard-coded.

### 1.4 High-level component diagram

```
Loom Console (Next.js, fiab-console)
  ├─ /experience/data-science/home            (React canvas route)
  ├─ lib/editors/notebook-editor.tsx          (AML + Fabric switch)
  │    ├─ Monaco cell editor + Pylance LSP (WS)
  │    ├─ Copilot drawer / in-cell / inline / fix
  │    ├─ Variables pane / display() viz / session config
  │    └─ Datastore explorer (AML Datastore + delta-rs)
  ├─ lib/editors/ml-experiment-editor.tsx     (MLflow runs)
  ├─ lib/editors/ml-model-editor.tsx          (AML registry — exists)
  └─ app/api/...                              (BFF routes → Azure REST)
        ├─ /api/foundry/computes              (Compute Instance list/start)
        ├─ /api/notebook/[id]/execute(-spark) (Jupyter Server proxy)
        ├─ /api/notebook/[id]/lsp             (WS Pylance bridge)
        ├─ /api/copilot/{sessions,complete}   (Azure OpenAI)
        ├─ /api/aml/datastores                (AML Datastore REST + delta-rs)
        ├─ /api/aml/experiments|runs|models   (MLflow / AML REST)
        └─ /api/notebook/[id]/schedule        (AML Job schedule)
```

---

## 2. Feature-by-feature parity table

Legend — **Status**: ✅ built · ⚠️ honest-gate · 🟡 stub/partial · 🔴 missing/placeholder.
Effort estimates are engineering-hours for the coding agent.

| # | Fabric feature | Azure-native backend | Loom UI surface | Portability notes | Loom status today | Work needed |
|---|---|---|---|---|---|---|
| 1 | Data Science Home Page | AML Studio Home (jobs/experiments/models/endpoints) REST | `/experience/data-science/home` canvas: Recent notebooks/experiments/models, quick-create, learning strip | GA Commercial + Gov (`.us`). No native "recommended tutorials" → curated static list | 🔴 missing | New `data-science-home` editor + `/api/items/data-science/home` route |
| 2 | Notebook — Create & Manage | AML Compute Instance JupyterLab + Jupyter Server; notebooks on workspace file share | Notebook canvas: New-Notebook wizard (kernel/name), Datastore explorer, .ipynb import, auto-start CI | CI GA Commercial+Gov; VS Code integration NOT in Gov | 🟡 stub (wired to Fabric workspaces) | Add AML-CI path via workspace-type switch; CI selector + auto-start + datastore explorer + kernel selector + upload |
| 3 | Notebook — Cell Types & Authoring | AML CI kernel (Python/R); Serverless/Synapse Spark for PySpark; magics | Cell-type selector, `%%pyspark` routing, toolbar (Run/Stop/Move/Delete/Convert), drag reorder, split/merge, collapse | Spark data-wrangling NO in Gov → attach Synapse pool. No Scala in CI integrated editor → kernel selector surfaced | 🟡 stub (Fabric patterns only) | Cell-type selector + `%%pyspark` route to `/api/notebook/[id]/execute-spark`; magic highlight; @dnd-kit reorder |
| 4 | Notebook — IDE IntelliSense (Pylance) | Pylance LSP on running CI (jupyter-lsp); Monaco client-side | Monaco editor in cells; Pylance over WebSocket; "Open in VS Code for Web" deep-link | Monaco everywhere; VS Code for Web NOT in Gov (browser Pylance still works) | 🔴 placeholder (textarea) | Swap textarea → `monaco-textarea`; WS Pylance bridge `/api/notebook/[id]/lsp`; hover/goto/params |
| 5 | Notebook — Copilot Chat Pane | Azure OpenAI via `/apps/copilot`; schema context from AML Datastore + delta-rs | Right drawer chat: history, streaming, `/fix /explain /comments /optimize`, multi-cell diff "Apply" | AOAI GA Commercial + Gov (`openai.azure.us`); batch NOT in Gov | 🔴 placeholder (cross-item copilot not embedded) | Embed chat drawer; wire `/api/copilot/sessions`; slash templates; context injection; diff-apply |
| 6 | Notebook — Fix with Copilot | Azure OpenAI; error context = stderr + traceback | Inline "Fix with Copilot" below failed cell → opens pane prefilled with error + cell; approve diff | Same as #5 | 🔴 missing | Error-output capture in CodeCell; inline button; `/api/copilot/sessions` accepts error ctx → diff |
| 7 | Notebook — Inline Code Completion | Azure OpenAI completions; debounced | Monaco `InlineCompletionItemProvider` ghost text; Tab accepts; toolbar toggle | Requires #4 Monaco; AOAI Gov OK | 🔴 missing | `/api/copilot/complete`; Monaco inline provider; 300ms debounce; schema context |
| 8 | Notebook — In-Cell Copilot | Azure OpenAI completions | Per-cell Copilot button → popover prompt + slash commands; inserts result cell below | Same as #7 | 🔴 missing | Cell-toolbar Copilot button + popover; reuse `/api/copilot/complete` |
| 9 | Notebook — Variable Explorer | Jupyter kernel `%whos` / comm inspection | Right-panel "Variables" tab: sortable Name/Type/Length/Value; repr() tooltip | Python kernel only (same as Fabric) | 🔴 placeholder | Variables tab; run `%whos` on kernel connect; sortable grid |
| 10 | Notebook — `display()` rich viz | Loom-injected helper → comm to browser; Spark job for full-dataset agg | TanStack table (col/row select, summary stats, CSV copy), Inspect pane, Vega-Lite charts (≤5, X/Y/legend/agg, recommendations) | Client-side render; agg-over-all triggers Spark | 🔴 missing | `ai_display()` python helper auto-loaded; cell output hook; TanStack grid + Vega specs |
| 11 | Notebook — Session Config & Mgmt | `%%configure`; AML CI/Spark session API; status | "Configure Session" dialog: executors (slider), memory, timeout; status badge (Idle/Running/Error); High-Concurrency note | Sliders, no JSON | 🔴 placeholder | Dialog + `%%configure` apply; status badge; `/api/notebook/[id]/config` |
| 12 | Notebook — Scheduling | AML Job schedule (recurrence) or pipeline notebook-activity | Ribbon "Schedule" button → recurrence wizard (cron-free dropdowns); list/enable/disable | AML schedule GA Commercial + Gov | 🔴 missing | Schedule wizard + `/api/notebook/[id]/schedule` (AML REST create/list/disable) |
| 13 | Notebook — Library & Environment Mgmt | AML Environment (curated/custom Docker+conda); `%pip`/`%conda` inline | Environment selector + "Manage Environment" panel: PyPI/Conda lists, .jar, attach to notebook | AML Env GA Commercial + Gov | 🔴 missing | Env selector + manage panel; `/api/aml/environments` (list/create/attach) |
| 14 | ML Experiment (tracking) | AML/MLflow tracking server; runs, params, metrics, artifacts | `ml-experiment` editor: runs table, metric charts, params diff, artifact browser, compare-runs | MLflow REST GA Commercial + Gov; OSS MLflow-on-AKS for IL5 | 🔴 missing | New `ml-experiment` editor + `/api/aml/experiments` + `/api/aml/runs` (MLflow REST) |
| 15 | ML Model (registry) | AML Model Registry; versions, stages, deploy to online endpoint | `ml-model` editor (exists): models, versions, stage transitions, register-from-run, deploy | AML registry GA Commercial + Gov | ✅ built (extend) | Add register-from-run + stage transitions if missing; verify live |
| 16 | Experiment switcher / Data Science nav | AML Studio left-nav | Loom experience switcher entry "Data Science" → home (#1) | n/a | 🔴 missing | Register experience in switcher config |

---

## 3. Azure / OSS service feature-sets + native UI surfaces to rebuild 1:1

For each backing service, enumerate the **real UI surface** Loom must mirror
(per `ui-parity.md`). Ground each in Microsoft Learn before building.

### 3.1 Azure Machine Learning — Compute Instance + integrated notebook
**Native UI (ml.azure.com → Notebooks / Compute):**
- **Notebooks file tree** (workspace file share): create folder/file, rename,
  delete, upload, download, clone-sample, GitHub clone.
- **Compute Instance bar**: select/create CI, **Start / Stop / Restart**, status
  pill, "Open in JupyterLab / Jupyter / VS Code (Web/Desktop) / Terminal".
- **Integrated editor**: code/markdown cells, run/run-all, kernel picker
  (Python 3.10, R, custom conda env), IntelliSense, variable inspect.
- **Datastore / Data**: registered datastores (ADLS Gen2, Blob), browse, mount,
  `abfss://` path insert.
**Loom must rebuild:** file tree (datastore explorer), CI bar (selector +
start/stop/status), cell editor (Monaco), kernel picker, datastore browser.
REST: `computes`, `datastores`, Jupyter Server contents/kernels API via proxy.

### 3.2 Azure ML Serverless Spark / attached Synapse Spark pool
**Native UI:** Spark session config (driver/executor cores+memory, instances,
session timeout, conda/inline packages), session monitor (Spark UI link), logs.
**Loom must rebuild:** Configure-Session dialog (#11) → `%%configure`; session
status badge; "Open Spark UI" link; Gov path attaches Synapse pool.

### 3.3 Azure OpenAI (Copilot backend)
**Native concepts:** chat completions (streaming), system+context messages,
function/tool calling, token limits per model.
**Loom must rebuild:** chat drawer, inline completion, in-cell, fix-with-copilot
— all via `/apps/copilot` proxy with slash-command prompt templates and
schema/error context injection.

### 3.4 MLflow (tracking + registry) — AML-hosted or OSS-on-AKS
**Native UI (MLflow UI / AML Jobs+Models):**
- **Experiments**: experiment list, runs table (sortable/filterable columns of
  params+metrics), run detail (params, metrics with step charts, tags,
  artifacts), **compare runs** (parallel-coords + metric overlay), search by
  param/metric.
- **Models**: registered models list, versions, **stage transitions**
  (None/Staging/Production/Archived), lineage to source run, deploy.
**Loom must rebuild:** runs table (#14), metric charts, compare-runs, artifact
browser; models registry already in `ml-model` editor (#15). REST: MLflow
`2.0/mlflow/experiments`, `/runs/search`, `/registered-models`,
`/model-versions/transition-stage`.

### 3.5 OSS libraries
- **Monaco** — cell editor + inline completion provider + LSP client.
- **Pylance / jupyter-lsp** — type-check, hover, goto, params over WS.
- **TanStack Table** — `display()` grid (col/row select, summary stats).
- **Vega-Lite** — `display()` charts + recommendations.
- **@dnd-kit** — cell drag-reorder.
- **delta-rs (deltalake)** — Delta table schema introspection for Copilot
  context + datastore explorer.

---

## 4. Sequenced task list (implementable units, no stubs)

Each task: **Goal · Files · Backend/REST · Bicep/portability · UI · Acceptance
(real-data, zero stubs)**. Tasks are ordered so foundational plumbing lands
first. Reuse existing assets: `lib/components/editor/monaco-textarea.tsx`,
`app/api/copilot/{sessions,complete}`, `lib/editors/ml-model-editor`,
`mlflow-client.ts`, `resolveAoaiTarget`.

---

### TASK 1 — `resolveAmlTarget()` + AML REST client (foundation)
- **Goal:** Single cloud-aware resolver + typed client for AML control-plane
  (computes, datastores, experiments, runs, models, schedules, environments).
- **Files:** create `apps/fiab-console/lib/clients/aml-client.ts`,
  `apps/fiab-console/lib/clients/resolve-aml-target.ts`; edit
  `apps/fiab-console/lib/clients/index.ts`.
- **Backend/REST:** ARM `Microsoft.MachineLearningServices/workspaces/computes`;
  AML data-plane `/datastores`, MLflow `2.0/mlflow/*`. Auth via existing managed
  identity / `DefaultAzureCredential`.
- **Bicep/portability:** add env `LOOM_AML_WORKSPACE`, `LOOM_AML_RESOURCE_GROUP`,
  `LOOM_AML_SUBSCRIPTION`, `LOOM_AML_REGION` to `admin-plane/main.bicep` apps env
  list; resolver picks `.us` suffix for Gov via existing cloud detection.
- **UI:** none (library).
- **Acceptance:** `aml-client.listComputes()` returns the live CI list (first
  300 chars in receipt) against a real AML workspace with
  `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. tsc clean; vitest unit test mocks ARM
  and asserts Gov endpoint selection.

### TASK 2 — Compute Instance API: list / start / status
- **Goal:** BFF for CI lifecycle.
- **Files:** create `apps/fiab-console/app/api/foundry/computes/route.ts`,
  `apps/fiab-console/app/api/foundry/computes/[id]/start/route.ts`,
  `.../[id]/status/route.ts`.
- **Backend/REST:** ARM computes GET/list; `start` action POST; poll
  provisioning/running state.
- **Bicep/portability:** Console UAMI needs **AzureML Compute Operator** (or
  Contributor scoped to the AML workspace) — add `roleAssignments` to the AML
  bicep module + bootstrap workflow.
- **UI:** none (consumed by Task 5/6).
- **Acceptance:** `GET /api/foundry/computes` returns real CIs;
  `POST .../start` transitions a stopped CI to Running (receipt shows state
  change). Returns `{ok,data,error}` with proper status codes. Honest-gate
  MessageBar payload when role missing.

### TASK 3 — Jupyter Server proxy (contents + kernel execute)
- **Goal:** Execute cells against the running CI kernel; read/write `.ipynb` on
  the file share.
- **Files:** create `apps/fiab-console/app/api/notebook/[id]/execute/route.ts`,
  `.../contents/route.ts`; helper `lib/clients/jupyter-server-client.ts`.
- **Backend/REST:** Jupyter Server REST (`/api/contents`, `/api/sessions`,
  `/api/kernels`) reached through the AML CI authenticated tunnel; execute via
  kernel WebSocket message protocol (`execute_request` → `stream`/`execute_result`/`error`).
- **Bicep/portability:** none new (uses Task 2 RBAC). Gov: same protocol.
- **UI:** none (foundation).
- **Acceptance:** POST a `print(1+1)` cell → response contains real
  `execute_result` `2`; a failing cell returns captured stderr+traceback. Vitest
  integration with a record/replay of the kernel WS.

### TASK 4 — Monaco cell editor + Pylance LSP bridge (feature #4)
- **Goal:** Replace textarea cells with Monaco; full IntelliSense.
- **Files:** edit `apps/fiab-console/lib/editors/notebook-editor.tsx` (use
  `monaco-textarea`), `lib/components/notebook/code-cell.tsx`; create
  `app/api/notebook/[id]/lsp/route.ts` (WebSocket Pylance bridge).
- **Backend/REST:** `jupyter-lsp` / Pylance on the CI over WS; Monaco
  `monaco-languageclient` wired to the bridge.
- **Bicep/portability:** ensure CI image includes `jupyter-lsp` +
  `python-lsp-server`/Pylance (curated AML Env). Gov: browser Monaco+Pylance OK;
  add "Open in VS Code for Web" deep-link **only when not Gov** (feature-flag).
- **UI:** Monaco cells with hover docs, go-to-definition, parameter hints;
  toolbar "Open in VS Code" (Commercial only).
- **Acceptance:** typing `import pandas as pd; pd.read_` shows real Pylance
  member completions sourced from the CI; hover on `pd.DataFrame` shows docstring.
  Playwright trace of completion popup. No textarea remains.

### TASK 5 — Notebook AML path: workspace-type switch, CI selector, auto-start, kernel, datastore explorer, .ipynb import (feature #2)
- **Goal:** Make the notebook fully usable on AML, Fabric path preserved.
- **Files:** edit `apps/fiab-console/lib/editors/notebook-editor.tsx`; create
  `lib/components/notebook/datastore-explorer.tsx`,
  `app/api/aml/datastores/route.ts`.
- **Backend/REST:** Task 2 (computes), Task 3 (contents). Datastore: AML
  `/datastores` + folder listing; Delta schema via `delta-rs` in a small python
  sidecar or `/api/aml/datastores?path=...&delta=1`.
- **Bicep/portability:** none new. Gov uses `.us`.
- **UI:** workspace-type toggle (Azure ML | Fabric); CI selector with
  start/status; New-Notebook wizard (kernel Python 3.10 / R, name);
  Datastore explorer sidebar (drag → insert `abfss://` path); .ipynb upload.
- **Acceptance:** with Fabric unset, create+open a notebook on a real CI, see
  real datastores listed, drag a path in, run a cell. Auto-start kicks a stopped
  CI. Receipt: contents API response + screenshot.

### TASK 6 — Cell types & authoring: `%%pyspark` routing, toolbar, reorder, split/merge (feature #3)
- **Goal:** Full cell authoring UX + Spark routing.
- **Files:** edit `lib/components/notebook/code-cell.tsx`,
  `notebook-editor.tsx`; create `app/api/notebook/[id]/execute-spark/route.ts`.
- **Backend/REST:** Serverless Spark session create+statement REST; Gov path
  attaches Synapse Spark pool (`synapse-spark` Livy statements).
- **Bicep/portability:** add env `LOOM_AML_SPARK` (serverless|synapse) +
  `LOOM_SYNAPSE_SPARK_POOL`; Gov defaults to `synapse`. Document the Gov
  data-wrangling caveat.
- **UI:** cell-type selector (Python | PySpark | SQL | Markdown); `%%pyspark`
  highlight; toolbar Run/Stop/Move/Delete/Convert; @dnd-kit reorder;
  split/merge in Edit menu; collapse/expand.
- **Acceptance:** a `%%pyspark` cell runs a real `spark.range(5).count()` → `5`
  via the Spark endpoint; Python cell runs on CI kernel. Drag reorder persists to
  `.ipynb`. Receipt shows both execution paths.

### TASK 7 — Copilot chat pane (feature #5)
- **Goal:** Persistent context-aware chat drawer with slash commands.
- **Files:** create `lib/components/notebook/copilot-pane.tsx`; edit
  `notebook-editor.tsx`; reuse `app/api/copilot/sessions`.
- **Backend/REST:** Azure OpenAI via existing copilot backend (`resolveAoaiTarget`).
  Context builder sends current cell + prior 5 cells + datastore schema (names +
  column types from Task 5 delta-rs).
- **Bicep/portability:** none new (AOAI already deployed). Gov uses `openai.azure.us`.
- **UI:** right drawer (~25%): history, streaming, input, slash menu
  (`/fix /explain /comments /optimize`); multi-cell responses render as diff with
  "Apply to notebook".
- **Acceptance:** `/optimize` on a real cell returns a streamed Azure OpenAI
  response referencing actual variable names; "Apply" writes cells back. Receipt:
  AOAI response first 300 chars + screenshot.

### TASK 8 — Fix with Copilot (feature #6)
- **Goal:** Inline error remediation.
- **Files:** edit `lib/components/notebook/code-cell.tsx`, `copilot-pane.tsx`;
  extend `app/api/copilot/sessions/route.ts` to accept error context.
- **Backend/REST:** Azure OpenAI; input = stderr + traceback (captured in Task 3)
  + cell code.
- **Bicep/portability:** none.
- **UI:** "Fix with Copilot" button under a failed cell → opens pane prefilled;
  returns a fix as an approve-diff.
- **Acceptance:** force a `NameError`, click Fix, get a real AOAI fix that
  resolves it on re-run. Receipt shows the failing output → applied fix → success.

### TASK 9 — Inline code completion (feature #7)
- **Goal:** Ghost-text autocomplete.
- **Files:** edit `monaco-textarea`/`code-cell.tsx`; create
  `app/api/copilot/complete/route.ts` (if not present extend existing).
- **Backend/REST:** Azure OpenAI completions; debounce 300ms; context = prefix +
  3 prior cells + datastore schema.
- **Bicep/portability:** none. Note Fabric requires F2+/P capacity — Loom path
  is AOAI, no capacity gate.
- **UI:** Monaco `InlineCompletionItemProvider` gray ghost text; Tab accept;
  toolbar toggle.
- **Acceptance:** typing a comment `# read csv into df` yields a real ghost
  suggestion from AOAI; Tab inserts. Playwright trace.

### TASK 10 — In-cell Copilot (feature #8)
- **Goal:** Per-cell prompt popover.
- **Files:** edit `lib/components/notebook/code-cell.tsx`.
- **Backend/REST:** reuse `/api/copilot/complete`.
- **Bicep/portability:** none.
- **UI:** Copilot icon in cell toolbar → popover prompt + slash commands; result
  inserted in cell below.
- **Acceptance:** `/explain` in-cell produces a real markdown explanation cell.
  Receipt + screenshot.

### TASK 11 — Variable Explorer (feature #9)
- **Goal:** Live variable inspection.
- **Files:** create `lib/components/notebook/variables-pane.tsx`; edit
  `notebook-editor.tsx`.
- **Backend/REST:** kernel `%whos` (or comm inspect) via Task 3 execute.
- **Bicep/portability:** none.
- **UI:** "Variables" right-panel tab; sortable Name/Type/Length/Value; repr()
  tooltip; Python-only badge.
- **Acceptance:** define `x=[1,2,3]` then open Variables → real row
  `x | list | 3 | [1, 2, 3]`. Sort works. Screenshot.

### TASK 12 — `display()` rich visualization (feature #10)
- **Goal:** Interactive grid + charts widget.
- **Files:** create `lib/components/notebook/rich-display.tsx`,
  `lib/notebook/ai-display.py` (injected helper); edit cell output hook.
- **Backend/REST:** helper serializes a 5,000-row sample via Jupyter comm;
  full-dataset aggregation triggers a real Spark job (Task 6).
- **Bicep/portability:** include `ai_display` in the curated AML Env startup.
- **UI:** TanStack table (col/row select, summary stats, CSV copy, Inspect pane);
  Vega-Lite charts (≤5, bar/scatter/line/pivot, X/Y/legend/agg, recommendations,
  rename/duplicate/delete/reorder).
- **Acceptance:** `display(df)` on a real Spark/pandas DataFrame renders the grid
  with real column stats and at least one recommended chart; agg-over-all fires a
  Spark job. Screenshot of table + chart.

### TASK 13 — Session config & status (feature #11)
- **Goal:** Spark/CI session control without freeform config.
- **Files:** create `lib/components/notebook/session-config-dialog.tsx`,
  `app/api/notebook/[id]/config/route.ts`; edit status bar in `notebook-editor.tsx`.
- **Backend/REST:** apply `%%configure` before first execute; read session state.
- **Bicep/portability:** none.
- **UI:** "Configure Session" dialog (executor count slider 1–100, memory 1–8 GB,
  timeout minutes); bottom-left status badge (Idle/Running/Error); High-Concurrency
  note.
- **Acceptance:** set executors=2, run a Spark cell, confirm the session report
  reflects 2 executors (real Spark session JSON in receipt). No JSON textarea.

### TASK 14 — Notebook scheduling (feature #12)
- **Goal:** Recurrence scheduling, dropdown-driven.
- **Files:** create `lib/components/notebook/schedule-wizard.tsx`,
  `app/api/notebook/[id]/schedule/route.ts`.
- **Backend/REST:** AML Job schedule create/list/disable (recurrence trigger).
- **Bicep/portability:** Console UAMI needs AML job submit rights (covered by
  Task 2 role). GA Commercial + Gov.
- **UI:** ribbon "Schedule" button → recurrence wizard (frequency/interval/start
  dropdowns, no raw cron); schedule list with enable/disable.
- **Acceptance:** create a daily schedule → real AML schedule resource returned;
  list shows it; disable updates state. Receipt: schedule REST response.

### TASK 15 — Library & Environment management (feature #13)
- **Goal:** Persistent env + inline installs.
- **Files:** create `lib/components/notebook/environment-panel.tsx`,
  `app/api/aml/environments/route.ts`.
- **Backend/REST:** AML Environment list/create/attach (curated + custom conda
  Docker); inline `%pip`/`%conda` run via Task 3.
- **Bicep/portability:** none new.
- **UI:** environment selector in ribbon + "Manage Environment" panel (PyPI/Conda
  package lists, .jar attach, attach-to-notebook).
- **Acceptance:** attach a curated AML Env, list its real packages, `%pip install`
  a package and import it in a cell. Receipt: environment REST + import success.

### TASK 16 — ML Experiment editor (feature #14)
- **Goal:** MLflow tracking surface.
- **Files:** create `apps/fiab-console/lib/editors/ml-experiment-editor.tsx`;
  register in `lib/editors/registry.ts`; create
  `app/api/aml/experiments/route.ts`, `app/api/aml/runs/route.ts`; reuse
  `mlflow-client.ts`.
- **Backend/REST:** MLflow `2.0/mlflow/experiments/search`, `/runs/search`,
  `/runs/get`, artifact list.
- **Bicep/portability:** Commercial/Gov use AML-hosted MLflow; **IL5 → OSS MLflow
  on AKS** (`LOOM_MLFLOW_TRACKING_URI`). Add env var + honest-gate MessageBar when
  unset.
- **UI:** runs table (sortable/filterable params+metrics), run detail (metric step
  charts via Vega-Lite, params, tags, artifacts), compare-runs (parallel coords).
- **Acceptance:** open a real experiment, see real runs with real metrics;
  compare two runs renders overlaid metric chart. Receipt: MLflow search response.

### TASK 17 — ML Model editor extension (feature #15)
- **Goal:** Close any gaps in the existing registry editor.
- **Files:** edit `apps/fiab-console/lib/editors/ml-model-editor.tsx`.
- **Backend/REST:** AML Model Registry; MLflow `model-versions/transition-stage`;
  register-from-run.
- **Bicep/portability:** none new.
- **UI:** ensure stage transitions (None/Staging/Production/Archived),
  register-from-run, lineage-to-run, deploy-to-online-endpoint all present.
- **Acceptance:** transition a real model version Staging→Production via the UI →
  registry reflects the change. Receipt: registry REST response.

### TASK 18 — Data Science Home page + experience switcher (features #1, #16)
- **Goal:** Landing page + nav entry.
- **Files:** create `apps/fiab-console/lib/editors/data-science-home-editor.tsx`,
  `app/api/items/data-science/home/route.ts`,
  `app/experience/data-science/home/page.tsx`; register editor in
  `lib/editors/registry.ts`; add switcher entry in experience config.
- **Backend/REST:** AML `jobs`/`experiments`/`models` REST + MLflow for recents.
- **Bicep/portability:** none new.
- **UI:** Recent notebooks (5), recent experiments (5), recent model
  registrations (5); quick-create buttons → notebook/experiment/model wizards;
  curated "Learning Resources" strip; switcher target "Data Science".
- **Acceptance:** home renders real recent items from a live AML workspace;
  quick-create opens the correct editor; switcher entry navigates here. Screenshot
  + REST receipt.

### TASK 19 — Docs + parity artifact + bicep/teardown verification
- **Goal:** Satisfy `docs_source_of_truth`, `ui-parity`, `no-vaporware` bicep sync.
- **Files:** update `docs/fiab/workloads/data-science.md`; create
  `docs/fiab/parity/data-science-notebook.md` (and per-editor parity rows);
  update `docs/fiab/v3-tenant-bootstrap.md` with new env vars/roles; edit bicep
  modules + `admin-plane/main.bicep`.
- **Acceptance:** `az deployment sub create -f platform/fiab/bicep/main.bicep
  -p params/commercial-full.bicepparam` + bootstrap produces a working Data
  Science experience with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. Parity doc shows
  zero ❌ (every row ✅ or ⚠️ honest-gate).

---

## 5. Claude Code DEV-LOOP per task

Run this 4-agent loop for **every** task above. Do not advance until the gate
passes. Use isolated worktrees per task to avoid the pnpm worktree corruption
gotcha (`rm -rf node_modules && pnpm install` if `tslib` unresolved).

```
┌─ CODING AGENT ────────────────────────────────────────────────┐
│ Input: the task's Goal + Files + Backend/REST + UI spec.        │
│ Do: implement on the AML/Azure-native DEFAULT path. No mocks,   │
│     no `return []`, no `useState(MOCK_DATA)`. Wire BFF → real    │
│     Azure REST / AOAI / MLflow / Jupyter. Honest-gate MessageBar │
│     for missing infra (name the exact env var / role).          │
│ Output: code + a draft real-data receipt.                       │
└───────────────────────────────────────────────────────────────┘
                 │ handoff
                 ▼
┌─ VALIDATION / TEST AGENT ─────────────────────────────────────┐
│ 1. `pnpm -C apps/fiab-console tsc --noEmit`  → 0 errors.         │
│ 2. `pnpm -C apps/fiab-console build`         → next build green. │
│ 3. `pnpm -C apps/fiab-console vitest run <touched specs>`        │
│    (env: jsdom + setupFiles per the known broken-harness note).  │
│ 4. REAL-DATA E2E: mint a session cookie, hit the new endpoint,   │
│    capture first 300 chars of the REAL response; Playwright      │
│    click-through of the surface (every control does its thing).  │
│ Gate: any tsc/build/test/E2E failure → bounce back to CODING.    │
└───────────────────────────────────────────────────────────────┘
                 │ pass
                 ▼
┌─ DOCS AGENT ──────────────────────────────────────────────────┐
│ Update docs/fiab/workloads/data-science.md + the parity doc row  │
│ for this feature (built ✅ / honest-gate ⚠️). Add Learn-grounded  │
│ inventory line. No clarifying-question text in product/docs      │
│ (per no_questions_in_product). Update bootstrap doc if env/role   │
│ added.                                                            │
└───────────────────────────────────────────────────────────────┘
                 │
                 ▼
┌─ UAT AGENT ───────────────────────────────────────────────────┐
│ Run `pnpm uat` deep-functional spec for the surface + a live     │
│ side-by-side against the real Azure ML / AOAI / MLflow UI.       │
│ Confirm one-for-one behavior (DOM strings ≠ parity). Grade the   │
│ surface (target A / A+). If < acceptance → loop to CODING with   │
│ the gap list.                                                     │
└───────────────────────────────────────────────────────────────┘
                 │ A / A+ and acceptance met
                 ▼
        Open PR with the real-data E2E receipt (endpoint, response,
        screenshot/trace, bicep diff). Reviewer rejects if absent.
```

**Iteration rule:** the loop repeats CODING→TEST until tsc+build+vitest+E2E all
pass, then DOCS, then UAT; any UAT gap restarts at CODING. A task is *done* only
when its acceptance criteria pass on the **Azure-native default path with
`LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET**.

---

## 6. Definition of done (whole experience)

The Data Science experience is **done** when **all** hold:

1. **Every parity row (Section 2) is ✅ built or ⚠️ honest-gate — zero 🔴, zero
   🟡, zero stub banners.** Each honest-gate names the exact env var / role /
   resource and still renders the full UI surface.
2. **Azure-native default works with Fabric unset.** A teardown + 1-button
   redeploy into a clean sub (`az deployment sub create … commercial-full` +
   bootstrap) yields: home page with real recents, a runnable notebook on a real
   Compute Instance, Spark cells executing, Copilot (chat/inline/in-cell/fix)
   returning real Azure OpenAI output, Variables pane, `display()` viz,
   scheduling, environments, ML Experiment + ML Model editors — all on real
   Azure/MLflow REST. No `onelake.dfs.fabric` / `api.fabric.microsoft.com` /
   `api.powerbi.com` on the default path.
3. **Four-cloud portability verified:** Commercial GA; Gov uses `.us` endpoints
   with VS Code link suppressed and Spark via attached Synapse pool; IL5 path
   documented (US Gov regions, CMK storage, OSS MLflow-on-AKS option) and the
   honest-gates for batch/VS-Code/serverless-Spark Gov limitations are present.
4. **Bicep sync complete:** every new resource, env var (`LOOM_AML_*`,
   `LOOM_AML_SPARK`, `LOOM_SYNAPSE_SPARK_POOL`, `LOOM_MLFLOW_TRACKING_URI`), and
   role assignment (AML Compute Operator / job submit, Storage data access) is in
   `platform/fiab/bicep/**` + `admin-plane/main.bicep` + the bootstrap workflow,
   with drift = a violation.
5. **No-vaporware grep clean** on this experience's code:
   `grep -rE "(return \[\]|return \{\}|useState\(\[\{|MOCK_|SAMPLE_)"` over the
   new editors/api returns no real hits; every `fabricWorkspaceId` read has an
   Azure fallback in the same function.
6. **Parity doc + receipts:** `docs/fiab/parity/data-science-notebook.md` (and
   sibling rows) show the full Azure/Fabric inventory mapped 1:1 with a backend
   per control; every merged PR carries its real-data E2E receipt.
7. **UAT green:** `pnpm uat` deep-functional spec passes and a live side-by-side
   against Azure ML Studio + the Fabric Data Science UI confirms feature-for-
   feature usable parity (every control clicked, same outcome). Target grade
   A / A+ on every surface.

---

_Last updated: 2026-06-06._
