// CSA Loom DLZ — Azure Service Bus namespace (Microsoft.ServiceBus/namespaces)
//
// Backs the `service-bus-namespace` item + servicebus-client.ts: a navigator over
// the deployment-pinned Service Bus namespace (queues + topics CRUD). Azure-native,
// no Microsoft Fabric dependency (no-fabric-dependency.md) — Service Bus is a
// first-class Azure messaging service, parity for the Fabric/Activator "reliable
// queue / pub-sub" surface.
//
// Posture (mirrors the sibling eventhubs.bicep / adf.bicep DLZ modules):
//   - System-assigned identity
//   - publicNetworkAccess: Disabled (private link only)
//   - PE on snet-private-endpoints (groupId 'namespace') reached over hub→spoke
//     peering from the Loom Console; shares the privatelink.servicebus.windows.net
//     private DNS zone with Event Hubs (same zone covers both services)
//   - RBAC: Loom Console UAMI → "Azure Service Bus Data Owner" (data plane:
//     send/receive + entity ownership) + "Contributor" (ARM control-plane CRUD of
//     queues / topics / subscriptions). Both gated behind skipRoleGrants.
//   - Diagnostic settings → standardized Loom LAW
//   - Standard tier — REQUIRED for topics (Basic supports queues only); the item
//     creates both queues and topics.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Domain name (used for resource naming).')
param domainName string = 'default'

@description('Service Bus SKU tier. Standard is required for topics/subscriptions (the item creates both). Premium adds VNet/zone-redundancy at higher cost.')
@allowed([
  'Standard'
  'Premium'
])
param skuName string = 'Standard'

@description('Loom Console UAMI principal ID — granted Azure Service Bus Data Owner (data plane) + Contributor (ARM control plane) on the namespace so the service-bus-namespace navigator can create/list/delete queues + topics. Empty skips the grants.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Spoke private-endpoint subnet ID (snet-private-endpoints).')
param privateEndpointSubnetId string

@description('Private DNS zone resource ID for privatelink.servicebus.windows.net (shared with Event Hubs) — must be linked to hub + spoke VNets. Empty = the PE registers but its DNS zone group is skipped (the namespace still provisions; DNS resolves once the zone is added). Decoupled so a missing zone never silently skips the whole namespace (adf.bicep pattern).')
param privateDnsZoneServicebusId string = ''

@description('Log Analytics workspace ID for diagnostic settings. Empty (dlz-attach with no hub LAW coordinate) skips the diagnostic settings.')
param workspaceId string = ''

@description('Disable local (SAS key) authentication on the namespace. Defaults true (Entra-only — the secure default and the only allowed posture at IL5/GCC-High). Set false ONLY in Commercial deployments where a custom app must connect with a SAS connection string.')
param disableLocalAuth bool = true

@description('Compliance tags applied to every resource.')
param complianceTags object

// =====================================================================
// Service Bus namespace
// =====================================================================

resource ns 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: 'sbns-loom-${domainName}-${location}'
  location: location
  tags: complianceTags
  sku: {
    name: skuName
    tier: skuName
  }
  identity: { type: 'SystemAssigned' }
  properties: {
    publicNetworkAccess: 'Disabled'
    disableLocalAuth: disableLocalAuth
    minimumTlsVersion: '1.2'
  }
}

// Per-queue / per-topic entities are created at runtime by the
// service-bus-namespace navigator (PUT .../queues|topics), not at namespace
// deploy time — mirroring the Event Hubs module's per-hub creation model.

// =====================================================================
// Private endpoint (namespace data + management plane)
// =====================================================================

resource pe 'Microsoft.Network/privateEndpoints@2024-03-01' = {
  name: 'pe-${ns.name}'
  location: location
  tags: complianceTags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'sbns-link'
        properties: {
          privateLinkServiceId: ns.id
          groupIds: [ 'namespace' ]
        }
      }
    ]
  }
}

resource peDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-03-01' = if (!empty(privateDnsZoneServicebusId)) {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'sb-zone', properties: { privateDnsZoneId: privateDnsZoneServicebusId } }
    ]
  }
}

// =====================================================================
// Diagnostic settings → standardized Loom LAW
// =====================================================================

resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  scope: ns
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'OperationalLogs', enabled: true }
      { category: 'VNetAndIPFilteringLogs', enabled: true }
      { category: 'RuntimeAuditLogs', enabled: true }
      { category: 'ApplicationMetricsLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// =====================================================================
// RBAC — Loom Console UAMI grants
// =====================================================================

// Azure Service Bus Data Owner — data plane (send/receive + entity ownership).
// Role GUID 090c5cfd-751d-490a-894a-3ce6f1109419.
resource sbDataOwnerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: ns
  name: guid(ns.id, consolePrincipalId, '090c5cfd-751d-490a-894a-3ce6f1109419')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '090c5cfd-751d-490a-894a-3ce6f1109419')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Contributor (namespace scope only) — ARM control-plane CRUD of queues, topics,
// subscriptions, and authorization rules. Role GUID b24988ac-6180-42a0-ab88-20f7382dd24c.
resource sbContributorRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: ns
  name: guid(ns.id, consolePrincipalId, 'b24988ac-6180-42a0-ab88-20f7382dd24c')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output namespaceId string = ns.id
output namespaceName string = ns.name
output namespacePrincipalId string = ns.identity.principalId
// Sovereign-cloud Service Bus FQDN, derived from the storage suffix the same way
// eventhubs.bicep derives its namespace FQDN (Commercial/GCC servicebus.windows.net;
// GCC-High/IL5 servicebus.usgovcloudapi.net).
output namespaceFqdn string = '${ns.name}.servicebus.${environment().suffixes.storage == 'core.usgovcloudapi.net' ? 'usgovcloudapi.net' : 'windows.net'}'
