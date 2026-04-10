// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// This template is used to create a Container Registry.
targetScope = 'resourceGroup'

// Parameters
param location string
param tags object
param subnetId string
param containerRegistryName string
param privateDnsZoneIdContainerRegistry string = ''

@description('Attach a CanNotDelete resource lock to the ACR. Default true for production safety.')
param enableResourceLock bool = true

@description('Log Analytics workspace resource ID for diagnostic settings. Leave empty to skip diagnostics.')
param logAnalyticsWorkspaceId string = ''

// Variables
var containerRegistryNameCleaned = replace(containerRegistryName, '-', '')
var containerRegistryPrivateEndpointName = '${containerRegistry.name}-private-endpoint'

// Resources
resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: containerRegistryNameCleaned
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  sku: {
    name: 'Premium'
  }
  properties: {
    adminUserEnabled: false
    // anonymousPullEnabled cannot be true while publicNetworkAccess is
    // Disabled — the ACR would reject anonymous pulls anyway, so keep the
    // intent explicit.
    anonymousPullEnabled: false
    dataEndpointEnabled: false
    networkRuleBypassOptions: 'None'
    networkRuleSet: {
      defaultAction: 'Deny'
      ipRules: []
      virtualNetworkRules: []
    }
    policies: {
      quarantinePolicy: {
        status: 'enabled'
      }
      retentionPolicy: {
        status: 'enabled'
        days: 7
      }
      trustPolicy: {
        status: 'disabled'
        type: 'Notary'
      }
    }
    publicNetworkAccess: 'Disabled'
    // zoneRedundancy: 'Enabled'  // Uncomment to allow zone redundancy for your Container Registry
  }
}

resource containerRegistryPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: containerRegistryPrivateEndpointName
  location: location
  tags: tags
  properties: {
    manualPrivateLinkServiceConnections: []
    privateLinkServiceConnections: [
      {
        name: containerRegistryPrivateEndpointName
        properties: {
          groupIds: [
            'registry'
          ]
          privateLinkServiceId: containerRegistry.id
          requestMessage: ''
        }
      }
    ]
    subnet: {
      id: subnetId
    }
  }
}

resource containerRegistryPrivateEndpointARecord 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = if(!empty(privateDnsZoneIdContainerRegistry)) {
  parent: containerRegistryPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: '${containerRegistryPrivateEndpoint.name}-arecord'
        properties: {
          privateDnsZoneId: privateDnsZoneIdContainerRegistry
        }
      }
    ]
  }
}

// Resource lock — protects the ACR from accidental deletion.
resource containerRegistryLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: containerRegistry
  name: '${containerRegistryNameCleaned}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box: DMLZ container registry. Delete via the rollback workflow in docs/ROLLBACK.md.'
  }
}

// Diagnostic settings — ship registry repository + login events to Log
// Analytics for audit.
resource containerRegistryDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${containerRegistryNameCleaned}-diagnostics'
  scope: containerRegistry
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

// Outputs
