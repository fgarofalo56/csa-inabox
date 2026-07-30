// CSA Loom — N8 lab 1: the DuckLake catalog metadata store (DEFAULT-ON).
//
// Backs LOOM_DUCKLAKE_CATALOG_URL. DuckLake (https://ducklake.select, Apache-2.0)
// keeps lakehouse table metadata in a **SQL database** instead of a metadata-file
// tree; the N2 DuckDB serving tier `ATTACH`es it and reads the Delta/Parquet data
// IN PLACE on the deployment's own ADLS Gen2. This module is that SQL database:
// an Azure Database for PostgreSQL Flexible Server, private-endpoint only.
//
// WHY THIS EXISTS (loom_default_on_opt_out — .claude/rules): until now
// `svc-ducklake-catalog` was documented as "operator-provided … not
// bicep-emitted", i.e. a day-one gate the operator had to close by hand. That is
// exactly the opt-IN posture the default-ON rule forbids. This module makes the
// store a first-class, deployed-by-default resource so a FRESH push-button
// deploy into an empty subscription lights the gate with no manual step.
//
// ── DEDICATED SERVER, NOT A DATABASE ON A SHARED ONE (deliberate) ────────────
// The obvious cheaper option is a second database on the Airflow metadata server
// (admin-plane/airflow.bicep). Rejected, on two grounds:
//
//   1. BLAST RADIUS / CREDENTIALS. That server is password-auth with ONE
//      administrator login and no per-database role separation (bicep cannot
//      create a Postgres role — that needs a bootstrap script). Sharing it would
//      hand the DuckLake DSN full rights over Airflow's control-plane metadata.
//   2. BURST CREDITS. Both are B-series (burstable) servers: CPU is a credit
//      budget, not a reservation. DuckLake is a USER-driven metadata workload
//      (every catalog browse/ATTACH is a query burst); Airflow's DB is the
//      scheduler's heartbeat. Co-tenanting them means a catalog scan storm can
//      exhaust the credit balance and silently stall DAG scheduling.
//
// The isolation costs one B1ms (see COST below). It is worth it.
//
// ── AUTH POSTURE ────────────────────────────────────────────────────────────
//   * Entra auth is ENABLED and the Console UAMI is set as the Entra
//     administrator, so operator/BFF paths can connect token-only.
//   * Password auth is ALSO enabled for exactly one consumer: the DuckDB
//     engine's `ATTACH 'ducklake:postgres:<dsn>'`, which hands the DSN to libpq.
//     libpq presents a static credential at connect time and the long-lived
//     engine process cannot refresh an Entra token mid-session, so a token DSN
//     would break the moment it expired. This is the same reason
//     admin-plane/airflow.bicep uses password auth for SQLAlchemy.
//   * The password is UNPREDICTABLE (derived by the orchestrator from
//     loomGeneratedSecretSeed = newGuid(), never guid(rg.id, <public-const>)),
//     is marked @secure() so it never lands in deployment output, and the
//     assembled connection string is written to the Loom **Key Vault**. The
//     Console binds it as a Key Vault `secretRef` — it is NEVER a plain env var.
//
// ── NETWORK POSTURE ─────────────────────────────────────────────────────────
//   * `network.publicNetworkAccess = 'Disabled'` — the server has no public
//     endpoint at all; firewall rules are not even evaluated.
//   * A private endpoint in the caller's VNet + a `privatelink.postgres.*`
//     private DNS zone (sovereign suffix derived per cloud, never hard-coded),
//     so the in-VNet DuckDB Container App resolves the server privately.
//   * Diagnostics to the Loom Log Analytics workspace.
// Mirrors data-plane/loom-unity-postgres.bicep (LU-1) exactly; the ONLY
// deviation is passwordAuth, justified above.
//
// ── COST (idle, per cloud) ──────────────────────────────────────────────────
//   Standard_B1ms (1 vCore / 2 GiB, Burstable) ≈ $12–13/mo compute
// + 32 GiB storage                            ≈ $3–4/mo
// + PITR backup within the retention window   = included (no extra charge up to
//                                               100% of provisioned storage)
//   ≈ **$16/mo per cloud, ≈ $32/mo across Commercial + Gov.** B1ms is the
//   smallest flexible-server SKU Azure offers; a catalog metadata store is a
//   low-QPS, small-row workload, so this is the minimum viable size, not a
//   compromise. There is no scale-to-zero tier for PostgreSQL Flexible Server
//   (auto-stop exists only for the single-server retired SKU), so this is a
//   real, disclosed floor — the honest cost of removing the gate.
//
// Azure-native / OSS only. The metadata store is in-boundary Postgres and the
// engine is the in-boundary DuckDB container: no SaaS catalog is in the path, so
// the lab runs disconnected in an air-gapped enclave. No Microsoft Fabric, no
// OneLake, no Power BI (.claude/rules/no-fabric-dependency.md).

targetScope = 'resourceGroup'

