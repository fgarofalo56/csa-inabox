// CSA Loom — Operations Agent evaluator + approval infra (G3).
//
// Azure-native backing for a CSA Loom operations agent's autonomous
// monitor -> reason -> act loop (NO Microsoft Fabric / Power Automate
// dependency — see .claude/rules/no-fabric-dependency.md). Provisions the
// SHARED infrastructure the operations-agent item needs; the per-trigger
// scheduledQueryRules + action groups themselves are created dynamically by the
// Console (lib/azure/activator-monitor.ts) when a user adds a trigger, so they
// are NOT templated here.
//
// Resources:
//   1. Evaluator Function App (Linux Consumption, timer-triggered) — on a cron
//      it reads the agent's fired triggers, calls Azure OpenAI to interpret +
//      recommend, and dispatches the bound approval Logic App. System-assigned
//      identity, granted Monitoring Reader (ARM) here and Database Viewer on the
//      bound Eventhouse/ADX when a co-located cluster+db is provided.
//      Code: azure-functions/ops-agent-evaluator (Node v4 model).
//   2. Approval Logic App (Consumption) — an HTTP-triggered workflow that posts
//      a Microsoft Teams adaptive card ("post adaptive card and wait for a
//      response") to the approver and returns the decision to the caller. This
//      is the human-in-the-loop approval channel the ops-agent evaluator invokes
//      when a trigger has requireApproval=true.
//   3. Teams API connection (managed 'teams' connector) the workflow uses.
//
// Grounded in Microsoft Learn:
//   Functions IaC (serverfarms Y1/Dynamic) + Microsoft.Web/sites:
//     https://learn.microsoft.com/azure/azure-functions/functions-infrastructure-as-code
//   Timer trigger (NCRONTAB):
//     https://learn.microsoft.com/azure/azure-functions/functions-bindings-timer
//   Microsoft.Logic/workflows (Consumption, Bicep):
//     https://learn.microsoft.com/azure/templates/microsoft.logic/workflows
//   Teams connector "Post adaptive card and wait for a response":
//     https://learn.microsoft.com/connectors/teams/
//   ADX database principal assignment (Database Viewer):
//     https://learn.microsoft.com/azure/templates/microsoft.kusto/clusters/databases/principalassignments
//   Monitoring Reader built-in role:
//     https://learn.microsoft.com/azure/role-based-access-control/built-in-roles#monitoring-reader
//
// DEPLOYMENT NOTES (post-deploy, out-of-band — Bicep cannot do these):
//   - The Teams API connection must be OAuth-authorized in the portal (Logic App
//     -> Edit -> the Teams action -> Change connection -> sign in). GCC-High: use
//     the AzureUSGovernment auth endpoint. Until authorized, the action 401s.
//   - Teams adaptive cards posted by an APP identity additionally require the
//     Microsoft Graph application permission Chat.ReadWrite (or ChannelMessage.
//     Send). That is an AAD APP-ROLE grant, which ARM roleAssignments CANNOT
//     express — grant it via `az ad app permission` / admin consent in the
//     post-deploy bootstrap (docs/fiab/v3-tenant-bootstrap.md). This module wires
//     everything else; the Graph grant is the one honest out-of-band step.
//
// Standalone entrypoint: deployed out-of-band (admin-plane/main.bicep is at the
// 256-parameter ceiling), then LOOM_OPS_AGENT_EVALUATOR_FUNC /
// LOOM_OPS_AGENT_APPROVAL_LOGICAPP are set on the Console app. The ops-agent
// evaluator + approval channel honest-gate until wired. Allowlisted in
// scripts/ci/check-bicep-sync.mjs.
//
//   az deployment group create -g <rg> \
//     -f platform/fiab/bicep/modules/admin-plane/monitor-ops-agent.bicep \
//     -p location=<region> aoaiEndpoint=<https://…> aoaiDeployment=gpt-4o \
//        lawResourceId=<LAW id> complianceTags='{}'

targetScope = 'resourceGroup'

@description('Primary region.')
param location string = resourceGroup().location

@description('Azure OpenAI endpoint the evaluator calls to interpret a fired trigger and recommend an action (https://<res>.openai.azure.com/). Empty → the evaluator honest-gates (no reasoning) until set.')
param aoaiEndpoint string = ''

@description('Azure OpenAI chat deployment name used for reasoning (e.g. gpt-4o).')
param aoaiDeployment string = 'gpt-4o'

@description('Loom Cosmos account endpoint the evaluator reads the agents + their triggers from (https://<acct>.documents.<suffix>:443/). Empty disables the engine cleanly.')
param loomCosmosEndpoint string = ''

