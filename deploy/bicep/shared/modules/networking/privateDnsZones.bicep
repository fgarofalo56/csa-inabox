// =============================================================================
// CSA-in-a-Box: Private DNS Zones Module
// Creates all privatelink DNS zones required by the data platform PaaS
// services and links them to the supplied VNets.
// =============================================================================
targetScope = 'resourceGroup'

// Parameters
@description('Tags for resource organisation')
param parTags object = {}

@description('Array of VNet resource IDs to link each DNS zone to.  At minimum, include the hub VNet.')
param parVnetIds array

@description('Deploy gov-cloud zone names instead of commercial.  Auto-detected from location when false.')
param parIsGovCloud bool = false

// Private DNS zone names — commercial cloud.  Gov overrides below.
var commercialZones = {
  blob: 'privatelink.blob.core.windows.net'
  dfs: 'privatelink.dfs.core.windows.net'
  file: 'privatelink.file.core.windows.net'
  queue: 'privatelink.queue.core.windows.net'
  table: 'privatelink.table.core.windows.net'
  web: 'privatelink.web.core.windows.net'
  keyVault: 'privatelink.vaultcore.azure.net'
  sqlServer: 'privatelink.database.windows.net'
  synapseSql: 'privatelink.sql.azuresynapse.net'
  synapseDev: 'privatelink.dev.azuresynapse.net'
  databricks: 'privatelink.azuredatabricks.net'
  dataFactory: 'privatelink.datafactory.azure.net'
  cosmosDocument: 'privatelink.documents.azure.com'
  cosmosMongo: 'privatelink.mongo.cosmos.azure.com'
  cosmosTable: 'privatelink.table.cosmos.azure.com'
  cosmosCassandra: 'privatelink.cassandra.cosmos.azure.com'
  cosmosGremlin: 'privatelink.gremlin.cosmos.azure.com'
  servicebus: 'privatelink.servicebus.windows.net'
  containerRegistry: 'privatelink.azurecr.io'
  purview: 'privatelink.purview.azure.com'
  purviewStudio: 'privatelink.purviewstudio.azure.com'
  cognitiveServices: 'privatelink.cognitiveservices.azure.com'
  eventHub: 'privatelink.servicebus.windows.net'  // Event Hub uses servicebus zone
  machineLearning: 'privatelink.api.azureml.ms'
  machineLearningNotebook: 'privatelink.notebooks.azure.net'
}

var govCloudZones = {
  blob: 'privatelink.blob.core.usgovcloudapi.net'
  dfs: 'privatelink.dfs.core.usgovcloudapi.net'
  file: 'privatelink.file.core.usgovcloudapi.net'
  queue: 'privatelink.queue.core.usgovcloudapi.net'
  table: 'privatelink.table.core.usgovcloudapi.net'
  web: 'privatelink.web.core.usgovcloudapi.net'
  keyVault: 'privatelink.vaultcore.usgovcloudapi.net'
  sqlServer: 'privatelink.database.usgovcloudapi.net'
  synapseSql: 'privatelink.sql.azuresynapse.usgovcloudapi.net'
  synapseDev: 'privatelink.dev.azuresynapse.usgovcloudapi.net'
  databricks: 'privatelink.azuredatabricks.net'
  dataFactory: 'privatelink.datafactory.azure.us'
  cosmosDocument: 'privatelink.documents.azure.us'
  cosmosMongo: 'privatelink.mongo.cosmos.azure.us'
  cosmosTable: 'privatelink.table.cosmos.azure.us'
  cosmosCassandra: 'privatelink.cassandra.cosmos.azure.us'
  cosmosGremlin: 'privatelink.gremlin.cosmos.azure.us'
  servicebus: 'privatelink.servicebus.usgovcloudapi.net'
  containerRegistry: 'privatelink.azurecr.us'
  purview: 'privatelink.purview.azure.us'
  purviewStudio: 'privatelink.purviewstudio.azure.us'
  cognitiveServices: 'privatelink.cognitiveservices.azure.us'
  eventHub: 'privatelink.servicebus.usgovcloudapi.net'
  machineLearning: 'privatelink.api.ml.azure.us'
  machineLearningNotebook: 'privatelink.notebooks.usgovcloudapi.net'
}

var effectiveZones = parIsGovCloud ? govCloudZones : commercialZones

