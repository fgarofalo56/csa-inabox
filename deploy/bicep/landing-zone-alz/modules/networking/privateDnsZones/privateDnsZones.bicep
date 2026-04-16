metadata name = 'ALZ Bicep - Private DNS Zones'
metadata description = 'Module used to set up Private DNS Zones in accordance to Azure Landing Zones'

type lockType = {
  @description('Optional. Specify the name of lock.')
  name: string?

  @description('Optional. The lock settings of the service.')
  kind: ('CanNotDelete' | 'ReadOnly' | 'None')

  @description('Optional. Notes about this lock.')
  notes: string?
}

@sys.description('The Azure Region to deploy the resources into.')
param parLocation string = resourceGroup().location

@sys.description('Set Parameter to false to skip the addition of a Private DNS Zone for Azure Backup.')
param parPrivateDnsZoneAutoMergeAzureBackupZone bool = true

@sys.description('Tags you would like to be applied to all resources in this module.')
param parTags object = {}

@sys.description('Resource ID of VNet for Private DNS Zone VNet Links.')
param parVirtualNetworkIdToLink string = ''

@sys.description('Resource ID of VNet for Failover Private DNS Zone VNet Links.')
param parVirtualNetworkIdToLinkFailover string = ''

@sys.description('''Resource Lock Configuration for Private DNS Zones.

- `kind` - The lock settings of the service which can be CanNotDelete, ReadOnly, or None.
- `notes` - Notes about this lock.

''')
param parResourceLockConfig lockType = {
  kind: 'None'
  notes: 'This lock was created by the ALZ Bicep Private DNS Zones Module.'
}

var varAzBackupGeoCodes = {
  australiacentral: 'acl'
  australiacentral2: 'acl2'
  australiaeast: 'ae'
  australiasoutheast: 'ase'
  brazilsouth: 'brs'
  brazilsoutheast: 'bse'
  centraluseuap: 'ccy'
  canadacentral: 'cnc'
  canadaeast: 'cne'
  centralus: 'cus'
  eastasia: 'ea'
  eastus2euap: 'ecy'
  eastus: 'eus'
  eastus2: 'eus2'
  francecentral: 'frc'
  francesouth: 'frs'
  germanycentral: 'gec'
  germanynorth: 'gn'
  germanynortheast: 'gne'
  germanywestcentral: 'gwc'
  israelcentral: 'ilc'
  italynorth: 'itn'
  centralindia: 'inc'
  southindia: 'ins'
  westindia: 'inw'
  japaneast: 'jpe'
  japanwest: 'jpw'
  jioindiacentral: 'jic'
  jioindiawest: 'jiw'
  koreacentral: 'krc'
  koreasouth: 'krs'
  northcentralus: 'ncus'
  northeurope: 'ne'
  norwayeast: 'nwe'
  norwaywest: 'nww'
  polandcentral: 'plc'
  qatarcentral: 'qac'
  southafricanorth: 'san'
  southafricawest: 'saw'
  southcentralus: 'scus'
  swedencentral: 'sdc'
  swedensouth: 'sds'
  southeastasia: 'sea'
  switzerlandnorth: 'szn'
  switzerlandwest: 'szw'
  uaecentral: 'uac'
  uaenorth: 'uan'
  uksouth: 'uks'
  ukwest: 'ukw'
  westcentralus: 'wcus'
  westeurope: 'we'
  westus: 'wus'
  westus2: 'wus2'
  westus3: 'wus3'
  usdodcentral: 'udc'
  usdodeast: 'ude'
  usgovarizona: 'uga'
  usgoviowa: 'ugi'
  usgovtexas: 'ugt'
  usgovvirginia: 'ugv'
  usnateast: 'exe'
  usnatwest: 'exw'
  usseceast: 'rxe'
  ussecwest: 'rxw'
  chinanorth: 'bjb'
  chinanorth2: 'bjb2'
  chinanorth3: 'bjb3'
  chinaeast: 'sha'
  chinaeast2: 'sha2'
  chinaeast3: 'sha3'
}