@description('Deployment region (e.g. usgovvirginia / centralus).')
param location string = resourceGroup().location

@description('Flexible-server name. Default derives a deterministic, globally-unique name from the resource group.')
@maxLength(63)
param name string = take('psql-loom-ducklake-${uniqueString(resourceGroup().id)}', 63)

@description('Catalog database name DuckLake persists its lakehouse table metadata in. Must match the /<db> segment of LOOM_DUCKLAKE_CATALOG_URL.')
param databaseName string = 'ducklake'

@description('PostgreSQL major version.')
@allowed([
  '15'
  '16'
])
param postgresVersion string = '16'

@description('Flexible-server SKU name. Standard_B1ms (1 vCore / 2 GiB) is the SMALLEST size Azure offers and is the right one for a metadata catalog — see the COST block in the header.')
param skuName string = 'Standard_B1ms'

@description('Compute tier for the SKU. Burstable cannot do zone-redundant HA — pick GeneralPurpose when haMode is set.')
@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param tier string = 'Burstable'

@description('Storage size in GB. DuckLake stores table/snapshot metadata only (the data files live on ADLS) — 32 GB is generous.')
@allowed([
  32
  64
  128
  256
  512
])
param storageSizeGB int = 32

@description('Point-in-time-restore retention window in days (7-35).')
@minValue(7)
@maxValue(35)
param backupRetentionDays int = 14

@description('Geo-redundant backup. Leave Disabled in sovereign boundaries with a single paired-region policy.')
@allowed([
  'Enabled'
  'Disabled'
])
param geoRedundantBackup string = 'Disabled'

@description('High-availability mode. ZoneRedundant requires a GeneralPurpose/MemoryOptimized tier AND a region with availability zones; Disabled (default) still gives PITR + automated backups.')
@allowed([
  'Disabled'
  'SameZone'
  'ZoneRedundant'
])
param haMode string = 'Disabled'

@description('PostgreSQL administrator login used by the DuckDB engine\'s libpq DSN. Not an Entra principal — see the AUTH POSTURE block in the header for why a static credential is unavoidable on this one hop.')
param administratorLogin string = 'loomducklake'

@description('Administrator password. UNPREDICTABLE — derived by the orchestrator from loomGeneratedSecretSeed (newGuid()), NEVER guid(rg.id, <public-const>). @secure() so it never lands in deployment output/logs, and it leaves this module only inside the Key Vault secret below.')
@secure()
param administratorPassword string

@description('Resource id of the subnet the PRIVATE ENDPOINT is injected into — normally the Loom hub private-endpoint subnet, in (or peered to) the VNet the Container Apps environment is integrated with. REQUIRED: `publicNetworkAccess` is hard-wired to Disabled, so without a private endpoint nothing can reach the server at all.')
param privateEndpointSubnetId string

@description('Existing privatelink.postgres.database.<suffix> private DNS zone resource id. EMPTY (default) => this module CREATES the zone and links it to the VNet that owns privateEndpointSubnetId, so a from-scratch deploy resolves the server privately with no hub prerequisite. Pass an id when the hub already owns the zone.')
param privateDnsZoneId string = ''

@description('Additional VNet resource ids to link to the private DNS zone (only used when this module creates the zone) — e.g. a separate Container Apps VNet peered to the private-endpoint VNet.')
param additionalDnsVnetIds array = []

@description('Principal (object) id of the Console UAMI. Set as the Entra ADMINISTRATOR of the server so operator/BFF paths can connect token-only. Empty => no Entra administrator is set (the server still accepts the password login above).')
param entraAdminPrincipalId string = ''

@description('Display name of that identity — this is the PostgreSQL role name the server maps an Entra token to.')
param entraAdminPrincipalName string = 'uami-loom-console'

@description('Tenant id for the Entra administrator.')
param tenantId string = tenant().tenantId

@description('Loom Key Vault resource id. The assembled postgresql:// connection string is written there as `catalogUrlSecretName` and the Console binds it via a Key Vault secretRef — never a plain env var. Empty => no secret is written (the caller must wire the DSN itself).')
param keyVaultId string = ''

@description('Key Vault secret name holding the DuckLake connection string.')
param catalogUrlSecretName string = 'loom-ducklake-catalog-url'

@description('Log Analytics workspace resource id for diagnostic settings. Empty => no diagnostic settings.')
param workspaceId string = ''

@description('Compliance/cost tags.')
param complianceTags object = {}

// ── Sovereign-safe naming ───────────────────────────────────────────────────
// The Postgres data-plane suffix differs per cloud and so does the private-link
// zone name. environment().suffixes.sqlServerHostname is the ARM-provided
// per-cloud SQL/DB hostname suffix ('.database.windows.net' /
// '.database.usgovcloudapi.net'); the flexible-server privatelink zone is
// 'privatelink.postgres' + that same suffix. Nothing hard-coded on a code path
// (identical derivation to data-plane/loom-unity-postgres.bicep).
var sqlHostSuffix = environment().suffixes.sqlServerHostname
var privateDnsZoneName = 'privatelink.postgres${sqlHostSuffix}'

