// ============================================================================
// Alerts - Linked Storage Account for Log Analytics Workspace
// ============================================================================

@description('The subscription ID where the storage account resides')
param subscriptionId string

@description('The resource group name where the storage account resides')
param resourceGroupName string = 'rg-alz-dev-logging'

@description('The storage account name for linked storage')
param storageAccountName string

@description('The Azure region for the resource')
param location string = 'eastus'

resource Alerts 'Microsoft.OperationalInsights/workspaces/linkedstorageaccounts@2022-10-01' = {
  properties: {
    dataSourceType: 'Alerts'
    storageAccountIds: [
      '/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Storage/storageAccounts/${storageAccountName}'
    ]
  }
  location: location
  name: 'Alerts'
}