// Variables
// Private DNS Zones for Azure Commercial - AzureCloud
var varAzureCloudPrivateDNSZones = [
  'privatelink${environment().suffixes.keyvaultDns}'
  'privatelink.blob.${environment().suffixes.storage}'
  'privatelink.dfs.${environment().suffixes.storage}'
  'privatelink.file.${environment().suffixes.storage}'
  'privatelink.queue.${environment().suffixes.storage}'
  'privatelink.table.${environment().suffixes.storage}'
  'privatelink.web.${environment().suffixes.storage}'
  'privatelink${environment().suffixes.sqlServerHostname}'
  'privatelink.${replace(toLower(parLocation),' ','')}.azmk8s.io'
  'privatelink.${replace(toLower(parLocation),' ','')}.kusto.windows.net'
  'privatelink.mysql.database.azure.com'
  'privatelink.mariadb.database.azure.com'
  'privatelink.postgres.database.azure.co'
  'privatelink.dev.azuresynapse.net'
  'privatelink.webpubsub.azure.com'
  'privatelink.openai.azure.com'
  'privatelink.services.ai.azure.com'
  'privatelink.token.botframework.com'
  'privatelink.redisenterprise.cache.azure.net'
  'privatelink.pbidedicated.windows.net'
  'privatelink.prod.migration.windowsazure.com'
  'privatelink.prod.powerquery.microsoft.com'
  'privatelink.kubernetesconfiguration.azure.com'
  'privatelink.media.azure.net'
  'privatelink.digitaltwins.azure.net'
  'privatelink.digitaltwins.azure.net'
  'privatelink.directline.botframework.com'
  'privatelink.azurehealthcareapis.com'
  'privatelink.azurestaticapps.net'
  'privatelink.azure-api.net'
  'privatelink.analysis.windows.net'
  'privatelink.afs.azure.net'
  'privatelink.sql.azuresynapse.net'
  'privatelink.azuresynapse.net'
  'privatelink.${replace(toLower(parLocation),' ','')}.batch.azure.com'
  'privatelink.mongo.cosmos.azure.com'
  'privatelink.table.cosmos.azure.com'
  'privatelink.gremlin.cosmos.azure.com'
  'privatelink.documents.azure.com'
  'privatelink.sqlx.cosmos.azure.com'
  'privatelink.adf.azure.com'
  'privatelink.agentsvc.azure-automation.net'
  'privatelink.api.azureml.ms'
  'privatelink.azconfig.io'
  'privatelink.azure-automation.net'
  '${replace(toLower(parLocation),' ','')}.data.privatelink.azurecr.io'
  'privatelink.azurecr.io'
  'privatelink.azure-devices.net'
  'privatelink.azure-devices-provisioning.net'
  'privatelink.azuredatabricks.net'
  'privatelink.azurehdinsight.net'
  'privatelink.azurewebsites.net'
  'scm.privatelink.azurewebsites.net'
  'privatelink.cassandra.cosmos.azure.com'
  'privatelink.cognitiveservices.azure.com'
  'privatelink.datafactory.azure.net'
  'privatelink.dicom.azurehealthcareapis.com'
  'privatelink.fhir.azurehealthcareapis.com'
  'privatelink.workspace.azurehealthcareapis.com'
  'privatelink.eventgrid.azure.net'
  'privatelink.monitor.azure.com'
  'privatelink.notebooks.azure.net'
  'privatelink.ods.opinsights.azure.com'
  'privatelink.oms.opinsights.azure.com'
  'privatelink.purview.azure.com'
  'privatelink.purviewstudio.azure.com'
  'privatelink.redis.cache.windows.net'
  'privatelink.search.windows.net'
  'privatelink.servicebus.windows.net'
  'privatelink.siterecovery.windowsazure.com'
  'privatelink.vaultcore.azure.net'
  'privatelink-global.wvd.microsoft.com'
  'privatelink.wvd.microsoft.com'
  'privatelink.wvd.microsoft.com'
]
// Private DNS Zones for Azure US Government zones - AzureUSGovernment
var varAzureUSGovernmentPrivateDNSZone = [
  'privatelink${environment().suffixes.keyvaultDns}'
  'privatelink.blob.${environment().suffixes.storage}'
  'privatelink.dfs.${environment().suffixes.storage}'
  'privatelink.file.${environment().suffixes.storage}'
  'privatelink.queue.${environment().suffixes.storage}'
  'privatelink.table.${environment().suffixes.storage}'
  'privatelink.web.${environment().suffixes.storage}'
  'privatelink${environment().suffixes.sqlServerHostname}'
  'privatelink.mysql.database.usgovcloudapi.net'
  'privatelink.postgres.database.usgovcloudapi.net'
  'privatelink.adx.monitor.azure.us'
  'privatelink.azuresynapse.usgovcloudapi.net'
  'privatelink.dev.azuresynapse.usgovcloudapi.net'
  'privatelink.batch.usgovcloudapi.net'
  'privatelink.mongo.cosmos.azure.us'
  'privatelink.table.cosmos.azure.us'
  'privatelink.gremlin.cosmos.azure.us'
  'privatelink.documents.azure.us'
  'privatelink.adf.azure.us'
  'privatelink.agentsvc.azure-automation.us'
  'privatelink.api.ml.azure.us'
  'privatelink.azconfig.azure.us'
  'privatelink.azure-automation.us'
  '${replace(replace(toLower(parLocation),' ',''),' ','')}.privatelink.azurecr.us'
  'privatelink.azurecr.us'
  'privatelink.azure-devices.us'
  'privatelink.azure-devices-provisioning.us'
  'privatelink.databricks.azure.us'
  'privatelink.azurehdinsight.us'
  'privatelink.azurewebsites.us'
  'scm.privatelink.azurewebsites.us'
  'privatelink.cassandra.cosmos.azure.us'
  'privatelink.cognitiveservices.azure.us'
  'privatelink.datafactory.azure.us'
  'privatelink.dicom.azurehealthcareapis.us'
  'privatelink.fhir.azurehealthcareapis.us'
  'privatelink.workspace.azurehealthcareapis.us'
  'privatelink.eventgrid.azure.us'
  'privatelink.monitor.azure.us'
  'privatelink.notebooks.usgovcloudapi.net'
  'privatelink.ods.opinsights.azure.us'
  'privatelink.oms.opinsights.azure.us'
  'privatelink.purview.azure.us'
  'privatelink.purviewstudio.azure.us'
  'privatelink.redis.cache.usgovcloudapi.net'
  'privatelink.search.azure.us'
  'privatelink.servicebus.usgovcloudapi.net'
  'privatelink.siterecovery.windowsazure.us'
  'privatelink.vaultcore.usgovcloudapi.net'
  'privatelink-global.wvd.azure.us'
  'privatelink.wvd.azure.us'
  'privatelink.${replace(toLower(parLocation),' ','')}.backup.windowsazure.us'
]
// Private DNS Zones for Deployment based on the environment
var varPrivateDNSZones = environment().name == 'AzureCloud'
  ? varAzureCloudPrivateDNSZones
  : (environment().name == 'AzureUSGovernment' ? varAzureUSGovernmentPrivateDNSZone : [])

