// CSA Loom DLZ — Databricks workspace
// Premium tier; VNet-injected with private + public subnets
// Unity Catalog managed when supported in boundary; otherwise Hive metastore

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Domain name (suffix)')
param domainName string

@description('Spoke VNet name (must contain databricks-private + databricks-public subnets)')
param spokeVnetName string

@description('Private subnet name (delegated to Microsoft.Databricks/workspaces)')
param privateSubnetName string

@description('Public subnet name (delegated to Microsoft.Databricks/workspaces)')
param publicSubnetName string

@description('Boundary — controls UC availability')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string

@description('Log Analytics workspace ID for diagnostic settings. Empty (dlz-attach with no hub LAW coordinate) skips the diagnostic settings.')
param workspaceId string = ''

@description('Compliance tags')
param complianceTags object

@description('Disable public IP (recommended; required at IL4+)')
param disablePublicIp bool = true

@description('Customer-managed key for storage (IL5)')
param storageCmkKeyUri string = ''

@description('Spoke subnet resource id hosting inbound private endpoints (snet-private-endpoints). Empty skips the databricks_ui_api private endpoint (the workspace then relies on the IP-access-list fallback in post-deploy bootstrap).')
param privateEndpointSubnetId string = ''

@description('Admin Plane / hub private DNS zone id for privatelink.azuredatabricks.net (Commercial) or privatelink.databricks.azure.us (Gov). Linked to the hub VNet so the Console resolves the workspace host to the PE private IP. Empty skips the PE DNS group (the A record must then be wired manually).')
param databricksPrivateDnsZoneId string = ''

var workspaceName = 'adb-loom-${domainName}-${location}'

// The MRG (managed resource group) name must be globally unique and
// stable across deploys; Databricks creates this RG for its DBFS,
// VMSS, NSG, NICs, etc.
var managedRgName = 'rg-mng-${workspaceName}-${uniqueString(resourceGroup().id)}'

var ucSupported = boundary == 'Commercial' || boundary == 'GCC'

resource workspace 'Microsoft.Databricks/workspaces@2024-09-01-preview' = {
  name: workspaceName
  location: location
  tags: complianceTags
  sku: { name: 'premium' }
  properties: {
    managedResourceGroupId: subscriptionResourceId('Microsoft.Resources/resourceGroups', managedRgName)
    parameters: {
      enableNoPublicIp: { value: disablePublicIp }
      customVirtualNetworkId: {
        value: resourceId('Microsoft.Network/virtualNetworks', spokeVnetName)
      }
      customPrivateSubnetName: { value: privateSubnetName }
      customPublicSubnetName: { value: publicSubnetName }
      requireInfrastructureEncryption: { value: true }
      prepareEncryption: { value: !empty(storageCmkKeyUri) }
    }
    publicNetworkAccess: 'Disabled'
    requiredNsgRules: 'NoAzureDatabricksRules'
  }
}

// =====================================================================
// Databricks Access Connector (system-assigned MI)
// =====================================================================
// The Access Connector's system-assigned managed identity is the storage
// credential Unity Catalog uses to reach external locations (ADLS Gen2). It is
// what the Databricks SQL Warehouse runs OPTIMIZE / ANALYZE / write-back as on
// external Delta tables. Its principalId is granted Storage Blob Data
// Contributor on the lakehouse ADLS account by databricks-storage-rbac.bicep so
// OPTIMIZE can rewrite compacted Parquet + update the _delta_log.
// Only created where Unity Catalog is supported (Commercial + GCC); on
// GCC-High / IL5 (Hive metastore) the connector + UC external-location model do
// not apply, so it is skipped and the RBAC grant is a no-op.
resource accessConnector 'Microsoft.Databricks/accessConnectors@2024-09-01-preview' = if (ucSupported) {
  name: 'dbac-loom-${domainName}-${location}'
  location: location
  tags: complianceTags
  identity: {
    type: 'SystemAssigned'
  }
}

