using '../modules/geoanalytics.bicep'

// Development environment — smallest viable SKUs
param namePrefix = 'csa'
param environment = 'dev'
param location = 'East US 2'

// Development tags
param tags = {
  Environment: 'Development'
  Project: 'CSA-in-a-Box'
  CostCenter: 'Engineering'
  Owner: 'Data Platform Team'
  Workload: 'GeoAnalytics'
}

// PostgreSQL — Burstable B1ms for dev
param postgresSkuName = 'Standard_B1ms'
param postgresSkuTier = 'Burstable'
param postgresAdminLogin = 'geoadmin'
param postgresAdminPassword = '' // Set via --parameters or Key Vault at deploy time

// Databricks — Premium for Unity Catalog support
param databricksSku = 'premium'

// Networking — disabled for dev
param enablePrivateEndpoints = false
param subnetId = ''

// Log Analytics — provide if available
param logAnalyticsWorkspaceResourceId = ''
