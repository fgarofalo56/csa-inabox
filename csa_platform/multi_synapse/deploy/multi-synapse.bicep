// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Multi-Synapse — deploys multiple Synapse Analytics workspaces with shared
// infrastructure for multi-organization analytics environments.

targetScope = 'subscription'

// ─── Parameters ─────────────────────────────────────────────────────────────

@description('Azure region for resource deployment.')
param location string

@description('Resource tags applied to all deployed resources.')
param tags object = {}

@description('Environment identifier.')
@allowed(['dev', 'stg', 'prod'])
param environment string

@description('List of organization names. Each gets its own Synapse workspace, storage account, and resource group.')
param organizations array

@description('SQL administrator username shared across all workspaces.')
param sqlAdminUsername string = 'SqlServerMainUser'

@description('SQL administrator password shared across all workspaces.')
@secure()
param sqlAdminPassword string

@description('Azure AD group name for Synapse SQL admin access.')
param synapseSqlAdminGroupName string = ''

@description('Azure AD group object ID for Synapse SQL admin access.')
param synapseSqlAdminGroupObjectId string = ''

@description('Log Analytics workspace resource ID for shared diagnostics.')
param logAnalyticsWorkspaceId string = ''

@description('Purview resource ID for lineage integration.')
param purviewId string = ''

@description('VNet resource group name for private endpoints.')
param vnetResourceGroupName string = ''

@description('VNet name for private endpoints.')
param vnetName string = ''

@description('Subnet name for private endpoints.')
param peSubnetName string = ''

@description('Synapse SQL private DNS zone resource ID.')
param privateDnsZoneIdSynapseSql string = ''

@description('Synapse Dev private DNS zone resource ID.')
param privateDnsZoneIdSynapseDev string = ''

@description('SQL pool SKU for dedicated pools. Set empty to skip dedicated pool.')
@allowed(['', 'DW100c', 'DW200c', 'DW300c', 'DW400c', 'DW500c', 'DW1000c'])
param sqlPoolSku string = 'DW100c'

@description('Spark pool node size.')
@allowed(['Small', 'Medium', 'Large'])
param sparkNodeSize string = 'Small'

@description('Spark pool minimum node count.')
param sparkMinNodes int = 3

@description('Spark pool maximum node count.')
param sparkMaxNodes int = 10

@description('Enable Customer-Managed Key (CMK) encryption.')
param enableCmk bool = false

@description('Attach CanNotDelete resource locks.')
param enableResourceLock bool = true

@description('Storage SKU for data lake accounts.')
@allowed(['Standard_LRS', 'Standard_ZRS', 'Standard_GRS', 'Standard_RAGRS'])
param storageSku string = 'Standard_ZRS'

// ─── Variables ──────────────────────────────────────────────────────────────

var sharedRgName = 'rg-${environment}-synapse-shared-${location}'

// ─── Shared Resource Group ──────────────────────────────────────────────────

@description('Shared resource group for common infrastructure (VNet, Log Analytics, Purview).')
resource sharedRg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: sharedRgName
  location: location
  tags: union(tags, {
    Environment: environment
    Pattern: 'MultiSynapse'
    Purpose: 'Shared infrastructure'
  })
}

// ─── Per-Organization Resource Groups ───────────────────────────────────────

@description('One resource group per organization.')
resource orgResourceGroups 'Microsoft.Resources/resourceGroups@2024-03-01' = [
  for org in organizations: {
    name: 'rg-${environment}-synapse-${org}-${location}'
    location: location
    tags: union(tags, {
      Environment: environment
      Organization: org
      Pattern: 'MultiSynapse'
      CostCenter: 'CC-${org}'
    })
  }
]

// ─── Per-Organization Synapse Deployments ───────────────────────────────────

@description('Deploy Synapse workspace + storage for each organization.')
module orgDeployments 'modules/org-synapse.bicep' = [
  for (org, i) in organizations: {
    name: 'synapse-${org}-${uniqueString(org, environment)}'
    scope: orgResourceGroups[i]
    params: {
      location: location
      tags: union(tags, {
        Organization: org
        CostCenter: 'CC-${org}'
      })
      orgName: org
      environment: environment
      sqlAdminUsername: sqlAdminUsername
      sqlAdminPassword: sqlAdminPassword
      synapseSqlAdminGroupName: synapseSqlAdminGroupName
      synapseSqlAdminGroupObjectId: synapseSqlAdminGroupObjectId
      logAnalyticsWorkspaceId: logAnalyticsWorkspaceId
      purviewId: purviewId
      sqlPoolSku: sqlPoolSku
      sparkNodeSize: sparkNodeSize
      sparkMinNodes: sparkMinNodes
      sparkMaxNodes: sparkMaxNodes
      enableCmk: enableCmk
      enableResourceLock: enableResourceLock
      storageSku: storageSku
      privateEndpointSubnets: !empty(vnetResourceGroupName) ? [
        {
          vNetName: vnetName
          subnetName: peSubnetName
          vNetResourceGroup: vnetResourceGroupName
          SubscriptionId: subscription().subscriptionId
          vNetLocation: location
        }
      ] : []
      privateDnsZoneIdSynapseSql: privateDnsZoneIdSynapseSql
      privateDnsZoneIdSynapseDev: privateDnsZoneIdSynapseDev
    }
  }
]

// ─── Outputs ────────────────────────────────────────────────────────────────

@description('Resource group names per organization.')
output organizationResourceGroups array = [
  for (org, i) in organizations: {
    organization: org
    resourceGroup: orgResourceGroups[i].name
  }
]

@description('Synapse workspace names per organization.')
output synapseWorkspaces array = [
  for (org, i) in organizations: {
    organization: org
    workspaceName: orgDeployments[i].outputs.synapseName
    workspaceId: orgDeployments[i].outputs.synapseId
  }
]
