// CSA Loom Health Data Services (LHDS) - per-tenant resources inside a stamp (W1-2).
//
// Deployed by the control-plane job `tenant.create` into the stamp resource group,
// once per tenant, as the deployment `lhds-tenant-<tenantSlug>`. It consumes the
// stamp manifest (stamp.bicep output `stamp`) so it never re-derives a stamp name.
//
//   keys        4 HSM-backed per-tenant keys in the STAMP vault (ADR-012):
//                 t-<slug>-st-pixel  CMK of the tenant pixel account (in use at creation)
//                 t-<slug>-st-audit  CMK of the tenant audit account (in use at creation)
//                 t-<slug>-pg        reserved for the W2 engine's envelope encryption of
//                                    tenant rows (PostgreSQL's server CMK is stamp-wide)
//                 t-<slug>-backup    reserved for tenant backup/export envelope encryption
//               Crypto-shred (tenant.destroy) disables then deletes these; the key state
//               read back from ARM is the evidence. Purge protection is mandatory, so the
//               key material stays recoverable for the vault soft-delete window (90 d).
//   containers  a tenant pixel account (blob, private endpoint, CMK st-pixel) and an
//               immutable tenant audit account (CMK st-audit), both from storage.bicep.
//   databases   one PostgreSQL database per tenant on the stamp server (ADR-003).
//               PostgreSQL ROLES are SQL objects and cannot be created by ARM: the engine
//               init (W2) creates the in-database role; this module creates the Azure
//               side (below).
//   roles       a per-tenant user-assigned identity, granted Storage Blob Data Contributor
//               on the tenant pixel account, Storage Blob Data Contributor on the tenant
//               audit account, Key Vault Crypto Service Encryption User on ONLY the
//               tenant's own keys (key-scoped, so it cannot unwrap another tenant's key),
//               and Azure Event Hubs Data Sender/Receiver on the tenant event hub.
//   hub         one Event Hub per tenant in the stamp namespace (`eh-t-<slug>`).
//   DNS         every private endpoint carries a privatelink zone group; the zone ids
//               come from the stamp manifest, so the stamp's linked VNets (hub included,
//               via extraDnsLinkVnetIds) resolve the tenant accounts privately.
//   quotas      a Log Analytics-free metric alert on the pixel account UsedCapacity at
//               the tenant's maxStorageGiB (the request-rate quota is enforced at the
//               edge, W1-6). The alert is a signal, not a hard cap.
//
// UNMEASURED at authoring time: this module has never been deployed.

targetScope = 'resourceGroup'

@description('Stamp manifest (stamp.bicep output `stamp`). Everything stamp-level is read from here.')
param stamp object

@description('Tenant slug, 2-20 chars of a-z, 0-9 and hyphen (the control plane allows 40; the Azure names derived from it are tighter).')
@minLength(2)
@maxLength(20)
param tenantSlug string

@description('Tenant display name; recorded in tags only.')
param displayName string = tenantSlug

@description('Maximum tenant storage in GiB. Drives the capacity alert.')
@minValue(1)
param maxStorageGiB int = 1024

@description('Audit blob retention in days (Unlocked version-level immutability). 2190 = 6 years.')
param auditRetentionDays int = 2190

@description('Action group resource id that receives the capacity alert. Empty = the alert is created with no action.')
param alertActionGroupId string = ''

@description('Skip role assignments (re-deploys where the deployer cannot write RBAC).')
param skipRoleGrants bool = false

@description('Tags applied to every resource.')
param tags object = {}

var location = string(stamp.location)
var stampName = string(stamp.stampName)
var cleanSlug = replace(tenantSlug, '-', '')
var nameSeed = uniqueString(resourceGroup().id, tenantSlug)
var tenantTags = union(tags, {
  'lhds-stamp': stampName
  'lhds-tenant': tenantSlug
  'lhds-tenant-name': take(displayName, 120)
})

