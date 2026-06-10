# mirrored-database-wizard — parity with Fabric "New mirrored database" + multi-source connectors

**Surface:** the CSA Loom **New / Edit mirrored database** wizard
(`apps/fiab-console/lib/editors/components/mirror-source-wizard.tsx`) inside the
Mirrored Database editor. The Loom analogue of the Fabric portal
**Create → Mirrored database → Choose a source → New connection → Choose
databases/tables → Connect** onboarding flow, and the Azure portal's
linked-service + table-selection experience.

Source UI (grounded in Microsoft Learn):
- Mirroring source picker (Azure SQL DB/MI, SQL Server, Snowflake, Cosmos DB, PostgreSQL, BigQuery, Oracle) — https://learn.microsoft.com/fabric/mirroring/overview
- Create + connect + select tables (Azure SQL) — https://learn.microsoft.com/fabric/mirroring/azure-sql-database-tutorial
- Mirrored Google BigQuery — service-account email + JSON key + project/dataset — https://learn.microsoft.com/fabric/mirroring/google-bigquery-tutorial
- Mirrored Oracle — TNS/connect-descriptor server + basic auth (user/password) via OPDG — https://learn.microsoft.com/fabric/mirroring/oracle-tutorial
- Connection with Key Vault-stored credentials — https://learn.microsoft.com/fabric/data-factory/how-to-use-azure-key-vault-secrets-pipeline-activities
- ADF Change Data Capture (the no-Fabric backend) — https://learn.microsoft.com/azure/data-factory/concepts-change-data-capture-resource

## Azure/Fabric feature inventory → Loom coverage

| Capability (Fabric/Azure)                                    | Loom coverage | Backend per control |
|--------------------------------------------------------------|---------------|---------------------|
| Pick a source type from a gallery of connectors              | ✅ built (10 source cards incl. BigQuery + Oracle) | client state |
| Create/select a connection (no plaintext creds)              | ✅ built (ConnectionBuilder + dropdown) | `/api/connections` → Key Vault secretRef |
| Server / database coordinates                                | ✅ built (source-aware labels, prefilled from connection) | item state (Cosmos) |
| BigQuery connection — project id + service-account email + JSON key | ✅ built (ConnectionBuilder `bigquery` type, `service-account-key` auth → KV) | `/api/connections` |
| Oracle connection — TNS/connect-descriptor + basic auth (user/password) + OPDG gateway | ✅ built (ConnectionBuilder `oracle` type, `sql-password` auth → KV) | `/api/connections` |
| Private cross-cloud source via data gateway (OPDG/VNet)      | ⚠️ honest-gate (`LOOM_MIRROR_GATEWAY` field + env var) | bicep `loomMirrorGateway` |
| Test connectivity before create                              | ✅ built (Verify) | `/api/items/mirrored-database/verify` (real TDS probe) |
| Enumerate source tables                                      | ✅ built (Load tables) | `/[id]/tables` (credential-aware, KV secretRef) + `/source-tables` (pre-create) |
| Include/exclude a subset of tables                           | ✅ built (checkbox grid + All/None) | persisted to `state.tables` |
| Name + review before create                                  | ✅ built (step 4 summary) | POST/PATCH `/api/items/mirrored-database[/id]` |
| Edit an existing mirror's source/tables                      | ✅ built (Edit → same wizard) | PATCH `/[id]` |
| Multi-source binding surface                                 | ✅ built (GET/POST `/[id]/sources`) | item state |
| Start replication → initial load + CDC                       | ✅ built (Start) | ADF CDC → Bronze **Delta** (opt-in) or built-in CSV snapshot engine — both Azure-native |
| Monitor per-table replication (rows/bytes/last sync)         | ✅ built (replication grid) | `state.tablesStatus` |
| Snowflake / Open-mirroring continuous CDC                    | ⚠️ honest-gate | engine returns a disclosed follow-up gate (`no-vaporware.md`) |
| BigQuery / Oracle continuous CDC engine                      | ⚠️ honest-gate | source authenticates via its own credential + gateway; copy runtime is the disclosed follow-up (Verify returns a precise source-specific note; Start gates with the gateway/credential requirement) |

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
  in `admin-plane/main.bicep` — including `LOOM_MIRROR_GATEWAY` (param `loomMirrorGateway`,
  default empty) naming the OPDG/VNet data gateway that reaches private BigQuery
  projects / Oracle servers. Empty = no gateway (honest gate, not a Fabric requirement).
- **BigQuery / Oracle credentials:** a `bigquery` connection stores the GCP project id +
  service-account email (non-secret) and the service-account JSON key in Key Vault
  (`service-account-key` auth); an `oracle` connection stores the TNS/connect-descriptor
  server + username (non-secret) and the password in Key Vault (`sql-password` auth).
  Both carry the optional `gateway` name. No Microsoft Fabric / Power BI workspace.

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
