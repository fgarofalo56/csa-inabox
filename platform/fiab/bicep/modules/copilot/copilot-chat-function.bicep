// CSA Loom — docs-site Copilot chat Function App (#3429, fix item 3).
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// `func-csa-inabox-copilot-fg` is the PRODUCTION chat backend for the docs
// site. Until this module it existed ONLY because somebody once ran the
// `az functionapp create` block in azure-functions/copilot-chat/DEPLOYMENT.md
// by hand. Measured 2026-08-17, before this file landed:
//
//     $ grep -rlE "copilot-fg|csa-inabox-copilot" --include=*.bicep \
//         --include=*.bicepparam platform/ scripts/
//     (no output)
//     $ grep -rn "Microsoft.Web/sites@" --include=*.bicep . | grep -c existing
//     1                       <- and that ONE is copilot-chat/deploy/main.bicep
//
// i.e. the only bicep in the tree that named this app declared it `existing`.
// A consumer with no producer. The sibling module
// `azure-functions/copilot-chat/deploy/main.bicep` says so in its own header:
// "What this Bicep does NOT do: Create / modify the Function App."
//
// That is an `auto-bind-by-default.md` §5 violation — "Infra prerequisites are
// DEPLOYED, not requested" — and it is why `deploy-copilot-function.yml` has no
// recovery path when the app is not reachable: there was nothing to deploy.
//
// ── RELATIONSHIP TO THE COSMOS MODULE ───────────────────────────────────────
//
// This module deliberately does NOT create Cosmos. `azure-functions/
// copilot-chat/deploy/main.bicep` already owns the Cosmos account, its database,
// its three containers and the sqlRoleAssignment binding this app's identity to
// Cosmos DB Built-in Data Contributor. Duplicating it here would produce two
// templates fighting over one account. Order for a from-scratch estate:
//
//   1. THIS module                 -> Function App exists + has an identity
//   2. copilot-chat/deploy/main.bicep -> Cosmos + the data-plane role for it
//   3. this module again, with `cosmosEndpoint` set -> COSMOS_ENDPOINT wired
//
// ── WHAT AUTOMATION ACTUALLY REACHES, AND WHAT IT DOES NOT ──────────────────
//
// Steps 1 and 2 are reachable from CI: deploy-copilot-function.yml applies THIS
// module on the `absent-here` preflight verdict, and main.bicep is applied by
// its own documented path. STEP 3 IS NOT. That lane's apply is gated on the app
// being ABSENT, so once the app exists it never re-applies — which is exactly
// when step 3 would matter. An earlier draft of this header called step 3 "a
// no-op re-apply … what makes the binding self-healing per
// auto-bind-by-default.md §3". That was false: nothing invokes it, so the
// binding is NOT self-healing today and this header is not going to claim it is.
//
// The gate is the right call, not an oversight. `siteConfig.appSettings` below
// is declared IN FULL, so a re-apply removes every setting it does not name —
// including WEBSITE_RUN_FROM_PACKAGE, which Azure/functions-action sets on each
// code deploy and which the running host needs to start. An automatic re-apply
// would take production down to reconcile configuration.
//
// So step 3 is a DOCUMENTED OPERATOR STEP (azure-functions/copilot-chat/
// DEPLOYMENT.md, "Reconciling an existing app"), the lane announces on every
// `found` run that it applied no infrastructure, and closing the gap properly —
// a reconcile that preserves out-of-band settings, so §3 self-healing is real
// rather than asserted — is tracked in #3429 rather than implied here.
//
// ── CLOUD PARITY (cloud-parity.md) ──────────────────────────────────────────
//
// No cloud-specific hostname is written into this file. The storage endpoint
// suffix comes from `environment().suffixes.storage`, so the AzureWebJobsStorage
// connection string is correct in Commercial, GCC, GCC-High and IL5 without a
// per-cloud branch. Every service ENDPOINT (Azure OpenAI, Cosmos, Content
// Safety) is a PARAMETER, so a sovereign caller passes its own boundary's host
// rather than inheriting a `.azure.com` literal — the shape
// check-cloud-endpoint-literals.mjs exists to enforce.
//
// Content Safety is the one genuine per-cloud difference and it is handled by
// absence, not by a branch: the service is offered in Commercial, GCC and
// GCC-High (USGovArizona / USGovVirginia) and NOT in the DoD regions. Leave
// `contentSafetyEndpoint` empty there; the setting is then omitted and
// content_safety.py honest-gates (its `_CONTENT_SAFETY_ENDPOINT` is read with a
// default and every call site checks it). No cloud gets a broken app; the DoD
// boundary gets the regex injection guard without harm/jailbreak moderation,
// which is the documented behaviour in DEPLOYMENT.md.
//
// NOT VERIFIED AGAINST A LIVE SOVEREIGN DEPLOY. This module compiles for every
// boundary and hard-codes no Commercial host, but per cloud-parity.md §4 a
// receipt is per-cloud and comes from a GitHub Actions run. At time of writing
// it has been applied to NEITHER cloud — see the workflow header.
//
// ── SECRETS ─────────────────────────────────────────────────────────────────
//
// AZURE_OPENAI_KEY is deliberately NOT settable here. function_app.py
// `_make_openai_client()` is "MI-first, key-fallback": it uses the key only when
// AZURE_OPENAI_KEY is present, otherwise it calls
// `get_bearer_token_provider(cred, ".../.default")`. Leaving the setting unset
// takes the managed-identity path, which is SEC-COPILOT H-3 ("OpenAI key still
// in app settings — replace with azure_ad_token_provider"). The role assignment
// below is what makes that path work, so this module retires the key rather
// than templating it.
//
// Grounded in Microsoft Learn:
//   Functions infrastructure as code (serverfarms Y1/Dynamic, Microsoft.Web/sites)
//   https://learn.microsoft.com/azure/azure-functions/functions-infrastructure-as-code
//   App settings reference (AzureWebJobsStorage, FUNCTIONS_*)
//   https://learn.microsoft.com/azure/azure-functions/functions-app-settings

