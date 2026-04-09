// This template is used as a module to from the main.bicep file to deploy a Log Analytics workspace
// Metadata
metadata name = 'ALZ Bicep - Subscription default Log Analytics workspace'

// Parameters

param automationAccountID string
param parLocation string
param prefix string
param tags object
param logRetentionDays int = 30
param storageAccountId string
param parLoggingRG string
param environment string
param parLogAnalyticsWorkspaceLogRetentionInDays int
param parDataCollectionRuleVMInsightsName string
param parDataCollectionRuleChangeTrackingName string
param parDataCollectionRuleMDFCSQLName string
param parDCRWorkspaceTransformationName string

@sys.description('Solutions that will be added to the Log Analytics Workspace.')
param parLogAnalyticsWorkspaceSolutions array = [
  'SecurityInsights'
]

@sys.description('Log Analytics Workspace Name.')
param parmLogAnalyticsWorkspaceName string = '${prefix}-${environment}-log-analytics'

@allowed([
  'CapacityReservation'
  'Free'
  'LACluster'
  'PerGB2018'
  'PerNode'
  'Premium'
  'Standalone'
  'Standard'
])
@sys.description('Log Analytics Workspace sku name.')
param parLogAnalyticsWorkspaceSkuName string = 'PerGB2018'

// Resource
// Create a Log Analytics Workspace
resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: parmLogAnalyticsWorkspaceName
  location: parLocation
  tags: tags
  properties: {
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
    retentionInDays: logRetentionDays
    sku: {
      name: parLogAnalyticsWorkspaceSkuName
    }
  }
}

// data collection rules
// VM Insights
resource resDataCollectionRuleVMInsights 'Microsoft.Insights/dataCollectionRules@2021-04-01' = {
  name: parDataCollectionRuleVMInsightsName
  location: parLocation
  properties: {
    description: 'Data collection rule for VM Insights'
    dataSources: {
      performanceCounters: [
        {
          name: 'VMInsightsPerfCounters'
          streams: [
            'Microsoft-InsightsMetrics'
          ]
          counterSpecifiers: [
            '\\VMInsights\\DetailedMetrics'
          ]
          samplingFrequencyInSeconds: 60
        }
      ]
      extensions: [
        {
          streams: [
            'Microsoft-ServiceMap'
          ]
          extensionName: 'DependencyAgent'
          extensionSettings: {}
          name: 'DependencyAgentDataSource'
        }
      ]
    }
    destinations: {
      logAnalytics: [
        {
          workspaceResourceId: logAnalyticsWorkspace.id
          name: 'VMInsightsPerf-Logs-Dest'
        }
      ]
    }
    dataFlows: [
      {
        streams: [
          'Microsoft-InsightsMetrics'
        ]
        destinations: [
          'VMInsightsPerf-Logs-Dest'
        ]
      }
      {
        streams: [
          'Microsoft-ServiceMap'
        ]
        destinations: [
          'VMInsightsPerf-Logs-Dest'
        ]
      }
    ]
  }
}

