// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// This template is used as a module from the main.bicep template. 
// The module contains a template to create the governance services.
targetScope = 'resourceGroup'

// Parameters
param location string
param defaultTags object
param prefix string
param environment string

// param subnetId string
// param privateDnsZoneIdPurview string = ''
// param privateDnsZoneIdPurviewPortal string = ''
// param privateDnsZoneIdStorageBlob string = ''
// param privateDnsZoneIdStorageQueue string = ''
// param privateDnsZoneIdEventhubNamespace string = ''
// param privateDnsZoneIdKeyVault string = ''

param governanceResourceGroup string

//Moddules and Resources to deploy
@description('Specify the modules and resources to deploy')
param deployModules object = {}

// Governance module parameters
@sys.description('Array to hold all vaules for Governance module.')
param parGovernance object

// Variables
// Parameter to build base name for resources to include prefix and environment
@sys.description('Parameter to build base name for resources to include prefix and environment')
param parBaseName string = '${prefix}-${environment}'

var varPurview001Name = toLower(substring(
  '${parBaseName}-${parGovernance.purviewAcountName}}',
  0,
  min(length('${parBaseName}-${parGovernance.purviewAcountName}'), 24)
))

// var keyvault001Name = '${prefix}-vault001'

var varPurviewTags = union(defaultTags, parGovernance.purviewTags)

// Resources
// module purview001 '../Purview/purview.bicep' = {
//   name: 'purview001'
//   scope: resourceGroup()
//   params: {
//     location: location
//     tags: tags
//     subnetId: subnetId
//     purviewName: purview001Name
//     privateDnsZoneIdPurview: privateDnsZoneIdPurview
//     privateDnsZoneIdPurviewPortal: privateDnsZoneIdPurviewPortal
//     privateDnsZoneIdStorageBlob: privateDnsZoneIdStorageBlob
//     privateDnsZoneIdStorageQueue: privateDnsZoneIdStorageQueue
//     privateDnsZoneIdEventhubNamespace: privateDnsZoneIdEventhubNamespace
//   }
// }

//Deploy Purview
module deployPurview '../Purview/purview.bicep' = if (bool(deployModules.governance)) {
  name: 'Deploy-${varPurview001Name}'
  scope: resourceGroup(governanceResourceGroup)
  params: {
    // purviewAcctName: '${parBaseName}-purview-${parGovernance.parLocation}'
    purviewAcctName: varPurview001Name
    sku: parGovernance.purviewSku
    parPurviewPublicNetworkAccess: parGovernance.purviewPublicNetworkAccess
    location: parGovernance.purviewLocation
    parTenantEndpointState: parGovernance.purviewTenantEndpointState
    configKafka: parGovernance.purviewKafkaConfig
    tags: varPurviewTags
  }
  dependsOn: [
    resourceGroup(governanceResourceGroup)
  ]
}

// module keyVault001 'services/keyvault.bicep' = {
//   name: 'keyVault001'
//   scope: resourceGroup()
//   params: {
//     location: location
//     tags: tags
//     subnetId: subnetId
//     keyvaultName: keyvault001Name
//     privateDnsZoneIdKeyVault: privateDnsZoneIdKeyVault
//   }
// }

// module purviewKeyVaultRoleAssignment 'auxiliary/purviewRoleAssignmentKeyVault.bicep' = {
//   name: 'purviewKeyVaultRoleAssignment'
//   scope: resourceGroup()
//   params: {
//     purviewId: purview001.outputs.purviewId
//     keyVaultId: keyVault001.outputs.keyvaultId
//   }
// }

// // Outputs
// output purviewId string = purview001.outputs.purviewId
// output purviewManagedStorageId string = purview001.outputs.purviewManagedStorageId
// output purviewManagedEventHubId string = purview001.outputs.purviewManagedEventHubId
