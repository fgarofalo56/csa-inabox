// CSA Loom — Azure Analysis Services (AAS) server for datamart migration targets.
//
// Datamarts are deprecated; the migrate BFF route (/api/items/datamart/migrate)
// provisions a Synapse Serverless database + an AAS server as the Azure-native
// replacement for a Power BI datamart's storage + semantic model. This module
// declaratively deploys one AAS tabular server per landing zone so the runtime
// PUT is a no-op (idempotent) and infra/runtime stay in sync.
//
// AAS is first-party Azure PaaS — NO Fabric / Power BI capacity required:
//   Commercial / GCC : ARM management.azure.com,        asazure.windows.net
//   GCC-High / IL5   : ARM management.usgovcloudapi.net, asazure.usgovcloudapi.net
//   DoD              : same as GCC-High (US DoD IL5 PA scope per Microsoft Learn)
//
// The console app's LOOM_UAMI_CLIENT_ID (the UAMI application/client id) +
// LOOM_ENTRA_TENANT_ID let the migrate route construct the AAS admin SP
// identifier `app:<clientId>@<tenantId>`, matching asAdministrators below.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Domain name (used in resource naming; lowercased)')
param domainName string

@description('AAS SKU — B1 (Basic) is cheapest. Use S1+ for larger in-memory models.')
@allowed([ 'D1', 'B1', 'B2', 'S0', 'S1', 'S2', 'S4' ])
param aasSku string = 'B1'

@description('Loom Console UAMI principal (object) id — granted Contributor so the migrate route can PUT/GET the server.')
param consolePrincipalId string = ''

@description('Loom Console UAMI application/client id — stamped in asAdministrators as app:<appId>@<tenantId>.')
param consoleUamiAppId string = ''

@description('Skip ARM role assignment (e.g. when already granted out-of-band).')
param skipRoleGrants bool = false

@description('Compliance tags')
param complianceTags object

// AAS server name: lowercase, 3-63 chars, [a-z][a-z0-9]*.
var serverName = take('loom${toLower(domainName)}', 63)

// Tier derived from SKU prefix (D->Development, B->Basic, else Standard).
var skuTier = startsWith(aasSku, 'D') ? 'Development' : (startsWith(aasSku, 'B') ? 'Basic' : 'Standard')

// AAS data-plane suffix — Gov vs Commercial, derived from the storage suffix so
// no hard-coded cloud boundary lives here (same env()-driven pattern as synapse).
var isGov = environment().suffixes.storage == 'core.usgovcloudapi.net'
var aasSuffix = isGov ? 'asazure.usgovcloudapi.net' : 'asazure.windows.net'

// Contributor role definition id (built-in).
var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'

resource aasServer 'Microsoft.AnalysisServices/servers@2017-08-01' = {
  name: serverName
  location: location
  tags: complianceTags
  sku: {
    name: aasSku
    tier: skuTier
    capacity: 1
  }
  properties: {
    managedMode: 1
    asAdministrators: {
      // AAS supports UPNs, group object ids, and SP `app:<applicationId>@<tenantId>`
      // identifiers only — SP object ids are NOT accepted here.
      members: !empty(consoleUamiAppId) ? [ 'app:${consoleUamiAppId}@${subscription().tenantId}' ] : []
    }
  }
}

// Grant the Console UAMI Contributor on the AAS server so the migrate BFF route
// (aas-client.ts) can PUT/GET it via the UAMI credential.
resource aasContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: aasServer
  name: guid(aasServer.id, consolePrincipalId, contributorRoleId)
  properties: {
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributorRoleId)
  }
}

output aasServerName string = aasServer.name
output aasServerId string = aasServer.id
output aasConnectionUri string = 'asazure://${location}.${aasSuffix}/${serverName}'
