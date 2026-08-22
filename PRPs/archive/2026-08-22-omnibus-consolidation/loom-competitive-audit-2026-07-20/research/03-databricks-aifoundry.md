# Competitive Audit — CSA Loom vs. Databricks + Azure AI Foundry

**Cluster 03 · Databricks (Data Intelligence Platform) + Azure AI Foundry (Microsoft Foundry)**
**Date:** 2026-07-20 · **Repo:** `E:\Repos\GitHub\csa-inabox` · **Grader bar:** as-good-or-better (operator standard)

Loom is a Next.js data/AI platform on **Azure-native + OSS backends** (`.claude/rules/no-fabric-dependency.md`).
Databricks and Azure AI Foundry are the two products this cluster benchmarks Loom against: Databricks for the
lakehouse + governance + ML platform, Azure AI Foundry for the model-catalog + agent + eval/observability platform.

---

## 1. Capability inventory of the real products (current, 2026)

### 1a. Databricks — Data Intelligence Platform

| Area | Capability (2026) |
|---|---|
| **Unity Catalog** | Unified governance/metastore for tables, volumes, ML models, functions; 3-level namespace; **ABAC** (attribute-based access, row-filter/column-mask policies), governed tags, lineage + system tables, Lakehouse Federation connections, Delta Sharing, workspace bindings, clean rooms, quality monitors, metric views (semantic layer), Iceberg interop. |
| **Delta Lake** | ACID storage format; time travel, `MERGE`, liquid clustering, deletion vectors, predictive optimization. |
| **Lakeflow** (was DLT + Jobs) | **Lakeflow Connect** (managed ingest connectors), **Lakeflow Declarative Pipelines** (formerly Delta Live Tables — streaming tables / materialized views / expectations), **Lakeflow Jobs** (multi-task orchestration, retries, DAG). |
| **Databricks SQL** | Serverless + classic SQL warehouses, Photon, query history, alerts, query federation. |
| **AI/BI** | **AI/BI Dashboards** (AI-authored viz, forecasting, key-driver analysis) + **Genie** (NL-to-SQL conversational analytics over governed data, Genie Spaces, auto-generated agents, native mobile). |
| **Mosaic AI** | Model training + AutoML, **fine-tuning / model training (FT + continued pretraining)**, **Model Serving** (real-time + batch + provisioned throughput for foundation models), **AI Gateway**, **Agent Framework + Agent Evaluation**, **AI Functions** (`ai_query`, `ai_classify`, `ai_gen`, etc. in SQL). |
| **Vector Search** | Managed vector index (Delta-synced, governed by UC), hybrid query, rerankers — "Databricks AI Search". |
| **Feature Store / Feature Engineering** | UC-governed feature tables, **online tables** (low-latency serving), point-in-time lookups, automatic feature lookup at serving. |
| **MLflow** | Experiments, run tracking, model registry (UC-backed), evaluation, `mlflow.evaluate`, LLM-as-judge, tracing (MLflow 3 GenAI). |
| **Databricks Apps** | Managed hosting for Streamlit/Dash/Gradio/Flask data apps with UC auth. |
| **Marketplace + Delta Sharing** | Open cross-org data/model/notebook sharing; provider/recipient model. |
| **Clean Rooms** | Privacy-safe multi-party collaboration on shared data without copying. |