// Private DNS Zones for Azure Backup        
// If region entered in parLocation and matches a lookup to varAzBackupGeoCodes then insert Azure Backup Private DNS Zone with appropriate geo code inserted alongside zones in varPrivateDNSZones. If not just return varPrivateDNSZones
var varPrivateDnsZonesMerge = parPrivateDnsZoneAutoMergeAzureBackupZone && contains(varAzBackupGeoCodes, parLocation)
  ? union(
      varPrivateDNSZones,
      ['privatelink.${varAzBackupGeoCodes[replace(toLower(parLocation),' ','')]}.backup.windowsazure.com']
    )
  : varPrivateDNSZones

resource resPrivateDnsZones 'Microsoft.Network/privateDnsZones@2024-06-01' = [
  for privateDnsZone in varPrivateDnsZonesMerge: {
    name: privateDnsZone
    location: 'global'
    tags: parTags
  }
]

resource resPrivateDnsZonesLock 'Microsoft.Authorization/locks@2020-05-01' = [
  for (privateDnsZone, index) in varPrivateDnsZonesMerge: if (parResourceLockConfig.kind != 'None') {
    scope: resPrivateDnsZones[index]
    name: parResourceLockConfig.?name ?? '${privateDnsZone}-lock'
    properties: {
      level: parResourceLockConfig.kind
      notes: parResourceLockConfig.?notes ?? ''
    }
  }
]

