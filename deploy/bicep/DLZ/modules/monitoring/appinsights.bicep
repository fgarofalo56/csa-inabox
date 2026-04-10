// Application Insights Module
// Deploys Application Insights connected to Log Analytics
targetScope = 'resourceGroup'

// Parameters
@description('Name of the Application Insights resource.')
param appInsightsName string

@description('Azure region.')
param location string

@description('Tags to apply to resources.')
param tags object = {}

@description('Resource ID of the Log Analytics workspace.')
param logAnalyticsWorkspaceId string

@description('Application type.')
@allowed([
  'web'
  'other'
])
param applicationType string = 'web'

@description('Disable local authentication (use AAD only).')
param disableLocalAuth bool = true

// Resources
resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  tags: tags
  kind: applicationType
  properties: {
    Application_Type: applicationType
    WorkspaceResourceId: logAnalyticsWorkspaceId
    DisableLocalAuth: disableLocalAuth
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Disabled'
    publicNetworkAccessForQuery: 'Disabled'
  }
}

// Outputs
@description('Resource ID of the Application Insights.')
output appInsightsId string = appInsights.id

@description('Instrumentation key.')
output instrumentationKey string = appInsights.properties.InstrumentationKey

@description('Connection string.')
output connectionString string = appInsights.properties.ConnectionString
