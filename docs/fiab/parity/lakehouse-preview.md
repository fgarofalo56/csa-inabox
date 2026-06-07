# lakehouse-preview — parity with Fabric Lakehouse table preview + Data Wrangler column statistics

Source UI:
- **Fabric Lakehouse → table/file preview grid** — open a Delta table or file in
  the Lakehouse explorer and the right pane shows a sortable, resizable data grid
  with multi-select rows, a File / Table view toggle, and copy/keyboard support.
- **Fabric Data Wrangler → "Summary" / column-statistics panel** — per-column
  count, missing/null count, min, max, mean, standard deviation, and a value
  distribution sparkline, computed on Spark.
  https://learn.microsoft.com/fabric/data-science/data-wrangler-spark

Loom surface: the Lakehouse editor **Preview** tab
(`apps/fiab-console/lib/editors/lakehouse-editor.tsx`) now renders the structured
`/api/lakehouse/preview` response through the Fluent v9
`DeltaPreviewGrid` component
(`apps/fiab-console/lib/editors/components/delta-preview-grid.tsx`), replacing the
prior read-only `<Table>` text preview (graded a BLOCKER in
`docs/fiab/parity-gap/lakehouse.md`, Phase 3). Column statistics come from a real
Spark `summary()` job submitted via the Synapse Livy interactive-session API
(`/api/lakehouse/table-stats` → `synapse-dev-client`). No Fabric / OneLake
dependency: preview = ADLS Gen2 via Synapse Serverless OPENROWSET; stats = ADLS
Gen2 (`abfss://`) read on the Synapse `loompool` Spark pool.

## Fabric/Azure feature inventory → Loom coverage

| Capability (Fabric preview + Data Wrangler) | Loom coverage | Backend per control |
|---|---|---|
| Sortable columns (numeric-aware) | built ✅ — `DataGrid sortable`, numeric `compare` when all cells parse finite | client-side over `/api/lakehouse/preview` rows |
| Resizable columns | built ✅ — `resizableColumns` + `columnSizingOptions` | client |
| Multi-select rows | built ✅ — `selectionMode="multiselect"` | client |
| Copy selection (Ctrl/Cmd+C) as CSV | built ✅ — RFC-4180 `toCsv`, `navigator.clipboard` (+ execCommand fallback) | client |
| Download grid as CSV | built ✅ — Blob download of shown rows | client |
| Filter rows | built ✅ — case-insensitive substring across cells, no re-fetch | client |
| Cell preview (full un-truncated value) | built ✅ — click-cell Dialog + copy value | client |
| File / Table view toggle | built ✅ — `mode` + `onModeChange` buttons | parent state |
| Column count | built ✅ | Spark `df.columns` |
| Per-column missing/null count | built ✅ | Spark `count(when isNull)` |
| Per-column min / max | built ✅ | Spark `df.summary('min','max')` |
| Per-column mean / stddev (numeric) | built ✅ | Spark `df.summary('mean','stddev')` |
| Value-distribution sparkline | built ✅ — 10-bucket CSS histogram | Spark RDD `histogram(10)` |
| Loading indicator during async stat compute | built ✅ — `Spinner` in the column-summary card while the Livy job runs | poll `/api/lakehouse/table-stats?jobId=` every 3s |
| Deep-link to reopen the same table | built ✅ — `?tab=preview&container=&path=` written on select, restored on mount | client + `/api/lakehouse/preview` |
| Honest infra gate | ⚠️ — `503 { code:'not_configured', missing:'LOOM_SYNAPSE_WORKSPACE' }` (or ADLS URL) surfaced as "Column statistics unavailable: …" | `synapseConfigGate()` |

Zero ❌ — every preview/stat capability is built, with one honest gate when the
Synapse workspace / ADLS account env vars are unset.

## Backend / async model

`GET /api/lakehouse/table-stats?container=&path=` creates a Livy session on the
Spark pool (`LOOM_SPARK_POOL`, default `loompool`) and — once the session is
`idle` — submits a PySpark statement that runs `df.summary(...)`, per-column null
counts, and numeric histograms, printing a `LOOM_STATS:<json>` marker. The route
returns immediately with `jobId = "<pool>:<session>:<stmt>"` (the stmt segment is
empty while a cold pool warms). The client polls `?jobId=…&container=&path=` every
3 s; the route submits the statement statelessly once the session reaches idle,
then parses the statement output. No blocking call exceeds the Front Door ~30 s
timeout.

## Bicep sync

No new Azure resource: the `loompool` Spark pool is already deployed by
`platform/fiab/bicep/modules/landing-zone/synapse.bicep` (`deploySparkPool`,
`sparkPoolName='loompool'`). The optional `LOOM_SPARK_POOL` env var was added to
the console app in `platform/fiab/bicep/modules/admin-plane/main.bicep`
(param `loomSynapseSparkPool`, default `loompool`) so the pool name is
deployment-driven; the route falls back to `loompool` when it is unset.

## Verification

- `lib/editors/__tests__/delta-preview-grid.test.ts` — 19 passing node-env unit
  tests over CSV serialization (RFC-4180 quoting), numeric-column detection,
  cell formatting, number formatting, and the client filter.
- `npx tsc --noEmit` clean on the three touched TS/TSX files (pre-existing
  Griffel px-literal noise in the editor's untouched `useStyles` excepted).
- Live: with `LOOM_SYNAPSE_WORKSPACE` + `LOOM_{BRONZE,…}_URL` set, select a
  Delta/Parquet/CSV file → DataGrid renders real rows, Ctrl+C copies the
  selection as CSV, the column-summary card shows a Spinner then real Spark
  stats, and the `?tab=preview&container=&path=` deep-link reopens the table.