// DCR Change Tracking
resource resDataCollectionRuleChangeTracking 'Microsoft.Insights/dataCollectionRules@2021-04-01' = {
  name: parDataCollectionRuleChangeTrackingName
  location: parLocation
  properties: {
    description: 'Data collection rule for CT.'
    dataSources: {
      extensions: [
        {
          streams: [
            'Microsoft-ConfigurationChange'
            'Microsoft-ConfigurationChangeV2'
            'Microsoft-ConfigurationData'
          ]
          extensionName: 'ChangeTracking-Windows'
          extensionSettings: {
            enableFiles: true
            enableSoftware: true
            enableRegistry: true
            enableServices: true
            enableInventory: true
            registrySettings: {
              registryCollectionFrequency: 3000
              registryInfo: [
                {
                  name: 'Registry_1'
                  groupTag: 'Recommended'
                  enabled: false
                  recurse: true
                  description: ''
                  keyName: 'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Group Policy\\Scripts\\Startup'
                  valueName: ''
                }
                {
                  name: 'Registry_2'
                  groupTag: 'Recommended'
                  enabled: false
                  recurse: true
                  description: ''
                  keyName: 'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Group Policy\\Scripts\\Shutdown'
                  valueName: ''
                }
                {
                  name: 'Registry_3'
                  groupTag: 'Recommended'
                  enabled: false
                  recurse: true
                  description: ''
                  keyName: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Run'
                  valueName: ''
                }
                {
                  name: 'Registry_4'
                  groupTag: 'Recommended'
                  enabled: false
                  recurse: true
                  description: ''
                  keyName: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Active Setup\\Installed Components'
                  valueName: ''
                }
                {
                  name: 'Registry_5'
                  groupTag: 'Recommended'
                  enabled: false
                  recurse: true
                  description: ''
                  keyName: 'HKEY_LOCAL_MACHINE\\Software\\Classes\\Directory\\ShellEx\\ContextMenuHandlers'
                  valueName: ''
                }
                {
                  name: 'Registry_6'
                  groupTag: 'Recommended'
                  enabled: false
                  recurse: true
                  description: ''
                  keyName: 'HKEY_LOCAL_MACHINE\\Software\\Classes\\Directory\\Background\\ShellEx\\ContextMenuHandlers'
                  valueName: ''
                }
                {
                  name: 'Registry_7'
                  groupTag: 'Recommended'
                  enabled: false
                  recurse: true
                  description: ''
                  keyName: 'HKEY_LOCAL_MACHINE\\Software\\Classes\\Directory\\Shellex\\CopyHookHandlers'
                  valueName: ''
                }
                {
                  name: 'Registry_8'
                  groupTag: 'Recommended'
                  enabled: false
                  recurse: true
                  description: ''
                  keyName: 'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ShellIconOverlayIdentifiers'
                  valueName: ''
                }
                {
                  name: 'Registry_9'
                  groupTag: 'Recommended'
                  enabled: false
                  recurse: true
                  description: ''
                  keyName: 'HKEY_LOCAL_MACHINE\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ShellIconOverlayIdentifiers'
                  valueName: ''
                }
                {
                  name: 'Registry_10'
                  groupTag: 'Recommended'
                  enabled: false
                  recurse: true
                  description: ''
                  keyName: 'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Browser Helper Objects'
                  valueName: ''
                }
                {
                  name: 'Registry_11'
                  groupTag: 'Recommended'
                  enabled: false
                  recurse: true
                  description: ''
                  keyName: 'HKEY_LOCAL_MACHINE\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Browser Helper Objects'
                  valueName: ''
                }
                {
                  name: 'Registry_12'
                  groupTag: 'Recommended'
                  enabled: false
                  recurse: true
                  description: ''
                  keyName: 'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Internet Explorer\\Extensions'
                  valueName: ''
                }
                {
                  name: 'Registry_13'
                  groupTag: 'Recommended'
                  enabled: false
                  recurse: true
                  description: ''
                  keyName: 'HKEY_LOCAL_MACHINE\\Software\\Wow6432Node\\Microsoft\\Internet Explorer\\Extensions'
                  valueName: ''
                }
                {
                  name: 'Registry_14'
                  groupTag: 'Recommended'
                  enabled: false
                  recurse: true
                  description: ''
                  keyName: 'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Drivers32'
                  valueName: ''
                }
                {
                  name: 'Registry_15'
                  groupTag: 'Recommended'
                  enabled: false
                  recurse: true
                  description: ''
                  keyName: 'HKEY_LOCAL_MACHINE\\Software\\Wow6432Node\\Microsoft\\Windows NT\\CurrentVersion\\Drivers32'
                  valueName: ''
                }
                {
                  name: 'Registry_16'
                  groupTag: 'Recommended'
                  enabled: false
                  recurse: true
                  description: ''
                  keyName: 'HKEY_LOCAL_MACHINE\\System\\CurrentControlSet\\Control\\Session Manager\\KnownDlls'
                  valueName: ''
                }
                {
                  name: 'Registry_17'
                  groupTag: 'Recommended'
                  enabled: false
                  recurse: true
                  description: ''
                  keyName: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\\Notify'
                  valueName: ''
                }
              ]
            }
            fileSettings: {
              fileCollectionFrequency: 2700
            }
            softwareSettings: {
              softwareCollectionFrequency: 1800
            }
            inventorySettings: {
              inventoryCollectionFrequency: 36000
            }
            serviceSettings: {
              serviceCollectionFrequency: 1800
            }
          }
          name: 'CTDataSource-Windows'
        }
        {
          streams: [
            'Microsoft-ConfigurationChange'
            'Microsoft-ConfigurationChangeV2'
            'Microsoft-ConfigurationData'
          ]
          extensionName: 'ChangeTracking-Linux'
          extensionSettings: {
            enableFiles: true
            enableSoftware: true
            enableRegistry: false
            enableServices: true
            enableInventory: true
            fileSettings: {
              fileCollectionFrequency: 900
              fileInfo: [
                {
                  name: 'ChangeTrackingLinuxPath_default'
                  enabled: true
                  destinationPath: '/etc/.*.conf'
                  useSudo: true
                  recurse: true
                  maxContentsReturnable: 5000000
                  pathType: 'File'
                  type: 'File'
                  links: 'Follow'
                  maxOutputSize: 500000
                  groupTag: 'Recommended'
                }
              ]
            }
            softwareSettings: {
              softwareCollectionFrequency: 300
            }
            inventorySettings: {
              inventoryCollectionFrequency: 36000
            }
            serviceSettings: {
              serviceCollectionFrequency: 300
            }
          }
          name: 'CTDataSource-Linux'
        }
      ]
    }
    destinations: {
      logAnalytics: [
        {
          workspaceResourceId: logAnalyticsWorkspace.id
          name: 'Microsoft-CT-Dest'
        }
      ]
    }
    dataFlows: [
      {
        streams: [
          'Microsoft-ConfigurationChange'
          'Microsoft-ConfigurationChangeV2'
          'Microsoft-ConfigurationData'
        ]
        destinations: [
          'Microsoft-CT-Dest'
        ]
      }
    ]
  }
}

