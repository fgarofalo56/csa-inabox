// CSA Loom DLZ — Azure Analysis Services (datamart-migration target + opt-in semantic engine).
//
// One AAS server backs THREE azure-native, no-Fabric surfaces:
//
//   1. Datamart migration target — the migrate BFF route
//      (/api/items/datamart/migrate) provisions a Synapse Serverless DB + this
//      AAS server as the Azure-native replacement for a Power BI datamart's
//      storage + semantic model. Idempotent ARM PUT, no-op on subsequent runs.
//   2. Model view XMLA write path — relationships + drill hierarchies authored
//      in the Loom editor can be pushed as TMSL to a live tabular engine
//      (aas-client.ts XMLA exec) for Excel / SSMS XMLA drill-through.
//   3. "Get data" (Power Query M) ingest refresh — after an authored M mashup
//      lands a Delta table in ADLS Gen2, the Loom BFF calls the AAS
//      asynchronous-refresh REST API to refresh the partition source.
//
// Per .claude/rules/no-fabric-dependency.md the semantic model's DEFAULT
// backend is the Loom-native tabular layer (Cosmos + the TMSL preview) — it
// works with NO Analysis Services server and NO Fabric workspace. AAS is the
// azure-native option for operators who want a live tabular engine. Provisioned
// ONLY when the caller selects it.
//
// AAS is first-party Azure PaaS — NO Fabric / Power BI capacity required:
//   Commercial / GCC : ARM management.azure.com,        asazure.windows.net
//   GCC-High / IL5   : ARM management.usgovcloudapi.net, asazure.usgovcloudapi.net
//   DoD              : same as GCC-High (US DoD IL5 PA scope per Microsoft Learn)
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
//   `app:<clientId>@<tenantId>`) so its managed identity can invoke the XMLA
//   write / async-refresh REST APIs. When `consoleUamiAppId` is provided, the
//   module stamps it into asAdministrators automatically; otherwise the
//   `serverAdminMembers` array is used verbatim.
//
// Env wiring (admin-plane/main.bicep apps[] env list):
//   LOOM_AAS_XMLA_ENDPOINT  → output xmlaEndpoint
//   LOOM_AAS_SERVER         → output aasConnectionString
//   LOOM_AAS_SCOPE          → per-cloud resource scope (set in the client)

targetScope = 'resourceGroup'

// ---- Naming -----------------------------------------------------------------
// EITHER `name` (preferred, used by the DLZ semantic-engine caller) OR
// `domainName` (used by the datamart-migration caller) must be supplied; if
// `name` is empty the server is named `loom<domainName>`.

@description('Analysis Services server name (3-63 lowercase alphanumerics, must start with a letter). When empty, derived from domainName as `loom<domainName>`.')
param name string = ''

@description('Domain name (used when `name` is empty: derives `loom<domainName>`).')
param domainName string = ''

@description('Deployment location. Must be a region where Azure Analysis Services is offered (Commercial / China only — never a Government region).')
param location string = resourceGroup().location

// ---- SKU --------------------------------------------------------------------
// Accept BOTH `skuName` (DLZ caller) and `aasSku` (datamart-migration caller).
// `aasSku` wins when both are set so the datamart override flows through.

@description('AAS SKU name. D1 = Developer (cheapest); B1/B2 = Basic; S0-S4 = Standard query pools.')
@allowed([ 'D1', 'B1', 'B2', 'S0', 'S1', 'S2', 'S4' ])
param skuName string = 'D1'

@description('Alias of skuName preserved for the datamart-migration caller. When non-empty (and not D1), overrides skuName.')
@allowed([ '', 'D1', 'B1', 'B2', 'S0', 'S1', 'S2', 'S4' ])
param aasSku string = ''

// ---- Admin model ------------------------------------------------------------

