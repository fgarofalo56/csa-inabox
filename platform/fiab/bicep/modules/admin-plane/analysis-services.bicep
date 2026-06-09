// CSA Loom — Azure Analysis Services server for the semantic-model RLS/OLS
// Security tab (Azure-native default backend; no Fabric workspace required).
//
// The Security tab authors model roles (row-level DAX filters + object-level
// table/column permissions) and runs test-as-role probes through the
// Analysis-Services XMLA endpoint. This module deploys the AAS server and wires
// its admin identity. Two facts drive the design (verified on Microsoft Learn):
//
//   1. AAS does NOT support managed identities as server admins or role members,
//      so the server admin is a dedicated service principal (aasSpnClientId),
//      formatted `app:{clientId}@{tenantId}` in asAdministrators.members.
//   2. The Console UAMI gets ARM Reader on the server so the management plane can
//      discover the server FQDN; the data-plane XMLA auth uses the SPN
//      (LOOM_AAS_CLIENT_ID / LOOM_AAS_CLIENT_SECRET), not the UAMI.
//
// When this module is NOT deployed, the Security tab renders an honest
// MessageBar (aasConfigGate) naming LOOM_AAS_SERVER — no fabricated roles. The
// editor's full surface still renders. Power BI Premium / Fabric XMLA
// (LOOM_POWERBI_XMLA_ENDPOINT) is the opt-in alternative backend; it needs no
// AAS server.

targetScope = 'resourceGroup'

@description('Location for the AAS server.')
param location string = resourceGroup().location

@description('AAS server name (3-63 lowercase alphanumerics; must be globally unique within the region).')
param serverName string

@description('AAS SKU. Default D1 (Developer tier; suspends to $0 when idle).')
@allowed(['D1', 'B1', 'B2', 'S0', 'S1', 'S2', 'S4', 'S8', 'S9'])
param sku string = 'D1'

@description('Entra tenant id used to format the AAS server-admin SPN (app:{clientId}@{tenantId}).')
param tenantId string = tenant().tenantId

@description('Service-principal client id (appId) granted AAS server-admin. REQUIRED — a managed identity cannot be an AAS admin. Empty = no admin wired (the server still deploys but is not usable until an admin is set out-of-band).')
param aasSpnClientId string

@description('Console UAMI principalId — granted ARM Reader on the AAS server for management-plane discovery. Empty = skip.')
param consolePrincipalId string = ''

@description('When true, skip the role grant (re-deploy where RBAC already exists or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

@description('Compliance / cost tags applied to the AAS server.')
param complianceTags object = {}

var tier = sku == 'D1' ? 'Development' : (startsWith(sku, 'B') ? 'Basic' : 'Standard')

resource aasServer 'Microsoft.AnalysisServices/servers@2017-08-01' = {
  name: serverName
  location: location
  sku: {
    name: sku
    tier: tier
  }
  tags: complianceTags
  properties: {
    asAdministrators: empty(aasSpnClientId) ? {
      members: []
    } : {
      members: [
        'app:${aasSpnClientId}@${tenantId}'
      ]
    }
    querypoolConnectionMode: 'All'
  }
}

// ARM Reader on the AAS server — the Console UAMI can read the server's
// serverFullName / state for the management-plane discovery the Security tab
// uses to confirm the engine is reachable. (Reader: acdd72a7-3385-48ef-bd42-f606fba81ae7)
resource aasReaderGrant 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  name: guid(aasServer.id, consolePrincipalId, 'loom-aas-reader-v1')
  scope: aasServer
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'acdd72a7-3385-48ef-bd42-f606fba81ae7')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    description: 'Loom Console UAMI: ARM Reader on the AAS server (RLS/OLS Security tab management-plane discovery).'
  }
}

@description('AAS server resource name.')
output aasServerName string = aasServer.name

@description('AAS server full data-plane name (asazure://<region>.<suffix>/<server>) for LOOM_AAS_SERVER.')
output aasServerFullName string = aasServer.properties.serverFullName
