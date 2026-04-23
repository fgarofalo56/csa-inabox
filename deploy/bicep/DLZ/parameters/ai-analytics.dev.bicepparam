using '../modules/ai-analytics.bicep'

// Basic configuration
param namePrefix = 'csa'
param environment = 'dev'
param location = 'East US 2'

// Development tags
param tags = {
  Environment: 'Development'
  Project: 'CSA-in-a-Box'
  CostCenter: 'Engineering'
  Owner: 'Data Platform Team'
  Workload: 'AI Analytics'
}

// Azure OpenAI deployments - smaller capacity for dev
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
      capacity: 10 // Reduced capacity for dev
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
      capacity: 30 // Reduced capacity for dev
    }
  }
]

// Networking - disabled private endpoints for dev
param enablePrivateEndpoints = false
param vnetResourceId = ''
param privateEndpointSubnetId = ''

// Log Analytics - provide if available
param logAnalyticsWorkspaceResourceId = ''