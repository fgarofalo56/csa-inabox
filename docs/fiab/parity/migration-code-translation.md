# migration-code-translation — parity with SQL / DAX / report migration assessors

Source UI / tools this M3 surface maps to (a Loom-native tool; there is no single
Fabric analog — the closest are the assessment/translation flows below):

- SQL Server Migration Assistant (SSMA) "Assess" + object-conversion report and
  Azure Synapse Pathway's construct-compatibility assessment.
  https://learn.microsoft.com/sql/ssma/sql-server/assessing-sql-server-database-conversion
- Snowflake → Synapse T-SQL dialect differences (function/cast/semi-structured).
  https://learn.microsoft.com/azure/synapse-analytics/sql/overview-features
- Power BI / DAX → the Loom-native semantic layer (no Power BI workspace needed
  per `.claude/rules/no-fabric-dependency.md`); DAX surface handled by the A1–A3
  parser + fold engine (`lib/azure/dax/*`).
- BI-as-code report authoring (Evidence.dev model) — the N16 `code-report`
  target the report path emits.

The **Translate** tab on `/admin/migrate` consumes M1's ReadinessReport rows that
carry translatable source (SQL views, stored routines, DAX measures, reports) and
produces a **needs-review diff** — never a silent wrong translation. It needs no
Microsoft Fabric / Power BI capacity to function (the transpilers are pure and
run fully in-boundary; IL5-safe).

## Feature inventory (assessment/translation tools)

| Capability (SSMA / Synapse Pathway / dialect guides)                    | Where |
|--------------------------------------------------------------------------|-------|
| Read the translatable source objects (views, routines, measures, reports)| M1 ReadinessReport |
| Per-construct compatibility assessment (flag unsupported constructs)     | SSMA Assess / Pathway |
| Emit target-flavored code for the supported subset                       | Pathway output |
| Refuse to emit a fabricated translation for an unsupported construct     | SSMA "manual conversion required" |
| Side-by-side source vs converted review                                  | SSMA object diff |
| Land converted objects as editable drafts                                | SSMA schema project |
| DAX measure → governed semantic metric                                   | (Loom N9) |
| Report → code-first report document                                      | (Loom N16) |

## Loom coverage

| Inventory row                              | Status | Notes |
|--------------------------------------------|--------|-------|
| Read translatable source rows              | ✅ | Consumes M1's `ReadinessReport` (sql-view / stored-routine / notebook / report rows); the actual source text is supplied per-artifact. |
| Per-construct compatibility assessment     | ✅ | `lib/migrate/sql-transpile.ts` classifies each statement; each unsupported construct (`QUALIFY`, `LATERAL FLATTEN`, `::`, VARIANT, `LISTAGG`, temp tables, MERGE, …) is flagged needs-review with the exact reason. |
| Emit Loom SQL for the supported subset     | ✅ | Bracket-quoted Synapse-serverless T-SQL (via `@/lib/sql/quoting`); exact-1:1 renames (NVL→ISNULL, IFF→IIF, LENGTH→LEN) + identifier requoting + `OR REPLACE`→`OR ALTER`. |
| NEVER a fabricated translation             | ✅ | A statement/measure/report with any unsupported construct returns `generated: null` and the source verbatim — mirrors A1's `unsupportedDaxError` honesty. |
| DAX measure translation (reuse A1–A3)      | ✅ | `lib/migrate/artifact-transpile.ts#translateDaxMeasure` validates with `parseDaxExpression` and probes `foldDaxToSql`; a parseable measure is carried over as an N9 `measure` metric (sourceRef = original DAX). |
| Report translation (reuse N16)             | ✅ | `#translateReport` assembles an N16 `code-report` source and validates it with `parseCodeReport` + `assertReadOnlyQuery`; a malformed report surfaces the N16 error as needs-review. |
| Side-by-side review diff                   | ✅ | `app/admin/migrate/translate-panel.tsx` — resizable `SplitPane` source-vs-generated + per-construct supported/needs-review badges with reasons. |
| Land as editable drafts                    | ✅ | Supported artifacts create a **draft** Loom item (warehouse view / semantic-model measure / code-report) through the normal audited item-create path (draft/publish semantics). |
| Emit governed metric to the contract       | ✅ | A parseable DAX measure can be emitted into N9's store (`registerMetric`) from the diff. |

Zero ❌. The one honest boundary: constructs outside the confident mechanical set
are surfaced as needs-review with the exact remediation reason — that is the
designed, correct behavior (no silent wrong output), not a missing feature.

## Backend per control

- `POST /api/migrate/translate` (`withTenantAdmin`, audited, FLAG0 `n-m3-translate`)
  → `lib/migrate/translate.ts#translateBatch` → the pure transpilers.
- Draft creation → `POST /api/workspaces/{id}/items` + `PATCH /api/cosmos-items/...`.
- Metric emission → `lib/azure/semantic-contract.ts#registerMetric` (real Cosmos write).
