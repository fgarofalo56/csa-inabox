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

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Private endpoints subnet ID')
param privateEndpointSubnetId string

@description('Private DNS zone ID for vault')
param privateDnsZoneVaultId string

@description('Log Analytics workspace ID for diagnostic settings')
param workspaceId string

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

// Role assignment skipped when adminEntraGroupId not configured —
// operator runs `scripts/csa-loom/grant-admin-kv-access.sh` post-
// deploy once they've identified the admin group.
resource adminKvRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(adminEntraGroupId) && !skipRoleGrants) {
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

resource hsm 'Microsoft.KeyVault/managedHSMs@2024-11-01' = if (hsmIsolated && !empty(adminEntraGroupId)) {
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

// Diagnostic settings → standardized Loom LAW
resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: keyVault
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
      { categoryGroup: 'audit', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

resource diagHsm 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (hsmIsolated) {
  scope: hsm
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
      { categoryGroup: 'audit', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output keyVaultId string = keyVault.id
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
output managedHsmId string = hsmIsolated ? hsm.id : ''
