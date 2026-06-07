// CSA Loom — ADX cluster MI → Azure Event Hubs Data Receiver on the DLZ namespace.
//
// The Event Hubs namespace lives in the DLZ resource group, NOT the admin RG
// where the ADX cluster is created. Same cross-RG (BCP139) + runtime-principalId
// (BCP120) constraints as adx-mi-storage-rbac.bicep — solved with the same
// RG-scoped module-indirection pattern used elsewhere in this repo
// (see scaling-rbac.bicep).
//
// Role: Azure Event Hubs Data Receiver (a638d3c7-ab3a-418d-83e6-5f17a39d4fde) —
// required so ARM dataConnections (EventHub kind) can pull events via the
// cluster's managed identity. Distinct from the Console-UAMI Data Receiver grant
// in landing-zone/eventhubs.bicep (different principal → different role-assignment
// GUID, so the two coexist). The built-in role ID is cloud-agnostic.

targetScope = 'resourceGroup'

@description('Event Hubs namespace name in this resource group.')
param ehNamespaceName string

@description('ADX cluster system-assigned MI principal ID (passed as a param so it is start-time-known for the role-assignment name).')
param principalId string

@description('When true, skip the role grant (re-deploy where RBAC exists or deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

resource ns 'Microsoft.EventHub/namespaces@2024-05-01-preview' existing = {
  name: ehNamespaceName
}

resource adxMiEventHubsDataReceiver 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(principalId) && !skipRoleGrants) {
  scope: ns
  name: guid(ns.id, principalId, 'a638d3c7-ab3a-418d-83e6-5f17a39d4fde')
  properties: {
    // Azure Event Hubs Data Receiver
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'a638d3c7-ab3a-418d-83e6-5f17a39d4fde')
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