// VNet that owns the private-endpoint subnet:
//   /subscriptions/S/resourceGroups/RG/providers/Microsoft.Network/virtualNetworks/V/subnets/SUB
// split('/') keeps everything through the VNet name at index 8 → take(...,9).
var peVnetId = join(take(split(privateEndpointSubnetId, '/'), 9), '/')
var createDnsZone = empty(privateDnsZoneId)
var dnsVnetIds = union([peVnetId], additionalDnsVnetIds)
var tags = union(complianceTags, { 'loom-band': 'data-plane', 'loom-item': 'ducklake-catalog' })

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: tier
  }
  properties: {
    version: postgresVersion
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorPassword
    storage: {
      storageSizeGB: storageSizeGB
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: geoRedundantBackup
    }
    // BOTH auth modes on purpose. Entra for humans/BFF; password for the ONE
    // libpq hop (DuckDB ATTACH) that cannot refresh a token — see the header.
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Enabled'
      tenantId: tenantId
    }
    // NO public endpoint. Reachable only through the private endpoint below.
    network: {
      publicNetworkAccess: 'Disabled'
    }
    highAvailability: {
      mode: haMode
    }
  }
}

// Entra administrator = the Console UAMI. `principalName` is the PostgreSQL role
// name the server maps the token to.
resource pgEntraAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = if (!empty(entraAdminPrincipalId)) {
  parent: pg
  name: entraAdminPrincipalId
  properties: {
    principalName: entraAdminPrincipalName
    principalType: 'ServicePrincipal'
    tenantId: tenantId
  }
}

resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// ── Private connectivity ────────────────────────────────────────────────────
resource pe 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${name}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'loom-ducklake-pg'
        properties: {
          privateLinkServiceId: pg.id
          groupIds: [
            'postgresqlServer'
          ]
        }
      }
    ]
  }
}

resource dnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (createDnsZone) {
  name: privateDnsZoneName
  location: 'global'
  tags: tags
}

// One link per VNet that must resolve the server privately. @batchSize(1):
// concurrent virtualNetworkLink PUTs against the same zone race in ARM.
@batchSize(1)
resource dnsLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (vnetId, i) in dnsVnetIds: if (createDnsZone) {
  parent: dnsZone
  name: 'link-${uniqueString(vnetId)}'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnetId
    }
  }
}]

resource peDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'postgres-zone'
        properties: {
          privateDnsZoneId: createDnsZone ? dnsZone.id : privateDnsZoneId
        }
      }
    ]
  }
  dependsOn: [
    dnsLinks
  ]
}

resource pgDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  scope: pg
  name: 'diag-loom-ducklake-pg'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'PostgreSQLLogs', enabled: true }
      { category: 'PostgreSQLFlexSessions', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// ── The connection string, in Key Vault (never a plain env var) ─────────────
// libpq (and therefore DuckDB's `ATTACH 'ducklake:postgres:<dsn>'`) accepts the
// URI form. sslmode=require pins TLS on the private hop.
var catalogUrl = 'postgresql://${administratorLogin}:${administratorPassword}@${pg.properties.fullyQualifiedDomainName}:5432/${databaseName}?sslmode=require'

resource keyVault 'Microsoft.KeyVault/vaults@2024-04-01-preview' existing = if (!empty(keyVaultId)) {
  name: last(split(keyVaultId, '/'))
}

resource catalogUrlSecret 'Microsoft.KeyVault/vaults/secrets@2024-04-01-preview' = if (!empty(keyVaultId)) {
  parent: keyVault
  name: catalogUrlSecretName
  properties: {
    value: catalogUrl
    contentType: 'ducklake-catalog-connection-string'
    attributes: { enabled: true }
  }
  dependsOn: [
    pgDb
  ]
}

@description('Flexible-server name.')
output serverName string = pg.name

@description('Fully-qualified server name. Resolves to the private endpoint address inside the linked VNet(s).')
output fqdn string = pg.properties.fullyQualifiedDomainName

@description('Catalog database name — the /<db> segment of LOOM_DUCKLAKE_CATALOG_URL.')
output databaseName string = pgDb.name

@description('Key Vault secret NAME holding the DuckLake connection string. The Console binds LOOM_DUCKLAKE_CATALOG_URL to this via a Key Vault secretRef.')
output catalogUrlSecretName string = catalogUrlSecretName

@description('TRUE — this module never creates a publicly-reachable server and never emits the connection string anywhere but Key Vault. Emitted so the deploy receipt can assert the posture.')
output privateOnlyKeyVaultBacked bool = true

@description('Private DNS zone resource id in use (created here, or the one passed in).')
output privateDnsZoneId string = createDnsZone ? dnsZone.id : privateDnsZoneId
