// CSA Loom — Loom Unity metastore persistence: Azure Database for PostgreSQL
// Flexible Server, Entra-ONLY, private-endpoint-only, in-VNet.
//
// LU-1. This is the DEFAULT catalog store for "Loom Unity" (Loom's
// Unity-Catalog-COMPATIBLE metastore, apps/loom-unity + compute/loom-unity-app.bicep).
// It replaces the previous H2-file-DB-on-Azure-Files default, which:
//
//   * CrashLoopBackOff'd on Azure Government — the CIFS mount blocks container
//     start before the JVM runs, and H2's file-lock protocol has no reliable
//     SMB semantics (observed live 2026-07-14; the app module's own `dbEphemeral`
//     escape hatch documents it verbatim);
//   * is single-writer, which pinned the Container App to exactly ONE replica —
//     no rolling restart without a catalog outage, no horizontal headroom;
//   * has no PITR, no backup, and no server-side encryption story.
//
// Postgres fixes all three: durable + backed up, multi-writer (so the app can
// run >1 replica), and reachable ONLY over a private endpoint with Entra tokens.
//
// FedRAMP posture (non-negotiable, .claude/rules — no-vaporware / no-fabric-dependency):
//   * `authConfig.passwordAuth = 'Disabled'`  — there is NO password to leak,
//     rotate, or land in ARM deployment history. Every connection presents an
//     Entra access token minted from a managed identity.
//   * `network.publicNetworkAccess = 'Disabled'` — the server has no public
//     endpoint at all; firewall rules are not even evaluated.
//   * A private endpoint in the caller's VNet + a `privatelink.postgres.*`
//     private DNS zone (sovereign suffix derived per cloud) so the Container
//     App resolves the server name to a private address.
//   * Diagnostics to the Loom Log Analytics workspace.
//
// DEPLOYED BY THE ORCHESTRATOR (#2681). admin-plane/main.bicep invokes this
// module whenever Loom Unity is active AND the sovereign Postgres quota gate
// allows it (`loomUnityPostgresActive`), and passes its fqdn / aadUser outputs
// straight to compute/loom-unity-app.bicep. No new top-level param was needed —
// the Loom Unity toggle rides the existing `loomBackends` bag — so the ARM
// 256-parameter ceiling is untouched.
//
// ZONE-COLLISION CONTRACT: the orchestrator passes the privatelink.postgres.*
// zone that ducklake-catalog-postgres.bicep created on the hub VNet as this
// module's `privateDnsZoneId`. Azure rejects a second virtualNetworkLink to a
// DIFFERENT zone of the same name on the same VNet, so this module must never
// create its own when that one exists.
//
// Where the quota gate trips (gcc-high / il5 default postgresQuotaAvailable=
// false) the orchestrator SKIPS this module and runs the catalog on an EmptyDir
// H2 store instead (`dbEphemeral: true`) — a functional but non-durable
// metastore, which is what the Gov estate has been running since 2026-07-15.
// The direct invocation below still works for an out-of-band deploy:

//   az deployment group create -g <admin-rg> \
//     -f platform/fiab/bicep/modules/data-plane/loom-unity-postgres.bicep \
//     -p location=<region> \
//        privateEndpointSubnetId=<pe-subnet-resource-id> \
//        unityPrincipalId=<loom-unity-UAMI-principalId> \
//        unityPrincipalName=<loom-unity-UAMI-name> \
//        workspaceId=<law-id> complianceTags='{ "env": "gov" }'
//   # then run scripts/csa-loom/loom-unity-postgres-bootstrap.sh to create the
//   # Entra DB principal + (optionally) migrate an existing H2 catalog, and pass
//   # unityPostgresFqdn/unityDbAadUser into compute/loom-unity-app.bicep.
//
// Azure-native only — no Microsoft Fabric / Power BI / OneLake dependency.

targetScope = 'resourceGroup'

@description('Deployment region (e.g. usgovvirginia / centralus).')
param location string

@description('Flexible-server name. Default derives a deterministic, globally-unique name from the resource group.')
@maxLength(63)
param name string = take('psql-loom-unity-${uniqueString(resourceGroup().id)}', 63)

@description('Catalog database name Loom Unity persists its metastore in.')
param databaseName string = 'unitycatalog'

@description('PostgreSQL major version.')
@allowed([
  '15'
  '16'
])
param postgresVersion string = '16'

@description('Flexible-server SKU name. GeneralPurpose D2ds_v5 is the smallest tier that supports zone-redundant HA; Burstable B1ms/B2s is the cheapest functional size for a metadata catalog and is the default (a Unity metastore is a low-QPS, small-row workload).')
param skuName string = 'Standard_B2s'

