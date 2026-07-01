# data-agent — parity with Microsoft Fabric Data Agent (NL-to-query AI data agent)

**Source UI:** Microsoft Fabric → Data Science → **Data agent**. Grounded in Microsoft Learn:

- https://learn.microsoft.com/fabric/data-science/concept-data-agent
- https://learn.microsoft.com/fabric/data-science/how-to-create-data-agent
- https://learn.microsoft.com/fabric/data-science/data-agent-add-datasources
- https://learn.microsoft.com/fabric/data-science/data-agent-configurations
- https://learn.microsoft.com/fabric/data-science/data-agent-configuration-best-practices
- https://learn.microsoft.com/fabric/data-science/data-agent-end-to-end-tutorial
- https://learn.microsoft.com/fabric/data-science/evaluate-data-agent

Loom surface: `apps/fiab-console/lib/editors/phase4/data-agent-editor.tsx` → `DataAgentEditor`
(registered for `data-agent` in `lib/editors/registry.ts`). Lifecycle pane
`lib/panes/data-agent.tsx`; Config-Copilot `lib/editors/data-agent-config-copilot.tsx`;
result-viz `lib/editors/data-agent-result-viz.tsx`. Runtime
`lib/azure/data-agent-client.ts` (grounded chat) + `lib/azure/data-agent-execute.ts`
(real read-only per-source query execution). Routes under
`app/api/items/data-agent/[id]/*` (chat / conversations / copilot / evaluate / publish /
m365-copilot / deploy).

