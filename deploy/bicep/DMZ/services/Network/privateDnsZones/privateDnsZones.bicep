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

param vNetName string = 'demo-core-vnet'
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
var vnetId = resourceId('Microsoft.Network/virtualNetworks', vNetName)
var privateDnsZoneNames = [
   'privatelink.purview.azure.com'
  'privatelink.purviewstudio.azure.com'
  'privatelink.queue.${environment().suffixes.storage}'
  'privatelink.table.${environment().suffixes.storage}'
  'privatelink.blob.${environment().suffixes.storage}'
  'privatelink.file.${environment().suffixes.storage}'
 ]

 var allZones = [for zone in privateDnsZoneNames:'\'${zone}\'']
 var zoneVnet = [for zone in privateDnsZoneNames: {
  ZoneName: zone
  vNetName: vNetName
 }]
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
    arguments: '-zones ${allZonesString} -ResourceGroupName \'${resourceGroup().name}\''
    scriptContent: '''
    param([string[]] $zones, [string] $ResourceGroupName)
    foreach ($zone in $zones) { `
      $existingLinks += Get-AzPrivateDnsVirtualNetworkLink -ZoneName $zone -ResourceGroupName $ResourceGroupName | Select ZoneName, @{label='vNetName'; expression={$_.VirtualNetworkId.Split('/')[-1]}} ` 
    }
    $output = $existingLinks
    $DeploymentScriptOutputs = @{}
    $DeploymentScriptOutputs['linkedvNets'] = $output
   '''
    cleanupPreference: 'OnSuccess'
    retentionInterval: 'P1D'
  }
}

module linkedvnet 'virtualNetworkLinks.bicep' = [for item in zoneVnet: {
  name: '${item.ZoneName}-${item.vNetName}'
  scope: resourceGroup()
  params: {
    exists: (contains(GetExistingVNetLinks.properties.outputs['linkedvNets'], item) ? true : false)
    tags: tags
    vNetName: item.vNetName
    pzone: item.ZoneName
    env: env    
  }
}]