@description('Loom Cosmos database id.')
param loomCosmosDatabase string = 'loom'

@description('ADX / Eventhouse cluster query URI the evaluator runs trigger KQL against (https://<cluster>.<region>.kusto.windows.net). Empty → LA-sourced triggers only.')
param adxClusterUri string = ''

@description('ADX / Eventhouse cluster NAME (in THIS resource group) to grant the evaluator Database Viewer on. Empty skips the inline data-plane grant (grant out-of-band instead).')
param adxClusterName string = ''

@description('ADX / Eventhouse database name to grant Database Viewer on. Required together with adxClusterName for the inline grant.')
param adxDatabaseName string = ''

@description('Azure Monitor Log Analytics workspace ARM id the evaluator reads scheduled-query alert state from. Empty → ADX-sourced triggers only.')
param lawResourceId string = ''

@description('NCRONTAB (6-field) schedule for the evaluator tick. Default every 5 minutes — the operations-agent parity cadence.')
param evaluatorCron string = '0 */5 * * * *'

@description('Loom Console UAMI principalId — granted Logic App Contributor so the Console BFF can call listCallbackUrl on the approval workflow. Empty skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Application Insights connection string for telemetry. Empty skips wiring.')
param appInsightsConnectionString string = ''

@description('Compliance tags applied to every resource.')
param complianceTags object = {}

// ── names ──────────────────────────────────────────────────────────────────
var suffix = uniqueString(resourceGroup().id)
var saName = take('saopsagent${suffix}', 24)
var planName = take('plan-opsagent-${suffix}', 40)
var funcName = take('func-opsagent-${suffix}', 60)
var logicAppName = take('logic-opsagent-approval-${suffix}', 80)
var teamsConnName = take('teams-opsagent-${suffix}', 60)

// Built-in role: Monitoring Reader.
var monitoringReaderRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '43d0d8ad-25c7-4714-9337-8ba259a9fe05')
// Built-in role: Logic App Contributor.
var logicAppContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '87a39d53-fc1b-424a-814c-f7e04687dc9e')

// ── evaluator Function App ──────────────────────────────────────────────────
resource sa 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: saName
  location: location
  tags: complianceTags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: planName
  location: location
  tags: complianceTags
  sku: { name: 'Y1', tier: 'Dynamic' }
  kind: 'functionapp,linux'
  properties: { reserved: true }
}

