# Loom SQL Server 2025 Vector Index Editor — Azure-portal parity spec

> Captured 2026-05-26. Source: Microsoft Learn `sql/sql-server/ai/vectors`, `sql/t-sql/data-types/vector-data-type`, `sql/t-sql/data-types/vector-data-type-half-precision-float`, `sql/t-sql/statements/create-vector-index-transact-sql`, `sql/t-sql/functions/vector-search-transact-sql`, `sql/t-sql/functions/vectorproperty-transact-sql`, `sql/t-sql/functions/vector-functions-transact-sql`, `sql/relational-databases/system-catalog-views/sys-vector-indexes-transact-sql`, `azure/azure-sql/managed-instance/update-policy`. Item: `sql-server-2025-vector-index` → `apps/fiab-console/lib/editors/azure-sql-editors.tsx::SqlServer2025VectorIndexEditor`. **All features here are Preview in SQL Server 2025 (17.x).**

## Overview
SQL Server 2025 introduces a first-class `vector` data type (`VECTOR(dimensions[, base_type])`, base type `float32` default or `float16` preview, dimensions 1-1998) for storing fixed-dimension numeric embeddings in optimized binary form (exposed as JSON arrays for compatibility). A new `CREATE VECTOR INDEX` T-SQL DDL builds a DiskANN graph-based approximate-nearest-neighbor index on a `vector` column. The `VECTOR_SEARCH` T-SQL function performs ANN queries against the index; `VECTOR_DISTANCE`, `VECTORPROPERTY`, and the `vector` function family round out the surface. `sys.vector_indexes` is the catalog view. Vector features are available in Azure SQL Database, SQL database in Microsoft Fabric, SQL Server 2025, and Azure SQL Managed Instance configured with **SQL Server 2025** or **Always-up-to-date** update policy. **Latest-version vector indexes are currently Azure SQL Database + Fabric SQL only** (per the Microsoft Learn note on `CREATE VECTOR INDEX`); SQL Server 2025 and SQL MI hold an earlier index version that requires `PREVIEW_FEATURES = ON`.

## "Portal UI" inventory
There is **no first-party Azure-portal blade** for vector indexes — the feature is entirely T-SQL DDL/DML. The Microsoft Learn surface is:
- `CREATE VECTOR INDEX <name> ON <table>(<vector_col>) WITH (METRIC = 'cosine' | 'dot' | 'euclidean', TYPE = 'DiskANN', MAXDOP = N) [ON filegroup_name]` — only DiskANN is supported today.
- `DROP INDEX <name> ON <table>` — required to migrate from earlier index versions (cannot upgrade in place).
- `SELECT TOP (N) WITH APPROXIMATE ... FROM VECTOR_SEARCH(...)` — latest version. Earlier versions used `TOP_N` parameter (deprecated; raises Msg 42274 in latest version).
- `sys.vector_indexes` catalog view — columns `vector_index_type`, `distance_metric`, `build_parameters` (JSON, includes `Version` — value `3` = latest format).
- `sys.columns` exposes `vector_dimensions`, `vector_base_type`, `vector_base_type_desc` for `vector` columns.
- `VECTORPROPERTY(@v, 'Dimensions' | 'BaseType')` for run-time inspection.
- `ALTER DATABASE SCOPED CONFIGURATION SET PREVIEW_FEATURES = ON` — required on SQL Server 2025 (and for `float16` on any engine).
- DML support on indexed tables: latest version allows INSERT/UPDATE/DELETE/MERGE with real-time index maintenance (removes the earlier read-only-after-index-build limitation). Iterative filtering applies WHERE predicates during the vector search rather than post-filter.

The closest "UI" is SSMS / Azure Data Studio with the `mssql` extension — both surface vector columns as a string column today and don't render the index visually. Loom is the first opinionated UI for this surface.

