# databricks-sql-warehouse — parity with Azure Databricks SQL Warehouse

Source UI: Databricks SQL — https://learn.microsoft.com/azure/databricks/sql/
Editor: `DatabricksSqlWarehouseEditor` in `apps/fiab-console/lib/editors/databricks-editors.tsx`

## Feature inventory

| # | Capability |
|---|---|
| 1 | Warehouse picker |
| 2 | Catalog / schema / table explorer (Unity Catalog) |
| 3 | SQL editor + Run + results grid |
| 4 | Start / Stop warehouse |
| 5 | Query history |
| 6 | New SQL query |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | `/warehouses` picker |
| 2 | ✅ | `/schema?warehouseId=&catalog=&schema=` lazy tree (Unity Catalog) |
| 3 | ✅ | `/query` (statement-execution REST) + results grid |
| 4 | ✅ | `/start` + `/state` (warehouses REST) |
| 5 | ✅ | `/query-history` with filters |
| 6 | ✅ | `New SQL query` resets editor |

## Backend per control
- All controls → Databricks SQL Statement Execution + Warehouses REST via Console UAMI.

Grade: **A (warehouse lifecycle + UC explorer + query + history all real Databricks REST).**
