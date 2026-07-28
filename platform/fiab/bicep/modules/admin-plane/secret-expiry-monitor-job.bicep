// CSA Loom — S1 secret-expiry monitor (scheduled Container App Job).
//
// A `Microsoft.App/jobs` with a Schedule trigger (default daily 06:00 UTC) in
// the console's VNet-integrated Container Apps Environment. Each execution runs
// `node dist/src/main.js` from the loom-secret-expiry-monitor image (built by
// scripts/csa-loom/deploy-secret-expiry-job.sh /
// azure-functions/secret-expiry-monitor/Dockerfile): it inventories the Console
// MSAL app registration's passwordCredentials[] via Microsoft Graph, reads
// attributes.exp / attributes.updated for every tracked Key Vault secret
// (loom-msal-client-secret, synthetic-login-secret, …), computes days-to-expiry
// + the 60/30/7-day bands, detects MSAL KV drift, and on band ESCALATION fires
// the shared loom-default-alerts action group (LOOM_ALERT_ACTION_GROUP_ID, the
// O1 alert convention) + an optional dedup GitHub issue. Prevention for the
// 2026-07-19 expired/drifted-MSAL-secret total sign-in outage, which recurs on
// a 2-year clock (entra-app-registration.bicep mints the secret --years 2).
//
// ── WHY AN ACA JOB, NOT A Y1 FUNCTION (B-FN, operator decision 2026-07-23) ──
// Y1 Linux Consumption Functions are structurally broken on this estate: Azure
// Policy seals the storage data-plane (publicNetworkAccess=Disabled, AAD-only,
// no private endpoint) and the multitenant Y1 runtime is not a trusted service,
// so host keys / timer leases fail. ALL scheduled/background compute uses the
// in-VNet ACA-job pattern (this module mirrors lineage-extractor-job.bicep and
// cost-anomaly-monitor-job.bicep, proven live by loom-uat / gh-aca-runner).
// This module REPLACES secret-expiry-monitor-function.bicep, which is deleted.
//
// ── IDENTITY (what changed, and why it is simpler) ─────────────────────────
// The job runs as the CONSOLE UAMI, not a per-Function system identity. That
// deletes three moving parts:
//   • no host storage account, so no Storage Blob Data Owner / Queue
//     Contributor grants and no sealed-storage trusted-service dependency;
//   • Key Vault Secrets User + Monitoring Contributor are granted here to the
//     SAME principal the Console already uses (guid() names, skipRoleGrants-
//     aware) — idempotent with the Console's existing grants;
//   • the one-time Graph app role Application.Read.All is now needed on the
//     CONSOLE UAMI, which is exactly what
//     scripts/csa-loom/grant-identity-graph-approles.sh already grants for the
//     Identity Picker. Estates that ran that script have ZERO new operator
//     actions for S1 (previously a separate consent on the Function identity).
// Escalation-dedup state moved from the Function's own storage account to the
// `ops-state` container on the Loom lake account (landing-zone/storage.bicep) —
// the same account + identity the synthetic/UAT runners already write to.
//
// Azure-native only (Container Apps Jobs + Microsoft Graph + Key Vault + Action
// Groups). No Microsoft Fabric dependency (.claude/rules/no-fabric-dependency.md).
//
// Wired into admin-plane/main.bicep via the R0 functionAppsConfig bag
// (secretExpiryEnabled, default-ON, opt-out) — never a new top-level param.
//
// ── Rollback ───────────────────────────────────────────────────────────────
// Disable: set functionAppsConfig.secretExpiryEnabled=false and redeploy
// (removes the job), or one-shot `az containerapp job stop --name
// loom-secret-expiry-monitor` — the console app is untouched and /admin/health
// keeps reading Graph + Key Vault live (that surface is independent of this
// job). The dedup-state blob is inert without the job; no state migration
// either way. Roll the image back with `az containerapp job update --image
// <prev-tag>` via scripts/csa-loom/deploy-secret-expiry-job.sh.
//
// Grounded in Microsoft Learn:
//   Container Apps jobs (Schedule trigger, cron is 5-field UTC)
//   https://learn.microsoft.com/azure/container-apps/jobs
//   Action Groups createNotifications
//   https://learn.microsoft.com/rest/api/monitor/action-groups/create-notifications-at-action-group-resource-level

