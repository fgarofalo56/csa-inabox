// --------------------------------------------------------------------------
// Sentinel Workspace Deployment
// Deploys Log Analytics Workspace with Microsoft Sentinel solution,
// data connectors, and data collection rules for federal cybersecurity.
// --------------------------------------------------------------------------

@description('Prefix for all resource names')
param namePrefix string = 'csa'

@description('Deployment environment')
@allowed(['dev', 'stg', 'prd'])
param environment string = 'dev'

@description('Azure region for deployment')
param location string = resourceGroup().location

@description('Log Analytics data retention in days')
@minValue(30)
@maxValue(730)
param retentionDays int = 90

@description('Tags applied to all resources')
param tags object = {
  project: 'csa-inabox'
  vertical: 'cybersecurity'
  environment: environment
  managedBy: 'bicep'
}

// --------------------------------------------------------------------------
// Variables
// --------------------------------------------------------------------------

var workspaceName = '${namePrefix}-law-${environment}'
var sentinelName = '${namePrefix}-sentinel-${environment}'
var identityName = '${namePrefix}-id-cyber-${environment}'
var dcrName = '${namePrefix}-dcr-winsec-${environment}'

// --------------------------------------------------------------------------
// Managed Identity
// --------------------------------------------------------------------------

resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: tags
}

// --------------------------------------------------------------------------
// Log Analytics Workspace
// --------------------------------------------------------------------------

resource workspace 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionDays
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    workspaceCapping: {
      dailyQuotaGb: environment == 'prd' ? -1 : 5
    }
  }
}

// --------------------------------------------------------------------------
// Microsoft Sentinel Solution
// --------------------------------------------------------------------------

resource sentinel 'Microsoft.OperationsManagement/solutions@2015-11-01-preview' = {
  name: 'SecurityInsights(${workspaceName})'
  location: location
  tags: tags
  plan: {
    name: 'SecurityInsights(${workspaceName})'
    publisher: 'Microsoft'
    promotionCode: ''
    product: 'OMSGallery/SecurityInsights'
  }
  properties: {
    workspaceResourceId: workspace.id
  }
}

// --------------------------------------------------------------------------
// Data Connector: Azure Activity
// --------------------------------------------------------------------------

resource activityConnector 'Microsoft.SecurityInsights/dataConnectors@2023-02-01-preview' = {
  scope: workspace
  name: '${sentinelName}-activity'
  kind: 'AzureActivity'
  properties: {
    linkedResourceId: subscription().id
  }
  dependsOn: [sentinel]
}

// --------------------------------------------------------------------------
// Data Connector: Azure Active Directory (Sign-In & Audit)
// --------------------------------------------------------------------------

resource aadConnector 'Microsoft.SecurityInsights/dataConnectors@2023-02-01-preview' = {
  scope: workspace
  name: '${sentinelName}-aad'
  kind: 'AzureActiveDirectory'
  properties: {
    tenantId: subscription().tenantId
    dataTypes: {
      alerts: {
        state: 'Enabled'
      }
    }
  }
  dependsOn: [sentinel]
}

// --------------------------------------------------------------------------
// Data Connector: Microsoft 365 Defender
// --------------------------------------------------------------------------

resource m365dConnector 'Microsoft.SecurityInsights/dataConnectors@2023-02-01-preview' = {
  scope: workspace
  name: '${sentinelName}-m365d'
  kind: 'MicrosoftThreatProtection'
  properties: {
    tenantId: subscription().tenantId
    dataTypes: {
      incidents: {
        state: 'Enabled'
      }
    }
  }
  dependsOn: [sentinel]
}

// --------------------------------------------------------------------------
// Data Collection Rule: Windows Security Events
// --------------------------------------------------------------------------

resource dataCollectionRule 'Microsoft.Insights/dataCollectionRules@2022-06-01' = {
  name: dcrName
  location: location
  tags: tags
  properties: {
    dataSources: {
      windowsEventLogs: [
        {
          name: 'securityEvents'
          streams: ['Microsoft-SecurityEvent']
          xPathQueries: [
            'Security!*[System[(EventID=4624 or EventID=4625 or EventID=4634 or EventID=4648 or EventID=4672 or EventID=4688 or EventID=4720 or EventID=4726 or EventID=7045)]]'
          ]
        }
      ]
    }
    destinations: {
      logAnalytics: [
        {
          name: 'sentinelWorkspace'
          workspaceResourceId: workspace.id
        }
      ]
    }
    dataFlows: [
      {
        streams: ['Microsoft-SecurityEvent']
        destinations: ['sentinelWorkspace']
      }
    ]
  }
}

// --------------------------------------------------------------------------
// Diagnostic Settings for Workspace
// --------------------------------------------------------------------------

resource diagnosticSettings 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: workspace
  name: '${workspaceName}-diag'
  properties: {
    workspaceId: workspace.id
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
        retentionPolicy: {
          enabled: true
          days: retentionDays
        }
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
        retentionPolicy: {
          enabled: true
          days: retentionDays
        }
      }
    ]
  }
}

// --------------------------------------------------------------------------
// Outputs
// --------------------------------------------------------------------------

output workspaceId string = workspace.id
output workspaceName string = workspace.name
output sentinelName string = sentinel.name
output managedIdentityId string = managedIdentity.id
output managedIdentityClientId string = managedIdentity.properties.clientId
output dataCollectionRuleId string = dataCollectionRule.id
