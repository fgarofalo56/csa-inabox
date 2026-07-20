# 04 — Frontier AI & Agentic Platforms vs CSA Loom

**Cluster:** Frontier AI labs / agentic platforms — OpenAI, Anthropic, Google (Gemini / Vertex / Agentspace), xAI Grok.
**Lens:** data analytics, AI assistants, data agents, multi-agent workloads.
**Date:** 2026-07-20. **Grounded in:** live web research (2026) + repo inventory of `E:\Repos\GitHub\csa-inabox`.

---

## 0. TL;DR framing

The frontier labs are converging on the same shape: a **Responses/agent-loop API + an agent-builder canvas + a connector/MCP tool ecosystem + hosted multi-agent runtime + evals/observability + agent memory**, with a data-analysis surface (code interpreter / NL-to-query) bolted on. None of them own the customer's governed data estate, and none run sovereign / in-VNet / Gov.

Loom has, surprisingly, **already built most of the agentic primitives** — a multi-agent orchestrator, an MCP catalog + client + publish-as-MCP, data agents grounded on real Azure sources, agent memory (Cosmos + AI Search vector), an eval harness, and content-safety guardrails — all wired to **real Azure backends inside the customer's tenant**. Loom's weakness is not capability breadth; it is (a) **model/reasoning quality** (it rides whatever AOAI deployment exists; the tier-router is a near-no-op), (b) a **first-class visual agent-builder canvas** at frontier polish, and (c) **agent evals/observability as a product surface** rather than scattered routes. Its unique, un-copyable advantage is **agentic analytics over a governed ontology, sovereign and Gov-capable, acting through the real Azure data plane where the data lives.**

---

## 1. Capability inventory — the real frontier platforms (2026)

### 1.1 OpenAI