Sources: [What is Databricks](https://docs.databricks.com/aws/en/introduction), [Unity Catalog](https://docs.databricks.com/aws/en/data-governance/unity-catalog/), [Genie](https://docs.databricks.com/aws/en/genie/), [Databricks AI Search](https://docs.databricks.com/aws/en/ai-search/ai-search), [Lakeflow / data engineering](https://docs.databricks.com/aws/en/data-engineering/), [AI/BI](https://docs.databricks.com/aws/en/ai-bi/).

### 1b. Azure AI Foundry (Microsoft Foundry)

| Area | Capability (2026) |
|---|---|
| **Model catalog** | 1,900+ models (OpenAI, DeepSeek, Meta/Llama, Hugging Face, Mistral, industry/domain); "sold by Azure" vs partner/community; side-by-side compare; serverless + managed-compute deployments; **fungible provisioned throughput**. |
| **Foundry Agent Service** | Prompt agents + Hosted agents over the **Responses API**; Agent Runtime; built-in tools (web search, file search, memory, code interpreter, **MCP servers**, custom functions); OBO auth; **multi-agent / connected agents**; publish to Teams / M365 Copilot / Entra Agent Registry; **agent optimizer (FAOS)**. |
| **Prompt flow** (classic) | Visual LLM+tool graph, variants, built-in eval — *retiring 2027-04-20, migrate to Microsoft Agent Framework*. |
| **Evaluations** | Built-in evaluators (coherence/fluency; RAG groundedness/relevance; safety hate/violence/self-harm/protected-material; agent tool-call-accuracy/task-adherence); custom evaluators; cloud + local eval; agent-target + trace evaluation; cluster analysis. |
| **Observability** | OpenTelemetry tracing (LangChain/LangGraph/OpenAI Agents SDK/MAF), Azure Monitor App Insights dashboards, continuous eval, alerts. |
| **Content Safety** | Text + image moderation (hate/violence/sexual/self-harm), prompt shields, groundedness detection, severity thresholds. |
| **Fine-tuning** | Serverless + managed-compute FT; safety eval of training data + resulting model. |
| **Connections** | Typed connections to AOAI, AI Search, storage, own endpoints; hub/project inheritance. |
| **RAG / AI Search** | Vector indexes, hybrid (vector+BM25+semantic-ranker) grounding for agents. |
| **AI Search** | First-class RAG retrieval store. |

Sources: [Foundry Agent Service](https://learn.microsoft.com/azure/foundry/agents/overview), [Foundry Models overview](https://learn.microsoft.com/azure/foundry/concepts/foundry-models-overview), [Observability](https://learn.microsoft.com/azure/foundry/concepts/observability), [Prompt flow (classic)](https://learn.microsoft.com/azure/foundry-classic/concepts/prompt-flow), [Fine-tuning safety eval](https://learn.microsoft.com/azure/foundry/openai/how-to/fine-tuning-safety-evaluation).

---

## 2. Loom's current equivalent (from the repo, today)

### Governance / Unity Catalog
- **Dual UC backend** — `apps/fiab-console/lib/azure/uc-backend.ts` selects Databricks UC (Commercial default) vs. self-hosted **OSS Unity Catalog** (`apps/loom-unity/`, Azure-Gov default) over the *same* `/api/2.1/unity-catalog/*` REST. Client: `lib/azure/unity-catalog-client.ts`.
- **Full UC BFF surface** — `app/api/databricks/unity-catalog/*`: `catalogs, schemas, tables, volumes, functions, models, grants, lineage, principals, bindings, connections, data-classification, governed-tags, marketplace, policies (ABAC), quality-monitors, system-tables, tags, metric-views, clean-rooms, online-tables, external-locations`. This is near-complete UC parity, incl. ABAC policies, clean rooms, online tables, metric views.
- Genuinely Databricks-only families (Delta Sharing, system tables, federation, clean rooms, online tables, marketplace) are **honest-gated** on the OSS backend rather than silently 404ing (`ossUcUnsupportedPath`).
- **Purview** integration in parallel (`lib/azure/purview-client.ts`, `purview-source-map.ts`) for classic Data Map governance.

### Databricks compute / data engineering
- Clients + BFF: `lib/azure/databricks-client.ts`; `app/api/databricks/{workspace,catalogs,clusters,jobs,notebooks,repos,warehouses,pipelines,serving-endpoints,mlflow/experiments,mlflow/models}`.
- **Catalog item-types** (`lib/catalog/item-types/azure-databricks.ts`): `databricks-notebook`, `databricks-job`, `databricks-cluster`, **`databricks-pipeline` (Lakeflow DLT — real visual canvas that compiles to DLT SQL + creates/runs via `/api/2.0/pipelines`)**, `databricks-sql-warehouse`.
- **Model serving** — `app/api/databricks/serving-endpoints/route.ts` does real list/create/delete against `/api/2.0/serving-endpoints` (honest 404 on Gov). *Not yet a first-class editor item.*
- Spark: `lib/spark/config-presets.ts`, `synapse-livy-client.ts`, `spark-session-pool.ts` (Synapse-native path).

### ML / Data Science
- `lib/catalog/item-types/data-science.ts`: **`ml-model`** (MLflow registered model + PREDICT endpoint, wired to Foundry hub), **`ml-experiment`** (MLflow tracking), **`automl`** (real AML AutoML jobs, `jobType:'AutoML'`).

### Azure AI Foundry surfaces
- `lib/catalog/item-types/azure-ai-foundry.ts`: `ai-foundry-hub`, `ai-foundry-project`, **`prompt-flow`**, **`evaluation`** (Foundry evaluators), **`content-safety`**, **`tracing`** (App Insights), **`ai-search-index`** (vector+hybrid RAG), **`compute`** (AML instances/clusters), **`dataset`** (data assets), **`ai-enrichment`** (batch LLM over a column — Fabric AI-functions parity, in-DB via Databricks `ai_*`), **`ai-red-team`** (defensive PyRIT-style safety scan, preview).
- Foundry lib: `lib/foundry/{model-tier-router, model-availability-matrix, model-availability-runtime, deployment-types, agent-eval, agentops, red-team}.ts`. **`agent-eval.ts`** = real Agent Service call + AOAI-judge 1-5 scoring; **`red-team.ts`** + **`agentops.ts`** = safety/ops.
- `lib/azure/foundry-client.ts`, `deployment-types.ts` — model deployment management.

### Agents / Copilot / model routing
- **Cross-item Copilot** (`lib/catalog/item-types/ai-agents.ts` + `lib/azure/copilot-orchestrator.ts`, `agent-orchestrator.ts`) — NL orchestrator across 25+ Loom service tools, SSE-streamed, full audit log.
- **Agent flow** (`agent-flow`) — visual multi-agent canvas (orchestrator + grounded data tools + MCP/OpenAPI/function tools + connected sub-agents) run on Azure-native connected-agents runtime; `lib/azure/agent-flow-run.ts`, `agent-tool-kinds.ts`, `agent-tool-catalog.ts`, `agent-memory-client.ts`, `agent-runtime-tier.ts`.
- **Data agent** (Genie analog) — `lib/azure/data-agent-client.ts` + `data-agent-execute.ts`: grounds NL over up to 5 typed sources (Warehouse/Lakehouse/KQL/Semantic model/AI Search) via AOAI Assistants, emits the SQL/KQL/DAX; publishable as MCP + to M365 Copilot (`app/api/items/data-agent/[id]/{chat,mcp,m365-copilot,publish-mcp}`).
- **Model tier-router** (`lib/foundry/model-tier-router.ts`) — default-ON task-class→tier (mini/standard/strong) routing, admin-configurable; grounded in AOAI Model Router.
- **Unified AOAI client** — `lib/azure/aoai-chat-client.ts` (18 callers), `aoai-model-contract.ts`, `aoai-apim-gateway.ts`, `embeddings-client.ts`.

### Vector / RAG / feature data
- **`vector-store`** item (`lib/catalog/item-types/azure-graph-vector.ts`) — vector index over Cosmos vCore / AI Search / **pgvector**; `lib/azure/memory-vector-index.ts`, `vectorizer-consistency.ts`.
- **Lakebase** (`lakebase-postgres`, `postgres-flex-client.ts`) — Postgres OLTP / pgvector, Databricks-Lakebase analog.
- **AI Search index** item = managed RAG retrieval.

### BI / semantic / apps / sharing (adjacent)
- Semantic model + report renderer (`lib/semantic-model/*`, `power-bi.ts`), KQL dashboards, **Marketplace + Delta Sharing** (`app/api/marketplace/sharing/*`, `csa-data-products.ts`), **Loom Apps** (`lib/azure/loom-apps-client.ts` — Databricks-Apps analog), **Fabric IQ / Weave** ontology suite (`fabric-iq.ts`: `ontology, ontology-sdk, data-agent, operations-agent, graph-model, aip-logic/Spindle`, etc.).

---

## 3. Graded parity matrix

Grades: **A+** exceeds · **A** at-par + polished · **B** functional parity, rough edges · **C** partial · **D** stub/read-only · **F** missing.

### Databricks

| Capability | Databricks surface | Loom surface (file) | Grade | Gap |
|---|---|---|---|---|
| Unity Catalog governance | UC metastore, 3-level ns | `uc-backend.ts` + `unity-catalog-client.ts` + full `app/api/databricks/unity-catalog/*` | **A** | Dual-backend (DBX + OSS); near-complete surface |
| ABAC / row-filter / masking | UC policies | `unity-catalog/policies/route.ts`, `governed-tags`, `data-classification` | **A−** | Present; verify policy-authoring UX depth vs portal |
| Lineage + system tables | UC lineage, system tables | `unity-catalog/{lineage,system-tables}/route.ts` | **B+** | DBX-only on OSS backend (honest-gated) |
| Delta Lake format | Delta ACID/time-travel | ADLS+Delta via lakehouse; Synapse table reg | **B** | No Delta-specific optimize/liquid-clustering UX |
| Lakeflow Declarative Pipelines (DLT) | Streaming tables/MVs/expectations | `databricks-pipeline` (real canvas → DLT SQL → `/api/2.0/pipelines`) | **A** | Strong; canvas compiles + runs real |
| Lakeflow Connect (managed ingest) | Connectors | Data-integration infra (linked services/SHIR), Synapse/ADF path | **B−** | No 1:1 managed-connector gallery for DBX |
| Lakeflow Jobs / Workflows | Multi-task DAG | `databricks-job` + `app/api/databricks/jobs` | **A−** | Real multi-task run + inspect |
| Databricks SQL warehouse | Serverless/classic + Photon | `databricks-sql-warehouse` + `app/api/databricks/warehouses` | **A−** | Real list/start/stop/query |
| **Genie (NL analytics)** | Conversational NL-to-SQL over governed data | **`data-agent`** (`data-agent-client.ts`, 5 sources) + Cross-item Copilot | **A−** | Loom's is multi-source + publishable-as-MCP; Genie has richer Spaces/mobile |
| AI/BI Dashboards | AI-authored dashboards + forecasting | Semantic model + report renderer + KQL dashboards | **B** | No AI-authored-viz / key-driver / forecast one-click |
| **Mosaic AI Model Serving** | Real-time/batch/provisioned-throughput serving | `serving-endpoints/route.ts` (list/create/delete) + Foundry `ml-model` deploy | **C+** | Read/CRUD only; **no first-class serving editor, traffic-split, or monitoring UX** |
| **Feature Store / online tables** | UC feature tables + online serving + PIT lookup | `unity-catalog/online-tables/route.ts` (list) | **D** | **No feature-table authoring, PIT-join, or feature-lookup-at-serving** |
| **Vector Search** | Delta-synced managed index, hybrid, rerank | `vector-store` (Cosmos/AISearch/pgvector) + `ai-search-index` | **B** | No Delta-synced auto-index; manual sync |
| MLflow (experiments/registry/eval) | Full lifecycle + GenAI tracing | `ml-experiment`, `ml-model`, `app/api/databricks/mlflow/*`, Foundry `evaluation`/`tracing` | **B+** | Experiments/registry wired; no `mlflow.evaluate` GenAI-judge one-click |
| Fine-tuning / model training | Mosaic FT + continued pretrain | AutoML (`automl`) only | **D+** | **No LLM fine-tuning UX** (see Foundry row) |
| AI Functions (SQL `ai_*`) | In-DB LLM SQL | **`ai-enrichment`** (in-DB via DBX `ai_*` + per-row AOAI) | **A** | Durable item form; exceeds Fabric AI-functions |
| Databricks Apps | Managed data-app hosting | **Loom Apps** (`loom-apps-client.ts`, runtime templates) | **A−** | Publish-as-API/MCP, per-app monitoring |
| Marketplace | Cross-org data/model share | `csa-data-products.ts`, `app/api/marketplace/sharing/*` | **B+** | Delta Sharing + subscribe→access shipped |
| Delta Sharing | Open sharing protocol | `marketplace/sharing/{providers,catalogs}` | **B** | Present; DBX-native on OSS honest-gated |
| Clean Rooms | Privacy-safe collab | `unity-catalog/clean-rooms/route.ts` (list) | **D** | DBX-only passthrough; no Loom-native clean room |
| Lakehouse Federation | Query external sources | `unity-catalog/connections/route.ts` | **C** | List/connect; no query-federation UX |

### Azure AI Foundry

| Capability | AI Foundry surface | Loom surface (file) | Grade | Gap |
|---|---|---|---|---|
| Model catalog | 1,900+ models, compare, deploy | `model-availability-matrix.ts`, `foundry-client.ts`, `deployment-types.ts` | **B+** | Availability matrix + deploy; no side-by-side compare/benchmark UX |
| Model deployment mgmt | Serverless + managed compute | `foundry-client.ts`, Foundry `compute` item | **B+** | Real; provisioned-throughput UX thinner |
| **Model tier routing** | Model Router | **`model-tier-router.ts`** (default-ON, admin-tunable) | **A** | Exceeds — task-class routing built-in day-one |
| Foundry Agent Service | Prompt/Hosted agents, Responses API, tools, multi-agent | **`agent-flow`**, `data-agent`, `agent-orchestrator.ts`, MCP tools | **A−** | Azure-native connected-agents runtime; MAF opt-in |
| Prompt flow | Visual LLM+tool graph | **`prompt-flow`** item | **B+** | Present; note MS is retiring prompt-flow → MAF (Loom's agent-flow is the modern path) |
| Evaluations | Built-in + custom evaluators | **`evaluation`** item + **`agent-eval.ts`** (AOAI-judge) | **A−** | Real judge scoring; grow built-in evaluator library breadth |
| Observability / tracing | OTel + App Insights dashboards | **`tracing`** item + `agentops.ts` + `copilot-latency-tracker.ts`/`copilot-slo.ts` | **B+** | Trace filter/drill; no full OTel span-tree/cluster-analysis |
| Content Safety | Text/image moderation, prompt shields | **`content-safety`** item | **A−** | Categories + thresholds + wire-in-front |
| AI Red Teaming | AI Red Teaming Agent (PyRIT) | **`ai-red-team`** item + `red-team.ts` | **A** | Loom-native PyRIT-style scan (preview) |
| Fine-tuning | Serverless/managed FT + safety eval | — (AutoML only) | **F** | **No LLM fine-tuning surface** |
| Connections | Typed hub/project connections | `ai-foundry-hub`/`project` (inherit connections) | **B** | Connection-management UX thinner than portal |
| RAG / AI Search | Vector indexes + hybrid grounding | **`ai-search-index`** + `vector-store` | **A−** | Hybrid RAG grounding wired |
| Agent memory | Thread memory tool | `agent-memory-client.ts`, `memory-vector-index.ts` | **B+** | pgvector-backed memory present |
| Publish (Teams/M365/Entra registry) | Agent publishing | `data-agent/[id]/m365-copilot`, `copilot-studio-client.ts` | **B** | M365 publish present; no Entra Agent Registry |

---

## 4. Gaps & recommendations (prioritized)

**P0 — material missing ML-platform capabilities**
1. **Feature Store (Grade D → A).** No feature-table authoring, point-in-time joins, or feature-lookup-at-serving. Build a Loom-native feature store over **UC feature tables + `online-tables` + Lakebase/pgvector** for online serving. This is the single biggest ML-platform gap vs Databricks.
2. **Model Serving as a first-class editor (C+ → A).** `serving-endpoints/route.ts` is CRUD-only. Add a **`model-serving-endpoint` item** with traffic-split, autoscale, provisioned-throughput, invocation console, and latency/error monitoring — over both Databricks serving *and* Foundry managed online endpoints (Azure-native default).
3. **LLM fine-tuning UX (F → B+).** No fine-tuning surface at all. Add a **`fine-tuning-job` item** over AOAI/Foundry serverless + managed-compute FT, including data-eval + model-safety-eval gates (Foundry already gives the RAI checks). Optionally Mosaic FT when Databricks is the chosen backend.

**P1 — enhance existing surfaces to at-par**
4. **AI/BI Dashboards (B → A).** Add AI-authored visualization, one-click **forecasting + key-driver analysis** to the semantic-model/report path to match Databricks AI/BI + Genie-generated dashboard agents.
5. **Managed Vector Search (B → A).** Make `vector-store` a **Delta-synced auto-indexed** store (auto-sync from a lakehouse/UC table, incremental) rather than manual population; add reranking.
6. **GenAI evaluation depth (B+ → A).** Expand the built-in evaluator library (groundedness/relevance/tool-call-accuracy/task-adherence) and add **`mlflow.evaluate`-style one-click** GenAI judge + **cluster-analysis of eval failures** (Foundry parity).
7. **Observability span-tree (B+ → A).** Upgrade `tracing`/`agentops` to a full OTel span waterfall with token/latency/error rollups and continuous-eval alerts (Azure Monitor).

**P2 — refactors / breadth**
8. **Model catalog compare/benchmark UX** — side-by-side eval on your own data (Foundry Models parity).
9. **Lakehouse Federation query UX** and **Lakeflow Connect managed-connector gallery** for the Databricks-backend path.
10. **Loom-native Clean Room** (currently DBX passthrough) so Gov/OSS deployments get privacy-safe collaboration without a Databricks capacity — consistent with `no-fabric-dependency` philosophy applied to Databricks-only features.

---

## 5. Burn-the-box ideas — where Loom can EXCEED

Databricks owns data+ML but not the ontology/BI/agent-publishing stack as one graph; AI Foundry owns models+agents but not the governed lakehouse or semantic layer. **Loom owns the whole vertical** — lakehouse + Unity Catalog + Purview governance + semantic model + Weave/Fabric-IQ ontology + BI + agents — behind one theme and one auth. Exploit that:

1. **Ontology-grounded agents & feature store (unification neither competitor can match).** Loom already ships a Palantir-grade **ontology / Weave** layer (`fabric-iq.ts`: `ontology`, `ontology-sdk`, `graph-model`, `data-agent`, `operations-agent`, `aip-logic`). Wire the **feature store and vector index directly to ontology objects** and let **agents reason over the ontology + governed features + lineage together**. Databricks Genie sees tables; a Loom agent can see *entities, their relationships, their features, and their governance* — that's an Ontology-native Genie/AgentBricks that a standalone Databricks or Foundry structurally cannot build.

2. **One governance spine across data + ML + agents.** Unify **Unity Catalog + Purview + the gate registry (`lib/gates/registry`)** so that a fine-tuned model, a serving endpoint, a feature table, a vector index, *and* an agent are all UC/Purview securables with the same ABAC policies, lineage, classification, and audit. Foundry governs models; Databricks governs data; **only Loom can put a model deployment, its training data lineage, and the agent that calls it under one ABAC + lineage graph** — including cross-cloud (Commercial + Gov) with the OSS-UC fallback so it works with *no* Databricks or Fabric capacity.

3. **Closed-loop evaluate→route→serve→observe fabric.** Loom already has the pieces separately: `model-tier-router` (routing), `agent-eval`/`red-team` (eval), `serving-endpoints` (serving), `agentops`/`copilot-slo` (observability). Fuse them into a **self-optimizing loop**: continuous eval + red-team results feed the tier-router and a serving traffic-split automatically (promote the model/prompt that wins live eval, demote regressions), all logged to the gate registry and surfaced on the Admin panel. Foundry has FAOS agent-optimizer and Databricks has Agent Evaluation, but **neither closes the loop across routing + serving + governance in one product** — Loom can, because it owns every stage and every stage is Azure-native + Gov-capable.

---

## Executive summary (10 lines)

1. **Overall grade: B+ / A−.** Loom is at-or-near parity on governance, data engineering, agents, and the Foundry gen-AI surface; it trails on the classic-ML platform pieces (serving, feature store, fine-tuning).
2. Unity Catalog coverage is **A** — dual Databricks + OSS-UC backend over one REST surface, near-complete (ABAC, lineage, clean-rooms/online-tables passthrough, metric views), Gov-capable with no Fabric/Databricks hard dependency.
3. Lakeflow DLT (`databricks-pipeline`), Jobs, SQL warehouses, and **AI-enrichment** (`ai_*`) are **A/A−** — real canvas-to-REST execution.
4. Foundry parity is strong: prompt-flow, evaluation, content-safety, tracing, AI-search, red-team, agent-eval, and a **default-ON model tier-router** that *exceeds* Foundry's Model Router.
5. **Genie analog = `data-agent`** (multi-source NL, publishable as MCP) grades **A−** and is arguably broader than Genie.
6. **Top 5 gaps:** (1) **Feature Store — D** (no feature tables/PIT/online lookup); (2) **Model Serving — C+** (CRUD-only, no first-class serving editor/traffic-split/monitoring); (3) **LLM fine-tuning — F** (none beyond AutoML); (4) **AI/BI dashboards — B** (no AI-authored viz/forecast/key-driver); (5) **Managed Vector Search — B** (no Delta-synced auto-index).
7. Also below-bar: eval library breadth + cluster-analysis, OTel span-tree observability, model catalog compare/benchmark, Loom-native clean rooms.
8. **Burn-the-box #1:** Ontology-grounded feature store + agents (Weave/Fabric-IQ) — agents reason over entities+features+lineage, not just tables.
9. **Burn-the-box #2:** One ABAC+lineage governance spine (UC+Purview+gate registry) spanning data, models, endpoints, features, and agents — cross-cloud, no Fabric/Databricks capacity required.
10. **Burn-the-box #3:** Closed-loop evaluate→route→serve→observe self-optimizing fabric fusing `model-tier-router` + `agent-eval`/`red-team` + `serving-endpoints` + `agentops`.
