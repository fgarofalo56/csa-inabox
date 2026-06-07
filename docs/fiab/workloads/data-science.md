# Data Science parity

!!! note "Shipped reality (2026-06-07)"
    The shipped data-science surfaces are the **`ml-model`** editor (Azure ML
    model registry + online endpoints), the **`ml-experiment`** editor (job/run
    list + MLflow experiment tracking with per-step metric history),
    **`prompt-flow`**, the **AI Foundry** agents/evals editors, and the **AI
    Functions HTTP surface** (`POST /api/ai-functions`) documented below — all on
    real Azure REST / Azure OpenAI / AML MLflow, with **no Microsoft Fabric or
    Power BI workspace required** (`LOOM_DEFAULT_FABRIC_WORKSPACE` stays unset on
    the default path). There is no `fiab-ai-functions` PyPI library. The
    feature-by-feature comparison artifact is
    [parity/data-science-notebook.md](../parity/data-science-notebook.md) — zero
    ❌, zero stub rows. The standalone "Models pane" / "Endpoints pane" mentions
    in this doc are **forward roadmap** beyond the `ml-model` editor.

## What Fabric does

Fabric Data Science = Notebook + ML Model + ML Experiment + ML Job
item types. MLflow fully integrated (experiment tracking, model
registry). SynapseML preinstalled. AI Functions library exposes
GPT-class operations as Spark DataFrame functions. Semantic Link +
semantic-link-labs let notebooks read/write Power BI semantic models
programmatically. "Prep for AI" is a semantic-model-authoring UI for
encoding AI instructions, verified answers, and schema annotations
consumed by Data Agents.

## CSA Loom parity design

### Notebooks

Covered in [Data Engineering parity](data-engineering.md) — Databricks
notebooks via Loom Console Notebook pane.

### MLflow + Model Registry

| Boundary | Implementation |
|---|---|
| Commercial / GCC | Databricks-managed MLflow (once UC managed Gov-GAs in v1.1) — registry, experiment tracking, model serving |
| GCC-High / IL4 / IL5 | **OSS MLflow on AKS** (`mlflow server` container with Postgres backend + ADLS Gen2 artifact store) |

_Roadmap:_ a Loom Console "Models" pane (registered models, versions, and
stages, backed by the MLflow REST API) is planned but not yet surfaced. Today,
model registration/listing is done from the `ml-model` editor (Azure ML
registry) or the notebook's MLflow client directly.

### ML Experiment (MLflow tracking)

The **`ml-experiment`** editor is the shipped MLflow experiment-tracking surface
(Fabric ML Experiment / Azure ML Studio → Jobs + Experiments parity). It runs on
**real Azure ML REST**, no Fabric workspace:

- **Experiment / run list** — `GET /api/items/ml-experiment` →
  `foundry-client.ts listJobs()` (`Microsoft.MachineLearningServices/workspaces/{ws}/jobs`),
  rolled up by `experimentName`.
- **Runs & metrics tab** — `GET /api/items/ml-experiment/[id]/runs` →
  `mlflow-client.ts searchRuns()` and `.../runs/[runId]/metrics` →
  `getMetricHistory()` against AML's MLflow-compatible tracking server
  (`https://{region}.api.azureml.ms/mlflow/v1.0/.../workspaces/{ws}/api/2.0/mlflow/*`).
- **Submit / register** — `POST /api/items/ml-experiment/submit` and
  `.../[id]/register`.

The MLflow workspace resolves from `LOOM_AML_WORKSPACE` / `LOOM_AML_REGION`,
falling back to the AI Foundry hub (`LOOM_FOUNDRY_NAME` / `LOOM_FOUNDRY_REGION`)
— itself an `Microsoft.MachineLearningServices/workspaces`, so experiment
tracking works out of the box on the default deploy. When neither resolves, the
tab honest-gates with a `MlflowNotConfiguredError` MessageBar naming the env vars
+ the **AzureML Data Scientist** role.

### SynapseML

Available in Databricks notebooks via PyPI install — no SynapseML SaaS
feature gap.

### AI Functions (HTTP)

Loom's parity for Fabric's AI Functions is a **real Azure-native HTTP surface**,
not a PyPI library. It runs GPT-class text operations against the same live
Azure OpenAI deployment the cross-item Copilot and data-agent test-chat resolve
(`resolveAoaiTarget`). No Microsoft Fabric / Power BI dependency — pure AOAI.