**Last verified: 2026-07-01 against current code.** The editor now ships tabs
Build · Config Copilot · Test chat · **Evaluate** · Publish · **Consume** · Run
inspector · Monitoring — Evaluation (#15), Consume (#20), and conversation
starters (#22) have shipped and flip ❌→✅ below.

Azure-native by default (no Microsoft Fabric dependency): a data agent is a Cosmos
item; grounded chat runs on the Azure OpenAI deployment the cross-item Copilot
resolves; sources execute against Synapse (T-SQL), ADLS/Spark (lakehouse), ADX (KQL),
Azure AI Search, ADX graph. Publishing to Foundry Agent Service / M365 Copilot is
strictly opt-in.

---

## Real feature inventory (every capability, grounded in Learn)

### A. Data sources (left "explorer" rail)
1. Add up to **5 data sources** in any combination.
2. Source types: **Lakehouse**, **Warehouse / SQL DB**, **KQL database / Eventhouse**,
   **Power BI semantic model**, **Ontology (preview)**, **GQL graph model (preview)**,
   **Microsoft Graph**, **Azure AI Search index / unstructured (preview)**.
3. **Schema selection** — a browsable schema tree to check specific **Tables / Views /
   Functions** (SQL), **Tables / Materialized views / Functions / Shortcuts** (KQL),
   **Tables** (lakehouse), model tables (semantic). Graph/ontology = whole (no scope).
4. **Data source description** — high-level routing context per source.
5. **Data source instructions** — table/column descriptions, join logic, value formats,
   "when asked about X use table Y" routing logic.
6. **Example queries (few-shot)** — NL→SQL/KQL/GQL pairs per source; **only valid,
   schema-matching queries are used** (Fabric validates and ignores invalid ones);
   top-3 retrieved by vector similarity at query time.
7. **AI Search unstructured config** — Display Name, **Search Type** (full-text / hybrid
   / semantic), **Number of Documents** (3–20), Context/Description, Agent Instructions;
   **citations** (URL / file-path fields) returned automatically.
8. **Semantic-model "Prep for AI"** — AI Data Schemas, AI Instructions, Verified Answers
   on the Power BI side; the agent honors them.

### B. Agent-level configuration
9. **Agent instructions** — up to **15,000 chars**, plain-English cross-source routing
   + term definitions.
10. **Agent name / description** — shown to consuming orchestrators for routing.

### C. Build / test loop
11. **NL chat test pane** (right side) — ask, get grounded answers.
12. **Generated-query transparency** — the exact SQL/KQL/DAX run, which source was
    picked, and (for AI Search) cited documents.
13. **Multi-source routing** — agent picks among sources; trace shows which.
14. **Conversation thread** with history.

### D. Evaluation
15. **Data agent evaluation** — supply a **ground-truth set** of question/expected-answer
    (or expected-query) pairs, run the agent over all, get an **accuracy score +
    per-question pass/fail**, the generated query, and the thread link per row; iterate.

### E. Guardrails / governance
16. Agent answers **only from attached sources** (scope limiting).
17. Queries run **read-only under the caller's identity** (RLS/CLS honored).
18. Content safety on the model; sensitivity-aware (Purview labels on sources).

### F. Publish / consume
19. **Publish** a versioned agent; draft vs published version.
20. **Consume programmatically** — published agent reachable as a REST endpoint
    (OpenAI-compatible) + Python SDK; consumable from **AI Foundry** and **Copilot Studio**.
21. **Version history** — published versions; see/restore current published version.
22. **Conversation starters / suggested prompts** surfaced to consumers.

---

## Loom coverage (built ✅ / honest-gate ⚠️ / MISSING ❌)

| # | Capability | Status | Notes / backend |
|---|------------|--------|-----------------|
| 1 | Up to 5 typed sources | ✅ | `addSource` caps at 5; sources are real Loom items via `GET /api/items/by-type` |
| 2 | Source types | ⚠️ | warehouse / lakehouse / kql / semantic-model / ai-search / ontology / graph built; **Microsoft Graph ❌** |
| 3 | Schema selection | ❌ | only a **comma-separated `tables` text Input** + type-aware label — no schema tree picker (violates `no-freeform-config`) |
| 4 | Data source description | ✅ | per-source `description`, fed into the grounded prompt |
| 5 | Data source instructions | ✅ | per-source `instructions` textarea, seeded with the Fabric template |
| 6 | Example queries (few-shot) | ⚠️ | authored + Config-Copilot-generated; gated correctly per type; **no schema validation of examples** |
| 7 | AI Search unstructured config | ❌ | ai-search treated as a generic source; no search-type / doc-count / citations |
| 8 | Semantic-model Prep-for-AI | ⚠️ | honest MessageBar points at Power BI Prep for AI |
| 9 | Agent instructions (15k) | ✅ | `maxLength=15000` + live counter + template |
| 10 | Agent name / description | ✅ | `alias` + `description` |
| 11 | NL chat test pane | ✅ | `/chat` → live AOAI grounded turn, composer pinned |
| 12 | Generated-query transparency | ✅ | tools-used trace + executed rows (`DataAgentResultViz` KPI/chart/table toggle) |
| 13 | Multi-source routing trace | ✅ | `tools[]` per turn |
| 14 | Conversation history | ✅ | `/conversations` (Cosmos), History menu |
| 15 | **Evaluation** | ✅ | Evaluate tab: ground-truth `Table` + Run → `POST /evaluate` runs each Q through `chatGrounded`, judges with an AOAI LLM-as-judge (`aoaiChatJson`), persists `evalRuns` to Cosmos, shows accuracy donut + per-Q pass/fail + run history |
| 16 | Answer only from sources | ✅ | system prompt scope-limits |
| 17 | Read-only under identity | ✅ | `data-agent-execute` SELECT/WITH-only, KQL mgmt/ingest blocked, 25-row cap |
| 18 | Content safety / sensitivity | ⚠️ | DSPM labels emitted post-hoc (`resolveAgentSourceLabels`); **no guardrails config UI** |
| 19 | Publish (Foundry / M365) | ✅ / ⚠️ | `/publish` (Foundry Agent Service) + `/m365-copilot` (Copilot Studio); honest infra-gates |
| 20 | **Consume / REST endpoint + snippets** | ✅ | Consume tab renders the POST endpoint + copy-paste cURL / Python / JS snippets (lang `Dropdown` + Copy). Snippets target the existing `/chat` route (no separate `consume/` route / APIM exposure yet) |
| 21 | Version history | ❌ | `publishedSnapshot` stored but no versions UI / restore |
| 22 | Conversation starters | ✅ | Consume tab authors suggested prompts (add/update/remove), persisted to `state.conversationStarters`, surfaced in the Test-pane empty state |
| — | Run-steps inspector (published Foundry agent) | ✅ | extra-vs-Fabric: `/data-agent/run-steps` trace |
| — | Monitoring (Azure Monitor alert rules) | ✅ | extra-vs-Fabric: reuses activator rules route |

**Grade: B+ / A- (functional, real backend).** The build/test loop is real and
grounded, and **Evaluation** (LLM-as-judge `/evaluate` persisting runs to Cosmos),
a **Consume** endpoint + cURL/Python/JS snippets, and **conversation starters** have
now shipped — all three flip ❌→✅. The rows that remain genuinely missing/partial
are the real schema-tree picker (#3, still comma-separated text), Microsoft Graph
source type (#2), AI Search unstructured config (#7), a Guardrails config surface
(#18), and version history (#21) — that's what still reads as "basic."

---

## Build plan (prioritized)

### P0 — visible parity uplift
- **Evaluation tab.** New `Evaluate` tab + `POST /api/items/data-agent/[id]/evaluate`.
  Author/import a ground-truth set (question + expected answer/query) into a Cosmos
  `data-agent-eval` doc; "Run evaluation" iterates each question through `chatGrounded`,
  judges with an AOAI LLM-as-judge (correctness + query-match), persists a run with
  per-question pass/fail + generated query + thread link, shows an aggregate accuracy
  ring + a results `DataGrid`. Web5: `TileGrid` of past runs, `EmptyState`, status badges.
- **Schema-tree source picker.** Replace the comma-separated `tables` `Input` with a real
  checkbox **schema browser** (`Tree`/`TreeItem` of Tables/Views/Functions; KQL adds MVs/
  Functions/Shortcuts) fed by a new `GET /api/items/data-agent/[id]/source-schema?sourceId=`
  route introspecting the real backend (Synapse `INFORMATION_SCHEMA`, ADX `.show
  tables/functions`, ADLS/Delta catalog, AI Search fields) — much of the introspection
  already exists in `data-agent-execute` / Config Copilot. Persist selected objects typed.
- **Microsoft Graph + AI Search source config.** Add a `microsoft-graph` source type
  (honest-gate on Graph perms) and an AI Search config block (Display Name, Search Type
  `Combobox`, Number of Documents `SpinButton` 3–20, Context). Surface AI Search
  **citations** (doc title + link) in the chat trace.

### P1
- **Guardrails panel** (sub-section/tab). Typed controls (no JSON): max rows returned
  (`SpinButton`), allowed/blocked topics (`TagPicker`), "answer only from sources"
  `Switch`, PII/sensitivity redaction `Switch` (wires to `resolveAgentSourceLabels` /
  Purview), AOAI content-safety `Switch`. Enforced in `data-agent-execute` (row cap) +
  `chatGrounded` (scope/topics) + the chat route.
- **Consume tab.** Stable Loom REST endpoint + copy-paste **cURL / Python / JS** snippets
  (OpenAI-compatible against the existing `/chat` route), Entra/API-key auth note, optional
  "Expose via APIM" action (real APIM import). `CodeBlock` with copy per language.
- **Example-query validation.** On blur / "Validate", dry-run each few-shot example's
  SQL/KQL against the picked schema via `data-agent-execute` (parse/EXPLAIN, no data
  movement); badge each pair valid/invalid and warn invalid pairs are ignored (Fabric behavior).

### P2
- **Version history.** List `publishedSnapshot` versions (timestamp + diff vs draft +
  restore); `GET/POST /api/items/data-agent/[id]/versions`.
- **Per-agent model + temperature settings** (Settings sub-panel) overriding the cross-item
  AOAI default; `Dropdown` of deployed models + `Slider` temperature.
- **Conversation starters authoring** — list of suggested prompts persisted to state,
  emitted on publish (Foundry/M365) + shown in the test-pane empty state.

## Bicep sync

P0/P1/P2 extend an existing Cosmos-backed item type and reuse already-wired AOAI
(`LOOM_AOAI_*`), Foundry (`LOOM_FOUNDRY_*`), Synapse/ADX, AI Search, and Purview env
contracts. The eval ground-truth set persists in the existing Cosmos `items`/agent state
(or a `data-agent-eval` doc in the same container — `createIfNotExists`); no new Azure
resource. APIM exposure (P1 Consume) reuses the existing APIM module if the operator opts in.
