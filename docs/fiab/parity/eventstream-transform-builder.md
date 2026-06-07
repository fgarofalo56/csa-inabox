# eventstream-transform-builder — parity with Fabric Eventstream transform nodes / Azure Stream Analytics query editor

Source UI:
- Fabric Eventstream (Edit / transformations): https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/route-events-based-on-content
- Fabric Eventstream operators (Filter / Aggregate / Group by / Join / Union / Manage fields): https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/process-events-using-event-processor-editor
- ASA query editor + Test query: https://learn.microsoft.com/azure/stream-analytics/stream-analytics-test-query
- SAQL reference (windows / joins / aggregates): https://learn.microsoft.com/stream-analytics-query/stream-analytics-query-language-reference
- Common query patterns (windows, session, join, union): https://learn.microsoft.com/azure/stream-analytics/stream-analytics-stream-analytics-query-patterns

Fabric Eventstream is built on the same runtime as Azure Stream Analytics, so the
transform/operator surface maps 1:1 onto SAQL. Loom builds the transform node as
a **guided builder** (dropdowns, number spinners, field lists) that compiles to
SAQL via `lib/azure/asa-query-compiler.ts`. The only freeform inputs are the
single-expression Monaco slots (WHERE / HAVING / JOIN ON) — the allowed 1:1
builder exception per `no-freeform-config.md`. No Fabric tenant is required; the
backend is Azure Stream Analytics ARM (Azure-native default per
`no-fabric-dependency.md`).

## Source feature inventory

| # | Capability | Source behaviour |
|---|------------|------------------|
| 1 | **Filter** operator | Keep events matching a condition (WHERE) |
| 2 | **Aggregate** operator | AVG / SUM / COUNT / MIN / MAX over a time window |
| 3 | **Group by** | Aggregate partitioned by one or more columns |
| 4 | **Windowing** | Tumbling / Hopping / Sliding / Session / Snapshot windows |
| 5 | **Manage fields / project** | Choose / rename the columns flowing downstream |
| 6 | **Join** | Temporal INNER / LEFT join of two streams within a time bound |
| 7 | **Union** | Merge multiple upstream streams into one |
| 8 | **Event-time** (TIMESTAMP BY) | Pick the timestamp column used for windowing |
| 9 | **HAVING** | Filter on aggregate results |
| 10 | **Live query preview** | See the generated query as the operator is configured |
| 11 | **Test query with sample data** | Run the query over sample events and see output rows |
| 12 | **Validate / compile** | Surface query errors before starting the job |
| 13 | **Apply** | Persist the query to the job / eventstream |

## Loom coverage

| # | Capability | Status | Backend / notes |
|---|------------|--------|-----------------|
| 1 | Filter | ✅ built | WHERE Monaco slot → `compileToSaql` → `saveTransformation` (ARM PUT transformations) |
| 2 | Aggregate (AVG/SUM/COUNT/MIN/MAX) | ✅ built | Repeating func/field/alias rows → SAQL aggregate select list |
| 3 | Group by | ✅ built | Comma GROUP BY field list |
| 4 | Windowing (5 types) | ✅ built | Window type/size/unit/hop spinners → `TumblingWindow`/`HoppingWindow`/`SlidingWindow`/`SessionWindow`/`SnapshotWindow` |
| 5 | Project / manage fields | ✅ built | Columns-to-keep field list |
| 6 | Join (INNER / LEFT OUTER + DATEDIFF) | ✅ built | Right-stream dropdown (sources), ON Monaco slot, within-seconds spinner → `JOIN … ON … AND DATEDIFF` |
| 7 | Union | ✅ built | Materialized through a `WITH` step with a single INTO |
| 8 | Event-time (TIMESTAMP BY) | ✅ built | Timestamp-column input applied at the source read |
| 9 | HAVING | ✅ built | HAVING Monaco slot |
| 10 | Live SAQL preview | ✅ built | `useMemo(compileToSaql)` in inspector + Query Builder tab (read-only Monaco) |
| 11 | Test query with sample data | ✅ built | `POST /api/items/stream-analytics-job/[name]/test` mode `run` → ASA `locations/{loc}/testQuery` LRO; returns output rows. Needs `LOOM_ASA_TEST_WRITE_URI` (honest infra-gate otherwise) |
| 12 | Validate / compile | ✅ built | mode `compile` → ASA `locations/{loc}/compileQuery`; returns real errors/warnings inline, no storage needed |
| 13 | Apply | ✅ built | "Apply to ASA job" → `PUT …/query` (`saveTransformation`) |

Zero ❌. The only non-functional states are honest infra-gates: the
subscription-scoped **Stream Analytics Query Tester** grant
(`1ec5b3c1-b17e-4e25-8312-2acb3c3c5abf`) for Compile/Test, and
`LOOM_ASA_TEST_WRITE_URI` for sample-output rows — both surfaced as MessageBars
naming the exact role / env var (see `docs/fiab/v3-tenant-bootstrap.md#asa-query-tester`).

## Backend per control

| Control | Backend |
|---------|---------|
| Operation config (all kinds) | `lib/azure/asa-query-compiler.ts` (pure SAQL compile) — no backend, deterministic |
| Apply to ASA job | `saveTransformation` → ARM `PUT /streamingjobs/{name}/transformations/{name}` `@2020-03-01` |
| Compile query | `compileQuery` → ARM `POST /locations/{loc}/compileQuery` `@2021-10-01-preview` |
| Run test (sample output) | `testTransformation` → ARM `POST /locations/{loc}/testQuery` `@2021-10-01-preview` (LRO → poll → read output blob) |

## Per-cloud

ARM endpoint is cloud-aware (`stream-analytics-client.ts`): `management.azure.com`
for Commercial, `management.usgovcloudapi.net` for GCC / GCC-High / IL5 (selected
from `LOOM_CLOUD`). ASA + the compile/test preview actions are available in Azure
Government regions; if a sovereign region lacks the preview API the call returns a
real error surfaced honestly (no mock).

## Verification

- `lib/azure/__tests__/asa-query-compiler.test.ts` — 10 unit tests (filter,
  aggregate+window, hopping hop, join DATEDIFF, multi-transform WITH chain,
  union, multi-sink, windowClause) — GREEN.
- `lib/editors/__tests__/stream-analytics-job.test.tsx` — render tests assert the
  Query Builder + Test tabs mount with the guided inspector, SAQL preview, and
  Compile/Run actions (runs in CI; the local jsdom store is missing
  `@adobe/css-tools`/`@asamuzakjp/css-color`, a pre-existing harness breakage).
- Live side-by-side (operator-gated): configure a filter/aggregate/window
  transform → Compile → Run test → confirm output rows; attach the ASA
  testQuery/compileQuery response as the receipt.
