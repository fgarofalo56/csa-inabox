using '../modules/streaming.bicep'

// Development environment — smallest viable SKUs for cost efficiency
param namePrefix = 'csa'
param environment = 'dev'
param location = 'East US 2'

// Development tags
param tags = {
  Environment: 'Development'
  Project: 'CSA-in-a-Box'
  CostCenter: 'Engineering'
  Owner: 'Data Platform Team'
  Workload: 'Streaming Analytics'
}

// Event Hubs Standard tier (minimum for Kafka protocol support)
param eventHubsSkuTier = 'Standard'

// Stream Analytics — minimum streaming units
param streamingUnits = 1

// ADX Dev SKU — single node, no SLA, ~$0.12/hr
param adxSkuName = 'Dev(No SLA)_Standard_E2a_v4'
param adxSkuTier = 'Basic'

// Networking — disabled for dev
param enablePrivateEndpoints = false
param subnetId = ''

// Log Analytics — provide if available
param logAnalyticsWorkspaceResourceId = ''
