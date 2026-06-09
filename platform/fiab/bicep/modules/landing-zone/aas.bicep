// CSA Loom DLZ — Azure Analysis Services (semantic layer, opt-in)
//
// Backs the semantic-model "Get data" (Power Query M) ingest path's Phase C:
// after an authored M mashup lands a Delta table in ADLS Gen2, the Loom BFF
// (aas-client.ts) calls the AAS asynchronous-refresh REST API to refresh the
// tabular model whose partition source points at that Delta path, making the
// table queryable. AAS is the Azure-native semantic engine — NO Microsoft
// Fabric / Power BI capacity required (no-fabric-dependency.md).
//
// OPT-IN: deployed only when deployAas=true in landing-zone/main.bicep. AAS has
// no Azure Government offering, so this module must NOT be deployed in
// GCC-High / DoD — the Console honestly gates Phase C there and directs the
// operator to Synapse Serverless OPENROWSET over the same Delta files.
//
// Server admin is NOT an Azure RBAC role — it is configured via the server
// resource's `properties.asAdministrators.members[]` (an array of UPNs / SPN
// identifiers). The Loom Console UAMI must be listed (as `app:<clientId>@<tenantId>`)
// so its managed identity can call the refresh REST API. Pass that identifier
// in `serverAdminMembers`.

targetScope = 'resourceGroup'

@description('Primary region. Must be a region where Azure Analysis Services is offered (Commercial / China only — never a Government region).')
param location string

@description('Domain name (used for resource naming).')
param domainName string = 'default'

@description('AAS SKU name. Dev/test: D1. Basic: B1/B2. Standard: S0–S9v2. Defaults to B1.')
@allowed([ 'D1', 'B1', 'B2', 'S0', 'S1', 'S2', 'S4' ])
param sku string = 'B1'

@description('AAS server administrator identifiers — UPNs and/or service principals. The Loom Console UAMI MUST be included as `app:<clientId>@<tenantId>` so its managed identity can invoke the async-refresh REST API. AAS admin is a server property, not an Azure RBAC role.')
param serverAdminMembers array

@description('Compliance tags applied to the server.')
param complianceTags object = {}

// AAS server name rules: 3–63 chars, lowercase letters + digits, must start
// with a letter. Strip non-alphanumerics from the domain and clamp length.
var rawName = toLower('aasloom${replace(domainName, '-', '')}')
var serverName = take(rawName, 63)

resource aasServer 'Microsoft.AnalysisServices/servers@2017-08-01' = {
  name: serverName
  location: location
  sku: {
    name: sku
    capacity: 1
  }
  tags: complianceTags
  properties: {
    asAdministrators: {
      members: serverAdminMembers
    }
    // Managed mode 1 = "Generally Available" (always-on). For cost control in
    // production, pause/resume the server out-of-band or move to a lower SKU.
    managedMode: 1
    querypoolConnectionMode: 'All'
  }
}

@description('AAS server resource name.')
output aasServerName string = aasServer.name

@description('AAS deployment region (the REST host subdomain).')
output aasRegion string = location

@description('AAS connection string in the SSMS/REST form — set as LOOM_AAS_SERVER on the Console app. The model name (LOOM_AAS_MODEL) is set by the operator per deployed tabular model.')
output aasConnectionString string = 'asazure://${location}.asazure.windows.net/${aasServer.name}'
