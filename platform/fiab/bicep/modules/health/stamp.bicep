// CSA Loom Health Data Services (LHDS) - stamp orchestrator (ADR-005, W1-1).
//
// A stamp is one region's self-contained cell: VNet + private DNS + optional
// egress firewall, private AKS, PostgreSQL Flexible Server, audit and export
// Blob accounts, Event Hubs, Key Vault with the CMK identity, a Log Analytics
// workspace, and the WAF v2 ingress. It knows nothing about other stamps, so its
// blast radius is the tenants placed on it. Tenants (databases, containers,
// per-tenant keys) are added by tenant.bicep (W1-2); the engine workloads by W2+.
//
// Scope: resource group `rg-csa-loom-health-<stamp>-<region>`, created by main.bicep
// behind `healthEnabled` (default false in every param file).
//
// Sizing is a `profile` (CAPACITY-MODEL.md s5):
//   dev - one D8s_v5 AKS node, egress pool at 0 nodes, PostgreSQL GP D2ds_v5 128 GB,
//         no HA/replicas, Event Hubs Standard. Function proof only.
//   S / M / L - the documented class sizes. Gov has no E-series v5 and no D/E v5
//         PostgreSQL SKUs (W0-RECEIPT.md s4.1b), so Gov boundaries resolve PostgreSQL
//         to the v4 generation. Storage is Premium SSD: SSD v2 was not seen in Gov,
//         which means class L as sized (about 55 TiB) does not fit one server there;
//         it is capped at the 32 TiB Premium SSD ceiling and the tenant working-set
//         cap / split-by-facility-group rule applies (CAPACITY-MODEL.md s5).

targetScope = 'resourceGroup'

@description('Primary region. Gov default is usgovarizona (zone-redundant PostgreSQL HA); usgovvirginia is offer-restricted for the measured subscription (W0-RECEIPT.md s4.1b).')
param location string = resourceGroup().location

@description('Paired region for DR. Recorded in tags and outputs; DR resources are W11. Gov default is usgovtexas.')
param pairedLocation string = ''

@description('Stamp short name, 2-12 chars: lowercase letters, digits and hyphen, starting with a letter.')
@minLength(2)
@maxLength(12)
param stampName string

@description('Cloud boundary. Selects sovereign DNS suffixes, the Gov PostgreSQL SKU generation, and the AKS KEDA add-on.')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string

@description('Size profile.')
@allowed(['dev', 'S', 'M', 'L'])
param profile string = 'dev'

@description('Entra tenant id.')
param tenantId string = subscription().tenantId

@description('Object id of the Entra group that administers the vault, the PostgreSQL server and the cluster. Empty = the operator grants roles after the deploy.')
param adminEntraGroupId string = ''

@description('Stamp VNet address space. Stamps do not peer with each other, so the default can repeat across stamps; change it when the VNet is peered to a hub that uses the same range.')
param vnetAddressPrefix string = '10.60.0.0/16'

@description('Outbound model override. Empty = profile default (firewall for S/M/L, loadBalancer for dev).')
@allowed(['', 'firewall', 'loadBalancer'])
param egressModeOverride string = ''

@description('PostgreSQL HA override. Empty = profile default (ZoneRedundant for S/M/L, Disabled for dev). Use SameZone in a region without zone-redundant HA (usgovtexas).')
@allowed(['', 'Disabled', 'SameZone', 'ZoneRedundant'])
param postgresHaOverride string = ''

@description('Spread zonal resources over availability zones. Set false in a region without zones.')
param useAvailabilityZones bool = true

@description('Kubernetes version (W0 read 1.31 to 1.37 as offered in all three Gov regions).')
param kubernetesVersion string = '1.34'

@description('Login server of the shared ACR the stamp pulls images from. Empty = no ACR firewall rule.')
param acrLoginServer string = ''

@description('Extra FQDNs allowed through the egress firewall. A reviewed change.')
param extraAllowedFqdns array = []

@description('VNets (for example the hub that hosts the control plane) linked to every stamp private DNS zone.')
param extraDnsLinkVnetIds array = []