// The stamp manifest carries ids; names are the last path segment.
var vaultName = last(split(string(stamp.keyVaultId), '/'))
var pgServerName = last(split(string(stamp.postgresServerId), '/'))
var hasPostgres = !empty(string(stamp.postgresServerId))
var ehNamespaceName = string(stamp.eventHubsNamespace)

var keySuffixes = ['st-pixel', 'st-audit', 'pg', 'backup']
var keyNameList = [for k in keySuffixes: 't-${tenantSlug}-${k}']
var pixelAccountName = take('sthpx${take(cleanSlug, 8)}${nameSeed}', 24)
var auditAccountName = take('sthta${take(cleanSlug, 8)}${nameSeed}', 24)

// Built-in role ids, global GUIDs (identical in every cloud).
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var kvCryptoServiceEncryptionUserRoleId = 'e147488a-f6f5-4113-8e2d-b22465e65bf6'
var eventHubsDataSenderRoleId = '2b629674-e913-4c01-ae53-ef4638d8f975'
var eventHubsDataReceiverRoleId = 'a638d3c7-ab3a-418d-83e6-5f17a39d4fde'

resource vault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: vaultName
}

resource ehNamespace 'Microsoft.EventHub/namespaces@2024-05-01-preview' existing = {
  name: ehNamespaceName
}

// ── Keys ──────────────────────────────────────────────────────────────────────
resource keys 'Microsoft.KeyVault/vaults/keys@2024-11-01' = [for (k, i) in keySuffixes: {
  parent: vault
  name: keyNameList[i]
  tags: tenantTags
  properties: {
    kty: 'RSA-HSM'
    keySize: 3072
    keyOps: ['wrapKey', 'unwrapKey']
    attributes: { enabled: true }
    rotationPolicy: {
      attributes: { expiryTime: 'P1Y' }
      lifetimeActions: [
        {
          trigger: { timeBeforeExpiry: 'P60D' }
          action: { type: 'rotate' }
        }
        {
          trigger: { timeBeforeExpiry: 'P90D' }
          action: { type: 'notify' }
        }
      ]
    }
  }
}]

// ── Containers (storage) ──────────────────────────────────────────────────────
module pixelStorage 'storage.bicep' = {
  name: 'lhds-tenant-${tenantSlug}-pixel'
  params: {
    location: location
    accountName: pixelAccountName
    skuName: string(stamp.profile) == 'dev' ? 'Standard_LRS' : 'Standard_ZRS'
    containers: ['pixel']
    peSubnetId: string(stamp.peSubnetId)
    blobZoneId: string(stamp.privateDnsZoneIds.blob)
    cmkIdentityId: string(stamp.cmkIdentityId)
    keyVaultUri: string(stamp.keyVaultUri)
    keyName: keys[0].name
    workspaceId: string(stamp.lawId)
    tags: tenantTags
  }
}

module auditStorage 'storage.bicep' = {
  name: 'lhds-tenant-${tenantSlug}-audit'
  params: {
    location: location
    accountName: auditAccountName
    skuName: string(stamp.profile) == 'dev' ? 'Standard_LRS' : 'Standard_ZRS'
    containers: ['audit']
    immutableVersioning: true
    immutabilityRetentionDays: auditRetentionDays
    peSubnetId: string(stamp.peSubnetId)
    blobZoneId: string(stamp.privateDnsZoneIds.blob)
    cmkIdentityId: string(stamp.cmkIdentityId)
    keyVaultUri: string(stamp.keyVaultUri)
    keyName: keys[1].name
    workspaceId: string(stamp.lawId)
    tags: tenantTags
  }
  // Two accounts behind one private endpoint subnet and one zone: serialise so
  // concurrent privateDnsZoneGroup writes against the same zone do not race.
  dependsOn: [
    pixelStorage
  ]
}

// ── Database ──────────────────────────────────────────────────────────────────
resource pgServer 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' existing = if (hasPostgres) {
  name: hasPostgres ? pgServerName : 'unused'
}

