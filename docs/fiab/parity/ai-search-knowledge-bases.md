# ai-search-knowledge-bases — parity with Azure AI Search agentic retrieval (Foundry IQ)

Source UI:
- https://learn.microsoft.com/azure/search/agentic-retrieval-overview
- https://learn.microsoft.com/azure/search/get-started-portal-agentic-retrieval (portal Import/preview)
- https://learn.microsoft.com/azure/search/agentic-knowledge-source-how-to-search-index
- https://learn.microsoft.com/azure/search/agentic-retrieval-how-to-create-knowledge-base
- https://learn.microsoft.com/azure/search/agentic-retrieval-how-to-retrieve
- https://learn.microsoft.com/azure/ai-foundry/agents/how-to/tools/knowledge-retrieval

**Loom surface:** the AI Search editor's service navigator now has a **"Knowledge
bases"** group. Selecting it opens `KnowledgeBasesPanel`
(`lib/components/ai-search/knowledge-bases-panel.tsx`), a three-tab surface —
Knowledge sources / Knowledge bases / Retrieve test — Loom-themed (Fluent v9 +
Loom tokens), backed by the real `2026-04-01` GA agentic-retrieval REST API on
the same AI Search service.

**API version.** GA is `2026-04-01` (Commercial + GCC): knowledge sources,
knowledge bases, and extractive retrieval (`intents` input). Answer synthesis +
conversational `messages` input are `2026-05-01-preview`; Loom opts into the
preview version **only** when the retrieve "Synthesize a single answer" toggle is
on (and the base is configured for it) — the default path stays on GA.

## Azure / Foundry feature inventory (grounded in Learn)

| # | Capability (portal / REST) | REST |
|---|----------------------------|------|
| 1 | List knowledge sources (name, kind) | `GET /knowledgesources` |
| 2 | Create a **searchIndex** knowledge source over an existing index (semantic config + source/search fields) | `PUT /knowledgesources/{name}` |
| 3 | Delete a knowledge source (blocked while a base references it) | `DELETE /knowledgesources/{name}` |
| 4 | List knowledge bases | `GET /knowledgebases` |
| 5 | Create a knowledge base composing sources (+ reasoning effort, output mode, optional model) | `PUT /knowledgebases/{name}` |
| 6 | Delete a knowledge base | `DELETE /knowledgebases/{name}` |
| 7 | Retrieve — decompose → subquery → semantic rerank → grounding/answer, with activity (subqueries) + references (citations) | `POST /knowledgebases/{name}/retrieve` |
| 8 | Answer synthesis (single LLM answer) + conversational history | preview `messages` + `outputMode:answerSynthesis` |
| 9 | MCP endpoint (`knowledge_base_retrieve`) consumable by agents/Copilot | Foundry Agent Service tool |

## Loom coverage

| # | Capability | Status | Where / backend |
|---|------------|--------|-----------------|
| 1 | Knowledge sources list | ✅ built | `GET /api/ai-search/knowledge-sources` → `listKnowledgeSources` |
| 2 | Create knowledge source (typed wizard: pick index from live estate, semantic config, description — **no JSON**) | ✅ built | `POST …/knowledge-sources` → `createKnowledgeSource` (`PUT /knowledgesources/{n}`) |
| 3 | Delete knowledge source | ✅ built | `DELETE …/knowledge-sources?name=` |
| 4 | Knowledge bases list (sources chips, output mode) | ✅ built | `GET …/knowledge-bases` → `listKnowledgeBases` |
| 5 | Create knowledge base (typed wizard: multi-select sources, reasoning-effort dropdown, description) | ✅ built | `POST …/knowledge-bases` → `createKnowledgeBase` (`PUT /knowledgebases/{n}`) |
| 6 | Delete knowledge base | ✅ built | `DELETE …/knowledge-bases?name=` |
| 7 | Retrieve-test pane (question → subqueries + citations + grounding/answer) | ✅ built | `POST …/knowledge-bases/{name}/retrieve` → `retrieveKnowledge` |
| 8 | Answer synthesis toggle (preview) | ⚠️ honest-gate | Switch selects `2026-05-01-preview` + `messages`; requires a base configured for synthesis. Extractive is the GA default. |
| 9 | Copilot `knowledge_base_retrieve` tool (+ `knowledge_base_list`) | ✅ built | `lib/copilot/knowledge-tools.ts` → registered in `buildDefaultRegistry()` so Loom's own Copilot grounds RAG on agentic retrieval |

Zero ❌. The only non-full state is the honest preview-gated answer-synthesis path
(extractive retrieval is fully GA and is the default).

## Backend per control

- **Client:** `lib/azure/aisearch-knowledge.ts` — a NEW sibling of
  `search-index-client.ts` (reuses its service-name resolution + honest-gate +
  error types; same `ChainedTokenCredential` + `https://search.azure.com/.default`
  scope). No mocks, no Fabric / Power BI.
- **BFF:** `app/api/ai-search/knowledge-sources/route.ts`,
  `app/api/ai-search/knowledge-bases/route.ts`,
  `app/api/ai-search/knowledge-bases/[name]/retrieve/route.ts` — session-validated,
  `{ ok, data, error }`, honest 503 gate (`LOOM_AI_SEARCH_SERVICE`).
- **Copilot:** `knowledge_base_retrieve` / `knowledge_base_list` tools.

## Gov / sovereign

`2026-04-01` agentic retrieval is GA for Commercial + GCC (both run on Commercial
Azure endpoints). For **GCC-High / DoD** the panel and Copilot tools honest-gate
with a Fluent `MessageBar intent="warning"` (`knowledgeGovGate()`) naming the
required `2026-04-01` api-version to verify in the sovereign region — no fake
answer, no default-path Fabric dependency. Web knowledge sources (unsupported in
sovereign clouds) are intentionally not offered; Loom creates **searchIndex**
sources only.

## Bicep

None new — reuses the AI Search service + the UAMI's existing **Search Service
Contributor** + **Search Index Data Contributor** roles
(`platform/fiab/bicep/modules/admin-plane/ai-search.bicep`). No new env var, no
new role assignment. Extractive retrieval needs no model; answer synthesis (opt-in
preview) would reference the existing Foundry AOAI deployment.

## Verification

`pnpm test` covers the client (`lib/azure/__tests__/aisearch-knowledge.test.ts`),
the routes (`app/api/ai-search/knowledge-bases/__tests__/route.test.ts`), and the
Copilot tools (`lib/copilot/__tests__/knowledge-tools.test.ts`). Live receipt:
create a knowledge source over a real index, create a base, `POST …/retrieve` with
a multi-part question, confirm subqueries + citations + grounding in the pane.
