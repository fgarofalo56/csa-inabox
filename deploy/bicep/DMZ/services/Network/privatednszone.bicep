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

param CorevNetName string = 'demo-core-vnet'
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
var vnetId = resourceId('Microsoft.Network/virtualNetworks', CorevNetName)
var vnetName = length(split(vnetId, '/')) >= 9 ? last(split(vnetId, '/')) : 'incorrectSegmentLength'
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
    Write-Output "zones: $zones"
    Write-Output "ResourceGroupName: $ResourceGroupName"
    $subscriptionId = (Get-AzContext).Subscription.Id
    Write-Output "subscriptionId: $subscriptionId"
    Write-Output "Running Loop for each zone"
    Write-Output "Stating Loop for each lookup got zones"
    foreach ($zone in $zones) { `
      Write-Output "Running Get-AzPrivateDnsVirtualNetworkLink for zone: $zone"
      $existingLinks += Get-AzPrivateDnsVirtualNetworkLink -ZoneName $zone -ResourceGroupName $ResourceGroupName | Select Name, ZoneName, ResourceGroupName, VirtualNetworkId, VirtualNetworkLinkState
      Write-Output "Finished Get-AzPrivateDnsVirtualNetworkLink for zone: $zone"
    }
    $output = $existingLinks | ConvertTo-Json
    Write-Output "Writing output:"
    Write-Output $output
    $DeploymentScriptOutputs = @{}
    $DeploymentScriptOutputs['linkedvNets'] = $output
    Write-Output "DeploymentScriptOutputs:"
    Write-Output $DeploymentScriptOutputs | ConvertTo-Json
    Write-Output "Finished GetExistingVNetLinks script"
   '''
    cleanupPreference: 'OnSuccess'
    retentionInterval: 'P1D'
  }
}

// resource privateDnsZones 'Microsoft.Network/privateDnsZones@2020-06-01' = [for zone in privateDnsZoneNames: {
//   name: zone
//   location: 'global'
//   tags: tags
//   properties: {}
// }]

// resource existingVirtualNetworkLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2018-09-01' = [for zone in privateDnsZoneNames: {
//   name: '${zone}/existing-links'
//   properties: {}
// }]

// resource virtualNetworkLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2018-09-01' = [for zone in privateDnsZoneNames: {
//   name: '${zone}/${link.name}'
//   properties: {
//     virtualNetwork: {
//       id: link.properties.virtualNetwork.id
//     }
//   }
//   dependsOn: [
//     zone
//   ]
//   condition: '${zone}/${link.name}' not in [for link in existingVirtualNetworkLinks: link.name]
// } for link in GetExistingVirtualNetworkLinks(zone.name, subscription().subscriptionId)]

// output existingVirtualNetworkLinks array = [for link in existingVirtualNetworkLinks: {
//   zoneName: link.name
// }]


output linkedVNets object = GetExistingVNetLinks

