# data-agent — parity with Fabric Data Agent

**Source UI:** Microsoft Fabric → Data Science → **Data agent** (preview).
Grounded in Microsoft Learn:

- https://learn.microsoft.com/fabric/data-science/how-to-create-data-agent
- https://learn.microsoft.com/fabric/data-science/concept-data-agent
- https://learn.microsoft.com/fabric/data-science/data-agent-add-datasources
- https://learn.microsoft.com/fabric/data-science/data-agent-example-queries
- https://learn.microsoft.com/fabric/data-science/data-agent-configurations
- https://learn.microsoft.com/fabric/data-science/data-agent-end-to-end-tutorial

Loom surface: `lib/editors/phase4-editors.tsx` → `DataAgentEditor`
(registered as `data-agent` in `lib/editors/registry.ts`). Pure logic in
`lib/editors/_family-utils.ts`; runtime in `lib/azure/data-agent-client.ts`.

> Note: the legacy chat-only pane at `/data-agent`
> (`lib/panes/data-agent.tsx`) is a separate, honestly-deprecated surface — its
> `/api/data-agent/chat` route returns a 503 + remediation pointing at the
> cross-item Copilot orchestrator. The **editor** below is the parity surface.

## Fabric feature inventory (every capability, grounded in Learn)

| # | Fabric capability | Detail |
|---|---|---|
| 1 | **Add up to 5 data sources** | Any combination of lakehouse, warehouse, KQL/Eventhouse, Power BI semantic model, ontology, Microsoft Graph (max 5 total). |
| 2 | **Schema / table selection** | Per source: pick Tables / Views / Functions (SQL), Tables / MVs / Functions / Shortcuts (KQL), model tables (semantic). Graph & ontology are queried whole (no scoping). |
| 3 | **Data agent instructions (global)** | Up to 15,000 chars, plain English; routes question types to sources, defines terminology. |
| 4 | **Data source description (per source)** | Routing hint — helps the agent decide whether a source is relevant to a question. (Not supported for semantic model in Fabric.) |
| 5 | **Data source instructions (per source)** | Table descriptions / join logic / business terms passed to NL2SQL/NL2KQL/NL2GQL. (For semantic models, managed via Power BI Prep for AI.) |
| 6 | **Example queries (few-shot)** | Question → query pairs. Supported: lakehouse, warehouse, KQL, graph (GQL), AI Search. **Not** supported: semantic model, ontology. |
| 7 | **Test / chat pane** | Ask a question, get a grounded NL answer + the generated query, see which source was used. |
| 8 | **Publish** | Publishes the agent (instructions + sources as tools) so Foundry / Copilot Studio can consume it via a workspace-id + artifact-id pair. |
| 9 | **Run-steps / debug view** | Inspect which example queries were retrieved for a turn. |

## Loom coverage (built ✅ / honest-gate ⚠️ / MISSING ❌)

