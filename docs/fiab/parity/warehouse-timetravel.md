# warehouse-timetravel — parity with Fabric Warehouse (data recovery: clone / time travel / restore points / COPY INTO / snapshots)

Source UI (Fabric Warehouse):

- Time travel — <https://learn.microsoft.com/fabric/data-warehouse/time-travel>
- Clone table — <https://learn.microsoft.com/fabric/data-warehouse/clone-table>
- Restore in-place — <https://learn.microsoft.com/fabric/data-warehouse/restore-in-place>
- Warehouse snapshot — <https://learn.microsoft.com/fabric/data-warehouse/warehouse-snapshot>
- Data retention — <https://learn.microsoft.com/fabric/data-warehouse/data-retention>
- COPY INTO (T-SQL) — <https://learn.microsoft.com/sql/t-sql/statements/copy-into-transact-sql?view=azure-sqldw-latest>

Azure-native backends (no Fabric dependency, per `.claude/rules/no-fabric-dependency.md`):

- Warehouse relational engine → **Synapse Dedicated SQL pool** (`synapse-sql-client`, `synapse-pool-arm`).
- Delta time-travel SQL (`VERSION AS OF` / `TIMESTAMP AS OF` / `SHALLOW CLONE`) → **Databricks SQL Warehouse** (`databricks-client`) — the Azure-native engine that speaks Delta time travel; Synapse Serverless does not.
- Delta version/checkpoint history → read directly from `_delta_log` on **ADLS Gen2** (`delta-history` + `adls-client`), no engine required.

Surface: a **Time travel** tab in the Warehouse editor (`lib/editors/phase3/warehouse-editor.tsx`) rendering `WarehouseTimeTravelTab` (`lib/editors/components/warehouse-time-travel.tsx`), with five sub-tabs.

## Fabric feature inventory → Loom coverage → backend per control

| Fabric Warehouse capability | Loom coverage | Backend per control |
|---|---|---|
| **Clone table — current point-in-time** (`CREATE TABLE AS CLONE OF`) | ✅ Clone tab → "Warehouse table (CTAS)" | Real `CREATE TABLE [tgt] WITH (DISTRIBUTION=…) AS SELECT * FROM [src]` on the Synapse Dedicated pool (`POST /clone` mode `ctas`). Dedicated pools have no zero-copy CLONE statement; CTAS is the Azure-native independent-copy equivalent. |
| **Clone table — zero-copy metadata clone** | ✅ Clone tab → "Delta lakehouse table (SHALLOW CLONE)" | Real `CREATE TABLE delta.\`tgt\` SHALLOW CLONE delta.\`src\`` on Databricks (`POST /clone` mode `delta-shallow`). Honest-gate when Databricks unconfigured. |
| **Clone as of past point-in-time** | ✅ Clone (delta-shallow) `version` + Snapshots "Snapshot this" per version | `SHALLOW CLONE … VERSION AS OF n` on Databricks. |
| **Time travel — `FOR TIMESTAMP AS OF`** (statement-level read) | ✅ Time travel tab → "By timestamp" | Real `SELECT * FROM delta.\`abfss\` TIMESTAMP AS OF '…' LIMIT 100` on Databricks (`POST /time-travel`). Azure-native equivalent of the Fabric `OPTION (FOR TIMESTAMP AS OF …)`. |
| **Time travel — by version** | ✅ Time travel tab → "By version" | Real `SELECT … VERSION AS OF n` on Databricks. |
| **Version history (DESCRIBE HISTORY)** | ✅ Time travel + Snapshots "Load version history" | `_delta_log` commit-file read (`GET /time-travel`, `GET /snapshots`) — no engine, zero Fabric dep. |
| **User-defined restore points (DISCRETE)** | ✅ Restore points tab → "Create restore point" | Real ARM `POST …/sqlPools/{pool}/restorePoints { restorePointLabel }` (`POST /restore-points` action `create`). |
| **Automatic restore points (CONTINUOUS, ~8h)** | ✅ Restore points list (type badge) | Real ARM `GET …/restorePoints` (`GET /restore-points`). |
| **Delete restore point** | ✅ Restore points tab → per-row Delete (DISCRETE only) | Real ARM `DELETE …/restorePoints/{name}`. |
| **Restore in-place** | ✅ Restore points tab → "Restore to new pool" (honest disclosure: dedicated pools restore to a NEW pool) | Real ARM `PUT …/sqlPools/{newPool} { createMode: PointInTimeRestore, sourceDatabaseId, restorePointInTime }`. |
| **COPY INTO ingestion** | ✅ COPY INTO tab (source picker → target → format wizard) | Real `COPY INTO [tgt] FROM '<url>' WITH (FILE_TYPE=…, CREDENTIAL=(IDENTITY='Managed Identity'))` on the dedicated pool (`POST /copy-into`); source browse via `GET /copy-into` (ADLS `listPaths`). |
| **Warehouse snapshot (read-only point-in-time copy)** | ✅ Snapshots tab → "Create snapshot" | Zero-copy Delta `SHALLOW CLONE` on Databricks (`POST /snapshots`) — Fabric warehouse-snapshot semantics. |
| **Snapshot / checkpoint listing** | ✅ Snapshots tab (versions + `*.checkpoint.parquet` + `_last_checkpoint`) | `_delta_log` read (`GET /snapshots`), no engine. |
| Data retention window config | ⚠️ Out of scope here — retention is a pool/Delta setting (managed via `VACUUM` / pool retention), surfaced in the lakehouse maintenance surface. |

Zero ❌. All rows are built ✅ or honest-gate ⚠️.

## Real-data / honest-gate behaviour (per `no-vaporware.md`)

Every control calls a real backend:

- **CTAS clone / COPY INTO / restore points** run against the live Synapse Dedicated SQL pool (TDS + ARM) — real receipts (`sql`, `recordsAffected`/`rowsLoaded`, `executionMs`), no mocks.
- **Delta shallow clone / time travel / snapshot create** run real Databricks Statement Execution SQL; when Databricks is unconfigured they return an honest 503 MessageBar naming the exact env var (`databricksConfigGate().missing`) — the full surface still renders, and the `_delta_log`-backed **list** paths keep working without Databricks.
- **Restore points** honest-gate on `LOOM_SYNAPSE_WORKSPACE` / `LOOM_SYNAPSE_DEDICATED_POOL` when the pool isn't configured, and on pool `Paused` state (paused pools take no snapshots) with a 409.

## Env / bicep sync

No new env vars introduced — reuses `LOOM_SYNAPSE_WORKSPACE`, `LOOM_SYNAPSE_DEDICATED_POOL`, `LOOM_SYNAPSE_RG`/`LOOM_SYNAPSE_SUB` (restore points ARM), the existing Databricks vars (`databricks-client`), and `LOOM_GOLD_URL`/ADLS account (`adls-client`). `check-env-sync` stays green.

## Verification

- Guard cascade (`check-bff-errors`, `check-route-guards`, `check-env-sync`, `check-no-freeform`, `check-sql-quoting`, `check-docs-hygiene`) green.
- Live E2E receipt (endpoint hit + real body + screenshot) attached to the PR per `no-vaporware.md`.
