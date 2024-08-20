targetScope = 'subscription'

// Set Param values

param diagnosticSettingName string = 'alz-diag-setting'
param resourceLocationList array = [
  'eastus'
  'eastus2'
  'westus'
  'westus2'
  'centralus'
  'northcentralus'
  'southcentralus'
  'westcentralus'
]
param logAnalytics string = 'alz-log-analytics'
param logAnalyticsRG string = 'rg-alz-logging-001'
// param categoryGroup string = 'allLogs'
param effect string = 'DeployIfNotExists'
param profileName string = 'alz-policy-profile'
param metricsEnabled string = 'True'
param logsEnabled string = 'True'
// param listOfImageIdToInclude array = []
// Get and Set Varables 
param managedIdentityName string = 'alz-umi-identity'
var userAssignedMI = resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', managedIdentityName)

var workspaceId = resourceId('Microsoft.OperationalInsights/workspaces', logAnalytics)

// Get Existing Resources if needed

// resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2020-08-01' existing = {
//   name: logAnalytics
//   scope: resourceGroup()
// }


// resource getWorkspace 'Microsoft.Resources/deploymentScripts@2020-10-01' = {
//   name: 'getWorkspaceScript'
//   location: 'eastus'
//   kind: 'AzureCLI'
//   properties: {
//     azCliVersion: '2.0.80'
//     scriptContent: 'az monitor log-analytics workspace show  --resource-group ${logAnalyticsRG} --workspace-name ${logAnalytics}'
//     timeout: 'PT30M'
//     cleanupPreference: 'OnSuccess'
//     retentionInterval: 'P1D'
//   }
// }
// output workspaceId string = getWorkspace.properties.outputs.id


// resource getWorkspaceKey 'Microsoft.Resources/deploymentScripts@2020-10-01' = {
//   name: 'getWorkspaceKeyScript'
//   location: 'eastus'
//   kind: 'AzureCLI'
//   properties: {
//     azCliVersion: '2.0.80'
//     scriptContent: 'az monitor log-analytics workspace get-shared-keys --resource-group ${logAnalyticsRG} --workspace-name ${logAnalytics}'
//     timeout: 'PT30M'
//     cleanupPreference: 'OnSuccess'
//     retentionInterval: 'P1D'
//   }
// }

// output workspaceKey string = getWorkspaceKey.properties.outputs.primarySharedKey


