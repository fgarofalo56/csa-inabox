# azure-sql-database-search — parity with Azure SQL Database Full-Text Search + Vector Index

Source UI: SSMS / Azure portal query editor (FTS DDL) and SQL Server 2025 vector index docs.
- CREATE FULLTEXT CATALOG: https://learn.microsoft.com/sql/t-sql/statements/create-fulltext-catalog-transact-sql
- CREATE FULLTEXT INDEX:   https://learn.microsoft.com/sql/t-sql/statements/create-fulltext-index-transact-sql
- CREATE VECTOR INDEX:     https://learn.microsoft.com/sql/t-sql/statements/create-vector-index-transact-sql
- sys.vector_indexes:      https://learn.microsoft.com/sql/relational-databases/system-catalog-views/sys-vector-indexes-transact-sql

This is the dedicated FTS + vector index management surface requested by the Fabric Build 2026 audit (ask #23). It lives as a **Search** tab on the registered `UnifiedSqlDatabaseEditor` (item type `azure-sql-database` / `sql-database`) and on `AzureSqlDatabaseEditor`. There is no native portal "blade" for FTS; SSMS exposes it via Object Explorer right-click wizards + the New Full-Text Catalog / Full-Text Indexing Wizard. Loom reproduces those wizards one-for-one as guided dialogs with a live preview-SQL pane.

## Feature inventory (grounded in Learn)

| Source-UI capability | Loom coverage | Backend per control |
| --- | --- | --- |
| Create full-text catalog (name, AS DEFAULT, ACCENT_SENSITIVITY) | ✅ built | Full-text catalog tab → `POST /sql-search {wizard:'ft-catalog'}` → `buildCreateFtCatalog` → TDS |
| Drop full-text catalog | ✅ built | Existing objects tab → `{wizard:'ft-catalog-drop'}` → `buildDropFtCatalog` → TDS |
| Create full-text index (columns + LANGUAGE, KEY INDEX picker, catalog, CHANGE_TRACKING) | ✅ built | Full-text index tab → `{wizard:'ft-index'}` → `buildCreateFtIndex` → TDS. Column / KEY INDEX / catalog pickers populated from `sys.*` |
| Drop full-text index | ✅ built | Existing objects tab → `{wizard:'ft-index-drop'}` → `buildDropFtIndex` → TDS |
| List full-text catalogs (default, accent, item count) | ✅ built | GET `/sql-search` → `sys.fulltext_catalogs` + `FULLTEXTCATALOGPROPERTY` |
| List full-text indexes (table, columns, catalog, change-tracking, enabled) | ✅ built | GET → `sys.fulltext_indexes` + `sys.fulltext_index_columns` |
| Create DiskANN vector index (vector column, METRIC, TYPE=DiskANN, MAXDOP) | ✅ built | Vector index tab → `{wizard:'vector-index'}` → `buildCreateVectorIndex` → TDS |
| Drop vector index | ✅ built | Existing objects tab → `{wizard:'vector-index-drop'}` → `buildDropVectorIndex` (DROP INDEX) → TDS |
| List vector indexes (metric, type) | ✅ built | GET → `sys.vector_indexes` joined to `sys.indexes` |
| Engine capability probe (version, vector type, FTS installed) | ✅ built | GET → `SERVERPROPERTY('ProductVersion')` + `sys.types` + `FULLTEXTSERVICEPROPERTY` |
| Preview generated T-SQL before execute | ✅ built | `{preview:true}` returns the SQL without executing |
| Full-text stoplist / search property list | ⚠️ honest-gate (future) | Not yet — listed as a follow-up; the wizards cover catalog + index, the 80% case |
| Populate / start-stop crawl (ALTER FULLTEXT INDEX ... START POPULATION) | ⚠️ honest-gate (future) | CHANGE_TRACKING AUTO covers continuous population; manual crawl control is a follow-up |

Zero ❌ for the core create/manage/drop/list loop. Stoplists + manual crawl control are tracked follow-ups (honest gaps, not stub banners).

## Backend reality (no-vaporware check)

- Every list comes from a real `sys.*` TDS read; every create/drop runs the generated DDL over TDS + Microsoft Entra token (`azure-sql-client.executeQuery`). No mock arrays.
- The client never sends raw SQL — only structured params; SQL is built server-side by `lib/sql/sql-search-builders.ts` (bracket-quoted identifiers via the shared `bracket()` from `tsql-builders.ts`; allowlisted metrics / change-tracking / accent / LANGUAGE LCID / MAXDOP). No injection path.
- Honest gates: "pick a server + database" when unbound; a warning when the engine lacks the `vector` type (older than SQL 2025 / Azure SQL DB) — the wizard still previews the exact DDL.

## No-Fabric-dependency check

FTS and native DiskANN vector indexes are **Azure SQL Database data-plane features** — no Microsoft Fabric, no Power BI, no `fabricWorkspaceId`. The backend is Azure SQL only (TDS). Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET.

## Bicep / bootstrap sync

No new Azure resource, env var, role assignment, or Cosmos container is introduced. The feature is pure T-SQL over the existing Azure SQL TDS path the editor already uses (same connection, same `azure-active-directory-access-token` auth). The only operational requirement is the existing one for the Query tab: the console UAMI must be the Microsoft Entra admin (or in the admin group) and have `db_owner` / `db_ddladmin` on the database to run DDL. That is documented on the editor's left pane and in `docs/fiab/v3-tenant-bootstrap.md` (SQL Entra-admin bootstrap) — unchanged by this feature.

## Files

- BFF: `apps/fiab-console/app/api/items/[type]/[id]/sql-search/route.ts`
- Builders: `apps/fiab-console/lib/sql/sql-search-builders.ts`
- Panel: `apps/fiab-console/lib/panes/sql-search-panel.tsx`
- Wired into: `apps/fiab-console/lib/editors/unified-sql-database-editor.tsx` (Search tab + ribbon) and `apps/fiab-console/lib/editors/azure-sql-editors.tsx` (Search tab + ribbon)
- Tests: `apps/fiab-console/lib/sql/__tests__/sql-search-builders.test.ts`