targetScope = 'resourceGroup'

// ── Identity of the app ─────────────────────────────────────────────────────

@description('Function App name. MUST match FUNCTION_APP_NAME in .github/workflows/deploy-copilot-function.yml — check-function-app-producer-coverage.mjs fails the build when the two drift.')
@minLength(2)
@maxLength(60)
param functionAppName string = 'func-csa-inabox-copilot-fg'

@description('Region for the plan + app. The production instance is eastus; its Cosmos is eastus2 (eastus had AZ-redundant capacity issues on 2026-05-06).')
param location string = resourceGroup().location

@description('Tags applied to every resource this module creates.')
param tags object = {}

// ── Backing storage (brownfield: reuse; greenfield: create) ─────────────────

@description('Storage account backing the Functions host. The production estate REUSES `aimldatastore` because its subscription policy blocks new shared-key storage accounts; a from-scratch estate creates its own. The deploy workflow discovers which case applies and sets createStorageAccount accordingly (deploy-integrity.md R5 — discover, never assume).')
@minLength(3)
@maxLength(24)
param storageAccountName string

@description('Create the storage account, or bind to one that already exists in this resource group.')
param createStorageAccount bool = true

// ── Telemetry ───────────────────────────────────────────────────────────────

@description('Application Insights connection string. Empty leaves APPLICATIONINSIGHTS_CONNECTION_STRING unset, which telemetry.py already treats as "telemetry off" rather than an error. Supply the existing appi-csa-inabox-copilot-fg value on the production estate; a from-scratch estate sets createAppInsights=true and this is ignored.')
param appInsightsConnectionString string = ''

