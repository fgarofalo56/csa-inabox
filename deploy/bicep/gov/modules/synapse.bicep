// Azure Synapse Analytics - Government Deployment Module
// Managed VNet with data exfiltration protection

@description('Workspace name.')
param name string

@description('Azure Government region.')
param location string

@description('Resource tags.')
param tags object = {}

@description('ADLS Gen2 storage account ID for the default data lake.')
param storageAccountId string

@description('Managed virtual network name.')
param managedVirtualNetwork string = 'default'

@description('Prevent data exfiltration.')
param preventDataExfiltration bool = true

@description('Public network access.')
param publicNetworkAccess string = 'Disabled'

@description('Log Analytics workspace ID.')
param logAnalyticsId string = ''

var storageAccountName = last(split(storageAccountId, '/'))

resource synapse 'Microsoft.Synapse/workspaces@2021-06-01' = {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    defaultDataLakeStorage: {
      accountUrl: 'https://${storageAccountName}.dfs.core.usgovcloudapi.net'
      filesystem: 'silver'
    }
    managedVirtualNetwork: managedVirtualNetwork
    managedVirtualNetworkSettings: {
      preventDataExfiltration: preventDataExfiltration
      allowedAadTenantIdsForLinking: []
    }
    publicNetworkAccess: publicNetworkAccess
    sqlAdministratorLogin: 'sqladmin'
    encryption: {
      doubleEncryptionEnabled: true
    }
    trustedServiceBypassEnabled: true
  }
}

// Firewall rules - deny all by default
resource firewallRule 'Microsoft.Synapse/workspaces/firewallRules@2021-06-01' = {
  parent: synapse
  name: 'AllowAllWindowsAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// Managed Identity SQL control settings
resource managedIdentitySql 'Microsoft.Synapse/workspaces/managedIdentitySqlControlSettings@2021-06-01' = {
  parent: synapse
  name: 'default'
  properties: {
    grantSqlControlToManagedIdentity: {
      desiredState: 'Enabled'
    }
  }
}

// Diagnostic settings
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsId)) {
  name: '${name}-diag'
  scope: synapse
  properties: {
    workspaceId: logAnalyticsId
    logs: [
      { category: 'SynapseRbacOperations', enabled: true }
      { category: 'GatewayApiRequests', enabled: true }
      { category: 'BuiltinSqlReqsEnded', enabled: true }
      { category: 'IntegrationPipelineRuns', enabled: true }
      { category: 'IntegrationActivityRuns', enabled: true }
      { category: 'IntegrationTriggerRuns', enabled: true }
      { category: 'SQLSecurityAuditEvents', enabled: true }
    ]
  }
}

output workspaceId string = synapse.id
output workspaceName string = synapse.name
output workspaceUrl string = synapse.properties.connectivityEndpoints.web
output sqlEndpoint string = synapse.properties.connectivityEndpoints.sql
output principalId string = synapse.identity.principalId
