# PRP — Copilot & AI at full Microsoft-Fabric parity, Azure-native

> **Status:** Implementation-ready.
> **Owner experience:** CSA Loom › Copilot & AI (every Copilot surface across all workloads + the cross-item Copilot + AI functions).
> **Parity target:** Microsoft Fabric "Copilot & AI" — the Copilot chat panel and inline AI across Data Engineering/Science (Notebooks), Data Factory (Dataflow Gen2 + Pipelines), Data Warehouse, Real-Time Intelligence (KQL), Power BI (DAX/semantic model/reports), Activator, Data Agents, plus the common interaction model (slash commands, suggested prompts, approval-diff, feedback, conversation history) and the underlying Azure OpenAI inference.
> **Hard rule:** Per `.claude/rules/no-fabric-dependency.md`, **every feature here must be 100% functional on Azure-native backends by default, with a real Microsoft Fabric capacity / workspace and a real Power BI workspace UNSET.** Fabric / Power BI Copilot is opt-in only. Per `.claude/rules/no-vaporware.md`, **no stubs, no mock arrays, no `return []` placeholders** — each task lands real backend calls (real Azure OpenAI completion, real NL2X execution against a real engine, real Cosmos persistence) or an honest infra-gate MessageBar naming the exact env var / role / resource. Per `.claude/rules/ui-parity.md`, each surface gets a parity doc and must match the source Copilot UI one-for-one (theme differs, functionality does not). Per the no-freeform-config rule, prompts are natural language but every applied result (code, query, transform step) flows through an approval-diff before commit.

---

## 1. Overview + Azure-native + OSS architecture (all 4 cloud types)

### 1.1 What this experience is

Microsoft Fabric's "Copilot & AI" is not a single item — it is a **cross-cutting assistant** that appears inside every workload editor as a collapsible chat panel plus inline affordances (slash commands, suggested prompts, inline completion, "Fix with Copilot", approval-diff, thumbs feedback, 28-day conversation history). It is powered by **Azure OpenAI Service** (GPT-family, Microsoft-managed; the user cannot pick or fine-tune the model). It also includes AI functions in notebooks and Semantic Link reads of Power BI models.

CSA Loom rebuilds this 1:1 as a **single unified Copilot runtime with per-context personas** — same chat UX everywhere, but the system prompt + tool catalog are selected by the active editor pane. There is **no dependency on a real Fabric capacity, a Power BI workspace, or any Fabric Copilot capacity**. Inference is the deployer's own **Azure OpenAI** deployment; every NL2X tool executes against the corresponding Azure-native engine already built in Loom (Synapse SQL, ADX/Kusto, the M-engine, the Loom tabular layer, etc.).

### 1.2 Azure-native + OSS backing services

| Concern | Azure-native DEFAULT | OSS component | Loom client / module |
|---|---|---|---|
| Inference / model | **Azure OpenAI Service** (gpt-4o / gpt-4.1 / o3-mini / gpt-5.1) — `*.openai.azure.com` (Comm) / `*.openai.azure.us` (Gov) | — | `lib/azure/copilot-orchestrator.ts` (`resolveAoaiTarget`) |
| Agent orchestration (Comm/GCC) | **Azure AI Foundry Agent Service** (thread persistence, MCP tools, Entra Agent ID) | — | `copilot-orchestrator.ts` |
| Agent orchestration (GCC-High/IL4/IL5) | **Azure OpenAI direct** + **Microsoft Agent Framework (MAF) 1.0** as a Container App / AKS | MAF SDK (OSS) | `copilot-orchestrator.ts` (MAF tier) |
| Thread / session persistence | **Azure Cosmos DB** (`loomdb / copilot-sessions`, PK `/sessionId`, 28-day TTL) | — | `lib/azure/cosmos-client.ts` |
| Telemetry + feedback | **Azure Application Insights** (`appinsights-csa-loom`) | — | `azure-functions/copilot-chat/function_app.py` |
| Identity / auth | **Microsoft Entra ID** — On-Behalf-Of (OBO) on every tool call | — | `lib/auth/*` |
| Content safety | **Azure AI Content Safety** (on the Foundry hub) | — | `copilot-chat/function_app.py` pipeline |
| PII redaction / off-topic / prompt-injection | Existing `copilot-chat` post-processing pipeline | Presidio (optional OSS) | `copilot-chat/function_app.py` |
| NL2SQL engine | **Synapse Serverless / dedicated SQL** | — | `synapse-sql-client` |
| NL2KQL engine | **Azure Data Explorer (ADX)** | — | `kusto-client` |
| NL2DAX / semantic model | **Loom-native tabular layer** over warehouse/lakehouse (AAS optional) | — | `synapse-sql-client` + tabular model |
| NL→M (Dataflow) | **Loom M-engine / Mashup** runtime | Power Query SDK (OSS bits) | `dataflow-engine-client` |
| NL→PySpark/SQL (notebook) | **Synapse Spark Livy** / Databricks | Apache Spark | `synapse-livy-client` |
| Doc / workspace grounding (RAG) | **Azure AI Search** (`loom-items` + `loom-docs` indexes) | — | `ai-search-client` |
| Notebook AI functions | **Azure OpenAI** invoked from Spark (pandas/Spark UDF) | OSS `synapse-ml` openai utils | `synapse-livy-client` + AOAI |

There is **no Fabric Copilot capacity** in Azure. Loom uses the deployer's own AOAI deployment ("Loom Copilot Capacity") and meters usage to Application Insights + Cost views. All "Power BI semantic model" reads go through the Loom-native tabular layer, never `api.powerbi.com`, on the default path.

### 1.3 Cloud portability matrix (the 4 cloud types)

