//Main Bicep file for Azure Policy deployment

targetScope = 'subscription'


// General parameters
@description('Specifies the location for all resources.')
param location string
@allowed([
  'dev'
  'tst'
  'prd'
])
@description('Specifies the environment of the deployment.')
param environment string = 'dev'
@minLength(2)
@maxLength(10)
@description('Specifies the prefix for all resources created in this deployment.')
param prefix string
@description('Specifies the tags that you want to apply to all resources.')
param tags object = {}

// Resource parameters
@description('Specifies the list of user object IDs that are assigned as collection admin to the root collection in Purview.')
param purviewRootCollectionAdminObjectIds array = []
