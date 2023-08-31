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

 var allZones = [for zone in privateDnsZoneNames: concat('\'', zone, '\'')]
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
    Write-Output "Starting GetExistingVNetLinks script"
    foreach ($zone in $zones) { `
      Write-Output "Running Get-AzPrivateDnsVirtualNetworkLink for zone: $zone"
      $existingLinks += Get-AzPrivateDnsVirtualNetworkLink -ZoneName $zone -ResourceGroupName $ResourceGroupName | Select Name, ZoneName, ResourceGroupName, VirtualNetworkId, VirtualNetworkLinkState
      Write-Output "Finished Get-AzPrivateDnsVirtualNetworkLink for zone: $zone"
    }
    $output = $existingLinks
    $DeploymentScriptOutputs = @{}
    $DeploymentScriptOutputs['linkedvNets'] = $output
    Write-Output "Finished GetExistingVNetLinks script"
   '''
    cleanupPreference: 'OnSuccess'
    retentionInterval: 'P1D'
  }
}

var testarray = [for zone in privateDnsZoneNames: '\'${zone}\', \'${vnetId}\'']
var test = intersection(GetExistingVNetLinks.properties.outputs['linkedvNets'], testarray)

// module linkedvnet 'privatednszone.bicep' = [for zone in privateDnsZoneNames: {
//   name: '${zone}-${vNetName}'
//   scope: resourceGroup()
//   params: {
//     exists: (contains(test,vnetId) && contains(test,zone) && contains(GetExistingVNetLinks.properties.outputs['linkedvNets'], vNetName) ? true : false)
//     tags: tags
//     vNetName: vNetName
//     pzone: zone
//     env: env
    
//   }
// }]

// // Outputs
// output linkedvnet array = [for zone in privateDnsZoneNames: {
//   name: linkedvnet[0].name
//   value: linkedvnet[0].outputs
// }]

output testarray array = testarray
output test array = test