var baseAppSettings = [
  {
    name: 'AzureWebJobsStorage'
    value: 'DefaultEndpointsProtocol=https;AccountName=${sa.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${sa.listKeys().keys[0].value}'
  }
  { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
  { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
  { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
  { name: 'OPS_AGENT_EVALUATOR_CRON', value: evaluatorCron }
  { name: 'LOOM_COSMOS_ENDPOINT', value: loomCosmosEndpoint }
  { name: 'LOOM_COSMOS_DATABASE', value: loomCosmosDatabase }
  { name: 'LOOM_AOAI_ENDPOINT', value: aoaiEndpoint }
  { name: 'LOOM_AOAI_DEPLOYMENT', value: aoaiDeployment }
  { name: 'LOOM_KUSTO_CLUSTER_URI', value: adxClusterUri }
  { name: 'LOOM_LOG_ANALYTICS_RESOURCE_ID', value: lawResourceId }
  { name: 'LOOM_OPS_AGENT_APPROVAL_LOGICAPP', value: logicAppName }
  { name: 'LOOM_ARM_ENDPOINT', value: environment().resourceManager }
  { name: 'LOOM_STORAGE_SUFFIX', value: environment().suffixes.storage }
]

resource func 'Microsoft.Web/sites@2024-04-01' = {
  name: funcName
  location: location
  tags: complianceTags
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'Node|20'
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      appSettings: empty(appInsightsConnectionString) ? baseAppSettings : concat(baseAppSettings, [
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
      ])
    }
  }
}

// ── Teams API connection (managed connector) ────────────────────────────────
resource teamsConn 'Microsoft.Web/connections@2016-06-01' = {
  name: teamsConnName
  location: location
  tags: complianceTags
  properties: {
    displayName: 'Loom Operations Agent — Teams approval'
    api: {
      id: subscriptionResourceId('Microsoft.Web/locations/managedApis', location, 'teams')
    }
  }
}

// ── Approval Logic App (Consumption) ────────────────────────────────────────
// HTTP-triggered: the evaluator POSTs { agentName, recommendation, ruleName,
// approver } and the workflow posts a Teams adaptive card and waits for the
// approver's decision, then returns it. The Teams action + connection are
// OAuth-authorized post-deploy (see DEPLOYMENT NOTES).
resource approvalWorkflow 'Microsoft.Logic/workflows@2019-05-01' = {
  name: logicAppName
  location: location
  tags: complianceTags
  properties: {
    state: 'Enabled'
    definition: {
      '$schema': 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#'
      contentVersion: '1.0.0.0'
      parameters: {
        '$connections': { type: 'Object', defaultValue: {} }
      }
      triggers: {
        manual: {
          type: 'Request'
          kind: 'Http'
          inputs: {
            schema: {
              type: 'object'
              properties: {
                agentName: { type: 'string' }
                ruleName: { type: 'string' }
                recommendation: { type: 'string' }
                approverUpn: { type: 'string' }
              }
            }
          }
        }
      }
      actions: {
        Post_adaptive_card_and_wait: {
          type: 'ApiConnectionWebhook'
          inputs: {
            host: {
              connection: { name: '@parameters(\'$connections\')[\'teams\'][\'connectionId\']' }
            }
            body: {
              notificationUrl: '@{listCallbackUrl()}'
              body: {
                messageBody: '@{triggerBody()?[\'recommendation\']}'
                recipient: '@{triggerBody()?[\'approverUpn\']}'
              }
            }
            path: '/flowbot/actions/flowcontinuation/recipients/@{encodeURIComponent(triggerBody()?[\'approverUpn\'])}/waitForResponse'
          }
        }
        Respond: {
          type: 'Response'
          kind: 'Http'
          runAfter: {
            Post_adaptive_card_and_wait: [ 'Succeeded' ]
          }
          inputs: {
            statusCode: 200
            body: '@body(\'Post_adaptive_card_and_wait\')'
          }
        }
      }
    }
    parameters: {
      '$connections': {
        value: {
          teams: {
            connectionId: teamsConn.id
            connectionName: teamsConnName
            id: subscriptionResourceId('Microsoft.Web/locations/managedApis', location, 'teams')
          }
        }
      }
    }
  }
}

// ── role assignments ────────────────────────────────────────────────────────
// Evaluator identity → Monitoring Reader on this RG (read scheduled-query rule +
// alert state). Real ARM grant.
resource evalMonitoringReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants) {
  name: guid(resourceGroup().id, func.id, 'monitoring-reader')
  properties: {
    roleDefinitionId: monitoringReaderRoleId
    principalId: func.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Console UAMI → Logic App Contributor on the approval workflow (listCallbackUrl).
resource consoleLogicContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants && !empty(consolePrincipalId)) {
  name: guid(approvalWorkflow.id, consolePrincipalId, 'logic-contributor')
  scope: approvalWorkflow
  properties: {
    roleDefinitionId: logicAppContributorRoleId
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Evaluator identity → Database Viewer on the bound Eventhouse/ADX database
// (data-plane principalAssignment). Only when a co-located cluster + database
// are named; otherwise grant out-of-band (docs/fiab/v3-tenant-bootstrap.md).
resource adxCluster 'Microsoft.Kusto/clusters@2023-08-15' existing = if (!empty(adxClusterName)) {
  name: empty(adxClusterName) ? 'placeholder' : adxClusterName
}

resource adxDbViewer 'Microsoft.Kusto/clusters/databases/principalAssignments@2023-08-15' = if (!skipRoleGrants && !empty(adxClusterName) && !empty(adxDatabaseName)) {
  name: '${empty(adxClusterName) ? 'placeholder' : adxClusterName}/${empty(adxDatabaseName) ? 'placeholder' : adxDatabaseName}/opsagenteval'
  properties: {
    principalId: func.identity.principalId
    principalType: 'App'
    role: 'Viewer'
    tenantId: subscription().tenantId
  }
  dependsOn: [ adxCluster ]
}

// ── outputs ─────────────────────────────────────────────────────────────────
@description('Evaluator Function App resource id — set LOOM_OPS_AGENT_EVALUATOR_FUNC on the Console app.')
output evaluatorFunctionId string = func.id
output evaluatorFunctionName string = func.name
@description('Evaluator system-assigned identity principalId — grant Cosmos DB Built-in Data Contributor + (if not inlined) ADX Database Viewer + Microsoft Graph Chat.ReadWrite in post-deploy bootstrap.')
output evaluatorPrincipalId string = func.identity.principalId
@description('Approval Logic App workflow name — set LOOM_OPS_AGENT_APPROVAL_LOGICAPP on the Console app.')
output approvalLogicAppName string = approvalWorkflow.name
output approvalLogicAppId string = approvalWorkflow.id
output teamsConnectionName string = teamsConn.name
