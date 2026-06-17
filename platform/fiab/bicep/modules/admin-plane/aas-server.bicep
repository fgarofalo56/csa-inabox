// CSA Loom — Azure Analysis Services (AAS) Standard server.
//
// Hosts Import-mode (and DirectQuery / Hybrid) tabular semantic-model databases
// for CSA Loom. This is the Azure-native semantic-model backend (per
// no-fabric-dependency.md) — NO Microsoft Fabric / Power BI workspace is
// required. The Console BFF talks to it via apps/fiab-console/lib/azure/
// aas-server-client.ts over three transports:
//   • ARM (list/get databases, schedule-as-tag)            — armScope()
//   • AAS async-refresh REST (refresh now, history)        — aasScope()
//   • AAS XMLA endpoint (TMSL commands)                    — aasScope()
//
// SKU: Standard S1 (2 QPU, ~$160/mo) — the minimum Standard tier that supports
// programmatic refresh via the data-plane REST API with a service principal as
// server administrator (the Dev/D1 tier is single-user and does not support the
// non-interactive REST refresh path). Upgrade to S2/S4 for production QPU.
//
// MI Admin: the Console UAMI is added as an AAS *server administrator* using the
// canonical service-principal format  app:{clientId}@{tenantId}  (Microsoft
// Learn: "Add a service principal to the server administrator role"). The async-
// refresh REST API requires server-admin permission, which this grants. Azure
// RBAC (Reader) is also granted so the ARM list/get database calls succeed.
//
// Bicep + bootstrap sync (no-vaporware.md): main.bicep wires the module outputs
// to the Console env — LOOM_AAS_SERVER_NAME, LOOM_AAS_REGION — and sets
// NEXT_PUBLIC_LOOM_BI_BACKEND=aas so the SemanticModelEditor renders the AAS
// surface and the refresh routes dispatch to AAS by default.
//
// This module is the env-pinned server provisioner added by PR #976 (extracted
// to aas-server.bicep so it composes with the existing aas.bicep Direct-Lake-
// shim infra and analysis-services.bicep composite-model server modules).

targetScope = 'resourceGroup'

@description('Primary region.')
param location string

@description('AAS server name (lowercase alphanumerics, globally unique within the region).')
param serverName string = 'aasloom${uniqueString(resourceGroup().id)}'

@description('SKU name — Standard tier required for the data-plane refresh REST API. S0 is the smallest/cheapest Standard SKU and is broadly available; S8v2 / S9v2 are the v2 high-QPU SKUs. The legacy S8 / S9 (non-v2) SKUs are NOT offered in many regions (e.g. centralus exposes only S0, S1, S2, S4, S8v2, S9v2), so they are excluded to avoid SkuNotAvailable.')
@allowed(['S0', 'S1', 'S2', 'S4', 'S8v2', 'S9v2'])
param skuName string = 'S1'

@description('LAW resource id for diagnostic settings.')
param workspaceId string

@description('Console UAMI client id — added as AAS server admin via app:{clientId}@{tenantId}.')
param consolePrincipalClientId string

@description('Console UAMI principal (object) id — granted Reader on the AAS server for ARM list/get. Empty skips the grant.')
param consolePrincipalId string = ''

@description('Entra tenant id — forms the AAS server-admin UPN app:{clientId}@{tenantId}.')
param tenantId string = tenant().tenantId

@description('Compliance tags.')
param complianceTags object

@description('When true, skip RBAC grants (re-deploy where assignments already exist or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

resource aasServer 'Microsoft.AnalysisServices/servers@2017-08-01' = {
  name: serverName
  location: location
  tags: complianceTags
  sku: {
    name: skuName
    tier: 'Standard'
  }
  properties: {
    asAdministrators: {
      // Service-principal / managed-identity server administrators use the
      // app:{clientId}@{tenantId} format. Server-admin is required for the
      // async-refresh REST API (the data plane the Console calls).
      members: [
        'app:${consolePrincipalClientId}@${tenantId}'
      ]
    }
    // Standalone AAS server (managedMode left default = not managed). Power BI /
    // Fabric connectivity is the opt-in Fabric-family path and is NOT enabled
    // here — the Console talks to AAS Azure-native over REST + XMLA.
  }
}

resource aasDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: aasServer
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// Console UAMI → Reader on the AAS server (ARM list/get databases + read the
// loom-refresh-schedule tag). Data-plane server-admin access is granted via
// asAdministrators.members above (not Azure RBAC). Reader role id is
// cloud-invariant (identical across Commercial / GCC / GCC-High / IL5).
resource consoleAasReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: aasServer
  name: guid(aasServer.id, consolePrincipalId, 'acdd72a7-3385-48ef-bd42-f606fba81ae7')
  properties: {
    // Reader
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'acdd72a7-3385-48ef-bd42-f606fba81ae7')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output serverId string = aasServer.id
output serverName string = aasServer.name
// serverRegion is wired to LOOM_AAS_REGION in main.bicep (the AAS data-plane
// REST host is https://{serverRegion}.{aasSuffix}/servers/{serverName}/...).
output serverRegion string = location
// asazure:// connection string for SSMS / Tabular Editor. The suffix follows
// the Commercial vs USGov split (environment().suffixes.storage discriminates).
output serverUri string = 'asazure://${location}.${environment().suffixes.storage == 'core.usgovcloudapi.net' ? 'asazure.usgovcloudapi.net' : 'asazure.windows.net'}/${serverName}'
// The UPN added to the server-admin role (for audit).
output serverAdminMember string = 'app:${consolePrincipalClientId}@${tenantId}'
