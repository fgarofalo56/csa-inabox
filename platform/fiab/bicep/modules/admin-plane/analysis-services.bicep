// =====================================================================
// CSA Loom — Azure Analysis Services (optional semantic-model backend)
// =====================================================================
//
// Deployed only when loomSemanticBackend == 'analysis-services'. AAS provides
// the XMLA endpoint the Console uses to read + write tabular-model COLUMN
// METADATA — data category, format string, summarize-by, display folder,
// sort-by, hidden toggle, calculated columns and calculated tables — via TMSL
// Execute / TMSCHEMA Discover (see apps/fiab-console/lib/azure/aas-client.ts).
//
// This is the Azure-native path: it requires NO Microsoft Fabric or Power BI
// workspace (per .claude/rules/no-fabric-dependency.md — semantic-model maps to
// "Azure Analysis Services optional"). The Console reads:
//   LOOM_AAS_SERVER_URL  = asazure://<region>.asazure.windows.net/<name>
//   LOOM_AAS_DATABASE    = <model db name>
// and acquires tokens via the Console UAMI with scope
//   https://<region>.asazure.windows.net/.default
//
// AVAILABILITY: Azure Analysis Services is Commercial / GCC ONLY — it is not
// offered in Azure Government (GCC-High / IL5 / DoD). The orchestrator guards
// this module on the boundary; in Gov the Console surfaces an honest gate and
// (if licensed) uses LOOM_POWERBI_XMLA_ENDPOINT instead.

targetScope = 'resourceGroup'

@description('Azure region for the AAS server.')
param location string

@description('Console UAMI client (application) id — added to the AAS server administrators as app:<clientId>@<tenantId> so the managed identity can run TMSL/XMLA.')
param uamiClientId string

@description('AAS SKU. B1=Basic, B2, S0/S1/S2=Standard, D1=Developer (no SLA, cheapest for dev). Default B1.')
@allowed(['B1', 'B2', 'S0', 'S1', 'S2', 'S4', 'D1'])
param sku string = 'B1'

@description('Resource tags.')
param tags object = {}

resource aasServer 'Microsoft.AnalysisServices/servers@2017-08-01' = {
  name: take('aascsaloom${uniqueString(resourceGroup().id)}', 63)
  location: location
  tags: tags
  sku: {
    name: sku
    capacity: 1
  }
  properties: {
    // The Console UAMI service principal must be a server administrator so it
    // can execute TMSL Alter/Create over XMLA. AAS expects the SP form
    // app:<appId>@<tenantId>.
    asAdministrators: {
      members: [
        'app:${uamiClientId}@${tenant().tenantId}'
      ]
    }
    querypoolConnectionMode: 'All'
    // Allow the Console's egress to reach the XMLA endpoint. Tighten to the
    // Container Apps / AKS egress IPs post-deploy if required.
    ipV4FirewallSettings: {
      firewallRules: [
        {
          firewallRuleName: 'AllowAzureServices'
          rangeStart: '0.0.0.0'
          rangeEnd: '0.0.0.0'
        }
      ]
      enablePowerBIService: true
    }
  }
}

@description('asazure:// connection string for the deployed server — wire to LOOM_AAS_SERVER_URL. serverFullName already includes the region host, e.g. eastus2.asazure.windows.net.')
output aasServerUrl string = 'asazure://${aasServer.properties.serverFullName}/${aasServer.name}'

@description('Bare AAS resource name.')
output aasServerName string = aasServer.name
