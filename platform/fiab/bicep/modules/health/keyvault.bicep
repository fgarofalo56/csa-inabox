// CSA Loom Health Data Services (LHDS) - stamp Key Vault + CMK identity.
//
// ADR-012: every data service in a stamp uses customer-managed keys, the key
// store is Key Vault Premium (HSM-backed), and soft-delete + purge protection
// are mandatory. This module owns:
//   - the vault (RBAC authorization, purge protection, private only),
//   - ONE user-assigned identity that the stamp's Storage, PostgreSQL and Event
//     Hubs resources use to wrap/unwrap their keys (assigned at resource
//     creation, which is the only order those services accept),
//   - the stamp-level HSM-backed keys with a yearly rotation policy,
//   - the vault private endpoint (privatelink.vaultcore zone group).
// Per-tenant keys (st-pixel, st-audit, pg, backup per tenant) are created by
// tenant.bicep (W1-2) in this same vault.

targetScope = 'resourceGroup'

@description('Region of the stamp.')
param location string

@description('Stamp short name; folded into resource names.')
param stampName string

@description('Entra tenant id that owns the vault.')
param tenantId string = subscription().tenantId

@description('Object id of the Entra group that administers the vault (Key Vault Administrator). Empty skips the grant; the operator then grants it out of band.')
param adminEntraGroupId string = ''

@description('Subnet that hosts the private endpoint.')
param peSubnetId string

@description('Resource id of the privatelink.vaultcore private DNS zone.')
param vaultZoneId string

@description('Log Analytics workspace id for diagnostics. Empty skips the diagnostic setting.')
param workspaceId string = ''

@description('Names of the stamp-level HSM-backed keys to create.')
param keyNames array = [
  'stamp-storage'
  'stamp-postgres'
  'stamp-eventhubs'
]

@description('Tags applied to every resource.')
param tags object = {}

var kvName = take('kv-lhds-${take(stampName, 6)}-${take(uniqueString(resourceGroup().id), 8)}', 24)

// Built-in role ids, global GUIDs (identical in every cloud).
var kvAdministratorRoleId = '00482a5a-887f-4fb3-b363-3b7fe8e74483'
var kvCryptoServiceEncryptionUserRoleId = 'e147488a-f6f5-4113-8e2d-b22465e65bf6'

resource cmkIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-lhds-${stampName}-cmk'
  location: location
  tags: tags
}

resource vault 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: kvName
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'premium'
    }
    tenantId: tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    // ADR-012: purge protection is mandatory and irreversible. A lost key is
    // unrecoverable data by design.
    enablePurgeProtection: true
    publicNetworkAccess: 'Disabled'
    // Storage and Event Hubs reach the vault as trusted Azure services when they
    // wrap/unwrap keys; every other caller goes through the private endpoint.
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Deny'
    }
  }
}

resource cmkRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, cmkIdentity.id, kvCryptoServiceEncryptionUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvCryptoServiceEncryptionUserRoleId)
    principalId: cmkIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'LHDS stamp CMK identity: wrap/unwrap keys for Storage, PostgreSQL and Event Hubs.'
  }
}

resource adminRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(adminEntraGroupId)) {
  scope: vault
  name: guid(vault.id, adminEntraGroupId, kvAdministratorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvAdministratorRoleId)
    principalId: adminEntraGroupId
    principalType: 'Group'
  }
}

// Keys are created through the ARM control plane, which works with public
// network access disabled and needs no data-plane role for the deployer.
resource keys 'Microsoft.KeyVault/vaults/keys@2024-11-01' = [for k in keyNames: {
  parent: vault
  name: k
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

resource pe 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${kvName}'
  location: location
  tags: tags
  properties: {
    subnet: { id: peSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'kv-link'
        properties: {
          privateLinkServiceId: vault.id
          groupIds: ['vault']
        }
      }
    ]
  }
}

resource peDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'vault'
        properties: { privateDnsZoneId: vaultZoneId }
      }
    ]
  }
}

// allLogs is the superset that works in every cloud: Azure Government rejects a
// separate 'audit' category group on Key Vault diagnostic settings, and allLogs
// already carries the audit events.
resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  scope: vault
  name: 'diag-lhds-stamp'
  properties: {
    workspaceId: workspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output vaultId string = vault.id
output vaultName string = vault.name
output vaultUri string = vault.properties.vaultUri
output cmkIdentityId string = cmkIdentity.id
output cmkIdentityClientId string = cmkIdentity.properties.clientId
output cmkIdentityPrincipalId string = cmkIdentity.properties.principalId
@description('Versionless key URIs by key name, so services follow automatic rotation.')
output keyUris object = reduce(range(0, length(keyNames)), {}, (acc, i) => union(acc, { '${keyNames[i]}': '${vault.properties.vaultUri}keys/${keyNames[i]}' }))
