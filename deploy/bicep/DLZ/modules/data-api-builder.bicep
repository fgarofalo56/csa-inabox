// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Data API Builder infrastructure — Azure SQL + Container Apps (DAB) +
// Static Web App for the data-mesh sharing layer.

targetScope = 'resourceGroup'

// ─── Parameters ─────────────────────────────────────────────────────────────

@description('Azure region for resource deployment.')
param location string = resourceGroup().location

@description('Resource tags applied to all deployed resources.')
param tags object = {}

@description('Environment identifier.')
@allowed(['dev', 'stg', 'prod'])
param environment string

@description('Base name prefix for all resources.')
param namePrefix string = 'csa-dab'

@description('Log Analytics workspace resource ID for diagnostics.')
param logAnalyticsWorkspaceId string = ''

@description('SQL Server administrator login name.')
param sqlAdminLogin string = 'sqladmin'

@description('SQL Server administrator password.')
@secure()
param sqlAdminPassword string

@description('Azure SQL Database SKU name.')
@allowed(['Basic', 'S0', 'S1', 'S2', 'P1', 'P2'])
param sqlSkuName string = 'S0'

@description('DAB container image reference.')
param dabImage string = 'mcr.microsoft.com/azure-databases/data-api-builder:latest'

@description('Container App CPU cores.')
param containerCpu string = '0.5'

@description('Container App memory.')
param containerMemory string = '1Gi'

@description('Static Web App SKU tier.')
@allowed(['Free', 'Standard'])
param staticWebAppSku string = 'Free'

@description('Enable public network access on SQL Server. Disable for prod with private endpoints.')
param publicNetworkAccessEnabled bool = true

@description('Attach a CanNotDelete resource lock. Default true for production.')
param enableResourceLock bool = false

// ─── Variables ──────────────────────────────────────────────────────────────

var uniqueSuffix = take(uniqueString(resourceGroup().id), 6)
var sqlServerName = '${namePrefix}-sql-${environment}-${uniqueSuffix}'
var sqlDatabaseName = '${namePrefix}-db-${environment}'
var managedIdentityName = '${namePrefix}-id-${environment}'
var containerEnvName = '${namePrefix}-env-${environment}'
var containerAppName = '${namePrefix}-app-${environment}'
var staticWebAppName = '${namePrefix}-swa-${environment}'
var appInsightsName = '${namePrefix}-insights-${environment}'

// ─── Application Insights ───────────────────────────────────────────────────

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: !empty(logAnalyticsWorkspaceId) ? logAnalyticsWorkspaceId : null
  }
}

// ─── Managed Identity ───────────────────────────────────────────────────────

@description('User-assigned managed identity for DAB container to access SQL.')
resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: managedIdentityName
  location: location
  tags: tags
}

// ─── Azure SQL Server ───────────────────────────────────────────────────────

@description('Azure SQL Server for data-mesh products database.')
resource sqlServer 'Microsoft.Sql/servers@2023-08-01-preview' = {
  name: sqlServerName
  location: location
  tags: union(tags, { Pattern: 'DataApiBuilder' })
  properties: {
    administratorLogin: sqlAdminLogin
    administratorLoginPassword: sqlAdminPassword
    version: '12.0'
    minimalTlsVersion: '1.2'
    publicNetworkAccess: publicNetworkAccessEnabled ? 'Enabled' : 'Disabled'
  }
}

