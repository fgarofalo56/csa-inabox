// CSA Loom DLZ — Synapse workspace (Serverless SQL pool only)
// Per LD-2: Synapse Serverless is the SQL-over-Delta engine in Gov
// where Databricks SQL Warehouse hasn't yet GA'd.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Domain name')
param domainName string

@description('ADLS Gen2 storage account name (default Synapse data lake)')
param defaultStorageAccountName string

@description('Default file system name')
param defaultFileSystemName string = 'synapse'

@description('Admin Entra group object ID (Workspace Admin)')
param adminEntraGroupId string

@description('Managed VNet enabled')
param managedVnet bool = true

@description('Compliance tags')
param complianceTags object

resource synapseWs 'Microsoft.Synapse/workspaces@2021-06-01' = {
  name: 'syn-loom-${domainName}-${location}'
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    defaultDataLakeStorage: {
      accountUrl: 'https://${defaultStorageAccountName}.dfs.${environment().suffixes.storage}'
      filesystem: defaultFileSystemName
    }
    managedVirtualNetwork: managedVnet ? 'default' : ''
    publicNetworkAccess: 'Disabled'
    managedVirtualNetworkSettings: managedVnet ? {
      preventDataExfiltration: true
      allowedAadTenantIdsForLinking: [subscription().tenantId]
    } : null
  }
}

// Workspace admin role assignment (Workspace Admin = Synapse RBAC scope)
resource synapseAdminRole 'Microsoft.Synapse/workspaces/firewallRules@2021-06-01' = {
  parent: synapseWs
  name: 'allow-vnet-only'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource roleAssignment 'Microsoft.Synapse/workspaces/administrators@2021-06-01' = {
  parent: synapseWs
  name: 'activeDirectory'
  properties: {
    administratorType: 'Group'
    login: 'admins'
    sid: adminEntraGroupId
    tenantId: subscription().tenantId
  }
}

output synapseWorkspaceId string = synapseWs.id
output synapseWorkspaceName string = synapseWs.name
output synapseServerlessSqlEndpoint string = synapseWs.properties.connectivityEndpoints.sqlOnDemand
output synapseDevEndpoint string = synapseWs.properties.connectivityEndpoints.dev
output synapseManagedIdentityPrincipalId string = synapseWs.identity.principalId