resource resVirtualNetworkLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [
  for privateDnsZoneName in varPrivateDnsZonesMerge: if (!empty(parVirtualNetworkIdToLink)) {
    name: '${privateDnsZoneName}/${take('link-${uniqueString(parVirtualNetworkIdToLink)}', 80)}'
    location: 'global'
    properties: {
      registrationEnabled: false
      virtualNetwork: {
        id: parVirtualNetworkIdToLink
      }
    }
    dependsOn: resPrivateDnsZones
    tags: parTags
  }
]

resource resVirtualNetworkLinkLock 'Microsoft.Authorization/locks@2020-05-01' = [
  for (privateDnsZone, index) in varPrivateDnsZonesMerge: if (!empty(parVirtualNetworkIdToLink) && !empty(parResourceLockConfig ?? {}) && parResourceLockConfig.kind != 'None') {
    scope: resVirtualNetworkLink[index]
    name: parResourceLockConfig.?name ?? 'link-${uniqueString(parVirtualNetworkIdToLink)}-${privateDnsZone}-lock'
    properties: {
      level: parResourceLockConfig.kind
      notes: parResourceLockConfig.?notes ?? ''
    }
  }
]

resource resVirtualNetworkLinkFailover 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [
  for privateDnsZoneName in varPrivateDnsZonesMerge: if (!empty(parVirtualNetworkIdToLinkFailover)) {
    name: '${privateDnsZoneName}/${take('fallbacklink-${uniqueString(parVirtualNetworkIdToLinkFailover)}', 80)}'
    location: 'global'
    properties: {
      registrationEnabled: false
      virtualNetwork: {
        id: parVirtualNetworkIdToLinkFailover
      }
    }
    dependsOn: resPrivateDnsZones
    tags: parTags
  }
]

resource resVirtualNetworkLinkFailoverLock 'Microsoft.Authorization/locks@2020-05-01' = [
  for (privateDnsZone, index) in varPrivateDnsZonesMerge: if (!empty(parVirtualNetworkIdToLinkFailover) && !empty(parResourceLockConfig ?? {}) && parResourceLockConfig.kind != 'None') {
    scope: resVirtualNetworkLinkFailover[index]
    name: parResourceLockConfig.?name ?? 'failbacklink-${uniqueString(parVirtualNetworkIdToLink)}-${privateDnsZone}-lock'
    properties: {
      level: parResourceLockConfig.kind
      notes: parResourceLockConfig.?notes ?? ''
    }
  }
]

output outPrivateDnsZones array = [
  for i in range(0, length(varPrivateDnsZonesMerge)): {
    name: resPrivateDnsZones[i].name
    id: resPrivateDnsZones[i].id
  }
]

output outPrivateDnsZonesNames array = [for i in range(0, length(varPrivateDnsZonesMerge)): resPrivateDnsZones[i].name]
