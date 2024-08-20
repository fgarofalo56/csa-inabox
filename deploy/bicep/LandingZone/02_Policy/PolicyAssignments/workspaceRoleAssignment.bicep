targetScope = 'subscription'

metadata name = 'ALZ Bicep - Subscription Policy Assignments'
metadata description = 'Module used to assign policy definitions to management groups'

type nonComplianceMessageType = {
  @description('The message to display when the policy is non-compliant.')
  message: string

  @description('The reference ID of the policy definition.')
  policyDefinitionReferenceId: string
}[]



param workspaceName string = 'alz-log-analytics'
param resourceGroupName string = 'rg-alz-logging-001'
param managedIdentityName string = 'alz-umi-identity'
param roleDefinition string = 'b24988ac-6180-42a0-ab88-20f7382dd24c'
param umiPrincipalId string = '347ccf25-94c7-4234-84f5-1bd58d51a812'

var umiID = resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', managedIdentityName)

resource roleDefinitionId 'Microsoft.Authorization/roleDefinitions@2023-07-01-preview' existing = {
  name: roleDefinition
  // scope: resourceGroup()
}

resource roleAssignment 'Microsoft.Authorization/roleAssignments@2022-01-01-preview' = {
  name: guid(resourceGroupName, workspaceName, umiID, roleDefinitionId.id)
  properties: {
    roleDefinitionId: roleDefinitionId.id
    principalId: umiPrincipalId
  }
}
