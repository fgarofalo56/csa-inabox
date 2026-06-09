# mirror-sql-analytics-endpoint — parity with Fabric Mirrored Database "SQL analytics endpoint"

Source UI: Microsoft Fabric Mirrored Database → auto-generated **SQL analytics
endpoint** (read-only T-SQL over the mirrored Delta), and Synapse Serverless SQL
OPENROWSET over Delta/CSV.
- https://learn.microsoft.com/fabric/mirroring/overview
- https://learn.microsoft.com/azure/synapse-analytics/sql/query-single-csv-file
- https://learn.microsoft.com/azure/synapse-analytics/sql/develop-storage-files-storage-access-control?tabs=managed-identity

In Fabric, mirroring a database automatically provisions a paired **SQL analytics
endpoint** so the mirrored tables are queryable as T-SQL the moment replication
starts. CSA Loom reproduces this **without any Fabric/OneLake dependency**: the
Azure-native mirror (ADF-CDC → ADLS Bronze) is auto-paired 1:1 with a
`synapse-serverless-sql-pool` item over the mirror's Bronze root.

## Fabric feature inventory → Loom coverage

| Fabric capability | Loom coverage | Backend per control |
|---|---|---|
| Mirroring auto-creates a paired SQL analytics endpoint | built ✅ — install pairing rule `ITEM_PAIRING_RULES['mirrored-database']` auto-creates a `synapse-serverless-sql-pool` item | `provisioning-engine.runPairingPass` → `synapseSqlPoolProvisioner` (real TDS) |
| Endpoint scoped to the mirror's data | built ✅ — per-mirror `loom_mirror_<name>` Serverless DB + external data source over `abfss://bronze@…/mirrors/<wsId>/<mirrorId>/` | `synapse-sql-client.executeQuery` (DATABASE SCOPED CREDENTIAL = Managed Identity) |
| Mirrored tables visible as queryable objects | built ✅ — one `CREATE OR ALTER VIEW [dbo].[<schema>_<table>]` per mirrored table over the table's Bronze CSV folder | OPENROWSET(BULK, DATA_SOURCE, FORMAT='CSV', HEADER_ROW=TRUE) |
| Open the endpoint from the mirror | built ✅ — "SQL analytics endpoint" toolbar button + ribbon action on the mirror editor; opens the Serverless editor at `?database=loom_mirror_<name>` with the views visible | `GET /api/items/mirrored-database/[id]/sql-endpoint` (Cosmos lookup) → `/items/synapse-serverless-sql-pool/<id>` |
| Query the mirrored tables (SELECT TOP N) | built ✅ — Serverless editor object explorer + Monaco SQL grid; `SELECT TOP 10 * FROM [dbo].[<view>]` returns live Bronze rows | `synapse-serverless-sql-pool/[id]/query` (real TDS) |
| Sovereign-cloud correctness (Comm + Gov) | built ✅ — abfss root from `LOOM_BRONZE_URL` (`resolveAbfssRoot`) + endpoint suffix from `getSynapseSqlSuffix()`; cloud-matrix test covers Comm + Gov | `cloud-endpoints.synapseSqlSuffix` |
| Endpoint when storage/Synapse not provisioned | honest-gate ⚠️ — no `adlsRoot` (Fabric backend / `LOOM_BRONZE_URL` unset) ⇒ pairing skips; no Synapse workspace ⇒ provisioner returns a precise remediation; editor shows "Install the mirror to provision it" | — |

Zero ❌, zero stub banners.

## No-Fabric-dependency

The pairing only fires on the Azure-native ADF-CDC backend (the default). The
opt-in Fabric backend emits no `adlsRoot`, so `deriveContent` returns `null` and
no pairing is attempted — the SQL analytics endpoint is 100% Azure-native
(Synapse Serverless over ADLS Gen2 Bronze), reachable with
`LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET.

## Bicep sync

The Synapse workspace MSI already holds **Storage Blob Data Contributor** on the
DLZ ADLS account (`landing-zone/synapse-storage-rbac.bicep`) where mirror Bronze
lands — so the Serverless `WorkspaceIdentity` credential can OPENROWSET the
mirrored CSV with no extra grant in the common single-DLZ topology. For a
split-DLZ topology (separate mirror Bronze account), the new optional
`mirrorBronzeStorageAccountName` param grants the Synapse MSI Storage Blob Data
Reader on that account.

## Verification

- `tsc --noEmit` clean on touched files.
- `lib/azure/__tests__/mirror-sql-endpoint.test.ts` — cloud-matrix (Comm + Gov
  abfss root + Synapse suffix) + pairing `deriveContent` normalization. 9 green.
- Live receipt (Fabric UNSET): install a mirror → paired
  `synapse-serverless-sql-pool` auto-created → open "SQL analytics endpoint" →
  `SELECT TOP 10 * FROM [dbo].[dbo_<table>]` returns live Bronze rows.
