// CSA Loom — secret-expiry monitor timer Function (S1). Azure Functions on a
// Linux Consumption (Y1/Dynamic) plan with a system-assigned identity. On the
// SECRET_EXPIRY_CRON schedule (default daily 06:00 UTC) it inventories the
// Console MSAL app registration's passwordCredentials[] via Microsoft Graph,
// reads attributes.exp / attributes.updated for every tracked Key Vault secret
// (loom-msal-client-secret, synthetic-login-secret, …), computes days-to-expiry
// + the 60/30/7-day bands, detects MSAL KV drift, and on band ESCALATION fires
// the shared loom-default-alerts action group (LOOM_ALERT_ACTION_GROUP_ID, the
// O1 alert convention) + an optional dedup GitHub issue. Prevention for the
// 2026-07-19 expired/drifted-MSAL-secret total sign-in outage, which recurs on
// a 2-year clock (entra-app-registration.bicep mints the secret --years 2).
//
// Code: azure-functions/secret-expiry-monitor (Node v4 model, pure core + thin
// wrappers mirroring ops-agent-evaluator). Rollback: see that folder's README
// (env-flip to silence alerts, functionAppsConfig.secretExpiryEnabled=false to
// remove; the /admin/health surface reads Graph+KV live and is independent).
//
// IDENTITY-BASED HOST STORAGE (Function standard — NO storage keys):
//   AzureWebJobsStorage__accountName + AzureWebJobsStorage__credential =
//   managedidentity; the system identity is granted Storage Blob Data Owner +
//   Storage Queue Data Contributor on the Function's own storage account below.
// Roles declared HERE (guid() names, skipRoleGrants-aware):
//   - Storage Blob Data Owner + Storage Queue Data Contributor (own SA),
//   - Key Vault Secrets User on the hub vault (secret ATTRIBUTES only),
//   - Monitoring Contributor on this RG (action-group createNotifications).
// The Graph app role Application.Read.All is a Graph object, NOT ARM — it is a
// documented ONE-TIME admin consent (docs/fiab/runbooks/secret-rotation.md,
// script pre-filled with the principalId output). Until granted the Graph half
// honest-gates in the logs while the Key Vault half keeps working.
//
// Grounded in Microsoft Learn:
//   Functions infra-as-code (serverfarms Y1/Dynamic) + Microsoft.Web/sites
//   https://learn.microsoft.com/azure/azure-functions/functions-infrastructure-as-code
//   Identity-based host storage (AzureWebJobsStorage__accountName)
//   https://learn.microsoft.com/azure/azure-functions/functions-reference#connecting-to-host-storage-with-an-identity
//   Timer trigger (NCRONTAB)
//   https://learn.microsoft.com/azure/azure-functions/functions-bindings-timer
//   Action Groups createNotifications
//   https://learn.microsoft.com/rest/api/monitor/action-groups/create-notifications-at-action-group-resource-level

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Console MSAL app (client) id whose passwordCredentials are inventoried via Graph. Empty → the Graph half honest-gates (KV inventory still runs).')
param msalClientId string = ''

@description('Hub Key Vault NAME (same RG) — the Function identity is granted Key Vault Secrets User on it.')
param keyVaultName string

@description('Hub Key Vault data-plane URI (https://<vault>.vault.<suffix>/).')
param keyVaultUri string

@description('Comma-separated tracked KV secret NAMES (attributes-only reads). Not secret material — a list of identifiers, hence the lint suppression.')
#disable-next-line secure-secrets-in-params
param trackedKvSecrets string = 'loom-msal-client-secret,synthetic-login-secret'

@description('Days-to-expiry OUTER warning threshold (LOOM_SECRET_EXPIRY_WARN_DAYS). Inner 30/7-day bands are fixed.')
param warnDays int = 60

@description('NCRONTAB schedule (6-field) for the expiry tick. Default daily 06:00 UTC — expiry is a slow clock; escalation dedup makes a finer cadence safe but pointless. Not secret material — a cron string, hence the lint suppression.')
#disable-next-line secure-secrets-in-params
param secretExpiryCron string = '0 0 6 * * *'

@description('ARM id of the shared loom-default-alerts action group (monitoring-default-alerts.bicep::defaultActionGroup — the O1 alert convention). Empty → alerts are logged only (honest gate).')
param actionGroupId string = ''

@description('Sovereign Graph base (https://graph.microsoft.com | graph.microsoft.us | dod-graph.microsoft.us).')
param graphBase string = 'https://graph.microsoft.com'

@description('Skip RBAC role assignments (reconcile passes on estates where grants already exist).')
param skipRoleGrants bool = false

@description('Application Insights connection string for telemetry. Empty skips wiring.')
param appInsightsConnectionString string = ''

@description('Compliance tags applied to every resource.')
param complianceTags object

var saName = take('sasecexp${uniqueString(resourceGroup().id)}', 24)
var planName = take('plan-secexp-${uniqueString(resourceGroup().id)}', 40)
var siteName = take('func-secexp-${uniqueString(resourceGroup().id)}', 60)
var stateContainerName = 'secret-expiry-state'

