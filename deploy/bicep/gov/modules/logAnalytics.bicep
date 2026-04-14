// Log Analytics Workspace - Government Deployment Module
// FedRAMP High compliant with extended retention

@description('Workspace name.')
param name string

@description('Azure Government region.')
param location string

@description('Resource tags.')
param tags object = {}

@description('Data retention in days (FedRAMP High requires 365+).')
param retentionInDays int = 365

@description('Daily ingestion quota in GB. -1 for unlimited.')
param dailyQuotaGb int = -1

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionInDays
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
      enableDataExport: true
    }
    workspaceCapping: {
      dailyQuotaGb: dailyQuotaGb
    }
    publicNetworkAccessForIngestion: 'Disabled'
    publicNetworkAccessForQuery: 'Disabled'
  }
}

// Solutions for comprehensive monitoring
resource securitySolution 'Microsoft.OperationsManagement/solutions@2015-11-01-preview' = {
  name: 'Security(${name})'
  location: location
  tags: tags
  plan: {
    name: 'Security(${name})'
    publisher: 'Microsoft'
    product: 'OMSGallery/Security'
    promotionCode: ''
  }
  properties: {
    workspaceResourceId: workspace.id
  }
}

output workspaceId string = workspace.id
output workspaceName string = workspace.name
output customerId string = workspace.properties.customerId
