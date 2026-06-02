// CSA Loom deploy-planner — Azure SignalR Service
//
// Wired by the deploy-planner catalog (key: signalr → signalrEnabled).
// Self-contained: a Standard_S1 SignalR resource in Default service mode with
// AAD-only auth (disableLocalAuth) so the Loom realtime fan-out binds to a real
// resource. The Loom Console UAMI is granted SignalR App Server + Contributor.
//
// Grounded in Microsoft Learn:
//   Microsoft.SignalRService/signalR  (Bicep resource definition)
//   https://learn.microsoft.com/azure/templates/microsoft.signalrservice/signalr

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('SignalR SKU. Free_F1 for dev, Standard_S1 for functional fan-out.')
@allowed(['Free_F1', 'Standard_S1', 'Premium_P1'])
param skuName string = 'Standard_S1'

@description('SKU capacity (unit count).')
@minValue(1)
param skuCapacity int = 1

@description('Loom Console UAMI principal ID — granted SignalR App Server (negotiate) + Contributor (ARM CRUD). Empty skips the grants.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags applied to every resource.')
param complianceTags object

var signalrName = take('signalr-loom-${uniqueString(resourceGroup().id)}', 63)

resource signalr 'Microsoft.SignalRService/signalR@2024-03-01' = {
  name: signalrName
  location: location
  tags: complianceTags
  sku: {
    name: skuName
    capacity: skuCapacity
  }
  kind: 'SignalR'
  identity: { type: 'SystemAssigned' }
  properties: {
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
    tls: {
      clientCertEnabled: false
    }
    features: [
      {
        flag: 'ServiceMode'
        value: 'Default'
      }
    ]
  }
}

// SignalR App Server — data plane negotiate (role 420fcaa2-552c-430f-98ca-3264be4806c7).
resource srAppServer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: signalr
  name: guid(signalr.id, consolePrincipalId, '420fcaa2-552c-430f-98ca-3264be4806c7')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '420fcaa2-552c-430f-98ca-3264be4806c7')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Contributor — ARM CRUD (role b24988ac-6180-42a0-ab88-20f7382dd24c).
resource srContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: signalr
  name: guid(signalr.id, consolePrincipalId, 'b24988ac-6180-42a0-ab88-20f7382dd24c')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output signalrId string = signalr.id
output signalrName string = signalr.name
output hostName string = signalr.properties.hostName