@description('Version-less Key Vault secret URI of the ingress TLS certificate. Empty = no TLS listener yet; port 80 only redirects.')
param tlsCertificateSecretUri string = ''

@description('Audit blob retention in days applied as an Unlocked version-level immutability policy. 2190 = 6 years (45 CFR 164.316). Locking is irreversible and left to the operator.')
param auditRetentionDays int = 2190

@description('Log Analytics retention in days.')
@minValue(30)
@maxValue(730)
param logRetentionDays int = 90

@description('Tags applied to every resource.')
param tags object = {}

var isGov = boundary == 'GCC-High' || boundary == 'IL5'
var stampTags = union(tags, {
  'lhds-stamp': stampName
  'lhds-profile': profile
  'lhds-paired-region': empty(pairedLocation) ? 'none' : pairedLocation
})

// ── Profiles (CAPACITY-MODEL.md s5, W0 DEV measurements) ──────────────────────
// PostgreSQL size is the v5 name without generation; Gov resolves to _v4.
var profiles = {
  dev: {
    aksSystem: { vmSize: 'Standard_D8s_v5', count: 1, minCount: 1, maxCount: 1 }
    aksEngines: { vmSize: 'Standard_D8s_v5', count: 0, minCount: 0, maxCount: 0 }
    aksEgress: { vmSize: 'Standard_D4s_v5', count: 0, minCount: 0, maxCount: 2 }
    isolateSystemPool: false
    pgSize: 'D2ds'
    pgTier: 'GeneralPurpose'
    pgStorageGB: 128
    pgHa: 'Disabled'
    pgReplicas: 0
    eventHubsTier: 'Standard'
    eventHubsCapacity: 1
    storageSku: 'Standard_LRS'
    egressMode: 'loadBalancer'
    agwMin: 1
    agwMax: 2
  }
  S: {
    aksSystem: { vmSize: 'Standard_D4s_v5', count: 3, minCount: 3, maxCount: 5 }
    aksEngines: { vmSize: 'Standard_D8s_v5', count: 6, minCount: 6, maxCount: 12 }
    aksEgress: { vmSize: 'Standard_D4s_v5', count: 0, minCount: 0, maxCount: 3 }
    isolateSystemPool: true
    pgSize: 'E8ds'
    pgTier: 'MemoryOptimized'
    pgStorageGB: 8192
    pgHa: 'ZoneRedundant'
    pgReplicas: 1
    eventHubsTier: 'Premium'
    eventHubsCapacity: 1
    storageSku: 'Standard_ZRS'
    egressMode: 'firewall'
    agwMin: 2
    agwMax: 6
  }
  M: {
    aksSystem: { vmSize: 'Standard_D4s_v5', count: 3, minCount: 3, maxCount: 5 }
    aksEngines: { vmSize: 'Standard_D16s_v5', count: 12, minCount: 12, maxCount: 20 }
    aksEgress: { vmSize: 'Standard_D4s_v5', count: 0, minCount: 0, maxCount: 4 }
    isolateSystemPool: true
    pgSize: 'E16ds'
    pgTier: 'MemoryOptimized'
    pgStorageGB: 32767
    pgHa: 'ZoneRedundant'
    pgReplicas: 2
    eventHubsTier: 'Premium'
    eventHubsCapacity: 2
    storageSku: 'Standard_ZRS'
    egressMode: 'firewall'
    agwMin: 2
    agwMax: 10
  }
  L: {
    aksSystem: { vmSize: 'Standard_D4s_v5', count: 3, minCount: 3, maxCount: 5 }
    aksEngines: { vmSize: 'Standard_D16s_v5', count: 24, minCount: 24, maxCount: 36 }
    aksEgress: { vmSize: 'Standard_D8s_v5', count: 0, minCount: 0, maxCount: 6 }
    isolateSystemPool: true
    pgSize: 'E32ds'
    pgTier: 'MemoryOptimized'
    pgStorageGB: 32767
    pgHa: 'ZoneRedundant'
    pgReplicas: 2
    eventHubsTier: 'Premium'
    eventHubsCapacity: 4
    storageSku: 'Standard_ZRS'
    egressMode: 'firewall'
    agwMin: 3
    agwMax: 15
  }
}
var p = profiles[profile]
var egressMode = empty(egressModeOverride) ? p.egressMode : egressModeOverride
var pgHa = empty(postgresHaOverride) ? p.pgHa : postgresHaOverride
var pgSkuName = 'Standard_${p.pgSize}_${isGov ? 'v4' : 'v5'}'
var storageSku = useAvailabilityZones ? p.storageSku : 'Standard_LRS'

