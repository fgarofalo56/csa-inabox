# lakehouse-table-history — parity with Fabric Lakehouse / Delta table history (time travel)

Source UI: Microsoft Fabric Lakehouse → table context menu → "View version history" /
"Maintenance"; Databricks Catalog → table → **History** tab. Grounded in
Delta Lake `DESCRIBE HISTORY`, `RESTORE TABLE … TO VERSION AS OF`, and
`SELECT … VERSION AS OF` (Microsoft Learn: Delta Lake time travel on Azure
Databricks / Fabric Spark).

## Azure / Fabric feature inventory

| # | Capability (Fabric/Databricks) | Backing SQL / API |
|---|--------------------------------|-------------------|
| 1 | Version history grid: version #, commit timestamp, operation, user, operation metrics | `DESCRIBE HISTORY <table>` |
| 2 | Operation metrics per version (rows written, files added/removed, rows deleted, bytes) | `operationMetrics` map in commit log |
| 3 | Preview a historical snapshot (read-only) | `SELECT * FROM <table> VERSION AS OF <n>` |
| 4 | Restore the table to an earlier version | `RESTORE TABLE <table> TO VERSION AS OF <n>` |
| 5 | Refresh history | re-run `DESCRIBE HISTORY` |

## Loom coverage

| # | Capability | State | Notes |
|---|------------|-------|-------|
| 1 | Version history grid (version, timestamp, operation, user, metrics) | ✅ built | Read directly from `_delta_log/*.json` `commitInfo` — no SQL engine needed (Azure-native, zero Fabric dependency). |
| 2 | Operation metrics column | ✅ built | numOutputRows · numFiles · numRemovedFiles · numDeletedRows · numOutputBytes rendered inline. |
| 3 | Preview-as-of (read-only snapshot, 100 rows) | ✅ built / ⚠️ honest-gate | `SELECT … VERSION AS OF` on a Databricks SQL Warehouse. Honest MessageBar (`code:no_databricks` / `no_warehouse`) when Databricks isn't configured. |
| 4 | Restore to version | ✅ built / ⚠️ honest-gate | `RESTORE TABLE … TO VERSION AS OF` on the warehouse, with a confirm dialog + VACUUM warning. Same honest-gate. History grid auto-refreshes after restore so the new RESTORE commit is visible. |
| 5 | Refresh | ✅ built | Re-reads `_delta_log`. |

Zero ❌. The version-list path (rows 1–2) works on pure ADLS with **no**
Databricks and **no** Fabric workspace. Restore/preview (rows 3–4) require a
Databricks SQL Warehouse — an honest Azure-side infra gate, not a Fabric one.

## Backend per control

| Control | Route | Backend |
|---------|-------|---------|
| History grid + Refresh | `GET /api/lakehouse/history?container&tablePath` | `adls-client.listPaths` + `downloadFile` over `_delta_log/*.json` (parses `commitInfo`) |
| Preview-as-of | `POST /api/lakehouse/history {action:'preview'}` | `databricks-client.executeStatement` → `SELECT … VERSION AS OF … LIMIT 100` |
| Restore | `POST /api/lakehouse/history {action:'restore'}` | `databricks-client.executeStatement` → `RESTORE TABLE … TO VERSION AS OF` |

## No-Fabric / no-vaporware compliance

- Default path reads `_delta_log` from ADLS Gen2 — works with
  `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. No `api.fabric.microsoft.com` /
  `onelake.dfs.fabric` calls.
- No mock data: the grid is empty (info MessageBar) until a real Delta table
  has commits; restore/preview either return a real warehouse result or an
  honest 503 gate naming `LOOM_DATABRICKS_HOSTNAME`.
- Env vars (`LOOM_DATABRICKS_HOSTNAME`, `LOOM_BRONZE/SILVER/GOLD/LANDING_URL`)
  already wired in `platform/fiab/bicep/modules/admin-plane/main.bicep` — no
  new infra.

## Verification

- `GET /api/lakehouse/history?container=bronze&tablePath=Tables/<t>` → `{ok:true, versions:[{version,timestamp,operation,metrics,…}]}` listing real Delta commits.
- `POST {action:'preview', version:0}` → historical row set for that version.
- `POST {action:'restore', version:N}` then re-GET → a new RESTORE commit appears at the top; current table reverts (row count matches version N). Receipt in PR body.
