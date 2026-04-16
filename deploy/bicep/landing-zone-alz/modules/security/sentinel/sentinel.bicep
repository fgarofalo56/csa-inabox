param workspaceName string
param resourceGroupName string
param location string = 'global'


resource sentinelSolution 'Microsoft.OperationsManagement/solutions@2021-06-01' = {
  name: 'Microsoft.Sentinel.AzureActivity'
  location: location
  properties: {
    workspaceResourceId: sentinelWorkspace.id
    plan: {
      name: 'Microsoft.Sentinel.AzureActivity'
      publisher: 'Microsoft'
      product: 'Microsoft Sentinel'
      promotionCode: 'Sentinel'
      term: 0
      publisherLogoUri: 'https://example.com/logo.png'
    }
    parameters: {
      'dataSources': {
        'LogAnalytics': {
          'workspaceResourceId': sentinelWorkspace.id
        }
      }
    }
  }
}

output workspaceResourceId string = sentinelWorkspace.id
output solutionResourceId string = sentinelSolution.id
