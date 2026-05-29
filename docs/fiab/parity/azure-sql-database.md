# azure-sql-database — parity with Azure SQL Database (portal)

Source UI: Azure portal SQL database — https://learn.microsoft.com/azure/azure-sql/database/connect-query-portal · https://learn.microsoft.com/azure/azure-sql/database/active-geo-replication-overview
Editor: `AzureSqlDatabaseEditor` in `apps/fiab-console/lib/editors/azure-sql-editors.tsx`

## Feature inventory

| # | Capability | Portal blade |
|---|---|---|
| 1 | Query editor (T-SQL, Entra/SQL auth, Run, results) | Query editor |
| 2 | Server + database picker | Overview |
| 3 | Fabric mirroring config | Mirroring |
| 4 | Active geo-replication (add replica) | Replicas |
| 5 | SQL Server 2025 engine feature probe (vector, etc.) | Overview/version |
| 6 | Firewall / AAD admin | (server-level, see azure-sql-server) |
| 7 | Keyboard Run (Ctrl/Cmd+S) | Editor |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | Monaco T-SQL + Run via `/query` (TDS over AAD MI), results grid |
| 2 | ✅ | `useSqlServers` + `useSqlDatabases` pickers |
| 3 | ✅ | `Toggle Fabric mirror` → `/mirroring` |
| 4 | ✅ | `Add geo-replica` dialog → `/replication` (ARM createReplica) |
| 5 | ✅ | `Probe engine` → `/sql2025-features` |
| 6 | ✅ | Surfaced on the server editor (firewall/AAD admin ARM) |
| 7 | ✅ | Ctrl/Cmd+S runs the query (SSMS muscle memory) |

## Backend per control
- Query → Azure SQL TDS (AAD MI). Mirroring/replication/sql2025 → ARM + TDS via the respective routes.

Grade: **A (query + mirroring + geo-replica + SQL2025 probe all real ARM/TDS).**
