# datamart — parity with Power BI Datamart (DEPRECATED → Azure-native migration)

Source UI: Power BI datamart (deprecated) —
https://learn.microsoft.com/power-bi/transform-model/datamarts/datamarts-overview
(Microsoft has deprecated datamarts; the recommended replacement is a database
+ semantic model.)

Azure-native replacement (no Fabric / Power BI capacity required):
- Storage / SQL surface → **Azure Synapse Serverless SQL** user database
  (`CREATE DATABASE [loom_dm_<name>]`, OPENROWSET / external tables).
- Semantic model → **Azure Analysis Services** tabular server
  (Microsoft.AnalysisServices/servers, ARM 2017-08-01; XMLA model deploy).

This is a **deprecated, migration-only** item type. The definition of "done"
here is NOT a full authoring surface (datamarts can no longer be authored) — it
is: (1) an honest deprecation banner on every datamart, (2) a working migration
to real Azure backends, and (3) no create path anywhere.

## Power BI datamart capability inventory  (grounded in Learn)

| # | Datamart capability (legacy) | Disposition under deprecation |
|---|------------------------------|-------------------------------|
| 1 | Create a new datamart | **Removed** — datamarts are deprecated; no create path (parity = no create). |
| 2 | Ingest/transform data (dataflow-style) | Superseded by Synapse pipeline / dataflow editors (separate Loom items). |
| 3 | Auto-provisioned Azure SQL store + queryable SQL endpoint | **Migrated to** Synapse Serverless database (always-on SQL endpoint). |
| 4 | Auto-generated semantic model | **Migrated to** Azure Analysis Services tabular server. |
| 5 | Connect Power BI / SQL clients to the endpoint | Reconnect to the Synapse Serverless SQL endpoint or the AAS XMLA endpoint (URIs in the migration receipt). |
| 6 | Manage / view the datamart item | Loom shows the item with a deprecation banner + migration status. |

## Loom coverage

| Capability | Status | Notes |
|------------|--------|-------|
| Deprecation banner on every datamart | ✅ built | Fluent `MessageBar intent="warning"`: "Datamarts are deprecated. Migrate to a Synapse Serverless warehouse + semantic model." Always rendered. |
| No create path | ✅ built | `deprecated:true` filters the type out of the New item dialog; the editor's `id==='new'` renders an error MessageBar (no authoring surface, no enabled create button). |
| Migrate action | ✅ built | Ribbon button + banner button → `POST /api/items/datamart/migrate`. |
| Provision Synapse Serverless DB | ✅ built | `CREATE DATABASE [loom_dm_<name>]` (IF NOT EXISTS) over TDS+AAD on the env-bound Serverless endpoint. |
| Provision AAS semantic-model server | ✅ built | ARM PUT `Microsoft.AnalysisServices/servers` via the Console UAMI. |
| Migration receipt (DB, server, connection URI, state) | ✅ built | Returned by the route and persisted to `state.migration`; surfaced as a success MessageBar (fresh + persisted). |
| Idempotency | ✅ built | Short-circuits when `state.migration.status==='migrated'`; CREATE DATABASE guarded; ARM PUT is no-op when the server exists. |
| Synapse not configured | ⚠️ honest gate | 503 + MessageBar naming `LOOM_SYNAPSE_WORKSPACE`. |
| AAS not configured | ⚠️ honest gate | 503 + MessageBar naming `LOOM_SUBSCRIPTION_ID` / `LOOM_AAS_RG`. |
| AAS data-plane model deploy (XMLA) | ⚠️ documented | Tabular model is deployed via SSDT/SSMS against the AAS XMLA endpoint (connection URI in the receipt); outside Loom's BFF scope, surfaced in Learn steps + `aasAdminWarning` when the admin SP id is unset. |

Zero ❌, zero stub banners. The only non-built rows are honest infra/admin gates.

## Backend per control

| Control | Backend |
|---------|---------|
| Deprecation banner | static (no backend) |
| Migrate (Synapse DB) | `executeQuery(serverlessTarget('master'), 'CREATE DATABASE …')` — TDS + AAD (`synapse-sql-client`) |
| Migrate (AAS server) | `provisionAasServer()` → ARM PUT `Microsoft.AnalysisServices/servers@2017-08-01` (`aas-client`) |
| Receipt persistence | `updateOwnedItem('datamart', …, { state.migration })` — Cosmos (`item-crud`) |
| Editor detail load | `GET /api/cosmos-items/datamart/<id>` — Cosmos |

## Cloud matrix (all endpoints from `cloud-endpoints.ts` — no literals)

| Aspect | Commercial / GCC | GCC-High / IL5 | DoD |
|--------|------------------|----------------|-----|
| ARM host (`armBase()`) | management.azure.com | management.usgovcloudapi.net | management.azure.microsoft.scloud |
| AAS suffix (`aasSuffix()`) | asazure.windows.net | asazure.usgovcloudapi.net | asazure.usgovcloudapi.net |
| Synapse Serverless suffix | sql.azuresynapse.net | sql.azuresynapse.usgovcloudapi.net | sql.azuresynapse.usgovcloudapi.net |

## No-Fabric / no-vaporware compliance

- Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET — neither Synapse Serverless
  nor AAS touches `api.fabric.microsoft.com` / `api.powerbi.com`.
- `ok:true` is returned only after both the `CREATE DATABASE` and the ARM PUT
  succeed; partial/unconfigured states return distinct error codes
  (`SYNAPSE_NOT_CONFIGURED`, `SYNAPSE_DB_ERROR`, `AAS_NOT_CONFIGURED`,
  `AAS_PROVISION_ERROR`) — no faked receipt.

## Bicep sync

- `platform/fiab/bicep/modules/landing-zone/aas.bicep` deploys the AAS server +
  Console-UAMI Contributor grant; wired into `landing-zone/main.bicep` under
  `deployAas` (default true).
- `LOOM_AAS_RG` env var added to the console app (→ DLZ RG, where aas.bicep
  deploys); `LOOM_UAMI_CLIENT_ID` + `AZURE_TENANT_ID` (already wired) supply the
  AAS admin SP identifier.

## Tests

`apps/fiab-console/lib/azure/__tests__/aas-client-datamart.test.ts` — 11 tests:
server-name sanitizer (ARM rules), SKU→tier mapping, DB-name sanitizer, and the
AAS suffix / connection-URI cloud matrix (Commercial / GCC-High / DoD + override).
