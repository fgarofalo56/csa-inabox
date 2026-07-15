# Appendix — Copilot & AI Agents: Microsoft Fabric → CSA Loom Parity

**Domain:** `copilot-ai` — Copilot in Fabric (every workload), Fabric Data Agent,
AI functions, AI-assisted authoring, agentic integration (Foundry / Copilot
Studio / M365).
**Date:** 2026-06-26 · **Grounding:** Microsoft Learn (URLs inline) + live Loom code read.
**Verdict:** Loom coverage in this domain is **STRONG** — the cross-item Copilot
orchestrator, per-pane Copilot personas, the full Fabric Data Agent artifact, AI
Functions, Copilot Studio, and Foundry are all built Azure-native. Remaining work
is **breadth** (Copilot builders on *every* design surface), **AI-Functions-at-scale**
(table/DataFrame + T-SQL + Dataflow), and a handful of agentic items
(Operations Agent, Data Wrangler AI, Prep-for-AI / Verified Answers, Translytical).

> **Strategic headline — Loom delivers Copilot where Fabric cannot.** Microsoft
> Learn states plainly: *"Copilot isn't yet supported for sovereign clouds due to
> GPU availability."* (copilot-fabric-overview). Fabric Copilot is also region-gated
> (AOAI only in US + EU data boundary) and capacity-gated (F2/F64 + tenant switch,
> dark-by-default outside US/EU). **Loom's Azure-native default — AOAI in the
> customer's own subscription, Commercial *and* Azure Government (USGov Virginia /
> Arizona) — gives GCC / GCC-High / DoD customers a working Copilot + Data Agent
> that the real Fabric product denies them.** This appendix's day-one-on posture
> turns that into the default.

---

## 1. Architecture: how Fabric Copilot actually works (and the Loom 1:1)

