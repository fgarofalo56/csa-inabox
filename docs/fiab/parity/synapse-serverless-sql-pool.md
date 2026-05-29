# synapse-serverless-sql-pool — parity with Synapse Serverless SQL pool

Source UI: Synapse Studio Serverless SQL — https://learn.microsoft.com/azure/synapse-analytics/sql/on-demand-workspace-overview
Editor: `SynapseServerlessSqlPoolEditor` in `apps/fiab-console/lib/editors/synapse-sql-editors.tsx`

## Feature inventory

| # | Capability | Source UI |
|---|---|---|
| 1 | Database explorer (master + user DBs) | Data hub |
| 2 | Lake (OPENROWSET over ADLS) browsing | Data hub |
| 3 | T-SQL editor + Run + results grid | Develop hub |
| 4 | Sample queries | Knowledge center |
| 5 | External tables / data sources / file formats | Develop |
| 6 | Bytes-processed cost telemetry | Monitor |
| 7 | Cost cap / data-processed limit | Manage |
| 8 | Compute target picker | Studio |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | `/schema` databases tree; click sets active DB |
| 2 | ✅ | Lake (bronze/silver/gold/landing) tree from `/schema` |
| 3 | ✅ | Monaco editor + Run via `/query` (serverless TDS) |
| 4 | ✅ | Sample queries from `/schema`, click loads SQL |
| 5 | ✅ | `External tables` loads sys.external_tables + OPENROWSET template |
| 6 | ✅ | `Bytes processed` loads sys.dm_external_data_processed query |
| 7 | ✅ | `Cost cap` loads sys.configurations + sp_set_data_processed_limit template |
| 8 | ✅ | `ComputePicker` (serverless, read-only lifecycle — always-on) |

## Backend per control
- Query / DMV / OPENROWSET → Synapse Serverless TDS (`executeQuery`/`serverlessTarget`) via `/api/items/synapse-serverless-sql-pool/[id]/query` + `/schema`.

Grade: **A — every inventory row built; the three former "deferred" buttons (external tables, bytes processed, cost cap) now load real DMV / OPENROWSET T-SQL run through the wired /query path.**
