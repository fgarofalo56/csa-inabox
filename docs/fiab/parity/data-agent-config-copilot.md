# data-agent-config-copilot — parity with Fabric Data Agent "example queries" + AI instructions

Source UI: Microsoft Fabric → Data agent → per-source **Example queries** grid +
**AI instructions**, and Power BI **"Prep for AI" / Verified Answers**. Learn:
- https://learn.microsoft.com/fabric/data-science/concept-data-agent
- https://learn.microsoft.com/fabric/data-science/data-agent-example-queries
- https://learn.microsoft.com/power-bi/create-reports/copilot-evaluate-data-quality

CSA Loom realizes this on Azure-native backends (Synapse SQL, ADX, AI Search) —
no Fabric/Power BI workspace required (`.claude/rules/no-fabric-dependency.md`).

## Fabric feature inventory (example-query / description authoring)

| # | Capability in Fabric | Notes |
|---|----------------------|-------|
| 1 | Add example question → query pairs per data source | Few-shot grounding for NL→query |
| 2 | AI-assisted generation of example queries from the source schema | Fabric suggests examples from table/column metadata |
| 3 | Per-column / per-field descriptions feeding the agent's grounding | Improves routing + answer quality |
| 4 | Examples validated by running against the real source | Author confirms the query returns rows |
| 5 | Descriptions + examples persisted to the agent definition | Saved to the item, used at query time |
| 6 | Source-type-aware query language (SQL / KQL / DAX / search) | Per attached source |

## Loom coverage

| # | Loom surface | Status | Backend per control |
|---|--------------|--------|---------------------|
| 1 | Build tab — editable example pairs per source (pre-existing) | built ✅ | persisted in `state.sources[].examples` via PATCH `/api/items/data-agent/[id]` |
| 2 | **Config Copilot tab — "Generate" per source** | built ✅ | `POST …/copilot {action:'generate'}` → `fetchSourceSchema` (real Synapse/ADX/AI Search schema) → AOAI (`agent-config-copilot` persona) |
| 3 | **Field descriptions generated + previewed, written into source instructions** | built ✅ | same call; persisted via `{action:'apply'}` → `updateOwnedItem` |
| 4 | Generated examples run against the real source | built ✅ | applied examples land in `state.sources[].examples`; `composeSystemPrompt` injects them; test-chat phase-2 runs them read-only via `executeSourceQuery` |
| 5 | Apply persists to the real config doc | built ✅ | `{action:'apply'}` → Cosmos `items` PATCH; editor mirrors + re-saves the exact snapshot |
| 6 | Source-type-aware language (T-SQL / Spark SQL / KQL / search string) | built ✅ | persona prompt + `QUERY_LANG` map |
| — | Semantic-model (DAX) example generation | honest-gate ⚠️ | MessageBar: DAX examples come from Power BI "Prep for AI" Verified Answers; copilot covers warehouse/lakehouse/KQL/AI Search |
| — | Ontology / graph example generation | honest-gate ⚠️ | MessageBar: queried whole — no column schema to ground on |
| — | No AOAI model deployed | honest-gate ⚠️ | 503 → MessageBar with Foundry-hub "deploy gpt-4o-mini" remediation |
| — | Backend unconfigured (ADX/AI Search env unset) | honest-gate ⚠️ | 200 `{gate}` → MessageBar naming the exact env var |

Zero ❌, zero stub banners.

## Backend per control

- **Schema read (grounding):** `lib/copilot/agent-config-tools.ts::fetchSourceSchema`
  - warehouse → `INFORMATION_SCHEMA.COLUMNS` on the Synapse **dedicated** SQL pool (`dedicatedTarget()`)
  - lakehouse → same query on Synapse **serverless** over the delta DB (`serverlessTarget(name)`)
  - kql → `.show tables details` + `.show table schema as json` on **ADX** (`listTableDetails` / `getTableSchema`)
  - ai-search → `getIndex(name)` field list on **Azure AI Search**
- **Generation:** `generateSuggestions` → `resolveAoaiTarget()` (admin-config → env → Foundry discovery) → AOAI `chat/completions`, UAMI token via `cogScope()` (sovereign-correct on GCC-High/IL5). Persona system prompt = `AGENT_CONFIG_COPILOT`.
- **Persist:** `applyToSource` → `mergeSuggestionIntoSources` (shared pure helper `_da-config-merge.ts`) → `updateOwnedItem` (Cosmos).

## Per-cloud

`cogScope()`, `dedicatedTarget`/`serverlessTarget`, `clusterUri()`, `getIndex` already
encapsulate the Commercial vs GCC-High/IL5 hosts + audiences — no cloud branching in the
new code. AOAI, Synapse, ADX, and AI Search are all available in USGov boundaries.

## Verification (real-data E2E)

With `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET, against a real `data-agent` item with a
warehouse source bound to the Synapse dedicated pool:
1. `POST /api/items/data-agent/<id>/copilot {action:'schema', sourceId}` → real `INFORMATION_SCHEMA` table/column text.
2. `{action:'generate'}` → `{suggestion:{examples,descriptions,schemaUsed}}` grounded on that schema (no invented columns).
3. `{action:'apply', approved}` → `{ok:true}`; GET the item shows `state.sources[].examples` + `instructions` with the field-descriptions block.
4. Test chat asks a question → the applied example query runs read-only against the live pool (`executed:true`, real `rowCount`).

Unit-tested: `lib/copilot/__tests__/agent-config-tools.test.ts` (18 tests — parse, gates, schema text, merge).