@description('Create a workspace-based Application Insights component (and its Log Analytics workspace) instead of consuming appInsightsConnectionString.')
param createAppInsights bool = false

@description('Name for the Application Insights component when createAppInsights is true.')
param appInsightsName string = 'appi-${functionAppName}'

// ── Chat backend wiring ─────────────────────────────────────────────────────

@description('Azure OpenAI endpoint, e.g. https://<account>.cognitiveservices.<boundary-suffix>/ . Required: function_app.py reads AZURE_OPENAI_ENDPOINT with os.environ[...] and raises KeyError without it.')
param azureOpenAiEndpoint string

@description('Azure OpenAI model deployment name.')
param azureOpenAiDeployment string = 'gpt-5.4-nano'

@description('Azure OpenAI data-plane API version. Matches function_app.py\'s own default.')
param azureOpenAiApiVersion string = '2025-04-01-preview'

@description('Name of the Azure OpenAI / AI Services account IN THIS RESOURCE GROUP to grant the app identity Cognitive Services OpenAI User on. Empty skips the grant, and the app then needs AZURE_OPENAI_KEY supplied out-of-band — which is the state SEC-COPILOT H-3 exists to end, so leaving it empty is a documented downgrade, not the intended path.')
param azureOpenAiAccountName string = ''

@description('Origins allowed to call the chat API. Written to BOTH the platform CORS allow-list and the ALLOWED_ORIGINS app setting the function itself enforces.')
param allowedOrigins array = [
  'https://fgarofalo56.github.io'
  'http://localhost:8000'
  'http://localhost:8080'
  'http://127.0.0.1:8080'
]

// ── Analytics (Cosmos is owned by copilot-chat/deploy/main.bicep) ───────────

@description('Cosmos endpoint for the analytics pipeline. Empty leaves COSMOS_ENDPOINT unset; storage.py then no-ops the analytics writes and the chat path stays healthy (documented in DEPLOYMENT.md).')
param cosmosEndpoint string = ''

@description('Cosmos database id holding conversations / feedback / backlog.')
param cosmosDatabase string = 'copilot'

@description('Salt for the per-IP hash in the rate limiter. Left empty the function falls back to its in-code default, which is public in the repo — supply a generated value on any estate that matters.')
@secure()
param ipHashSalt string = ''

// ── Moderation + grounding ──────────────────────────────────────────────────

@description('Azure AI Content Safety endpoint. EMPTY IS A SUPPORTED STATE and is the correct value in the DoD regions where Content Safety is not offered; content_safety.py honest-gates rather than silently claiming to filter.')
param contentSafetyEndpoint string = ''

@description('Name of the Content Safety account IN THIS RESOURCE GROUP to grant the app identity Cognitive Services User on. Empty skips the grant.')
param contentSafetyAccountName string = ''

@description('Enable the Microsoft Learn MCP fallback grounding (CSA-0162 Phase 2).')
param msLearnEnabled bool = true

@description('Microsoft Learn MCP endpoint used for fallback grounding.')
param msLearnMcpUrl string = 'https://learn.microsoft.com/api/mcp'

@description('Boundary label surfaced in the chat response envelope.')
@allowed([
  'Commercial'
  'GCC'
  'GCC-High'
  'IL5'
])
param boundary string = 'Commercial'

// ── Storage ─────────────────────────────────────────────────────────────────

resource newStorage 'Microsoft.Storage/storageAccounts@2024-01-01' = if (createStorageAccount) {
  name: storageAccountName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

// listKeys() on the resourceId works for BOTH the created and the reused
// account, which is why the connection string is not read off `newStorage`
// directly — that symbol does not exist when createStorageAccount is false.
// `dependsOn` below supplies the ordering the indirection loses.
var storageId = resourceId('Microsoft.Storage/storageAccounts', storageAccountName)
var storageSuffix = environment().suffixes.storage
var storageConnectionString = 'DefaultEndpointsProtocol=https;AccountName=${storageAccountName};EndpointSuffix=${storageSuffix};AccountKey=${listKeys(storageId, '2024-01-01').keys[0].value}'

// ── Application Insights (optional, workspace-based) ────────────────────────

resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' = if (createAppInsights) {
  // take(): functionAppName is bounded at 60 and a workspace name at 63, so the
  // naive interpolation can be one character too long. Bicep flags it as BCP335;
  // ARM would fail the deployment.
  name: take('log-${functionAppName}', 60)
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = if (createAppInsights) {
  name: appInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: law.id
  }
}