// Flatten to an array for iteration
var zoneEntries = [
  { key: 'blob', zone: effectiveZones.blob }
  { key: 'dfs', zone: effectiveZones.dfs }
  { key: 'file', zone: effectiveZones.file }
  { key: 'queue', zone: effectiveZones.queue }
  { key: 'table', zone: effectiveZones.table }
  { key: 'web', zone: effectiveZones.web }
  { key: 'keyVault', zone: effectiveZones.keyVault }
  { key: 'sqlServer', zone: effectiveZones.sqlServer }
  { key: 'synapseSql', zone: effectiveZones.synapseSql }
  { key: 'synapseDev', zone: effectiveZones.synapseDev }
  { key: 'databricks', zone: effectiveZones.databricks }
  { key: 'dataFactory', zone: effectiveZones.dataFactory }
  { key: 'cosmosDocument', zone: effectiveZones.cosmosDocument }
  { key: 'cosmosMongo', zone: effectiveZones.cosmosMongo }
  { key: 'cosmosTable', zone: effectiveZones.cosmosTable }
  { key: 'cosmosCassandra', zone: effectiveZones.cosmosCassandra }
  { key: 'cosmosGremlin', zone: effectiveZones.cosmosGremlin }
  { key: 'servicebus', zone: effectiveZones.servicebus }
  { key: 'containerRegistry', zone: effectiveZones.containerRegistry }
  { key: 'purview', zone: effectiveZones.purview }
  { key: 'purviewStudio', zone: effectiveZones.purviewStudio }
  { key: 'cognitiveServices', zone: effectiveZones.cognitiveServices }
  { key: 'machineLearning', zone: effectiveZones.machineLearning }
  { key: 'machineLearningNotebook', zone: effectiveZones.machineLearningNotebook }
]

// Create DNS zones — these are global resources (location = 'global')
resource privateDnsZones 'Microsoft.Network/privateDnsZones@2024-06-01' = [
  for entry in zoneEntries: {
    name: entry.zone
    location: 'global'
    tags: parTags
  }
]

// Link each zone to every supplied VNet.
// Bicep does not allow lambda variables inside resource array access (BCP247),
// so we use a nested module per zone to create the VNet links.
module dnsZoneVnetLinks 'privateDnsZoneLinks.bicep' = [
  for (entry, i) in zoneEntries: {
    name: 'link-${entry.key}'
    params: {
      parDnsZoneName: privateDnsZones[i].name
      parVnetIds: parVnetIds
      parLinkPrefix: entry.key
      parTags: parTags
    }
  }
]

// Outputs — one ID per zone, keyed by service name
output blobDnsZoneId string = privateDnsZones[0].id
output dfsDnsZoneId string = privateDnsZones[1].id
output fileDnsZoneId string = privateDnsZones[2].id
output queueDnsZoneId string = privateDnsZones[3].id
output tableDnsZoneId string = privateDnsZones[4].id
output webDnsZoneId string = privateDnsZones[5].id
output keyVaultDnsZoneId string = privateDnsZones[6].id
output sqlServerDnsZoneId string = privateDnsZones[7].id
output synapseSqlDnsZoneId string = privateDnsZones[8].id
output synapseDevDnsZoneId string = privateDnsZones[9].id
output databricksDnsZoneId string = privateDnsZones[10].id
output dataFactoryDnsZoneId string = privateDnsZones[11].id
output cosmosDocumentDnsZoneId string = privateDnsZones[12].id
output cosmosMongoDnsZoneId string = privateDnsZones[13].id
output cosmosTableDnsZoneId string = privateDnsZones[14].id
output cosmosCassandraDnsZoneId string = privateDnsZones[15].id
output cosmosGremlinDnsZoneId string = privateDnsZones[16].id
output servicebusDnsZoneId string = privateDnsZones[17].id
output containerRegistryDnsZoneId string = privateDnsZones[18].id
output purviewDnsZoneId string = privateDnsZones[19].id
output purviewStudioDnsZoneId string = privateDnsZones[20].id
output cognitiveServicesDnsZoneId string = privateDnsZones[21].id
output machineLearningDnsZoneId string = privateDnsZones[22].id
output machineLearningNotebookDnsZoneId string = privateDnsZones[23].id