| Backend | Commercial | GCC | GCC-High / IL4 | DoD IL5 | Endpoint / caveat |
|---|---|---|---|---|---|
| Azure OpenAI | GA | GA (GCC endpoints) | GA (`usgovvirginia`/`usgovarizona`: gpt-4o, gpt-4.1, o3-mini, gpt-5.1) | GA (same Gov catalog) | `*.openai.azure.com` vs `*.openai.azure.us`; model availability differs per region |
| Foundry Agent Service | GA (eastus2) | GA | **not Gov-wide GA → fall back to MAF** | not confirmed → MAF | portal `ai.azure.com` Comm/GCC only |
| MAF orchestrator (Container App/AKS) | optional | optional | **required tier** | **required tier** | runs in-boundary; no external dependency |
| Cosmos DB | GA | GA | GA | GA | `documents.azure.com` vs `documents.azure.us` |
| App Insights | GA | GA | GA | GA | connection string per cloud |
| AI Content Safety | GA | GA | verify region | verify region | honest-gate if region-absent |
| Azure AI Search | GA | GA | GA | GA | `search.windows.net` vs `search.azure.us` |
| ADX / Synapse SQL / Spark | GA | GA | GA | GA (verify SKU/region) | resolved via `cloud-endpoints` helper |

**Implication for code:** every AOAI / Cosmos / Search / engine host MUST resolve through the existing `cloud-endpoints` helper and `resolveAoaiTarget()`, **never hard-coded**. The orchestration tier (Foundry Agent Service vs MAF-direct) is auto-selected from `environment().name` per ADR fiab-0009. Any new client a task adds routes through that helper and gets a cloud-matrix unit test.

### 1.4 Runtime + persona topology in Loom

```
Unified Copilot Runtime
 ├─ apps/copilot/ (PydanticAI agent — local/dev + library use)
 ├─ azure-functions/copilot-chat/function_app.py (content-safety + PII + feedback + telemetry pipeline)
 ├─ apps/fiab-console BFF: /api/copilot/orchestrate (SSE), /api/copilot/sessions[/[id]], /api/copilot/tools, /api/copilot/status
 ├─ lib/azure/copilot-orchestrator.ts (resolveAoaiTarget, tier select, tool dispatch, OBO)
 ├─ lib/azure/copilot-config-store.ts (admin AOAI config in Cosmos)
 └─ lib/components/copilot-pane.tsx (right-side collapsible drawer, SSE render, approval-diff)

Per-context persona = (system prompt + tool catalog) selected by active pane:
  loom-copilot (console)        notebook-copilot     warehouse-copilot
  dataflow-copilot              kql-copilot          dax-copilot
  activator-copilot             agent-config-copilot ops-copilot
  loom-deploy-agent (wizard)    cross-item-copilot (full-screen /copilot, 32 tools)
```

---

## 2. Feature-by-feature parity table (incl. current Loom status + work needed)

Legend — **Status:** ✅ built · ⚠️ honest-gate (renders, partial backend, MessageBar) · 🔶 stub · ❌ missing.

| # | Fabric Copilot feature | Azure-native backend | Loom UI | Portability | Status today | Work needed |
|---|---|---|---|---|---|---|
| F1 | Common chat panel (collapsible side pane, streamed responses) | AOAI via orchestrator; Cosmos history | Right-side drawer `copilot-pane.tsx`, SSE bubbles, input, toggle | all clouds | ✅ built | none (type-aware rendering in **T7**) |
| F2 | AOAI inference + admin config | AOAI deployment; config in Cosmos | Admin AOAI config form; 503 honest-gate w/ ai.azure.com deep-link | Comm/GCC GA; Gov via env | ✅ built | verify Gov endpoint resolution (**T1**) |
| F3 | Per-pane context auto-load (active query/schema/workspace into prompt) | orchestrator context resolver | Pane passes `contextSlug` + payload; persona selected server-side | all | 🔶 stub (single `loom-copilot` persona) | **T2** context resolver + persona registry |
| F4 | Suggested-prompt buttons (per-pane seeded) | static per-persona seed + dynamic from context | Chips above input, click → send | all | ⚠️ partial (one seed msg) | **T3** per-persona suggested prompts |
| F5 | Slash commands `/explain /fix /comments /optimize` | persona tool dispatch | Command palette + inline parse in pane | all | ❌ missing | **T4** slash-command parser + tools |
| F6 | Approval-diff view before applying code | orchestrator returns proposed-change; UI diffs | Monaco diff modal: keep / undo | all | ❌ missing | **T5** approval-diff component |
| F7 | Thumbs up/down feedback + clear chat + 28-day history | Cosmos `copilot-sessions` (+ feedback doc), TTL 28d | Per-message thumbs; "Clear chat"; history list | all | ⚠️ partial (history yes; feedback inherited) | **T6** feedback UI wired to function pipeline + history drawer |
| F8 | Type-aware result rendering (code / table / chart / summary) | tool result `kind` discriminator | Render code block / DataGrid / chart / markdown per kind | all | 🔶 stub (raw JSON shown) | **T7** typed result renderer |
| F9 | Notebook chat (notebook-wide multi-cell gen, refactor, summarize, profile, perf insights) | AOAI + Livy context (schemas, runtime telemetry) | `notebook-copilot` persona; multi-cell apply via diff | Comm/Gov | ❌ missing | **T8** notebook chat persona + multi-cell apply |
| F10 | Notebook in-cell Copilot (`/explain /fix /comments /optimize` + freeform) | AOAI per-cell; Spark error logs for `/fix` | Cell toolbar AI button → command menu + prompt box | Comm/Gov | ❌ missing | **T9** in-cell Copilot |
| F11 | Notebook inline code completion (autocomplete as you type) | AOAI completion (low-latency model) | Monaco inline-completion provider | Comm/Gov | ❌ missing | **T10** inline completion provider |
| F12 | "Fix with Copilot" (auto-surface under failed cell/Spark job) | AOAI + cell code + Livy error/log | Inline "Fix" banner under failed output → diff | Comm/Gov | ❌ missing | **T11** fix-with-copilot banner |
| F13 | Notebook AI functions (LLM in Spark/pandas) | AOAI invoked from Spark UDF | `ai.*` helper library + docs; runs in Livy | Comm/Gov | ❌ missing | **T12** AI functions library + grounding |
| F14 | Dataflow Gen2 Copilot (NL→query, gen w/ sample/ref, explain, gen steps, undo step) | AOAI → Loom M-engine applied-steps | `dataflow-copilot`; each action = response card + Applied Step | Comm/Gov | ❌ missing | **T13** dataflow copilot + applied-step apply |
| F15 | Pipeline Copilot (NL→full pipeline, `/` source/dest completion, run from chat, summarize, error assistant) | AOAI → pipeline JSON over Synapse/ADF | `pipeline` persona on canvas; generate nodes + run | Comm/Gov | ❌ missing | **T14** pipeline copilot + canvas apply + error assistant |
| F16 | Warehouse / SQL Copilot (NL2SQL, explain, fix, optimize, quick actions) | AOAI → Synapse SQL (real exec) | `warehouse-copilot` in SQL editor; insert into editor + run | Synapse Comm/Gov | ⚠️ honest-gate (generic pane, no SQL tools) | **T15** NL2SQL tools + editor insert |
| F17 | KQL Copilot (NL2KQL, explain) | AOAI → ADX (real exec) | `kql-copilot` in KQL editor | ADX Comm/Gov | ⚠️ honest-gate | **T16** NL2KQL tools + editor insert |
| F18 | DAX / semantic-model Copilot (NL2DAX, explain DAX, optimize, measure descriptions) | AOAI → Loom tabular layer | `dax-copilot` in DAX view; insert measure | Comm/Gov | ❌ missing | **T17** NL2DAX over Loom tabular |
| F19 | Report Copilot (narrative/summary, suggest visuals) | AOAI → Loom-native report renderer | `report` persona in report builder | Comm/Gov | ❌ missing | **T18** report copilot (narrative + visual suggest) |
| F20 | Activator Copilot (rule author, threshold suggest) | AOAI → Monitor alert rule model | `activator-copilot`; generate rule + threshold | Comm/Gov | ❌ missing | **T19** activator copilot |
| F21 | Data Agent config Copilot (example-query gen, field-description gen) | AOAI → data-agent config store | `agent-config-copilot` in agent editor | Comm/Gov | ⚠️ partial (data-agent exists) | **T20** agent-config copilot edges |
| F22 | Ops / admin Copilot (capacity scale, OAP toggle, workspace create) | AOAI → ARM / config tools (real) | `ops-copilot` in admin pane | Comm/Gov | ❌ missing | **T21** ops copilot tools |
| F23 | Cross-item Copilot (full-screen, 32 tools spanning all services) | AOAI + full tool registry | `/copilot` page; tool transcript | Comm/Gov | ✅ built (orchestrator + page) | verify all 32 tools real (**T22**) |
| F24 | Semantic Link read (Copilot reads PBI model) | Loom tabular layer (no Power BI) | model picker in notebook/DAX persona | Comm/Gov | ❌ missing | **T23** tabular read tool |
| F25 | MAF orchestration tier (GCC-High/IL5) | MAF Container App + AOAI direct | transparent; same UI | Gov-High/IL5 | 🔄 deferred | **T24** MAF tier + bicep |
| F26 | Usage metering + cost (per-persona token spend) | App Insights custom metrics → Cost view | Admin "Copilot usage" panel | all | ❌ missing | **T25** metering + usage panel |
| F27 | Responsible-AI / content-safety gate (post-processing) | AI Content Safety + function pipeline | blocked-response MessageBar w/ reason | Comm/GCC GA; Gov verify | ⚠️ partial (pipeline exists) | **T26** wire safety verdict to all personas + honest-gate |
| F28 | Foundry Copilot capacity opt-in (Fabric/PBI Copilot as alt) | opt-in only behind env flag | settings toggle; default Azure path silent | n/a | ❌ missing | **T27** documented opt-in flag (no default gate) |