// Data Collection Rule for Defender for SQL
resource resDataCollectionRuleMDFCSQL 'Microsoft.Insights/dataCollectionRules@2021-04-01' = {
  name: parDataCollectionRuleMDFCSQLName
  location: parLocation
  properties: {
    description: 'Data collection rule for Defender for SQL.'
    dataSources: {
      extensions: [
        {
          extensionName: 'MicrosoftDefenderForSQL'
          name: 'MicrosoftDefenderForSQL'
          streams: [
            'Microsoft-DefenderForSqlAlerts'
            'Microsoft-DefenderForSqlLogins'
            'Microsoft-DefenderForSqlTelemetry'
            'Microsoft-DefenderForSqlScanEvents'
            'Microsoft-DefenderForSqlScanResults'
          ]
          extensionSettings: {
            enableCollectionOfSqlQueriesForSecurityResearch: true
          }
        }
      ]
    }
    destinations: {
      logAnalytics: [
        {
          workspaceResourceId: logAnalyticsWorkspace.id
          name: 'Microsoft-DefenderForSQL-Dest'
        }
      ]
    }
    dataFlows: [
      {
        streams: [
          'Microsoft-DefenderForSqlAlerts'
          'Microsoft-DefenderForSqlLogins'
          'Microsoft-DefenderForSqlTelemetry'
          'Microsoft-DefenderForSqlScanEvents'
          'Microsoft-DefenderForSqlScanResults'
        ]
        destinations: [
          'Microsoft-DefenderForSQL-Dest'
        ]
      }
    ]
  }
}

