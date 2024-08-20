// Template to deploy User Automation Account`

targetScope = 'resourceGroup'

// Metadata
metadata name = 'ALZ Bicep - Automation Account'
metadata description = 'Module used to deploy an Azure Automation Account'


// Parameters
param location string
param prefix string
param environment string
param tags object


resource resAutomationAccount 'Microsoft.Automation/automationAccounts@2022-08-08' = {
  name: '${prefix}-${environment}-automation-account'
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  } 
  properties: {
    encryption: {
      keySource: 'Microsoft.Automation'
    }
    publicNetworkAccess: true
    sku: {
      name: 'Basic'
    }
  }
}

output automationAccountName string = resAutomationAccount.name
output automationAccountId string = resAutomationAccount.id
output automationAccountPrincipalId string = resAutomationAccount.identity.principalId
