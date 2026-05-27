# Loom Evaluation Editor — AI Foundry parity spec

> Captured 2026-05-26 by catalog agent `fabric-parity-loop`. Sources: Microsoft Learn — [Observability in generative AI](https://learn.microsoft.com/azure/ai-foundry/concepts/observability), [Built-in evaluators reference](https://learn.microsoft.com/azure/foundry/concepts/built-in-evaluators), [Evaluate a custom chat application with the Foundry SDK](https://learn.microsoft.com/azure/foundry-classic/tutorials/copilot-sdk-evaluate), [Run an evaluation in Azure DevOps](https://learn.microsoft.com/azure/foundry/how-to/evaluation-azure-devops), [Evaluation in Agent Framework](https://learn.microsoft.com/agent-framework/agents/evaluation). Cross-checked against `apps/fiab-console/lib/editors/foundry-sub-editors.tsx::EvaluationEditor` (lines 286–373) and BFF routes `app/api/items/evaluation/route.ts` + `[id]/route.ts`.

## What it is

An AI Foundry **Evaluation** is a batch judgment run that scores the outputs of an AI app (or a base model endpoint, or a prompt flow run) against a set of **evaluators**. Each evaluator is an LLM-as-judge or rules-based scorer that produces a per-row score plus an aggregate metric. Evaluations are first-class workspace items with their own list, detail, and comparison views in the Foundry portal.

Three usage modes:
- **Bring your own data**: upload / register a dataset (JSONL with `query`, `response`, optional `context`, `ground_truth`, `tool_calls`) and pick evaluators
- **Simulators + AI red teaming**: generate adversarial or context-appropriate test data on the fly with the Azure AI Evaluation SDK's simulators
- **Continuous evaluation**: sample production traffic from an Application Insights connection and score it on a schedule

The same Evaluation item underpins the **Foundry portal evaluation wizard**, the **azure-ai-evaluation** Python SDK, the **Microsoft.Agents.AI.AzureAI** `FoundryEvals` class, and the **AIAgentEvaluation@2** Azure DevOps task.

## UI components

### Page chrome
- Title bar: evaluation display name (editable), status badge (Queued / Running / Completed / Failed), saved-state indicator
- Right-side actions: **+ New evaluation**, **Compare**, **Refresh**, **Share**, **Delete**

### Evaluations list (default)
- Tabular grid: one row per evaluation
- Default columns: **Name**, **Status**, **Created by**, **Created date**, **Duration**, **# rows**, **Dataset**, **Target** (flow / endpoint / model deployment), per-evaluator score columns (only those bound to this run)
- Multi-select feeds the **Compare** view; row click opens **Results detail**
- Filter chips: status, time range, evaluator subset, target

### New evaluation wizard
- **Step 1 — What to evaluate**: pick *Model* (an Azure OpenAI / Foundry deployment), *Prompt flow* (a flow + variant), *Dataset only* (score pre-computed responses), or *Agent* (registered agent ID)
- **Step 2 — Test data**:
  - Choose dataset source: registered Dataset, upload JSONL, blob path (`azureml://datastores/.../paths/...`), or **Generate with simulator** (context-appropriate / adversarial / AI red teaming)
  - Map dataset columns to evaluator inputs (`query`, `response`, `context`, `ground_truth`, `tool_calls`)
- **Step 3 — Evaluators**: multi-select grid grouped by category — see "Built-in evaluators" below; each evaluator has a parameter form (model deployment for LLM-as-judge, threshold for safety, custom prompt for `custom_evaluators`)
- **Step 4 — Connection & compute**: pick the AI judge model deployment (default `gpt-4o` family) and the runtime
- **Step 5 — Review + submit**

### Results detail view
- Header: name, status, runtime, evaluator list, dataset, target, "Open in Application Insights" link
- **Metrics summary** strip: aggregate score per evaluator (mean + pass-rate when a threshold is set), color-coded
- **Per-row results table**: every dataset row × every evaluator column, with the raw score, the judge's reasoning ("Why this score?"), and the original prompt / response / context inline; click any cell for the full trace
- **Failures & defects** tab: rows below threshold or flagged unsafe, grouped by evaluator
- **Trends** tab: when this evaluation is part of a scheduled / repeating run, line chart of metric over time

### Comparison view (multi-select from list)
- Side-by-side metric bars per evaluator across selected runs
- "Diff dataset" check (warns if rows changed between runs)
- Statistical significance badge per metric (uses confidence intervals from `dataset.json`-style runs)

### Built-in evaluators (categorical grid)
| Category | Evaluators |
|---|---|
| **RAG** | Retrieval, Document Retrieval, Groundedness, Groundedness Pro, Relevance, Response Completeness |
| **Agents** | Intent Resolution, Task Adherence, Task Completion, Task Navigation Efficiency, Tool Call Accuracy, Tool Selection, Tool Input Accuracy, Tool Output Utilization, Tool Call Success |
| **General purpose** | Coherence, Fluency, QA, Similarity |
| **Safety & security** | Hate / Unfairness, Violence, Sexual, Self-Harm, Protected Materials, Code Vulnerability, Indirect Attack |
| **Textual** | F1 Score, ROUGE, BLEU, METEOR, GLEU, Exact Match |
| **OpenAI graders** | Label Model, Score Model, Text Similarity, String Check |
| **Custom** | Custom prompt-based evaluator (LLM-as-judge with user-supplied system prompt), Custom code evaluator (Python class) |

### Continuous evaluation / Monitor
- "Run continuously" toggle in the wizard: samples production traffic from the project's Application Insights at a chosen rate and runs the evaluator suite on a schedule; results land back in the same item with a `scheduled` source tag

## What Loom has

Current `EvaluationEditor` (`apps/fiab-console/lib/editors/foundry-sub-editors.tsx` lines 286–373) is real-REST wired to the AML data plane via `lib/azure/foundry-client.ts::listEvaluations / getEvaluation / createEvaluation / getEvaluationResults` and BFF routes `GET|POST /api/items/evaluation` and `GET /api/items/evaluation/[id]?results=1`.

- Project picker → lists evaluations
- Evaluations table columns: **Name**, **Status**, **Dataset**, **Created**, action **Open**
- **New evaluation** form (single card, not a wizard): Display name, Dataset ID, Model deployment, Evaluators (comma-separated string)
- Submit calls `POST /api/items/evaluation` → wraps `createEvaluation`
- Selected evaluation card shows display name, status, and a flat **Metric → Value** table from `evaluation.metrics`
- Errors / not-deployed surfaced honestly via `ErrorBar`

That is: Loom can list, create, and inspect aggregate metrics, but it has no wizard, no evaluator grid / categorisation, no per-row results, no comparison, no failures tab, no simulator integration, and no continuous-evaluation toggle.

## Gaps for parity

1. **Evaluator selection UI** — today's `evaluators` is a comma-separated text input. Foundry has a categorised grid (RAG / Agents / Quality / Safety / Textual / OpenAI graders / Custom) with descriptions and per-evaluator parameter forms.
2. **Wizard flow** — Loom is a flat form; Foundry is a 5-step wizard (What → Data → Evaluators → Connection → Review). Needed because the field set varies sharply by what's being evaluated.
3. **Target type selection** — Loom only supports `modelDeployment`; cannot target a *flow + variant*, a registered *agent*, or *dataset-only* (score pre-computed responses).
4. **Per-row results table** — `getEvaluationResults` exists in the client and the BFF returns `results`, but the editor doesn't render them. This is the highest-value missing surface.
5. **Failure / defect drill-down** — no view of rows below threshold or flagged unsafe.
6. **Comparison view** — no multi-select → side-by-side metric bars across runs.
7. **Simulator integration** — no UI for *Generate with simulator*; the Azure AI Evaluation SDK's adversarial / context-appropriate simulators aren't exposed.
8. **Dataset column mapping** — Foundry lets the user map dataset columns (`q`, `a`, `ctx`) to evaluator inputs (`query`, `response`, `context`); Loom assumes the dataset is already shaped.
9. **AI judge model picker** — no UI to choose the LLM-as-judge deployment; Foundry defaults to `gpt-4o` but allows override per evaluator.
10. **Custom evaluator authoring** — no UI for writing a custom prompt-based or code-based evaluator.
11. **Continuous evaluation toggle** — no scheduled / sampled production-traffic option.
12. **Trends chart** — single run only; no time-series view across scheduled runs.

## Backend mapping

Same AML data-plane base as Prompt Flow; evaluations live under `{project}/evaluations`.

| Loom surface | Backend call |
|---|---|
| List evaluations | `GET .../evaluations?pageSize=50` (wired via `listEvaluations`) |
| Get evaluation | `GET .../evaluations/{id}` (wired via `getEvaluation`) |
| Get per-row results | `GET .../evaluations/{id}/results` (wired via `getEvaluationResults`, but UI unrendered) |
| Create evaluation | `POST .../evaluations` with `{ displayName, datasetId, modelDeployment?, evaluatorIds[] }` (wired via `createEvaluation`) |
| List available evaluators | `GET .../evaluators` (new helper required — currently the editor hard-codes the choice as a string) |
| List datasets in project | `GET .../datasets` (already partially wired by `DatasetEditor`) |
| Submit simulator job | `POST .../simulators/{kind}` where `kind` ∈ `adversarial` / `context-appropriate` / `red-teaming` |
| Continuous evaluation rule | `PUT .../evaluations/{id}/schedule` with cron + sampling rate + App Insights connection |
| Trends | `GET .../evaluations/{id}/history?from=...&to=...` |
| AI judge deployments | `GET .../deployments` filtered to chat-completions-capable models |

New helpers required in `foundry-client.ts`: `listEvaluators`, `getEvaluatorParameters`, `submitSimulatorRun`, `setEvaluationSchedule`, `getEvaluationHistory`.

## Required Azure resources

- **AI Foundry hub + project** (already provisioned as `aifoundry-csa-loom-eastus2`); UAMI needs **AzureML Data Scientist** + **Cognitive Services User** on the project
- **Azure OpenAI connection** in the project with a chat-completion deployment (default `gpt-4o`) — required as the LLM-as-judge for `groundedness`, `relevance`, `coherence`, `fluency`, `similarity`, `intent_resolution`, `task_adherence`, `tool_call_accuracy`
- **Storage** — the workspace's attached storage; datasets and result files materialize as Parquet / JSONL under `azureml://datastores/workspaceblobstore/paths/evaluations/<id>/`
- **Application Insights** — required when `Run continuously` is enabled (sampled production traffic source)
- **Compute** — automatic runtime / serverless compute session in the project
- **For safety evaluators**: the project must have a bound Azure AI Content Safety resource (or it falls back to the workspace-level default). Surface honestly with `MessageBar intent="warning"` when missing.

`MessageBar intent="warning"` triggers: project not selected, project has no AOAI connection, no chat-completion deployment present, Content Safety not bound when a safety evaluator is selected.

## Estimated effort

**3 sessions** to reach grade B:

- **Session N+1 (~2 hrs):** Replace comma-separated evaluators with a categorised grid (RAG / Agents / Quality / Safety / Textual). Add target-type radio (Model / Flow / Agent / Dataset). Render `evaluation.results` as a per-row table when present.
- **Session N+2 (~2.5 hrs):** Wizard chrome (5 steps), dataset column-mapping step, AI judge model picker, per-evaluator parameter forms (threshold for safety, model for LLM-as-judge). Failures tab.
- **Session N+3 (~2.5 hrs):** Comparison view (multi-select → side-by-side metric bars). Simulator wizard branch (context-appropriate / adversarial / red teaming). Continuous-evaluation toggle wired to `setEvaluationSchedule`. Trends chart.

Grade A+ adds Vitest unit coverage on the dataset column-mapping reducer, a Playwright walk against a seeded evaluation with 4 evaluators (groundedness, relevance, fluency, hate), and bicep additions binding a Content Safety resource to the hub for the safety evaluators to be live without a separate provisioning step.