resource initiative 'Microsoft.Authorization/policySetDefinitions@2023-04-01' = {
  name: 'FRGAROFALO_Assign_DataObserviablity'
  properties: {
    displayName: 'FRGAROFALO Assign Data Observiablity'
    description: 'Enable policies and policy sets for Data Observability, Logging, Diagnostic Settings Azure resources'
    policyType: 'Custom'
    version: '1.0.0'    
    metadata: {
      assignedBy: 'AzurePolicies'
      category: 'DataObserviablity'
      description: 'Enable policies and policy sets for Data Observability, Logging, Diagnostic Settings Azure resources'
      owner: 'frgarofa'
    }
    //Enable built in policy sets for Data Observability useing the following built in policies
    policyDefinitions: [
      {
        //Deploy Diagnostic Settings for Service Bus to Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/04d53d87-841c-4f23-8a5b-21564380b55e'
     parameters: { 
      effect: { 
       value: effect
          }
profileName: { 
       value: profileName
          }
logAnalytics: { 
       value: logAnalytics
          }
metricsEnabled: { 
       value: metricsEnabled
          }
logsEnabled: { 
       value: logsEnabled
          }
        }
      }
{
        //Deploy Log Analytics extension for Linux VMs. See deprecation notice below
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/053d3325-282c-4e5c-b944-24faffd30d77'
     parameters: { 
      logAnalytics: { 
       value: logAnalytics
          }
          /*
listOfImageIdToInclude: { 
       value: <enterVal>
               }
*/
        }
      }
{
        //Deploy - Configure Log Analytics extension to be enabled on Windows virtual machines
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/0868462e-646c-4fe3-9ced-a733534b6a2c'
parameters: {
logAnalytics: {
value: logAnalytics
          }
          /*
listOfImageIdToInclude: { 
       value: <enterVal>
               }
*/
effect: {
value: effect
          }
        }
      }
{
        //Deploy Diagnostic Settings for Search Services to Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/08ba64b8-738f-4918-9686-730d2ed79c7d'
parameters: {
effect: {
value: effect
          }
profileName: {
value: profileName
          }
logAnalytics: {
value: logAnalytics
          }
metricsEnabled: {
value: metricsEnabled
          }
logsEnabled: {
value: logsEnabled
          }
        }
      }
{
        //Log Analytics agent should be installed on your Cloud Services (extended support) role instances
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/15fdbc87-8a47-4ee9-a2aa-9a2ea1f37554'
parameters: {
effect: {
value: 'AuditIfNotExists'
          }
        }
      }
{
        //Configure diagnostic settings for Azure Databricks Workspaces to Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/23057b42-ca8d-4aa0-a3dc-96a98b5b5a3d'
parameters: {
effect: {
value: effect
          }
profileName: {
value: profileName
          }
logAnalytics: {
value: logAnalytics
          }
logsEnabled: {
value: true
          }
        }
      }
{
        //Deploy Diagnostic Settings for Stream Analytics to Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/237e0f7e-b0e8-4ec4-ad46-8c12cb66d673'
parameters: {
effect: {
value: effect
          }
profileName: {
value: profileName
          }
logAnalytics: {
value: logAnalytics
          }
metricsEnabled: {
value: metricsEnabled
          }
logsEnabled: {
value: logsEnabled
          }
        }
      }
{
        //Enable logging by category group for Application Insights (Microsoft.Insights/components) to Log Analytics (Virtual Enclaves)
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/244bcb20-b194-41f3-afcc-63aef382b64c'
parameters: {
effect: {
value: effect
          }
diagnosticSettingName: {
value: diagnosticSettingName
          }
resourceLocationList: {
value: resourceLocationList
          }
logAnalytics: {
value: logAnalytics
          }
        }
      }
{
        //Configure Azure Activity logs to stream to specified Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/2465583e-4e78-4c15-b6be-a36cbc7c8b0f'
parameters: {
logAnalytics: {
value: logAnalytics
          }
effect: {
value: effect
          }
logsEnabled: {
value: logsEnabled
          }
        }
      }
{
        //Deploy Diagnostic Settings for Data Lake Storage Gen1 to Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/25763a0a-5783-4f14-969e-79d4933eb74b'
parameters: {
effect: {
value: effect
          }
profileName: {
value: profileName
          }
logAnalytics: {
value: logAnalytics
          }
metricsEnabled: {
value: metricsEnabled
          }
logsEnabled: {
value: logsEnabled
          }
        }
      }
{
        //Configure diagnostic settings for File Services to Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/25a70cc8-2bd4-47f1-90b6-1478e4662c96'
parameters: {
effect: {
value: effect
          }
profileName: {
value: profileName
          }
logAnalytics: {
value: logAnalytics
          }
metricsEnabled: {
value: true
          }
logsEnabled: {
value: true
          }
        }
      }
{
        //Configure SQL servers to have auditing enabled to Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/25da7dfb-0666-4a15-a8f5-402127efd8bb'
parameters: {
effect: {
value: effect
          }
logAnalyticsWorkspaceId: {
value: workspaceId
          }
        }
      }
{
        //Configure diagnostic settings for Table Services to Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/2fb86bf3-d221-43d1-96d1-2434af34eaa0'
parameters: {
effect: {
value: effect
          }
profileName: {
value: profileName
          }
logAnalytics: {
value: logAnalytics
          }
metricsEnabled: {
value: true
          }
logsEnabled: {
value: true
          }
        }
      }

{
        //Configure Synapse workspaces to have auditing enabled to Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/32ba8d30-07c0-4136-ab18-9a11bf4a67b7'
parameters: {
effect: {
value: effect
          }
logAnalyticsWorkspaceId: {
value: workspaceId
          }
        }
      }
{
        //Enable logging by category group for Application group (microsoft.desktopvirtualization/applicationgroups) to Log Analytics
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/3aa571d2-2e4f-4e92-8a30-4312860efbe1'
parameters: {
effect: {
value: effect
          }
diagnosticSettingName: {
value: diagnosticSettingName
          }
resourceLocationList: {
value: resourceLocationList
          }
logAnalytics: {
value: logAnalytics
          }
        }
      }
{
        //Deploy - Configure Log Analytics extension to be enabled on Windows virtual machine scale sets
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/3c1b3629-c8f8-4bf6-862c-037cb9094038'
parameters: {
logAnalytics: {
value: logAnalytics
          }
          /*
listOfImageIdToInclude: { 
       value: <enterVal>
               }
*/
effect: {
value: effect
          }
        }
      }
{
        //Configure diagnostic settings for container groups to Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/41ebf9df-66cb-48e9-a8d0-98afb4e150ce'
parameters: {
effect: {
value: effect
          }
profileName: {
value: profileName
          }
logAnalytics: {
value: logAnalytics
          }
logsEnabled: {
value: true
          }
        }
      }
{
        //Enable logging by category group for Azure Cosmos DB (microsoft.documentdb/databaseaccounts) to Log Analytics
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/45c6bfc7-4520-4d64-a158-730cd92eedbc'
parameters: {
effect: {
value: effect
          }
diagnosticSettingName: {
value: diagnosticSettingName
          }
          /*
categoryGroup: { 
       value: <enterVal>
               }
*/
resourceLocationList: {
value: resourceLocationList
          }
logAnalytics: {
value: logAnalytics
          }
        }
      }
{
        //Auto provisioning of the Log Analytics agent should be enabled on your subscription
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/475aae12-b88a-4572-8b36-9b712b2b3a17'
parameters: {
effect: {
value: 'AuditIfNotExists'
          }
        }
      }
{
        //[Preview]: Configure Azure Arc-enabled Windows machines with Log Analytics agents connected to default Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/594c1276-f44f-482d-9910-71fac2ce5ae0'
parameters: {
effect: {
value: effect
          }
        }
      }
{
        //Configure diagnostic settings for Storage Accounts to Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/59759c62-9a22-4cdf-ae64-074495983fef'
parameters: {
effect: {
value: effect
          }
profileName: {
value: profileName
          }
logAnalytics: {
value: logAnalytics
          }
metricsEnabled: {
value: true
          }
        }
      }

{
        //Deploy Log Analytics extension for Linux virtual machine scale sets. See deprecation notice below
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/5ee9e9ed-0b42-41b7-8c9c-3cfb2fbe2069'
parameters: {
logAnalytics: {
value: logAnalytics
          }
          /*
listOfImageIdToInclude: { 
       value: <enterVal>
               }
*/
        }
      }
{
        //Audit Windows machines on which the Log Analytics agent is not connected as expected
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/6265018c-d7e2-432f-a75d-094d5f6f4465'
parameters: {
IncludeArcMachines: {
value: 'true'
          }
WorkspaceId: {
value: workspaceId
          }
        }
      }
{
        //Configure Log Analytics extension on Azure Arc enabled Windows servers
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/69af7d4a-7b18-4044-93a9-2651498ef203'
parameters: {
logAnalytics: {
value: logAnalytics
          }
effect: {
value: effect
          }
        }
      }
{
        //Enable logging by category group for Workspace (microsoft.desktopvirtualization/workspaces) to Log Analytics
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/6bb23bce-54ea-4d3d-b07d-628ce0f2e4e3'
parameters: {
effect: {
value: effect
          }
diagnosticSettingName: {
value: diagnosticSettingName
          }
resourceLocationList: {
value: resourceLocationList
          }
logAnalytics: {
value: logAnalytics
          }
        }
      }
{
        //Log Analytics workspaces should block log ingestion and querying from public networks
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/6c53d030-cc64-46f0-906d-2bc061cd1334'
parameters: {
effect: {
value: 'audit'
          }
        }
      }
{
        //Enable Security Center's auto provisioning of the Log Analytics agent on your subscriptions with default workspace.
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/6df2fee6-a9ed-4fef-bced-e13be1b25f1c'
parameters: {
effect: {
value: effect
          }
        }
      }
{
        //Enable logging by category group for Host pool (microsoft.desktopvirtualization/hostpools) to Log Analytics
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/6f95136f-6544-4722-a354-25a18ddb18a7'
parameters: {
effect: {
value: effect
          }
diagnosticSettingName: {
value: diagnosticSettingName
          }
resourceLocationList: {
value: resourceLocationList
          }
logAnalytics: {
value: logAnalytics
          }
        }
      }
{
        //Public IP addresses should have resource logs enabled for Azure DDoS Protection
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/752154a7-1e0f-45c6-a880-ac75a7e4f648'
parameters: {
effect: {
value: effect
          }
profileName: {
value: profileName
          }
logAnalytics: {
value: logAnalytics
          }
logsEnabled: {
value: logsEnabled
          }
metricsEnabled: {
value: metricsEnabled
          }
        }
      }
{
        //Deploy Diagnostic Settings for PostgreSQL flexible servers to Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/78ed47da-513e-41e9-a088-e829b373281d'
parameters: {
effect: {
value: effect
          }
profileName: {
value: profileName
          }
logAnalytics: {
value: logAnalytics
          }
metricsEnabled: {
value: true
          }
logsEnabled: {
value: true
          }
        }
      }
{
        //Configure diagnostic settings for Queue Services to Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/7bd000e3-37c7-4928-9f31-86c4b77c5c45'
parameters: {
effect: {
value: effect
          }
profileName: {
value: profileName
          }
logAnalytics: {
value: logAnalytics
          }
metricsEnabled: {
value: true
          }
logsEnabled: {
value: true
          }
        }
      }
{
        //Configure Azure SQL database servers diagnostic settings to Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/7ea8a143-05e3-4553-abfe-f56bef8b0b70'
parameters: {
logAnalyticsWorkspaceId: {
value: workspaceId
          }
effect: {
value: effect
          }
        }
      }
{
        //[Preview]: Log Analytics extension should be installed on your Linux Azure Arc machines
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/842c54e8-c2f9-4d79-ae8d-38d8b8019373'
parameters: {
effect: {
value: 'AuditIfNotExists'
          }
        }
      }
{
        //Azure Application Gateway should have Resource logs enabled
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/8a04f872-51e9-4313-97fb-fc1c3543011c'
parameters: {
effect: {
value: 'AuditIfNotExists'
          }
        }
      }
{
        //Azure Front Door should have Resource logs enabled
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/8a04f872-51e9-4313-97fb-fc1c35430fd8'
parameters: {
effect: {
value: 'AuditIfNotExists'
          }
        }
      }
{
        //Enable Security Center's auto provisioning of the Log Analytics agent on your subscriptions with custom workspace.
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/8e7da0a5-0a0e-4bbc-bfc0-7773c018b616'
parameters: {
effect: {
value: effect
          }
logAnalytics: {
value: logAnalytics
          }
        }
      }
{
        //Azure Log Search Alerts over Log Analytics workspaces should use customer-managed keys
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/94c1f94d-33b0-4062-bd04-1cdc3e7eece2'
parameters: {
effect: {
value: 'Audit'
          }
        }
      }
{
        //Deploy - Configure diagnostic settings for Azure Key Vault to Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/951af2fa-529b-416e-ab6e-066fd85ac459'
parameters: {
effect: {
value: effect
          }
// diagnosticsSettingNameToUse: {
// value: diagnosticsSettingName
//           }
logAnalytics: {
value: logAnalytics
          }
AuditEventEnabled: {
value: 'True'
          }
AllmetricsEnabled: {
value: 'True'
          }
        }
      }
{
        //Configure diagnostic settings for Azure Network Security Groups to Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/98a2e215-5382-489e-bd29-32e7190a39ba'
parameters: {
effect: {
value: effect
          }
// diagnosticsSettingNameToUse: {
// value: diagnosticsSettingName
//           }
logAnalytics: {
value: logAnalytics
          }
NetworkSecurityGroupEventEnabled: {
value: 'True'
          }
NetworkSecurityGroupRuleCounterEnabled: {
value: 'True'
          }
        }
      }
{
        //Configure Log Analytics extension on Azure Arc enabled Linux servers. See deprecation notice below
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/9d2b61b4-1d14-4a63-be30-d4498e7ad2cf'
parameters: {
logAnalytics: {
value: logAnalytics
          }
effect: {
value: effect
          }
        }
      }
{
        //Enable logging by category group for Firewall (microsoft.network/azurefirewalls) to Log Analytics
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/a4490248-cb97-4504-b7fb-f906afdb7437'
parameters: {
effect: {
value: effect
          }
diagnosticSettingName: {
value: diagnosticSettingName
          }
resourceLocationList: {
value: resourceLocationList
          }
logAnalytics: {
value: logAnalytics
          }
        }
      }
{
        //Virtual machines should have the Log Analytics extension installed
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/a70ca396-0a34-413a-88e1-b956c1e683be'
parameters: {
effect: {
value: 'AuditIfNotExists'
          }
        }
      }
{
        //Deploy - Configure diagnostic settings to a Log Analytics workspace to be enabled on Azure Key Vault Managed HSM
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/b3884c81-31aa-473d-a9bb-9466fe0ec2a0'
parameters: {
effect: {
value: effect
          }
profileName: {
value: profileName
          }
logAnalytics: {
value: logAnalytics
          }
metricsEnabled: {
value: metricsEnabled
          }
logsEnabled: {
value: logsEnabled
          }
        }
      }
{
        //Configure diagnostic settings for Blob Services to Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/b4fe1a3b-0715-4c6c-a5ea-ffc33cf823cb'
parameters: {
effect: {
value: effect
          }
profileName: {
value: profileName
          }
logAnalytics: {
value: logAnalytics
          }
metricsEnabled: {
value: true
          }
logsEnabled: {
value: true
          }
        }
      }
{
        //Deploy - Configure diagnostic settings for SQL Databases to Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/b79fa14e-238a-4c2d-b376-442ce508fc84'
parameters: {
effect: {
value: effect
          }
// diagnosticsSettingNameToUse: {
// value: diagnosticsSettingName
//           }
logAnalytics: {
value: logAnalytics
          }
QueryStoreRuntimeStatisticsEnabled: {
value: 'True'
          }
QueryStoreWaitStatisticsEnabled: {
value: 'True'
          }
ErrorsEnabled: {
value: 'True'
          }
DatabaseWaitStatisticsEnabled: {
value: 'True'
          }
BlocksEnabled: {
value: 'True'
          }
SQLInsightsEnabled: {
value: 'True'
          }
SQLSecurityAuditEventsEnabled: {
value: 'True'
          }
TimeoutsEnabled: {
value: 'True'
          }
AutomaticTuningEnabled: {
value: 'True'
          }
DeadlocksEnabled: {
value: 'True'
          }
Basic: {
value: 'True'
          }
InstanceAndAppAdvanced: {
value: 'True'
          }
WorkloadManagement: {
value: 'True'
          }
        }
      }
{
        //Deploy Diagnostic Settings for Logic Apps to Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/b889a06c-ec72-4b03-910a-cb169ee18721'
parameters: {
effect: {
value: effect
          }
profileName: {
value: profileName
          }
logAnalytics: {
value: logAnalytics
          }
metricsEnabled: {
value: metricsEnabled
          }
logsEnabled: {
value: logsEnabled
          }
        }
      }
{
        //[Preview]: Configure Azure Arc-enabled Linux machines with Log Analytics agents connected to default Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/bacd7fca-1938-443d-aad6-a786107b1bfb'
parameters: {
effect: {
value: effect
          }
        }
      }
{
        //Deploy Diagnostic Settings for Key Vault to Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/bef3f64c-5290-43b7-85b0-9b254eef4c47'
parameters: {
effect: {
value: effect
          }
profileName: {
value: profileName
          }
logAnalytics: {
value: logAnalytics
          }
metricsEnabled: {
value: metricsEnabled
          }
logsEnabled: {
value: logsEnabled
          }
matchWorkspace: {
value: true
          }
        }
      }
{
        //Enable logging by category group for App Service (microsoft.web/sites) to Log Analytics
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/c0d8e23a-47be-4032-961f-8b0ff3957061'
parameters: {
effect: {
value: effect
          }
diagnosticSettingName: {
value: diagnosticSettingName
          }
resourceLocationList: {
value: resourceLocationList
          }
logAnalytics: {
value: logAnalytics
          }
        }
      }
{
        //Deploy Diagnostic Settings for Recovery Services Vault to Log Analytics workspace for resource specific categories.
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/c717fb0c-d118-4c43-ab3d-ece30ac81fb3'
parameters: {
profileName: {
value: profileName
          }
logAnalytics: {
value: logAnalytics
          }
          // tagName: { 
          //        value: <enterVal>
          //                }
          // tagValue: { 
          //        value: <enterVal>
          //                }
          //     }
        }
      }
{
        //Deploy Diagnostic Settings for Batch Account to Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/c84e5349-db6d-4769-805e-e14037dab9b5'
parameters: {
effect: {
value: effect
          }
profileName: {
value: profileName
          }
logAnalytics: {
value: logAnalytics
          }
metricsEnabled: {
value: metricsEnabled
          }
logsEnabled: {
value: logsEnabled
          }
        }
      }
{
        //Azure Front Door Standard or Premium (Plus WAF) should have resource logs enabled
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/cd906338-3453-47ba-9334-2d654bf845af'
parameters: {
effect: {
value: 'AuditIfNotExists'
          }
        }
      }
{
        //Enable logging by category group for PostgreSQL flexible server (microsoft.dbforpostgresql/flexibleservers) to Log Analytics
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/cdd1dbc6-0004-4fcd-afd7-b67550de37ff'
parameters: {
effect: {
value: effect
          }
diagnosticSettingName: {
value: diagnosticSettingName
          }
          /*
categoryGroup: { 
       value: <enterVal>
               }
*/
resourceLocationList: {
value: resourceLocationList
          }
logAnalytics: {
value: logAnalytics
          }
        }
      }
{
        //Configure Azure Log Analytics workspaces to disable public network access for log ingestion and querying
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/d3ba9c42-9dd5-441a-957c-274031c750c0'
parameters: {
effect: {
value: 'audit'
          }
        }
      }
{
        //Azure Monitor Logs for Application Insights should be linked to a Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/d550e854-df1a-4de9-bf44-cd894b39a95e'
parameters: {
effect: {
value: 'audit'
          }
        }
      }
{
        //Deploy Diagnostic Settings for Data Lake Analytics to Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/d56a5a7c-72d7-42bc-8ceb-3baf4c0eae03'
parameters: {
effect: {
value: effect
          }
profileName: {
value: profileName
          }
logAnalytics: {
value: logAnalytics
          }
metricsEnabled: {
value: metricsEnabled
          }
logsEnabled: {
value: logsEnabled
          }
        }
      }
{
        //[Preview]: Log Analytics extension should be installed on your Windows Azure Arc machines
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/d69b1763-b96d-40b8-a2d9-ca31e9fd0d3e'
parameters: {
effect: {
value: 'AuditIfNotExists'
          }
        }
      }
{
        //Log Analytics Workspaces should block non-Azure Active Directory based ingestion.
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/e15effd4-2278-4c65-a0da-4d6f6d1890e2'
parameters: {
effect: {
value: 'Audit'
          }
        }
      }
{
        //Enable logging by category group for Function App (microsoft.web/sites) to Log Analytics
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/e9c22e0d-1f03-44da-a9d5-a9754ea53dc4'
parameters: {
effect: {
value: effect
          }
diagnosticSettingName: {
value: diagnosticSettingName
          }
resourceLocationList: {
value: resourceLocationList
          }
logAnalytics: {
value: logAnalytics
          }
        }
      }
{
        //The Log Analytics extension should be installed on Virtual Machine Scale Sets
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/efbde977-ba53-4479-b8e9-10b957924fbf'
parameters: {
effect: {
value: 'AuditIfNotExists'
          }
        }
      }
{
        //Virtual machines should be connected to a specified workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/f47b5582-33ec-4c5c-87c0-b010a6b2e917'
parameters: {
logAnalyticsWorkspaceId: {
value: workspaceId
          }
effect: {
value: 'AuditIfNotExists'
          }
        }
      }
{
        //Configure diagnostic settings for Azure Machine Learning Workspaces to Log Analytics workspace
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/f59276f0-5740-4aaf-821d-45d185aa210e'
parameters: {
effect: {
value: effect
          }
profileName: {
value: profileName
          }
logAnalytics: {
value: logAnalytics
          }
metricsEnabled: {
value: true
          }
logsEnabled: {
value: true
          }
        }
      }
{
        //Saved-queries in Azure Monitor should be saved in customer storage account for logs encryption
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/fa298e57-9444-42ba-bf04-86e8470e32c7'
parameters: {
effect: {
value: 'audit'
          }
        }
      }
{
        //Deploy export to Log Analytics workspace for Microsoft Defender for Cloud data
policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/ffb6f416-7bd2-4488-8828-56585fef2be9'
parameters: {
resourceGroupName: {
value: logAnalyticsRG
          }
          resourceGroupLocation: { 
                 value: 'eastus'
                         }
createResourceGroup: {
value: false
          }
// exportedDataTypes: {
// value: true
//           }
// recommendationNames: {
// value: 'defender-recommendations'
//           }
recommendationSeverities: {
value: ['High', 'Medium']
          }
isSecurityFindingsEnabled: {
value: true
          }
// secureScoreControlsNames: {
// value: 'defender-controls'
//           }
alertSeverities: {
value: ['High', 'Medium']
          }
// regulatoryComplianceStandardsNames: {
// value: 'defender-regulatory-compliance-standards'
//           }
workspaceResourceId: {
value: workspaceId
          }
        }
      }
    ]
  }
}

resource initiativeAssignment 'Microsoft.Authorization/policyAssignments@2021-06-01' = {
  name: 'FRGAROFALO_Assign_DataObserviablity_Assignment'
  location: 'eastus'
  identity: {
    type: 'userAssigned'
    userAssignedIdentities: {
      userAssignedMI: {
        clientId: userAssignedMI
      }
    }
  }
  properties: {
    displayName: 'FRGAROFALO Assign Data Observiablity Assignment'
    description: 'Enable policies and policy sets for Data Observability, Logging, Diagnostic Settings Azure resources'
    policyDefinitionId: initiative.id
    // Additional properties like parameters, etc.
  }
}
