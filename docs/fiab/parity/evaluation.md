# evaluation — parity with Azure AI Foundry evaluation

Source UI: Microsoft Foundry portal → Evaluation
(https://ai.azure.com → project → Evaluation)
(https://learn.microsoft.com/azure/ai-foundry/concepts/observability,
https://learn.microsoft.com/azure/foundry/how-to/evaluate-generative-ai-app,
https://learn.microsoft.com/azure/ai-foundry/concepts/evaluation-evaluators/rag-evaluators).

Azure-native backend (no Fabric): **Azure AI Foundry evaluation service** scoped
to a Foundry project, via the Foundry data-plane REST (`foundry-client`
`listEvaluations` / `createEvaluation` / evaluation detail + results). The
Foundry project + a model deployment (LLM judge) are the only requirement — a
Fabric workspace is never involved.

## Foundry evaluation inventory (grounded in Learn)

1. **Project scope** — evaluations live under a Foundry project; pick the
   project.
2. **List evaluations** — name, status (In Progress / Completed / Partial /
   Failed), dataset, created date.
3. **Create an evaluation** — choose a dataset (data source), optional model
   deployment (LLM-as-judge), and a set of evaluators.
4. **Evaluators** — Quality/RAG (groundedness, relevance, fluency, coherence,
   similarity, retrieval, response completeness, QA); Agent (intent resolution,
   task adherence, tool call accuracy); Safety (violence, sexual, self-harm,
   hate/unfairness); custom evaluators.
5. **Results** — metric tables (1–5 or 0–4 scores, pass/fail vs threshold),
   per-row detail, side-by-side run comparison in the portal.

## Loom coverage

| Foundry evaluation capability | Loom coverage | Backend (real REST) |
| --- | --- | --- |
| **Project picker** | ✅ built — `ProjectPicker` | Foundry project list |
| **List evaluations** (name/status/dataset/created) | ✅ built — table with Open action | `GET /api/items/evaluation?project=` → `listEvaluations` |
| **Create evaluation** — display name, dataset ID, model deployment, evaluators | ✅ built — New evaluation form; evaluators comma-list (e.g. groundedness, relevance, fluency) | `POST /api/items/evaluation` → `createEvaluation` |
| Open evaluation detail | ✅ built — selected → detail card | `GET /api/items/evaluation/[id]?project=&results=1` |
| **Metric results table** (metric → value) | ✅ built — detail card renders `evaluation.metrics` | evaluation detail + results |
| Status surface (In Progress / Completed / …) | ✅ built — status column + detail | evaluation object |
| Bundle-installed evaluation (opens from stamped metric definitions without a bound project) | ✅ built — detail route requested even with no project | route |
| Upload / reference an evaluation dataset file | ✅ built — evaluation files route | `/api/foundry/evaluations/files` |
| Deep-link to Foundry portal evaluations | ✅ built — ribbon → `ai.azure.com/projects/{p}/evaluations` | n/a |
| Side-by-side run comparison + rich per-row drill | ⚠️ honest-gate — surfaced via the Foundry portal deep-link; Loom shows the metric table + status in-editor | portal |
| Foundry project / model deployment not provisioned | ⚠️ honest-gate — 503 `NotDeployed` → `ErrorBar`/MessageBar names the missing project/env var; "Pick a project first" guidance | n/a |

Zero ❌ for the list / create / results core surface. Metrics render from the
real evaluation object — no fabricated scores (per `no-vaporware.md`).

## Backend per control

- List: `GET /api/items/evaluation?project=<name>` → `foundry-client.listEvaluations`.
- Create: `POST /api/items/evaluation` `{project, displayName, datasetId, modelDeployment?, evaluatorIds[]}` → `createEvaluation`.
- Detail + results: `GET /api/items/evaluation/[id]?project=&results=1`.
- Evaluation dataset files: `GET/POST /api/foundry/evaluations/files`; project-level list `/api/foundry/evaluations`.
- Honest gate: `NotDeployedError` → 503 `{ok:false, hint, notDeployed:true}`.
