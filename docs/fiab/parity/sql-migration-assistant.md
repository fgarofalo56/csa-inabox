# sql-migration-assistant — parity with Fabric Migration Assistant / SqlPackage publish

Source UI:
- Fabric Data Warehouse Migration Assistant — https://learn.microsoft.com/fabric/data-warehouse/migration-assistant
- SqlPackage publish (DACPAC import) — https://learn.microsoft.com/sql/tools/sqlpackage/sqlpackage-publish
- Synapse dedicated SQL pool feature support — https://learn.microsoft.com/azure/synapse-analytics/sql/overview-features

Azure-native backend: the env-bound Azure Synapse **Dedicated SQL pool**
(`LOOM_SYNAPSE_WORKSPACE` + `LOOM_SYNAPSE_DEDICATED_POOL`). No Microsoft Fabric
capacity or workspace is required — works with `LOOM_DEFAULT_FABRIC_WORKSPACE`
unset. This is the Build 2026 #22 "SQL DB migration assistant" capability.

## Fabric / SqlPackage feature inventory

| # | Capability | Source |
|---|------------|--------|
| 1 | Upload / select a source database package (`.dacpac`) | SqlPackage publish |
| 2 | Read the schema model (tables, columns, indexes, views, procs, functions, schemas) | DACPAC model.xml (MS-DACPAC) |
| 3 | Compatibility assessment — flag features the target cannot host | Fabric Migration Assistant "readiness" |
| 4 | Categorize findings (blocker vs warning) with remediation guidance | Fabric Migration Assistant |
| 5 | Object inventory grid | Fabric Migration Assistant |
| 6 | Generate target-dialect DDL | Migration Assistant codegen |
| 7 | Import / publish the schema into the target | SqlPackage publish |
| 8 | Per-object import receipt (created / failed / skipped) | SqlPackage deploy report |

## Loom coverage

| # | Capability | Status | Notes |
|---|------------|:------:|-------|
| 1 | Upload `.dacpac` | ✅ | `SqlMigrationPane` file picker → `POST /api/sqldb/migration/assess` (multipart). |
| 2 | Read schema model | ✅ | Dependency-free `zip-reader.ts` (zlib) + `parseDacpac()` over `model.xml`. |
| 3 | Compatibility assessment | ✅ | `assessModel()` — unsupported types, computed/sparse columns, FK/CHECK/triggers/sequences/synonyms/UDTs, unique indexes, and view/proc T-SQL surface (cursors, FOR XML, OPENXML, OFFSET/FETCH). |
| 4 | Blocker vs warning + Learn links | ✅ | Each finding carries `severity` + `doc` (Microsoft Learn URL). |
| 5 | Object inventory grid | ✅ | `LoomDataTable` — findings + table inventory, sortable/filterable. |
| 6 | Generate DDL | ✅ | `buildDdlPlan()` — ordered schemas→tables→indexes→views→functions→procedures; CTAS-free CREATE TABLE with ROUND_ROBIN + CLUSTERED COLUMNSTORE; CREATE OR ALTER for scripted objects; blockers emitted as skipped/commented. |
| 7 | Import to target | ✅ | `POST /api/sqldb/migration/import` → `executeQuery()` over real TDS on the dedicated pool. Honest 503 gate when pool env unset. |
| 8 | Per-object receipt | ✅ | Receipt grid: created / failed (with TDS error) / skipped counts + per-object rows. Import audited to the Cosmos audit log. |

Zero ❌. Honest infra-gate (⚠️) only: import returns 503 naming
`LOOM_SYNAPSE_WORKSPACE` + `LOOM_SYNAPSE_DEDICATED_POOL` and the bicep module
when the dedicated pool is not provisioned — the full assessment UI still works
(assessment needs no backend).

## Backend per control

| Control | Backend |
|---------|---------|
| Choose `.dacpac` → assess | `POST /api/sqldb/migration/assess` — in-process `assessDacpac()` (ZIP+XML parse, no service call). |
| Import compatible schema | `POST /api/sqldb/migration/import` — `executeQuery()` (mssql/TDS, AAD token, BFF UAMI) against `dedicatedTarget()`. |
| Findings / inventory grids | Rendered from the assess response. |
| Import receipt | Rendered from the import response; each statement run independently so one failure does not abort the batch. |

## Compatibility rules (grounded in Learn)

- Unsupported data types (xml, geometry, geography, hierarchyid, sql_variant, image, text, ntext, timestamp/rowversion): https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-tables-data-types#identify-unsupported-data-types
- Unsupported table features (FK/CHECK constraints, computed/sparse columns, sequences, synonyms, triggers, unique indexes, UDTs): https://learn.microsoft.com/azure/synapse-analytics/sql/develop-tables-overview#unsupported-table-features
- Unsupported T-SQL surface (cursors, FOR XML, OPENXML, OFFSET/FETCH): https://learn.microsoft.com/azure/synapse-analytics/sql/overview-features

## Bicep sync

No new env var / resource / role. Reuses the warehouse dedicated-pool plumbing
already wired by `platform/fiab/bicep/modules/admin-plane/main.bicep`
(`LOOM_SYNAPSE_WORKSPACE`, `LOOM_SYNAPSE_DEDICATED_POOL`) and the Console UAMI's
Synapse AAD-admin grant. Pool provisioning:
`platform/fiab/bicep/modules/synapse/synapse-pool.bicep`.

## Tests

`lib/azure/__tests__/dacpac-migration.test.ts` — builds a real PKZIP DACPAC
in-memory and asserts ZIP read, model parse, assessment severities (geography
blocker, FOR XML blocker, FK warning), and DDL generation (blocked column/object
exclusion, ROUND_ROBIN distribution, CREATE OR ALTER replay).