---

## 3. Azure / OSS services — full feature set + native UI surfaces to rebuild 1:1

For each backing service, inventory the real UI first (per `ui-parity.md`, grounded in Microsoft Learn via `microsoft_docs_search` / `microsoft_docs_fetch`), then build it one-for-one.

### 3.1 Azure OpenAI Service
- **Capabilities:** chat completions (streaming + non-stream), JSON / structured output, function/tool calling, low-latency completion models for inline autocomplete, content filters, deployment-per-model, per-region model catalog (gpt-4o, gpt-4.1, o3-mini, gpt-5.1), token usage in response.
- **Native UI to mirror:** the AOAI **deployment config** (deployment name, model, capacity/TPM) appears in Loom's **Admin › Copilot AOAI** form. The **chat playground** experience maps to the Loom Copilot pane (system prompt is Loom-managed per persona; user does not pick the model — parity with Fabric's "no model selection").
- **Loom client:** `copilot-orchestrator.ts` `resolveAoaiTarget()`; admin config in `copilot-config-store.ts`.

### 3.2 Azure AI Foundry Agent Service
- **Capabilities:** thread/run lifecycle, tool calling, MCP tool registration, Entra Agent ID, code-interpreter, file search, persisted threads.
- **Native UI to mirror:** Foundry portal "Agents" → Loom maps thread/run to its own `copilot-sessions` + step transcript. Foundry's **tool catalog** maps to Loom's per-persona tool catalog surfaced in `/api/copilot/tools`.
- **Loom client:** orchestrator Foundry tier (Comm/GCC).

### 3.3 Microsoft Agent Framework (MAF) — OSS
- **Capabilities:** agent loop, tool dispatch, AOAI-direct binding, runs in-boundary as a Container App / AKS workload; no external Foundry dependency.
- **Native UI to mirror:** identical to Foundry tier from the user's perspective — same Copilot pane, same transcript. Difference is internal.
- **Loom client:** orchestrator MAF tier (Gov-High/IL5).

### 3.4 Azure AI Content Safety
- **Capabilities:** text/image moderation categories + severities, prompt-shield (jailbreak/prompt-injection), groundedness detection.
- **Native UI to mirror:** Fabric's invisible post-processing → Loom shows a **blocked-response MessageBar** with the moderation reason when content is filtered. Admin can view category thresholds.
- **Loom client:** `copilot-chat/function_app.py` safety stage.

### 3.5 Azure Cosmos DB (sessions/history)
- **Capabilities:** per-session thread doc, message array, 28-day TTL, feedback docs, PK `/sessionId`.
- **Native UI to mirror:** Fabric "conversation history (28 days, clearable)" → Loom history drawer + "Clear chat".
- **Loom client:** `cosmos-client.ts`; routes `/api/copilot/sessions[/[id]]`.

