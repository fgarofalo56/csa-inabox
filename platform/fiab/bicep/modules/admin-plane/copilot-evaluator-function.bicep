// CSA Loom — copilot-evaluator Function (loom-next-level E2). Azure Functions
// on a Linux Consumption (Y1/Dynamic) plan with a system-assigned identity.
//
// On COPILOT_EVALUATOR_CRON (default nightly 07:00 UTC — deliberately OFF-PEAK
// so the LLM-judge run never competes with production Copilot AOAI TPM during
// business hours) plus an on-demand HTTP trigger (corpus-staging workflow E4 /
// admin "Run now" E5), the Function executes the E1 golden Q/A eval sets
// against the REAL Copilot path: it POSTs the console's internal
// /api/internal/copilot/eval-probe route (real searchDocs + one real
// aoai-chat-client turn — byte-identical retrieval + tier routing), gates the
// deterministic mustMention/mustNotMention guards BEFORE the LLM judge
// (forbidden phrase = auto-fail, zero judge spend), enforces the
// LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP, and writes scored eval-run/eval-result
// docs to Cosmos `loom-copilot-evals` (PK /surface).
//
// Code: azure-functions/copilot-evaluator (Node v4 model). Azure-native — NO
// Microsoft Fabric dependency (the judge rubric actively asserts answers never
// claim a Fabric capacity is required).
//
// FUNCTION STANDARD (loom-next-level rev 2 — the report-subscriptions
// listKeys() connection string is deliberately NOT mirrored):
//   - IDENTITY-BASED AzureWebJobsStorage (accountName + blob/queueServiceUri +
//     credential=managedidentity; allowSharedKeyAccess=false — the estate is
//     AAD-only, a key-based string is rejected KeyBasedAuthenticationNotPermitted).
//   - ALL role grants declared HERE (guid() names, skipRoleGrants-aware):
//       * Storage Blob Data Owner + Storage Queue Data Contributor — host storage
//       * Search Index Data Reader — the AI Search service (retrieval telemetry parity)
//       * Cognitive Services OpenAI User — the AOAI/Foundry account (LLM judge)
//       * Cosmos DB Built-in Data Contributor (data-plane sqlRoleAssignment) —
//         the Loom Cosmos account (same-RG hub account; a DLZ-hosted account is
//         cross-RG → grant via grant-navigator-rbac.sh, documented in the runbook)
//   - LOOM_INTERNAL_TOKEN is a LITERAL @secure() value (builtin-mcp precedent):
//     the Loom Key Vault is private-link-only and a Consumption Function App has
//     no VNet integration, so a KV reference would resolve to the literal string.
//
// DEDICATED JUDGE DEPLOYMENT (capacity note, SRE F10): the judge deployment
// resolves LOOM_COPILOT_EVAL_JUDGE_DEPLOYMENT → LOOM_AOAI_STRONG_DEPLOYMENT →
// LOOM_AOAI_MINI_DEPLOYMENT → LOOM_AOAI_DEPLOYMENT (never a hardcoded model
// name — bicep binds the strong tier per cloud from the availability matrix).
// Set judgeDeployment (functionAppsConfig.copilotEvalJudgeDeployment) to a
// DEDICATED deployment/TPM allocation to fully isolate prod Copilot quota.
// Full capacity + rollback notes: azure-functions/copilot-evaluator/README.md.
//
// Grounded in Microsoft Learn:
//   Functions infra-as-code + identity-based host storage
//   https://learn.microsoft.com/azure/azure-functions/functions-infrastructure-as-code
//   https://learn.microsoft.com/azure/azure-functions/functions-reference#connecting-to-host-storage-with-an-identity
//   Timer trigger (NCRONTAB)
//   https://learn.microsoft.com/azure/azure-functions/functions-bindings-timer

targetScope = 'resourceGroup'

@description('Primary region.')
param location string

@description('Loom Cosmos account endpoint (https://<acct>.documents.<suffix>:443/). Empty disables the engine cleanly (honest no-op tick).')
param loomCosmosEndpoint string = ''

@description('Loom Cosmos database id.')
param loomCosmosDatabase string = 'loom'

@description('Loom Cosmos account NAME when the hub account lives in THIS resource group — enables the in-module data-plane role grant. Empty skips the grant (cross-RG/DLZ account: grant via grant-navigator-rbac.sh).')
param cosmosAccountName string = ''

@description('NCRONTAB schedule (6-field) for the nightly eval run. Default 07:00 UTC — off-peak so judge spend never competes with business-hours Copilot TPM.')
param copilotEvaluatorCron string = '0 0 7 * * *'

