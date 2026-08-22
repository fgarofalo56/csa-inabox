# PRP — Azure AI Foundry (classic + Agent Service) + AI Search: full-depth direct integration

**Title:** Azure AI Foundry (classic + Agent Service) + AI Search — full-depth direct integration into CSA Loom
**Date:** 2026-07-08
**Status:** proposed
**Owner:** CSA Loom — next-waves backlog
**Cross-cutting rules honored:** `no-vaporware`, `no-fabric-dependency`, `no-freeform-config`, `ui-parity`, `loom-design-standards` (Fluent v9 + Loom tokens + `canvas-node-kit`), bicep-sync.
**Sources consulted:**
- Two live research streams (2026-07-08): (A) *Azure AI Foundry (classic) + Azure AI Search integration depth in Loom*; (B) *Azure AI Foundry Agent Service — agents, multi-agent workflows, tool catalog, AgentOps, model router, memory*.
- In-repo parity docs: `docs/fiab/parity/ai-foundry.md` (rev.3 — 21 built / 17 partial / 2 gated / 4 missing of 44 rows), `docs/fiab/parity/ai-search.md` (graded B).
- Existing PRPs: `PRPs/completed/fabric-parity/appendix-copilot-ai.md`, `docs/fiab/prp/copilot-ai.md` (T7 typed-result renderer, T12 enrichment, T24 MAF, T25 usage metering), `PRPs/active/enterprise-hardening/appendix-scale-aoai-ptu.md`.
- Microsoft Learn (per-item URLs in each work-item section; agentic retrieval `2026-04-01` REST GA July 2026, Microsoft Agent Framework 1.0 GA April 2026).

---

## Executive summary — the strategic "why"

Loom already renders a genuinely deep, non-vaporware Azure AI Foundry surface: `foundry-hub-editor.tsx` (14 tabs — model catalog + deploy, Chat/Images/Audio playgrounds, Agents build-and-test loop, Fine-tuning, Tracing span-tree, Observability) wired to live Cognitive Services / AOAI / AML / App-Insights REST, plus first-class `data-agent`, `operations-agent`, `prompt-flow`, `evaluation`, `tracing`, and `content-safety` item types, plus a real per-field AI Search index designer with a vector-query builder and full CRUD against real REST. This is B-/B grade and real.

What is **missing is the integration axis** — the thing that turns "a Foundry editor" and "a Search editor" into *Loom's own intelligence layer over Loom's own data estate*. Today there is **no embedding client anywhere in the codebase**, **no agentic-retrieval (Knowledge Sources / Knowledge Bases) support** despite that being the flagship 2026 capability that binds Foundry agents to AI Search, **no one-click bridge** from a lakehouse / warehouse / ADX item into a searchable, vectorized index, **no reusable multi-agent composition** (connected agents live only inside a hard-coded sample notebook), a **freeform comma-separated "Tools" text box** on the operations-agent (a `no-freeform-config` violation), and **no batch LLM enrichment stage** over table columns. Foundry parity also stops short of PTU/Batch deployment types, Model Router, and the AI Red Teaming Agent.

The operator's standard is unchanged: **Loom is Fabric-class AI on pure Azure + OSS, Commercial and Government, day-one, with zero hard dependency on real Microsoft Fabric or Power BI.** Foundry IQ agentic retrieval, integrated vectorization, multi-agent workflows, AgentOps, and enrichment are all Azure-native by construction (Cognitive Services / AOAI + AI Search REST + Foundry Agent Service data-plane) — no Fabric tenant, no Power BI workspace, ever. Where a 2026 capability is not confirmed Gov-wide GA (Foundry Agent Service in GCC-High/IL5; Bing grounding; some agentic-retrieval regions), Loom honest-gates and falls through to the OSS Microsoft Agent Framework tier — the same die-hard "100% functional without the premium/Fabric path" contract. This PRP closes that integration axis in dependency order: the RAG spine first (embeddings → knowledge bases → index-my-data), then the multi-agent spine (typed tool catalog → connected agents → visual canvas), then the depth-completion items (PTU/router/red-teaming/search-admin), and finally the Gov OSS runtime that makes the whole agent story portable to IL5.

---

## Work items

| ID | Item | Source product | Loom state | Priority | Effort |
|----|------|----------------|-----------|----------|--------|
| AIF-1 | Knowledge Sources + Knowledge Bases (agentic retrieval / Foundry IQ) | AI Search + Foundry Agent Service | MISSING | P0 | L |
| AIF-2 | Embedding client + integrated-vectorization (skillset + vector-profile designers) | AI Search + AOAI embeddings | MISSING | P0 | L |
| AIF-3 | Index-my-lakehouse / warehouse / ADX wizard | AI Search Import-and-vectorize wizard over Loom's estate | ✅ DONE (Wave 4) | P0 | XL |
| AIF-4 | Connected-agent (multi-agent) composition | Foundry Agent Service — connected agents | PARTIAL | P0 | M |
| AIF-5 | Typed agent tool catalog (MCP / OpenAPI / grounding) | Foundry Agent Service tool catalog | PARTIAL | P0 | M |
| AIF-6 | Visual multi-agent workflow canvas | Agent Framework graph workflows / Foundry flow designer | PARTIAL | P1 | L |
| AIF-7 | `ai-enrichment` workflow item (batch LLM over columns) | Fabric AI functions + Agent Service batch | MISSING | P1 | L |
| AIF-8 | Microsoft Agent Framework 1.0 OSS runtime tier (Gov) | MAF 1.0 (GA Apr 2026) | MISSING | P1 | XL |
| AIF-9 | Foundry Connections CRUD | Foundry Management center — Connections | PARTIAL | P1 | M |
| AIF-10 | Indexer scheduling + execution history + field mappings + reset | AI Search indexer lifecycle | MISSING | P1 | M |
| AIF-11 | PTU + Batch deployment types | Foundry Models deployment types | PARTIAL | P1 | M |
| AIF-12 | Model Router (router deployment + Loom-native tier router) | Foundry Model Router | PARTIAL | P2 | M |
| AIF-13 | AgentOps: eval-linked tracing + per-agent cost/latency rollup | Foundry unified OTel pipeline | PARTIAL | P2 | M |
| AIF-14 | Durable cross-session agent memory | Foundry Agent Service managed memory | MISSING | P2 | M |
| AIF-15 | AI Red Teaming Agent (PyRIT adversarial scan) | Foundry Risk & Safety Evaluations | MISSING | P2 | M |
| AIF-16 | Scoring-profile / analyzer / CORS / CMK designers | AI Search index designer | MISSING | P2 | M |
| AIF-17 | AI Search service administration in-editor | AI Search service admin | MISSING | P2 | M |
| AIF-18 | Browser-automation tool type (Playwright ACA substitute) | Foundry Agent Service tool catalog | MISSING | P3 | M |

**Sequencing note.** AIF-9 (Connections CRUD) is the shared plumbing that AIF-1 (knowledge-source connection) and AIF-2 (AOAI vectorizer connection) should reference rather than re-deriving raw endpoints; land it alongside or just ahead of them. AIF-2 is a hard prerequisite for AIF-1 and AIF-3 (no vectors without an embedding path). AIF-5 (typed tool catalog) is a prerequisite for AIF-4 (connected-agent is a tool type) and unblocks AIF-6/AIF-18. AIF-8 (MAF Gov tier) is the honest-gate backstop the P0 agent items degrade to in GCC-High/IL5.

