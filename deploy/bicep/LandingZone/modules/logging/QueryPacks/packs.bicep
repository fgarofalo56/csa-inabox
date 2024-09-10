param location string
param tags object
param parLoggingRG string


// Ref Link for Queries: https://github.com/microsoft/AzureMonitorCommunity
/**************************************************************************************
Query Pack Query Types can be set to any of or multiples of:

microsoft.aad/domainservices, 
microsoft.agfoodplatform/farmbeats, 
microsoft.informationprotection/datasecuritymanagement, 
microsoft.apimanagement/service, microsoft.appconfiguration/configurationstores, 
microsoft.network/applicationgateways, 
microsoft.servicenetworking/trafficcontrollers, 
microsoft.web/sites, 
microsoft.authorization/tenants, 
microsoft.autonomousdevelopmentplatform/workspaces, 
microsoft.resources/azureactivity, 
microsoft.kubernetes/connectedclusters, 
microsoft.attestation/attestationproviders, 
microsoft.cache/redis, 
microsoft.cdn/profiles, 
microsoft.hardwaresecuritymodules/cloudhsmclusters, 
microsoft.communication/communicationservices, 
microsoft.containerinstance/containergroups, 
microsoft.documentdb/databaseaccounts, 
microsoft.datacollaboration/workspaces, 
microsoft.azuredatatransfer/connections, 
microsoft.security/defenderforstoragesettings, 
microsoft.digitaltwins/digitaltwinsinstances, 
microsoft.network/dnsresolverpolicies, 
microsoft.eventgrid/namespaces, 
microsoft.eventgrid/topics, 
microsoft.eventhub/namespaces, 
microsoft.network/azurefirewalls, 
microsoft.dashboard/grafana,
microsoft.healthcareapis/workspaces,
microsoft.keyvault/vaults,
microsoft.containerservice/managedclusters,
microsoft.loadtestservice/loadtests,
microsoft.managednetworkfabric/networkdevices,
microsoft.documentdb/cassandraclusters,
microsoft.datareplication/replicationvaults,
microsoft.documentdb/mongoclusters,
microsoft.azuredatacollection/amawindows,
microsoft.insights/workloadmonitoring,
microsoft.netapp/netappaccounts/capacitypools,
microsoft.network/loadbalancers,
microsoft.networkcloud/baremetalmachines,
microsoft.networkcloud/clustermanagers,
microsoft.networkcloud/clusters,
microsoft.networkcloud/storageappliances,
microsoft.playfab/titles,
microsoft.securityinsights/purview,
microsoft.purview/accounts,
microsoft.recoveryservices/vaults,
microsoft.cache/redisenterprise,
microsoft.relay/namespaces,
microsoft.servicebus/namespaces,
microsoft.azuresphere/catalogs,
microsoft.networkfunction/azuretrafficcollectors,
microsoft.network/networkmanagers,
microsoft.avs/privateclouds,
microsoft.botservice/botservices,
microsoft.chaos/experiments,
microsoft.cognitiveservices/accounts,
microsoft.connectedcache/cachenodes,
microsoft.connectedvehicle/platformaccounts,
microsoft.network/networkwatchers/connectionmonitors,
microsoft.app/managedenvironments,
microsoft.d365customerinsights/instances,
microsoft.databricks/workspaces,
microsoft.insights/datacollectionrules,
microsoft.dbformysql/flexibleservers,
microsoft.dbforpostgresql/flexibleservers,
microsoft.dbforpostgresql/servergroupsv2,
microsoft.devcenter/devcenters,
microsoft.dynamics/fraudprotection/purchase,
microsoft.experimentation/experimentworkspaces,
microsoft.hdinsight/clusters,
microsoft.healthdataaiservices/deidservices,
microsoft.intune/operations,
microsoft.aadiam/tenants,
microsoft.compute/virtualmachines,
microsoft.operationalinsights/workspaces,
microsoft.logic/integrationaccounts,
microsoft.machinelearningservices/workspaces,
microsoft.machinelearningservices/registries,
microsoft.confidentialledger/managedccfs,
microsoft.security/security,
microsoft.monitor/accounts,
microsoft.media/mediaservices,
microsoft.azureplaywrightservice/accounts,
microsoft.graph/tenants,
microsoft.networkanalytics/dataproducts,
microsoft.network/networksecurityperimeters,
nginx.nginxplus/nginxdeployments,
microsoft.openenergyplatform/energyservices,
microsoft.openlogisticsplatform/workspaces,
microsoft.powerbi/tenants,
microsoft.powerbi/tenants/workspaces,
microsoft.securityinsights/cef,
microsoft.securityinsights/datacollection,
microsoft.securityinsights/anomalies,
microsoft.securityinsights/amazon,
microsoft.securityinsights/gcp,
microsoft.securityinsights/securityinsights/mcas,
microsoft.securityinsights/mda,
microsoft.securityinsights/mde,
microsoft.securityinsights/mdi,
microsoft.securityinsights/mdo,
microsoft.securityinsights/microsoftpurview,
microsoft.securityinsights/office365,
microsoft.securityinsights/powerplatform,
microsoft.securityinsights/sap,
microsoft.securityinsights/securityinsights,
microsoft.securityinsights/threatintelligence,
microsoft.securityinsights/tvm,
microsoft.securityinsights/watchlists,
microsoft.securityinsights/asimtables,
microsoft.securityinsights/auditeventnormalized,
microsoft.securityinsights/authenticationevent,
microsoft.securityinsights/dnsnormalized,
microsoft.securityinsights/networksessionnormalized,
microsoft.securityinsights/processeventnormalized,
microsoft.securityinsights/websessionlogs,
microsoft.storage/storageaccounts,
microsoft.storageinsights/storagecollectionrules,
microsoft.storagecache/amlfilesytems,
microsoft.storagecache/caches,
microsoft.storagemover/storagemovers,
microsoft.synapse/workspaces,
microsoft.network/networkwatchers/trafficanalytics,
microsoft.updatecompliance/updatecompliance,
microsoft.videoindexer/accounts,
microsoft.desktopvirtualization/hostpools,
default,
subscription,
resourcegroup,
microsoft.signalrservice/webpubsub,
microsoft.insights/components,
microsoft.desktopvirtualization/applicationgroups,
microsoft.desktopvirtualization/workspaces,
microsoft.timeseriesinsights/environments,
microsoft.workloadmonitor/monitors,
microsoft.analysisservices/servers,
microsoft.batch/batchaccounts,
microsoft.appplatform/spring,
microsoft.signalrservice/signalr,
microsoft.containerregistry/registries,
microsoft.kusto/clusters,
microsoft.blockchain/blockchainmembers,
microsoft.eventgrid/domains,
microsoft.eventgrid/partnernamespaces,
microsoft.eventgrid/partnertopics,
microsoft.eventgrid/systemtopics,
microsoft.conenctedvmwarevsphere/virtualmachines,
microsoft.azurestackhci/virtualmachines,
microsoft.scvmm/virtualmachines,
microsoft.compute/virtualmachinescalesets,
microsoft.azurestackhci/clusters,
microsoft.hybridcontainerservice/provisionedclusters,
microsoft.insights/autoscalesettings,
microsoft.devices/iothubs,
microsoft.servicefabric/clusters,
microsoft.logic/workflows,
microsoft.automation/automationaccounts,
microsoft.datafactory/factories,
microsoft.datalakestore/accounts,
microsoft.datalakeanalytics/accounts,
microsoft.powerbidedicated/capacities,
microsoft.datashare/accounts,
microsoft.sql/managedinstances,
microsoft.sql/servers,
microsoft.sql/servers/databases,
microsoft.dbformysql/servers,
microsoft.dbforpostgresql/servers,
microsoft.dbforpostgresql/serversv2,
microsoft.dbformariadb/servers,
microsoft.devices/provisioningservices,
microsoft.network/expressroutecircuits,
microsoft.network/frontdoors,
microsoft.network/networkinterfaces,
microsoft.network/networksecuritygroups,
microsoft.network/publicipaddresses,
microsoft.network/trafficmanagerprofiles,
microsoft.network/virtualnetworkgateways,
microsoft.network/vpngateways,
microsoft.network/virtualnetworks,
microsoft.search/searchservices,
microsoft.streamanalytics/streamingjobs,
microsoft.network/bastionhosts,
microsoft.healthcareapis/services"
*********************************************************************************************************************************************************************/
/*******************************************************************************************************************************************************************

'supported solutions are: 
ADAssessment, ADAssessmentPlus,
ADReplication,
ADSecurityAssessment,
AlertManagement,
AntiMalware,
ApplicationInsights,
AzureAssessment,
AzureResources,
AzureSecurityOfThings,
AzureSentinelDSRE,
AzureSentinelPrivatePreview,
BehaviorAnalyticsInsights,
ChangeTracking,
CompatibilityAssessment,
ContainerInsights,
Containers,
CustomizedWindowsEventsFiltering,
DeviceHealthProd,
DnsAnalytics,
ExchangeAssessment,
ExchangeOnlineAssessment,
IISAssessmentPlus,
InfrastructureInsights,
InternalWindowsEvent,
LogManagement,
Microsoft365Analytics,
NetworkMonitoring,
SCCMAssessmentPlus,
SCOMAssessment,
SCOMAssessmentPlus,
SPAssessment,
SQLAdvancedThreatProtection,
SQLAssessment,
SQLAssessmentPlus,
SQLDataClassification,
SQLThreatDetection,
SQLVulnerabilityAssessment,
Security,
SecurityCenter,
SecurityCenterFree,
SecurityInsights,
ServiceMap,
SfBAssessment,
SfBOnlineAssessment,
SharePointOnlineAssessment,
SurfaceHub,
Updates,
VMInsights,
WEFInternalUat,
WEF_10x,
WEF_10xDSRE,
WaaSUpdateInsights,
WinLog,
WindowsClientAssessmentPlus,
WindowsEventForwarding,
WindowsFirewall,
WindowsServerAssessment,
WireData,
WireData2

*********************************************************************************************************************************************************************/

