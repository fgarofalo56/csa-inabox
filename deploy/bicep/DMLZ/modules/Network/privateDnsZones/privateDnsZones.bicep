targetScope = 'resourceGroup'

// Parameters
@allowed([
  'dev'
  'test'
  'prod'
])
@minLength(2)
@maxLength(10)
@description('Deployment Environment')
param env string = 'dev'
param tags object = {
  Owner: 'Data Management and Analytics'
  CloudSacle: 'DMLZ'
  Domain: 'Networking'
  Contact: 'frgarofa'
  Project: 'Data Management and Analytics'
  Environment: env
  Toolkit: 'bicep'
  costCenter: '12345'
}

param utcValue string = utcNow()
param subscriptionId string = subscription().subscriptionId
param location string = resourceGroup().location
param identityType string = 'UserAssigned'
param userAssignedIdentities array = [
  '/subscriptions/${subscriptionId}/resourcegroups/demo-mdw-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mdw-devuser'
]

// Variables
var privateDnsZoneNames = [
  'privatelink.afs.azure.net'
  'privatelink.analysis.windows.net'
  'privatelink.api.azureml.ms'
  'privatelink.azure-automation.net'
  'privatelink.azure-devices.net'
  'privatelink.adf.azure.com'
  'privatelink.azurecr.io'
  'privatelink.azuredatabricks.net'
  'privatelink.azuresynapse.net'
  'privatelink.azurewebsites.net'
  'privatelink.blob.${environment().suffixes.storage}'
  'privatelink.cassandra.cosmos.azure.com'
  'privatelink.cognitiveservices.azure.com'
  'privatelink${environment().suffixes.sqlServerHostname}'
  'privatelink.datafactory.azure.net'
  'privatelink.dev.azuresynapse.net'
  'privatelink.dfs.${environment().suffixes.storage}'
  'privatelink.documents.azure.com'
  'privatelink.eventgrid.azure.net'
  'privatelink.file.${environment().suffixes.storage}'
  'privatelink.gremlin.cosmos.azure.com'
  'privatelink.mariadb.database.azure.com'
  'privatelink.mongo.cosmos.azure.com'
  'privatelink.mysql.database.azure.com'
  'privatelink.notebooks.azure.net'
  'privatelink.pbidedicated.windows.net'
  'privatelink.postgres.database.azure.com'
  'privatelink.purview.azure.com'
  'privatelink.purviewstudio.azure.com'
  'privatelink.queue.${environment().suffixes.storage}'
  'privatelink.redis.cache.windows.net'
  'privatelink.search.windows.net'
  'privatelink.service.signalr.net'
  'privatelink.servicebus.windows.net'
  'privatelink.sql.azuresynapse.net'
  'privatelink.table.${environment().suffixes.storage}'
  'privatelink.table.cosmos.azure.com'
  'privatelink.prod.powerquery.microsoft.com'
  'privatelink.vaultcore.azure.net'
  'privatelink.web.${environment().suffixes.storage}'
]

var AllvNets = [
  'demo-core-vnet'
  'demo-privatelink-vnet'
]

var allZonesVnets = [for i in range(0, (length(privateDnsZoneNames) * length(AllvNets))): {
  ZoneName: privateDnsZoneNames[i % length(privateDnsZoneNames)]
  vNetName: AllvNets[i % length(AllvNets)]
}]

 var allZones = [for zone in privateDnsZoneNames:'\'${zone}\'']
 var allZonesString = join(allZones, ', ')


// Resources
resource GetExistingVNetLinks 'Microsoft.Resources/deploymentScripts@2020-10-01' = {
  name: 'GetExistingVNetLinks'
  location: location
  identity: {
    type: identityType
    userAssignedIdentities: {
      '${userAssignedIdentities[0]}':{}
    }
  }
  kind: 'AzurePowerShell'
  properties: {
    forceUpdateTag: utcValue
    azPowerShellVersion: '10.1'
    timeout: 'PT1H'
    arguments: '-zones ${allZonesString} -ResourceGroupName \'${resourceGroup().name}\' '
    scriptContent: '''
    param([string[]] $zones, [string] $ResourceGroupName)
    $existingLinks = @()
    $output = @()
    foreach ($zone in $zones) {
      Try {
        $existingLinks += Get-AzPrivateDnsVirtualNetworkLink -ZoneName $zone -ResourceGroupName $ResourceGroupName -ErrorAction 'Ignore' | Select ZoneName, @{label='vNetName', expression={$_.VirtualNetworkId.Split('/')[-1]}}
      } Catch {
      }      
    }
    $output = $existingLinks 
    $DeploymentScriptOutputs = @{}
    $DeploymentScriptOutputs['linkedvNets'] = $output
   '''
    cleanupPreference: 'OnSuccess'
    retentionInterval: 'P1D'
  }
}

module linkedvnet 'virtualNetworkLinks.bicep' = [for item in array(union(allZonesVnets,[])): {
  name: '${item.ZoneName}-${uniqueString(item.vNetName, item.ZoneName, utcValue)}'
  params: {
    exists: (contains(GetExistingVNetLinks.properties.outputs.linkedvNets, item) ? true : false) ?? false
    tags: tags
    vNetName: item.vNetName
    pzone: item.ZoneName
    env: env
  }
}]

// output rg array = [for item in array(union(allZonesVnets,[])):{
//   name: item.vNetName
//   zone: item.ZoneName
//   exists: (contains(array(GetExistingVNetLinks.properties.outputs.linkedvNets), item) ? true : false) ?? false
//   resourceGroup: string(resourceGroup(resourceId('Microsoft.Network/virtualNetworks', item.vNetName)))
// }]

// output lookuplinkedvNets array = GetExistingVNetLinks.properties.outputs.linkedvNets