---

## AIF-1 — Knowledge Sources + Knowledge Bases (agentic retrieval / Foundry IQ)

**Capability.** Decompose a complex query into subqueries, run each against one or more *knowledge sources* (an AI Search index, web, or a remote source), semantic-rerank each subquery result, and synthesize a single grounded answer with citations. Each *knowledge base* exposes an MCP endpoint (`knowledge_base_retrieve` tool) consumable by Foundry agents, GitHub Copilot, Claude, and Cursor. This is the flagship capability binding Foundry agents to AI Search (Foundry IQ) and the reason the `2026-04-01` agentic-retrieval REST API GA'd in July 2026.

**Source grounding.**
- https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-overview
- https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-how-to-create-knowledge-base
- https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-how-to-retrieve
- https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/tools/knowledge-retrieval?view=foundry

**Current Loom state — MISSING.** `grep knowledgeAgent|knowledge-agent|agentic.retrieval` across `apps/fiab-console` returns zero hits. `ai-search-tree.tsx` object groups stop at Indexes / Indexers / Datasources / Skillsets / Synonymmaps / Aliases — no Knowledge-sources / Knowledge-bases group. `docs/fiab/parity/ai-search.md` row A.7 ("Knowledge sources / knowledge base (preview agentic)") is marked MISSING.

**Azure-first build.**
- **Client:** new methods in `lib/azure/search-index-client.ts`: `createKnowledgeSource` (wraps an existing index), `createKnowledgeBase` (`name` + `knowledgeSources[]` + default retrieval params: `rerankerThreshold`, `defaultIncludeReferenceSourceData`), `retrieve` — against `2026-04-01` REST (`PUT /knowledgeSources/{name}`, `PUT /knowledgeBases/{name}`, `POST /knowledgeBases/{name}/retrieve`).
- **BFF:** `app/api/ai-search/knowledge-sources/route.ts`, `app/api/ai-search/knowledge-bases/route.ts`, `app/api/ai-search/knowledge-bases/[name]/retrieve/route.ts` — structured `{ok, data, error}`, session-validated.
- **UI:** new navigator group **"Knowledge Bases"** in `ai-search-tree.tsx` (parity with the portal Import/preview UI), plus a **retrieve-test pane** — query + conversation history in; subqueries + citations + synthesized answer out — reusing the T7 typed-result renderer pattern from `copilot-ai.md`. No JSON textarea; wizard/dropdowns per `no-freeform-config`.
- **Copilot wiring:** register a `knowledge_base_retrieve` tool in `copilot-orchestrator.ts`'s tool catalog for the ai-search / RAG personas so Loom's own Copilot uses agentic retrieval instead of flat vector search.
- **Bicep:** none new (reuses AI Search + Foundry Agent Service). Grant already covered by existing Search + Cognitive Services role assignments.
- **Gov notes.** `2026-04-01` API is Commercial / GCC GA per REST; **verify Gov region GA before wiring** — if absent, honest-gate the Knowledge Bases group with a Fluent `MessageBar intent="warning"` naming the required region/API version. No Fabric dependency (pure AI Search + Foundry Agent Service REST).

**Acceptance (real-backend receipt, `no-vaporware`).** Create a knowledge source over a live index, create a knowledge base, hit `POST …/retrieve` with a multi-part question; PR body shows the real response body (subqueries + citations + synthesized answer, first 300 chars) and a screenshot of the retrieve-test pane. Loom Copilot demonstrably calls `knowledge_base_retrieve` in a traced run.

**Priority P0 · Effort L.**

---

## AIF-2 — Embedding client + integrated-vectorization (skillset + vector-profile designers)

**Capability.** Turn raw documents into searchable vectors *server-side* — a Text Split skill (chunking) + an `AzureOpenAIEmbedding` skill inside a skillset, or an inline vectorizer on a vector field — so ingestion never depends on a hand-rolled client-side embedding loop. This is the foundation AIF-1 and AIF-3 stand on.

**Source grounding.**
- https://learn.microsoft.com/en-us/azure/search/vector-search-integrated-vectorization
- https://learn.microsoft.com/en-us/azure/search/cognitive-search-defining-skillset
- https://learn.microsoft.com/en-us/azure/search/vector-search-how-to-create-index

**Current Loom state — MISSING.** `grep embedding|text-embedding|EmbeddingsClient` across `apps/fiab-console/lib` returns **zero code hits** — the only matches are narrative prose in `app-rag-builder.ts` `SEED_DOC_5`/`SEED_DOC_8` sample strings (not executed code). `search-field-shapes.ts` has no `Vectorizer` / `azureOpenAIVectorizer` types. `ai-search.md` rows 9-10 confirm the semantic-config and vector-profile designers are honest-gated (JSON-only); skillsets (row 4) are a JSON-textarea create-only surface with no skill picker.

**Azure-first build.**
1. **`lib/azure/foundry-embeddings-client.ts`** wrapping AOAI `/embeddings` (text-embedding-3-small/large) with batching + retry, reusing `resolveAoaiTarget()` / cloud-endpoints for all four clouds.
2. **Skillset visual designer** (replaces the JSON textarea) — new `SkillsetDesigner` component in / alongside `ai-search-tree.tsx` with a skill picker for the common set: Text Split (page length + overlap), `AzureOpenAIEmbedding` (deployment picker via the same AOAI account bound to Foundry), OCR, Merge, Entity Recognition, Key Phrase Extraction, Sentiment. Each skill = a card with typed inputs/outputs and an "Add skill" menu; `PUT /skillsets/{name}` (real REST).
3. **Vector-profile designer** promoting `ai-search.md` row 10 ("Not yet wired") to a real form: algorithm (HNSW / exhaustiveKnn) + vectorizer (`azureOpenAI`, pointing at the Foundry AOAI embedding deployment) + compression (scalar / binary quantization). `PUT` into the real index definition.
4. **Indexer output-field-mapping UI** so skillset embedding output maps to the vector field.
- **Bicep:** no new resources (reuses AI Search + Cognitive Services). **Add a role assignment:** grant the Search service's system identity **Cognitive Services OpenAI User** on the Foundry AOAI account so the server-side vectorizer can call embeddings — wire into `ai-search.bicep`.
- **Gov notes.** Integrated vectorization + AOAI embeddings are Gov GA; no Fabric dependency.

**Acceptance.** Build a skillset (chunk + embed) via the designer, define a vector field with an `azureOpenAI` vectorizer, run an indexer, and query the index with the vector-query builder — PR shows the real indexer status (docs succeeded > 0) and a vector search returning scored results, plus screenshots of both designers (no JSON textarea in the primary path).

**Priority P0 · Effort L.**

---

## AIF-3 — Index-my-lakehouse / warehouse / ADX wizard

**Capability.** One-click "Add search index" from a lakehouse (Delta / ADLS Gen2), warehouse (Synapse SQL), or ADX table item that provisions the datasource + skillset (chunk + embed) + index + indexer as a coordinated pipeline — parity with the portal's Import-and-vectorize-data wizard, applied to Loom's *own* estate.

**Source grounding.**
- https://learn.microsoft.com/en-us/azure/search/search-get-started-portal-import-vectors
- https://learn.microsoft.com/en-us/azure/search/search-import-data-portal
- https://learn.microsoft.com/en-us/azure/search/search-how-to-index-cosmosdb

