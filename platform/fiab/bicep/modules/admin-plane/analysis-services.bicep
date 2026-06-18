// CSA Loom — Azure Analysis Services server (opt-in).
//
// Hosts a COMPOSITE tabular model that mixes Import / DirectQuery / Dual
// storage modes (the semantic-model editor's per-table storage-mode picker).
// DISABLED by default (aasEnabled=false in the orchestrator) — the
// semantic-model item's Azure-native DEFAULT is the Loom-native tabular layer,
// which needs no AAS server (see .claude/rules/no-fabric-dependency.md). AAS is
// only provisioned when an operator opts into a standalone composite-model host.
//
// SKU guidance:
//   D1 (Developer, no SLA) — non-prod / test composite models
//   S1 (Standard)          — prod, ≤100 QPU, 25 GB
//   S2 / S4                — higher QPU + memory
//
// Apply path: full TMSL (createOrReplace / per-partition mode) is issued via
// XMLA (Invoke-ASCmd / TOM) or the Fabric updateDefinition REST API — the AAS
// REST surface itself only exposes async refresh. The Console UAMI is added to
// the AAS server-admin list so it can issue those XMLA commands; an ARM Reader
// grant gives it control-plane visibility.
//
// Env vars wired by main.bicep into the Console container (only when enabled):
//   LOOM_AAS_ENDPOINT  = serverFullName (asazure://<region>.asazure.windows.net/<server>)
//   LOOM_AAS_DATABASE  = aasDatabase
//
// Sovereign notes:
//   Commercial / GCC → asazure.windows.net           (Dual via Premium/Fabric)
//   GCC-High / IL5   → asazure.usgovcloudapi.net      (Dual NOT supported in
//                      standalone AAS; the BFF rejects Dual at Gov boundaries)

targetScope = 'resourceGroup'

@description('Azure region')
param location string

@description('AAS server name (3–63 chars, lowercase letters/numbers)')
@minLength(3)
@maxLength(63)
param serverName string = 'aasloom'

@description('AAS SKU name. Standard tier only — S0 is the smallest/cheapest Standard SKU and is broadly available. Developer (D1) and Basic (B1/B2) tiers are not offered in many regions (centralus exposes only S0, S1, S2, S4, S8v2, S9v2), so they are excluded here to avoid SkuNotAvailable on a day-one deploy.')
@allowed(['S0', 'S1', 'S2', 'S4', 'S8v2', 'S9v2'])
param skuName string = 'S0'

@description('SKU tier — Standard for every selectable skuName above.')
@allowed(['Standard'])
param skuTier string = 'Standard'

@description('AAS database / model name wired into LOOM_AAS_DATABASE')
param aasDatabase string = 'LoomComposite'

@description('Console UAMI principal id (object id) — granted ARM Reader on the AAS server.')
param consolePrincipalId string

@description('AAS server-administrator identity (UPN, or app:<clientId>@<tenantId> for an SP). Listed in asAdministrators so it can issue XMLA TMSL commands.')
param aasAdminUpn string

@description('Skip role-assignment grants — set true when re-provisioning to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags')
param tags object = {}

resource aasServer 'Microsoft.AnalysisServices/servers@2017-08-01' = {
  name: serverName
  location: location
  sku: {
    name: skuName
    tier: skuTier
    capacity: 1
  }
  tags: tags
  properties: {
    asAdministrators: {
      // AAS admin list — the Console identity must be here to issue TMSL via
      // XMLA (Invoke-ASCmd / TOM). SP format: 'app:<clientId>@<tenantId>'.
      members: [
        aasAdminUpn
      ]
    }
    querypoolConnectionMode: 'All'
  }
}

// ARM Reader for the Console UAMI (control-plane visibility; the AAS admin list
// above grants the data-plane XMLA rights).
//
// The role-assignment NAME is the stable guid(scope, principalId, readerRoleId)
// — i.e. the actual Reader role definition GUID, NOT a literal 'reader' string.
// Azure dedupes a role assignment by (principal, role, scope), so when this
// composite-model module and aas-server.bicep both target the SAME server
// (admin-plane/main.bicep passes the identical `aasloom${uniqueString}` name to
// both when aasEnabled), the prior literal-'reader' name produced a DIFFERENT
// assignment GUID for the same (principal,role,scope) tuple — Azure then failed
// with RoleAssignmentExists (pass-6 centralus deploy 2026-06-17). Using the real
// role GUID here makes both modules compute the identical assignment name; and
// admin-plane/main.bicep additionally passes skipRoleGrants:true to the shared
// `aas` instantiation so aas-server.bicep is the SINGLE owner of this grant.
var readerRoleId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
resource aasReaderRbac 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants && !empty(consolePrincipalId)) {
  name: guid(aasServer.id, consolePrincipalId, readerRoleId)
  scope: aasServer
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', readerRoleId) // Reader
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

@description('AAS serverFullName for LOOM_AAS_ENDPOINT (asazure://…)')
output serverFullName string = aasServer.properties.serverFullName

@description('asazure:// connection string for LOOM_AAS_SERVER_URL (used by the column metadata editor via XMLA Alter/Create — see PR #984).')
output aasServerUrl string = 'asazure://${aasServer.properties.serverFullName}/${aasServer.name}'

@description('Bare AAS resource name.')
output aasServerName string = aasServer.name

@description('AAS database name for LOOM_AAS_DATABASE')
output database string = aasDatabase