**Agent build/runtime**
- **AgentKit** (launched 2026): the agent-builder suite — **Agent Builder** (visual canvas to compose multi-step/multi-agent workflows), **Connector Registry** (governed catalog of data/tool connectors), **ChatKit** (embeddable chat UI). Built on top of the Responses API. *Note: OpenAI posted a June 3 2026 update that it is **winding down Agent Builder and the Evals product** with an end-of-availability date of Nov 30 2026 — the primitives live on in the Responses API + Agents SDK, but the hosted no-code canvas is being retired.* ([AgentKit](https://openai.com/index/introducing-agentkit/))
- **Responses API** — the unified agent-loop primitive (successor to Assistants API): server-side tool loop, built-in **web search**, **file search**, **code interpreter**, **computer use**, and remote **MCP** tool servers. Assistants API is on a deprecation path in favor of Responses. ([New tools for building agents](https://openai.com/index/new-tools-for-building-agents/))
- **Agents SDK** (Python + JS/TS) — code-first multi-agent orchestration: agents-as-tools, handoffs, guardrails, sessions, tracing; defaults to the Responses API and supports MCP servers as tools. ([Agents SDK](https://openai.github.io/openai-agents-python/models/))
- **GPTs** — consumer/no-code custom assistants with instructions + knowledge files + actions (function calling to external APIs).
- **Operator / agentic tasks** — browser-driving computer-use agent for autonomous multi-step web tasks.
- **Realtime API** — low-latency speech-to-speech + tool calling for voice agents.

**Data analysis**
- **ChatGPT Advanced Data Analysis / Code Interpreter** — sandboxed Python notebook: upload CSV/XLSX, clean/transform, statistical analysis, chart generation, file export. Connectors attach files from Google Drive / OneDrive / SharePoint. ([Data analysis with ChatGPT](https://help.openai.com/en/articles/8437071-data-analysis-with-chatgpt))

**Evals / guardrails**
- **Evals API + platform** — dataset-based grading, LLM-as-judge, run comparison (also being wound down as a product surface per the June 3 note, API persists).
- Guardrails in the Agents SDK (input/output validation, tripwires), Moderation API.

### 1.2 Anthropic (Claude)

**Agent build/runtime**
- **Claude Agent SDK** (formerly Claude Code SDK; Python + TS) — the agent loop that powers Claude Code, exposed as a library: tool use, **subagents** (context-isolated child agents with their own memory scope + permission mode), permission system, hooks, MCP servers. ([Subagents in the SDK](https://code.claude.com/docs/en/agent-sdk/subagents))
- **Managed Agents** — server-hosted agents with a **managed sandbox** (code execution + file creation) and mounted **memory** stores (`/mnt/memory/`, read/write surfaced as tool_use/tool_result events). ([Agent memory](https://platform.claude.com/docs/en/managed-agents/memory))
- **MCP (Model Context Protocol)** — Anthropic's open standard for connecting agents to tools/data; now an ecosystem standard adopted by OpenAI, Google, Microsoft. Spec moving fast (2026-07-28 release candidate). **MCP connector** for managed agents connects remote MCP servers directly. ([MCP](https://docs.anthropic.com/en/docs/mcp), [MCP RC](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/))
- **Computer use** — Claude controls a virtual desktop (screenshots + mouse/keyboard) for GUI automation.
- **Tool use / function calling** — first-class, parallel tool calls, structured tool results.

**Data analysis & assistant surfaces**
- **Claude for Excel** (office agents) — Excel add-in: Claude reads a workbook, runs code to analyze/transform, builds visualizations, writes results back to cells; requires "code execution and file creation" permission. ([Claude for Excel](https://claude.com/docs/office-agents/excel))
- **Artifacts** — live, versioned side-panel outputs (apps, charts, docs, code) rendered from a conversation; users can build interactive tools.
- **Projects** — persistent workspaces with pinned knowledge/context + custom instructions for a body of work.
- **Claude in Slack** (Claude Tag) — embed Claude in team workflows.

**Evals / guardrails**
- Constitutional-AI safety, system cards, prompt-injection mitigations in the agent/tool loop; permission model as the primary guardrail for agent actions.

### 1.3 Google (Gemini / Vertex / Agentspace)

**Agent build/runtime**
- **Vertex AI Agent Builder** — managed platform to build/deploy/scale agents: **Agent Engine** (managed runtime), **ADK** integration, evals, and connectors. ([Vertex AI Agent Builder blog](https://cloud.google.com/blog/products/ai-machine-learning/more-ways-to-build-and-scale-ai-agents-with-vertex-ai-agent-builder))
- **ADK (Agent Development Kit)** — open-source, code-first framework for building multi-agent systems (hierarchies, workflow agents, tools); the Google analog to the Agents SDK. ([ADK](https://adk.dev/a2a/a2a-extension/))
- **A2A (Agent2Agent) protocol** — open standard for **agent-to-agent interoperability** (agent cards, task delegation across vendors/frameworks) — complements MCP (tools) with an agent-to-agent layer. ([A2A](https://a2a-protocol.org/latest/))
- **Agentspace / Gemini Enterprise** — enterprise agent hub: register/manage ADK + A2A agents, enterprise search over company data, prebuilt + custom agents, governance. ([Register ADK/A2A agents in Gemini Enterprise](https://discuss.google.dev/t/new-official-docs-register-and-manage-adk-and-a2a-agents-in-gemini-enterprise/290762))
- **Gemini API Agents** — managed agent surface with connectors (data-store / BigQuery). ([Gemini API Agents](https://ai.google.dev/gemini-api/docs/agents))

**Data analysis (the strongest data-native story of the four)**
- **Gemini in BigQuery** — NL-to-SQL, **Data Engineering Agent** (autonomous pipeline building), **Data Canvas** (NL DAG-style analysis notebook), data prep agent — agents operate **inside the warehouse**.
- **Looker conversational analytics** — NL-to-insight over the governed semantic (LookML) model; conversational analytics API.
- **Gemini in Vertex / Colab Enterprise** — data science agent, notebook analysis.

**Evals / memory**
- **Vertex AI evaluation service** (agent + model evals), Agent Engine memory/session store.

### 1.4 xAI (Grok)

- **Grok API** — OpenAI-compatible **Responses endpoint** + native SDK; agent-first tool surface.
- **Agent Tools API** — server-side hosted tools: **web/X (real-time) search**, hosted **code execution / Python sandbox**, **file/collection search**; designed for tool-enabled + multi-agent workflows with real-time data. ([xAI Tools Overview](https://docs.x.ai/developers/tools/overview), [Agent Tools API](https://aiwiki.ai/wiki/agent_tools_api))
- **DeepSearch / DeeperSearch** — agentic real-time research over X + web (live-data reasoning is Grok's differentiator).
- **Function calling** — standard; community coding agents (grok-cli) wire it into terminal/multi-agent flows. ([grok-cli](https://github.com/superagent-ai/grok-cli))
- Weaker on: enterprise data-analysis surfaces, governed connectors, formal evals product.

### 1.5 Cross-cut: the emerging "agent stack" consensus

| Layer | OpenAI | Anthropic | Google | xAI |
|---|---|---|---|---|
| Agent-loop API | Responses API | Agent SDK / Managed Agents | ADK + Agent Engine | Grok Responses/Agent Tools |
| Visual builder | Agent Builder (winding down) | — (code-first) | Agent Builder (Agentspace) | — |
| Tool protocol | MCP + Connector Registry | **MCP (originator)** | MCP + **A2A** | server tools + MCP |
| Multi-agent | handoffs / agents-as-tools | subagents | ADK hierarchies + A2A | tool-enabled |
| Data analysis | Code Interpreter | Claude for Excel / Data | **Gemini in BigQuery / Looker** | code sandbox |
| Evals | Evals API (winding down) | system cards / perms | Vertex eval service | — |
| Memory | Sessions / memory | mounted memory stores | Agent Engine memory | — |
| **Sovereign / in-tenant data plane** | ❌ | ❌ | partial (VPC-SC) | ❌ |

The whole industry is standardizing on **MCP (tools) + A2A (agent-to-agent)**. Loom is well-positioned because it already speaks MCP natively.

---

## 2. Loom's current AI / agent surfaces (repo-grounded)

All paths under `E:\Repos\GitHub\csa-inabox`. The codebase enforces `no-vaporware` + `no-fabric-dependency`, so surfaces are real-backend with honest 501/503 gates rather than stubs.

### 2.1 Copilot (assistant) — the ChatGPT/Claude-chat analog
- Global chat: `apps\fiab-console\lib\components\copilot-pane.tsx` (single Copilot window) → `/api/copilot/orchestrate`.
- Intent router: `apps\fiab-console\lib\azure\copilot-router.ts` (real AOAI `tool_choice` classifier, docs→help vs build→act).
- ACT orchestrator: `apps\fiab-console\lib\azure\copilot-orchestrator.ts` — **38+ built-in tools** across Synapse/ADLS/Databricks/ADX/ADF/Power BI/Activator/MCP; history in Cosmos `copilot-sessions`. **REAL.**
- Docs-grounded RAG assistant: `apps\fiab-console\lib\azure\help-copilot-orchestrator.ts` (Cosmos `copilot-help-sessions`).
- Per-editor Copilots (persona packs): `apps\fiab-console\lib\azure\copilot-personas.ts` + 16 `copilot-personas-*.ts` (sql/kql/dax/notebook/pipeline/lakehouse/dataflow/eventstream/graph/automl/…). Each narrows tools + system prompt for its surface.
- Copilot chat Azure Function backend (docs widget): `azure-functions\copilot-chat\function_app.py` — streamed AzureOpenAI, Learn-MCP grounding (`ms_learn.py`), content safety (`content_safety.py`), PII redaction (`redaction.py`), Cosmos persistence (`storage.py`). **REAL.**
- Second (PydanticAI) grounded Q&A copilot: `apps\copilot\agent.py`, `agent_loop.py`, with vector RAG + citation verification.

### 2.2 Model clients / strategy
- Unified AOAI client: `apps\fiab-console\lib\azure\aoai-chat-client.ts` (consolidation target, ~38 importers), SSE passthrough `aoaiChatStream`, Gov+Commercial scope-correct, `NoAoaiDeploymentError` 503 gate. **REAL.**
- Request contract: `apps\fiab-console\lib\azure\aoai-model-contract.ts` (`max_completion_tokens` only).
- APIM GenAI-gateway (opt-in, default OFF): `apps\fiab-console\lib\azure\aoai-apim-gateway.ts`.
- Embeddings: `apps\fiab-console\lib\azure\embeddings-client.ts`.
- **Tier-router:** `apps\fiab-console\lib\foundry\model-tier-router.ts` — maps task class→deployment tier from env; **wired into `aoai-chat-client.ts` (`resolveTierForTurn`) but a safe NO-OP when no tier deployments configured.** This is the key model-quality gap: no premium-reasoning tier by default.
- Runtime-tier dispatch (Foundry Agents vs MAF OSS): `apps\fiab-console\lib\azure\agent-runtime-tier.ts`.

### 2.3 MCP ecosystem (Loom's standout agentic asset)
- Deployable catalog (ACA + KV, gov-safe allow-list): `apps\fiab-console\lib\azure\mcp-catalog.ts` + provisioner `mcp-deploy-client.ts` (ARM `Microsoft.App/containerApps`, UAMI + KV secretRef). **REAL.**
- MCP client (JSON-RPC/Streamable HTTP): `apps\fiab-console\lib\azure\mcp-client.ts`; config/OBO/shim: `mcp-config-store.ts`, `mcp-obo-token-store.ts`, `mcp-shim.ts`; SSRF guard: `mcp-egress-guard.ts`.
- **Publish-as-MCP:** `lib\apps\app-mcp.ts` (Loom App→MCP tool), `lib\azure\iq-mcp.ts` (Ontology/Semantic/Signals→MCP at `/api/iq/mcp`), `lib\copilot\data-agent-mcp.ts` (data agent→`ask_<agent>` MCP).
- Hosted MCP server: `azure-functions\mcp-server\function_app.py`; stdio↔HTTP bridge: `apps\fiab-mcp-bridge\src\server.mjs`.
- Admin routes: `app\api\admin\mcp-catalog`, `mcp-servers\{deploy,builtin,bridge,ms-remote,powerbi}`.

### 2.4 Agent / multi-agent
- **Default Azure-native multi-agent orchestrator:** `apps\fiab-console\lib\azure\agent-orchestrator.ts` (AIF-4) — fans out to N sub-agents via real `chatGrounded`, synthesizes, emits `delegate` trace markers. **REAL, no Foundry required.**
- Foundry Agent Service client (opt-in): `apps\fiab-console\lib\azure\foundry-agent-client.ts` (create/list/delete agents at project endpoint; 501 gate when `LOOM_FOUNDRY_PROJECT_ENDPOINT` unset).
- Agent-flow execution + tool-kinds: `agent-flow-run.ts`, `agent-tool-kinds.ts`; canvas `lib\editors\phase4\agent-flow-canvas.tsx`.
- OSS Microsoft-Agent-Framework tier (Gov backstop): `apps\copilot-maf\src\{agent-loop,agent-run,tools}.ts`.
- Foundry-parity routes: `app\api\foundry\agents[/eval,/run,/threads]`, `items\operations-agent[/deploy,/rules,/run]`, `items\agent-flow\[id][/run]`.
- **Ontology / Object-Explorer / OSDK (the substrate agents act over):** `lib\azure\weave-ontology-store.ts` (Apache AGE graph over Postgres), `weave-explore.ts` (Object Explorer, Foundry-parity 2.6); routes `items\ontology\[id][/objects,/links,/explore,/run-action]`, `items\ontology-sdk\[id][/generate,/query,/publish]` (OSDK), `items\aip-logic\[id]\run-agent`.

### 2.5 Data agents / NL→query/insight (the BigQuery/Looker analog)
- **Data Agent runtime:** `apps\fiab-console\lib\azure\data-agent-client.ts` — grounds NL over up to 5 typed sources (Warehouse/Lakehouse/KQL/Semantic model/AI Search); `data-agent-execute.ts` runs the per-source query. Routes `items\data-agent\[id]\{chat,evaluate,deploy,publish,m365-copilot,mcp}`. **REAL.**
- NL→query compilers: `wells-to-sql.ts` (T-SQL/Synapse), `wells-to-kql.ts` (ADX, wired into live Get-Data), `aas-dax.ts` (DAX/AAS), `copilot-query-builder.ts`.
- NL assist edges (real AOAI on live schema): `items\{synapse-*-sql-pool,warehouse,databricks-sql-warehouse}\[id]\model`, `kql-database\[id]\assist`, `azure-sql-database\[id]\copilot`, `semantic-model\[id]\{copilot-structure,dax-query}`, `report\[id]\powerbi-copilot`, `dataflow\copilot`, pipeline copilots.
- SQL Copilot editor UI: `apps\fiab-console\lib\components\editor\sql-copilot-editor.tsx` (NL→SQL / explain / fix bar).
- Tabular/Semantic-Link parity read + DAX eval: `lib\azure\tabular-eval-client.ts`.

### 2.6 Evals / guardrails / observability
- Eval harness (Python): `apps\copilot\evals\` — `harness.py`, `scorer.py`, `rubrics.py`, `regression.py`, goldens + baseline (LLM-judge + regression). **REAL.**
- Ops-agent evaluator (timer-triggered): `azure-functions\ops-agent-evaluator\src\evaluator-core.ts` (Cosmos→ADX→AOAI reasoning→Teams approval).
- Eval routes: `foundry\agents\eval`, `foundry\evaluations`, `items\data-agent\[id]\evaluate`, `items\ai-red-team\[id]\run` (AI red-teaming).
- Guardrails: content safety (`content_safety.py`), PII redaction (`redaction.py`), Prompt Shields via `foundry-client.ts` (`shieldPrompt`/`moderateContent`), SSRF guard (`mcp-egress-guard.ts`), capacity guardrails (`capacity-guardrails.ts`), **DSPM for AI** (`dspm-ai-client.ts` — which agents touch sensitive-labeled data).
- Observability: `lib\foundry\agentops.ts` (usage/latency rollup), `cost-estimate.ts`, admin `copilot-usage.tsx` / `copilot-slo-card.tsx`; routes `foundry\observability`, `admin\copilot-usage`.

### 2.7 Memory
- Copilot long-term memory (CTS-08): `lib\azure\memory-store.ts` (Cosmos `copilot-memory` SoR + AI Search vector mirror), `memory-recall.ts`, `memory-consolidate.ts`, `memory-flush.ts`, scope-isolation guard `lib\copilot\memory-write-guard.ts`. **REAL.**
- Agent memory + thread persistence (AIF-14): `lib\azure\agent-memory-client.ts` (Cosmos `loom-agent-memory`, thread resume + fact recall).

---

## 3. Graded parity matrix

Grades: A+ (exceeds frontier), A (at parity), B (functional, behind on polish/scale), C (partial), D (stub/gated), F (absent). Honest.

| Capability | Frontier reference | Loom surface (file) | Grade | Gap |
|---|---|---|---|---|
| Conversational assistant (chat) | ChatGPT / Claude | `copilot-pane.tsx` + `copilot-orchestrator.ts` (38+ tools) | **B+** | Model reasoning quality below GPT-5/Claude-Opus tier; single window vs rich multimodal canvas |
| Agent-loop / tool-use API | Responses API / Agent SDK | `copilot-orchestrator.ts`, `agent-flow-run.ts` | **B** | Internal, not a published developer API/SDK; no external Responses-compatible endpoint |
| Multi-agent orchestration | Agents SDK handoffs / ADK / subagents | `agent-orchestrator.ts` (fan-out+synthesize) | **B** | Works; lacks agent-as-tool graph depth, handoff semantics, A2A interop |
| Visual agent builder | OpenAI Agent Builder / Agentspace | `agent-flow-canvas.tsx` | **C** | Canvas exists but not at frontier builder polish/feature depth; not the product centerpiece |
| Tool protocol — MCP | MCP (Anthropic) | `mcp-client.ts`, `mcp-catalog.ts`, publish-as-MCP | **A** | **Loom is MCP-native both directions (consume + publish) — genuine parity** |
| Agent-to-agent protocol | A2A (Google) | — (no A2A agent cards / cross-vendor delegation) | **F** | No A2A support; can't federate with external ADK/Foundry agents |
| Connector/tool registry | Connector Registry / Connectors | `mcp-catalog.ts` (allow-list) + 70 connectors | **B** | Governed catalog exists; less breadth than OpenAI/Google SaaS connector libraries |
| Code interpreter / data analysis sandbox | ChatGPT Code Interpreter / Claude Excel | notebook-editor + Spark; no ephemeral per-chat Python sandbox in chat | **C** | No in-chat sandboxed Python "analyze this file" loop; analysis is via notebook/warehouse, not conversational sandbox |
| NL→SQL / NL→query | Gemini in BigQuery / Looker | `wells-to-sql.ts`, `wells-to-kql.ts`, `sql-copilot-editor.tsx` | **A-** | Strong, multi-engine, real backend; less polished NL UX than Looker conversational analytics |
| Data agent (ask-your-data) | Gemini data agents / Looker CA | `data-agent-client.ts` (5-source grounding) | **A-** | Real, multi-source, publishable-as-MCP; UX/eval polish behind Google |
| NL→insight over semantic model | Looker LookML conversational | `tabular-eval-client.ts`, `semantic-model\copilot-*` | **B+** | Real DAX/tabular over AAS/Synapse; no Power BI dependency |
| Autonomous data-engineering agent | BigQuery Data Engineering Agent | pipeline copilots, `operations-agent` | **C** | Copilot-assisted, not fully autonomous pipeline-building agent |
| Agent evals | Evals API / Vertex eval service | `apps\copilot\evals\`, `foundry\evaluations`, `ai-red-team` | **B** | Real harness + red-team; not surfaced as a first-class product page/dashboard |
| Guardrails / safety | Moderation / Prompt Shields / Constitutional | content-safety, Prompt Shields, DSPM-for-AI | **A-** | **DSPM-for-AI (agent-touches-sensitive-data) exceeds most labs**; core moderation at parity |
| Agent memory | Managed Agents memory / sessions | `memory-store.ts`, `agent-memory-client.ts` | **A-** | Cosmos SoR + vector mirror + scope guard — strong; less "automatic" than mounted store |
| Observability / AgentOps | tracing / Vertex | `agentops.ts`, `copilot-usage`, `foundry\observability` | **B** | Real usage/latency/cost; not a unified trace-timeline UI at frontier depth |
| Realtime / voice agent | OpenAI Realtime | — | **F** | No speech-to-speech agent surface |
| Computer use / GUI agent | Operator / Claude computer-use | `foundry\browser-tool` (limited) | **D** | Minimal; no general computer-use agent |
| **Sovereign / in-VNet / Gov agentic runtime** | none of the four | entire stack (ACA in-VNet, Gov CI, UAMI) | **A+** | **No frontier lab offers this — Loom's moat** |
| **Agents acting via real Azure data plane** | none (labs act via connectors, not owned data plane) | orchestrator tools hit Synapse/ADX/ADF/ARM directly | **A+** | Agents perform real governed data-plane actions, not just retrieval |

**Aggregate agentic-AI grade: B / B+.** Loom is at or near parity on the *primitives* (MCP, multi-agent, data agents, memory, evals, guardrails) and **ahead on sovereignty + governed-data-plane action**, but behind on *model reasoning quality*, *visual agent-builder polish*, *A2A interop*, *conversational code-interpreter*, and *realtime/computer-use*.

---

## 4. Gaps & recommendations (prioritized)

**P0 — close the model-quality gap (the single biggest lever)**
1. **Wire the tier-router for real.** `model-tier-router.ts` is a no-op without tier deployments. Ship a default 3-tier config (mini / standard / **reasoning**) bound to the best AOAI reasoning deployment available in each cloud, and route hard analytical/agentic turns to the strong tier automatically. Today every turn rides one default deployment — that caps agent quality regardless of orchestration.
2. **Reasoning-mode for data agents.** Give `data-agent-client.ts` a planner→execute→verify loop on the reasoning tier for multi-hop analytical questions (frontier data agents plan before querying).

**P1 — make the agentic surface a first-class product**
3. **Visual agent-builder canvas at frontier polish.** Elevate `agent-flow-canvas.tsx` to an Agentspace/Agent-Builder-grade builder: drag agents + tools + MCP servers + ontology objects onto a canvas, wire handoffs, set guardrails/evals inline, publish as MCP/API. This is where OpenAI (retiring theirs) leaves an opening.
4. **A2A protocol support.** Implement A2A agent cards + task delegation so Loom agents can federate with external ADK/Foundry/Copilot-Studio agents and vice-versa. Pair with existing MCP to be the only sovereign platform speaking *both* industry standards.
5. **Unified Agent Evals + Observability product page.** Consolidate `apps\copilot\evals\`, `foundry\evaluations`, `ai-red-team`, and `agentops.ts` into one Admin "Agent Quality" surface: eval sets, LLM-judge scores, regression vs baseline, red-team results, per-agent trace timelines, cost/latency SLOs. The plumbing exists; it needs a product face.

**P2 — fill the analysis-UX gaps**
6. **Conversational code-interpreter.** Add an in-chat ephemeral Python sandbox (Spark-serverless or ACA job) so users can "upload/point at this data and analyze it" conversationally with generated charts — matching ChatGPT ADA / Claude-for-Excel, but over governed lakehouse data.
7. **NL-insight everywhere.** Ensure every data surface (every table, report, dashboard, ontology object) has an "ask" affordance backed by `data-agent-client.ts` — Google's advantage is NL-analytics *embedded in the data tools*, not a separate chat.
8. **Autonomous data-engineering agent.** Promote pipeline copilots to a Data-Engineering Agent that can build/repair a Synapse/ADF pipeline end-to-end from a goal (BigQuery Data Engineering Agent parity).

**P3 — breadth**
9. Realtime/voice agent surface (Realtime-API parity) for ops/analyst voice workflows.
10. Broaden the governed connector/MCP catalog toward the OpenAI/Google SaaS-connector breadth while keeping the gov-safe allow-list model.

---

## 5. Burn-the-box ideas — why Loom can be #1 at data + AI + agents + sovereignty

The frontier labs are locked out of the one thing that matters most for enterprise/government analytics: **they do not own, and cannot run inside, the customer's governed data estate.** They reach data through connectors, over the public internet, on their infrastructure. Loom runs **where the data, the ontology, and the governance already live** — in the customer's VNet, in their subscription, in Gov clouds. That is an un-copyable structural advantage. Lean into it:

1. **Agentic analytics over a governed ontology (the killer surface).** Loom already has an Apache-AGE ontology (`weave-ontology-store.ts`), an Object Explorer (`weave-explore.ts`), OSDK, and data agents. Fuse them: **multi-agent workloads that reason over the *semantic ontology* — objects, links, actions — not raw tables.** An agent asks "which customers are at churn risk and why," traverses the ontology graph, joins Signals from ADX, and **executes a real action** (write-back, open a case, trigger an Activator alert) via the governed data plane. Palantir-AIP-parity, but Azure-native and sovereign. No frontier lab has an ontology substrate for agents to act over.

2. **Sovereign multi-agent runtime (Gov-capable, air-gap-safe).** Loom's MCP catalog already has air-gap-safe / azure-internal / external-saas egress profiles and a gov-safe allow-list. Productize **"multi-agent workloads that never leave the tenant"**: every agent, every tool, every model call stays inside the VNet, auditable, on Gov infrastructure. Sell this as the only agentic platform an IL5/classified customer can actually run. Frontier labs literally cannot compete here.

3. **Agents that *act* through the real Azure data plane — not just chat.** The orchestrator's 38+ tools already hit Synapse/ADX/ADF/ARM/Databricks directly. Make **action** the headline: a data agent doesn't just answer, it **provisions a warehouse, runs a TDS query, rebuilds a pipeline, applies a Purview classification, grants access** — every action governed, RBAC-checked, DSPM-screened (`dspm-ai-client.ts`), and audit-logged. Frontier agents retrieve; Loom agents *operate the estate*.

4. **Governed-by-construction agent memory + evals.** Loom's memory is scope-isolated by tenant (`memory-write-guard.ts`), vector-mirrored, and audited; its evals include AI red-teaming and DSPM-for-AI. Package this as **"trustworthy agents by default"** — the compliance-grade agent platform (audit trail on every agent action, sensitivity-aware memory, red-teamed before deploy). This is the enterprise buyer's actual blocker to adopting OpenAI/Anthropic agents; Loom answers it out of the box.

5. **Speak both industry standards (MCP + A2A), sovereignly.** Loom is already MCP-native both directions. Add A2A. Then Loom becomes the **sovereign interop hub**: external ADK/Foundry/OpenAI agents delegate governed data tasks *into* Loom (where the data + governance are), and Loom agents publish themselves as MCP tools / A2A agents to the outside world. Loom = the trusted, in-tenant execution layer for the whole multi-vendor agent ecosystem.

**One-line positioning:** *Every frontier lab gives you a smart agent that has to reach into your data from the outside. Loom gives you a governed, sovereign, multi-agent workforce that already lives inside your data estate, reasons over your ontology, and acts through your real Azure data plane — commercial or Gov.*

---

## 6. Sources
- OpenAI AgentKit — https://openai.com/index/introducing-agentkit/
- OpenAI new tools for building agents (Responses API) — https://openai.com/index/new-tools-for-building-agents/
- OpenAI Agents SDK — https://openai.github.io/openai-agents-python/models/
- ChatGPT data analysis / code interpreter — https://help.openai.com/en/articles/8437071-data-analysis-with-chatgpt
- Anthropic Claude Agent SDK subagents — https://code.claude.com/docs/en/agent-sdk/subagents
- Anthropic managed-agents memory — https://platform.claude.com/docs/en/managed-agents/memory
- Anthropic MCP docs — https://docs.anthropic.com/en/docs/mcp
- MCP 2026-07-28 release candidate — https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
- Claude for Excel — https://claude.com/docs/office-agents/excel
- Google Vertex AI Agent Builder — https://cloud.google.com/blog/products/ai-machine-learning/more-ways-to-build-and-scale-ai-agents-with-vertex-ai-agent-builder
- Google ADK / A2A extension — https://adk.dev/a2a/a2a-extension/
- A2A protocol — https://a2a-protocol.org/latest/
- Register ADK/A2A agents in Gemini Enterprise — https://discuss.google.dev/t/new-official-docs-register-and-manage-adk-and-a2a-agents-in-gemini-enterprise/290762
- Gemini API Agents — https://ai.google.dev/gemini-api/docs/agents
- xAI tools overview — https://docs.x.ai/developers/tools/overview
- xAI Agent Tools API — https://aiwiki.ai/wiki/agent_tools_api
- grok-cli — https://github.com/superagent-ai/grok-cli
