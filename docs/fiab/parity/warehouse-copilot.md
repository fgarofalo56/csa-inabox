# warehouse-copilot — parity with Fabric Warehouse Copilot (NL→SQL + Explain)

Source UI: https://learn.microsoft.com/fabric/data-warehouse/copilot
            https://learn.microsoft.com/fabric/data-warehouse/copilot-chat-pane
            https://learn.microsoft.com/fabric/data-warehouse/copilot-code-completion
            https://learn.microsoft.com/azure/azure-sql/copilot/copilot-azure-sql-overview (Azure portal "Copilot in Azure SQL")

Surface: inline Copilot bar on the SQL warehouse-family editors
Shared component: `apps/fiab-console/lib/components/editor/sql-copilot-editor.tsx` → `SqlCopilotEditor`
Editors:
  - `apps/fiab-console/lib/editors/phase3-editors.tsx` → `WarehouseEditor` (inline, toolbar-integrated)
  - `apps/fiab-console/lib/editors/synapse-sql-editors.tsx` → `SynapseDedicatedSqlPoolEditor`, `SynapseServerlessSqlPoolEditor`
  - `apps/fiab-console/lib/editors/databricks-editors.tsx` → `DatabricksSqlWarehouseEditor`
Route: `apps/fiab-console/app/api/items/[type]/[id]/assist/route.ts` (POST, `[type]` = engine)
Backend:
  - Chat model → Loom AOAI deployment (AI Foundry project `chat`, `gpt-4.1-mini`) via `resolveAoaiTarget()` + `cogScope()` AAD bearer — **no Fabric Copilot**
  - Schema grounding → real `sys.columns` DMV (Synapse Dedicated/Serverless via `executeQuery`) or `information_schema.columns` (Databricks via `executeStatement`)
  - Generated SQL executes against the real backend via the existing per-engine `/query` route

> Fabric Warehouse Copilot lets you (a) describe a query in natural language and
> get runnable T-SQL, (b) ask Copilot to explain an existing query, and (c) get
> a fix when a query errors. Loom reproduces all three **on the Azure-native
> default backend** (Synapse Dedicated SQL pool / Serverless / Databricks SQL
> warehouse) with **no Fabric or Power BI dependency** — the editor works with
> `LOOM_DEFAULT_FABRIC_WORKSPACE` **unset** (per `no-fabric-dependency.md`). The
> chat model is the AI Foundry project provisioned by
> `platform/fiab/bicep/modules/ai/foundry-project.bicep` and wired into the
> Container App as `LOOM_AOAI_ENDPOINT` + `LOOM_AOAI_DEPLOYMENT` by
> `admin-plane/main.bicep` (lines 1473–1479). When that project is not deployed
> the bar shows an honest config gate naming the env vars to set; the editor
> stays fully functional for manual authoring + Run.

## Source-UI feature inventory (grounded in Learn + live portal)

| # | Fabric/Azure-SQL Copilot capability | Behavior in the real UI |
| --- | --- | --- |
| 1 | NL→SQL ("Generate") | Type a question; Copilot returns a runnable query grounded in the warehouse schema |
| 2 | Insert / apply generated SQL | One click drops the generated SQL into the query editor, ready to Run |
| 3 | Explain query | Select / open a query; Copilot returns a plain-language description referencing the real tables/columns |
| 4 | Fix query | After an error, Copilot proposes a corrected query |
| 5 | Schema grounding | Suggestions reference actual tables/columns, not invented names |
| 6 | Run the result | Generated SQL executes against the live warehouse and returns rows |
| 7 | Dialect awareness | T-SQL for Warehouse/SQL pool; engine-appropriate SQL elsewhere |
| 8 | Graceful unconfigured state | Clear message when Copilot/AOAI is not available |

## Loom coverage

| # | Capability | Status | Where |
| --- | --- | --- | --- |
| 1 | NL→SQL ("Ask Copilot" → prompt bar → Generate) | built ✅ | `SqlCopilotEditor` / `WarehouseEditor`; route `mode:'generate'` |
| 2 | Apply generated SQL into the editor | built ✅ | "Apply" button replaces editor text + clears stale results |
| 3 | Explain query | built ✅ | "Explain" button; route `mode:'explain'` → info MessageBar drawer |
| 4 | Fix query (shown after a run error) | built ✅ | "Fix" button gated on `result.error`; route `mode:'fix'` |
| 5 | Schema grounding (real DMV) | built ✅ | `synapseSchemaContext` / `databricksSchemaContext` → live `sys.columns` / `information_schema.columns` |
| 6 | Run the generated SQL → real rows | built ✅ | existing `/query` route (`executeQuery` / `executeStatement`) |
| 7 | Dialect label per engine (T-SQL / Spark SQL) | built ✅ | `dialectFor(engine)` system prompt + UI copy |
| 8 | Honest no_aoai config gate | honest-gate ⚠️ | 503 `code:'no_aoai'` + hint naming `LOOM_AOAI_ENDPOINT`/`LOOM_AOAI_DEPLOYMENT` |

Zero ❌. Code-completion-as-you-type (Fabric "inline code completion") is a
distinct surface tracked separately; the three primary Copilot actions
(generate / explain / fix) — the acceptance surface — are all built.

## Backend per control

| Control | Calls |
| --- | --- |
| Ask Copilot → Generate | `POST /api/items/<engine>/<id>/assist` `{mode:'generate', prompt}` → AOAI `chat/completions` (temperature 0.2, reasoning-model retry) grounded in live schema |
| Explain | `POST …/assist` `{mode:'explain', sql}` → AOAI prose |
| Fix | `POST …/assist` `{mode:'fix', sql, errorText}` → AOAI corrected SQL |
| Apply → Run | existing `POST /api/items/<engine>/<id>/query` → Synapse TDS (`executeQuery`) / Databricks SQL (`executeStatement`) |
| Schema grounding | Synapse: `executeQuery(dedicated|serverlessTarget, sys.columns …)`; Databricks: `executeStatement(<catalog>.information_schema.columns …)` (soft-fail, never blocks) |

## Per-cloud notes

| Concern | Commercial / GCC | GCC-High / IL5 / DoD |
| --- | --- | --- |
| AOAI scope | `cogScope()` → `cognitiveservices.azure.com/.default` | `cognitiveservices.azure.us/.default` |
| AOAI endpoint | `*.openai.azure.com` (`LOOM_AOAI_ENDPOINT`) | `*.openai.azure.us` (`LOOM_AOAI_ENDPOINT`) |
| Synapse TDS | `database.windows.net` (via `getSynapseSqlSuffix`) | `database.usgovcloudapi.net` |
| Fabric / Power BI host | never contacted | never contacted |

## Verification

`pnpm uat` + live walk: open the Warehouse editor with a populated Synapse
Dedicated pool, click **Ask Copilot**, type *"top 10 customers by revenue last
quarter"*, **Generate** → a `SELECT TOP 10 … FROM …` over the real schema,
**Apply** → **Run** → real rows. **Explain** on the result → grounded prose.
Route test: `app/api/items/[type]/[id]/assist/__tests__/route.test.ts`
(validation gates, fence-stripping, schema grounding, reasoning-model retry).
