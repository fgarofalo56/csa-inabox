// CSA Loom DLZ — Azure Analysis Services (optional, opt-in)
//
// Backs the OPTIONAL XMLA write path of the Loom semantic-model "Model view"
// (relationships + drill hierarchies). Per .claude/rules/no-fabric-dependency.md
// the semantic model's DEFAULT backend is the Loom-native tabular layer (Cosmos
// + the TMSL preview) — it works with NO Analysis Services server and NO Fabric
// workspace. Azure Analysis Services is the azure-native, no-Fabric option for
// operators who want relationship/hierarchy edits pushed to a live tabular
// engine (e.g. for Excel / SSMS XMLA drill-through). It is provisioned ONLY when
// enableAas=true.
//
// Posture:
//   - Developer tier (D1) by default — cheapest QPU, no read-only replicas.
//     Set skuName to S0/S1 (Standard tier) for production query pools.
//   - Power BI service access enabled on the firewall (no IP rules by default).
//   - querypoolConnectionMode 'All'.
//
// Admin model (one-time bootstrap, surfaced via the asAdminNote output):
//   Azure Analysis Services uses its OWN administrator model (server
//   asAdministrators), NOT Azure RBAC, so the Console UAMI cannot be added as a
//   server admin declaratively without knowing its UPN-form identity. After
//   deploy, add the Console UAMI's service principal to the server admins via
//   the AAS Management REST API (PATCH servers/{name} asAdministrators) — see
//   docs/fiab/v3-tenant-bootstrap.md. Until then the editor's XMLA write surfaces
//   an honest MessageBar; the Loom-native (Cosmos) path keeps working.
//
// Env wiring (admin-plane/main.bicep apps[] env list):
//   LOOM_AAS_XMLA_ENDPOINT  → output xmlaEndpoint
//   LOOM_AAS_SCOPE          → per-cloud resource scope (Commercial default in the client)

@description('Analysis Services server name (3-63 lowercase alphanumerics).')
param name string

@description('Deployment location.')
param location string = resourceGroup().location

@description('SKU name. D1 = Developer tier (cheapest); S0/S1 = Standard tier query pools.')
@allowed([ 'D1', 'S0', 'S1', 'S2' ])
param skuName string = 'D1'

@description('Standardized compliance tags applied to the server.')
param complianceTags object = {}

resource aasServer 'Microsoft.AnalysisServices/servers@2017-08-01' = {
  name: name
  location: location
  tags: complianceTags
  sku: {
    name: skuName
    tier: skuName == 'D1' ? 'Development' : 'Standard'
    capacity: 1
  }
  properties: {
    // Server admins are set post-deploy via the Management REST API (see header).
    asAdministrators: {
      members: []
    }
    querypoolConnectionMode: 'All'
    ipV4FirewallSettings: {
      firewallRules: []
      enablePowerBIService: true
    }
  }
}

output serverName string = aasServer.name
output xmlaEndpoint string = 'https://${location}.asazure.windows.net/servers/${name}/xmla'
output serverFullName string = aasServer.properties.serverFullName
@description('One-time bootstrap reminder: add the Console UAMI SP to asAdministrators via the AAS Management REST API.')
output asAdminNote string = 'Add the Console UAMI service principal to ${name} asAdministrators (PATCH servers/${name}) — Bicep cannot set AAS admins declaratively.'
