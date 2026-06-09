# kql-copilot — parity with the Azure Data Explorer / Real-Time Intelligence KQL editor Copilot

**Surface:** the inline Copilot quick-actions inside the **KQL Database** editor
(`apps/fiab-console/lib/editors/phase3-editors.tsx`, `KqlDatabaseEditor`, **Query**
tab) and the existing **KQL Queryset** editor (`KqlQuerysetEditor`). Adds an **Ask
Copilot** (NL2KQL), **Explain** (Markdown), and **Fix** affordance grounded in the
live ADX database schema, plus **Apply** / **Apply & Run** that insert the
generated KQL and execute it against the real cluster.

**Source UI (Microsoft):**
- Copilot for Writing KQL Queries (Azure Data Explorer web UI) —
  https://learn.microsoft.com/azure/data-explorer/web-ui-query-copilot
- Real-Time Intelligence Copilot (Fabric KQL queryset) —
  https://learn.microsoft.com/fabric/real-time-intelligence/copilot-generate-kql-queries
- `.show database schema as json` (grounding) —
  https://learn.microsoft.com/kusto/management/show-schema-database

## Azure/Fabric feature inventory  (grounded in Learn)

| # | Capability (real ADX / RTI KQL Copilot) | Notes |
|---|---|---|
| 1 | **Natural language → KQL** in the query editor | Type intent, get a runnable KQL query grounded in the database schema |
| 2 | **Explain a query** in natural language | Describe what a KQL query does (table, filters, aggregations, time range) |
| 3 | **Fix** a query (error remediation) | Diagnose a failed query and return a corrected, runnable version |
| 4 | **Schema-grounded** suggestions | Copilot uses the real table/column schema so names are not invented |
| 5 | **Apply / run** the generated query | Insert the suggestion into the editor and execute it |

## Loom coverage

| # | Capability | Status | Where |
|---|---|---|---|
| 1 | NL → KQL | ✅ built | **Ask Copilot** opens an NL prompt bar → `callAssist('generate')` → `POST /api/items/kql-database/[id]/assist` (mode `generate`). System prompt = `KQL_COPILOT_PERSONA.generateSystemPrompt` with the live schema injected by `injectSchema()`. |
| 2 | Explain | ✅ built | **Explain** button → `callAssist('explain')` (mode `explain`); returns Markdown rendered in an `info` MessageBar. |
| 3 | Fix | ✅ built | **Fix** button (shown only when the last run errored) → `callAssist('fix')` (mode `fix`); returns corrected KQL → **Apply** → **Run** executes it on the real `/query` path. |
| 4 | Schema grounding | ✅ built | `buildSchemaContext(db)` issues `.show database <db> schema as json` over the live cluster (`getDatabaseSchemaJson`), trimmed to 8 000 chars, injected into the system prompt. Soft-fails to ungrounded (never blocks) when the cluster is cold. |
| 5 | Apply / Apply & Run | ✅ built | Suggestion MessageBar → **Apply** (`setKql`) and **Apply & Run** (`setKql` + `run()`), which POSTs to the real ADX `/query` route (`executeQuery`). |
| — | Cross-item Copilot tools | ✅ built | `kql_list_databases` / `kql_list_tables` / `kql_get_schema` / `kql_execute` registered in `buildDefaultRegistry()` (`lib/copilot/kql-tools.ts`) so the cross-item Copilot can ground + run KQL without leaving the chat. |
| — | AOAI not provisioned | ⚠️ honest-gate | Route returns `503 {code:'no_aoai', hint}`; the editor shows a Fluent `MessageBar intent="error"` naming `LOOM_AOAI_ENDPOINT` + `LOOM_AOAI_DEPLOYMENT` + the Foundry bicep module. The rest of the editor stays fully functional for manual authoring + Run. |
| — | ADX not provisioned | ⚠️ honest-gate | The KQL tools return `{gated, missing:'LOOM_KUSTO_CLUSTER_URI'}` and schema grounding soft-fails; generation still works ungrounded, Run surfaces the real cluster error. |

Zero ❌, zero stub banners.

## Backend per control

- **generate / explain / fix** → `POST /api/items/kql-database/[id]/assist` (and the
  pre-existing `/api/items/kql-queryset/[id]/assist`). Resolves AOAI via
  `resolveAoaiTarget()` (tenant admin pick → `LOOM_AOAI_ENDPOINT` → Foundry
  discovery); bearer minted on the cloud-correct `LOOM_AOAI_AUDIENCE`
  (`cognitiveservices.azure.com` vs `.azure.us`). Temperature retry for o1/o3/MAI-*.
- **Schema grounding** → `getDatabaseSchemaJson(db)` → ADX `/v1/rest/mgmt`
  (`.show database <db> schema as json`).
- **Apply & Run** → `POST /api/items/kql-database/[id]/query` → `executeQuery` →
  ADX `/v1/rest/query`.
- **kql_* orchestrator tools** → `executeQuery` / `executeMgmtCommand` /
  `listDatabases` / `listTables` / `getDatabaseSchemaJson` (all real ADX REST).

## Azure-native / no-Fabric

No Fabric / Power BI / OneLake host is contacted on any path. The persona targets
Azure Data Explorer (ADX) + Azure OpenAI only and works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset — the acceptance walkthrough below runs
entirely against the Azure-native shared ADX cluster.

## Bicep sync

No new resources, env vars, Cosmos containers, or role grants. The persona reuses
the exact infrastructure the KQL Queryset Copilot already ships:
- `LOOM_KUSTO_CLUSTER_URI`, `LOOM_KUSTO_DEFAULT_DB` — ADX data-plane
  (`modules/admin-plane/main.bicep`, from `adx-cluster.bicep`).
- `LOOM_AOAI_ENDPOINT`, `LOOM_AOAI_DEPLOYMENT`, `LOOM_AOAI_AUDIENCE` — Foundry
  project (`modules/ai/foundry-project.bicep`).
- `LOOM_UAMI_CLIENT_ID` — Console UAMI, which already holds **AllDatabasesAdmin**
  on the shared cluster (`adx-cluster.bicep`) and **Cognitive Services OpenAI
  User** on the Foundry account (`foundry-project.bicep`).

## Verification

- `npx tsc --noEmit -p tsconfig.json` — clean (0 errors project-wide).
- `lib/copilot/__tests__/kql-tools.test.ts` (11 tests): the four tools register;
  each handler dispatches to the right kusto-client function; `kql_execute` routes
  dot-commands to `/mgmt` and queries to `/query`; the honest `{gated, missing}`
  shape when `LOOM_KUSTO_CLUSTER_URI` is unset; `buildSchemaContext` soft-fail +
  8 000-char truncation.
- `lib/azure/__tests__/copilot-personas.test.ts` (8 tests): `allowedTools` ==
  `KQL_TOOL_NAMES`; `{{schema}}` placement; `injectSchema` replace + empty-strip +
  no-placeholder passthrough; temperatures in `[0,1]`.
- Live receipt (operator, `LOOM_DEFAULT_FABRIC_WORKSPACE` unset): in the KQL
  Database editor type **"count events per hour for the last day"** → **Ask
  Copilot** → **Generate** returns e.g.
  `Events | where timestamp > ago(1d) | summarize count() by bin(timestamp, 1h)`
  grounded in the live schema; **Apply & Run** returns real rows from the ADX
  cluster; **Explain** on that query returns Markdown describing the real table,
  filter, and bucket.