/*
supported categories are: 
security, 
network, 
management, 
virtualmachines, 
container, 
audit, 
desktopanalytics, 
workloads, 
resources, 
applications, 
monitor, 
databases,
windowsvirtualdesktop
*/
var varQueryPackQueries = [
    {
    queryPackName: 'ALZ Custom Pack - SQLAssessment Diagnostics Pack'  
    displayName: 'ALZ Custom Pack - How many times did each unique SQL Recommendation trigger'
    description: 'ALZ Custom Pack - Count SQL recommendations with failed result by recommendation'
    Categories: ['workloads', 'databases', 'monitor']
    Solutions: ['SQLAssessment']
    Topic: ['microsoft.dbformysql/flexibleservers', 'microsoft.dbforpostgresql/flexibleservers', 'microsoft.dbforpostgresql/servergroupsv2', 'microsoft.sql/servers', 'microsoft.sql/servers/databases', 'microsoft.dbformysql/servers', 'microsoft.dbforpostgresql/servers', 'microsoft.dbforpostgresql/serversv2', 'microsoft.dbformariadb/servers']
    bodyKQL: loadTextContent('SQLAssessment/How_many_times_did_each_unique_SQL_Recommendation_trigger.kql')
    }
    {
      queryPackName: 'ALZ Custom Pack - SQLAssessment Diagnostics Pack'
      displayName: 'ALZ Custom Pack - SQL Recommendations by AffectedObjectType'
      description: 'ALZ Custom Pack - Count SQL recommendations with failed result by affected object type.'
      Categories: ['workloads', 'databases', 'monitor']
      Solutions:  ['SQLAssessment']
      Topic: ['microsoft.dbformysql/flexibleservers', 'microsoft.dbforpostgresql/flexibleservers', 'microsoft.dbforpostgresql/servergroupsv2', 'microsoft.sql/servers', 'microsoft.sql/servers/databases', 'microsoft.dbformysql/servers', 'microsoft.dbforpostgresql/servers', 'microsoft.dbforpostgresql/serversv2', 'microsoft.dbformariadb/servers']
      bodyKQL: loadTextContent('SQLAssessment/SQL_Recommendations_by_AffectedObjectType.kql')
    }
    {
      queryPackName: 'ALZ Custom Pack - SQLAssessment Diagnostics Pack'
      displayName: 'ALZ Custom Pack - SQL Recommendations by Computer'
      description: 'ALZ Custom Pack - Count SQL recommendations with failed result by computer'
      Categories: ['workloads', 'databases', 'monitor']
      Solutions:  ['SQLAssessment']
      Topic: ['microsoft.dbformysql/flexibleservers', 'microsoft.dbforpostgresql/flexibleservers', 'microsoft.dbforpostgresql/servergroupsv2', 'microsoft.sql/servers', 'microsoft.sql/servers/databases', 'microsoft.dbformysql/servers', 'microsoft.dbforpostgresql/servers', 'microsoft.dbforpostgresql/serversv2', 'microsoft.dbformariadb/servers']
      bodyKQL: loadTextContent('SQLAssessment/SQL_Recommendations_by_Computer.kql')
    }
    {
      queryPackName: 'ALZ Custom Pack - SQLAssessment Diagnostics Pack'
      displayName: 'ALZ Custom Pack - SQL Recommendations by Database'
      description: 'Count SQL recommendations with failed result by database.'
      Categories: ['workloads', 'databases', 'monitor']
      Solutions:  ['SQLAssessment']
      Topic: ['microsoft.dbformysql/flexibleservers', 'microsoft.dbforpostgresql/flexibleservers', 'microsoft.dbforpostgresql/servergroupsv2', 'microsoft.sql/servers', 'microsoft.sql/servers/databases', 'microsoft.dbformysql/servers', 'microsoft.dbforpostgresql/servers', 'microsoft.dbforpostgresql/serversv2', 'microsoft.dbformariadb/servers']
      bodyKQL: loadTextContent('SQLAssessment/SQL_Recommendations_by_Database.kql')
    }
    {
      queryPackName: 'ALZ Custom Pack - SQLAssessment Diagnostics Pack'
      displayName: 'ALZ Custom Pack - SQL Recommendations by Instance'
      description: 'ALZ Custom Pack - Count SQL recommendations with failed result by instance.'
      Categories: ['workloads', 'databases', 'monitor']
      Solutions:  ['SQLAssessment']
      Topic: ['microsoft.dbformysql/flexibleservers', 'microsoft.dbforpostgresql/flexibleservers', 'microsoft.dbforpostgresql/servergroupsv2', 'microsoft.sql/servers', 'microsoft.sql/servers/databases', 'microsoft.dbformysql/servers', 'microsoft.dbforpostgresql/servers', 'microsoft.dbforpostgresql/serversv2', 'microsoft.dbformariadb/servers']
      bodyKQL: loadTextContent('SQLAssessment/SQL_Recommendations_by_Instance.kql')
    }
    {
      queryPackName: 'ALZ Custom Pack - SQL Diagnostics Pack'
      displayName: 'ALZ Custom Pack - SQL Loading Data'
      description: 'ALZ Custom Pack - Monitor data loading in the last hour.'
      Categories: ['workloads', 'databases', 'monitor']
      Solutions:  ['SQLAssessment', 'SQLDataClassification']
      Topic: ['microsoft.dbformysql/flexibleservers', 'microsoft.dbforpostgresql/flexibleservers', 'microsoft.dbforpostgresql/servergroupsv2', 'microsoft.sql/servers', 'microsoft.sql/servers/databases', 'microsoft.dbformysql/servers', 'microsoft.dbforpostgresql/servers', 'microsoft.dbforpostgresql/serversv2', 'microsoft.dbformariadb/servers']
      bodyKQL: loadTextContent('SQL databases/Queries/Diagnostics/Loading Data.kql')
    }
    {
      queryPackName: 'ALZ Custom Pack - SQL Diagnostics Pack'
      displayName: 'ALZ Custom Pack - SQL Wait stats'
      description: 'ALZ Custom Pack - Wait stats over the last hour, by Logical Server and Database.'
      Categories: ['workloads', 'databases', 'monitor']
      Solutions:  ['SQLAssessment', 'SQLDataClassification']
      Topic: ['microsoft.dbformysql/flexibleservers', 'microsoft.dbforpostgresql/flexibleservers', 'microsoft.dbforpostgresql/servergroupsv2', 'microsoft.sql/servers', 'microsoft.sql/servers/databases', 'microsoft.dbformysql/servers', 'microsoft.dbforpostgresql/servers', 'microsoft.dbforpostgresql/serversv2', 'microsoft.dbformariadb/servers']
      bodyKQL: loadTextContent('SQL databases/Queries/Diagnostics/Wait stats.kql')
    }    
    {
      queryPackName: 'ALZ Custom Pack - SQL Performance Pack'
      displayName: 'ALZ Custom Pack - SQL Performance troubleshooting'
      description: 'ALZ Custom Pack - Potentially query or deadlock on the system that could lead to poor performance.'
      Categories: ['workloads', 'databases', 'monitor']
      Solutions:  ['SQLAssessment', 'SQLDataClassification']
      Topic: ['microsoft.dbformysql/flexibleservers', 'microsoft.dbforpostgresql/flexibleservers', 'microsoft.dbforpostgresql/servergroupsv2', 'microsoft.sql/servers', 'microsoft.sql/servers/databases', 'microsoft.dbformysql/servers', 'microsoft.dbforpostgresql/servers', 'microsoft.dbforpostgresql/serversv2', 'microsoft.dbformariadb/servers']
      bodyKQL: loadTextContent('SQL databases/Queries/Performance/Performance troubleshooting.kql')
    }
    {
      queryPackName: 'ALZ Custom Pack - SQL Performance Pack'
      displayName: 'ALZ Custom Pack - SQL Avg CPU usage'
      description: 'ALZ Custom Pack - Avg CPU usage in the last hour by resource name.'
      Categories: ['workloads', 'databases', 'monitor']
      Solutions: ['SQLAssessment', 'SQLDataClassification']
      Topic: ['microsoft.dbformysql/flexibleservers', 'microsoft.dbforpostgresql/flexibleservers', 'microsoft.dbforpostgresql/servergroupsv2', 'microsoft.sql/servers', 'microsoft.sql/servers/databases', 'microsoft.dbformysql/servers', 'microsoft.dbforpostgresql/servers', 'microsoft.dbforpostgresql/serversv2', 'microsoft.dbformariadb/servers']
      bodyKQL: loadTextContent('SQL databases/Queries/Performance/Avg CPU usage.kql')
    }
]

var varQueryPacks = map(varQueryPackQueries, i => i.queryPackName)
var distinctQueryPacks = union(varQueryPacks, varQueryPacks)


resource resQueryPack 'Microsoft.OperationalInsights/queryPacks@2019-09-01' = [for queryPackName in distinctQueryPacks: {
  name: queryPackName
  location: location
  tags: tags
  properties: {}
  }
  ]

  // output reQueryPacks object = resQueryPack[0]

  module queryPackQueries 'queries.bicep' = [for (queryPackName, i) in distinctQueryPacks: {
    name: 'queryPackQueries-${i}'
    scope: resourceGroup(parLoggingRG)
    params: {
      parParent: resQueryPack[i].name
      parQueryPackQueries: varQueryPackQueries
      tags: tags
    
    }
  }
]


