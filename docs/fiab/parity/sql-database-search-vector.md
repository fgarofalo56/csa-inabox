# sql-database-search-vector — parity with Azure SQL full-text search + vector indexes

Source UI: SSMS / Azure Data Studio "Full-Text Catalogs" + "Indexes" nodes and the
SQL Server 2025 vector index DDL.
- Full-text: https://learn.microsoft.com/sql/relational-databases/search/get-started-with-full-text-search
- Vector index: https://learn.microsoft.com/sql/t-sql/statements/create-vector-index-transact-sql

Editor: the **Search & vector** tab in `AzureSqlDatabaseEditor`
(`apps/fiab-console/lib/editors/azure-sql-editors.tsx`, `SearchVectorTab`).

## Azure/Fabric feature inventory

| # | Capability |
|---|---|
| 1 | Inventory existing vector indexes (table, column, metric, version) |
| 2 | Inventory existing full-text catalogs (default flag, accent sensitivity) |
| 3 | Inventory existing full-text indexes (columns, catalog, key index, change tracking, enabled) |
| 4 | Create a vector index (DiskANN) — pick column, name, metric |
| 5 | Create a full-text catalog (optionally AS DEFAULT) |
| 6 | Create a full-text index — pick table, columns, unique key index, catalog, change tracking |
| 7 | Engine-version gate for vector indexes (SQL 2025 / major ≥ 17) |
| 8 | Refresh from live system catalog |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | `sys.vector_indexes` join, guarded with `OBJECT_ID` for older engines |
| 2 | ✅ | `sys.fulltext_catalogs` + `FULLTEXTCATALOGPROPERTY` |
| 3 | ✅ | `sys.fulltext_indexes` + `sys.fulltext_index_columns` aggregated |
| 4 | ✅ | Dialog → `CREATE VECTOR INDEX … WITH (METRIC, TYPE='DiskANN')`; column dropdown from `sys.types name='vector'` |
| 5 | ✅ | Dialog → `CREATE FULLTEXT CATALOG [name] [AS DEFAULT]` |
| 6 | ✅ | Dialog → `CREATE FULLTEXT INDEX … KEY INDEX … WITH (CHANGE_TRACKING …)`; columns + unique-key dropdowns from catalog |
| 7 | ✅ | `engineMajor` from `SERVERPROPERTY('ProductVersion')`; new-vector-index button + warning bar gate |
| 8 | ✅ | `Refresh` re-runs the inventory batch |

## Backend per control
- Inventory (read) → `GET /api/items/azure-sql-database/[id]/search-index?server=&database=`
  → `getSearchInventory()` one TDS multi-recordset batch over AAD MI.
- Create (DDL) → `POST /api/items/azure-sql-database/[id]/search-index`
  `{ kind: 'vector-index' | 'fts-catalog' | 'fts-index', spec }`
  → `buildCreate*Sql()` (all identifiers brace-quoted via `quoteIdent`) →
  `executeQueryBatch()` over TDS. The executed DDL string is returned for the receipt.

## Infra / permissions (honest gate)
- No new Azure resource, env var, RBAC role, or Cosmos container. Uses the same
  TDS + AAD MI path already required by the Query/Mirroring tabs.
- The Console UAMI must be `db_ddladmin` (or `db_owner`) on the database and hold
  `REFERENCES` on the full-text catalog. A permission/tier error surfaces verbatim
  in the dialog's error MessageBar (no fake success).
- Vector indexes require SQL Server 2025 / Azure SQL Database (engine major ≥ 17);
  on older engines the create-vector-index button is disabled with a warning bar.

Grade: **B → A target** — full inventory + structured create dialogs over real
TDS DDL, Azure-native (no Microsoft Fabric), griffel-clean tsc.