targetScope = 'resourceGroup'

@description('Deployment region (e.g. centralus / usgovvirginia).')
param location string

@description('Container Apps managed-environment (CAE) resource id — the console VNet-integrated env.')
param environmentId string

@description('uami-loom-console resource id — ACR pull + the identity the job runs as.')
param consoleUamiId string

@description('uami-loom-console clientId (AZURE_CLIENT_ID / LOOM_UAMI_CLIENT_ID).')
param consoleUamiClientId string

@description('uami-loom-console principalId — the grantee for the Key Vault + Monitoring role assignments below. Empty skips the grants.')
param consoleUamiPrincipalId string = ''

@description('ACR login server, e.g. acrloomk6mvh5sm6z7do.azurecr.io.')
param acrLoginServer string

@description('Monitor image. Default = loom-secret-expiry-monitor:latest (built by scripts/csa-loom/deploy-secret-expiry-job.sh). The first scheduled execution fails honestly until that image is pushed — build it in the post-deploy app phase.')
param image string = '${acrLoginServer}/loom-secret-expiry-monitor:latest'

@description('Console MSAL app (client) id whose passwordCredentials are inventoried via Graph. Empty → the Graph half honest-gates (the Key Vault inventory still runs).')
param msalClientId string = ''

@description('Hub Key Vault NAME (same RG) — the console UAMI is granted Key Vault Secrets User on it here.')
param keyVaultName string

@description('Hub Key Vault data-plane URI (https://<vault>.vault.<suffix>/).')
param keyVaultUri string

@description('Comma-separated tracked KV secret NAMES (attributes-only reads). Not secret material — a list of identifiers, hence the lint suppression.')
#disable-next-line secure-secrets-in-params
param trackedKvSecrets string = 'loom-msal-client-secret,synthetic-login-secret'

@description('Days-to-expiry OUTER warning threshold (LOOM_SECRET_EXPIRY_WARN_DAYS). Inner 30/7-day bands are fixed.')
param warnDays int = 60

@description('Schedule cron — STANDARD 5-FIELD, UTC (Container Apps jobs, not the 6-field NCRONTAB the retired Y1 Function used). Default daily 06:00 UTC; expiry is a slow clock and escalation dedup makes a finer cadence safe but pointless. Not secret material — a cron string, hence the lint suppression.')
#disable-next-line secure-secrets-in-params
param cronExpression string = '0 6 * * *'

@description('ARM id of the shared loom-default-alerts action group (monitoring-default-alerts.bicep::defaultActionGroup — the O1 alert convention). Empty → alerts are logged only (honest gate).')
param actionGroupId string = ''

@description('Sovereign Graph base (https://graph.microsoft.com | graph.microsoft.us | dod-graph.microsoft.us).')
param graphBase string = 'https://graph.microsoft.com'

@description('Storage account holding the escalation-dedup state blob (the Loom lake account; its ops-state container is created by landing-zone/storage.bicep). Empty → the job logs an honest warning and runs WITHOUT dedup (every non-ok band re-alerts each tick).')
param opsStateAccount string = ''

@description('Blob container for the dedup-state doc on that account.')
param opsStateContainer string = 'ops-state'

@description('Key Vault secret URI holding an optional GitHub PAT for the dedup issue-per-credential. Empty → the GitHub half is skipped (the action-group alert still fires). Leave EMPTY in IL5 so alerting stays in-boundary.')
param githubTokenSecretUri string = ''

@description('Max seconds one monitor pass may take before the execution is terminated. 10 min.')
param replicaTimeout int = 600

@description('Skip RBAC role assignments (reconcile passes on estates where grants already exist).')
param skipRoleGrants bool = false

@description('Compliance/cost tags.')
param complianceTags object = {}

// COST0 tag convention: every loom-next-level program resource carries the
// `loom-next-level` tag so program-budget.bicep's tag-filtered Consumption
// budget bounds the program's aggregate run-rate. Scale-to-zero scheduled job:
// ~$0/mo idle, a few cents/mo of vCPU-seconds per daily pass.
var programTags = union(complianceTags, { 'loom-next-level': 'true' })

