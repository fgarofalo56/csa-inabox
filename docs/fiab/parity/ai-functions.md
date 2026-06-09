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

---

## Notebook AI functions (Spark / pandas) — `loom-ai-functions`

A second, distinct surface for the SAME Fabric capability: Fabric's AI functions
are usable from **notebooks** over a Spark/pandas DataFrame, not only from the
SQL/data surface. The `ai_functions` Python library (`apps/copilot/ai_functions/`,
dist `loom-ai-functions`) brings that to Loom notebooks — an analyst writes
`ai.classify(df['text'])` in a cell and gets real AOAI labels back. This is
separate from the Console BFF path above (`ai-functions-client.ts` /
`app/api/ai-functions/route.ts`), which powers the SQL-editor helper dialog.

Source UI: Fabric AI functions in notebooks —
https://learn.microsoft.com/fabric/data-science/ai-functions/overview (the
`df.ai.summarize` / `ai.classify` DataFrame APIs). Azure-native engine: Azure
OpenAI chat completions, called from the Spark executor under the pool MSI.

### Loom coverage

| Capability | Status | Notes |
|------------|--------|-------|
| `ai.summarize` on str / pandas Series / pyspark Column | built ✅ | scalar / thread-batched Series / vectorized `pandas_udf` |
| `ai.classify(data, labels=[...])` | built ✅ | one label per row |
| `ai.sentiment(data)` | built ✅ | positive / negative / neutral |
| `ai.extract(data, fields=[...])` | built ✅ | JSON string per row |
| `ai.translate(data, target_lang="fr")` | built ✅ | |
| Managed-identity auth (Synapse MSI / Databricks AC MSI) | built ✅ | `azure-identity` ChainedTokenCredential; UAMI preferred |
| API-key fallback (`LOOM_AOAI_KEY`) | built ✅ | api-key header bypasses token fetch |
| Sovereign endpoint (GCC-High / IL5) | built ✅ | reads `LOOM_AOAI_AUDIENCE` / endpoint from pool env (`.openai.azure.us`) |
| Retry on 429 | built ✅ | 3 attempts, exponential 2/4/8s |
| Reasoning-model temperature fallback | built ✅ | mirrors `ai-functions-client.ts` |
| Honest gate (`ai.check_reachable()`) | built ✅ | raises `AoaiBridgeConfigError`/`AoaiBridgeAuthError` naming the env var + role — never a silent empty df |
| Batched concurrency | built ✅ | `ThreadPoolExecutor`, `LOOM_AI_FN_WORKERS` (default 8) |
| Wheel baked into the Spark pool | built ✅ | `scripts/csa-loom/ai-functions-pool-setup.sh` |

Zero ❌. No stub banners.

### Backend per control

| Control | Backend |
|---------|---------|
| `ai.*` on a str / Series / Column | `_client.call_chat` → live Azure OpenAI `/chat/completions` (sovereign host via `LOOM_AOAI_ENDPOINT`, audience via `LOOM_AOAI_AUDIENCE`) |
| Token | `_auth.get_bearer_token` → `azure-identity` MSI/UAMI token for the pool identity (or `LOOM_AOAI_KEY`) |
| `ai.check_reachable()` | one real `call_chat` probe; raises a typed, actionable error on failure |

### Azure-native default

No Fabric / Power BI / OneLake dependency. The library calls Azure OpenAI
directly from the Spark executor and works with `LOOM_DEFAULT_FABRIC_WORKSPACE`
unset. It never reaches `api.fabric.microsoft.com` / `api.powerbi.com` /
`onelake.dfs.*`.

### Bicep sync

- `platform/fiab/bicep/modules/admin-plane/aoai-spark-rbac.bicep` — grants the
  Synapse workspace MSI and the Databricks Access Connector MSI **Cognitive
  Services OpenAI User** (`5e0bd9bd-7b93-4f28-af87-19fc36ad61bd`, inference-only)
  on the AOAI account. Deployed at the Admin Plane RG scope from the orchestrator
  (`platform/fiab/bicep/main.bicep` → `singleDlzAoaiSparkRbac`) because the AOAI
  account (admin plane) is created before the Spark identities (DLZ).
- `admin-plane/main.bicep` — new output `aiServicesAccountName` (empty for the
  existing/external-account path).
- `landing-zone/main.bicep` — new outputs `synapseManagedIdentityPrincipalId`
  and `databricksAccessConnectorPrincipalId` (the latter empty on GCC-High / IL5
  where Databricks UC is unsupported, so that grant cleanly no-ops).
- `LOOM_AOAI_ENDPOINT` / `LOOM_AOAI_DEPLOYMENT` / `LOOM_AOAI_AUDIENCE` — already
  sovereign-aware in `admin-plane/main.bicep`; delivered onto the Spark pool by
  `scripts/csa-loom/ai-functions-pool-setup.sh` (Spark conf `spark.loom.aoai.*`).

### Per-cloud notes

- **Commercial / GCC** — AOAI on `.openai.azure.com`, audience
  `cognitiveservices.azure.com`. Both Synapse and Databricks MSI grants fire.
- **GCC-High / IL5** — AOAI on `.openai.azure.us`, audience
  `cognitiveservices.azure.us` (set by `main.bicep`). Databricks UC is
  unsupported → `databricksAccessConnectorPrincipalId` is empty → only the
  Synapse grant fires. The bootstrap script auto-derives
  `dfs.core.usgovcloudapi.net` from `AZURE_CLOUD`.

### Verification

- `apps/copilot/ai_functions/tests/` — 38 pytest cases GREEN (config, auth,
  client retry/error taxonomy, functions dispatch, batch order/empty-skip/
  fail-loud, honest gate). `ruff check` clean.
- `az bicep build platform/fiab/bicep/main.bicep` — clean with the new module +
  outputs wired.
- `python -m pip wheel apps/copilot/ai_functions` — builds
  `loom_ai_functions-0.1.0-py3-none-any.whl` exposing `import ai_functions`.
- Manual (live pool): open `docs/fiab/notebooks/ai_functions_demo.py` on a
  Synapse Spark session → Cell 2 `check_reachable()` prints "AOAI reachable" →
  Cell 3 `ai.classify(df['text'])` returns real gpt-4o labels over real rows →
  Cell 6 clears `LOOM_AOAI_ENDPOINT` and shows `AoaiBridgeConfigError` (not a
  silent empty df, not a Python `KeyError`).
