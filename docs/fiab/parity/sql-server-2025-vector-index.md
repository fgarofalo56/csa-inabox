# sql-server-2025-vector-index — parity with SQL Server 2025 native vector index

Source UI: SQL Server 2025 vector search — https://learn.microsoft.com/sql/relational-databases/vectors/vectors-sql-server
Editor: `SqlServer2025VectorIndexEditor` in `apps/fiab-console/lib/editors/azure-sql-editors.tsx`

## Feature inventory

| # | Capability |
|---|---|
| 1 | Server + database picker |
| 2 | Vector index config (table, column, dimensions, metric) |
| 3 | Create vector index (CREATE VECTOR INDEX DDL) |
| 4 | Test similarity (VECTOR_DISTANCE ANN probe) |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | `useSqlServers` / `useSqlDatabases` pickers |
| 2 | ✅ | Table / column / dimensions / metric form |
| 3 | ✅ | `Create` → CREATE VECTOR INDEX via `/azure-sql-database/[id]/query` (TDS) |
| 4 | ✅ | `Test similarity` now wired → VECTOR_DISTANCE ANN SELECT via the same `/query` TDS path |

## Backend per control
- DDL + similarity probe → Azure SQL / SQL 2025 engine TDS via `/api/items/azure-sql-database/[id]/query`.

Grade: **A — both index creation and the former "deferred" Test similarity button now execute real T-SQL (CREATE VECTOR INDEX + VECTOR_DISTANCE) through the wired TDS path.**
