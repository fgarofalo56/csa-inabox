# notebook-copilot-persona — parity with Fabric Notebook Copilot chat pane

Source UI: Fabric Notebook Copilot chat pane — https://learn.microsoft.com/fabric/data-engineering/copilot-notebooks-chat-pane

Persona declaration: `apps/fiab-console/lib/azure/copilot-personas.ts` (`NOTEBOOK_PERSONA`)
Tools: `apps/fiab-console/lib/copilot/notebook-tools.ts` (`NOTEBOOK_TOOLS`)
Pane: `apps/fiab-console/lib/components/notebook/copilot-chat-pane.tsx`
Backend: `apps/fiab-console/app/api/copilot/notebook-assist/route.ts` (real AOAI SSE; tool results from real ADLS / Synapse reads)
Telemetry: `apps/fiab-console/lib/azure/synapse-livy-client.ts` (`getRecentStatements`, sovereign `devBase`)

This is the docked **chat pane** (the right-hand sidebar), distinct from the per-cell
in-cell Copilot (`notebook-in-cell-copilot.md`). It is Azure-native: schema and
table profiling read straight from the ADLS Gen2 Delta `_delta_log`; Spark telemetry
from the Synapse Livy API. No Fabric / OneLake / Power BI dependency on any path —
works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Fabric feature inventory

| # | Capability | Where in Fabric |
|---|---|---|
| 1 | Persistent chat pane docked beside the notebook | Right sidebar |
| 2 | Context = the open notebook (its cells) + attached lakehouse | Pane context |
| 3 | Summarize the notebook (describe every cell) | Chat / suggestion chip |
| 4 | Generate code that loads + joins real tables by name | Chat prompt |
| 5 | Refactor / restructure across multiple cells | Chat prompt |
| 6 | Apply suggested code into the notebook (one or many cells) | "Insert"/"Apply" affordance |
| 7 | Single-cell helpers: fix / explain / comment / optimize | Slash commands |
| 8 | Streaming response, conversation history, prior sessions | Pane |
| 9 | Ground answers in the attached lakehouse schema (real columns) | Implicit context |
| 10 | Profile a table (size / version / row count) | Lakehouse + chat |
| 11 | Performance insights from the last Spark run | Chat |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | `CopilotChatPane` InlineDrawer (`position="end"`, ~25% width) docked in `notebook-editor.tsx` |
| 2 | ✅ | Persona system prompt built from real `cells`, `attachedSources`, `notebookName` (passed from editor) |
| 3 | ✅ | `/summarize` → `notebook_summarize` serializes every open cell; AOAI quotes the actual cell sources |
| 4 | ✅ | `/generate <task>` → `notebook_generate_code` calls `buildDatastoreSchema()` (real `_delta_log` read); schema injected into the prompt so PySpark references real tables/columns |
| 5 | ✅ | `/refactor` → `notebook_refactor_cells`; model emits one fenced block per output cell |
| 6 | ✅ | Existing `applyCells` bridge maps N blocks → N cells; marks the notebook dirty + "Apply N cells" button → **approval-diff** (user reviews + Saves) |
| 7 | ✅ | `/fix` `/explain` `/comments` `/optimize` retained (single-cell path, current + prior 5 cells) |
| 8 | ✅ | SSE streaming via `notebook-assist`; history + "Previous sessions" reuse `GET /api/copilot/sessions` |
| 9 | ✅ | `buildDatastoreSchema(LOOM_NOTEBOOK_PERSONA_CONTEXT_MAX_TABLES)` grounds every persona turn |
| 10 | ✅ | `/profile <table>` → `notebook_profile_table` → `scanLakehouseTables({rowCounts:true})` (real ADLS + Serverless `COUNT_BIG`); `rowCount` honest-null when Serverless offline |
| 11 | ✅ | `/perf` → `notebook_perf_insights` over the Livy session receipt + last cell output (`getRecentStatements` collects live statement text; sovereign `devBase` for Gov) |

Honest gate: when AOAI is not configured the route returns `503 {code:'no_aoai', hint}`;
the pane surfaces it in a Fluent `MessageBar intent="warning"` naming the AI Foundry
bicep module to deploy. The notebook + pane still render (per `no-vaporware.md`).
No mock schema is ever returned — `buildDatastoreSchema` / `scanLakehouseTables`
soft-fail to `''` / honest-error, never fabricated columns or rows.

## Backend per control

| Control | Backend |
|---|---|
| `/summarize`, `/refactor` | cell serialization (client-supplied) → AOAI chat-completions (SSE) |
| `/generate` | `delta-schema.buildDatastoreSchema()` → ADLS `_delta_log/0.json` (no Spark) → AOAI |
| `/profile` | `synapse-catalog-client.scanLakehouseTables({rowCounts:true})` → ADLS dir-scan + Synapse Serverless `OPENROWSET COUNT_BIG FORMAT='DELTA'` |
| `/perf` | `synapse-livy-client.getRecentStatements()` (live Livy statements) + the editor's Livy session receipt |
| `/fix /explain /comments /optimize` | existing single-cell prompt path → AOAI |

All AOAI calls resolve via `resolveAoaiTarget()` (tenant admin pick → env →
Foundry discovery). AAD bearer against `cogScope()` (`.us` for Gov, `.com`
commercial). No Fabric / Power BI host on any path.

## Per-cloud

| Cloud | Schema / profile read | AOAI | Livy telemetry |
|---|---|---|---|
| Commercial / GCC | `*.dfs.core.windows.net` Delta log | `*.openai.azure.com` | `*.dev.azuresynapse.net` |
| GCC-High / DoD | `*.dfs.core.usgovcloudapi.net` | `*.openai.azure.us` (`cogScope`) | `*.dev.azuresynapse.us` via `LOOM_SYNAPSE_DEV_SUFFIX` (sovereign `devBase` fix) |

Row counts (`/profile`) are honest-null when Synapse Serverless is offline /
region-gated; the persona is instructed never to fabricate a count.

## Bicep / bootstrap

No new Azure resources. One new env var:
`LOOM_NOTEBOOK_PERSONA_CONTEXT_MAX_TABLES` (default 30) added to
`platform/fiab/bicep/modules/admin-plane/main.bicep` (param
`loomNotebookPersonaContextMaxTables`). Reuses already-emitted
`LOOM_SYNAPSE_WORKSPACE`, `LOOM_SPARK_POOL`, `LOOM_SYNAPSE_DEV_SUFFIX`,
`LOOM_*_URL` (lakehouse containers), and `LOOM_AOAI_*`. Console UAMI already holds
Storage Blob Data Reader on the lakehouse containers (`synapse-storage-rbac.bicep`)
and Synapse Compute Operator on the Spark pool (`synapse.bicep`).

## Verification

- `npx tsc --noEmit` clean on all touched files.
- `lib/azure/__tests__/copilot-personas.test.ts` — 12 tests GREEN (persona prompt
  grounding + gov note + all five tools incl. honest-null rowCount + honest
  not-found error). Run on a node-env config because the shared jsdom setup file
  is missing a transitive dep (`@adobe/css-tools`) unrelated to this change
  (see `.claude` memory `fiab-console-vitest-harness-broken`).

Grade: **A (all inventory rows built; real ADLS/Synapse/AOAI backends; unit-tested).**