resource tenantDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = if (hasPostgres) {
  parent: pgServer
  name: 'lhds_${replace(tenantSlug, '-', '_')}'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// ── Hub (Event Hub) ───────────────────────────────────────────────────────────
resource tenantHub 'Microsoft.EventHub/namespaces/eventhubs@2024-05-01-preview' = {
  parent: ehNamespace
  name: 'eh-t-${tenantSlug}'
  properties: {
    partitionCount: 2
    retentionDescription: {
      cleanupPolicy: 'Delete'
      retentionTimeInHours: 24
    }
  }
}

// ── Identity + roles ──────────────────────────────────────────────────────────
resource tenantIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-lhds-${stampName}-${tenantSlug}'
  location: location
  tags: tenantTags
}

resource pixelAccount 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {
  name: pixelAccountName
}

resource auditAccount 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {
  name: auditAccountName
}

resource pixelRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants) {
  scope: pixelAccount
  name: guid(pixelAccount.id, tenantIdentity.id, storageBlobDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalId: tenantIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource auditRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants) {
  scope: auditAccount
  name: guid(auditAccount.id, tenantIdentity.id, storageBlobDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalId: tenantIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Key-scoped: the tenant identity can use ONLY its own four keys.
resource keyRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (k, i) in keySuffixes: if (!skipRoleGrants) {
  scope: keys[i]
  name: guid(keys[i].id, tenantIdentity.id, kvCryptoServiceEncryptionUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvCryptoServiceEncryptionUserRoleId)
    principalId: tenantIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}]

resource hubSender 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants) {
  scope: tenantHub
  name: guid(tenantHub.id, tenantIdentity.id, eventHubsDataSenderRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', eventHubsDataSenderRoleId)
    principalId: tenantIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource hubReceiver 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants) {
  scope: tenantHub
  name: guid(tenantHub.id, tenantIdentity.id, eventHubsDataReceiverRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', eventHubsDataReceiverRoleId)
    principalId: tenantIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── Quota signal ──────────────────────────────────────────────────────────────
resource capacityAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-lhds-${stampName}-${tenantSlug}-capacity'
  location: 'global'
  tags: tenantTags
  properties: {
    description: 'Tenant ${tenantSlug} pixel storage exceeded its ${maxStorageGiB} GiB quota.'
    severity: 2
    enabled: true
    scopes: [pixelAccount.id]
    evaluationFrequency: 'PT1H'
    windowSize: 'PT6H'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'usedCapacity'
          criterionType: 'StaticThresholdCriterion'
          metricName: 'UsedCapacity'
          metricNamespace: 'Microsoft.Storage/storageAccounts'
          operator: 'GreaterThan'
          threshold: maxStorageGiB * 1073741824
          timeAggregation: 'Average'
        }
      ]
    }
    actions: empty(alertActionGroupId) ? [] : [
      { actionGroupId: alertActionGroupId }
    ]
  }
}

@description('Tenant manifest: every resource id the control plane reads back and records. Names equal the ones derived from the tenant slug.')
output tenant object = {
  tenantSlug: tenantSlug
  stampName: stampName
  pixelAccountId: pixelStorage.outputs.accountId
  pixelAccountName: pixelStorage.outputs.accountName
  auditAccountId: auditStorage.outputs.accountId
  auditAccountName: auditStorage.outputs.accountName
  databaseId: hasPostgres ? tenantDb.id : ''
  databaseName: hasPostgres ? tenantDb.name : ''
  eventHubId: tenantHub.id
  eventHubName: tenantHub.name
  identityId: tenantIdentity.id
  identityPrincipalId: tenantIdentity.properties.principalId
  capacityAlertId: capacityAlert.id
  maxStorageGiB: maxStorageGiB
}

@description('Resource ids of the four tenant keys, in the order st-pixel, st-audit, pg, backup.')
output keyIds array = [for (k, i) in keySuffixes: keys[i].id]

@description('Names of the four tenant keys, same order.')
output keyNames array = keyNameList
