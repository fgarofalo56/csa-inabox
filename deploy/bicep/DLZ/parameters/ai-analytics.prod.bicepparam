using '../modules/ai-analytics.bicep'

// Basic configuration
param namePrefix = 'csa'
param environment = 'prod'
param location = 'East US 2'

// Production tags
param tags = {
  Environment: 'Production'
  Project: 'CSA-in-a-Box'
  CostCenter: 'Production'
  Owner: 'Data Platform Team'
  Workload: 'AI Analytics'
  BusinessCriticality: 'High'
  DataClassification: 'Confidential'
}

// Azure OpenAI deployments - full capacity for production
param openAIDeployments = [
  {
    name: 'gpt-5-4'
    model: {
      format: 'OpenAI'
      name: 'gpt-5.4'
      version: '2024-11-20'
    }
    sku: {
      name: 'Standard'
      capacity: 30 // Full capacity for production
    }
  }
  {
    name: 'text-embedding-3-large'
    model: {
      format: 'OpenAI'
      name: 'text-embedding-3-large'
      version: '1'
    }
    sku: {
      name: 'Standard'
      capacity: 120 // Full capacity for production
    }
  }
]

// Networking - enabled private endpoints for production
param enablePrivateEndpoints = true
// These should be provided at deployment time
param vnetResourceId = '' // '/subscriptions/{subscription-id}/resourceGroups/{rg-name}/providers/Microsoft.Network/virtualNetworks/{vnet-name}'
param privateEndpointSubnetId = '' // '/subscriptions/{subscription-id}/resourceGroups/{rg-name}/providers/Microsoft.Network/virtualNetworks/{vnet-name}/subnets/{subnet-name}'

// Log Analytics - should be provided for production monitoring
param logAnalyticsWorkspaceResourceId = '' // '/subscriptions/{subscription-id}/resourceGroups/{rg-name}/providers/Microsoft.OperationalInsights/workspaces/{workspace-name}'