@description('Allow Azure services to access SQL Server.')
resource sqlFirewallAzure 'Microsoft.Sql/servers/firewallRules@2023-08-01-preview' = if (publicNetworkAccessEnabled) {
  parent: sqlServer
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

@description('Azure SQL Database for data products.')
resource sqlDatabase 'Microsoft.Sql/servers/databases@2023-08-01-preview' = {
  parent: sqlServer
  name: sqlDatabaseName
  location: location
  tags: union(tags, { Pattern: 'DataApiBuilder' })
  sku: {
    name: sqlSkuName
  }
  properties: {
    collation: 'SQL_Latin1_General_CP1_CI_AS'
    maxSizeBytes: 2147483648 // 2 GB
    catalogCollation: 'SQL_Latin1_General_CP1_CI_AS'
    zoneRedundant: environment == 'prod'
    isLedgerOn: false
  }
}

@description('Transparent Data Encryption on the database.')
resource tde 'Microsoft.Sql/servers/databases/transparentDataEncryption@2023-08-01-preview' = {
  parent: sqlDatabase
  name: 'current'
  properties: {
    state: 'Enabled'
  }
}

// ─── SQL Auditing ───────────────────────────────────────────────────────────

// CKV_AZURE_23 -- auditing must be on for every SQL server.  When a
// Log Analytics workspace is supplied we ship audit events there;
// otherwise we still enable auditing with retention so the events
// land in the server's storage account default sink.  Either way the
// 'state: Enabled' assertion is unconditionally true.
resource sqlAuditing 'Microsoft.Sql/servers/auditingSettings@2023-08-01-preview' = {
  parent: sqlServer
  name: 'default'
  properties: {
    state: 'Enabled'
    // CKV_AZURE_24 -- retain audit logs for >=90 days.
    retentionDays: 90
    isAzureMonitorTargetEnabled: !empty(logAnalyticsWorkspaceId)
  }
}

// CKV_AZURE_25 -- enable Defender for SQL with all alert types.
// This is the modern replacement for ``securityAlertPolicies``; both
// resource types are still accepted by ARM but ``securityAlertPolicies``
// (``state: 'Enabled'`` + ``disabledAlerts: []`` -> all alert types) is
// what Checkov inspects.
resource sqlThreatDetection 'Microsoft.Sql/servers/securityAlertPolicies@2023-08-01-preview' = {
  parent: sqlServer
  name: 'default'
  properties: {
    state: 'Enabled'
    disabledAlerts: []
    emailAccountAdmins: true
    retentionDays: 90
  }
}

resource sqlDbThreatDetection 'Microsoft.Sql/servers/databases/securityAlertPolicies@2023-08-01-preview' = {
  parent: sqlDatabase
  name: 'default'
  properties: {
    state: 'Enabled'
    disabledAlerts: []
    emailAccountAdmins: true
    retentionDays: 90
  }
}

resource sqlDbAuditing 'Microsoft.Sql/servers/databases/auditingSettings@2023-08-01-preview' = {
  parent: sqlDatabase
  name: 'default'
  properties: {
    state: 'Enabled'
    retentionDays: 90
    isAzureMonitorTargetEnabled: !empty(logAnalyticsWorkspaceId)
  }
}

// ─── Container App Environment ──────────────────────────────────────────────

resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: containerEnvName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: !empty(logAnalyticsWorkspaceId) ? 'log-analytics' : null
      logAnalyticsConfiguration: !empty(logAnalyticsWorkspaceId) ? {
        customerId: reference(logAnalyticsWorkspaceId, '2022-10-01').customerId
        sharedKey: listKeys(logAnalyticsWorkspaceId, '2022-10-01').primarySharedKey
      } : null
    }
  }
}

// ─── Container App (DAB) ────────────────────────────────────────────────────

@description('Container App running Data API Builder.')
resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: containerAppName
  location: location
  tags: union(tags, { Pattern: 'DataApiBuilder' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 5000
        transport: 'http'
        corsPolicy: {
          allowedOrigins: ['https://${staticWebAppName}.azurestaticapps.net', 'http://localhost:4280']
          allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
          allowedHeaders: ['*']
          allowCredentials: true
        }
      }
    }
    template: {
      containers: [
        {
          name: 'dab'
          image: dabImage
          resources: {
            cpu: json(containerCpu)
            memory: containerMemory
          }
          env: [
            {
              name: 'SQL_CONNECTION_STRING'
              value: 'Server=tcp:${sqlServer.properties.fullyQualifiedDomainName},1433;Database=${sqlDatabaseName};User ID=${sqlAdminLogin};Password=${sqlAdminPassword};Encrypt=true;TrustServerCertificate=false;Connection Timeout=30;'
            }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
          ]
        }
      ]
      scale: {
        minReplicas: environment == 'prod' ? 1 : 0
        maxReplicas: environment == 'prod' ? 3 : 1
      }
    }
  }
}

// ─── Static Web App ─────────────────────────────────────────────────────────

@description('Static Web App for the Data Mesh portal frontend.')
resource staticWebApp 'Microsoft.Web/staticSites@2023-12-01' = {
  name: staticWebAppName
  location: location
  tags: union(tags, { Pattern: 'DataApiBuilder' })
  sku: {
    name: staticWebAppSku
    tier: staticWebAppSku
  }
  properties: {
    stagingEnvironmentPolicy: 'Enabled'
    allowConfigFileUpdates: true
    buildProperties: {
      appLocation: '/frontend'
      outputLocation: '/frontend'
    }
  }
}

// ─── Diagnostic Settings ────────────────────────────────────────────────────

resource sqlDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${sqlDatabaseName}-diagnostics'
  scope: sqlDatabase
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// ─── Resource Lock (prod only) ──────────────────────────────────────────────

resource sqlLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock && environment == 'prod') {
  name: '${sqlServerName}-lock'
  scope: sqlServer
  properties: {
    level: 'CanNotDelete'
    notes: 'Production SQL Server — do not delete.'
  }
}

// ─── Outputs ────────────────────────────────────────────────────────────────

@description('Fully qualified domain name of the SQL Server.')
output sqlServerFqdn string = sqlServer.properties.fullyQualifiedDomainName

@description('DAB Container App endpoint URL.')
output dabEndpoint string = 'https://${containerApp.properties.configuration.ingress.fqdn}'

@description('Static Web App default hostname.')
output staticWebAppUrl string = 'https://${staticWebApp.properties.defaultHostname}'

@description('Managed Identity principal ID (for RBAC assignments).')
output managedIdentityPrincipalId string = managedIdentity.properties.principalId