**Current Loom state — MISSING.** `ai-search-tree.tsx` ~line 592 is an honest-gate row (`ai-search.md` row 21): "Create the pieces individually using +New … the coordinated wizard is not yet built." The per-object plumbing exists — the datasource dialog supports `adlsgen2` / `onelake` / `azuresql` / `cosmosdb` (`ai-search-tree.tsx:942`) — but there is **no entry point from a source item** (`lakehouse-editor.tsx`, warehouse editor, ADX kql-db editor) that pre-fills a datasource pointing at that item's own storage/SQL/cluster.

**Azure-first build.** New `IndexMyDataWizard` (Fluent Wizard/stepper) launchable from a button on `lakehouse-editor.tsx`, `unified-sql-database-editor.tsx` (warehouse), and the ADX kql-db editor:
- **Step 1 — connection auto-derive** from the source item's already-bound resource (ADLS Gen2 container path via `shortcut-engines.ts` / `adls-client` for lakehouse Delta; Synapse SQL connection for warehouse; ADX cluster+db for KQL). No manual paste.
- **Step 2 — skillset preset** (Documents = OCR + chunk + embed; Structured rows = chunk + embed only) reusing the AIF-2 skillset designer.
- **Step 3 — field-mapping preview** (source columns → index fields, auto-suggested from the schema the source editor already reads: lakehouse Tables tab / SQL objects client / ADX schema call).
- **Step 4 — orchestrate** datasource + skillset + index + indexer via existing real REST (`POST /datasources`, `POST /skillsets`, `PUT /indexes/{n}`, `POST /indexers`) then run the indexer.
- **BFF:** `app/api/items/{lakehouse|warehouse|kql-database}/[id]/index-to-search/route.ts` orchestrating server-side **with rollback-on-failure**.
- **Bicep:** none new — reuses AI Search + the source's existing bicep-provisioned storage/SQL/ADX. Reuse the AIF-2 Search→AOAI role grant for embeddings.
- **Gov notes.** All backends Gov-native; honest-gate any step whose datasource type isn't Gov-GA.

**Acceptance.** From a live lakehouse item with real Delta tables, run the wizard end-to-end; PR shows the created index name, the indexer run's real doc count, a query returning rows sourced from that lakehouse, and a screenshot of the 4-step wizard. Rollback proven by a forced mid-sequence failure leaving no orphan objects.

**Priority P0 · Effort XL.**

---

## AIF-4 — Connected-agent (multi-agent) composition

**Capability.** A reusable, point-and-click way to chain N Foundry agents as sub-agents of an orchestrator over Loom items (warehouse / ADX / lakehouse) — not a hard-coded sample.

**Source grounding.** Foundry Agent Service connected agents / Agent Framework graph workflows: https://learn.microsoft.com/azure/foundry/agents/how-to/connected-agents (+ tool-catalog docs under AIF-5).

**Current Loom state — PARTIAL.** `app-sovereign-ai-agents.ts:326-361` hard-codes a 3-agent + orchestrator `ConnectedAgentTool` example **only inside a sample notebook's Python string**. The real agent builder `foundry-agents.tsx:53-58` (`TOOL_TYPES`) offers only `code_interpreter` / `file_search` / `function` — a user cannot pick "Agent B" as a tool of "Agent A" from the real UI.