### 3.6 Engines for NL2X (the "do the thing" backends)
- **Synapse SQL** (NL2SQL, EXPLAIN, optimize) — real T-SQL exec + result grid.
- **ADX/Kusto** (NL2KQL, explain) — real Kusto exec.
- **Loom tabular layer** (NL2DAX, measure descriptions) — real model eval, no Power BI.
- **Loom M-engine** (NL→M applied steps) — real transform preview.
- **Synapse Spark Livy** (NL→PySpark/SQL, `/fix` from real error logs, AI functions) — real cell exec.
- **Monitor alert model** (activator rule author) — real rule create.
- **ARM / config** (ops copilot) — real scale / toggle / create.
Each tool MUST execute against the real engine and return real rows / real applied step / real created resource — never a canned response (no-vaporware).

---

## 4. TASK LIST

Each task is independently shippable, lands real backend calls (no stubs / placeholders / mocks), and ends with an honest-gate MessageBar only where infra is genuinely absent. Tasks are ordered so foundation (T1–T7) precedes per-workload personas (T8–T23) and the Gov/ops tail (T24–T28).

**Conventions for every task:** TypeScript strict (no `any` on public surfaces); BFF routes return `{ ok, data, error }` with correct HTTP status; OBO Entra token on every tool call; all hosts via `cloud-endpoints` / `resolveAoaiTarget`; new client gets a cloud-matrix unit test; parity doc at `docs/fiab/parity/copilot-<slug>.md` updated.

---

### T1 — Verify + harden AOAI target resolution across all 4 clouds
- **Goal:** `resolveAoaiTarget()` correctly returns the right `*.openai.azure.com` / `*.openai.azure.us` endpoint, deployment, and API version for Commercial / GCC / GCC-High / IL5, and surfaces a precise honest-gate when no deployment is configured.
- **Files:** `lib/azure/copilot-orchestrator.ts`, `lib/azure/copilot-config-store.ts`, `lib/azure/cloud-endpoints.ts`, `app/api/copilot/status/route.ts`.
- **Backend/REST:** AOAI `POST /openai/deployments/{deployment}/chat/completions?api-version=...`; config read from Cosmos `copilot-config`.
- **Bicep/portability:** add `LOOM_AOAI_ENDPOINT`, `LOOM_AOAI_DEPLOYMENT`, `LOOM_AOAI_API_VERSION` to `admin-plane/main.bicep` apps env; document Gov endpoint suffix in `docs/fiab/v3-tenant-bootstrap.md`. Cloud auto-detect from `environment().name`.
- **UI:** `/api/copilot/status` returns `{ configured, endpoint, cloud, model }`; pane shows 503 honest-gate with deep-link (Comm→`ai.azure.com`, Gov→Gov portal) when unconfigured.
- **Acceptance (no stubs):** unit cloud-matrix test asserts correct host per `environment().name` (4 cases); live probe against the configured Comm AOAI returns a real completion; with `LOOM_AOAI_*` unset, pane renders the MessageBar (not a crash, not a fake reply).

### T2 — Per-pane context resolver + persona registry
- **Goal:** Replace the single `loom-copilot` persona with a registry that maps a `contextSlug` (pane) → `{ systemPrompt, toolCatalog, suggestedPrompts }`, and have the orchestrator select it server-side.
- **Files:** new `lib/azure/copilot-personas.ts` (registry), `lib/azure/copilot-orchestrator.ts` (select by slug), `app/api/copilot/orchestrate/route.ts` (accept `contextSlug` + `contextPayload`), `lib/components/copilot-pane.tsx` (emit current pane slug + payload), `lib/copilot/use-copilot-context.ts` (hook editors call to register their context).
- **Backend/REST:** orchestrator composes system prompt from persona + injected context payload (active query, schema, workspace id) before calling AOAI.
- **Bicep/portability:** none new.
- **UI:** every editor calls `useCopilotContext({ slug, payload })`; pane title reflects persona ("Notebook Copilot", "Warehouse Copilot").
- **Acceptance:** opening the SQL editor then asking "explain" produces a warehouse-flavored answer using the active query (verified by injecting a known query and seeing it referenced); switching panes changes persona; unit test asserts registry returns distinct catalogs per slug; no persona returns a hard-coded reply.

### T3 — Per-persona suggested-prompt chips
- **Goal:** Pre-seeded, context-aware suggested-prompt buttons above the input, defined per persona and optionally augmented from the live context payload.
- **Files:** `copilot-personas.ts` (`suggestedPrompts` + optional `dynamicPrompts(ctx)`), `copilot-pane.tsx` (chip row, click → send).
- **Backend/REST:** dynamic prompts computed from context payload (e.g., table names) — real values, not placeholders.
- **UI:** Fluent v9 chips; wrap; keyboard-navigable.
- **Acceptance:** notebook pane shows notebook prompts ("Summarize this notebook", "Optimize this cell"); warehouse pane shows SQL prompts; clicking a chip sends it; chips reflect real context (e.g., a real table name from the open editor).

### T4 — Slash-command parser + `/explain /fix /comments /optimize` tools
- **Goal:** Parse leading slash commands in the input and route to the matching persona tool with the active selection/cell as input.
- **Files:** new `lib/copilot/slash-commands.ts` (parser + command registry), `copilot-orchestrator.ts` (command → tool), persona catalogs add the four tools.
- **Backend/REST:** `/explain` → AOAI explain; `/fix` → AOAI + error context; `/comments` → AOAI doc-gen; `/optimize` → AOAI + engine-specific optimize hints (real EXPLAIN plan where available).
- **UI:** typing `/` shows a command menu; selected command shown as a pill; result returns through approval-diff (T5) where it changes code.
- **Acceptance:** `/explain` on a real selected query returns a plain-language explanation grounded in that query; `/fix` on a real failing cell uses the real error; unit test asserts parser extracts command + arg; commands unavailable in a persona are hidden (not stubbed).