@description('AAS server administrator identifiers — UPNs and/or service principals (`app:<clientId>@<tenantId>`). The Loom Console UAMI must be included so its MI can invoke the XMLA write / async-refresh REST APIs. AAS admin is a server property, not an Azure RBAC role. Empty (and no consoleUamiAppId) = the editor honestly gates the live-engine write; the Loom-native Cosmos path still works.')
param serverAdminMembers array = []

@description('Loom Console UAMI application/client id. When non-empty, stamped into asAdministrators as `app:<consoleUamiAppId>@${subscription().tenantId}` and merged with serverAdminMembers.')
param consoleUamiAppId string = ''

// ---- Role grant (datamart-migration caller) --------------------------------

@description('Loom Console UAMI principal (object) id — granted Contributor on the AAS server so the migrate BFF route (aas-client.ts) can PUT/GET it via the UAMI credential. Empty = skipped.')
param consolePrincipalId string = ''

@description('Skip ARM role assignment (e.g. when already granted out-of-band).')
param skipRoleGrants bool = false

@description('Standardized compliance tags applied to the server.')
param complianceTags object = {}

// ---- Derived values ---------------------------------------------------------

var resolvedName = !empty(name)
  ? name
  : take('loom${toLower(domainName)}', 63)
var resolvedSku = !empty(aasSku) ? aasSku : skuName
var skuTier = resolvedSku == 'D1'
  ? 'Development'
  : (startsWith(resolvedSku, 'B') ? 'Basic' : 'Standard')

// AAS data-plane suffix — Gov vs Commercial, derived from the storage suffix.
var isGov = environment().suffixes.storage == 'core.usgovcloudapi.net'
var aasSuffix = isGov ? 'asazure.usgovcloudapi.net' : 'asazure.windows.net'

// Auto-stamp the Console UAMI SP into asAdministrators when its appId is supplied.
var uamiAdminMember = !empty(consoleUamiAppId)
  ? [ 'app:${consoleUamiAppId}@${subscription().tenantId}' ]
  : []
var resolvedAdminMembers = union(serverAdminMembers, uamiAdminMember)

// Built-in Contributor role id.
var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'

resource aasServer 'Microsoft.AnalysisServices/servers@2017-08-01' = {
  name: resolvedName
  location: location
  tags: complianceTags
  sku: {
    name: resolvedSku
    tier: skuTier
    capacity: 1
  }
  properties: {
    asAdministrators: {
      // AAS supports UPNs, group object ids, and SP `app:<applicationId>@<tenantId>`
      // identifiers only — SP object ids are NOT accepted here.
      members: resolvedAdminMembers
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

// ---- Outputs ----------------------------------------------------------------

@description('AAS server resource name.')
output serverName string = aasServer.name
@description('Alias of serverName (datamart-migration / Power Query ingest naming).')
output aasServerName string = aasServer.name
@description('AAS server resource id.')
output aasServerId string = aasServer.id
@description('AAS deployment region (the REST host subdomain).')
output aasRegion string = location
@description('AAS server fullname (e.g. asazure://<region>.<suffix>/<server>).')
output serverFullName string = aasServer.properties.serverFullName
@description('XMLA endpoint backing the Model view write path → LOOM_AAS_XMLA_ENDPOINT.')
output xmlaEndpoint string = 'https://${location}.${aasSuffix}/servers/${resolvedName}/xmla'
@description('AAS connection string in the SSMS/REST form → LOOM_AAS_SERVER on the Console app. LOOM_AAS_MODEL is set per deployed tabular model by the operator.')
output aasConnectionString string = 'asazure://${location}.${aasSuffix}/${aasServer.name}'
@description('Alias of aasConnectionString (datamart-migration receipt naming).')
output aasConnectionUri string = 'asazure://${location}.${aasSuffix}/${aasServer.name}'
@description('One-time bootstrap reminder: add the Console UAMI SP to asAdministrators via the AAS Management REST API.')
output asAdminNote string = 'Add the Console UAMI service principal to ${resolvedName} asAdministrators (PATCH servers/${resolvedName}) — Bicep stamps `app:<consoleUamiAppId>@<tenantId>` automatically when provided.'