// Workspace transformation
resource resDCRWorkspaceTransformation 'Microsoft.Insights/dataCollectionRules@2021-04-01' = {
  name: parDCRWorkspaceTransformationName
  location: parLocation
  properties: {
    description: 'Data collection rule for Workspace Transformation.'
    dataSources: {
      extensions: [
        {
          extensionName: 'MicrosoftDefenderForSQL'
          name: 'MicrosoftDefenderForSQL'
          streams: [
            'Microsoft-DefenderForSqlAlerts'
            'Microsoft-DefenderForSqlLogins'
            'Microsoft-DefenderForSqlTelemetry'
            'Microsoft-DefenderForSqlScanEvents'
            'Microsoft-DefenderForSqlScanResults'
          ]
          extensionSettings: {
            enableCollectionOfSqlQueriesForSecurityResearch: true
          }
        }
      ]
    }
    destinations: {
      logAnalytics: [
        {
          workspaceResourceId: logAnalyticsWorkspace.id
          name: 'WorkspaceTransformation-Dest'
        }
      ]
    }
    dataFlows: [
      {
        streams: [
          'Microsoft-Table-LAQueryLogs'
        ]
        destinations: [
          'WorkspaceTransformation-Dest'
        ]
        // transformKql: '''
        //   source 
        //   | where QueryText !contains 'LAQueryLogs' 
        //   | extend Context = parse_json(RequestContext) 
        //   | extend Resources_CF = tostring(Context['workspaces']) 
        //   | extend RequestContext = ''
        //   '''
      }
    ]
  }
}

// Onboard the Log Analytics Workspace to Sentinel for SecurityInsights 
resource resSentinelOnboarding 'Microsoft.SecurityInsights/onboardingStates@2024-03-01' = {
  name: 'default'
  scope: logAnalyticsWorkspace
  properties: {}
}

// Link the Log Analytics Workspace to the Automation Account
resource resLogAnalyticsLinkedServiceForAutomationAccount 'Microsoft.OperationalInsights/workspaces/linkedServices@2020-08-01' = {
  parent: logAnalyticsWorkspace
  name: 'Automation'
  properties: {
    resourceId: automationAccountID
  }
}

// Link the Log Analytics Workspace to the Storage Account CustomLogs
resource resLogAnalyticsLinkedStorageAccountCustomLogs 'Microsoft.OperationalInsights/workspaces/linkedStorageAccounts@2020-03-01-preview' = {
  parent: logAnalyticsWorkspace
  name: 'CustomLogs'
  properties: {
    storageAccountIds: [
      storageAccountId
    ]
  }
}

// Link the Log Analytics Workspace to the Storage Account Query
resource resLogAnalyticsLinkedStorageAccountQuery 'Microsoft.OperationalInsights/workspaces/linkedStorageAccounts@2020-03-01-preview' = {
  parent: logAnalyticsWorkspace
  name: 'Query'
  properties: {
    storageAccountIds: [
      storageAccountId
    ]
  }
}

// Link the Log Analytics Workspace to the Storage Account Alerts
resource resLogAnalyticsLinkedStorageAccountAlerts 'Microsoft.OperationalInsights/workspaces/linkedStorageAccounts@2020-03-01-preview' = {
  parent: logAnalyticsWorkspace
  name: 'Alerts'
  properties: {
    storageAccountIds: [
      storageAccountId
    ]
  }
}

module resQueryPack 'QueryPacks/packs.bicep' = {
  name: 'resQueryPack'
  params: {
    location: parLocation
    tags: tags
    parLoggingRG: parLoggingRG
  }
}

// // Solution deployments:
resource resLogAnalyticsWorkspaceSolutions 'Microsoft.OperationsManagement/solutions@2015-11-01-preview' = [
  for solution in parLogAnalyticsWorkspaceSolutions: {
    name: '${solution}(${parmLogAnalyticsWorkspaceName})'
    location: parLocation
    tags: tags
    plan: {
      name: '${solution}(${parmLogAnalyticsWorkspaceName})'
      product: 'OMSGallery/${solution}'
      promotionCode: ''
      publisher: 'Microsoft'
    }
    properties: {
      workspaceResourceId: logAnalyticsWorkspace.id
    }
  }
]

// output resQueryPacks object = resQueryPack
output logAnalyticsWorkspaceName string = logAnalyticsWorkspace.name
output logAnalyticsWorkspaceId string = logAnalyticsWorkspace.id