// `.?` (safe dereference), NOT `createAppInsights ? appInsights.properties… : …`.
//
// The mechanism, MEASURED by compiling both forms rather than asserted — an
// earlier draft of this comment blamed "an ARM `if()` does not reliably avoid
// evaluating the untaken branch", which the compiled template refutes, because
// the accepted form emits the SAME `if()`:
//
//   ternary -> if(parameters('createAppInsights'),
//                 reference(resourceId(...), '2020-02-02').ConnectionString,
//                 parameters('appInsightsConnectionString'))
//   this    -> coalesce(tryGet(if(parameters('createAppInsights'),
//                 reference(resourceId(...), '2020-02-02', 'full'), null()),
//                 'properties', 'ConnectionString'),
//                 parameters('appInsightsConnectionString'))
//
// The difference is the ACCESS, not the branch. `appInsights` is a CONDITIONAL
// resource, so its symbol is typed `Microsoft.Insights/components | null` and a
// direct `.properties` on it earns BCP318 in bicep's own words: "The value of
// type "Microsoft.Insights/components | null" may be null at the start of the
// deployment, which would cause this access expression (and the overall
// deployment with it) to fail." `.?` compiles to `tryGet`, whose untaken branch
// yields `null()` and which returns null instead of failing on it.
//
// The failing path would be exactly the one the production estate uses: reuse
// the existing appi-csa-inabox-copilot-fg, create nothing.
var effectiveAppInsightsConnectionString = appInsights.?properties.ConnectionString ?? appInsightsConnectionString

// ── Hosting plan (Linux Consumption, matching the live app) ─────────────────

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  // take(): see the workspace above — `plan-` + a 60-char app name overruns the
  // 63-char serverfarms limit.
  name: take('plan-${functionAppName}', 40)
  location: location
  tags: tags
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  kind: 'functionapp,linux'
  properties: {
    reserved: true
  }
}

// ── App settings ────────────────────────────────────────────────────────────
//
// Built as a concat of one REQUIRED block plus per-capability blocks that are
// omitted when their input is empty. An empty setting is NOT the same as an
// absent one for this codebase: storage.py, telemetry.py and content_safety.py
// all branch on truthiness, so writing an empty string would work by accident;
// omitting the key is what the code's own honest-gate documentation describes.

var requiredSettings = [
  {
    name: 'AzureWebJobsStorage'
    value: storageConnectionString
  }
  {
    name: 'FUNCTIONS_EXTENSION_VERSION'
    value: '~4'
  }
  {
    name: 'FUNCTIONS_WORKER_RUNTIME'
    value: 'python'
  }
  {
    // The CI lane pre-installs into .python_packages/ and deploys with
    // scm-do-build-during-deployment:false + enable-oryx-build:false. These two
    // settings keep the app's own configuration saying the same thing, so a
    // portal-triggered sync does not start a remote build the package layout
    // does not expect.
    name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
    value: 'false'
  }
  {
    name: 'ENABLE_ORYX_BUILD'
    value: 'false'
  }
  {
    name: 'AZURE_OPENAI_ENDPOINT'
    value: azureOpenAiEndpoint
  }
  {
    name: 'AZURE_OPENAI_DEPLOYMENT'
    value: azureOpenAiDeployment
  }
  {
    name: 'AZURE_OPENAI_API_VERSION'
    value: azureOpenAiApiVersion
  }
  {
    name: 'ALLOWED_ORIGINS'
    value: join(allowedOrigins, ',')
  }
  {
    name: 'COPILOT_MS_LEARN_ENABLED'
    value: msLearnEnabled ? 'true' : 'false'
  }
  {
    name: 'COPILOT_MS_LEARN_MCP_URL'
    value: msLearnMcpUrl
  }
  {
    name: 'CSA_LOOM_BOUNDARY'
    value: boundary
  }
]