### T5 — Approval-diff component (keep / undo)
- **Goal:** Any tool that proposes a code/query/transform change returns a `proposedChange { target, before, after }`; the pane renders a Monaco diff modal with Keep / Undo, and only on Keep is the editor mutated.
- **Files:** new `lib/components/copilot-diff.tsx`, `copilot-pane.tsx` (render on `kind:'proposed_change'`), `lib/copilot/apply-change.ts` (editor-mutation bridge per pane).
- **Backend/REST:** orchestrator emits `event: step` with `kind:'proposed_change'`.
- **UI:** Monaco `DiffEditor`; Keep applies via the registered editor bridge; Undo discards; Esc / a11y wired.
- **Acceptance:** asking notebook copilot to refactor a real cell shows a real before/after diff; Keep mutates the actual cell; Undo leaves it unchanged; no change is applied without explicit Keep.

### T6 — Feedback (thumbs) + clear-chat + history drawer
- **Goal:** Per-message thumbs up/down persisted to the `copilot-chat` feedback pipeline; "Clear chat" deletes the session; a history drawer lists prior sessions per pane (28-day TTL).
- **Files:** `copilot-pane.tsx` (thumbs + clear + history), `app/api/copilot/sessions/[id]/route.ts` (DELETE + feedback PATCH), `azure-functions/copilot-chat/function_app.py` (feedback sink), `cosmos-client.ts` (TTL).
- **Backend/REST:** feedback → Cosmos feedback doc + App Insights event; session DELETE removes the doc; history GET lists by `contextSlug` + user.
- **Bicep/portability:** ensure `copilot-sessions` container created with `defaultTtl=2419200` (28d) via cosmos init step.
- **UI:** thumbs toggle with toast; clear-chat confirm; history drawer with timestamp + first-message preview.
- **Acceptance:** thumbs writes a real feedback doc (verify in Cosmos); clear-chat empties the pane and removes the doc; history lists real prior sessions; TTL set to 28 days in container props.

### T7 — Typed result renderer (code / table / chart / summary)
- **Goal:** Render tool results by `kind` — code block (with copy + "insert into editor"), Fluent DataGrid for tabular, chart for series, markdown for summaries — replacing the current raw-JSON dump.
- **Files:** new `lib/components/copilot-result.tsx`, `copilot-pane.tsx` (dispatch on `kind`), reuse existing DataGrid + chart primitives.
- **Backend/REST:** tools tag results with `kind` (`code|table|chart|summary|proposed_change|error`) and typed `data`.
- **UI:** code → Monaco read-only + actions; table → sortable/filterable DataGrid; chart → existing chart component; summary → markdown.
- **Acceptance:** NL2SQL result renders as a real DataGrid of real rows; an explain returns markdown; raw JSON no longer shown to users; each kind has a render test.

### T8 — Notebook chat persona (multi-cell gen, refactor, summarize, profile, perf insights)
- **Goal:** `notebook-copilot` persona that is context-aware from open (no Spark session required), can generate/refactor across multiple cells, summarize the notebook, profile attached lakehouse tables, and give performance insights.
- **Files:** `copilot-personas.ts` (notebook persona + tools), `lib/editors/notebook-editor.tsx` (register context + multi-cell apply bridge), `lib/copilot/notebook-tools.ts`, `synapse-livy-client` (schema + runtime telemetry read).
- **Backend/REST:** context = workspace + attached lakehouse schemas (real catalog read) + notebook structure + last-run telemetry; AOAI generates; multi-cell changes flow through approval-diff (T5).
- **Bicep/portability:** none new (uses Spark/Livy already wired).
- **UI:** chat pane scoped to the open notebook; "apply to notebook" creates/updates real cells after diff approval.
- **Acceptance:** with a real attached lakehouse, "summarize this notebook" references real cells; "generate code to load table X and join Y" produces runnable PySpark referencing real schemas; multi-cell apply creates real cells via diff; profiling reads real table stats. No mock schema.

### T9 — Notebook in-cell Copilot (`/explain /fix /comments /optimize` + freeform)
- **Goal:** A Copilot button on each code cell opens a command menu + freeform prompt scoped to that cell.
- **Files:** `lib/components/notebook/code-cell.tsx` (AI button + menu), `notebook-tools.ts`, slash-commands (T4) reuse.
- **Backend/REST:** per-cell AOAI; `/fix` pulls the real last error/log for that cell from Livy.
- **UI:** cell toolbar AI button → menu (`/explain` etc.) + prompt box; result via approval-diff for code changes.
- **Acceptance:** `/comments` on a real cell inserts real docstrings after approval; `/optimize` suggests a real join/shuffle improvement; freeform "convert to a function" refactors the real cell. Verified on a live cell, not a fixture.

### T10 — Notebook inline code completion
- **Goal:** AI-powered inline autocomplete in code cells as the user types.
- **Files:** `code-cell.tsx` (register Monaco `InlineCompletionsProvider`), new `lib/copilot/inline-complete.ts`, `app/api/copilot/complete/route.ts`.
- **Backend/REST:** low-latency AOAI completion deployment (`LOOM_AOAI_COMPLETION_DEPLOYMENT`, falls back to chat deployment); debounce; cancel on keystroke.
- **Bicep/portability:** add the optional completion deployment env var; honest-gate to chat deployment if unset.
- **UI:** ghost-text inline suggestion; Tab accepts; Esc dismisses.
- **Acceptance:** typing a real partial statement yields a real, accept-able completion from AOAI (verify network call + token usage); debounced; works against the configured deployment; no canned suggestions.

### T11 — Fix with Copilot (auto-surface under failed cell / Spark job)
- **Goal:** When a cell or Spark job fails, an inline "Fix with Copilot" banner appears under the output offering error summary, root cause, and a recommended fix.
- **Files:** `code-cell.tsx` (failure banner), `notebook-tools.ts` (`fix` tool), `synapse-livy-client` (error + log fetch).
- **Backend/REST:** AOAI prompt = failed cell code + Livy error + execution details; returns summary + root cause + proposed change (diff).
- **UI:** banner under failed output; "Fix" → diff → Keep applies.
- **Acceptance:** force a real cell error (e.g., bad column) → banner appears using the real error text → proposed fix corrects it → re-run succeeds. No synthetic error string.