var nameSeed = uniqueString(resourceGroup().id)
var cleanStamp = replace(stampName, '-', '')

// ── Observability ─────────────────────────────────────────────────────────────
resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-lhds-${stampName}'
  location: location
  tags: stampTags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: logRetentionDays
  }
}

// ── Network ───────────────────────────────────────────────────────────────────
module network 'network.bicep' = {
  name: 'lhds-${stampName}-network'
  params: {
    location: location
    stampName: stampName
    boundary: boundary
    vnetAddressPrefix: vnetAddressPrefix
    egressMode: egressMode
    acrLoginServer: acrLoginServer
    extraAllowedFqdns: extraAllowedFqdns
    extraDnsLinkVnetIds: extraDnsLinkVnetIds
    tags: stampTags
  }
}

// ── Key Vault + CMK identity + stamp keys ─────────────────────────────────────
module keyvault 'keyvault.bicep' = {
  name: 'lhds-${stampName}-keyvault'
  params: {
    location: location
    stampName: stampName
    tenantId: tenantId
    adminEntraGroupId: adminEntraGroupId
    peSubnetId: network.outputs.peSubnetId
    vaultZoneId: network.outputs.privateDnsZoneIds.vault
    workspaceId: law.id
    tags: stampTags
  }
}

// ── Storage: immutable audit trail + export staging ───────────────────────────
module auditStorage 'storage.bicep' = {
  name: 'lhds-${stampName}-storage-audit'
  params: {
    location: location
    accountName: take('sthaud${take(cleanStamp, 6)}${nameSeed}', 24)
    skuName: storageSku
    containers: ['audit']
    immutableVersioning: true
    immutabilityRetentionDays: auditRetentionDays
    peSubnetId: network.outputs.peSubnetId
    blobZoneId: network.outputs.privateDnsZoneIds.blob
    cmkIdentityId: keyvault.outputs.cmkIdentityId
    keyVaultUri: keyvault.outputs.vaultUri
    keyName: 'stamp-storage'
    workspaceId: law.id
    tags: stampTags
  }
}

module exportStorage 'storage.bicep' = {
  name: 'lhds-${stampName}-storage-export'
  params: {
    location: location
    accountName: take('sthexp${take(cleanStamp, 6)}${nameSeed}', 24)
    skuName: storageSku
    containers: ['export-staging']
    peSubnetId: network.outputs.peSubnetId
    blobZoneId: network.outputs.privateDnsZoneIds.blob
    cmkIdentityId: keyvault.outputs.cmkIdentityId
    keyVaultUri: keyvault.outputs.vaultUri
    keyName: 'stamp-storage'
    workspaceId: law.id
    tags: stampTags
  }
  // Two accounts behind one private endpoint subnet and one zone: serialise so
  // concurrent privateDnsZoneGroup writes against the same zone do not race.
  dependsOn: [
    auditStorage
  ]
}

// ── PostgreSQL ────────────────────────────────────────────────────────────────
module postgres 'postgres.bicep' = {
  name: 'lhds-${stampName}-postgres'
  params: {
    location: location
    stampName: stampName
    skuName: pgSkuName
    tier: p.pgTier
    storageSizeGB: p.pgStorageGB
    highAvailabilityMode: pgHa
    replicaCount: p.pgReplicas
    delegatedSubnetId: network.outputs.postgresSubnetId
    vnetId: network.outputs.vnetId
    privateDnsZoneName: network.outputs.postgresZoneName
    extraDnsLinkVnetIds: extraDnsLinkVnetIds
    cmkIdentityId: keyvault.outputs.cmkIdentityId
    cmkKeyUri: keyvault.outputs.keyUris['stamp-postgres']
    tenantId: tenantId
    adminEntraGroupId: adminEntraGroupId
    workspaceId: law.id
    tags: stampTags
  }
}