## What Loom has
- `SqlServer2025VectorIndexEditor` — form with Server + Database + Table + Vector column + Dimensions + Metric (cosine | euclidean | dot). Generates a templated `CREATE VECTOR INDEX` DDL into a read-only textarea, then a single **Create vector index** button that proxies to `POST /api/items/azure-sql-database/[id]/query` (re-uses the Database editor's TDS route). MessageBar disclaims the SQL 2025 gate. Probe step lives in the Database editor's "SQL 2025" tab.
- Currently emits an invalid DDL fragment — `WITH (METRIC = 'COSINE', DIMENSIONS = 1536)` is **not** the published syntax. Per Microsoft Learn, `DIMENSIONS` is declared in the column definition (`VECTOR(1536)`), not in the index `WITH` clause. **This is a bug to fix during parity work.** The correct shape is:
  ```sql
  CREATE VECTOR INDEX idx_docs_embedding
  ON dbo.docs(embedding)
  WITH (METRIC = 'cosine', TYPE = 'DiskANN');
  ```

## Gaps for parity
1. **DDL bug fix** — remove `DIMENSIONS = N` from the index `WITH` clause; dimensions are a property of the underlying `vector` column. Show the column DDL (`CREATE TABLE / ALTER TABLE ADD <col> VECTOR(N)`) as a sibling block in the editor.
2. **Preview-features gate detection** — `SELECT value FROM sys.database_scoped_configurations WHERE name = 'PREVIEW_FEATURES'` → if `0`, surface a MessageBar with a one-click "Enable PREVIEW_FEATURES" button that runs `ALTER DATABASE SCOPED CONFIGURATION SET PREVIEW_FEATURES = ON`.
3. **Engine-and-policy gate** — for Azure SQL MI targets, also probe the instance `updatePolicy` (control plane) and warn when not `SQLServer2025` or `AlwaysUpToDate`. Re-use the existing `sql2025-features` probe.
4. **Vector column creation wizard** — pick a base type (`float32` default, `float16` preview), validate dimensions in `[1, 1998]`, emit `ALTER TABLE ... ADD <col> VECTOR(N [, float16])`.
5. **Index inspection view** — query `sys.vector_indexes` joined to `sys.indexes` + `sys.tables` and render a table of vector indexes per database with type, metric, JSON `build_parameters`, derived `Version` (3 = latest, lower = legacy needing migration). Add a one-click **Migrate** action that drops + recreates legacy indexes.
6. **Similarity-search runner** — Test pane with an input embedding (JSON array or text + `AI_GENERATE_EMBEDDINGS(... USE MODEL Ada2Embeddings)` if the database has the AI model wired up) and a `SELECT TOP (N) WITH APPROXIMATE ... FROM VECTOR_SEARCH(...)` template that renders the top-N results with distance.
7. **Quantization parameters** — once the GA T-SQL exposes them (today only Cosmos DB documents `quantizerType`, `quantizationByteSize`, `indexingSearchListSize`), surface as advanced options.
8. **MAXDOP control** — slider for parallel index build degree (`MAXDOP = 0 | 1 | N`).
9. **DML demo + lag indicator** — show that INSERT/UPDATE/DELETE/MERGE on the indexed table keeps the index live (latest version). On legacy indexes warn that the table becomes read-only after build.
10. **`VECTOR_DISTANCE` calculator** — paired-vector distance computation for ad-hoc debugging; mirrors the Microsoft docs sample for `DECLARE @v AS VECTOR(3) = '[0.1, 2, 30]'`.

## Backend mapping
Pure TDS — no ARM. All DDL/DML lands through the same `POST /api/items/azure-sql-database/[id]/query` route the Database editor uses; for MI targets, route through a future `POST /api/items/azure-sql-managed-instance/[id]/query` (gated on the VNet integration described in the MI parity spec). Suggested additional BFF endpoints:
- `POST /api/items/sql-server-2025-vector-index/list` — runs the `sys.vector_indexes` join query, returns structured rows including the parsed `Version`.
- `POST /api/items/sql-server-2025-vector-index/enable-preview` — runs `ALTER DATABASE SCOPED CONFIGURATION SET PREVIEW_FEATURES = ON` against the target DB; idempotent.
- `POST /api/items/sql-server-2025-vector-index/test-search` — accepts `{ table, column, queryVector, topN, metric }` and runs the `VECTOR_SEARCH` template.

## Required Azure resources
None new — this is a feature of an existing Azure SQL Database / SQL MI / SQL database in Fabric / on-prem SQL Server 2025 engine. Gates:
- Azure SQL Database — supported (latest index version).
- SQL database in Microsoft Fabric — supported (latest index version).
- Azure SQL MI — requires `updatePolicy = SQLServer2025` or `AlwaysUpToDate`; earlier vector index version only.
- SQL Server 2025 (boxed / VM) — requires `PREVIEW_FEATURES = ON`; earlier vector index version only.
- For embedding generation inside the engine (`AI_GENERATE_EMBEDDINGS`), the database must have an AI model registered (separate Preview feature wiring an Azure OpenAI or external embeddings endpoint via `CREATE EXTERNAL MODEL`); otherwise embeddings must be supplied client-side.

## Reference DDL / DML shapes (from Microsoft Learn samples)
For the editor's templated SQL and the inline help popovers:

```sql
-- 1) Enable preview features (SQL Server 2025 + float16 only; not needed in Azure SQL DB / Fabric)
ALTER DATABASE SCOPED CONFIGURATION SET PREVIEW_FEATURES = ON;

-- 2) Declare a vector column (dimensions are a column-level property, 1-1998)
CREATE TABLE dbo.Articles (
    id INT PRIMARY KEY,
    title NVARCHAR(400),
    title_vector VECTOR(1536)              -- default float32
    -- title_vector VECTOR(1536, float16)  -- half-precision (Preview)
);

-- 3) Build a DiskANN ANN index on the vector column
CREATE VECTOR INDEX idx_articles_title_vector
ON dbo.Articles(title_vector)
WITH (METRIC = 'cosine', TYPE = 'DiskANN', MAXDOP = 0);

-- 4) Approximate nearest-neighbor search (latest index version syntax)
DECLARE @q VECTOR(1536) = AI_GENERATE_EMBEDDINGS(N'quantum computing' USE MODEL Ada2Embeddings);
SELECT TOP (10) WITH APPROXIMATE
    a.id, a.title, vs.distance
FROM dbo.Articles AS a
CROSS APPLY VECTOR_SEARCH(table = dbo.Articles, column = title_vector, queryvector = @q) AS vs
WHERE vs.id = a.id
ORDER BY vs.distance;

-- 5) Inspect existing vector indexes (resolve Version = 3 for latest format)
SELECT
    t.name AS table_name, i.name AS index_name,
    vi.vector_index_type, vi.distance_metric,
    JSON_VALUE(vi.build_parameters, '$.Version') AS index_version,
    vi.build_parameters
FROM sys.vector_indexes AS vi
JOIN sys.indexes AS i ON vi.object_id = i.object_id AND vi.index_id = i.index_id
JOIN sys.tables  AS t ON vi.object_id = t.object_id;
```

## Estimated effort
2 sessions. (1) Bug-fix DDL template, add preview-features + engine + update-policy gating + vector column wizard + `sys.vector_indexes` browser with migrate action; (2) similarity-search runner with template + embedding input + result rendering, plus `VECTOR_DISTANCE` calculator, MAXDOP / advanced options, and the `float16` preview toggle.