### T12 — Notebook AI functions (LLM in Spark/pandas)
- **Goal:** An `ai.*` helper library usable inside notebook cells that calls AOAI from Spark/pandas (e.g., `ai.summarize`, `ai.classify`, `ai.extract`, `ai.translate`).
- **Files:** new `apps/copilot/ai_functions/` (Python lib bundled into the Spark environment), grounding docs in `docs/fiab/`, env wiring in the Spark environment.
- **Backend/REST:** functions read `LOOM_AOAI_ENDPOINT`/key from the Spark session secrets; batch calls with retry; OBO or managed-identity token.
- **Bicep/portability:** ensure the Spark environment can reach AOAI (NSG/private-endpoint note in bootstrap doc); honest-gate in a cell if AOAI unreachable.
- **UI:** docs + a sample notebook; results render in the cell grid (T7 reused for chat, native df display in cell).
- **Acceptance:** a real cell calling `ai.classify(df['text'])` returns real labels from AOAI over real rows; failure path raises a clear, actionable error (not a silent empty df).

### T13 — Dataflow Gen2 Copilot (NL→query, gen w/ sample/ref, explain, gen steps, undo)
- **Goal:** `dataflow-copilot` that generates a new M query from NL, generates referencing sample/existing queries, explains the current query + applied steps, generates new transformation steps, and undoes the last step — each as a response card with the corresponding Applied Step.
- **Files:** `copilot-personas.ts`, new `lib/copilot/dataflow-tools.ts`, `lib/editors/dataflow-editor.tsx` (applied-steps bridge + context), `dataflow-engine-client`.
- **Backend/REST:** AOAI → M code; the Loom M-engine validates + previews; generated steps appended to the real Applied Steps list after diff approval.
- **UI:** response cards; each applied action shows in the real Applied Steps panel; "undo last step" removes the real step.
- **Acceptance:** "only keep European customers" adds a real filter step previewed against real data; "count employees by City" adds a real group-by; "explain my query" describes the real steps; undo removes the real last step. No fabricated step list.

### T14 — Pipeline Copilot (NL→pipeline, `/` source/dest completion, run, summarize, error assistant)
- **Goal:** Generate a complete pipeline from NL onto the canvas, interactive `/` completion to pick source/dest connections and emit Copy activities, run the generated pipeline from chat, summarize an existing pipeline, and an error assistant for pipeline/monitor errors.
- **Files:** `copilot-personas.ts`, new `lib/copilot/pipeline-tools.ts`, `lib/editors/pipeline-editor.tsx` (canvas apply bridge), `synapse-dev-client` / `adf-client`.
- **Backend/REST:** AOAI → pipeline JSON; nodes applied to the real React-Flow canvas after diff; "run" triggers a real pipeline run; error assistant reads the real run error.
- **UI:** canvas nodes appear after approval; "run" returns a real run id + status; summarize reads the real pipeline; error card links to Monitor.
- **Acceptance:** NL "copy from ADLS folder to SQL table" creates real Copy activity nodes with real connections; run produces a real run id with a real status; error assistant explains a real failed run. No placeholder pipeline.

### T15 — Warehouse / SQL Copilot (NL2SQL, explain, fix, optimize, quick actions)
- **Goal:** `warehouse-copilot` in the SQL editor: NL2SQL, explain a query, fix an error, optimize (with real EXPLAIN), and quick actions; results insert into the editor and run against real Synapse SQL.
- **Files:** `copilot-personas.ts`, new `lib/copilot/sql-tools.ts`, `lib/editors/warehouse-editor.tsx` / SQL pane (insert bridge + context), `synapse-sql-client`.
- **Backend/REST:** AOAI grounded on the real schema (read from Synapse) → T-SQL; "run" executes real SQL and returns real rows; optimize uses a real EXPLAIN/estimated plan.
- **UI:** "insert into editor" + "run"; result DataGrid (T7); explain → markdown.
- **Acceptance:** "top 10 customers by revenue" generates valid T-SQL grounded in the real schema and returns real rows on run; fix corrects a real syntax error; optimize cites the real plan. No schema mocking.

### T16 — KQL Copilot (NL2KQL, explain)
- **Goal:** `kql-copilot` in the KQL editor: NL2KQL grounded on real ADX schema + explain.
- **Files:** `copilot-personas.ts`, new `lib/copilot/kql-tools.ts`, KQL editor (insert + context), `kusto-client`.
- **Backend/REST:** AOAI grounded on real ADX table schema → KQL; run executes against real ADX; explain → markdown.
- **UI:** insert into editor + run; result grid.
- **Acceptance:** "count events per hour for the last day" generates real KQL that runs against a real ADX table and returns real rows; explain describes a real query. No fixture cluster.

### T17 — DAX / semantic-model Copilot (NL2DAX, explain, optimize, measure descriptions)
- **Goal:** `dax-copilot` over the **Loom-native tabular layer** (no Power BI): NL2DAX measure generation, explain DAX, optimize DAX, auto field/measure descriptions.
- **Files:** `copilot-personas.ts`, new `lib/copilot/dax-tools.ts`, DAX/semantic-model editor (insert + context), tabular eval via `synapse-sql-client`.
- **Backend/REST:** AOAI grounded on the real Loom tabular model metadata → DAX; evaluate against the real model; descriptions written to the real model metadata after approval.
- **Bicep/portability:** none new; explicitly no `api.powerbi.com` on default path.
- **UI:** insert measure; explain → markdown; "generate descriptions" updates the real model after diff.
- **Acceptance:** "create a YoY revenue measure" generates valid DAX evaluated against the real Loom model; descriptions persist to real metadata; zero Power BI calls on default path (grep gate).

### T18 — Report Copilot (narrative/summary + suggest visuals)
- **Goal:** `report` persona in the Loom-native report builder: generate a narrative summary of the report data and suggest visuals — over the Loom semantic layer, no Power BI.
- **Files:** `copilot-personas.ts`, new `lib/copilot/report-tools.ts`, report builder editor (apply bridge + context).
- **Backend/REST:** AOAI grounded on the real report's bound dataset (Loom tabular) → narrative + visual config; visuals added to the real report after approval.
- **UI:** "summarize report" narrative card; "suggest a visual" → adds a real visual after diff.
- **Acceptance:** narrative reflects real aggregates from the bound model; suggested visual is added as a real, rendering visual; no Power BI dependency.

