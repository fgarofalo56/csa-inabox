# mirrored-database-wizard — parity with Fabric "New mirrored database" + multi-source connectors

**Surface:** the CSA Loom **New / Edit mirrored database** wizard
(`apps/fiab-console/lib/editors/components/mirror-source-wizard.tsx`) inside the
Mirrored Database editor. The Loom analogue of the Fabric portal
**Create → Mirrored database → Choose a source → New connection → Choose
databases/tables → Connect** onboarding flow, and the Azure portal's
linked-service + table-selection experience.

Source UI (grounded in Microsoft Learn):
- Mirroring source picker (Azure SQL DB/MI, SQL Server, Snowflake, Cosmos DB, PostgreSQL) — https://learn.microsoft.com/fabric/mirroring/overview
- Create + connect + select tables (Azure SQL) — https://learn.microsoft.com/fabric/mirroring/azure-sql-database-tutorial
- Connection with Key Vault-stored credentials — https://learn.microsoft.com/fabric/data-factory/how-to-use-azure-key-vault-secrets-pipeline-activities
- ADF Change Data Capture (the no-Fabric backend) — https://learn.microsoft.com/azure/data-factory/concepts-change-data-capture-resource

## Azure/Fabric feature inventory → Loom coverage

| Capability (Fabric/Azure)                                    | Loom coverage | Backend per control |
|--------------------------------------------------------------|---------------|---------------------|
| Pick a source type from a gallery of connectors              | ✅ built (8 source cards) | client state |
| Create/select a connection (no plaintext creds)              | ✅ built (ConnectionBuilder + dropdown) | `/api/connections` → Key Vault secretRef |
| Server / database coordinates                                | ✅ built (fields, prefilled from connection) | item state (Cosmos) |
| Test connectivity before create                              | ✅ built (Verify) | `/api/items/mirrored-database/verify` (real TDS probe) |
| Enumerate source tables                                      | ✅ built (Load tables) | `/[id]/tables` (credential-aware, KV secretRef) + `/source-tables` (pre-create) |
| Include/exclude a subset of tables                           | ✅ built (checkbox grid + All/None) | persisted to `state.tables` |
| **Include Iceberg tables** (Snowflake only, Fabric Build 2026)| ✅ built (Snowflake-only checkbox in step 3) | persisted to `state.includeIcebergTables` + `mirroring.json` source.typeProperties.includeIcebergTables; threaded into the engine `MirrorSource` on Start |
| Name + review before create                                  | ✅ built (step 4 summary) | POST/PATCH `/api/items/mirrored-database[/id]` |
| Edit an existing mirror's source/tables                      | ✅ built (Edit → same wizard) | PATCH `/[id]` |
| Multi-source binding surface                                 | ✅ built (GET/POST `/[id]/sources`) | item state |
| Start replication → initial load + CDC                       | ✅ built (Start) | ADF CDC → Bronze **Delta** (opt-in) or built-in CSV snapshot engine — both Azure-native |
| Monitor per-table replication (rows/bytes/last sync)         | ✅ built (replication grid) | `state.tablesStatus` |
| Snowflake / Open-mirroring continuous CDC                    | ⚠️ honest-gate | engine returns a disclosed follow-up gate (`no-vaporware.md`) |

## Backend wiring

- **Credentials** are stored only as a Key Vault `secretRef` on a Loom Connection
  (`connections-store.ts`); the per-item `tables` route resolves the secret server-side
  via `getKeyVaultSecretValue` and never returns/stores it in plaintext.
- **Start** dispatches to **ADF ChangeDataCapture** (`adfcdcs` ARM resource) landing
  Delta in ADLS Bronze when `LOOM_ADF_NAME` + `LOOM_MIRROR_SOURCE_LINKED_SERVICE` +
  `LOOM_MIRROR_ADLS_LINKED_SERVICE` are set; otherwise the built-in TDS/PG/Cosmos →
  CSV-in-Bronze engine runs. **No Microsoft Fabric** on either path
  (`no-fabric-dependency.md`).
- **Bicep:** Console UAMI granted Storage Blob Data Contributor on the lakehouse SA
  (`synapse-storage-rbac.bicep`, default-on for the CSV engine writes); ADF system MI
  already has Storage Blob Data Contributor (`adf.bicep`) for the Delta writes; Key
  Vault Secrets Officer already granted (`keyvault.bicep`). New opt-in env vars wired
  in `admin-plane/main.bicep`.

## Verification

`pnpm tsc --noEmit` clean on all touched files. Vitest
`lib/azure/__tests__/mirror-adf-cdc.test.ts` (5 tests, **green**) locks the CDC spec
shape (source entities = selected tables, AzureBlobFS Delta sink, per-table Bronze
folder) and the honest gates. The test mocks every Azure-SDK-importing module of
mirror-engine, so it runs even though the worktree's shared pnpm store is currently
missing `@adobe/css-tools` / `@azure/abort-controller` (documented store corruption
from parallel agents) that breaks the global jest-dom setup file used by render
suites. Live E2E receipt (ADF run id + ABFS Delta listing) to be attached by the
operator against a real Azure SQL source.
