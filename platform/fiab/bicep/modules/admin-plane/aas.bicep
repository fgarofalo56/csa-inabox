// CSA Loom — Azure Analysis Services Standard server for the BI stack.
//
// Backs the semantic-model "analysis-services" backend and the Direct Lake
// shim's TOM partition-refresh path (apps/fiab-direct-lake-shim). The
// loom-direct-lake UAMI is configured as a server administrator so the shim
// can connect over the XMLA read/write endpoint (Standard tier) with its
// managed identity and issue RequestRefresh against the deployed models.
//
// NO Fabric / Power BI workspace dependency: AAS is a standalone Azure PaaS
// tabular engine. The model's data sources are Synapse / ADLS (Azure-native).
// Per no-fabric-dependency.md this is an OPT-IN alternative to the default
// loom-native tabular layer — the Console only routes here when
// LOOM_BI_BACKEND=analysis-services AND this server is deployed.
//
// Cloud matrix: AAS is GA only in Commercial regions. It is NOT offered in
// US Gov Virginia (GCC / GCC-High / IL5), so the caller gates this module on
// `aasEnabled && boundary == 'Commercial'`. On Gov boundaries the semantic
// model provisioner falls through to the loom-native backend (honest, no gate).

targetScope = 'resourceGroup'

@description('Primary region (Commercial AAS region, e.g. eastus2).')
param location string

@description('AAS Standard SKU. S0 is the smallest billable Standard tier; S1/S2/S4/S8v2/S9v2 add query-replica scale-out for production DAX load.')
@allowed(['S0', 'S1', 'S2', 'S4', 'S8v2', 'S9v2'])
param aasSkuName string = 'S0'

@description('clientId (appId GUID) of the loom-direct-lake UAMI. Added as an AAS server administrator (app:<clientId>@<tenantId>) so the Direct Lake shim can connect over XMLA and refresh partitions with its managed identity.')
param uamiDirectLakeClientId string

@description('Compliance tags applied to the AAS server.')
param complianceTags object

// AAS server names must match ^[a-z][a-z0-9]{2,62}$ (lowercase, start with a
// letter, <=63 chars). uniqueString gives a stable lowercase-alphanumeric
// suffix; take(24) keeps the XMLA URL well under length limits.
var serverName = take('aasloom${uniqueString(resourceGroup().id)}', 24)

resource aas 'Microsoft.AnalysisServices/servers@2017-08-01' = {
  name: serverName
  location: location
  tags: complianceTags
  sku: {
    name: aasSkuName
    tier: 'Standard'
    capacity: 1
  }
  properties: {
    // The Direct Lake shim's managed identity is a server administrator so it
    // can open an XMLA read/write session (Standard tier) and RequestRefresh.
    // Service-principal admin format is app:<appId>@<tenantId>.
    asAdministrators: {
      members: [
        'app:${uamiDirectLakeClientId}@${tenant().tenantId}'
      ]
    }
    // Standard tier exposes the XMLA read/write endpoint required by TOM.
    querypoolConnectionMode: 'All'
  }
}

@description('AAS server short name (LOOM_AAS_SERVER_NAME).')
output aasServerName string = aas.name

@description('AAS XMLA read/write endpoint (asazure://<region>.asazure.windows.net/<server>) — LOOM_AAS_XMLA_ENDPOINT. The TOM client (TomRefreshClient.ConnectServer) connects here.')
output aasXmlaEndpoint string = aas.properties.serverFullName

@description('Server administrator principal string for out-of-band data-plane grants (Synapse db_datareader CREATE USER ... FROM EXTERNAL PROVIDER). Format app:<clientId>@<tenantId>.')
output aasAdminPrincipalString string = 'app:${uamiDirectLakeClientId}@${tenant().tenantId}'