**Endpoint**

```
POST /api/ai-functions
Content-Type: application/json

{ "fn": "summarize", "input": "<text>", "options": { /* optional */ } }
```

**Response**

```json
{ "ok": true, "result": "<model output>", "model": "gpt-4o-mini",
  "usage": { "promptTokens": 120, "completionTokens": 30, "totalTokens": 150 } }
```

**Functions (`fn`)**

| `fn` | Does | Useful `options` |
|---|---|---|
| `summarize` | Concise 2-3 sentence summary of `input` | — |
| `classify` | Returns exactly one label for `input` | `labels: string[]` (candidate labels) |
| `sentiment` | Returns `positive` / `negative` / `neutral` | — |
| `extract` | Returns a JSON object of named fields | `fields: string[]` (field names) |
| `translate` | Translates `input` to a target language | `targetLang: string` (e.g. `"Spanish"`) |

All functions also accept `options.maxTokens` (default 800).

**Honest gate.** When no AOAI model is deployed (fresh deployment, no Foundry
connection registered), the endpoint returns HTTP `501`:

```json
{ "ok": false, "code": "not_configured",
  "error": "No AOAI deployment on Foundry hub. Deploy a gpt-4 / gpt-4o model first.",
  "hint": "Deploy a chat model (e.g. gpt-4o-mini) from the AI Foundry hub …",
  "missing": "LOOM_AOAI_DEPLOYMENT" }
```

To enable it, deploy a chat model from the AI Foundry hub (or set
`LOOM_AOAI_ENDPOINT` + `LOOM_AOAI_DEPLOYMENT`). These are the same env vars
every AOAI-backed Loom route already uses — no new infra. On the **full
commercial push-button deploy**, `param agentFoundryEnabled = true` in
`commercial-full.bicepparam` provisions the dedicated AIServices account
(`aifndry-loom-<region>`) with a `chat` (gpt-4.1-mini) deployment and wires
`LOOM_AOAI_*` automatically, so AI Functions returns real completions on a clean
deploy — the 501 gate only fires when `agentFoundryEnabled` is off and no AOAI
model is connected.

**Notebook helper.** Call the surface from any Databricks / Azure ML notebook
with a session cookie (the same auth the Console UI uses). Copy-paste:

```python
import os, requests

LOOM_BASE = os.environ.get("LOOM_CONSOLE_URL", "https://<your-loom-console>")
SESSION_COOKIE = os.environ["LOOM_SESSION_COOKIE"]  # minted Loom session cookie

def ai_fn(fn: str, text: str, **options) -> str:
    """Call Loom's AI Functions surface. fn ∈ summarize|classify|sentiment|extract|translate."""
    resp = requests.post(
        f"{LOOM_BASE}/api/ai-functions",
        json={"fn": fn, "input": text, "options": options},
        headers={"Cookie": SESSION_COOKIE},
        timeout=60,
    )
    body = resp.json()
    if not body.get("ok"):
        raise RuntimeError(f"{body.get('code', 'error')}: {body.get('error')} ({body.get('hint', '')})")
    return body["result"]

# Examples
ai_fn("sentiment", "The onboarding flow was frustrating.")           # -> "negative"
ai_fn("classify", "My card was declined", labels=["billing", "auth", "bug"])
ai_fn("extract", "Invoice #42 for Acme, $1,200", fields=["invoice_no", "customer", "amount"])
ai_fn("translate", "Good morning", targetLang="French")
```

To apply a function across a Spark DataFrame column, wrap `ai_fn` in a UDF
(batch-aware) — the call shape stays identical; only the deployment lives in
Azure, not in a bundled library.

### Semantic Link parity

