// ============================================================================
// CSA-in-a-Box: GeoAnalytics Landing Zone (OSS Path)
// ============================================================================
// This module deploys open-source-friendly geospatial analytics infrastructure:
// - PostgreSQL with PostGIS for spatial queries and vector tiles
// - Azure Maps for geocoding, routing, and basemap rendering
// - ADLS Gen2 storage for GeoParquet / cloud-native geospatial formats
// - Databricks workspace for Apache Sedona / large-scale geospatial notebooks
// ============================================================================

targetScope = 'resourceGroup'

// ============================================================================
// Parameters
// ============================================================================

@description('The name prefix for all resources')
param namePrefix string = 'csa'

@description('The environment name (dev, staging, prod)')
param environment string = 'dev'

@description('Azure region for resources')
param location string = resourceGroup().location

@description('Tags to apply to all resources')
param tags object = {}

@description('Log Analytics workspace resource ID for diagnostic settings')
param logAnalyticsWorkspaceResourceId string = ''

@description('Subnet resource ID for private endpoints (optional)')
param subnetId string = ''

@description('Enable private endpoints for all services')
param enablePrivateEndpoints bool = false

@description('PostgreSQL administrator login name')
param postgresAdminLogin string = 'geoadmin'

@description('PostgreSQL administrator password — use Key Vault in production')
@secure()
param postgresAdminPassword string

@description('PostgreSQL SKU name')
param postgresSkuName string = 'Standard_B1ms'

@description('PostgreSQL SKU tier')
@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param postgresSkuTier string = 'Burstable'

@description('Databricks workspace SKU — Premium required for Unity Catalog')
@allowed(['standard', 'premium'])
param databricksSku string = 'premium'

// ============================================================================
// Variables
// ============================================================================

var uniqueId = substring(uniqueString(resourceGroup().id), 0, 4)
var baseName = '${namePrefix}-geo-${environment}-${uniqueId}'

// ============================================================================
// PostgreSQL Flexible Server with PostGIS
// ============================================================================

// PostGIS extends PostgreSQL with geometry types, spatial indexing (GiST),
// and hundreds of spatial functions — the de facto standard for OSS geospatial.
resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: '${baseName}-postgres'
  location: location
  tags: tags
  sku: {
    name: postgresSkuName
    tier: postgresSkuTier
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    version: '16'
    storage: {
      storageSizeGB: environment == 'prod' ? 256 : 32
      tier: 'P4'
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: environment == 'prod' ? 35 : 7
      geoRedundantBackup: environment == 'prod' ? 'Enabled' : 'Disabled'
    }
    network: enablePrivateEndpoints ? {
      publicNetworkAccess: 'Disabled'
      delegatedSubnetResourceId: subnetId
    } : {
      publicNetworkAccess: 'Enabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    maintenanceWindow: {
      customWindow: 'Enabled'
      dayOfWeek: 0
      startHour: 2
      startMinute: 0
    }
  }
}

// Enable PostGIS and related extensions via azure.extensions server parameter.
// This allowlists extensions; CREATE EXTENSION must still be run in-database.
resource postgresExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-12-01-preview' = {
  parent: postgresServer
  name: 'azure.extensions'
  properties: {
    value: 'POSTGIS,POSTGIS_RASTER,POSTGIS_TOPOLOGY,FUZZYSTRMATCH,POSTGIS_TIGER_GEOCODER'
    source: 'user-override'
  }
}

resource postgresDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01-preview' = {
  parent: postgresServer
  name: 'geodata'
  properties: {
    charset: 'utf8'
    collation: 'en_US.utf8'
  }
}

// ============================================================================
// Azure Maps Account
// ============================================================================

// Gen2 S1 provides geocoding, routing, rendering, and spatial operations.
// Gen2 is required for new deployments and provides the latest API features.
resource mapsAccount 'Microsoft.Maps/accounts@2023-06-01' = {
  name: '${baseName}-maps'
  location: 'global' // Azure Maps is a global service
  tags: tags
  sku: {
    name: 'G2'
  }
  kind: 'Gen2'
  properties: {
    disableLocalAuth: false
  }
}

// ============================================================================
// ADLS Gen2 Storage — GeoParquet & Cloud-Native Geospatial
// ============================================================================

// Hierarchical namespace (HNS) enables efficient directory operations and
// is required for ADLS Gen2 semantics used by Spark/Sedona and GeoParquet.
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: replace('${baseName}geo', '-', '')
  location: location
  tags: tags
  sku: {
    name: environment == 'prod' ? 'Standard_GRS' : 'Standard_LRS'
  }
  kind: 'StorageV2'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    isHnsEnabled: true
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    publicNetworkAccess: enablePrivateEndpoints ? 'Disabled' : 'Enabled'
    networkAcls: enablePrivateEndpoints ? {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    } : {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource geospatialContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  name: '${storageAccount.name}/default/geospatial'
  properties: {
    publicAccess: 'None'
  }
}

// ============================================================================
// Azure Databricks Workspace — Apache Sedona for Geospatial at Scale
// ============================================================================

// Databricks with Apache Sedona provides distributed geospatial processing
// over GeoParquet, spatial joins, and visualization via Kepler.gl notebooks.
// Premium SKU required for Unity Catalog and fine-grained access control.
resource databricksWorkspace 'Microsoft.Databricks/workspaces@2024-05-01' = {
  name: '${baseName}-dbw'
  location: location
  tags: tags
  sku: {
    name: databricksSku
  }
  properties: {
    managedResourceGroupId: subscriptionResourceId('Microsoft.Resources/resourceGroups', '${baseName}-dbw-managed-rg')
    publicNetworkAccess: enablePrivateEndpoints ? 'Disabled' : 'Enabled'
    parameters: {
      enableNoPublicIp: {
        value: enablePrivateEndpoints
      }
    }
  }
}

// ============================================================================
// Private Endpoints (if enabled)
// ============================================================================

resource storagePrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = if (enablePrivateEndpoints) {
  name: '${baseName}-storage-pe'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: subnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${baseName}-storage-pe-connection'
        properties: {
          privateLinkServiceId: storageAccount.id
          groupIds: ['dfs'] // ADLS Gen2 uses dfs endpoint
        }
      }
    ]
  }
}

// ============================================================================
// Diagnostic Settings
// ============================================================================

resource postgresDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceResourceId)) {
  scope: postgresServer
  name: 'postgres-diagnostics'
  properties: {
    workspaceId: logAnalyticsWorkspaceResourceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
        retentionPolicy: {
          enabled: false
          days: 0
        }
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
        retentionPolicy: {
          enabled: false
          days: 0
        }
      }
    ]
  }
}

resource databricksDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceResourceId)) {
  scope: databricksWorkspace
  name: 'databricks-diagnostics'
  properties: {
    workspaceId: logAnalyticsWorkspaceResourceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
        retentionPolicy: {
          enabled: false
          days: 0
        }
      }
    ]
  }
}

// ============================================================================
// Outputs
// ============================================================================

output postgresqlFqdn string = postgresServer.properties.fullyQualifiedDomainName
output postgresqlServerName string = postgresServer.name
output postgresqlServerId string = postgresServer.id
output mapsAccountName string = mapsAccount.name
output mapsAccountId string = mapsAccount.id
output storageAccountName string = storageAccount.name
output storageAccountId string = storageAccount.id
output databricksWorkspaceUrl string = databricksWorkspace.properties.workspaceUrl
output databricksWorkspaceId string = databricksWorkspace.id
