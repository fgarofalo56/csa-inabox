// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// This template is used as a module from the main.bicep template. 
// The module contains a template to create external storage resources.
targetScope = 'resourceGroup'

// Parameters
@description('Deployment location')
param location string

@description('Deployment prefix')
param prefix string

@description('Private endpoint subnet ID')
param tags object

@description('Base Storage account name')
param storageAccountName string

@description('Subnets for private endpoints')
param privateEndpointSubnets array = []

@description('Private DNS zone Location Information')
param privateDNSZones object
// Variables

var storageExternal001Name = '${prefix}-${storageAccountName}-ext001'
var fileSytemNames = [
  'data'
]

// Resources
module storageExternal001 'externalstorage.bicep' = {
  name: 'storageExternal001'
  scope: resourceGroup()
  params: {
    location: location
    tags: tags
    privateEndpointSubnets: privateEndpointSubnets
    storageName: storageExternal001Name
    privateDNSZones: privateDNSZones
    fileSystemNames: fileSytemNames
  }
}