var telemetrySettings = empty(effectiveAppInsightsConnectionString) ? [] : [
  {
    name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
    value: effectiveAppInsightsConnectionString
  }
]

var cosmosSettings = empty(cosmosEndpoint) ? [] : [
  {
    name: 'COSMOS_ENDPOINT'
    value: cosmosEndpoint
  }
  {
    name: 'COSMOS_DATABASE'
    value: cosmosDatabase
  }
]

var saltSettings = empty(ipHashSalt) ? [] : [
  {
    name: 'COPILOT_IP_HASH_SALT'
    value: ipHashSalt
  }
]

var contentSafetySettings = empty(contentSafetyEndpoint) ? [] : [
  {
    name: 'CONTENT_SAFETY_ENDPOINT'
    value: contentSafetyEndpoint
  }
]

// ── The Function App ────────────────────────────────────────────────────────

resource site 'Microsoft.Web/sites@2024-04-01' = {
  name: functionAppName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    // The hardening block from DEPLOYMENT.md "Hardening applied at provisioning
    // time", which until now lived only in that prose + a hand-run az command.
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'Python|3.12'
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      cors: {
        allowedOrigins: allowedOrigins
        supportCredentials: false
      }
      appSettings: concat(
        requiredSettings,
        telemetrySettings,
        cosmosSettings,
        saltSettings,
        contentSafetySettings
      )
    }
  }
  dependsOn: [
    newStorage
  ]
}

// ── RBAC — the managed-identity path the code already prefers ───────────────

// Cognitive Services OpenAI User. Established in-repo at
// csa-loom-post-deploy-bootstrap.yml:1593 and deploy/bicep/shared/modules/
// aifoundry.bicep:230.
var roleCognitiveServicesOpenAiUser = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
// Cognitive Services User — the role DEPLOYMENT.md already names for Content
// Safety token auth.
var roleCognitiveServicesUser = 'a97b65f3-24c7-4388-baec-2e87135dc908'

resource aoaiAccount 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = if (!empty(azureOpenAiAccountName)) {
  name: azureOpenAiAccountName
}

resource contentSafetyAccount 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = if (!empty(contentSafetyAccountName)) {
  name: contentSafetyAccountName
}

// Names are deterministic `guid(...)` seeds, NOT newGuid(): ARM enforces
// uniqueness on the (scope, principalId, roleDefinitionId) triple, so a rotating
// name produces RoleAssignmentExists on every reconcile of an estate that
// already carries the grant (check-role-assignment-determinism.mjs, #3039).
resource aoaiGrant 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(azureOpenAiAccountName)) {
  scope: aoaiAccount
  name: guid(aoaiAccount.id, site.id, roleCognitiveServicesOpenAiUser)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleCognitiveServicesOpenAiUser)
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource contentSafetyGrant 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(contentSafetyAccountName)) {
  scope: contentSafetyAccount
  name: guid(contentSafetyAccount.id, site.id, roleCognitiveServicesUser)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleCognitiveServicesUser)
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── Outputs ─────────────────────────────────────────────────────────────────

output functionAppName string = site.name
output functionAppId string = site.id
output defaultHostName string = site.properties.defaultHostName
@description('System-assigned identity principalId. Feed this to azure-functions/copilot-chat/deploy/main.bicep so the Cosmos sqlRoleAssignment binds the same identity.')
output principalId string = site.identity.principalId