// COST0 tag convention: every loom-next-level program resource carries the
// `loom-next-level` tag so program-budget.bicep's tag-filtered Consumption
// budget bounds the program's aggregate run-rate (S1 is ~$0 idle on Y1 — see
// program-budget.README.md).
var programTags = union(complianceTags, { 'loom-next-level': 'true' })

// Built-in role definition ids (same constants the sibling modules use).
var blobDataOwnerRoleId = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b' // Storage Blob Data Owner
var queueDataContributorRoleId = '974c5e8b-45b9-4653-ba55-5f855dd0fb88' // Storage Queue Data Contributor
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6' // Key Vault Secrets User
var monitoringContributorRoleId = '749f88d5-cbae-40b8-bcfc-e573ddc772fa' // Monitoring Contributor

resource sa 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: saName
  location: location
  tags: programTags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true // Functions runtime host requirements; app auth is identity-based (no key in app settings)
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

// Escalation-dedup state blob lives here (last-alerted band per credential).
resource saBlob 'Microsoft.Storage/storageAccounts/blobServices@2024-01-01' = {
  parent: sa
  name: 'default'
}
resource stateContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2024-01-01' = {
  parent: saBlob
  name: stateContainerName
  properties: { publicAccess: 'None' }
}

@description('Existing Linux Y1 (Dynamic) plan resource id to REUSE instead of creating a new one. The admin RG Linux-consumption webspace hit "Requested features Dynamic SKU, Linux Worker not available in resource group" (ExtendedCode 59324) once it held 5 plans — Y1 plans host multiple Function apps, so reuse is both the workaround and the cheaper posture. Empty = create a dedicated plan (fresh RGs).')
param existingPlanId string = ''

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = if (empty(existingPlanId)) {
  name: planName
  location: location
  tags: programTags
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  kind: 'functionapp,linux'
  properties: {
    reserved: true
  }
}

var effectivePlanId = empty(existingPlanId) ? plan.id : existingPlanId

var baseAppSettings = [
  // Identity-based host storage — NO account key anywhere in app settings.
  { name: 'AzureWebJobsStorage__accountName', value: sa.name }
  { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }
  { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
  { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
  { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
  { name: 'SECRET_EXPIRY_CRON', value: secretExpiryCron }
  { name: 'LOOM_MSAL_CLIENT_ID', value: msalClientId }
  { name: 'LOOM_KEY_VAULT_URI', value: keyVaultUri }
  { name: 'LOOM_SECRET_EXPIRY_KV_SECRETS', value: trackedKvSecrets }
  { name: 'LOOM_SECRET_EXPIRY_WARN_DAYS', value: string(warnDays) }
  { name: 'LOOM_ALERT_ACTION_GROUP_ID', value: actionGroupId }
  { name: 'LOOM_GRAPH_BASE', value: graphBase }
  // Sovereign endpoints derived from the deployment environment.
  { name: 'LOOM_ARM_ENDPOINT', value: environment().resourceManager }
  { name: 'LOOM_STORAGE_SUFFIX', value: environment().suffixes.storage }
  { name: 'SECRET_EXPIRY_STATE_CONTAINER', value: stateContainerName }
  // Optional GitHub dedup issue (set via `az functionapp config appsettings set`
  // with a KV reference; leave unset in IL5 so alerting stays in-boundary).
  { name: 'LOOM_GITHUB_REPO_OWNER', value: 'fgarofalo56' }
  { name: 'LOOM_GITHUB_REPO_NAME', value: 'csa-inabox' }
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

// ── RBAC (declared here, skipRoleGrants-aware, guid() names) ────────────────

// Identity-based AzureWebJobsStorage requires Blob Data Owner on the host SA;
// the same grant covers the escalation-state blob.
resource saBlobOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants) {
  name: guid(sa.id, site.name, blobDataOwnerRoleId)
  scope: sa
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataOwnerRoleId)
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource saQueueContrib 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants) {
  name: guid(sa.id, site.name, queueDataContributorRoleId)
  scope: sa
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', queueDataContributorRoleId)
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Secret ATTRIBUTES read (exp/updated) — Key Vault Secrets User on the hub vault.
resource hubVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}
resource kvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants) {
  name: guid(hubVault.id, site.name, keyVaultSecretsUserRoleId)
  scope: hubVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Action-group read + createNotifications — Monitoring Contributor on THIS RG
// (the loom-default-alerts action group lives in the admin RG).
resource rgMonitoringContrib 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants && !empty(actionGroupId)) {
  name: guid(resourceGroup().id, site.name, monitoringContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', monitoringContributorRoleId)
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output siteId string = site.id
output siteName string = site.name
output defaultHostName string = site.properties.defaultHostName
@description('System-assigned identity principalId — used by the ONE-TIME Graph Application.Read.All admin consent (docs/fiab/runbooks/secret-rotation.md); every ARM role is already granted above.')
output principalId string = site.identity.principalId
