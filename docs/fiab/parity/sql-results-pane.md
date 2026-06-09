# sql-results-pane — parity with the Azure SQL / SSMS / Azure Data Studio / Fabric SQL results pane

Source UI:
- Azure Data Studio / SSMS query results grid (multiple grids per batch, Messages tab, save-as-Excel/CSV/JSON, in-grid filter).
- Microsoft Fabric SQL editor results pane — https://learn.microsoft.com/fabric/data-warehouse/query-warehouse
- Azure portal "Query editor (preview)" results grid — https://learn.microsoft.com/azure/azure-sql/database/query-editor

Surface: `lib/editors/components/results-panel.tsx` (`ResultsPanel`), consumed by
`UnifiedSqlDatabaseEditor` Query + Schema tabs. Backed by
`POST /api/items/azure-sql-database/[id]/query` →
`executeQueryBatch()` (real TDS over `mssql`/`tedious`, AAD-MI token). No Microsoft
Fabric dependency — works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Azure / SSMS / Fabric feature inventory

| # | Capability in the source UI | Notes |
|---|------------------------------|-------|
| 1 | Multiple result grids per batch (one grid per `SELECT`) | SSMS/ADS show a stacked/selectable grid per result set |
| 2 | Messages tab (PRINT / RAISERROR / row counts / errors) | severity-coloured; statement durations |
| 3 | Row-count + execution-time readout | "(N rows affected)", elapsed ms |
| 4 | Large result handling / preview cap | portal Query editor caps preview rows |
| 5 | Save / export grid as Excel (.xlsx) | ADS "Save as Excel" |
| 6 | Save / export grid as CSV | |
| 7 | Save / export grid as JSON | ADS "Save as JSON" |
| 8 | Copy with headers / Copy / Copy headers only | right-click grid menu |
| 9 | In-grid search / filter of returned rows | ADS results filter box |
| 10 | Select which result set is shown | result-set switcher |

## Loom coverage

| # | Capability | Status | How |
|---|------------|--------|-----|
| 1 | Multiple result grids per batch | ✅ built | route returns `recordsets[]`; result-set `Dropdown` selects the active grid (shown only when > 1) |
| 2 | Messages tab | ✅ built | `request.on('info')` captures every in-band message → `messages[]`; "Messages" tab with severity badges (Info/Warning/Error), number, message, line, proc |
| 3 | Row-count + execution time | ✅ built | per-set rows badge + batch `executionMs` badge; `rowsAffected[]` shown in Messages + empty-result line |
| 4 | Preview cap (raised to 10,000) | ✅ built | `MAX_ROWS_BATCH = 10_000` server-side cap; honest "Showing first 10,000 of N rows" Badge per set; truncated sets flagged in the dropdown |
| 5 | XLSX (Excel) download | ✅ built | `recordsetsToXlsxBuffer()` (dependency-free OOXML/ZIP writer) → one sheet per result set + a Messages sheet; opens natively in Excel |
| 6 | CSV download | ✅ built | client-side serializer, Download menu |
| 7 | JSON download | ✅ built | client-side serializer, Download menu |
| 8 | Copy dropdown (names+data / data / names) | ✅ built | writes TSV to clipboard (pastes into Excel/SSMS); respects the active filter |
| 9 | In-grid search / filter | ✅ built | `Input` with search icon → `useMemo` row filter; "N match filter" readout |
| 10 | Result-set switcher | ✅ built | Fluent `Dropdown` over `recordsets[]` |

Zero ❌, zero stub banners. Error / honest-gate states (auth failure, postgres gate)
render through the same panel via the backward-compat single-recordset shape.

## Backend per control

| Control | Backend / data-plane |
|---------|----------------------|
| Run (multi-statement batch) | `executeQueryBatch(server, db, sql)` → `mssql` `request.query()` over TDS; `result.recordsets[]` + `result.rowsAffected[]` |
| Messages | tedious `request.on('info')` events (PRINT / RAISERROR sev ≤ 10 / done-with-count) → `messages[]` |
| 10k cap | `MAX_ROWS_BATCH` slice in `executeQueryBatch` (server-side) + honest truncation flag |
| XLSX / CSV / JSON download | client-side, no extra route (XLSX via `lib/azure/sql-xlsx-export.ts`) |
| Copy | `navigator.clipboard.writeText` (TSV) |
| In-grid filter | client-side `useMemo` over the active recordset |

## Per-cloud

TDS is the on-wire protocol — identical across Commercial / GCC / GCC-High / DoD.
The only cloud variable is the host suffix (`database.windows.net` vs
`database.usgovcloudapi.net`), already resolved by `sqlHostSuffix()` /
`LOOM_AZURE_SQL_HOST_SUFFIX`. The XLSX writer is pure browser/Node JS with no
cloud dependency. No new env var, Azure resource, role, or Cosmos container is
introduced by this feature, so no bicep change is required.

## Verification

- `lib/azure/__tests__/sql-xlsx-export.test.ts` — 6 green (PK magic bytes, OOXML
  parts, one sheet per recordset, Messages sheet conditional, truncation note,
  XML escaping). Real workbook receipt: 4,286 bytes, `PK\x03\x04`, sheets
  `Result 1` / `Result 2` / `Messages`.
- `app/api/items/__tests__/azure-sql-databases-routes.test.ts` — added 4 cases
  asserting the `recordsets[] + messages[] + rowsAffected[]` shape, backward-compat
  field promotion, 401/400 gates, and `AzureSqlError` status propagation
  (runs in CI; cannot execute in the isolated worktree because the shared pnpm
  store is missing `tslib`/`@adobe/css-tools` — a known harness gap, unrelated to
  this change; `tsc --noEmit` is clean on the file).