### T19 — Activator Copilot (rule author, threshold suggest)
- **Goal:** `activator-copilot` that authors a real Monitor scheduled-query alert rule from NL and suggests thresholds from historical data.
- **Files:** `copilot-personas.ts`, new `lib/copilot/activator-tools.ts`, activator editor (apply bridge + context), `monitor-client`.
- **Backend/REST:** AOAI → alert rule model; threshold suggestion reads real historical metric data; "create" provisions a real Monitor alert rule after approval.
- **UI:** rule preview card; "create rule" → real rule id; threshold chip.
- **Acceptance:** "alert when failed logins exceed normal" creates a real Monitor alert rule with a threshold derived from real data; rule visible in Azure. No fake rule.

### T20 — Data Agent config Copilot (example-query gen, field-description gen)
- **Goal:** `agent-config-copilot` in the data-agent editor that generates example queries and field descriptions for the agent config from the real bound data source.
- **Files:** `copilot-personas.ts`, new `lib/copilot/agent-config-tools.ts`, data-agent editor (apply bridge), data-agent config store.
- **Backend/REST:** AOAI grounded on the real source schema → example queries + descriptions; written to the real agent config after approval.
- **UI:** "suggest example queries" → list inserted into config; "generate descriptions" → fields populated after diff.
- **Acceptance:** generated example queries run against the real bound source; descriptions persist to the real config doc. No placeholder examples.

### T21 — Ops / admin Copilot (capacity scale, OAP toggle, workspace create)
- **Goal:** `ops-copilot` in the admin pane that performs real ARM/config actions from NL: scale capacity, toggle OAP, create a workspace — each behind an approval-diff and an RBAC check.
- **Files:** `copilot-personas.ts`, new `lib/copilot/ops-tools.ts`, admin pane (context + apply), `arm-client` / config stores.
- **Backend/REST:** AOAI → intended action + params; on approval, executes the real ARM/config call with OBO + RBAC check; honest-gate MessageBar if the caller lacks the role.
- **UI:** action preview card with target + params; "apply" → real result; RBAC-denied → MessageBar naming the role.
- **Acceptance:** "scale the SQL pool to DW200c" executes a real ARM update after approval; "create a workspace named X" creates a real workspace; insufficient role → honest MessageBar (no silent no-op). No fake success.

### T22 — Cross-item Copilot tool audit (all 32 tools real)
- **Goal:** Verify and, where needed, fix the full-screen `/copilot` cross-item Copilot so every registered tool calls a real backend (no `return []`, no canned data).
- **Files:** `app/api/copilot/tools/route.ts`, `lib/azure/copilot-orchestrator.ts` tool registry, each tool's client.
- **Backend/REST:** each tool exercised against its real service; any stub replaced or removed from the catalog with a tracked follow-up.
- **UI:** tool transcript shows real tool calls + real results (T7 rendering).
- **Acceptance:** a scripted run invoking each of the 32 tools returns real data or an honest-gate; `grep -rE "return \[\]|return \{\}|MOCK_|SAMPLE_" lib/azure/copilot-orchestrator.ts lib/copilot app/api/copilot` returns zero un-disclosed hits; receipt attached per tool.

### T23 — Semantic Link read (Copilot reads the model, no Power BI)
- **Goal:** A `read-tabular-model` tool used by notebook + DAX personas to read the Loom-native tabular model (parity with Fabric Semantic Link), with zero Power BI dependency.
- **Files:** new `lib/copilot/tabular-read-tool.ts`, notebook + dax personas register it, tabular eval client.
- **Backend/REST:** reads real model metadata + evaluates DAX/MDX-equivalent against the Loom tabular layer; returns real measures/tables.
- **UI:** model picker; results render via T7.
- **Acceptance:** notebook copilot can list real measures/tables of a real Loom model and pull real values; no `api.powerbi.com` on default path.

### T24 — MAF orchestration tier for GCC-High / IL5
- **Goal:** A Microsoft Agent Framework Container App that binds AOAI-direct and serves the same orchestration contract as the Foundry tier, auto-selected when `environment().name` is a Gov-High/IL5 cloud.
- **Files:** `copilot-orchestrator.ts` (MAF tier client), new `apps/copilot-maf/` (MAF Container App), bicep module `platform/fiab/bicep/modules/copilot/maf.bicep`, wired into the orchestrator.
- **Backend/REST:** MAF agent loop calls Gov AOAI direct; same tool dispatch + OBO; Cosmos persistence shared.
- **Bicep/portability:** Container App + UAMI + AOAI access; env vars added to admin-plane; documented in bootstrap.
- **UI:** transparent — identical Copilot pane.
- **Acceptance:** with cloud forced to Gov-High in test, orchestration routes to MAF and returns a real AOAI completion via the Container App; same transcript shape as Foundry tier; deploys from bicep.

### T25 — Usage metering + Copilot cost panel
- **Goal:** Emit per-persona token usage to App Insights custom metrics and surface a "Copilot usage" admin panel that rolls into the Cost view.
- **Files:** `copilot-orchestrator.ts` (emit usage from AOAI `usage` field), `azure-functions/copilot-chat/function_app.py` (metric sink), new admin panel `lib/components/admin/copilot-usage.tsx`, cost view integration.
- **Backend/REST:** real `prompt_tokens`/`completion_tokens` from AOAI responses → App Insights → KQL query for the panel.
- **UI:** usage panel: tokens/cost by persona + time; honest-gate if App Insights unconfigured.
- **Acceptance:** a real Copilot call increments the metric; panel shows real token counts by persona queried from App Insights; no synthetic numbers.

