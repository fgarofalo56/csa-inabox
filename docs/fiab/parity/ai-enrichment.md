# ai-enrichment — parity with Microsoft Fabric AI functions (batch over a column)

Source UI: https://learn.microsoft.com/fabric/data-science/ai-functions/overview
(Fabric AI functions — `ai.summarize` / `ai.classify` / `ai.extract` / `ai.translate`
/ `ai.similarity` over a DataFrame/table column) + Foundry Agent Service batch runs.

Loom builds this as a durable, first-class catalog item type (`ai-enrichment`,
category **Azure AI Foundry**) — not a Copilot-panel helper — that runs a batch
LLM operation over one column of a lakehouse / warehouse table and materialises a
new Delta column. 100% Azure-native, **no Microsoft Fabric / Power BI dependency**
(per `no-fabric-dependency.md`). Closes AIF-7 / copilot-ai.md T12.

## Fabric AI-functions feature inventory

| # | Capability (Fabric) | Notes |
|---|---------------------|-------|
| 1 | Pick a source table + text column | DataFrame / Spark / Warehouse SQL surface |
| 2 | `summarize` | concise summary per row |
| 3 | `classify` (custom labels) | one label per row |
| 4 | `sentiment` | positive / negative / neutral |
| 5 | `extract` (named fields → JSON) | structured extraction |
| 6 | `translate` (target language) | per-row translation |
| 7 | `fix_grammar` / `generate_response` | text cleanup / drafting |
| 8 | Custom prompt per row | free-form instruction |
| 9 | Write results to a new output column | materialised back to the table |
| 10 | Batch size / concurrency controls | throughput tuning |
| 11 | Default-model + reasoning-effort tuning | model-tier selection (June-2026) |
| 12 | Preview before a full run | validate on sample rows |
| 13 | Cost visibility | token metering |
| 14 | Run history | prior batch runs |

## Loom coverage

| # | Loom surface | Backend per control | State |
|---|--------------|---------------------|-------|
| 1 | Cascading Unity-Catalog picker (warehouse → catalog → schema → table → column) | `GET …/ai-enrichment/[id]/schema` (live `SHOW`/`DESCRIBE` via Databricks SQL) | ✅ built |
| 2–7 | Operation dropdown (7 builtins) | in-database `ai_*` CTAS (Databricks) | ✅ built |
| 8 | Custom-prompt op (the one allowed free-form field) | per-row Azure OpenAI (`callCustomPrompt`) | ✅ built |
| 9 | Output column + destination Delta table | `CREATE TABLE … AS SELECT *, ai_*(col) AS out` (builtins) / VALUES CTAS (custom) | ✅ built |
| 10 | Batch size + concurrency inputs | `runAoaiEnrichment` bounded-concurrency + retry orchestrator | ✅ built |
| 11 | Model tier (Fast / Advanced) + reasoning-effort | FGC-19 — deployment override + `reasoning_effort` through `ai-functions-client` | ✅ built |
| 12 | Preview (first N real rows) | `POST …/preview` — REAL Azure OpenAI over live rows | ✅ built |
| 13 | Cost estimate (tokens + ≈ USD) | grounded in measured preview tokens (rel-T85 metering) | ✅ built |
| 14 | Run history (persisted) | `item.state.runs[]` in Cosmos; `GET …/runs` | ✅ built |

Honest gate ⚠️: on a boundary with neither a Databricks SQL Warehouse nor Azure
OpenAI configured, the editor shows a Fluent `MessageBar` naming the exact env
vars (`LOOM_DATABRICKS_HOSTNAME` / `LOOM_AOAI_ENDPOINT` + `LOOM_AOAI_DEPLOYMENT`)
and the UAMI role — the full UI surface still renders. The destination write on
the custom-prompt / Gov path requires a writable Databricks SQL Warehouse; that
requirement is disclosed honestly (Azure infra gate, not a Fabric one).

## Backend per control

- **Schema browse** → `databricks-client.executeStatement` (`SHOW CATALOGS/SCHEMAS/TABLES`, `DESCRIBE TABLE`).
- **Preview / custom-prompt run** → `ai-functions-client.callAiFn` / `callCustomPrompt` (live AOAI chat-completions), orchestrated by `ai-enrichment-client.runAoaiEnrichment` (bounded concurrency + retry/backoff).
- **Builtin full run** → one `CREATE TABLE … AS SELECT` with the `ai_*` builtin (`ai-enrichment-client.buildEnrichmentCtas`) executed on the warehouse.
- **Run history** → Cosmos `item.state.runs[]` via `updateOwnedItem`.

## Verification

`ai-enrichment-client.test.ts` covers the pure batch-orchestration logic (chunking,
tuning clamps, SQL/CTAS builders + literal escaping, cost estimate, the
concurrency + retry orchestrator, and run-history capping). Live acceptance: run
`ai-enrichment` over a real table (e.g. classify a review column) with
`LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET → a new Delta table with the populated
output column, plus a preview receipt and a persisted run row.
