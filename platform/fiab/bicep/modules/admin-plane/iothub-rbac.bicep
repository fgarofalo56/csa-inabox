// CSA Loom — IoT Hub navigator RBAC for the Eventstream "IoT Hub" source.
//
// An Eventstream IoT Hub source (lib/azure/iothub-client.ts) does NOT use the
// device-facing data plane. It reads the hub's BUILT-IN Event Hubs-compatible
// endpoint (properties.eventHubEndpoints.events). For that the Console UAMI
// needs two grants on the target IoT Hub resource:
//
//   Reader — acdd72a7-3385-48ef-bd42-f606fba81ae7
//     ARM GET on Microsoft.Devices/IotHubs to resolve the built-in endpoint
//     FQDN + entity path the source consumes.
//   Azure Event Hubs Data Receiver — a638d3c7-ab3a-418d-83e6-5f17a39d4fde
//     Entra data-plane receive on the hub's built-in Event Hubs endpoint, so
//     the source reads events with the managed identity (no SAS keys).
//
// Both role definition GUIDs are cloud-agnostic (identical in Commercial / GCC /
// GCC-High / IL5 / DoD). The module is scoped to the IoT Hub's own resource so
// the grant is least-privilege (this hub only, not the whole RG/subscription).
//
// Opt-in: only deployed when loomIotHubResourceId is set (main.bicep gates on
// !empty). When unset, the editor surfaces an honest-gate MessageBar naming the
// runtime-selected hub + these two roles (per no-vaporware.md) instead.
//
// Split into its own module (consolePrincipalId is a main.bicep OUTPUT — BCP177)
// — same pattern as sql-rbac.bicep / cosmos-navigator-keys-rbac.bicep.

targetScope = 'resourceGroup'

@description('IoT Hub name (the resource must exist in THIS resource group). Derived in main.bicep from loomIotHubResourceId.')
param iotHubName string

@description('Console UAMI principalId — granted Reader + Event Hubs Data Receiver on the IoT Hub. Empty string skips the grant.')
param consolePrincipalId string = ''

@description('When true, skip all role grants (re-deploy where RBAC already exists or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

resource iotHub 'Microsoft.Devices/IotHubs@2023-06-30' existing = {
  name: iotHubName
}

// Reader — acdd72a7-3385-48ef-bd42-f606fba81ae7
// Lets the Console UAMI GET the hub and resolve the built-in EH endpoint.
resource readerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: iotHub
  name: guid(iotHub.id, consolePrincipalId, 'loom-iothub-reader-v1')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'acdd72a7-3385-48ef-bd42-f606fba81ae7')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    description: 'Loom Console UAMI: resolve the IoT Hub built-in Event Hubs endpoint (ARM GET) for the Eventstream IoT Hub source.'
  }
}

// Azure Event Hubs Data Receiver — a638d3c7-ab3a-418d-83e6-5f17a39d4fde
// Entra data-plane receive on the built-in endpoint (no SAS keys).
resource ehReceiverRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: iotHub
  name: guid(iotHub.id, consolePrincipalId, 'loom-iothub-eh-receiver-v1')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'a638d3c7-ab3a-418d-83e6-5f17a39d4fde')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    description: 'Loom Console UAMI: receive events from the IoT Hub built-in Event Hubs-compatible endpoint with the managed identity.'
  }
}

output roleAssigned bool = !empty(consolePrincipalId) && !skipRoleGrants