// Built-in role definition ids (built-in GUIDs are identical in all clouds).
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6' // Key Vault Secrets User
var monitoringContributorRoleId = '749f88d5-cbae-40b8-bcfc-e573ddc772fa' // Monitoring Contributor

// Optional KV-backed GitHub PAT — a Container Apps secret resolved through the
// job's user-assigned identity (keyVaultUrl + identity), never a literal.
var githubSecret = empty(githubTokenSecretUri)
  ? []
  : [
      {
        name: 'secret-expiry-github-token'
        keyVaultUrl: githubTokenSecretUri
        identity: consoleUamiId
      }
    ]

// Pinned to the same Container Apps api-version the sibling ACA job modules use
// (cost-anomaly-monitor-job.bicep / lineage-extractor-job.bicep) — bicep/runtime sync.
resource secretExpiryJob 'Microsoft.App/jobs@2025-02-02-preview' = {
  name: 'loom-secret-expiry-monitor'
  location: location
  tags: programTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${consoleUamiId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: replicaTimeout
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: cronExpression
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acrLoginServer
          identity: consoleUamiId
        }
      ]
      secrets: githubSecret
    }
    template: {
      containers: [
        {
          name: 'secret-expiry'
          image: image
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          env: concat(
            [
              { name: 'AZURE_CLIENT_ID', value: consoleUamiClientId }
              { name: 'LOOM_UAMI_CLIENT_ID', value: consoleUamiClientId }
              { name: 'LOOM_MSAL_CLIENT_ID', value: msalClientId }
              { name: 'LOOM_KEY_VAULT_URI', value: keyVaultUri }
              { name: 'LOOM_SECRET_EXPIRY_KV_SECRETS', value: trackedKvSecrets }
              { name: 'LOOM_SECRET_EXPIRY_WARN_DAYS', value: string(warnDays) }
              { name: 'LOOM_ALERT_ACTION_GROUP_ID', value: actionGroupId }
              { name: 'LOOM_GRAPH_BASE', value: graphBase }
              { name: 'SECRET_EXPIRY_CRON', value: cronExpression }
              // Sovereign endpoints derived from the deployment environment.
              { name: 'LOOM_ARM_ENDPOINT', value: environment().resourceManager }
              { name: 'LOOM_STORAGE_SUFFIX', value: environment().suffixes.storage }
              { name: 'LOOM_OPS_STATE_ACCOUNT', value: opsStateAccount }
              { name: 'LOOM_OPS_STATE_CONTAINER', value: opsStateContainer }
              { name: 'LOOM_GITHUB_REPO_OWNER', value: 'fgarofalo56' }
              { name: 'LOOM_GITHUB_REPO_NAME', value: 'csa-inabox' }
            ],
            empty(githubTokenSecretUri) ? [] : [
              { name: 'LOOM_SECRET_EXPIRY_GITHUB_TOKEN', secretRef: 'secret-expiry-github-token' }
            ]
          )
        }
      ]
    }
  }
}

// ── RBAC (declared here, skipRoleGrants-aware, guid() names) ────────────────
// Both grants target the CONSOLE UAMI (the identity the job runs as). They are
// idempotent with the Console's own grants — a duplicate assignment for the
// same principal+role+scope resolves to the same guid() name.

// Secret ATTRIBUTES read (exp / updated) — Key Vault Secrets User on the hub vault.
resource hubVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}
resource kvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants && !empty(consoleUamiPrincipalId)) {
  name: guid(hubVault.id, consoleUamiPrincipalId, keyVaultSecretsUserRoleId)
  scope: hubVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: consoleUamiPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Action-group read + createNotifications — Monitoring Contributor on THIS RG
// (the loom-default-alerts action group lives in the admin RG).
resource rgMonitoringContrib 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants && !empty(consoleUamiPrincipalId) && !empty(actionGroupId)) {
  name: guid(resourceGroup().id, consoleUamiPrincipalId, monitoringContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', monitoringContributorRoleId)
    principalId: consoleUamiPrincipalId
    principalType: 'ServicePrincipal'
  }
}

@description('The secret-expiry-monitor Job resource id.')
output jobId string = secretExpiryJob.id

@description('The secret-expiry-monitor Job name.')
output jobName string = secretExpiryJob.name
