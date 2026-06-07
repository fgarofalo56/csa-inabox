// CSA Loom - RTI hub cross-subscription discovery RBAC
//
// The Real-Time Intelligence hub catalog (/rti-hub -> GET /api/rti-hub)
// enumerates every Event Hub namespace, IoT Hub, and ADX (Kusto) cluster the
// Console UAMI can see across the subscription via Azure Resource Graph
// (lib/azure/eventhubs-client.ts -> listStreamingResourcesViaGraph).
//
// Resource Graph honors RBAC: a resource appears in results ONLY where the
// querying principal has at least Reader. The Console UAMI's other grants are
// resource-group-scoped (per-resource data plane + RG Reader), so without a
// subscription-scoped Reader the graph query returns [] and the hub looks
// empty. Reader is read-only - the least-privilege grant that lights up
// cross-RG discovery.
//
// Subscription scope (vs. inlining in main.bicep) so consolePrincipalId - a
// module OUTPUT in main.bicep - arrives as a plain start-time-known param,
// satisfying the role-assignment name/if requirement (avoids BCP177/BCP120),
// the same pattern as admin-plane/scaling-rbac.bicep.

targetScope = 'subscription'

@description('Console UAMI principalId - granted Reader at this subscription scope so the RTI hub can discover Event Hubs / IoT Hub / ADX via Resource Graph. Empty string skips the grant.')
param consolePrincipalId string

@description('When true, skip the role grant (e.g. re-deploy where RBAC already exists or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

// Reader - acdd72a7-3385-48ef-bd42-f606fba81ae7
resource rtiHubArgReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  name: guid(subscription().id, consolePrincipalId, 'rti-hub-arg-reader')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'acdd72a7-3385-48ef-bd42-f606fba81ae7')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}
