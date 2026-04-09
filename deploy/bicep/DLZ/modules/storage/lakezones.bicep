// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// This template is used as a module from the main.bicep template.
// The module contains a template to create storage resources.
targetScope = 'resourceGroup'

// Parameters
@description('Deployment location')
param location string

@description('Prefix for naming resources')
param prefix string

@description('Base Storage account name')
param storageAccountName string

@description('Tags to apply to resources')
param tags object = {}

@description('Subnets for private endpoints')
param privateEndpointSubnets array = []

@description('Private DNS zone Location Information')
param privateDNSZones object

@description('Private DNS Zone ID for Blob group')
param privateDnsZoneIdBlob string = ''

@description('File system names for domain data storage')
param domainFileSystemNames array = []

@description('File system names for data products storage')
param dataProductFileSystemNames array = []

// Variables
var storageRawName = '${prefix}-${storageAccountName}-raw'
var storageEnrichedCuratedName = '${prefix}-${storageAccountName}-encur'
var storageWorkspaceName = '${prefix}-${storageAccountName}-work'

// Resources
@description('Module to create Raw Storage')
module storageRaw 'storage.bicep' = {
  name: 'storageRaw'
  scope: resourceGroup()
  params: {
    location: location
    tags: tags
    privateEndpointSubnets: privateEndpointSubnets
    storageName: storageRawName
    privateDNSZones: privateDNSZones
    fileSystemNames: domainFileSystemNames
  }
}

@description('Module to create Enriched and Curated Storage')
module storageEnrichedCurated 'storage.bicep' = {
  name: 'storageEnrichedCurated'
  scope: resourceGroup()
  params: {
    location: location
    tags: tags
    privateEndpointSubnets: privateEndpointSubnets
    storageName: storageEnrichedCuratedName
    privateDNSZones: privateDNSZones
    fileSystemNames: domainFileSystemNames
  }
}

@description('Module to create Workspace Storage')
module storageWorkspace 'storage.bicep' = {
  name: 'storageWorkspace'
  scope: resourceGroup()
  params: {
    location: location
    tags: tags
    privateEndpointSubnets: privateEndpointSubnets
    storageName: storageWorkspaceName
    privateDNSZones: privateDNSZones
    fileSystemNames: dataProductFileSystemNames
  }
}

// Outputs
@description('Raw storage account ID')
output storageRawId string = storageRaw.outputs.storageId

@description('Raw storage file system ID')
output storageRawFileSystemId string = storageRaw.outputs.storageFileSystemIds[0].storageFileSystemId

@description('Enriched and Curated storage account ID')
output storageEnrichedCuratedId string = storageEnrichedCurated.outputs.storageId

@description('Enriched and Curated storage file system ID')
output storageEnrichedCuratedFileSystemId string = storageEnrichedCurated.outputs.storageFileSystemIds[0].storageFileSystemId

@description('Workspace storage account ID')
output storageWorkspaceId string = storageWorkspace.outputs.storageId

@description('Workspace storage file system ID')
output storageWorkspaceFileSystemId string = storageWorkspace.outputs.storageFileSystemIds[0].storageFileSystemId
