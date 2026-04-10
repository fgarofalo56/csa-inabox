// =============================================================================
// CSA-in-a-Box: Customer-Managed Key Identity Module
// Creates a user-assigned managed identity for CMK encryption operations
// and assigns the Key Vault Crypto User role to it.
// =============================================================================
targetScope = 'resourceGroup'

@description('Azure region for deployment')
param parLocation string

@description('Name for the user-assigned managed identity')
param parIdentityName string

@description('Resource ID of the Key Vault holding the CMK encryption key')
param parKeyVaultId string

@description('Tags for resource organisation')
param parTags object = {}

// Key Vault Crypto User role — allows wrap/unwrap/get key operations
// required for CMK encryption across Storage, Cosmos DB, and Synapse.
var keyVaultCryptoUserRoleId = '12338af0-0e69-4776-bea7-57ae8d297424'

// User-assigned managed identity
resource cmkIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: parIdentityName
  location: parLocation
  tags: parTags
}

// Assign Key Vault Crypto User role to the identity on the Key Vault
resource roleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(parKeyVaultId, cmkIdentity.id, keyVaultCryptoUserRoleId)
  scope: keyVault
  properties: {
    principalId: cmkIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultCryptoUserRoleId)
    description: 'CSA-in-a-Box CMK identity — Key Vault Crypto User for encryption key operations'
  }
}

// Reference the existing Key Vault for scope
resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: last(split(parKeyVaultId, '/'))
}

// Outputs
output identityId string = cmkIdentity.id
output identityPrincipalId string = cmkIdentity.properties.principalId
output identityClientId string = cmkIdentity.properties.clientId
output identityName string = cmkIdentity.name