| # | Capability | Status | Notes |
|---|---|---|---|
| 1 | Up to 5 typed sources | ✅ | Build tab; `DA_SOURCE_TYPES` now covers warehouse, lakehouse, KQL, semantic-model, AI Search, **ontology**, **graph-model**. Picker enforces the 5-source cap. Sources are **real Loom items** listed via `GET /api/items/by-type` (Cosmos). |
| 2 | Schema / table selection | ✅ | Per-source comma-separated tables/views/functions input with a type-aware label (`DA_SCHEMA_LABEL`). Ontology & graph correctly show "queried whole — no scoping" instead of a misleading box. (A live checkbox tree over the source's schema is a future enhancement; the scope is honestly captured and flows into the grounded prompt today.) |
| 3 | Global agent instructions (≤15k) | ✅ | `instructions` textarea, `maxLength=15000` with live counter. |
| 4 | Data source description | ✅ | **New** per-source `description` field, persisted, fed into the system prompt as "When to use this source:". |
| 5 | Data source instructions | ✅ | Per-source `instructions` textarea pre-seeded with the Fabric template. |
| 6 | Example queries (few-shot) | ✅ | Per-source add/edit/delete pairs, **gated by `daSupportsExampleQueries`** — hidden for semantic-model & ontology with the exact Fabric explanation (Prep for AI / unsupported), matching Learn. |
| 7 | Test / chat pane | ✅ (live, executes + visualizes) / ⚠️ (infra-gate) | Test tab runs against the **live AOAI deployment**. The generated per-source query is **EXECUTED read-only on the real backend** — warehouse → Synapse dedicated SQL/TDS, lakehouse → Synapse serverless SQL, KQL → ADX, **AI Search → `docs/search` REST** — and the model is **re-prompted with the real rows**. The prompt now **forbids hedging** ("would you like me to run it?" / "imagine…"): the agent always emits the query and the platform runs it automatically. Results render as a **modern mini-BI card** (`DataAgentResultViz`): KPI tile for single values, bar/time **chart** (`KqlChart`) for label/numeric or time series, or a styled **table** — with a Table/Chart/KPI toggle. Honest ⚠ gate per unreachable source (semantic-model DAX needs an XMLA endpoint → gated). Queries hard-gated read-only (SELECT/WITH only; KQL mgmt/ingest blocked), capped to 25 rows. No model deployed → honest 503 naming `LOOM_AOAI_ENDPOINT`/`LOOM_AOAI_DEPLOYMENT`. Logic: `lib/azure/data-agent-execute.ts` + `lib/editors/data-agent-result-viz.tsx`. |
| 8 | Publish | ✅ / ⚠️ | Publishes to the **Foundry Agent Service** (`createOrUpdateAgent`). Not configured → honest 501 MessageBar naming `LOOM_FOUNDRY_PROJECT_ENDPOINT` / `LOOM_FOUNDRY_PROJECT_ID`. Returns the workspace-id + artifact-id pair for Copilot Studio / Foundry connections. |
| 9 | Run-steps / debug view | ❌ (deferred) | Fabric's per-turn example-retrieval inspector is not built. The chat pane already surfaces the generated query + source used per turn, which covers the common debugging need; the full run-steps tree is deferred. |

## Backend per control

| Control | Route | Backend |
|---|---|---|
| Source picker (list real items per type) | `GET /api/items/by-type?types=<itemType>` | Cosmos `items` container, tenant-scoped by workspace ownership. Real items only. |
| Save draft (instructions + sources + descriptions + examples) | `PATCH /api/items/data-agent/[id]` (`useItemState`) | Cosmos `items` upsert + AI Search mirror. |
| Test chat turn | `POST /api/items/data-agent/[id]/chat` | Loads Cosmos config → `chatGrounded()`: (1) AOAI chat/completions proposes an answer + per-source query, (2) `executeSourceQuery()` runs each query **read-only on the real backend** (Synapse SQL / ADX), (3) AOAI is re-prompted with the real rows for a grounded final answer. Tools carry `{executed, rowCount, columns, rows, gate}`. 503 + remediation when no model; per-source honest gate when a backend is unreachable. |
| Publish | `POST /api/items/data-agent/[id]/publish` | `createOrUpdateAgent()` → Azure AI Foundry **Agent Service** (real REST). Snapshots published config in Cosmos. 501 + hint when Foundry not configured. |
| Deploy (legacy alt entry) | `POST /api/items/data-agent/[id]/deploy` | Same Foundry Agent Service path from the legacy free-text bag. |

## Grade

**B → approaching A.** Every Fabric inventory row is built ✅ or honest-gated
⚠️ except the run-steps debug inspector (❌, deferred — not on the critical
create/configure/test/publish path). New pure logic
(`daSupportsExampleQueries`, ontology/graph typing, per-source description
normalization) is unit-tested in
`lib/editors/__tests__/family-utils.test.ts`.

## Bicep sync

No new Azure resource, env var, role, or Cosmos container introduced by this
change — it extends an existing Cosmos-backed item type and reuses the already
-wired AOAI (`LOOM_AOAI_*`) and Foundry (`LOOM_FOUNDRY_*`) env contracts. No
bicep diff required.
