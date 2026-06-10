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
| **Snowflake: "Mirror all managed and Iceberg tables" vs "only managed"** | ✅ built (Snowflake-only "Include Iceberg tables" Switch in step 3) | persisted to `state.snowflake.includeIceberg` |
| **Snowflake: storage connection for Iceberg tables** | ✅ built (Iceberg storage URL field, required when Iceberg on) | `state.snowflake.icebergStorageUrl` (normalized to abfss, sovereign-aware) |
| **Snowflake: pick which Iceberg tables to expose** | ✅ built (per-row Iceberg checkbox column) | `state.snowflake.icebergTables[]` |
| Name + review before create                                  | ✅ built (step 4 summary incl. Iceberg state) | POST/PATCH `/api/items/mirrored-database[/id]` |
| Edit an existing mirror's source/tables                      | ✅ built (Edit → same wizard, Iceberg prefilled) | PATCH `/[id]` |
| Multi-source binding surface                                 | ✅ built (GET/POST `/[id]/sources`) | item state |
| Start replication → initial load + CDC                       | ✅ built (Start) | ADF CDC → Bronze **Delta** (opt-in) or built-in CSV snapshot engine — both Azure-native |
| Start → Snowflake Iceberg tables read in place               | ✅ built (Start, Iceberg branch) | `registerSnowflakeIceberg` → Synapse Serverless `OPENROWSET(FORMAT='DELTA')` over external storage — no copy, 1:1 with Fabric shortcut + Iceberg→Delta virtualization |
| Monitor per-table replication (rows/bytes/last sync)         | ✅ built (replication grid; Iceberg rows badged) | `state.tablesStatus` |
| Snowflake managed-table continuous CDC                       | ⚠️ honest-gate | disclosed follow-up gate for *managed* tables (Iceberg tables are fully functional now) (`no-vaporware.md`) |
| Open-mirroring continuous CDC                                | ⚠️ honest-gate | engine returns a disclosed follow-up gate (`no-vaporware.md`) |

### Snowflake Iceberg parity note

Fabric's Snowflake "Configure mirroring" screen offers, under **Mirror all data**,
the choice to mirror **all managed and Iceberg tables** or **only managed tables
(skipping Iceberg)**; when Iceberg is included it requires **one storage connection**
to the external storage that holds the Iceberg data
(https://learn.microsoft.com/fabric/mirroring/snowflake-tutorial#start-mirroring-process).
Fabric handles Iceberg by creating a **OneLake shortcut** to that storage and using
**metadata virtualization** to read the Iceberg table as Delta
(https://learn.microsoft.com/fabric/onelake/onelake-iceberg-tables).

Loom reproduces this 1:1 with **no Fabric and no OneLake**: the wizard exposes the
same "Include Iceberg tables" toggle + the one storage connection (Iceberg storage
URL). On Start, `registerSnowflakeIceberg` registers each selected Iceberg table as a
Synapse Serverless `OPENROWSET(..., FORMAT='DELTA')` accessor directly over the
customer's external ADLS Gen2 storage — **zero data movement** (the same in-place
read Fabric's shortcut gives). Snowflake *managed* tables remain an honest follow-up
gate (their own copy runtime), exactly as the rest of the engine discloses for
own-runtime sources. No new env var or bicep resource is required — the Iceberg
storage URL is per-mirror config captured in the wizard.

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