### T26 — Wire content-safety verdict to every persona
- **Goal:** Route all persona responses through the AI Content Safety + PII/prompt-injection pipeline and surface a blocked-response MessageBar with the moderation reason when content is filtered.
- **Files:** `azure-functions/copilot-chat/function_app.py` (ensure safety stage on all paths), `copilot-orchestrator.ts` (honor safety verdict), `copilot-pane.tsx` (blocked MessageBar).
- **Backend/REST:** Content Safety call on input + output; on block, return `{ ok:false, error:{ reason } }`.
- **Bicep/portability:** ensure Content Safety resource on the Foundry hub; honest-gate (warning MessageBar) if absent in Gov region.
- **UI:** blocked-response MessageBar `intent="warning"` with the category/reason.
- **Acceptance:** a deliberately unsafe prompt is blocked with a real moderation reason shown (verify Content Safety call); a normal prompt passes; if Content Safety absent, honest-gate (not silent pass).

### T27 — Documented Fabric/Power BI Copilot opt-in (no default gate)
- **Goal:** Add a strictly opt-in path to use a real Fabric/Power BI Copilot capacity behind `LOOM_COPILOT_BACKEND=fabric` + a bound workspace, while the Azure-native path remains the silent default.
- **Files:** `copilot-orchestrator.ts` (opt-in branch only), `copilot-config-store.ts` (flag), settings UI toggle, parity doc.
- **Backend/REST:** only when the flag + workspace are present does the orchestrator call Fabric/PBI Copilot; otherwise Azure-native, no message.
- **Bicep/portability:** flag documented; never on default path.
- **Acceptance:** with the flag unset, zero `api.fabric.microsoft.com` / `api.powerbi.com` calls (grep gate) and the Copilot works fully; with the flag + workspace set, the Fabric path is reachable. Default path shows no "bind a Fabric workspace" message.

### T28 — Parity docs + UAT spec for the whole Copilot surface
- **Goal:** Author/refresh `docs/fiab/parity/copilot-<persona>.md` for every persona (inventory ✅/⚠️/❌ + backend per control) and add a deep-functional UAT spec covering each persona end-to-end.
- **Files:** `docs/fiab/parity/copilot-*.md`, `apps/fiab-console/uat/copilot.spec.ts` (or existing UAT harness), `docs/fiab/prp/copilot-ai.md` (this file) status updates.
- **Acceptance:** every persona's parity doc shows zero ❌ (built ✅ or honest-gate ⚠️); `pnpm uat` covers each persona's primary action against a real backend; docs updated per `docs_source_of_truth` rule.

---

## 5. Per-task Claude Code dev-loop

Run this loop for **each** task above; do not mark a task done until every gate passes.

1. **Code** — implement the task's files. Strict TS; OBO on tool calls; hosts via `cloud-endpoints` / `resolveAoaiTarget`; no `any` on public surfaces; no mock arrays / `return []` / hard-coded sample replies (no-vaporware). Where infra may be absent, emit an honest-gate MessageBar naming the exact env var / role / resource — never a fake success.
2. **Validate / test:**
   - `pnpm -C apps/fiab-console tsc --noEmit` (or the repo's typecheck) — zero errors.
   - `pnpm -C apps/fiab-console vitest run <files>` — unit tests green, including the cloud-matrix test for any new client and a render test for any new component.
   - **Real-data E2E:** mint a session cookie, hit the BFF route (`/api/copilot/orchestrate` with the task's `contextSlug`, or the task's specific route), and capture the **real** response (first ~300 chars) showing a real AOAI completion / real engine rows / real created resource — or the precise honest-gate MessageBar. For UI tasks, a Playwright walk clicking the actual control.
   - Run the grep gates: `grep -rE "(return \[\]|return \{\}|useState\(\[\{|MOCK_|SAMPLE_)" lib/copilot lib/azure/copilot-* app/api/copilot lib/components/copilot-*` and `grep -rn "api.fabric.microsoft.com\|api.powerbi.com" lib/azure/copilot-orchestrator.ts lib/copilot` — zero un-disclosed hits (Power BI/Fabric only inside the T27 opt-in branch).
3. **Docs** — update the persona parity doc (`docs/fiab/parity/copilot-<slug>.md`) and any affected workload spec; update this PRP's status column. No clarifying-questions or side-convo baked into product/docs (per `no_questions_in_product`).
4. **UAT** — extend/run the deep-functional UAT for the persona; live side-by-side against the real Fabric Copilot for that workload (DOM strings ≠ parity — click every control).
5. **Iterate** — if any gate fails, fix and re-run from step 2. A task is done only when typecheck + vitest + real-data E2E + grep gates + UAT all pass and the parity doc shows zero ❌.

---

## 6. Experience definition-of-done

The Copilot & AI experience is **done** when **all** hold:

- **No Fabric / Power BI dependency on any default path.** With `LOOM_DEFAULT_FABRIC_WORKSPACE` and any Power BI workspace UNSET, every persona renders and executes its primary action against a real Azure-native backend (real AOAI completion + real engine result). Grep gates return zero default-path Fabric/PBI hits. Fabric/PBI Copilot exists only behind the T27 opt-in flag.
- **No vaporware.** Every control calls a real backend or shows an honest-gate MessageBar naming the exact env var / role / resource. No mock arrays, no `return []`, no canned replies, no dead buttons, no empty tabs.
- **One-for-one UI parity.** Every Fabric Copilot affordance (chat panel, suggested prompts, slash commands, inline completion, Fix-with-Copilot, approval-diff, thumbs feedback, 28-day history, typed results) exists and works in Loom with Fluent v9 + Loom tokens; only the theme differs. Each persona has a parity doc with zero ❌.
- **All 4 clouds.** AOAI + orchestration tier (Foundry for Comm/GCC, MAF for GCC-High/IL5) resolve correctly via `resolveAoaiTarget()` + `environment().name`; cloud-matrix tests pass; bicep deploys the AOAI env vars and (Gov) the MAF Container App from scratch.
- **Persisted + governed.** Sessions persist in Cosmos with a 28-day TTL and are clearable; feedback is recorded; every response passes the content-safety + PII pipeline; usage is metered to App Insights and surfaced in the Cost view.
- **Tested + documented + bicep-synced.** `tsc` + `vitest` + real-data E2E + `pnpm uat` green for every persona; parity docs and workload specs updated; every new env var / role / resource / Cosmos container added to bicep and the bootstrap doc (`az deployment sub create … + bootstrap` reproduces the full Copilot feature set).