@description('Console base URL the internal eval-probe route is reached at (Front Door public URL, or the CAE FQDN when reachable). The probe call carries the shared internal trust token.')
param consoleBaseUrl string = ''

@description('Shared VNet-internal trust token (deterministic guid from the orchestrator — the same value the Console validates). LITERAL app setting: the private Loom KV is unreachable from a Consumption plan.')
@secure()
param internalToken string = ''

@description('AOAI endpoint for the LLM judge. Empty → judge scores are honestly `deferred` (retrieval-only scoring still runs).')
param aoaiEndpoint string = ''

@description('AOAI/Foundry ACCOUNT NAME in this RG for the in-module Cognitive Services OpenAI User grant. Empty skips the grant (BYO/cross-RG account: grant documented in the runbook).')
param aoaiAccountName string = ''

@description('Dedicated judge deployment name (LOOM_COPILOT_EVAL_JUDGE_DEPLOYMENT). Empty → the Function falls back strong → mini → default at runtime.')
param judgeDeployment string = ''

@description('Strong (reasoning) deployment name — the judge fallback chain head (bicep-bound per cloud from the availability matrix; never a hardcoded model).')
param strongDeployment string = ''

@description('Mini deployment name — judge fallback after strong.')
param miniDeployment string = ''

@description('Default chat deployment name — the final judge fallback.')
param defaultDeployment string = ''

@description('Daily LLM-judge call cap (round-3 F1). Over cap → runs score retrieval-only and judge scores are marked deferred.')
param judgeDailyCap int = 500

@description('AI Search service NAME in this RG for the in-module Search Index Data Reader grant. Empty skips the grant.')
param aiSearchServiceName string = ''

@description('SRCH1 — Entra oid the federated-search eval-probe runs AS (searchCatalog is ACL-scoped). Empty → the search relevance run honest-gates (the probe 400s naming LOOM_EVAL_PROBE_OID).')
param evalProbeOid string = ''