@description('Compute tier for the SKU. Burstable cannot do zone-redundant HA — pick GeneralPurpose when haMode is set.')
@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param tier string = 'Burstable'

@description('Storage size in GB. A Unity Catalog metastore is metadata only — 32 GB is generous.')
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

@description('Geo-redundant backup. Leave Disabled in sovereign boundaries with a single paired region policy.')
@allowed([
  'Enabled'
  'Disabled'
])
param geoRedundantBackup string = 'Disabled'

@description('High-availability mode. ZoneRedundant requires a GeneralPurpose/MemoryOptimized tier AND a region with availability zones; Disabled (default) still gives PITR + automated backups. SameZone is the middle ground.')
@allowed([
  'Disabled'
  'SameZone'
  'ZoneRedundant'
])
param haMode string = 'Disabled'

@description('Resource id of the subnet the PRIVATE ENDPOINT is injected into — normally the Loom hub private-endpoint subnet, in (or peered to) the VNet the Container Apps environment is integrated with. REQUIRED: this module has no public-access mode. `publicNetworkAccess` is hard-wired to Disabled, so without a private endpoint nothing can reach the server at all.')
param privateEndpointSubnetId string

@description('Existing privatelink.postgres.database.<suffix> private DNS zone resource id. EMPTY (default) => this module CREATES the zone and links it to the VNet that owns privateEndpointSubnetId, so a from-scratch deploy resolves the server privately with no hub prerequisite. Pass an id when the hub already owns the zone.')
param privateDnsZoneId string = ''

@description('Additional VNet resource ids to link to the private DNS zone (only used when this module creates the zone) — e.g. a separate Container Apps VNet peered to the private-endpoint VNet.')
param additionalDnsVnetIds array = []

@description('Principal (object) id of the loom-unity Container App UAMI. Set as the Entra ADMINISTRATOR of the server so Loom Unity connects token-only with no password anywhere. Empty => no administrator is set and the operator wires one out-of-band (the server is still Entra-only; it just has nobody who can log in yet).')
param unityPrincipalId string = ''

@description('Display name of that UAMI — this is the PostgreSQL role name Loom Unity authenticates as (hibernate.connection.username / the app module unityDbAadUser).')
param unityPrincipalName string = 'uami-loom-unity'

@description('Additional Entra administrators (break-glass / operator groups). Each entry: { principalId, principalName, principalType } where principalType is User | Group | ServicePrincipal.')
param additionalAdministrators array = []

@description('Tenant id for the Entra administrators.')
param tenantId string = tenant().tenantId

@description('Log Analytics workspace resource id for diagnostic settings. Empty => no diagnostic settings.')
param workspaceId string = ''

@description('Compliance/cost tags.')
param complianceTags object = {}

// ── Sovereign-safe naming ───────────────────────────────────────────────────
// The PG data-plane suffix differs per cloud (postgres.database.azure.com in
// Commercial/GCC, postgres.database.usgovcloudapi.net in GCC-High/IL5) and so
// does the private-link zone name. environment().suffixes.sqlServerHostname is
// the ARM-provided per-cloud SQL/DB hostname suffix ('.database.windows.net' /
// '.database.usgovcloudapi.net').
//
// The PG suffix does NOT equal the SQL suffix in Commercial: SQL Server is
// '.database.windows.net' while PostgreSQL flexible server is
// '.database.azure.com', so the documented privatelink zone is
// privatelink.postgres.database.azure.com (learn.microsoft.com/azure/
// private-link/private-endpoint-dns#commercial). In Azure Government and
// Azure China the two suffixes coincide ('.database.usgovcloudapi.net' /
// '.database.chinacloudapi.cn'), which is why the earlier derivation —
// 'privatelink.postgres' + sqlServerHostname — was right in Gov and WRONG in
// Commercial: it produced privatelink.postgres.database.windows.net, a zone
// name the platform never resolves through, so the PE zone group wrote records
// nothing ever queried and the catalog's JDBC hostname could not resolve. The
// live Commercial estate carries exactly that fossil (an empty
// privatelink.postgres.database.windows.net zone + hub-VNet link, #3039), and
// lib/azure/pe-subresource-groups.ts has carried the correct per-cloud mapping
// all along. Map ONLY the Commercial special case; every sovereign suffix
// passes through unchanged.
var sqlHostSuffix = environment().suffixes.sqlServerHostname // '.database.windows.net' | '.database.usgovcloudapi.net'
// The '.database.windows.net' literal below is a COMPARISON key (detecting the
// Commercial/GCC SQL suffix), not a hardcoded endpoint — the emitted value
// still derives from environment().suffixes. Linter can't tell the difference.
#disable-next-line no-hardcoded-env-urls
var pgHostSuffix = sqlHostSuffix == '.database.windows.net' ? '.database.azure.com' : sqlHostSuffix
var privateDnsZoneName = 'privatelink.postgres${pgHostSuffix}'