// =====================================================================
// Front-end (databricks_ui_api) private endpoint — #1466
// =====================================================================
// The workspace sets publicNetworkAccess: 'Disabled', so the Loom Console
// (hub VNet) gets "403 Unauthorized network access to workspace" over the
// public path. This PE on the spoke private-endpoint subnet exposes the
// workspace UI/REST API privately; the databricks_ui_api subresource is the
// primary front-end endpoint (handles REST API calls for inbound + classic
// compute-plane Private Link). The DNS group registers the per-workspace host
// (adb-<id>.NN.azuredatabricks.net) on the shared privatelink.azuredatabricks.net
// zone, which is linked to the hub VNet — so the Console resolves it to the PE
// private IP and reaches the workspace over hub→spoke peering. SSO over a
// private path additionally needs a browser_authentication endpoint, but the
// Console's calls are REST/UI-API, so databricks_ui_api is sufficient here.
// Grounded in Microsoft Learn (Configure Inbound Private Link; private-endpoint-dns).
resource peUiApi 'Microsoft.Network/privateEndpoints@2024-03-01' = if (!empty(privateEndpointSubnetId)) {
  name: 'pe-adb-loom-${domainName}-uiapi'
  location: location
  tags: complianceTags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'adb-ui-api'
        properties: {
          privateLinkServiceId: workspace.id
          groupIds: [ 'databricks_ui_api' ]
        }
      }
    ]
  }
}

resource peUiApiDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-03-01' = if (!empty(privateEndpointSubnetId) && !empty(databricksPrivateDnsZoneId)) {
  parent: peUiApi
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'privatelink-azuredatabricks-net'
        properties: { privateDnsZoneId: databricksPrivateDnsZoneId }
      }
    ]
  }
}

// Outputs the caller uses to bootstrap:
// - UC metastore wiring (if ucSupported)
// - SQL Warehouse provisioning (via Databricks REST API post-deploy)
// - Job + cluster definitions (deployed via dbx or asset bundles)

// =====================================================================
// Diagnostic settings → standardized Loom LAW
// =====================================================================

resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  scope: workspace
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'dbfs', enabled: true }
      { category: 'clusters', enabled: true }
      { category: 'accounts', enabled: true }
      { category: 'jobs', enabled: true }
      { category: 'notebook', enabled: true }
      { category: 'ssh', enabled: true }
      { category: 'workspace', enabled: true }
      { category: 'secrets', enabled: true }
      { category: 'sqlPermissions', enabled: true }
      { category: 'instancePools', enabled: true }
      { category: 'sqlanalytics', enabled: true }
      { category: 'genie', enabled: true }
      { category: 'globalInitScripts', enabled: true }
      { category: 'iamRole', enabled: true }
      { category: 'mlflowExperiment', enabled: true }
      { category: 'featureStore', enabled: true }
      { category: 'RemoteHistoryService', enabled: true }
      { category: 'modelRegistry', enabled: true }
      { category: 'repos', enabled: true }
      { category: 'unityCatalog', enabled: true }
      { category: 'gitCredentials', enabled: true }
    ]
  }
}

output workspaceId string = workspace.id
output workspaceUrl string = 'https://${workspace.properties.workspaceUrl}'
output workspaceName string = workspace.name
output ucSupported bool = ucSupported
output managedRgId string = workspace.properties.managedResourceGroupId

// Numeric Databricks workspace id (e.g. 7405613013893759) — what the Databricks
// ACCOUNT API uses to assign a Unity Catalog metastore
// (PUT /accounts/{id}/workspaces/{workspaceNumericId}/metastore). Consumed by
// databricks-uc-bootstrap.bicep so UC is configured by default.
output workspaceNumericId string = string(workspace.properties.workspaceId)

// Bare workspace REST host (no scheme) — the UC default-catalog create call uses
// this against the WORKSPACE UC REST 2.1. Consumed by databricks-uc-bootstrap.bicep.
output workspaceHost string = workspace.properties.workspaceUrl

// Access Connector system-assigned MI principal id — empty when UC is not
// supported (connector skipped). Consumed by databricks-storage-rbac.bicep to
// grant Storage Blob Data Contributor on the lakehouse ADLS account.
output accessConnectorPrincipalId string = ucSupported ? accessConnector.identity.principalId : ''
output accessConnectorName string = ucSupported ? accessConnector.name : ''
