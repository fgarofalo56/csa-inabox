# stats-maintenance — parity with the Fabric Warehouse "Statistics" + Lakehouse "Maintenance" surfaces

Source UI:
- Fabric Warehouse statistics (CREATE/UPDATE/DROP STATISTICS): https://learn.microsoft.com/fabric/data-warehouse/statistics
- Fabric Lakehouse table maintenance (OPTIMIZE / V-Order / VACUUM): https://learn.microsoft.com/fabric/data-engineering/lakehouse-table-maintenance
- Azure Synapse Dedicated SQL pool statistics: https://learn.microsoft.com/azure/synapse-analytics/sql/develop-tables-statistics
- Databricks ANALYZE TABLE / OPTIMIZE / ZORDER: https://learn.microsoft.com/azure/databricks/sql/language-manual/sql-ref-syntax-aux-analyze-table , https://learn.microsoft.com/azure/databricks/delta/optimize

Azure-native, NO Microsoft Fabric. Two engines, the canonical Azure backends per
`no-fabric-dependency.md`:

| Loom engine (item type)       | Azure-native backend                | Client                          |
|-------------------------------|-------------------------------------|---------------------------------|
| `warehouse` / `synapse-dedicated-sql-pool` | Synapse Dedicated SQL pool (TDS)    | `synapse-sql-client`            |
| `databricks-sql-warehouse`    | Databricks SQL Warehouse (Statement API) + ADLS Gen2 | `databricks-client`, `adls-client` |

## Fabric/Azure feature inventory

### Statistics manager (Warehouse-family)
1. List user-created statistics on a table (name, columns, last-updated). — `sys.stats`
2. Create statistics over one or more columns, with a scan mode (default / FULLSCAN / SAMPLE n%).
3. Update (refresh) a single statistics object, or all on the table.
4. Drop a statistics object.
5. Pick columns from the table's real schema (no free-form entry).

### Maintenance (Lakehouse / Delta-family)
6. OPTIMIZE — bin-pack small Parquet files into larger ones.
7. ZORDER BY columns — multi-dimensional clustering for data-skipping.
8. ANALYZE / COMPUTE STATISTICS after compaction (optimizer refresh).
9. V-Order — Fabric write-time Parquet encoding.
10. File-count proof that compaction occurred (before/after).

## Loom coverage

| # | Capability | Status | Backend per control |
|---|------------|--------|---------------------|
| 1 | List statistics | ✅ | `GET .../[type]/[id]/statistics` → `buildSynapseListStatisticsSQL` → `executeQuery(dedicatedTarget())` (`sys.stats`) |
| 2 | Create statistics (+ scan mode) | ✅ | `POST … {action:'create'}` → `buildSynapseCreateStatisticsSQL` → `executeQuery` |
| 3 | Update statistics (one / all) | ✅ | `POST … {action:'update'}` → `buildSynapseUpdateStatisticsSQL` → `executeQuery` |
| 4 | Drop statistics | ✅ | `POST … {action:'drop'}` → `buildSynapseDropStatisticsSQL` → `executeQuery` |
| 5 | Column picker from real schema | ✅ | `buildSynapseListColumnsSQL` (`sys.columns`); editor DDL columns as fallback |
| 6 | OPTIMIZE (Databricks) | ✅ | `POST .../[type]/[id]/optimize` → `buildDatabricksOptimizeSQL` → `executeStatement` |
| 7 | ZORDER BY columns | ✅ | same — `OPTIMIZE … ZORDER BY (…)` |
| 8 | ANALYZE (Databricks) | ✅ | `POST … {action:'analyze'}` / `analyzeAfter:true` → `buildDatabricksAnalyzeSQL` → `executeStatement` |
| 9 | V-Order | ⚠️ honest-gate | Disabled `Switch` + `intent='warning'` MessageBar — Fabric Spark only, no Azure 1:1. Never POSTed. |
| 10 | File-count proof | ✅ | `countParquetFiles(container, storagePrefix)` (`adls-client`) before & after; receipt shows `filesBefore → filesAfter`. Databricks OPTIMIZE metrics also returned. |
| — | OPTIMIZE on Synapse Dedicated | ⚠️ honest-gate | columnstore (not Delta) → `code:'not_applicable'`; UI points to UPDATE STATISTICS / ALTER INDEX REBUILD |

Zero ❌, zero stub banners. The two ⚠️ rows are honest gates (V-Order has no Azure
1:1; OPTIMIZE genuinely does not apply to a columnstore pool) — both render the
full surface with a precise MessageBar, per `no-vaporware.md` / `ui-parity.md`.

## Backend / infra

- Synapse path: `LOOM_SYNAPSE_WORKSPACE` + `LOOM_SYNAPSE_DEDICATED_POOL` (existing). Console UAMI is Synapse AAD admin (TDS).
- Databricks path: `LOOM_DATABRICKS_HOSTNAME` (existing). The Databricks **Access Connector** system-assigned MI is granted **Storage Blob Data Contributor** on the lakehouse ADLS account by `platform/fiab/bicep/modules/landing-zone/databricks-storage-rbac.bicep` (wired in `landing-zone/main.bicep`) so OPTIMIZE can rewrite compacted Parquet + update `_delta_log`. UC-only (Commercial + GCC); skipped on GCC-High / IL5 where the grant no-ops.
- ADLS file-count: `countParquetFiles` uses the cloud-aware DFS suffix (`cloud-endpoints.dfsSuffix()`).

## Injection safety

The client never sends raw SQL — it sends a structured action + identifiers; all
SQL is built by `lib/azure/statistics-client.ts`, which validates every
identifier against `IDENT_RE` before bracket-/backtick-quoting. Covered by
`lib/azure/__tests__/statistics-client.test.ts` (26 tests incl. injection
attempts + a cloud-matrix invariance block).

## Verification

- `npx vitest run lib/azure/__tests__/statistics-client.test.ts` → 26 green.
- `tsc --noEmit` clean on all touched files.
- Live (operator): with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET — CREATE STATISTICS
  persists + appears in the list; OPTIMIZE on a fragmented Delta table drops the
  ADLS Parquet file count (filesBefore → filesAfter in the receipt); V-Order shows
  the honest MessageBar.