[`semantic-link-labs`](https://github.com/microsoft/semantic-link-labs)
(open-source, Microsoft-maintained) reads Power BI semantic models
via XMLA endpoint. Works against Power BI Premium directly without a
Fabric-specific dependency. Documented in
[Tutorial 03 — Direct Lake parity](../tutorials/03-direct-lake-parity.md).

### "Prep for AI" parity

Per-table + per-column annotations stored in Cosmos DB and surfaced
by Loom Console's Semantic Model designer. Loom Data Agents reads
these annotations as part of the system-prompt grounding.

### Model Serving

| Boundary | Implementation |
|---|---|
| Commercial / GCC (post UC managed Gov-GA) | Databricks Model Serving |
| GCC-High / IL4 / IL5 | **Azure ML managed online endpoints** OR **AKS-hosted MLflow serving** with custom inference image |

_Roadmap:_ a Loom Console "Endpoints" pane surfacing both deployment paths is
planned but not yet shipped. Today, online endpoints are managed from the
`ml-model` editor (Azure ML managed online endpoints) on real Azure REST.

### Vector Search

| Boundary | Implementation |
|---|---|
| Commercial / GCC (post UC managed Gov-GA) | Databricks Vector Search |
| GCC-High / IL4 / IL5 | **Azure AI Search** vector + integrated vectorization (authorized through IL6 per `research/02-gov-boundary-availability.md §7.9`) |

## Per-boundary behavior

| Boundary | Managed MLflow | Vector Search | Model Serving |
|---|---|---|---|
| Commercial | ✅ Databricks (when UC GA) | ✅ Databricks | ✅ Databricks |
| GCC | ✅ Databricks (when UC GA) | ✅ Databricks | ✅ Databricks |
| GCC-High / IL4 | ❌ OSS on AKS | ❌ Azure AI Search | ❌ Azure ML / AKS |
| IL5 (v1.1) | ❌ OSS on AKS | ❌ Azure AI Search | ❌ Azure ML / AKS |

## Honest gaps

- Databricks Vector Search and Model Serving aren't in Gov today;
  Azure AI Search + Azure ML are the substitutions
- AI Foundry portal isn't at IL4/IL5; use classic Azure ML Hub
  (`Microsoft.MachineLearningServices/workspaces`) in Gov
- **MLflow tracking host in sovereign clouds** — `mlflow-client.ts` builds the
  tracking base as `https://{region}.api.azureml.ms/...`. The GCC-High / DoD
  equivalent suffix (`.api.azureml.us`) is not yet parameterized; the
  `ml-experiment` "Runs & metrics" tab honest-gates in GCC-High / IL5 until a
  `LOOM_AML_HOST_SUFFIX` env var is introduced (tracked). Commercial + GCC are
  unaffected.

## Bicep sync

Per `.claude/rules/no-vaporware.md`, every surface here deploys from scratch via
`platform/fiab/bicep/main.bicep` + `params/commercial-full.bicepparam`:

| Surface | What bicep provisions / wires | Module |
|---|---|---|
| `ml-model` + `ml-experiment` RBAC | Console UAMI **AzureML Data Scientist** on the Foundry hub workspace (`hubConsoleDataScientist`) — without this the editors 403 on a clean deploy | `modules/admin-plane/ai-foundry.bicep` |
| AI Functions AOAI model | `agentFoundryEnabled = true` → dedicated AIServices account + `chat` deployment + `LOOM_AOAI_*` env vars | `modules/ai/foundry-project.bicep` (threaded via `main.bicep` → `admin-plane/main.bicep`) |
| MLflow tracking target | `LOOM_AML_WORKSPACE` / `LOOM_AML_RG` env vars (fall back to `LOOM_FOUNDRY_NAME` / `LOOM_FOUNDRY_RG`) | `modules/admin-plane/main.bicep` (`loomAmlWorkspace` / `loomAmlRg`) |

BYO Foundry hub and deploy-planner ML-workspace (`mlWorkspaceEnabled`) paths need
two post-deploy steps — see
[v3-tenant-bootstrap §AzureML Data Scientist](../v3-tenant-bootstrap.md#aml-data-scientist)
and [§ML workspace env patch](../v3-tenant-bootstrap.md#aml-workspace-env-patch).

## Forward migration

- MLflow experiments + models export via mlflow's portable JSON format
  → Fabric MLflow
- Notebooks via Git
- Vector indexes via re-embed (no zero-copy path; Vector embeddings
  are model-specific)

## Related

- ADR: [fiab-0002 Hybrid compute](../adr/0002-compute-hybrid.md)
- Build PRP: PRP-03 (Console Models pane), PRP-09 (Data Agents
  extension)
- Parent: [Azure AI Foundry Guide](../../guides/azure-ai-foundry.md)
