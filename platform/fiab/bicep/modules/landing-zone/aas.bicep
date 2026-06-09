// CSA Loom DLZ — Azure Analysis Services (optional, opt-in semantic engine)
//
// One AAS server backs TWO azure-native, no-Fabric semantic-model surfaces:
//
//   1. Model view XMLA write path — relationships + drill hierarchies authored
//      in the Loom editor can be pushed as TMSL to a live tabular engine
//      (aas-client.ts XMLA exec) for Excel / SSMS XMLA drill-through.
//   2. "Get data" (Power Query M) ingest refresh — after an authored M mashup
//      lands a Delta table in ADLS Gen2, the Loom BFF calls the AAS
//      asynchronous-refresh REST API to refresh the partition source, making
//      the table queryable.
//
// Per .claude/rules/no-fabric-dependency.md the semantic model's DEFAULT
// backend is the Loom-native tabular layer (Cosmos + the TMSL preview) — it
// works with NO Analysis Services server and NO Fabric workspace. AAS is the
// azure-native option for operators who want a live tabular engine. Provisioned
// ONLY when enableAas=true.
//
// AAS has no Azure Government offering, so this module must NOT be deployed in
// GCC-High / DoD — the Console honestly gates the AAS phases there and directs
// the operator to Synapse Serverless OPENROWSET over the same Delta files.
//
// Posture:
//   - Developer tier (D1) by default — cheapest QPU, no read-only replicas.
//     Set skuName to B1/B2 (Basic) or S0/S1 (Standard) for production pools.
//   - Power BI service access enabled on the firewall (no IP rules by default).
//   - querypoolConnectionMode 'All'; managedMode 1 (always-on).
//
// Admin model (one-time bootstrap, surfaced via the asAdminNote output):
//   Azure Analysis Services uses its OWN administrator model (server
//   asAdministrators), NOT Azure RBAC. The Console UAMI must be listed (as
//   `app:<clientId>@<tenantId>`) in serverAdminMembers so its managed identity
//   can invoke the XMLA write / async-refresh REST APIs. Bicep cannot resolve a
//   UAMI to that identifier automatically, so when serverAdminMembers is empty
//   the editor's XMLA/refresh write surfaces an honest MessageBar and the
//   Loom-native (Cosmos) path keeps working. See docs/fiab/v3-tenant-bootstrap.md.
//
// Env wiring (admin-plane/main.bicep apps[] env list):
//   LOOM_AAS_XMLA_ENDPOINT  → output xmlaEndpoint
//   LOOM_AAS_SERVER         → output aasConnectionString
//   LOOM_AAS_SCOPE          → per-cloud resource scope (set in the client)

@description('Analysis Services server name (3-63 lowercase alphanumerics, must start with a letter).')
param name string

@description('Deployment location. Must be a region where Azure Analysis Services is offered (Commercial / China only — never a Government region).')
param location string = resourceGroup().location

@description('SKU name. D1 = Developer tier (cheapest); B1/B2 = Basic; S0–S4 = Standard query pools.')
@allowed([ 'D1', 'B1', 'B2', 'S0', 'S1', 'S2', 'S4' ])
param skuName string = 'D1'

@description('AAS server administrator identifiers — UPNs and/or service principals. The Loom Console UAMI must be included as `app:<clientId>@<tenantId>` so its managed identity can invoke the XMLA write / async-refresh REST APIs. AAS admin is a server property, not an Azure RBAC role. Empty = the editor honestly gates the live-engine write; the Loom-native Cosmos path still works.')
param serverAdminMembers array = []

@description('Standardized compliance tags applied to the server.')
param complianceTags object = {}

resource aasServer 'Microsoft.AnalysisServices/servers@2017-08-01' = {
  name: name
  location: location
  tags: complianceTags
  sku: {
    name: skuName
    tier: skuName == 'D1' ? 'Development' : (startsWith(skuName, 'B') ? 'Basic' : 'Standard')
    capacity: 1
  }
  properties: {
    asAdministrators: {
      members: serverAdminMembers
    }
    // Managed mode 1 = "Generally Available" (always-on). For cost control in
    // production, pause/resume the server out-of-band or move to a lower SKU.
    managedMode: 1
    querypoolConnectionMode: 'All'
    ipV4FirewallSettings: {
      firewallRules: []
      enablePowerBIService: true
    }
  }
}

@description('AAS server resource name.')
output serverName string = aasServer.name
@description('Alias of serverName (Power Query ingest path naming).')
output aasServerName string = aasServer.name
@description('XMLA endpoint backing the Model view write path → LOOM_AAS_XMLA_ENDPOINT.')
output xmlaEndpoint string = 'https://${location}.asazure.windows.net/servers/${name}/xmla'
@description('AAS deployment region (the REST host subdomain).')
output aasRegion string = location
output serverFullName string = aasServer.properties.serverFullName
@description('AAS connection string in the SSMS/REST form → LOOM_AAS_SERVER on the Console app. LOOM_AAS_MODEL is set per deployed tabular model by the operator.')
output aasConnectionString string = 'asazure://${location}.asazure.windows.net/${aasServer.name}'
@description('One-time bootstrap reminder: add the Console UAMI SP to asAdministrators via the AAS Management REST API.')
output asAdminNote string = 'Add the Console UAMI service principal to ${name} asAdministrators (PATCH servers/${name}) — Bicep cannot set AAS admins declaratively.'
