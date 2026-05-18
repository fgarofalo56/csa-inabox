// Key Vault with RBAC + managed identity binding

param location string
param kvName string
param miPrincipalId string

resource kv 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: kvName
  location: location
  properties: {
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'  // production should set to Disabled with private endpoint
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
  }
}

// Grant the managed identity the "Key Vault Secrets User" role
var secretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource roleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(kv.id, miPrincipalId, secretsUserRoleId)
  properties: {
    principalId: miPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsUserRoleId)
  }
}

output kvName string = kv.name
output kvId string = kv.id
output kvUri string = kv.properties.vaultUri