**Azure-first build.** Add `connected_agent` to `TOOL_TYPES` in `foundry-agents.tsx` with an agent-picker Dropdown (populate from the same project's `listAgents()`); on save emit `{type:'connected_agent', connected_agent:{id, name, description}}` into `FoundryAgentBody.tools`. `createOrUpdateAgent` in `lib/azure/foundry-agent-client.ts` already POSTs/PATCHes an arbitrary `tools[]` — **no client change needed**; the existing `/api/foundry/agents` routes just allow the new tool shape.
- **Bicep:** none (data-plane only; same `LOOM_FOUNDRY_PROJECT_ENDPOINT`).
- **Gov notes.** Foundry Agent Service is Commercial / GCC GA (per `copilot-ai.md §1.3`). **GCC-High / IL5 honest-gates** the connected-agent picker to "requires Foundry-tier orchestration" and falls to the deferred MAF tier (AIF-8) until it ships. No Fabric dependency.

**Acceptance.** Compose an orchestrator + 2 sub-agents from the UI, run a thread, and show in the steps/thread inspector that the orchestrator delegated to a connected agent (real run id + step trace in the PR).

**Priority P0 · Effort M.**

---

## AIF-5 — Typed agent tool catalog (replaces freeform tool entry)

**Capability.** A typed tool catalog (code interpreter, file search, function, MCP, OpenAPI, Bing/web grounding, browser automation) shared across every agent surface — replacing the current freeform comma-separated tool text box (a `no-freeform-config` violation).

**Source grounding.**
- https://learn.microsoft.com/azure/foundry/agents/concepts/tool-catalog
- https://learn.microsoft.com/azure/foundry/agents/how-to/tools/model-context-protocol

**Current Loom state — PARTIAL (and a rule violation).** `operations-agent-editor.tsx:181-183` renders **"Tools (comma-separated)"** as a bare Fluent `Input` bound to a free string (default `'eventhouse-query, activator-trigger'`). `foundry-agents.tsx:53-58` `TOOL_TYPES` caps at `code_interpreter` / `file_search` / `function` — no `mcp`, `openapi`, `bing_grounding`, or `browser_automation` — even though Loom already runs a full deployable MCP-server catalog (`lib/mcp/catalog.ts`, `lib/azure/mcp-remote-config-store.ts`, `/admin/mcp-servers`) that isn't cross-wired as an agent tool source.

**Azure-first build.** New shared registry `lib/copilot/agent-tool-catalog.ts` enumerating: `code_interpreter`; `file_search` (bound to an ai-search-index item); `function` (bound to a Loom BFF tool); `mcp` (bound to a deployed/registered server from `lib/mcp/catalog.ts` — emits `{type:'mcp', server_label, server_url, allowed_tools}` per the Learn MCP schema); `openapi` (bound to an OpenAPI spec URL/item); `bing_grounding` (Gov-aware honest-gate). **Replace** the freeform `Input` in `operations-agent-editor.tsx` with a multi-select Dropdown fed by this registry, and wire the **same registry** into `foundry-agents.tsx` `TOOL_TYPES` and `PromptFlowBuilder` tool nodes so `data-agent`, `operations-agent`, `foundry-agents`, and `prompt-flow` share one typed catalog.
- **Backend:** `FoundryAgentBody.tools` is already free-form JSON on the wire in `foundry-agent-client.ts` — no new client method; structured UI just emits the correct tool JSON per tool type.
- **Bicep:** none.
- **Gov notes.** `bing_grounding` isn't in all Gov regions → honest-gate. MCP tool binds to Loom-owned in-VNet servers, keeping the path Azure-native.

**Acceptance.** operations-agent's tools become a typed multi-select (freeform box removed — grep for `comma-separated` in that file returns zero). Attach an `mcp` tool bound to a live registered MCP server and show the agent invoking one of its tools in a traced run.

**Priority P0 · Effort M.**

---

## AIF-6 — Visual multi-agent workflow canvas

**Capability.** Drag-drop authoring of a multi-agent flow (parity with Agent Framework graph workflows and Foundry's flow designer) instead of a form/table DAG.

**Source grounding.** Microsoft Agent Framework 1.0 graph workflows + Foundry Agent Service visual designer.

**Current Loom state — PARTIAL.** `foundry-sub-editors.tsx:408-622` (`PromptFlowEditor` / `PromptFlowBuilder`) renders nodes as a form/table (no `@xyflow/react` import), unlike `pipeline` / `dataflow` / `eventstream` which use the React-Flow-based `canvas-node-kit` (memory: `csa_loom_reactflow_canvas`, `csa_loom_web5_visual_program`). The node/edge JSON shape (`FlowDag` — nodes: input/tool/llm/output; edges: from/to) already exists; it just isn't rendered as a canvas.

**Azure-first build.** Reuse `canvas-node-kit.tsx` to render the existing `FlowDag` as draggable nodes with typed ports (input → tool/connected-agent → llm → output/human-in-loop), keeping the **same** `serializeFlowDag` / `toFlowDag` + `POST /api/items/prompt-flow(/:id)/run` contract — a pure UI-layer swap, **zero backend change**. Add first-class canvas node kinds for `connected-agent` (from AIF-4) and `human-in-loop gate` (both already modeled in the sovereign-ai-agents bundle's node kinds) so any user, not just the sample bundle, can compose a multi-agent flow visually.
- **Bicep:** none. **Gov notes:** UI-only; inherits the underlying tier's Gov posture.

**Acceptance.** Build a 3-node multi-agent flow on the canvas (drag + connect), run it via the unchanged run route, and show the real run output + a canvas screenshot. Old form builder path either removed or behind a "table view" toggle.

**Priority P1 · Effort L.**

---

## AIF-7 — `ai-enrichment` workflow item (batch LLM over columns)

**Capability.** A first-class pipeline/dataflow stage that runs a Foundry agent or direct AOAI call once per row/column-batch over a bound warehouse/lakehouse table, writing results to a new output column — Fabric AI-functions parity (`ai.summarize`/`classify`/`extract`/`translate`) as a durable item type, not a notebook helper. Closes T12 from `copilot-ai.md`.

**Source grounding.** Fabric AI functions + Foundry Agent Service batch runs (Learn: AOAI batch, Fabric AI functions overview).

**Current Loom state — MISSING.** `docs/fiab/prp/copilot-ai.md:243-249` (T12) tracks this as ❌. No `apps/copilot/ai_functions/` directory and no `ai-enrichment` item type in the catalog — only `ai-functions-client.ts` / `ai-functions-helper.tsx` (Copilot-panel helpers, not a batch data stage).

**Azure-first build.** New Loom item type **`ai-enrichment`** (category: Data Factory or Azure AI Foundry). Editor: typed source-table picker (reuse the dropdown pattern from `operations-agent-editor.tsx`'s Eventhouse picker), operation Dropdown (summarize / classify / extract / translate / custom-prompt), batch-size + concurrency controls, and a real-execution preview (first 20 rows) before a full run. Backend: `lib/azure/ai-enrichment-client.ts` batching rows through `resolveAoaiTarget()` (reusing `data-agent-client.ts`'s AOAI pattern) with retry/backoff, writing back via `synapse-sql-client` / ADLS client per source type.
- **Bicep:** none new (reuses AOAI + existing Synapse/ADLS wiring); honest-gate if AOAI unconfigured.
- **Gov notes.** AOAI + Synapse/ADLS are Gov-native. No freeform config — all pickers/dropdowns.

**Acceptance.** Run `ai-enrichment` over a live table (e.g. classify a text column), show the new output column populated with real model output in the target table, and a preview + full-run receipt in the PR.

**Priority P1 · Effort L.**

---

## AIF-8 — Microsoft Agent Framework 1.0 OSS runtime tier (Gov)

**Capability.** An OSS agent runtime for GCC-High / IL5 where Foundry Agent Service isn't confirmed Gov-wide GA — the single highest-leverage item for full agent parity in the hardest clouds. Highest-leverage because every P0 agent item (AIF-4/5/6) degrades to this tier in IL5.

**Source grounding.** Microsoft Agent Framework 1.0 (GA April 2026 — successor to Semantic Kernel + AutoGen, graph-based workflows): https://learn.microsoft.com/agent-framework/overview.

**Current Loom state — MISSING (deferred).** `copilot-ai.md:329-336` (T24) marks this 🔄 deferred; no `apps/copilot-maf/` and no `platform/fiab/bicep/modules/copilot/maf.bicep`. The `environment().name`-based tier auto-select referenced in `copilot-orchestrator.ts` comments is not implemented for the Gov-High/IL5 path.

**Azure-first build.** Stand up a small Container App `apps/copilot-maf/` running the OSS `microsoft/agent-framework` package, bound to **AOAI-direct** (no Foundry Agent Service dependency), exposing the **same** thread/run/step contract shape `foundry-agent-client.ts` already returns (`AgentRunInspection`) so `copilot-orchestrator.ts` swaps tiers transparently by `environment().name`.
- **Bicep:** new `platform/fiab/bicep/modules/copilot/maf.bicep` (Container App + UAMI with **Cognitive Services OpenAI User** + AOAI env vars), wired into `admin-plane/main.bicep` app env list per Gov topology (reuse the scale-to-zero ACA pattern from `platform/runners/`).
- **Gov notes.** This *is* the Gov path — AOAI-direct only, no Foundry/Fabric dependency, IL5-portable.

**Acceptance.** In a Gov-flavored deployment (or with `environment().name` forced), run a connected-agent flow through the MAF Container App and show it returns the same `AgentRunInspection` shape as the Foundry tier (side-by-side thread/run/step JSON). Bicep `what-if` clean.

**Priority P1 · Effort XL.**

**Build status (Wave 5).**
- ✅ **Orchestrator tier** — the cross-item Copilot orchestrator MAF tier is built and live: `apps/copilot-maf/` (real agent loop against Gov AOAI direct, Console tool-dispatch callback with OBO), auto-selected in `copilot-orchestrator.ts` by `isGovCloud() && LOOM_MAF_ENDPOINT`, `platform/fiab/bicep/modules/copilot/maf.bicep` deploys it.
- ✅ **Agent-run tier (this wave)** — the Foundry Agent Service thread/run/step inspector path now has the Gov backstop: `apps/copilot-maf/src/agent-run.ts` (`POST /agent-run` → real agent loop → `AgentRunInspection`), Console selection plumbing `lib/azure/agent-runtime-tier.ts` (`selectAgentTier()` + `runAgentInspectTiered()`), wired into `app/api/foundry/agents/run/route.ts`; the Agents playground passes the agent definition + badges which runtime served the run. Unit-tested (`agent-runtime-tier.test.ts`). No new bicep params (reuses `LOOM_MAF_ENDPOINT`).
- ⬜ **TODO (advanced tool-parity, deferred):** streaming deltas from the MAF agent-run; multi-turn thread reuse (MAF thread ids are synthetic per-run today); connected-agent sub-agent fan-out on the MAF tier; native `code_interpreter` / `file_search` emulation; and Loom-native (Cosmos-persisted) agent AUTHORING/LISTING so a Gov-no-Foundry deployment can populate the Agents list without a Foundry project (the panel currently sources agent definitions from the Foundry project list — AIF-14's per-agent Cosmos persistence is the substrate for this).

---

## AIF-9 — Foundry Connections CRUD

**Capability.** Full create/edit/delete of AOAI, AI Search, Blob, API-key, and custom-key connections at the Foundry project/hub level — the backbone that lets agents/flows/knowledge-bases reference a named connection instead of hard-coded endpoints. Prerequisite plumbing for AIF-1 and AIF-2.

**Source grounding.**
- https://learn.microsoft.com/azure/foundry/how-to/connections-add
- https://learn.microsoft.com/azure/ai-foundry/how-to/develop/connections-add

**Current Loom state — PARTIAL.** `ai-foundry.md` row C3: "read-only list only; no create/edit/delete despite portal supporting full CRUD" (flagged the doc's #3 highest-value gap).

**Azure-first build.** Extend `GET /api/foundry/connections` to POST/PATCH/DELETE against the project connections REST (`PUT /projects/{p}/connections/{name}` with typed `category` = AzureOpenAI / CognitiveSearch / AzureBlob / ApiKey / CustomKeys and `credentials` via **Key Vault reference — never raw secrets in the payload**). UI: a Connections tab with a typed create-dialog (category picker drives the credential-field set), matching the portal. AIF-1's knowledge-source wizard and AIF-2's AOAI vectorizer should **reference this connection object** rather than re-deriving endpoints.
- **Bicep:** none (data-plane); ensure the Console UAMI has the connection-write role on the Foundry project.
- **Gov notes.** Connections REST is Gov-GA; KV-reference credentials satisfy Gov secret-handling.

**Acceptance.** Create an AzureOpenAI + a CognitiveSearch connection from the UI, edit and delete one; PR shows real REST responses and confirms no raw secret ever appears in the request body (KV reference only).

**Priority P1 · Effort M.**

---

## AIF-10 — Indexer scheduling + execution history + field mappings + reset

**Capability.** Schedule an indexer, view per-run execution history, edit field/output-field mappings, and reset docs / reset skills (preview) / resync — the indexer lifecycle Learn calls core.

**Source grounding.**
- https://learn.microsoft.com/en-us/azure/search/search-howto-schedule-indexers
- https://learn.microsoft.com/en-us/azure/search/search-howto-run-reset-indexers
- https://learn.microsoft.com/en-us/azure/search/search-indexer-field-mappings

**Current Loom state — MISSING.** `ai-search.md` rows 17-20: no schedule UI; `resetDocs`/`resetSkills`/`resync` have no client method; execution status is a single badge (no per-run succeeded/failed/warnings/errors); field/output-field mappings not exposed.

**Azure-first build.** Extend `search-index-client.ts` with `setIndexerSchedule` (`schedule:{interval,startTime}` on the indexer PUT), `resetDocs`/`resetSkills` (`POST /indexers/{n}/resetdocs` with `overwrite`/`documentKeys`), and richer status parsing (`executionHistory[]` from `GET /indexers/{n}/status`). UI: an Indexer detail panel (in `ai-search-tree.tsx` or a promoted indexer editor) with a Schedule form (interval Dropdown 5min–1day + start-time picker), an execution-history `DataGrid` (per-run start/end, itemsProcessed/itemsFailed, expandable warnings/errors), and a field-mappings + output-field-mappings table editor (source → target field + mapping-function picker) — all into the same indexer PUT payload.
- **Bicep:** none. **Gov notes:** indexer REST is Gov-GA.

**Acceptance.** Schedule an indexer, trigger a reset-docs, and render real execution history for a live indexer; PR shows the schedule persisted (GET reflects it) and a history grid with real per-run counts.

**Priority P1 · Effort M.**

**Build status — ✅ built.** The full indexer lifecycle is live against real AI
Search REST (api-version `2024-07-01`, preview for reset-skills/resync):
- **Client** (`lib/azure/search-index-client.ts`): `updateIndexerSchedule`
  (schedule PUT preserving every other property), `getIndexerStatus`,
  `runIndexer`, `resetIndexer`, `resetIndexerDocs`, `resetIndexerSkills`,
  **`resyncIndexer`** (`POST /indexers/{n}/resync` `{options:['permissions']}`,
  `SEARCH_RESYNC_API=2026-05-01-preview`), and `updateIndexerFieldMappings`.
- **Pure shaping** (`lib/azure/search-indexer-shapes.ts`): field-mapping
  builder/parser (`buildFieldMappings`/`parseIndexerMappings`, all 8 mapping
  functions), execution-history normalizer (`parseExecutionHistory`,
  per-run counts + errors/warnings), and **`normalizeResyncOptions`** — unit
  tested (`search-indexer-shapes.test.ts`, 16 specs).
- **Routes** (`app/api/ai-search/indexers` service-scoped +
  `app/api/items/ai-search-index/[id]/indexers` item-scoped, session-gated via
  `resolveSearchBinding`): actions `run`/`reset`/`resetDocs`/`resetSkills`/
  **`resync`**/`setFieldMappings`/`status`/`get`/`setSchedule`, honest 503 gate
  when `LOOM_AI_SEARCH_SERVICE` is unset.
- **UI**: the schedule editor (`IndexerSchedulePanel` in `foundry-sub-editors.tsx`
  — preset-interval Dropdown 5min–1day / custom / start-time / disable) and
  `IndexerOpsPanel` (`lib/components/ai-search/indexer-ops.tsx` —
  execution-history table with expandable per-run errors/warnings, typed
  field-/output-field-mapping designer with mapping-function picker, and a
  reset accordion covering reset-docs, reset-skills, **resync (typed options
  checkboxes) + Run-now**). Wired into the AI Search navigator tree
  (`ai-search-tree.tsx`) and both the service-navigator and item editors. No
  new bicep. No Fabric dependency.

---

## AIF-11 — PTU + Batch deployment types

**Capability.** Provisioned-throughput deployment types (Global Provisioned, Data Zone Provisioned, Regional Provisioned) with a PTU-count input and hourly-billing disclosure, plus Global/Data Zone Batch deployments (24h, ~50% cheaper) for high-volume async work.

**Source grounding.**
- https://learn.microsoft.com/azure/foundry/openai/concepts/provisioned-throughput
- https://learn.microsoft.com/azure/ai-foundry/openai/how-to/deployment-types
- https://learn.microsoft.com/azure/foundry/openai/provisioned-quickstart
- https://learn.microsoft.com/azure/ai-foundry/openai/how-to/batch

**Current Loom state — PARTIAL.** `foundry-cs-client.ts:344-484` lists SKU options `GlobalStandard`/`Standard`/`DataZoneStandard…` with a fallback `['GlobalStandard']`; enumeration comes from the live account so Provisioned* *could* surface, but the Deploy dialog (`ai-foundry.md` B7/C1) has **no PTU-count field, no hourly-billing warning, no Batch submission UI**. The portal PTU quickstart requires a `sku-capacity` (PTU count) parameter Loom doesn't collect.

**Azure-first build.** Extend the Deploy dialog (`foundry-hub-editor.tsx` / model-deployments route) with a deployment-type selector (Standard / Global Standard / Data Zone Standard / Global Provisioned / Data Zone Provisioned / Regional Provisioned / Global Batch / Data Zone Batch) sourced from the model card's supported SKUs. On a Provisioned* choice, add a PTU-count numeric input (validated ≥ the model's documented minimum) + a "Confirm pricing" `MessageBar` disclosing that hourly billing starts immediately; POST via the same `PUT /accounts/{a}/deployments/{d}` ARM call with `sku.name` + `sku.capacity`. For Batch: a new "Batch jobs" tab submitting a JSONL input (reuse the fine-tuning file-upload pattern) to `POST /openai/batches`, polling status, downloading output.
- **Bicep:** none new (same CS account); document the PTU-quota prerequisite in `ai-foundry.md`.
- **Gov notes.** Only `ProvisionedManaged` (regional) lists gpt-4o in usgov regions; **Batch is not Gov-supported** → honest-gate the Batch tab in Gov (per `appendix-scale-aoai-ptu.md §2.4`). No Fabric dependency.

**Acceptance.** Create a Provisioned deployment with a real PTU count (or honest-gate if quota absent) and submit a real Batch job in Commercial; PR shows the ARM response with `sku.capacity` and a batch job id + terminal status.

**Priority P1 · Effort M.**

**Build status (Wave 7) — ✅ built.** The Deploy dialog (`foundry-hub-editor.tsx`
`DeployModelDialog`) now has a **deployment-type selector** sourced from the
model card's SKUs via a new pure catalog `lib/foundry/deployment-types.ts`
(Standard / Global Standard / Data Zone Standard / Global Provisioned / Data
Zone Provisioned / Regional Provisioned / Global Batch / Data Zone Batch). On a
Provisioned* choice the capacity field relabels to **PTU count** (validated ≥
the documented floor via `validateCapacity`) and a **"Confirm pricing" checkbox**
gates Deploy behind an hourly-billing disclosure; the same `PUT deployments`
ARM call carries `sku.name` + `sku.capacity`. Live per-region **quota headroom**
is surfaced next to the capacity input (`/api/foundry/quota`). In a Gov boundary
(region-detected), non-Gov-GA types are shown but **honest-gated** (disabled +
MessageBar). A new **Batch jobs** surface (`BatchJobsSection`) uploads a JSONL
input (purpose=batch), creates a job, polls status, and downloads the output —
backed by real data-plane fns in `foundry-cs-client.ts` (`uploadBatchFile`,
`createBatchJob`, `getBatchJob`, `cancelBatchJob`, `getFileContent`) and routes
`app/api/foundry/batch/**`; the tab honest-gates entirely in Gov (Batch not
Gov-supported). No new bicep (same CS account). Unit-tested
(`deployment-types.test.ts`, 10 specs).

---

## AIF-12 — Model Router (router deployment + Loom-native tier router)

**Capability.** A `model-router` deployment that auto-selects the best underlying model per request (Quality/Cost mode, optional model subset), usable as an agent base model with the resolved model surfaced per turn — plus a Loom-native tier router in the orchestrator that picks among deployed models for cost/quality beyond today's binary docs-vs-build classifier. *(De-duplicates the two model-router findings across both research streams.)*

**Source grounding.**
- https://learn.microsoft.com/azure/foundry/openai/how-to/model-router
- https://learn.microsoft.com/azure/foundry/openai/how-to/model-router-agents

**Current Loom state — PARTIAL.** `foundry-agent-client.ts` / `FoundryAgentsPanel` model picker (`ai-foundry.md` A4) selects a single concrete deployment — no `model-router` type, no Quality/Cost toggle, no per-response `model` field in the run/steps inspector. Separately, `copilot-router.ts:157-230` implements only a binary docs-vs-build **intent** classifier (forced `tool_choice` AOAI call); `copilot-agents-config.tsx:341-342` has a per-tenant `routerDeployment` override that routes intent, not model selection.

**Azure-first build.**
- **Router deployment:** add `model-router` as a selectable deployment kind in the model-deployments create flow (same `PUT deployments` REST, model name `model-router`); expose a Routing-mode Dropdown (Quality/Cost) + optional model-subset multi-select, persisted alongside the deployment record in Cosmos. When an agent picks a `model-router` deployment in `FoundryAgentsPanel`, surface the resolved underlying model per turn in the existing steps/thread inspector (the chat-completions response's `model` field already returns — just render it).
- **Loom-native tier router:** in `copilot-orchestrator.ts`, given the tenant's ARM-listed AOAI deployments (already feeding `routerDeployment`'s picker), classify request complexity (reuse the `classifyIntent` forced-`tool_choice` pattern) and pick among a configured tier list before dispatch; emit the chosen model in the SSE `agent` step badge. Admin UI: a "Model tiers" table (deployment → cost tier → complexity threshold) in `copilot-agents-config.tsx`.
- **Bicep:** none (reuses existing AOAI deployments).
- **Gov notes.** **Model Router is `No` in Azure Government** (Learn Gov feature table) → Gov **must** use the app-layer tier router only; honest-gate the managed `model-router` deployment kind in Gov.

**Acceptance.** Create a `model-router` deployment in Commercial, attach it as an agent base model, and show the resolved per-turn model in the inspector; separately show the Loom-native tier router selecting a cheaper deployment for a simple request (step badge in an SSE trace).

**Priority P2 · Effort M.**

---

## AIF-13 — AgentOps: eval-linked tracing + per-agent cost/latency rollup

**Capability.** Jump from an evaluation-run row to the exact trace/span that produced it, and roll up cost/latency **per agent** (not just per operation) — Foundry's unified OpenTelemetry AgentOps pipeline.

**Source grounding.** Foundry Control Plane unified OTel pipeline (evals link directly to traces).

**Current Loom state — PARTIAL.** `foundry-sub-editors.tsx:1150-1210` `TracingEditor` is real (App Insights GenAI traces, span-tree drill via `/api/items/tracing/:id`) and `EvaluationEditor` exists (`registry.ts:148`), but there's no link from an eval-run row back to its trace, and no per-agent rollup.

**Azure-first build.** Persist the `traceId`/`runId` every agent-run call site already produces (`runAgentAndInspect` returns `threadId`+`runId`) alongside each evaluation row; add an "Open trace" action in `EvaluationEditor`'s results table deep-linking to `/items/tracing/<traceId>` (reusing `TracingEditor`). For rollup, extend the App Insights KQL behind `/api/items/tracing` to `GROUP BY customDimensions.agent_name` and add an "Agents" tab beside the existing time-window filter.
- **Bicep:** none — same App Insights connection wired for T25 usage metering (`copilot-ai.md`).
- **Gov notes.** App Insights KQL is Gov-native.

**Acceptance.** From a real eval run, click "Open trace" and land on the exact span tree that produced it; show an Agents rollup tab with real per-agent latency/cost aggregates.

**Priority P2 · Effort M.**

**Build status (Wave 7) — ✅ built.** AgentOps landed on the agent playground
(`foundry-agents.tsx`) rather than only the eval table, so per-agent
cost/latency/success threads through the runs an operator actually produces.
New pure module `lib/foundry/agentops.ts` (`normalizeUsage`, `stepTimings`,
`runLatencyMs`, `runMetrics`, `rollupAgentRuns`) derives **per-run trace
metrics** (real token counts + per-step timings + an ESTIMATED cost via the
rel-T85 `cost-estimate` price table / CTS usage threading) and a **per-agent
rollup** (runs, success rate, total/avg cost, avg + p95 latency, per-model
breakdown). The playground shows per-run metrics inline and an **AgentOps panel**
(rollup + eval). Runs persist their `model` + `usage` on the existing
`loom-agent-memory` thread doc (AIF-14), so `GET /api/foundry/agents/rollup`
aggregates without new storage. **Eval hooks**: a structured prompt-set editor
(rows, not JSON) runs each prompt through the agent (real `runAgentInspectTiered`)
and scores the answer 1-5 with a **real AOAI judge** (`aoaiChatJson`), stored as
a `docType:'eval'` doc (`saveEvalRun`/`listEvalRuns`) and rendered as a scored
results table — honest-gated (501) when no agent runtime tier is configured. No
new bicep (same App Insights + Cosmos container). Unit-tested
(`agentops.test.ts` 10, `agent-eval.test.ts` 7). ⬜ TODO (deferred): the
`EvaluationEditor` "Open trace" deep-link + the App Insights
`GROUP BY agent_name` tab from the original spec (the playground Cosmos rollup
covers the per-agent aggregate; the App-Insights-side variant is additive).

---

## AIF-14 — Durable cross-session agent memory

**Capability.** Persistent facts/preferences an agent proactively recalls across unrelated threads/sessions — Foundry managed-memory behavior — versus today's 28-day chat-history TTL.

**Source grounding.** Foundry Agent Service managed memory (persistent context across threads).

**Current Loom state — MISSING.** `copilot-ai.md:136-139` / F7 describes Cosmos `copilot-sessions` with a 28-day TTL as conversation *history*, not durable memory. No memory-store client and no `memory` tool type in `foundry-agent-client.ts` / `foundry-agents.tsx` `TOOL_TYPES`.

**Azure-first build.** New Cosmos container `loom-agent-memory` (PK `/agentId`, **no TTL**) storing durable fact/preference docs extracted from completed runs (reuse an AOAI call to summarize a completed thread into 1-5 memory facts — same pattern as the feedback pipeline in `azure-functions/copilot-chat`). Expose a `memory` tool type in the AIF-5 tool catalog that, when attached, prepends the agent's top-K relevant memories (simple Cosmos query, or an AI Search vector query over memory docs at scale) to the system prompt before each run.
- **Bicep:** one new Cosmos container `createIfNotExists` step — no new resource type.
- **Gov notes.** Cosmos + AOAI Gov-native.

**Acceptance.** Teach an agent a fact in one thread; in a new unrelated thread the agent recalls it (traced run showing the memory tool injecting the fact). Cosmos container has no TTL.

**Priority P2 · Effort M.**

**Build status (Wave 5) — ✅ built.** New Cosmos container `loom-agent-memory`
(PK `/agentId`, NO TTL) created via `cosmos-client.ts` `ensure()` +
`KNOWN_CONTAINER_IDS` and ARM-provisioned in `cosmos.bicep` loomContainers (like
Wave-2's item-versions). `lib/azure/agent-memory-client.ts` stores two doc kinds:
`docType:'thread'` (resumable run transcripts, capped by `LOOM_AGENT_THREAD_CAP`,
default 50) and `docType:'memory'` (durable facts summarized from a completed run
via one `aoaiChatJson` call, capped by `LOOM_AGENT_MEMORY_CAP`). The agents/run
route retrieves top-K memories and injects them before each run (into the MAF
system prompt or the Foundry question turn), then persists the thread + extracts
new memories after a completed run — default-on, opt out with
`LOOM_AGENT_MEMORY_ENABLED=false`. `/api/foundry/agents/threads` (GET list / GET
one / DELETE) backs a Threads list + Resume UI on the Agents playground. Unit-
tested (`agent-memory-client.test.ts`, 9 specs incl. retention-cap eviction).
⬜ TODO (deferred): AI Search vector retrieval over memory docs at scale (today's
retrieval is recency top-K); a dedicated `memory` tool-kind entry once AIF-5's
catalog lands (memory currently injects via the run path, not a discrete tool).

---

## AIF-15 — AI Red Teaming Agent (PyRIT adversarial scan)

**Capability.** Automated adversarial-prompt scanning of a deployed model/agent endpoint (PyRIT-based), scored for Attack Success Rate across risk categories (Prohibited Actions, Task Adherence, Sensitive Data Leakage, content risks), with a scorecard tracked over time.

**Source grounding.**
- https://learn.microsoft.com/azure/foundry/concepts/ai-red-teaming-agent
- https://learn.microsoft.com/azure/foundry/how-to/develop/run-ai-red-teaming-cloud

**Current Loom state — MISSING.** `ai-foundry.md` row C5 (Evaluations) covers dataset + evaluator + target runs but no red-teaming/adversarial type. `grep redTeam|red.?team|PyRIT` = zero. `ContentSafetyEditor` (C8) is ad-hoc single-call moderation, not a scanning campaign.

**Azure-first build.** New "Red teaming" sub-tab beside Evaluations in `foundry-sub-editors.tsx`: create a red-team run (target = an existing model deployment or agent via `initializationParameters.deploymentName` or `connectionName/deploymentName`), risk-category multi-select (3 built-ins + content-risk categories), submit via `POST /redTeams` REST, poll status, render the scorecard (ASR per category, attack-response pairs table) reusing `foundry-charts.tsx`. New client `foundry-redteam-client.ts` + route `app/api/foundry/redteams/**`.
- **Bicep:** none (existing Foundry project + AOAI Contributor role).
- **Gov notes.** Verify red-teaming GA per Gov region; honest-gate if absent.

**Acceptance.** Run a red-team scan against a real deployment; PR shows a real scorecard (ASR per category) and the attack-response pairs table.

**Priority P2 · Effort M.**

---

## AIF-16 — Scoring-profile / analyzer / CORS / CMK designers

**Capability.** Visual (non-JSON) authoring of weighted-field scoring profiles (freshness/magnitude/distance/tag functions), custom analyzers (tokenizer + char/token filters), and index-level CORS / customer-managed-key settings.

**Source grounding.**
- https://learn.microsoft.com/en-us/azure/search/index-add-scoring-profiles
- https://learn.microsoft.com/en-us/azure/search/index-add-custom-analyzers
- https://learn.microsoft.com/en-us/azure/search/search-security-manage-encryption-keys

**Current Loom state — MISSING.** `ai-search.md` rows 11-13: scoring-profile, suggesters/analyzers/normalizers/tokenizers, and CORS/encryptionKey are all JSON-only (raw Schema Monaco editor), not even MessageBar-flagged — a `no-freeform-config` shortfall.

**Azure-first build.** Extend the existing Schema-tab field designer (`foundry-sub-editors.tsx` `AiSearchIndexEditor`) with three additive sub-sections, all writing into the **same** `PUT /indexes/{name}` the field grid already uses: (1) **Scoring profiles** — named profile cards, per-field text-weights table + function picker (freshness/magnitude/distance/tag) with parameter inputs → `scoringProfiles[]`; (2) **Analyzers** — custom-analyzer builder (tokenizer + char-filters + token-filters from the fixed Lucene component list) → `analyzers[]`/`tokenizers[]`/`charFilters[]`; (3) **CORS + encryptionKey** — settings card (allowed origins, max-age; CMK Key Vault URI + identity picker) → `corsOptions`/`encryptionKey`.
- **Bicep:** none (purely additive form sections). **Gov notes:** index REST Gov-GA; CMK requires a Gov Key Vault.

**Acceptance.** Author a scoring profile + a custom analyzer + CORS via forms (no JSON), PUT the index, and show the round-tripped index definition reflecting all three (real GET response in PR).

**Priority P2 · Effort M.**

---

## AIF-17 — AI Search service administration in-editor

**Capability.** Keys/auth-mode, Identity (managed identity), Networking (firewall/PE/trusted-service), Monitoring (QPS/latency/throttling + diagnostics/alerts), and a Service-statistics/quotas panel — inside the AI Search editor, parity with Foundry's own Quota/Networking/Keys/Activity tabs.

**Source grounding.**
- https://learn.microsoft.com/en-us/azure/search/search-security-api-keys
- https://learn.microsoft.com/en-us/azure/search/search-security-manage-encryption-keys
- https://learn.microsoft.com/en-us/azure/search/monitor-azure-cognitive-search

**Current Loom state — MISSING.** `ai-search.md` rows 28-32 all MISSING from the editor; Overview/Scale (26/27) live on a separate `/admin/scaling` page, not in the editor; `getServiceStats()` exists in `aisearch-client.ts` but row 32 confirms no route/UI consumes it.

**Azure-first build.** Add a "Service" tab to the AI Search editor/navigator (the Foundry C9-C13 pattern is proven in-repo): **Keys** (ARM `listAdminKeys`/`listQueryKeys`, regenerate POST, AAD-vs-key toggle from `authOptions`), **Identity** (system/user-assigned MI), **Networking** (`publicNetworkAccess` PATCH + PE list, mirroring the foundry-networking route), **Monitoring** (new `queryServiceMetrics` like foundry's `queryObservabilitySummary` — QPS/latency/throttling), and a **Service-stats** panel wiring the existing `getServiceStats()` through a new `GET /api/ai-search/stats`.
- **Bicep:** add diagnostic-settings wiring to `ai-search.bicep` if absent so Monitoring has data.
- **Gov notes.** ARM + Monitor Gov-native.

**Acceptance.** Open the Service tab against a live Search service: regenerate a query key, toggle public network access, and render real QPS/latency + service stats (real responses in PR).

**Priority P2 · Effort M.**

---

## AIF-18 — Browser-automation tool type (Playwright ACA substitute)

**Capability.** A `browser_automation` agent tool type. Since there's no native Azure PaaS browser-automation service, the Azure-first substitute is a Loom-owned Container App running Playwright behind an OpenAPI/function tool schema — keeping the whole path Azure-native with zero external dependency.

**Source grounding.** Foundry Agent Service tool catalog — browser automation tool (2026 addition).

**Current Loom state — MISSING.** `foundry-agents.tsx:53-58` `TOOL_TYPES` = `code_interpreter`/`file_search`/`function` only; `grep browser_automation|computer-use` = zero.

**Azure-first build.** Add `browser_automation` as a 4th `TOOL_TYPES` entry (via the AIF-5 catalog), honest-gated by a `MessageBar`: "Browser automation requires a Playwright-based tool endpoint — deploy `platform/runners` or an equivalent headless-browser Container App and set `LOOM_BROWSER_TOOL_ENDPOINT`." The tool calls that Container App via an OpenAPI/function schema.
- **Bicep:** new minimal Container App module (reuse the scale-to-zero ACA pattern from `platform/runners/`) + UAMI; wire `LOOM_BROWSER_TOOL_ENDPOINT` into admin-plane env.
- **Gov notes.** Fully Loom-owned/in-VNet — Gov-portable; no external browser service.

**Acceptance.** Deploy the Playwright ACA, attach the `browser_automation` tool to an agent, and show a traced run where the agent drives a real page (screenshot/console from the tool). Absent the endpoint, the honest-gate MessageBar renders.

**Priority P3 · Effort M.**

**Build status (Wave 5) — ✅ built.** Shared tool-kind contract
`lib/azure/agent-tool-kinds.ts` (canonical `AGENT_TOOL_KINDS` + `browser_automation`
kind + `buildToolDefinition` + `toolKindGate` — the single module AIF-5's typed
catalog extends). The Agents editor adds `browser_automation` to its tool
checkboxes and renders an honest MessageBar (naming `LOOM_BROWSER_TOOL_JOB` + the
bicep module) when no runner is deployed, via `/api/foundry/browser-tool/status`.
Real execution path `lib/azure/browser-tool-client.ts`: POSTs to a synchronous
HTTP runner (`LOOM_BROWSER_TOOL_ENDPOINT`) or starts an Azure Container Apps Job
execution via ARM (`LOOM_BROWSER_TOOL_JOB`), honest-gated (never a mock) when
neither is set; also registered as a real `browser_automation` tool in the
cross-item Copilot registry. Bicep module
`platform/fiab/bicep/modules/copilot/browser-tool.bicep` (scale-to-zero ACA Job +
UAMI) and a real Playwright runner `platform/runners/browser-tool/` (Dockerfile +
`runner.mjs`). Opt-in env vars allowlisted in `check-env-sync`. Unit-tested
(`agent-tool-kinds.test.ts`, 8 specs). ⬜ TODO (deferred): wire the ACA-Job module
into `admin-plane/main.bicep` conditional deploy (blocked on the 256-param
ceiling — needs a derived enablement flag, not a new param) and the async
job-execution → agent-turn result round-trip (the HTTP-runner path is synchronous
today).

---

## Global acceptance & guardrails (applies to every item)

- **Real-backend receipt per `no-vaporware`:** every PR body carries the endpoint hit, the real response body (first ~300 chars), a browser screenshot or Playwright trace of the surface, and a bicep diff if infra changed. Reviewers reject PRs without it.
- **No Fabric/Power BI service dependency, ever** (`no-fabric-dependency`): all backends are Cognitive Services / AOAI + AI Search REST + Foundry Agent Service data-plane + Synapse/ADLS/ADX/Cosmos. Any Fabric/Power BI path is opt-in only and never the default. Grep guards (`api.fabric.microsoft.com`, `api.powerbi.com`, `onelake.dfs.fabric`) stay clean on default paths.
- **No freeform JSON config** (`no-freeform-config`): the operations-agent freeform tool box (AIF-5) is removed; skillsets/vector-profiles/scoring-profiles move from JSON textareas to wizards/dropdowns/cards; multi-agent flows use `canvas-node-kit`.
- **Fluent v9 + Loom tokens + `canvas-node-kit`** for every new surface (`loom-design-standards`).
- **Bicep-synced:** new role grants (Search→AOAI embeddings, MAF UAMI, browser-tool UAMI), the two new Cosmos containers (agent memory, router config if persisted), and diagnostic settings are all added to bicep and validated by `az deployment sub validate` + `what-if`.
- **Dual-cloud honest-gates:** Model Router, Batch, Bing grounding, agentic-retrieval regions, and Foundry Agent Service in GCC-High/IL5 each carry a Gov honest-gate that falls through to the Azure-native / MAF substitute — never a hard block.
- **Parity docs updated:** `docs/fiab/parity/ai-foundry.md` and `docs/fiab/parity/ai-search.md` rows flip to built ✅ / honest-gate ⚠️ as each item lands (zero ❌, zero stub banners for A-grade).
