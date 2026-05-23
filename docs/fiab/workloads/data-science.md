# Data Science parity

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

Loom Console "Models" pane lists registered models, versions, and
stages. Backed by MLflow REST API.

### SynapseML

Available in Databricks notebooks via PyPI install — no SynapseML SaaS
feature gap.

### AI Functions library

Custom Python library `apps/fiab-ai-functions/` packaging the same
DataFrame-level APIs Fabric exposes:

```python
from fiab_ai_functions import sentiment, summarize, classify, translate, embed

# Same call shape as Fabric's AI Functions
df_with_sentiment = df.transform(sentiment("review_text"))
```

Each function wraps an AOAI call. Available as PyPI install in any
Databricks notebook. Configured via the Console "Admin → AI Settings"
pane (endpoint, model deployment, TPM allocation).

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

Loom Console "Endpoints" pane surfaces both deployment paths.

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
