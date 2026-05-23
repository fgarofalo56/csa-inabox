// CSA Loom — Admin Plane Key Vault Premium
// IL5: HSM-isolated (managed HSM); otherwise Premium with RBAC.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('HSM isolated mode (IL5 only)')
param hsmIsolated bool

@description('Tenant ID')
param tenantId string = subscription().tenantId

@description('Admin Entra group object ID')
param adminEntraGroupId string

@description('Private endpoints subnet ID')
param privateEndpointSubnetId string

@description('Private DNS zone ID for vault')
param privateDnsZoneVaultId string

@description('Compliance tags')
param complianceTags object

var kvName = take('kv-loom-${uniqueString(resourceGroup().id)}', 24)

resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: kvName
  location: location
  tags: complianceTags
  properties: {
    sku: {
      family: 'A'
      name: 'premium'
    }
    tenantId: tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Deny'
    }
  }
}

// Admin group gets Key Vault Administrator role
var keyVaultAdministratorRoleId = '00482a5a-887f-4fb3-b363-3b7fe8e74483'

resource adminKvRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, adminEntraGroupId, keyVaultAdministratorRoleId)
  properties: {
    roleDefinitionId: resourceId('Microsoft.Authorization/roleDefinitions', keyVaultAdministratorRoleId)
    principalId: adminEntraGroupId
    principalType: 'Group'
  }
}

// Private endpoint
resource pe 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${kvName}'
  location: location
  tags: complianceTags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'kv-link'
        properties: {
          privateLinkServiceId: keyVault.id
          groupIds: ['vault']
        }
      }
    ]
  }
}

resource peDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'kv-zone'
        properties: { privateDnsZoneId: privateDnsZoneVaultId }
      }
    ]
  }
}

// =====================================================================
// HSM-isolated mode (IL5) — also deploy a managed HSM
// =====================================================================

resource hsm 'Microsoft.KeyVault/managedHSMs@2024-11-01' = if (hsmIsolated) {
  name: take('hsm-loom-${uniqueString(resourceGroup().id)}', 24)
  location: location
  tags: complianceTags
  sku: {
    family: 'B'
    name: 'Standard_B1'
  }
  properties: {
    tenantId: tenantId
    initialAdminObjectIds: [adminEntraGroupId]
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Deny'
    }
  }
}

// =====================================================================
// Outputs
// =====================================================================

output keyVaultId string = keyVault.id
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
output managedHsmId string = hsmIsolated ? hsm.id : ''
