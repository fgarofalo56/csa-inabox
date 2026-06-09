# azure-sql-copilot — parity with the Azure SQL Database Query editor Copilot

**Surface:** the Copilot quick-actions inside the unified Azure SQL editor
(`apps/fiab-console/lib/editors/unified-sql-database-editor.tsx`, **Query** tab).
Adds a Copilot side pane, **Fix** / **Explain** ribbon + pane buttons (act on the
Monaco selection, falling back to the whole buffer), a Monaco inline ghost-text
completion (Tab-to-accept), and natural-language → T-SQL.

**Source UI (Microsoft):**
- Copilot in Azure SQL Database (Fix / Explain / NL→SQL, ghost text) —
  https://learn.microsoft.com/azure/azure-sql/copilot/copilot-azure-sql-overview
- Natural language to SQL — https://learn.microsoft.com/azure/azure-sql/copilot/query-editor-natural-language-to-sql
- Azure portal Query editor Copilot —
  https://learn.microsoft.com/azure/azure-sql/database/query-editor

## Azure/Fabric feature inventory  (grounded in Learn)

| # | Capability (real Azure SQL Copilot) | Notes |
|---|---|---|
| 1 | **Natural language → T-SQL** in the query editor | Type intent, get a runnable T-SQL query grounded in the DB schema |
| 2 | **Explain a query** in natural language | Annotate / describe what a query does |
| 3 | **Fix** a query (error remediation) | Diagnose a broken query and return a corrected, runnable version |
| 4 | **Inline completion (ghost text)** in the editor | Suggest the next T-SQL as you type; accept with Tab |
| 5 | **Schema-grounded** suggestions | Copilot uses the database schema so names are real, not invented |
| 6 | **Selection-aware** actions | Operate on the highlighted statement |

## Loom coverage

| # | Capability | Status | Where |
|---|---|---|---|
| 1 | NL → T-SQL | ✅ built | Copilot pane "Natural language → T-SQL" box → `invokeCopilot('nl2sql')` → `POST /api/items/azure-sql-database/[id]/copilot` (command `nl2sql`); "Insert into editor" pushes the generated SQL into Monaco. Also available inline: write `-- intent` and press Tab. |
| 2 | Explain | ✅ built | Ribbon **Explain** + pane **Explain** → `invokeCopilot('explain')` (command `explain`); streams an annotated `--`-commented version into the pane. |
| 3 | Fix | ✅ built | Ribbon **Fix** + pane **Fix** → `invokeCopilot('fix')` (command `fix`); returns corrected SQL → "Insert into editor" → **Run** executes it on the real TDS path. |
| 4 | Inline ghost text (Tab) | ✅ built | `registerInlineCompletion(editor, monaco, …)` wired in the Query-tab `MonacoTextarea onReady`; `lang:'tsql'`, schema in `schemaContext`, debounced fetch to `/api/copilot/complete`. Monaco `inlineSuggest.enabled` already on. |
| 5 | Schema grounding | ✅ built | The route reads `INFORMATION_SCHEMA.COLUMNS` (TOP 200) over the live TDS path (`executeQuery`) and injects `schema.table.column (type)` into the system prompt; the editor caches the same catalog into `schemaRef` for ghost text. Soft-fails to "do not invent names" when the read errors. |
| 6 | Selection-aware | ✅ built | `editor.onDidChangeCursorSelection` captures the selection into `sqlSelectionRef`; Fix/Explain use it, falling back to the full buffer. |
| — | AOAI not provisioned | ⚠️ honest-gate | Route returns `503 {code:'no_aoai', hint}`; the pane shows a Fluent `MessageBar intent="warning"` naming `LOOM_AZURE_OPENAI_ENDPOINT` + `LOOM_AOAI_DEPLOYMENT` + the **Cognitive Services OpenAI User** role (`5e0bd9bd-7b93-4f28-af87-19fc36ad61bd`). The rest of the editor stays fully functional. |

Zero ❌. PostgreSQL / SQL MI families are intentionally out of scope (the prompt
contract is T-SQL); the Copilot button is disabled there with a tooltip, which is
an honest scope boundary, not a stub.

## Backend per control

- **Fix / Explain / NL→T-SQL** → `POST /api/items/azure-sql-database/[id]/copilot`
  (SSE: `event: session|chunk|done|error`). Resolves AOAI from
  `LOOM_AZURE_OPENAI_ENDPOINT` (+ `LOOM_AOAI_DEPLOYMENT`) — a bare account name is
  expanded to the per-cloud host via `getOpenAiSuffix()` (`openai.azure.com` vs
  `openai.azure.us`) — then falls back to `resolveAoaiTarget()` (tenant admin pick
  → `LOOM_AOAI_ENDPOINT` → Foundry-hub discovery). Bearer minted on `cogScope()`.
- **Inline ghost text** → `POST /api/copilot/complete` (`lang:'tsql'`), unchanged.
- **Schema catalog** → `executeQuery(server, database, INFORMATION_SCHEMA.COLUMNS)`
  (TDS + AAD MI), the same path the Query tab uses.

## Azure-native / no-Fabric

No Fabric / Power BI host is contacted on any path. Works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset. The backend is Azure OpenAI only.

## Bicep sync

- `platform/fiab/bicep/main.bicep` — `param loomAzureOpenAiEndpoint` → passed to
  the admin-plane module.
- `platform/fiab/bicep/modules/admin-plane/main.bicep` — emits
  `LOOM_AZURE_OPENAI_ENDPOINT` (explicit param → Foundry `aoaiEndpoint` → empty).
- `platform/fiab/bicep/modules/ai/foundry-project.bicep` — `aoaiEndpoint` output
  now uses the sovereign-correct suffix (`openai.azure.us` in Gov) so the derived
  endpoint matches the `cognitiveservices.azure.us` token audience.
- Role: the **Cognitive Services OpenAI User** assignment to the Console UAMI
  already ships in `foundry-project.bicep` (`raCognitiveServicesOpenAIUser`).

## Verification

- `npx tsc --noEmit` clean on the touched files.
- `app/api/items/azure-sql-database/[id]/copilot/__tests__/copilot-route.test.ts`
  (7 tests): auth, command/snippet validation, the `no_aoai` honest gate (asserts
  the env var + role are named), SSE streaming grounded in the live schema, the
  bare-name → `openai.azure.us` Gov host, and schema-read soft-fail.
- `az bicep build platform/fiab/bicep/main.bicep` compiles; output contains
  `LOOM_AZURE_OPENAI_ENDPOINT` and the Gov `openai.azure.us` suffix.
- Live receipt (operator): paste a deliberately broken query (e.g.
  `SELCT TOP 5 * FORM dbo.Customer`), click **Fix** → **Insert into editor** →
  **Run** returns rows; **Explain** annotates a real query with correct `--`
  comments; ghost text appears on Tab after `-- top 10 customers by revenue`.
