// CSA Loom — Security & Compliance (SCC) sensitivity-label sidecar Function.
//
// A PowerShell 7 Azure Function (Windows Consumption / Y1) that performs
// sensitivity-label + label-policy CRUD via Security & Compliance PowerShell —
// the ONLY API surface that can create/edit/delete labels & policies
// (Microsoft Graph has no write surface). The Loom Console proxies CRUD here
// with a Functions host key. Code: azure-functions/scc-labels.
//
// Auth to SCC is certificate-based app-only:
//   Connect-IPPSSession -AppId <SCC_APP_ID> -Certificate <thumbprint> -Organization <tenant>
// The app needs the Graph app-role Exchange.ManageAsApp + the Entra directory
// role Compliance Administrator. The auth cert is uploaded to this Function app
// (WEBSITE_LOAD_CERTIFICATES) by the post-deploy bootstrap step
// "Provision SCC labels sidecar". Until that one-time admin action completes,
// the Console renders the honest 'mip_admin_not_configured' gate.
//
// Grounded in Microsoft Learn:
//   App-only auth for unattended scripts (Connect-IPPSSession)
//   https://learn.microsoft.com/powershell/exchange/app-only-auth-powershell-v2
//   Create/configure sensitivity labels + policies (New-Label / New-LabelPolicy)
//   https://learn.microsoft.com/purview/create-sensitivity-labels
//   Functions infrastructure-as-code (serverfarms Y1 + Microsoft.Web/sites)
//   https://learn.microsoft.com/azure/azure-functions/functions-infrastructure-as-code

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Entra app (client) id of the SCC sidecar app used by Connect-IPPSSession. Empty leaves the sidecar honest-gated.')
param sccAppId string = ''

@description('Thumbprint of the certificate the sidecar uses for app-only SCC auth. Loaded via WEBSITE_LOAD_CERTIFICATES. Empty leaves the sidecar honest-gated.')
param sccCertThumbprint string = ''

@description('Tenant onmicrosoft.com domain (e.g. contoso.onmicrosoft.com) passed to Connect-IPPSSession -Organization.')
param sccOrganization string = ''

@description('Optional SCC PowerShell ConnectionUri override for sovereign clouds. Empty uses the module default (Commercial: ps.compliance.protection.outlook.com).')
param sccConnectionUri string = ''

@description('Application Insights connection string for telemetry. Empty skips wiring.')
param appInsightsConnectionString string = ''

@description('Compliance tags applied to every resource.')
param complianceTags object

var saName = take('sascclbl${uniqueString(resourceGroup().id)}', 24)
var planName = take('plan-scclbl-${uniqueString(resourceGroup().id)}', 40)
var siteName = take('func-scclbl-${uniqueString(resourceGroup().id)}', 60)

resource sa 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: saName
  location: location
  tags: complianceTags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

// Windows Consumption plan — PowerShell + the certificate store
// (WEBSITE_LOAD_CERTIFICATES) is most reliable on Windows workers.
resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: planName
  location: location
  tags: complianceTags
  sku: { name: 'Y1', tier: 'Dynamic' }
  kind: 'functionapp'
  properties: {}
}

var baseAppSettings = [
  {
    name: 'AzureWebJobsStorage'
    value: 'DefaultEndpointsProtocol=https;AccountName=${sa.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${sa.listKeys().keys[0].value}'
  }
  { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
  { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'powershell' }
  // Load the SCC auth cert into CurrentUser\My so run.ps1 can select it by thumbprint.
  { name: 'WEBSITE_LOAD_CERTIFICATES', value: empty(sccCertThumbprint) ? '' : sccCertThumbprint }
  { name: 'SCC_APP_ID', value: sccAppId }
  { name: 'SCC_CERT_THUMBPRINT', value: sccCertThumbprint }
  { name: 'SCC_ORGANIZATION', value: sccOrganization }
  { name: 'SCC_CONNECTION_URI', value: sccConnectionUri }
]

resource site 'Microsoft.Web/sites@2024-04-01' = {
  name: siteName
  location: location
  tags: complianceTags
  kind: 'functionapp'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      powerShellVersion: '7.4'
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      appSettings: empty(appInsightsConnectionString) ? baseAppSettings : concat(baseAppSettings, [
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
      ])
    }
  }
}

output siteId string = site.id
output siteName string = site.name
output defaultHostName string = site.properties.defaultHostName
@description('https base URL the Console wires into LOOM_SCC_LABELS_ENDPOINT.')
output endpoint string = 'https://${site.properties.defaultHostName}'
@description('Default host function key the Console wires into LOOM_SCC_LABELS_KEY (sent as x-functions-key).')
output functionKey string = listKeys('${site.id}/host/default', '2024-04-01').functionKeys.default
@description('System-assigned identity principalId of the sidecar (informational).')
output principalId string = site.identity.principalId