### 1.1 Fabric Copilot control flow (grounded)
Source: [How Copilot in Microsoft Fabric works](https://learn.microsoft.com/fabric/fundamentals/how-copilot-works),
[What is Copilot in Fabric](https://learn.microsoft.com/fabric/fundamentals/copilot-fabric-overview).

1. **User input** in a workload surface (notebook, warehouse editor, PBI, RTI) →
   prompt + user token + session chat history + a **meta-prompt** carrying system
   metadata (where the user is, what item/schema is in context).
2. **Pre-processing / grounding** — Copilot collects only data the user can already
   access (respects workspace roles, item permissions, RLS/OLS). Grounding = schema,
   metadata, conversation history. Table *contents* are NOT sent unless the user
   directs it. Cached in the tenant home region for audit; **not** cached at AOAI.
3. **Send to Azure OpenAI** — augmented prompt + grounding → **Azure OpenAI Service**
   (Microsoft-managed; GPT-series; you can't pick/swap the model). Deployed only in
   US datacenters (EastUS/EastUS2/SouthCentralUS/WestUS) + EU data boundary.
4. **AOAI generates** the artifact (SQL/KQL/DAX/M/PySpark/report/summary).
5. **Post-processing** — RAI checks, formatting, returned to the surface. Billed to
   Fabric capacity under the **Copilot and AI** meter.

**Loom 1:1 architecture:** `app/api/copilot/orchestrate` runs `routeCopilot` — a
real AOAI `tool_choice` classifier that routes the GLOBAL launcher to a **docs
agent** (`orchestrateHelp`) or a **build agent** (`orchestrate`), emitting an
`agent` attribution step first. Per-pane personas are selected server-side by
`contextSlug` (warehouse / notebook / lakehouse / …) from the persona registry;
`contextPayload` carries live editor state (active query, schema, workspace id)
that composes the persona's system prompt. The AOAI target is resolved by
`resolveAoaiTarget` against the **Loom Foundry hub** (the customer's own AOAI
deployment) — no Fabric capacity, no Microsoft-managed model, no F64. Grounding
respects the minted session + the same RBAC the data-plane clients enforce.
Content safety is real: `shieldPrompt` (prompt-shield) + `moderateContent` via
`foundry-client`. Sovereign-aware: `cogScope()` mints `cognitiveservices.azure.us`
in Gov vs `.com` in Commercial, and cross-checks the endpoint host against the
active cloud.

**Why this is *better* than Fabric for the operator's customers:** the model,
region, data-residency, and capacity are all under the customer's control in their
own subscription — and it runs in Gov.

### 1.2 The Loom Copilot surface map (what exists today)

| Loom surface | File(s) | Fabric equivalent |
|---|---|---|
| Cross-item / global Copilot (router + SSE) | `app/api/copilot/orchestrate/route.ts`, `lib/azure/copilot-router.ts`, `cross-item-copilot-editor.tsx` | Standalone Copilot / "chat with your data" |
| Per-pane personas | `lib/azure/copilot-personas.ts`, `lib/copilot/use-copilot-context.ts` | Per-workload Copilots |
| Inline completion | `app/api/copilot/complete`, `lib/copilot/inline-complete*.ts` | Notebook / SQL code completion |
| DAX copilot | `app/api/copilot/dax`, `lib/copilot/dax-tools.ts`, `dax-probe.ts` | Copilot DAX query view |
| Notebook assist | `app/api/copilot/notebook-assist`, `lib/copilot/notebook-tools.ts` | Copilot in notebooks (chat + in-cell + Fix) |
| Tools registry | `app/api/copilot/tools`, `lib/copilot/{sql,kql,pipeline,dataflow,report,activator,ops,agent-config}-tools.ts` | Per-workload skills |
| Sessions / approval diff | `app/api/copilot/sessions`, `lib/copilot/{apply-change,proposed-change}.ts` | Approval-diff "Fix with Copilot" |
| Fabric Data Agent | `lib/azure/data-agent-client.ts`, `app/api/items/data-agent/**`, `data-agent-config-copilot.tsx`, `data-agent-result-viz.tsx` | Fabric Data Agent |
| AI Functions | `app/api/ai-functions/route.ts`, `lib/azure/ai-functions-client.ts` | AI Functions |
| Copilot Studio | `copilot-studio-editors.tsx`, `copilot-topic-canvas.tsx`, `lib/copilot-studio/` | Copilot Studio |
| Foundry hub / playground / evals | `foundry-hub-editor.tsx`, `foundry-playground.tsx`, `foundry-evaluations.md` | AI Foundry in Fabric |
| Content safety / governance | `lib/azure/foundry-client.ts`, `copilot-governance.md`, `global-copilot-content-safety.md` | Copilot privacy/security + Content Safety |

---

## 2. Capability inventory (grounded in MS Learn) + Loom coverage

Legend: ✅ built · ⚠️ partial / honest-gate / shallow · ❌ missing.
**featureCount = 28** discrete capabilities enumerated.

### 2.1 Copilot per workload

| # | Fabric capability | How it works (Learn) | Loom coverage |
|---|---|---|---|
| 1 | **Copilot for Data Engineering / Data Science (notebook)** — context-aware chat pane (workspace + attached lakehouse schemas + runtime state), notebook-wide multi-step gen/refactor/summarize/validate, in-cell `/fix`, **Fix with Copilot** (error summary + root-cause + approval diff), perf insights | [copilot-notebooks-overview](https://learn.microsoft.com/fabric/data-engineering/copilot-notebooks-overview) | ✅ `notebook-editor.tsx` + `notebook-tools.ts` + `app/api/copilot/notebook-assist`; parity docs `notebook-*`, `notebook-fix-with-copilot.md`, `copilot-approval-diff.md` |
| 2 | **Copilot for Data Factory — Dataflow Gen2** — NL transform steps (Applied steps), explain-query/step, generate sample data, Get-Data-with-Copilot, undo | [copilot-fabric-data-factory](https://learn.microsoft.com/fabric/data-factory/copilot-fabric-data-factory) | ✅ `dataflow-gen2-editor.tsx` + `dataflow-tools.ts`; parity `dataflow-gen2-copilot.md` |
| 3 | **Copilot for Data Factory — pipelines** — NL pipeline generation, error-message assistant, summarize pipeline, **expression builder Copilot** (Add dynamic content) | [copilot-fabric-data-factory-get-started](https://learn.microsoft.com/fabric/data-factory/copilot-fabric-data-factory-get-started) | ✅ `pipeline-editor*.tsx` + `pipeline-tools.ts`; parity `pipeline-copilot.md` |
| 4 | **Copilot for Data Warehouse** — NL2SQL chat pane, code completion (Tab), quick actions **Explain / Fix**, intelligent insights (schema-aware) | [data-warehouse/copilot](https://learn.microsoft.com/fabric/data-warehouse/copilot) | ✅ `warehouse-editor.tsx` + `synapse-sql-editors.tsx` + `sql-tools.ts`; parity `warehouse-copilot.md` |
| 5 | **Copilot for SQL database** — NL2SQL, code completion, Explain/Fix, **document-based Q&A**; uses object metadata not row data | [database/sql/copilot](https://learn.microsoft.com/fabric/database/sql/copilot-sql-database) | ✅ `unified-sql-database-editor.tsx` + `sql-database-editor.tsx`; parity `azure-sql-copilot.md` |
| 6 | **Copilot for Power BI — authors** — create/edit report pages, summarize semantic model, narrative visual, **DAX queries**, measure descriptions | [copilot-introduction](https://learn.microsoft.com/power-bi/create-reports/copilot-introduction), [dax-copilot](https://learn.microsoft.com/dax/dax-copilot) | ✅ Report Copilot in `phase3-editors.tsx` (narrative + suggest-visuals, Loom-native, no PBI) + DAX copilot `app/api/copilot/dax`; parity `report-copilot.md` |
| 7 | **Copilot for Power BI — consumers** — page/visual summaries, ask-questions-build-a-visual, "How Copilot arrived at this", email-subscription summaries | [copilot-reports-overview](https://learn.microsoft.com/power-bi/create-reports/copilot-reports-overview) | ⚠️ narrative + Q&A present; **consumer "build a visual from a question"** + subscription summary = partial |
| 8 | **Copilot for Real-Time Intelligence — KQL queryset** — NL2KQL, conversational refine, follow-ups | [copilot-real-time-intelligence](https://learn.microsoft.com/fabric/real-time-intelligence/copilot-real-time-intelligence) | ⚠️ `kql-tools.ts` + `kql-copilot.md` exist; **inline NL2KQL builder pane is NOT embedded in `synapse-kql-editor.tsx`** (gap G1) |
| 9 | **Copilot in Real-Time Dashboards** — edit tile queries in NL, explore-data in view mode, save insight as tile | [copilot-real-time-intelligence](https://learn.microsoft.com/fabric/real-time-intelligence/copilot-real-time-intelligence) | ❌ `kql-dashboard` editor has no tile-query Copilot (gap G1) |
| 10 | **Data Wrangler AI** — AI Functions in grid, rule-based AI suggestions, code-gen with Copilot, real-time preview | [data-wrangler-ai](https://learn.microsoft.com/fabric/data-science/data-wrangler-ai) | ❌ no Data Wrangler AI surface (gap G4) |

### 2.2 Fabric Data Agent (the configurable Q&A artifact)

| # | Fabric capability | How it works (Learn) | Loom coverage |
|---|---|---|---|
| 11 | **Data Agent core** — standalone artifact; AOAI **Assistant APIs** as orchestrator; question parse → data-source select → tool (NL2SQL/KQL/DAX/GQL) → validate → execute → human-readable answer; read-only; respects Purview DLP + RBAC | [concept-data-agent](https://learn.microsoft.com/fabric/data-science/concept-data-agent) | ✅ `data-agent-client.ts` (`chatGrounded`) + `run-steps` inspector + `data-agent-result-viz.tsx` |
| 12 | **Up to 5 data sources, any mix** — SQL (Lakehouse/Warehouse/SQL DB/Mirrored, T-SQL), Eventhouse (KQL), Semantic model (DAX), **Graph/GQL (preview)**, **Ontology (preview)**, **AI Search (preview, unstructured)**, Microsoft Graph | [data-agent-add-datasources](https://learn.microsoft.com/fabric/data-science/data-agent-add-datasources) | ✅ 7 source types in `data-agent-client.ts` (`warehouse/lakehouse/kql/semantic-model/ai-search/ontology/graph`) |
| 13 | **Per-source config** — schema selection (tables/views/functions), agent instructions (route), data-source instructions (NL2X context), data-source description, **example queries (few-shot, top-3 by vector similarity)** | [data-agent-configurations](https://learn.microsoft.com/fabric/data-science/data-agent-configurations) | ✅ config in editor; **example-query auto-gen via config-copilot** (`data-agent-config-copilot.tsx` → `/api/items/data-agent/[id]/copilot`) |
| 14 | **Agent instructions** — up to 15,000 chars, route financial→semantic, raw→lakehouse, logs→KQL | [how-to-create-data-agent](https://learn.microsoft.com/fabric/data-science/how-to-create-data-agent) | ✅ `data-agent-client.ts` system-prompt composition mirrors this routing |
| 15 | **Test chat + run-step inspector** — debug HOW it answered (per-tool steps) | [concept-data-agent](https://learn.microsoft.com/fabric/data-science/concept-data-agent) | ✅ `app/api/data-agent/run-steps` (Azure-native default + published-Foundry-agent upgrade path) |
| 16 | **Publish → Azure AI Foundry** (agent as a tool / Foundry IQ) | [data-agent-foundry](https://learn.microsoft.com/azure/ai-foundry/agents/how-to/tools/fabric) | ✅ `app/api/items/data-agent/[id]/deploy` (Foundry Agent Service `createOrUpdateAgent`) |
| 17 | **Publish → Copilot Studio** (connected agent, A2A) | [data-agent-microsoft-copilot-studio](https://learn.microsoft.com/fabric/data-science/data-agent-microsoft-copilot-studio) | ✅ `app/api/items/data-agent/[id]/publish` + Copilot Studio editors |
| 18 | **Publish → M365 Copilot** (Agent Store, @mention in Teams) | [data-agent-microsoft-365-copilot](https://learn.microsoft.com/fabric/data-science/data-agent-microsoft-365-copilot) | ⚠️ `app/api/items/data-agent/[id]/m365-copilot` route exists; **publish-to-Agent-Store flow shallow** (gap G6) |
| 19 | **Sharing & permissions** | [data-agent-sharing](https://learn.microsoft.com/fabric/data-science/data-agent-sharing) | ✅ Cosmos item RBAC via owned-item CRUD |

### 2.3 AI Functions & AI services

| # | Fabric capability | How it works (Learn) | Loom coverage |
|---|---|---|---|
| 20 | **AI Functions library** — `ai.analyze_sentiment / classify / embed / extract / fix_grammar / generate_response / similarity / summarize / translate` | [ai-functions/overview](https://learn.microsoft.com/fabric/data-science/ai-functions/overview) | ⚠️ only **5 of 9** (`summarize/classify/sentiment/extract/translate`); **missing `embed`, `similarity`, `fix_grammar`, `generate_response`** (gap G2) |
| 21 | **At-scale DataFrame APIs** — pandas + **PySpark** (distributed, default concurrency 200); `synapse.ml.aifunc` / `synapse.ml.spark.aifunc`; schema-driven `ai.extract` via JSON-Schema/Pydantic | [how-to-use-openai-ai-functions](https://learn.microsoft.com/fabric/data-science/ai-services/how-to-use-openai-ai-functions) | ❌ Loom `ai-functions` is **single-text only** — no table/DataFrame batch (gap G2) |
| 22 | **AI Functions in Warehouse / SQL endpoint (T-SQL)** — `ai_summarize`, `ai_classify`, `ai_generate_response` in queries | [data-warehouse/ai-functions](https://learn.microsoft.com/fabric/data-warehouse/ai-functions) | ❌ no T-SQL `ai_*` surface (gap G2) |
| 23 | **AI Functions in Dataflow Gen2** — "Fabric AI Prompt" AI-generated column in Power Query | [dataflow-gen2-ai-functions](https://learn.microsoft.com/fabric/data-factory/dataflow-gen2-ai-functions) | ❌ no AI-column step in Loom dataflow (gap G2) |
| 24 | **Multimodal AI Functions** — images/PDF/text (`column_type="path"`), summarize PDF, classify image, extract doc fields | [ai-functions/multimodal-overview](https://learn.microsoft.com/fabric/data-science/ai-functions/multimodal-overview) | ❌ text-only today (gap G2) |
| 25 | **AI services in Fabric** — prebuilt AOAI via SynapseML + Python SDK; RAG quickstart (AI Search + embeddings) | [ai-services-overview](https://learn.microsoft.com/fabric/data-science/ai-services/ai-services-overview) | ✅ Foundry playground + `app-supercharge-ml` RAG bundle + AI Search index/explorer editors |

### 2.4 Agentic & cross-cutting

| # | Fabric capability | How it works (Learn) | Loom coverage |
|---|---|---|---|
| 26 | **Operations Agent (RTI, preview)** — autonomous, ontology-driven; monitor live streams, interpret events, execute/recommend actions; integrates Activator + Power Automate; Teams alerts/approvals | [analyze-train-data#ai-agents](https://learn.microsoft.com/fabric/fundamentals/analyze-train-data) | ⚠️ `ops-tools.ts` + `ops-copilot.md` + `activator-copilot.md`; **no autonomous Operations Agent item** (Azure Monitor scheduled-query + Logic App) (gap G3) |
| 27 | **MCP servers + Skills for Fabric** — remote/local MCP (eventhouse, activator, map, eventstream NL2KQL), open-source agent-skills | [mcp-overview](https://learn.microsoft.com/fabric/real-time-intelligence/mcp-overview), [skills-for-fabric-overview](https://learn.microsoft.com/fabric/fundamentals/skills-for-fabric-overview) | ✅ `lib/mcp/catalog.ts` (deployable MCP library) + MS skills bundle; ⚠️ RTI-specific NL2KQL MCP partial |
| 28 | **Prep data for AI / Verified Answers** (semantic model) — AI data schema, AI instructions, Verified Answers feeding the Data Agent DAX tool + PBI Copilot | [copilot-prepare-data-ai](https://learn.microsoft.com/power-bi/create-reports/copilot-prepare-data-ai) | ⚠️ Data Agent consumes semantic models, but **no Prep-for-AI authoring surface** (Q&A linguistic schema, verified answers) (gap G5) |

---

## 3. Cross-cutting: Commercial vs Government

**The default path is AOAI in the customer's subscription** — no Fabric, no
Microsoft-managed model, no F64. This is the engine for *every* capability above.

| Concern | Commercial | Government (GCC / GCC-High / DoD) |
|---|---|---|
| LLM engine | Azure OpenAI (any region with the model) | **Azure OpenAI in Azure Government** — USGov Virginia / USGov Arizona. `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `text-embedding-3-large` GA in Gov. Endpoint `*.openai.azure.us`, token scope `cognitiveservices.azure.us` |
| Model absent in Gov (e.g. `gpt-5*`, `o*` reasoning, newest) | use directly | **OSS substitute**: self-host an open model (Llama-3.x / Mistral / Qwen) via **Azure ML managed online endpoint** or **vLLM on AKS** behind the same `chat_completions` contract the AOAI client already speaks; or Foundry Models catalog where Gov-listed |
| Content safety | Azure AI Content Safety | Content Safety GA in Gov; `shieldPrompt` / `moderateContent` already scope-aware |
| Fabric / Power BI / Copilot Studio / M365 publish | opt-in, Commercial hosts | **Honest gate** — Fabric has no GCC-High/IL5/DoD host; Power BI → `api.powerbigov.us`; M365 Copilot GCC-High limited. Loom's `copilot-orchestrator` already throws a sovereign gate instead of silently calling a Commercial host. Default Loom path needs none of these |
| Data residency | customer region | all inference in the customer's Gov subscription/region — **no cross-geo to Commercial AOAI** (the exact thing Fabric forces outside US/EU) |
| Networking | public or PE | **private-only**: AOAI + Content Safety + AI Search via Private Endpoint into the DLZ VNet; no public egress |

**Net:** every gap design below ships a Gov variant whose only substitution is the
LLM endpoint (managed AOAI-Gov, else OSS model on AKS/AML). No capability is
Gov-dark.

---

## 4. Gap build specs

Day-one posture for ALL gaps: **provisioned + enabled by default** at deploy via
bicep; the user *disables* what they don't want. No capability ships dark.

### G1 — Copilot builders on every design surface (P1)

**Operator's explicit ask: a Copilot builder on EVERY design UI.** Today 14 of ~60
editors embed a Copilot pane. Tools exist in the orchestrator for KQL / graph /
ops / activator, but the *editors* don't surface them inline.

**Missing inline builders:** `synapse-kql-editor` (NL2KQL), `kql-dashboard`
(tile-query NL2KQL + explore-data), `lakehouse-editor` (notebook-style code/NL),
`eventstream`, `stream-analytics-editor` (NL→SAQL), `semantic-model` (NL2DAX +
measure descriptions), `materialized-lake-view-editor`, `mirrored-database-editor`,
`ml-experiment-editor` / `automl-editor`, `graph-editors` (NL2GQL).

- **Design:** a reusable `<CopilotBuilderPane contextSlug=... contextPayload=... />`
  primitive (Web-5.0 Fluent v9 + Loom tokens, side-docked, collapsible) that every
  design editor mounts. It POSTs to the existing `/api/copilot/orchestrate` with the
  editor's `contextSlug` + live `contextPayload`; the **persona registry** gets one
  new persona per surface (kql-database, kql-dashboard-tile, eventstream,
  stream-analytics, semantic-model, mlv, mirrored-db, graph). Each persona's system
  prompt grounds on the surface's real schema via the existing data-plane clients
  (`kusto-client`, `synapse-sql-client`, ADX, etc.). Generated artifact is shown as a
  **proposed change with an approval diff** (`proposed-change.ts` / `apply-change.ts`),
  then applied to the real editor state — never auto-run.
- **Backend per control:** NL2KQL → `kusto-client` (ADX) `.show schema` + execute;
  NL2DAX → `synapse-sql-client` tabular read + DAX exec; NL2SAQL → Stream Analytics
  ARM; NL2GQL → ADX graph (`make-graph`/`graph-match`). All already present.
- **UI:** one toolbar toggle ("Copilot") per editor → docked pane: prompt box,
  starter-prompt chips, streamed answer, "Insert"/"Keep"/"Explain selection",
  approval diff. Matches the warehouse/notebook pane already shipped.
- **Bicep/day-one:** no new infra (reuses Foundry-hub AOAI). New persona configs are
  code. Day-one ON for every editor; admin toggle `LOOM_COPILOT_BUILDERS=off` to hide.
- **Commercial vs Gov:** identical; Gov uses AOAI-Gov endpoint already resolved.
- **Acceptance:** with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset, open each listed editor,
  type a NL prompt, get a real schema-grounded artifact inserted; approval diff works;
  KQL/DAX/SAQL/GQL execute against the real Azure backend.

### G2 — AI Functions at scale (table / T-SQL / Dataflow / multimodal) (P1)

Today `ai-functions` is 5 single-text ops. Fabric's value is **batch over tables**.

- **Design — notebook DataFrame helper:** ship a Loom Python package
  `loom-ai-functions` (mirrors `synapse.ml.aifunc`) exposing `df.ai.summarize/
  classify/extract/translate/sentiment/embed/similarity/fix_grammar/generate_response`
  for pandas + PySpark, with configurable concurrency (default 200) calling the
  customer AOAI `responses`/`chat_completions` endpoint. Preinstalled in the Loom
  Spark/notebook environment.
- **Design — Warehouse T-SQL:** expose `ai_summarize / ai_classify /
  ai_generate_response` as **Synapse SQL scalar UDFs** (or a BFF batch endpoint
  `/api/ai-functions/table` that reads N rows via `synapse-sql-client`, maps over
  AOAI with bounded concurrency, writes results back to a Delta/SQL column). UI:
  "Add AI column" action in the warehouse + lakehouse table grid.
- **Design — Dataflow Gen2 AI column:** a "Fabric AI Prompt"-equivalent transform
  step in `dataflow-gen2-editor` — pick column, choose function, preview, materialize.
  Backend = the table batch endpoint.
- **Add missing functions:** `embed` (text-embedding-3-large → Delta `Vector16` /
  AI Search), `similarity`, `fix_grammar`, `generate_response`.
- **Multimodal:** `column_type="path"` over ADLS — summarize PDF, classify image,
  extract doc fields (AOAI vision model; OSS fallback = `unstructured` + a vision
  model on AKS in Gov).
- **UI:** Web-5.0 "AI column" wizard (dropdown function picker + JSON-Schema builder
  for `extract` + concurrency slider + live preview grid). No freeform config.
- **Bicep/day-one:** AOAI embeddings deployment added to Foundry hub by default;
  notebook env image bakes `loom-ai-functions`; warehouse UDFs installed by a Cosmos/
  deploymentScript init step. ON by default.
- **Commercial vs Gov:** Gov uses AOAI-Gov; embeddings `text-embedding-3-large` GA in
  Gov. Vision model absent in Gov → OSS vision (e.g. Qwen-VL) on AKS.
- **Acceptance:** run `df.ai.classify(...)` over a 10k-row PySpark frame against real
  AOAI; "Add AI column" writes a real Delta column; Dataflow AI step materializes;
  all with Fabric unset.

### G3 — Operations Agent (autonomous monitor → act) (P2) — **BUILT (2026-07-15)**

> **Status: BUILT.** The `operations-agent` item is now a full rule-canvas over the
> real Azure-native backend. Shipped in `feat/g3-operations-agent`:
> - **Rule canvas** (`lib/editors/phase4/operations-agent-editor.tsx`, Triggers tab):
>   typed Eventhouse/ADX + Ontology source pickers, a structured **WHEN
>   condition-builder** (property/operator/value) reusing the Activator shape, the
>   **THEN action-kind picker** (Email/Teams/Webhook/SMS/Logic App via
>   `MonitorActionBuilder`), and an **approval-channel toggle** (autonomous vs
>   human-approved) — each trigger is a real `Microsoft.Insights/scheduledQueryRule`
>   + action group via `activator-monitor.ts`.
> - **Copilot persona** `operations-agent` (`lib/azure/copilot-personas.ts`) authors
>   the KQL trigger from NL, reusing the real `activator_author_rule` /
>   `activator_suggest_threshold` / `activator_create_rule` ARM tools.
> - **Deploy route** (`/api/items/operations-agent/[id]/deploy`) makes **Azure
>   Monitor the PRIMARY** target (re-upserts every trigger's scheduledQueryRule +
>   action group) and keeps the **Foundry Agent Service as an optional reasoning
>   companion**, not the sole target.
> - **Evaluator Function** `azure-functions/ops-agent-evaluator` (timer trigger):
>   reads agents from Cosmos, evaluates ADX triggers, reasons with AOAI, dispatches
>   the approval Logic App (Teams card) or the autonomous action.
> - **Bicep** `platform/fiab/bicep/modules/admin-plane/monitor-ops-agent.bicep`
>   (evaluator Function App + Teams approval Logic App + Teams connection + role
>   assignments) and the **OSS/air-gapped-Gov fallback** `monitor-ops-agent-aca.bicep`
>   (Container Apps Job + KEDA cron). Both `az bicep build`-clean + allowlisted.
> - **Tests** `lib/editors/__tests__/operations-agent.test.tsx` (rule creation,
>   condition/action config, approval toggle, persona) + `evaluator-core.test.ts`.
> Remaining: Graph `Chat.ReadWrite` app-role grant is out-of-band (documented);
> continuous ADX-scoped scheduled eval needs `LOOM_ADX_ALERT_SCOPE` (honest gate).

Fabric's Operations Agent watches live streams + ontology, then acts via Activator /
Power Automate. Loom has Activator + ops-tools but no autonomous agent item.

- **Azure-native default:** a new `operations-agent` item = **Azure Monitor
  scheduled-query alert** (or a recurring Logic App) over **ADX** (the eventhouse
  equivalent) + the Loom **Ontology**; on rule hit it invokes an action (Logic App →
  Teams adaptive card for human approval → downstream ERP/CRM connector). Reasoning
  step calls AOAI to interpret the event + recommend.
- **OSS option:** rules engine on ACA + KEDA (cron/queue) for air-gapped Gov.
- **UI:** Web-5.0 rule canvas (trigger ADX query builder + condition + action picker
  + approval channel) — reuses the activator wizard pattern; Copilot builder authors
  the KQL trigger from NL.
- **BFF:** `/api/items/operations-agent/**` (CRUD + deploy → Monitor/Logic App ARM).
- **Bicep:** `monitor.bicep` scheduled-query + Logic App + Teams connector; Console
  UAMI granted **Monitoring Contributor** day-one.
- **Commercial vs Gov:** Azure Monitor + Logic Apps GA in Gov; Teams GCC-High via
  `*.gov.teams` connector or email fallback.
- **Acceptance:** create a rule "alert when error rate > X", deploy, fire a real ADX
  condition, receive the real Teams/email action.

### G4 — Data Wrangler AI (P2)

- **Azure-native:** add an "AI" tab to the Loom Data Wrangler grid — AI Functions
  applied per-column (reuses G2 batch endpoint), rule-based AI cleaning suggestions,
  and "generate the transform code" (NL → pandas/PySpark via the notebook persona).
- **UI:** suggestion cards + real-time preview before apply (matches existing
  Wrangler preview model).
- **Day-one ON.** Gov identical (AOAI-Gov). Acceptance: AI suggestion transforms a
  real column with live preview, emits real code into the notebook.

### G5 — Prep data for AI / Verified Answers (semantic model) (P1)

- **Azure-native:** a "Prep for AI" panel on the Loom semantic-model editor — **AI
  data schema** (expose/hide tables+columns to AI), **AI instructions**, **Verified
  Answers** (curated NL→DAX pairs). Persisted on the model item; the Data Agent DAX
  tool + Report Copilot read them (the wiring point already exists in
  `data-agent-client.ts` semantic-model routing).
- **UI:** dropdown table/column selectors + verified-answer editor (NL question + DAX
  + run-to-verify) — no freeform.
- **Backend:** `synapse-sql-client` tabular DAX validate/execute.
- **Day-one ON.** Gov identical. Acceptance: add a verified answer, ask the Data
  Agent the matching question, confirm it uses the verified DAX.

### G6 — Deepen agentic publish (M365 Agent Store, Copilot Studio connected-agent) (P2)

- M365 route exists but the **Publish-to-Agent-Store** flow is shallow. Build the
  full publish dialog (rich description → `description_for_model`, deliver-as-is
  instruction, Agent Store toggle) and the Copilot Studio **connected-agent** wiring
  (User vs Agent-author auth). Honest Gov gate (no GCC-High M365 Copilot / Copilot
  Studio host) — the default Loom Data Agent + cross-item Copilot already cover the
  in-product need.
- **Acceptance:** publish a Data Agent, see it callable as a Foundry tool
  (Commercial); Gov surfaces the honest gate with the default in-product path.

---

## 5. Phasing

- **Phase 1 (P1):** G1 (Copilot-builder primitive + 10 personas), G2 (AI-Functions-at-
  scale + 4 missing fns), G5 (Prep-for-AI). These hit the operator's "Copilot builder
  on every design UI" + the AI-Functions value prop.
- **Phase 2 (P2):** G3 (Operations Agent), G4 (Data Wrangler AI), G6 (agentic publish
  depth).

## 6. Sources (primary Learn pages)
- copilot-fabric-overview · how-copilot-works · copilot-privacy-security
- copilot-notebooks-overview · copilot-fabric-data-factory(-get-started) · dataflow-gen2-copilot-explain
- data-warehouse/copilot(-chat-pane,-quick-action,-code-completion) · database/sql/copilot-sql-database
- power-bi/copilot-introduction · copilot-reports-overview · dax-copilot · copilot-prepare-data-ai
- real-time-intelligence/copilot-real-time-intelligence · copilot-writing-queries · mcp-overview · ai-agents-eventhouse
- data-science/concept-data-agent · how-to-create-data-agent · data-agent-add-datasources · data-agent-configurations · data-agent-microsoft-copilot-studio · data-agent-microsoft-365-copilot · data-agent-foundry
- ai-functions/overview · multimodal-overview · billing · data-warehouse/ai-functions · dataflow-gen2-ai-functions · how-to-use-openai-ai-functions
- data-wrangler-ai · analyze-train-data · skills-for-fabric-overview · external-integration
