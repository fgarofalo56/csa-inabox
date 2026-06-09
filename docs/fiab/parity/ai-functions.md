# ai-functions — parity with Fabric "AI functions" (sentiment · classify · translate · summarize · extract)

Source UI:
- Fabric AI functions overview: https://learn.microsoft.com/fabric/data-science/ai-functions/overview
- Fabric AI functions in T-SQL / SQL surfaces (the `ai_*` family): the Fabric
  data-science "AI functions" exposed over notebooks + the SQL `AI` functions.
- Databricks AI SQL functions (the Azure-native engine for the in-database path):
  https://learn.microsoft.com/azure/databricks/large-language-models/ai-functions
  (`ai_analyze_sentiment`, `ai_classify`, `ai_summarize`, `ai_translate`,
  `ai_extract`, `ai_query`).
- Azure OpenAI chat completions (the sovereign substitute):
  https://learn.microsoft.com/azure/ai-services/openai/reference

Fabric's "AI functions" let an analyst enrich a text column — sentiment,
classification, translation, summarization, field extraction — from the data
surface, backed by a managed LLM. This brings the same five enrichments to the
Loom SQL editor, Azure-native and with **no Microsoft Fabric / Power BI
dependency**.

## Source feature inventory

| # | Capability | Source behaviour |
|---|------------|------------------|
| 1 | **Pick an AI function** | sentiment / classify / translate / summarize / extract |
| 2 | **Pick the text column** to enrich | dropdown over the table's columns |
| 3 | **Per-function options** | classify labels, extract fields, translate target language |
| 4 | **In-database execution** | the function runs over the warehouse/lakehouse, returning enriched rows next to the source column |
| 5 | **Insert / author the call** | drop the generated function call into the query/notebook |
| 6 | **Result preview** | the enriched rows (source column + AI result) |
| 7 | **Managed-LLM backing** | no model wiring required by the analyst beyond a configured endpoint |

## Loom coverage

| # | Capability | Status | Notes |
|---|------------|--------|-------|
| 1 | Pick a function | built ✅ | `Dropdown` over the five `AI_FN_NAMES` in `ai-functions-helper.tsx` |
| 2 | Pick the column | built ✅ | `Dropdown` when `columns` supplied, else `Input`; table context captured from the UC tree click |
| 3 | Per-function options | built ✅ | classify labels, extract fields, translate language — surfaced conditionally |
| 4 | In-database execution (Comm/GCC) | built ✅ | route builds `SELECT col, ai_analyze_sentiment(col)/ai_classify/…` and runs it on the live Databricks SQL Warehouse via `executeStatement()` |
| 4b | AOAI substitute (Gov / no warehouse) | built ✅ | `callAiFn()` runs the same five enrichments against the gpt-4o-class AOAI deployment; boundary-detected by `isGovCloud()` |
| 5 | Insert the call | built ✅ | **Insert SQL** drops the generated `ai_*` SELECT into the query editor (`onInsert`) |
| 6 | Result preview / receipt | built ✅ | Databricks path → rows `DataGrid`; AOAI path → enriched value + model + token usage |
| 7 | Managed-LLM backing | built ✅ / honest-gate ⚠️ | works on a configured AOAI/Databricks endpoint; if AOAI is absent on a Gov boundary the dialog shows a `MessageBar intent="warning"` naming `LOOM_AOAI_ENDPOINT` + the role — never a crash |

Zero ❌. No stub banners.

## Backend per control

| Control | Backend |
|---------|---------|
| Boundary probe | `GET /api/items/[type]/[id]/ai-function?probe=1` → `{ govPath, dbxAvailable, gated }` (server-side `isGovCloud()` + `databricksConfigGate()`) |
| Run (Comm/GCC) | `POST …/ai-function` → `executeStatement(warehouseId, "SELECT col, ai_*(col) FROM table LIMIT n")` over the Databricks SQL Warehouse |
| Run (Gov / no warehouse) | `POST …/ai-function` → `callAiFn(fn, input, opts)` → live Azure OpenAI chat-completions (sovereign endpoint via `getOpenAiSuffix()`, audience via `cogScope()`) |
| Insert SQL | client-side codegen of the `ai_*` call; no backend |

## Azure-native default

No Fabric / Power BI dependency anywhere on the default path. The Commercial /
GCC path executes Databricks' built-in `ai_*` SQL functions in-database; the Gov
(GCC-High / IL5 / IL6) path uses Azure OpenAI directly. Both work with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset. The route never reaches
`api.fabric.microsoft.com` / `api.powerbi.com` / `onelake.dfs.*`.

## Bicep sync

- `platform/fiab/bicep/modules/admin-plane/ai-foundry.bicep` — grants the Console
  UAMI **Cognitive Services OpenAI User** (`5e0bd9bd-7b93-4f28-af87-19fc36ad61bd`)
  on the model-hosting account (inference-only, least-privilege), and outputs a
  sovereign-aware `aoaiInferenceEndpoint` (`.openai.azure.us` on Gov).
- `platform/fiab/bicep/modules/ai/foundry-project.bicep` — `aoaiEndpoint` output
  is now sovereign-aware (was hardcoded `.openai.azure.com`).
- `platform/fiab/bicep/modules/admin-plane/main.bicep` — `LOOM_AOAI_ENDPOINT` is
  now sourced from the shared Foundry hub (`aoaiInferenceEndpoint`) when the
  dedicated Agent Service account isn't deployed, so the AOAI path works on a
  hub-only deploy (deployment discovered by `resolveAoaiTarget()`).

## Verification

- `lib/azure/__tests__/ai-functions-suffix.test.ts` — 5 tests GREEN: the AOAI
  inference host (`getOpenAiSuffix`) and token audience (`cogScope`) flip to the
  Government values on `AzureUSGovernment` and `AzureDOD`, Commercial on
  `AzureCloud`.
- `tsc --noEmit` clean on all touched files.
- Manual (Comm/GCC): pick a table → AI functions → Sentiment on a text column →
  Run → enriched rows (`ai_result`) from the live warehouse.
- Manual (Gov): same picker → Run → AOAI gpt-4o enrichment in the receipt.
- Manual (Gov, no AOAI): the dialog renders the honest-gate `MessageBar` naming
  `LOOM_AOAI_ENDPOINT` instead of crashing.
