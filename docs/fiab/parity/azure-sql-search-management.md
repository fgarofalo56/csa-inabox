# azure-sql-search-management — parity with SSMS / Azure portal full-text + SQL 2025 vector index management

> **audit-t78 (2026-06-10).** Adds two new management tabs to the standalone
> `AzureSqlDatabaseEditor` (`apps/fiab-console/lib/editors/azure-sql-editors.tsx`):
> **Full-text search** and **Vector indexes** (Fabric Build 2026 #23). Both are
> guided-dialog surfaces over real TDS DDL — no raw JSON, no Fabric.

**Source UI:**
- Full-Text Search overview — https://learn.microsoft.com/sql/relational-databases/search/full-text-search
- Get started with FTS (T-SQL) — https://learn.microsoft.com/sql/relational-databases/search/get-started-with-full-text-search
- CREATE FULLTEXT CATALOG — https://learn.microsoft.com/sql/t-sql/statements/create-fulltext-catalog-transact-sql
- CREATE FULLTEXT INDEX — https://learn.microsoft.com/sql/t-sql/statements/create-fulltext-index-transact-sql
- Populate full-text indexes — https://learn.microsoft.com/sql/relational-databases/search/populate-full-text-indexes
- CREATE VECTOR INDEX (SQL 2025 preview) — https://learn.microsoft.com/sql/t-sql/statements/create-vector-index-transact-sql
- Vector search & indexes — https://learn.microsoft.com/sql/sql-server/ai/vectors

## Audited Loom code

- Editor: `lib/editors/azure-sql-editors.tsx` → `AzureSqlDatabaseEditor`, tabs **Query · Full-text search · Vector indexes · Mirroring · Replication · SQL 2025**. Ribbon **Search** group jumps to the FTS / Vector tabs.
- Panels: `lib/editors/components/sql-search-management.tsx` → `FullTextSearchPanel`, `VectorIndexPanel`.
- BFF: `app/api/items/azure-sql-database/[id]/search-management/route.ts` (GET inventory + POST create/drop/populate). All DDL built **server-side** with strict identifier whitelisting + bracket-quoting; every read & write runs over `executeQuery` (TDS + AAD MI).

Legend: ✅ built (1:1 + real backend) · ⚠️ honest-gate · ❌ MISSING

## A. Full-text search
| SSMS / portal capability | Loom | Where / backend |
| --- | --- | --- |
| List full-text catalogs | ✅ built | FTS tab grid ← `sys.fulltext_catalogs` |
| Create full-text catalog (accent sensitivity, AS DEFAULT) | ✅ built | New catalog dialog → `create-catalog` → `CREATE FULLTEXT CATALOG ... WITH ACCENT_SENSITIVITY = ON/OFF [AS DEFAULT]` |
| Drop full-text catalog | ✅ built | grid Drop → `drop-catalog` → `DROP FULLTEXT CATALOG` |
| List full-text indexes (table, columns, catalog, change-tracking) | ✅ built | FTS tab grid ← `sys.fulltext_indexes` join `sys.tables`/`sys.fulltext_index_columns` |
| Create full-text index — pick table (dropdown) | ✅ built | New FTS index dialog, tables ← `sys.tables` |
| Pick text columns (checkbox list, only eligible types) | ✅ built | columns ← `sys.columns` filtered to char/varchar/nchar/nvarchar/text/ntext/xml/image/varbinary |
| Per-column LANGUAGE (LCID dropdown) | ✅ built | LANGUAGE clause per column |
| KEY INDEX (single-column unique non-null dropdown) | ✅ built | KEY INDEX list ← `sys.indexes` eligibility filter |
| Catalog selection | ✅ built | `ON [catalog]` |
| CHANGE_TRACKING AUTO / MANUAL / OFF | ✅ built | WITH CHANGE_TRACKING |
| STOPLIST (SYSTEM / OFF / named) | ✅ built | `stoplist` param → `WITH STOPLIST = ...` |
| Live DDL preview before run | ✅ built | dialog shows the exact `CREATE FULLTEXT INDEX` |
| Start FULL / INCREMENTAL population; set tracking; stop | ✅ built | index-row actions → `populate-fts` → `ALTER FULLTEXT INDEX ... START FULL/INCREMENTAL POPULATION` / `SET CHANGE_TRACKING` / `STOP POPULATION` |
| Drop full-text index (confirm) | ✅ built | row Drop → `drop-fts` → `DROP FULLTEXT INDEX ON` |
| Query with CONTAINS / FREETEXT | ✅ built | runs on the existing Query tab (TDS) |
| TYPE COLUMN for varbinary documents | ❌ MISSING | not surfaced (rare; raw T-SQL on Query tab) |
| SEARCH PROPERTY LIST | ❌ MISSING | raw T-SQL |

## B. Vector indexes (SQL Server 2025 / Azure SQL Database)
| Capability | Loom | Where / backend |
| --- | --- | --- |
| List vector indexes (table, metric, version) | ✅ built | Vector tab grid ← `sys.vector_indexes` (defensive probe; older engines → [] + note) |
| Create vector index — pick table with a `vector(N)` column | ✅ built | dialog, tables ← `sys.columns` where type = `vector` |
| Pick vector column | ✅ built | column dropdown |
| Index name (auto-suggested) | ✅ built | input |
| METRIC = cosine / euclidean / dot | ✅ built | dropdown |
| TYPE = DiskANN | ✅ built | fixed (only supported type) |
| MAXDOP override (0-64) | ✅ built | optional input → `WITH (... MAXDOP = n)` |
| Live DDL preview | ✅ built | dialog shows `CREATE VECTOR INDEX` |
| Drop vector index (confirm) | ✅ built | row Drop → `drop-vector` → `DROP INDEX ... ON` |
| Search with VECTOR_SEARCH | ✅ built | Query tab (TDS) |
| No vector column → guided next step | ⚠️ honest-gate | warning MessageBar names `ALTER TABLE ... ADD col VECTOR(1536)` to run on Query tab |
| Older engine (no `sys.vector_indexes`) | ⚠️ honest-gate | inventory note: "SQL Server 2025 / Azure SQL Database required" |

## Backend reality (no-vaporware check)

- Every read (`sys.fulltext_catalogs`, `sys.fulltext_indexes`, `sys.vector_indexes`, `sys.tables`, `sys.columns`, `sys.indexes`) and every DDL is executed over real TDS via `executeQuery` (azure-sql-client). No mock arrays, no `return []`.
- Identifiers from the dialogs are validated (`^[A-Za-z_][A-Za-z0-9_$#@ ]*$`, ≤128) and bracket-quoted server-side; metric/tracking/maxdop are whitelist-validated. The client never sends raw SQL.
- The `ddl` that ran is echoed in every POST response.

## Infra requirements (honest gates — Azure, not Fabric)

- Console UAMI must be `db_owner` / `db_ddladmin` on the target database (same requirement as the existing Query tab). A permission error surfaces verbatim in the action MessageBar.
- **Vector indexes on SQL Server 2025 (not Azure SQL DB)** additionally require enabling the `PREVIEW_FEATURES` database-scoped configuration once: `ALTER DATABASE SCOPED CONFIGURATION SET PREVIEW_FEATURES = ON;` (documented in `docs/fiab/v3-tenant-bootstrap.md`). On Azure SQL Database this is not needed.
- No new Azure resource, app env var, role assignment, or Cosmos container is introduced — the feature rides the existing Azure SQL TDS path, so bicep needs no change.

## Verdict — Grade A (real backend, guided dialogs, no Fabric)

Both surfaces deliver the SSMS full-text + SQL 2025 vector-index management workflow one-for-one with guided dropdowns and live DDL preview, executing real T-SQL over TDS. Rare advanced FTS knobs (TYPE COLUMN, SEARCH PROPERTY LIST) remain raw-T-SQL only and are the only ❌ rows.
