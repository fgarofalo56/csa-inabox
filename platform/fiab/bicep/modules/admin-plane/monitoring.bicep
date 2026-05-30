// CSA Loom — Admin Plane monitoring
// Log Analytics Workspace + Application Insights + Sentinel (Defender
// for Cloud AI Threat Protection workaround when boundary lacks
// native support).

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Defender for AI Threat Protection availability')
param defenderForAIEnabled bool

@description('Compliance tags')
param complianceTags object

@description('Daily LAW data cap in GB (0 = unlimited)')
param dailyCapGb int = 50

@description('LAW retention days')
@minValue(30)
@maxValue(730)
param retentionDays int = 90

@description('Console UAMI principalId — granted Log Analytics Reader so the /monitor Logs (KQL) tab can query this workspace. Empty string skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

// =====================================================================
// Log Analytics Workspace
// =====================================================================

resource law 'Microsoft.OperationalInsights/workspaces@2025-02-01' = {
  name: 'law-csa-loom-${location}'
  location: location
  tags: complianceTags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: retentionDays
    workspaceCapping: {
      dailyQuotaGb: dailyCapGb == 0 ? -1 : dailyCapGb
    }
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

// Sentinel solution onto the LAW
resource sentinel 'Microsoft.OperationsManagement/solutions@2015-11-01-preview' = {
  name: 'SecurityInsights(${law.name})'
  location: location
  tags: complianceTags
  plan: {
    name: 'SecurityInsights(${law.name})'
    publisher: 'Microsoft'
    product: 'OMSGallery/SecurityInsights'
    promotionCode: ''
  }
  properties: {
    workspaceResourceId: law.id
  }
}

// Onboard the workspace to Microsoft Sentinel via the MODERN OnboardingStates
// API. The legacy OperationsManagement 'SecurityInsights' solution above is no
// longer sufficient (especially in Azure Government): creating Sentinel content
// (alert rules, data connectors) fails with "Workspace is not onboarded to
// Microsoft Sentinel" unless the workspace has a SecurityInsights/onboardingStates
// 'default' resource first, and all Sentinel content dependsOn it.
resource sentinelOnboarding 'Microsoft.SecurityInsights/onboardingStates@2024-03-01' = {
  scope: law
  name: 'default'
  properties: {}
  dependsOn: [ sentinel ]
}

// =====================================================================
// Application Insights (workspace-based)
// =====================================================================

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'ai-csa-loom-${location}'
  location: location
  tags: complianceTags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: law.id
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Disabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

// =====================================================================
// Defender for AI workaround — Sentinel analytics rules (PRP-13)
// Only deploy when native Defender for AI Threat Protection unavailable.
// =====================================================================

resource sentinelAiPromptInjection 'Microsoft.SecurityInsights/alertRules@2024-09-01' = if (!defenderForAIEnabled) {
  scope: law
  name: 'csa-loom-ai-prompt-injection'
  kind: 'Scheduled'
  properties: {
    displayName: 'CSA Loom — AOAI prompt injection signal'
    description: 'Detects AOAI requests with known prompt-injection patterns. PRP-13 Sentinel workaround for boundaries without native Defender for AI.'
    severity: 'Medium'
    enabled: true
    query: '''
AppRequests
| where Name contains "openai" or Name contains "/chat/completions"
| extend prompt = tostring(Properties.prompt)
| where prompt has_any (
    "ignore previous instructions",
    "ignore the above",
    "disregard previous",
    "system: you are now",
    "DAN mode",
    "jailbreak",
    "###system",
    "<|im_start|>system"
  )
| project TimeGenerated, AppRoleName, OperationName, prompt, ResultCode, _ResourceId
'''
    queryFrequency: 'PT5M'
    queryPeriod: 'PT15M'
    triggerOperator: 'GreaterThan'
    triggerThreshold: 0
    suppressionEnabled: false
    suppressionDuration: 'PT1H'
    tactics: ['InitialAccess']
  }
  dependsOn: [ sentinelOnboarding ]
}

resource sentinelAiAbuseQuota 'Microsoft.SecurityInsights/alertRules@2024-09-01' = if (!defenderForAIEnabled) {
  scope: law
  name: 'csa-loom-ai-abuse-quota-spike'
  kind: 'Scheduled'
  properties: {
    displayName: 'CSA Loom — AOAI abuse / quota spike'
    description: 'Detects abnormal AOAI request volume from a single principal. PRP-13.'
    severity: 'Medium'
    enabled: true
    query: '''
AppRequests
| where Name contains "openai" or Name contains "/chat/completions"
| extend principal = tostring(Properties.user_oid)
| summarize requestCount = count() by principal, bin(TimeGenerated, 5m)
| where requestCount > 200
'''
    queryFrequency: 'PT5M'
    queryPeriod: 'PT10M'
    triggerOperator: 'GreaterThan'
    triggerThreshold: 0
    suppressionEnabled: false
    suppressionDuration: 'PT1H'
    tactics: ['Impact']
  }
  dependsOn: [ sentinelOnboarding ]
}

// =====================================================================
// /monitor observability — Console UAMI gets Log Analytics Reader on the
// LAW so the Logs (KQL) tab can run queries against it. (Monitoring Reader
// for metrics / activity log / resource health / alerts is granted at
// subscription scope outside this RG-scoped module.)
// =====================================================================

// Log Analytics Reader — 73c42c96-874c-492b-b04d-ab87d138a893
resource consoleLaReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  name: guid(law.id, consolePrincipalId, '73c42c96-874c-492b-b04d-ab87d138a893')
  scope: law
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '73c42c96-874c-492b-b04d-ab87d138a893')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// =====================================================================
// Diagnostic settings catalog (callers wire per-resource)
// =====================================================================

output lawId string = law.id
output lawName string = law.name
output lawCustomerId string = law.properties.customerId
@description('Primary shared key — required by Container Apps Env. Marked secure so it isn\'t logged.')
output lawSharedKey string = law.listKeys().primarySharedKey
output appInsightsId string = appInsights.id
output appInsightsConnectionString string = appInsights.properties.ConnectionString
output appInsightsInstrumentationKey string = appInsights.properties.InstrumentationKey