// ── Event Hubs ────────────────────────────────────────────────────────────────
module eventing 'eventing.bicep' = {
  name: 'lhds-${stampName}-eventing'
  params: {
    location: location
    stampName: stampName
    skuTier: p.eventHubsTier
    capacity: p.eventHubsCapacity
    peSubnetId: network.outputs.peSubnetId
    eventHubsZoneId: network.outputs.privateDnsZoneIds.eventhubs
    cmkIdentityId: keyvault.outputs.cmkIdentityId
    keyVaultUri: keyvault.outputs.vaultUri
    keyName: 'stamp-eventhubs'
    workspaceId: law.id
    tags: stampTags
  }
  dependsOn: [
    exportStorage
  ]
}

// ── AKS ───────────────────────────────────────────────────────────────────────
module aks 'aks.bicep' = {
  name: 'lhds-${stampName}-aks'
  params: {
    location: location
    stampName: stampName
    boundary: boundary
    kubernetesVersion: kubernetesVersion
    aksSubnetId: network.outputs.aksSubnetId
    vnetName: network.outputs.vnetName
    routeTableId: network.outputs.routeTableId
    outboundType: egressMode == 'firewall' ? 'userDefinedRouting' : 'loadBalancer'
    useAvailabilityZones: useAvailabilityZones
    systemPool: p.aksSystem
    enginesPool: p.aksEngines
    egressPool: p.aksEgress
    isolateSystemPool: p.isolateSystemPool
    adminGroupObjectIds: empty(adminEntraGroupId) ? [] : [adminEntraGroupId]
    workspaceId: law.id
    tags: stampTags
  }
}

// ── Ingress ───────────────────────────────────────────────────────────────────
module ingress 'ingress.bicep' = {
  name: 'lhds-${stampName}-ingress'
  params: {
    location: location
    stampName: stampName
    agwSubnetId: network.outputs.agwSubnetId
    backendIp: network.outputs.ingressIlbIp
    tlsCertificateSecretUri: tlsCertificateSecretUri
    keyVaultId: keyvault.outputs.vaultId
    minCapacity: p.agwMin
    maxCapacity: p.agwMax
    useAvailabilityZones: useAvailabilityZones
    workspaceId: law.id
    tags: stampTags
  }
}

@description('Stamp manifest: everything the control plane records in the stamp registry and tenant.bicep consumes.')
output stamp object = {
  stampName: stampName
  profile: profile
  boundary: boundary
  location: location
  pairedLocation: pairedLocation
  resourceGroup: resourceGroup().name
  lawId: law.id
  vnetId: network.outputs.vnetId
  peSubnetId: network.outputs.peSubnetId
  privateDnsZoneIds: network.outputs.privateDnsZoneIds
  egressMode: egressMode
  egressFqdns: network.outputs.egressFqdns
  keyVaultId: keyvault.outputs.vaultId
  keyVaultUri: keyvault.outputs.vaultUri
  cmkIdentityId: keyvault.outputs.cmkIdentityId
  auditStorageAccount: auditStorage.outputs.accountName
  exportStorageAccount: exportStorage.outputs.accountName
  postgresServerId: postgres.outputs.serverId
  postgresFqdn: postgres.outputs.fqdn
  postgresSku: pgSkuName
  eventHubsNamespace: eventing.outputs.namespaceName
  eventHubsCustomerManagedKey: eventing.outputs.customerManagedKey
  aksClusterName: aks.outputs.clusterName
  aksOidcIssuerUrl: aks.outputs.oidcIssuerUrl
  kedaAddon: aks.outputs.kedaAddon
  ingressPublicFqdn: ingress.outputs.publicFqdn
  ingressTlsConfigured: ingress.outputs.tlsConfigured
  wafPolicyId: ingress.outputs.wafPolicyId
}