@description('When true, skip every role grant (re-deploy where RBAC already exists, or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

@description('Application Insights connection string for telemetry. Empty skips wiring.')
param appInsightsConnectionString string = ''

@description('Compliance tags applied to every resource.')
param complianceTags object

var saName = take('sacpeval${uniqueString(resourceGroup().id)}', 24)
var planName = take('plan-cpeval-${uniqueString(resourceGroup().id)}', 40)
var siteName = take('func-cpeval-${uniqueString(resourceGroup().id)}', 60)

// COST0 tag convention: every loom-next-level program resource carries the
// `loom-next-level` tag so program-budget.bicep's tag-filtered Consumption
// budget bounds the program's aggregate run-rate (E2 is ~$0 idle Y1 + a
// day-capped judge token spend — see program-budget.README.md).
var programTags = union(complianceTags, { 'loom-next-level': 'true' })

// ── Host storage (identity-based; AAD-only estate — NO account key) ──────────
resource sa 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: saName
  location: location
  tags: programTags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    // Estate policy seals new storage (publicNetworkAccess=Disabled); the Y1
    // Functions runtime reaches host storage via the trusted-services bypass —
    // without it the host dies the way func-rptsub's did (AAD-only + key string).
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

@description('Existing Linux Y1 (Dynamic) plan resource id to REUSE instead of creating a new one — the admin RG Linux-consumption webspace rejects additional plans (ExtendedCode 59324) once saturated; Y1 plans host multiple Function apps. Empty = create a dedicated plan (fresh RGs).')
param existingPlanId string = ''

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = if (empty(existingPlanId)) {
  name: planName
  location: location
  tags: programTags
  sku: { name: 'Y1', tier: 'Dynamic' }
  kind: 'functionapp,linux'
  properties: { reserved: true }
}

var effectivePlanId = empty(existingPlanId) ? plan.id : existingPlanId

var baseAppSettings = [
  // Identity-based runtime storage — no key in app settings (Function standard).
  { name: 'AzureWebJobsStorage__accountName', value: sa.name }
  { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }
  { name: 'AzureWebJobsStorage__blobServiceUri', value: 'https://${sa.name}.blob.${environment().suffixes.storage}' }
  { name: 'AzureWebJobsStorage__queueServiceUri', value: 'https://${sa.name}.queue.${environment().suffixes.storage}' }
  { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
  { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
  { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
  { name: 'COPILOT_EVALUATOR_CRON', value: copilotEvaluatorCron }
  { name: 'LOOM_COSMOS_ENDPOINT', value: loomCosmosEndpoint }
  { name: 'LOOM_COSMOS_DATABASE', value: loomCosmosDatabase }
  { name: 'LOOM_EVAL_PROBE_URL', value: consoleBaseUrl }
  { name: 'LOOM_INTERNAL_TOKEN', value: internalToken }
  { name: 'LOOM_AOAI_ENDPOINT', value: aoaiEndpoint }
  { name: 'LOOM_COPILOT_EVAL_JUDGE_DEPLOYMENT', value: judgeDeployment }
  { name: 'LOOM_AOAI_STRONG_DEPLOYMENT', value: strongDeployment }
  { name: 'LOOM_AOAI_MINI_DEPLOYMENT', value: miniDeployment }
  { name: 'LOOM_AOAI_DEPLOYMENT', value: defaultDeployment }
  { name: 'LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP', value: string(judgeDailyCap) }
  { name: 'LOOM_EVAL_PROBE_OID', value: evalProbeOid }
  // Default-ON / opt-out (loom_default_on_opt_out): flip to false to disable.
  { name: 'LOOM_COPILOT_EVAL_ENABLED', value: 'true' }
]

resource site 'Microsoft.Web/sites@2024-04-01' = {
  name: siteName
  location: location
  tags: programTags
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: effectivePlanId
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

// ── Role grants (ALL in-module; guid() names; skipRoleGrants-aware) ──────────

// Storage Blob Data Owner — required by identity-based AzureWebJobsStorage.
var blobOwnerRoleId = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
resource blobOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants) {
  name: guid(sa.id, site.id, blobOwnerRoleId)
  scope: sa
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobOwnerRoleId)
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Storage Queue Data Contributor — the Functions host uses queues for timer leases.
var queueContribRoleId = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
resource queueContrib 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants) {
  name: guid(sa.id, site.id, queueContribRoleId)
  scope: sa
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', queueContribRoleId)
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Search Index Data Reader on the AI Search service (retrieval-side parity).
resource aiSearch 'Microsoft.Search/searchServices@2023-11-01' existing = if (!empty(aiSearchServiceName)) {
  name: aiSearchServiceName
}
var searchIndexDataReaderRoleId = '1407120a-92aa-4202-b7e9-c0e197c71c8f'
resource searchReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants && !empty(aiSearchServiceName)) {
  name: guid(resourceGroup().id, siteName, aiSearchServiceName, searchIndexDataReaderRoleId)
  scope: aiSearch
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', searchIndexDataReaderRoleId)
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Cognitive Services OpenAI User on the AOAI/Foundry account (the LLM judge).
resource aoaiAccount 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = if (!empty(aoaiAccountName)) {
  name: aoaiAccountName
}
var cognitiveServicesOpenAiUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
resource aoaiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants && !empty(aoaiAccountName)) {
  name: guid(resourceGroup().id, siteName, aoaiAccountName, cognitiveServicesOpenAiUserRoleId)
  scope: aoaiAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesOpenAiUserRoleId)
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Cosmos DB Built-in Data Contributor (data-plane) on the same-RG hub account —
// the loom-copilot-evals writes. Cross-RG (DLZ-hosted) accounts: see the runbook.
resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2024-12-01-preview' existing = if (!empty(cosmosAccountName)) {
  name: cosmosAccountName
}
resource cosmosDataRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-12-01-preview' = if (!skipRoleGrants && !empty(cosmosAccountName)) {
  parent: cosmosAccount
  name: guid(resourceGroup().id, siteName, cosmosAccountName, '00000000-0000-0000-0000-000000000002')
  properties: {
    roleDefinitionId: '${resourceId('Microsoft.DocumentDB/databaseAccounts', cosmosAccountName)}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
    principalId: site.identity.principalId
    scope: resourceId('Microsoft.DocumentDB/databaseAccounts', cosmosAccountName)
  }
}

output siteId string = site.id
output siteName string = site.name
output defaultHostName string = site.properties.defaultHostName
@description('Default host (function) key — the Console reads this as LOOM_COPILOT_EVALUATOR_KEY so the E5 admin "Run now" can call the authLevel:function copilotEvaluatorHttp trigger (same pattern as scc-labels-function.functionKey). Not a storage key — this is the Functions host key.')
output functionKey string = listKeys('${site.id}/host/default', '2024-04-01').functionKeys.default
@description('System-assigned identity principalId (for any cross-RG data-plane grant, e.g. a DLZ-hosted Cosmos account via grant-navigator-rbac.sh).')
output principalId string = site.identity.principalId
