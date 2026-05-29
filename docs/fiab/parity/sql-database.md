# sql-database — parity with Fabric SQL database

Source UI: Fabric SQL database — https://learn.microsoft.com/fabric/database/sql/overview · https://learn.microsoft.com/fabric/database/sql/sql-analytics-endpoint
Editor: `SqlDatabaseEditor` in `apps/fiab-console/lib/editors/sql-database-editor.tsx`

## Feature inventory

| # | Capability |
|---|---|
| 1 | Database list (workspace) |
| 2 | Create SQL database |
| 3 | Tables explorer |
| 4 | T-SQL query + Run + results |
| 5 | Fabric mirroring (auto-replicate to OneLake) |
| 6 | Delete |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | `/api/items/sql-database?workspaceId=` list |
| 2 | ✅ | `New SQL DB` (Fabric REST SqlDatabases) |
| 3 | ✅ | `Tables` tab |
| 4 | ✅ | `Run` → `/api/items/azure-sql-database/[id]/query` (Fabric SQL DB shares the SQL engine) |
| 5 | ✅ | `Mirroring` tab (auto-replication is default for Fabric SQL DB) |
| 6 | ✅ | `Delete` wired |

## Backend per control
- CRUD → Fabric REST `/v1/workspaces/{ws}/SqlDatabases`. Query → Azure SQL engine TDS (shared engine).

Grade: **A (list + create + tables + query + mirroring + delete all real Fabric REST / TDS).**