// VNet that owns the private-endpoint subnet:
//   /subscriptions/S/resourceGroups/RG/providers/Microsoft.Network/virtualNetworks/V/subnets/SUB
//   split('/') => ['', subscriptions, S, resourceGroups, RG, providers, Microsoft.Network, virtualNetworks, V, subnets, SUB]
// take(...,9) keeps everything through the VNet name.
var peVnetId = join(take(split(privateEndpointSubnetId, '/'), 9), '/')
var createDnsZone = empty(privateDnsZoneId)
var dnsVnetIds = union([peVnetId], additionalDnsVnetIds)

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: name
  location: location
  tags: complianceTags
  sku: {
    name: skuName
    tier: tier
  }
  properties: {
    version: postgresVersion
    storage: {
      storageSizeGB: storageSizeGB
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: geoRedundantBackup
    }
    // ENTRA-ONLY. passwordAuth Disabled means the server will not accept a
    // password for ANY role — there is no credential to rotate or leak, and the
    // loom-unity container never carries one (LU-1 + the LU-2 "no inline
    // secrets" rule are the same posture applied to the DB tier).
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
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

// Entra administrator = the loom-unity UAMI. `principalName` is the PostgreSQL
// role name the server maps the token to, so it MUST match the username the
// container connects with (compute/loom-unity-app.bicep `unityDbAadUser`).
resource pgAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = if (!empty(unityPrincipalId)) {
  parent: pg
  name: unityPrincipalId
  properties: {
    principalName: unityPrincipalName
    principalType: 'ServicePrincipal'
    tenantId: tenantId
  }
}

// Break-glass / operator administrators. Serialized after the app admin: AAD
// admin writes are control-plane ops that fail while the server is mid-update
// (AadAuthOperationCannotBePerformedWhenServerIsNotAccessible — hit live on the
// dlz-attach provision), so they are never PUT in parallel.
@batchSize(1)
resource pgExtraAdmins 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = [for admin in additionalAdministrators: {
  parent: pg
  name: admin.principalId
  properties: {
    principalName: admin.principalName
    principalType: admin.?principalType ?? 'Group'
    tenantId: tenantId
  }
  dependsOn: [
    pgAdmin
  ]
}]

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
  tags: complianceTags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'loom-unity-pg'
        properties: {
          privateLinkServiceId: pg.id
          // 'postgresqlServer' is the documented private-link sub-resource for
          // Azure Database for PostgreSQL flexible server.
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
  tags: complianceTags
}

// One link per VNet that must resolve the server privately. @batchSize(1):
// concurrent virtualNetworkLink PUTs against the same zone race in ARM.
@batchSize(1)
resource dnsLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (vnetId, i) in dnsVnetIds: if (createDnsZone) {
  parent: dnsZone
  name: 'link-${uniqueString(vnetId)}'
  location: 'global'
  tags: complianceTags
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
  name: 'diag-loom-unity-pg'
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

@description('Flexible-server name.')
output serverName string = pg.name

@description('Fully-qualified server name — pass to compute/loom-unity-app.bicep as unityPostgresFqdn. Resolves to the private endpoint address inside the linked VNet(s).')
output fqdn string = pg.properties.fullyQualifiedDomainName

@description('Catalog database name — pass to compute/loom-unity-app.bicep as unityPostgresDatabase.')
output databaseName string = pgDb.name

@description('PostgreSQL role name Loom Unity authenticates as (the UAMI display name) — pass to compute/loom-unity-app.bicep as unityDbAadUser.')
output aadUser string = unityPrincipalName

@description('JDBC URL the loom-unity entrypoint renders (it appends sslmode + the Entra authentication plugin itself).')
output jdbcUrl string = 'jdbc:postgresql://${pg.properties.fullyQualifiedDomainName}:5432/${pgDb.name}'

@description('TRUE — this module never creates a password-authenticated or publicly-reachable server. Emitted so the deploy receipt can assert the posture.')
output entraOnlyPrivateOnly bool = true

@description('Private DNS zone resource id in use (created here, or the one passed in).')
output privateDnsZoneId string = createDnsZone ? dnsZone.id : privateDnsZoneId
