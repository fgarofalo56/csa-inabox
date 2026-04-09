// Azure Service Health Alerts
// Monitors Azure platform issues affecting CSA-in-a-Box services

targetScope = 'subscription'

@description('Action group resource ID for notifications')
param actionGroupId string

@description('Environment')
param environment string = 'dev'

@description('Regions to monitor')
param monitoredRegions array = [
  'East US'
  'East US 2'
]

@description('Services to monitor')
param monitoredServices array = [
  'Azure Databricks'
  'Azure Data Factory'
  'Azure Data Lake Storage Gen2'
  'Azure Synapse Analytics'
  'Azure Cosmos DB'
  'Key Vault'
  'Azure Functions'
  'Event Hubs'
  'Microsoft Purview'
  'Azure Machine Learning'
  'Azure Firewall'
  'Virtual Network'
  'Azure DNS'
  'Azure Monitor'
  'Log Analytics'
]

resource serviceHealthAlert 'Microsoft.Insights/activityLogAlerts@2020-10-01' = {
  name: 'csa-service-health-${environment}'
  location: 'Global'
  properties: {
    scopes: [subscription().id]
    enabled: true
    description: 'Alerts for Azure service health events affecting CSA-in-a-Box services'
    condition: {
      allOf: [
        {
          field: 'category'
          equals: 'ServiceHealth'
        }
        {
          field: 'properties.impactedServices[*].ServiceName'
          containsAny: monitoredServices
        }
        {
          field: 'properties.impactedServices[*].ImpactedRegions[*].RegionName'
          containsAny: monitoredRegions
        }
      ]
    }
    actions: {
      actionGroups: [
        {
          actionGroupId: actionGroupId
        }
      ]
    }
  }
}

resource plannedMaintenanceAlert 'Microsoft.Insights/activityLogAlerts@2020-10-01' = {
  name: 'csa-planned-maintenance-${environment}'
  location: 'Global'
  properties: {
    scopes: [subscription().id]
    enabled: true
    description: 'Alerts for planned maintenance on CSA-in-a-Box services'
    condition: {
      allOf: [
        {
          field: 'category'
          equals: 'ServiceHealth'
        }
        {
          field: 'properties.incidentType'
          equals: 'Maintenance'
        }
        {
          field: 'properties.impactedServices[*].ImpactedRegions[*].RegionName'
          containsAny: monitoredRegions
        }
      ]
    }
    actions: {
      actionGroups: [
        {
          actionGroupId: actionGroupId
        }
      ]
    }
  }
}
