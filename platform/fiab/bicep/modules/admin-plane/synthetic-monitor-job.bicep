// CSA Loom — V1 synthetic user-journey monitor (scheduled Container App Job).
//
// A `Microsoft.App/jobs` with a Schedule trigger (default every 15 minutes) in
// the console's VNet-integrated Container Apps Environment. Each execution runs
// `node e2e/run-synthetic.mjs` from the loom-uat image (the console image is
// slimmed — .dockerignore excludes e2e/ — so the UAT image, built by
// scripts/csa-loom/deploy-loom-uat-job.sh / Dockerfile.uat, is the one that
// carries the Playwright specs): six real end-to-end journeys against the LIVE
// deployment, two auth paths (minted-session + the TRUE MSAL login probe that
// catches the 2026-07-19 AADSTS7000215 class), gate-aware verdicts uploaded to
// Blob under uat-runs/synthetic/<runId>/ for the Health & Reliability hub's
// Journeys tab.
//
// The exit code is REAL-FAILURE-only (honest infra gates exit 0), so a Failed
// execution means a code or sign-in-path regression — the
// loom-synthetic-monitor.yml workflow lane adds GitHub-issue dedup + the
// shared action-group notification on top; the Schedule trigger here keeps
// the monitor running with zero GitHub dependency (the IL5-safe path).
//
// Wired into admin-plane/main.bicep via the R0 observabilityConfig bag
// (default-ON, opt-out) — never a new top-level param.
//
// Azure-native only (Container Apps Jobs). No Microsoft Fabric dependency.
//
// ── Rollback ───────────────────────────────────────────────────────────────
// Disable: set observabilityConfig.syntheticMonitorEnabled=false and redeploy
// (removes the job), or one-shot `az containerapp job stop` / delete the job —
// the console app is untouched. Artifacts in uat-runs/synthetic/* age out via
// the results container's lifecycle rule; no state migration either way.

targetScope = 'resourceGroup'

@description('Deployment region (e.g. centralus / usgovvirginia).')
param location string

@description('Container Apps managed-environment (CAE) resource id — the console VNet-integrated env.')
param environmentId string

@description('uami-loom-console resource id — ACR pull + managed-identity Azure calls (Blob results upload; the UAMI already holds Storage Blob Data Contributor on the DLZ account).')
param consoleUamiId string

@description('uami-loom-console clientId — targets the ACA managed-identity token fetch for the Blob upload (LOOM_UAMI_CLIENT_ID).')
param consoleUamiClientId string

@description('ACR login server, e.g. acrloomk6mvh5sm6z7do.azurecr.io.')
param acrLoginServer string

@description('Runner image. Default = the loom-uat image (carries the e2e specs; built by scripts/csa-loom/deploy-loom-uat-job.sh). The first scheduled execution fails honestly until that image is pushed — build it in the post-deploy app phase.')
param image string = '${acrLoginServer}/loom-uat:latest'

@description('Live console base URL the journeys probe (the Front Door / vanity URL).')
param loomUrl string

@description('Schedule cron for the journey runs. Default every 15 minutes.')
param cronExpression string = '*/15 * * * *'

@description('Key Vault secret URI for the console SESSION_SECRET (resolved by the console UAMI). Empty → sessionSecretValue is used.')
param sessionSecretKeyVaultSecretUri string = ''

@description('Literal SESSION_SECRET fallback (the console\'s stable per-RG value) when no KV-backed secret exists yet.')
@secure()
param sessionSecretValue string = ''

@description('Storage account name the runner uploads run artifacts to (LOOM_UAT_RESULTS_ACCOUNT). Empty disables upload (verdicts stay in container logs).')
param resultsAccount string = ''

@description('Blob container for run artifacts (LOOM_UAT_RESULTS_CONTAINER).')
param resultsContainer string = 'uat-results'

@description('UPN of the least-privilege synthetic automation account for the TRUE MSAL login probe (J1). Empty → J1 records an honest SKIP (minted-session journeys still run).')
param syntheticLoginUpn string = ''

@description('Key Vault secret URI holding the automation account password (kv-loom-*/synthetic-login-secret; resolved by the console UAMI). Empty → J1 skips honestly.')
param syntheticLoginSecretKeyVaultSecretUri string = ''

@description('ARM resource id of the shared default action group (monitoring-default-alerts.bicep) — the ONE derived alert var (LOOM_ALERT_ACTION_GROUP_ID).')
param alertActionGroupId string = ''

@description('Object id baked into the minted automation session (LOOM_AUTOMATION_OID). Empty → the runner\'s sentinel automation oid.')
param automationOid string = ''

@description('Max seconds one journey run may take before the execution is terminated. 20 min — well under the 15-min cadence x2.')
param replicaTimeout int = 1200

@description('Compliance/cost tags.')
param complianceTags object = {}

var loginProbeWired = !empty(syntheticLoginUpn) && !empty(syntheticLoginSecretKeyVaultSecretUri)

var sessionSecret = empty(sessionSecretKeyVaultSecretUri)
  ? [
      {
        name: 'session-secret'
        value: sessionSecretValue
      }
    ]
  : [
      {
        name: 'session-secret'
        keyVaultUrl: sessionSecretKeyVaultSecretUri
        identity: consoleUamiId
      }
    ]

var syntheticLoginSecret = loginProbeWired
  ? [
      {
        name: 'synthetic-login-secret'
        keyVaultUrl: syntheticLoginSecretKeyVaultSecretUri
        identity: consoleUamiId
      }
    ]
  : []

// COST0 tag convention: every loom-next-level program resource carries the
// `loom-next-level` tag so program-budget.bicep's tag-filtered Consumption
// budget bounds the program's aggregate run-rate (V1 is a ~$30-60/mo/cloud
// always-on item — see program-budget.README.md).
var programTags = union(complianceTags, { 'loom-next-level': 'true' })

// Pinned to the same Container Apps api-version the sibling ACA job modules use
// (gh-runner-job.bicep) — bicep/runtime sync.
resource syntheticMonitorJob 'Microsoft.App/jobs@2025-02-02-preview' = {
  name: 'loom-synthetic-monitor'
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
      replicaRetryLimit: 0
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
      secrets: concat(sessionSecret, syntheticLoginSecret)
    }
    template: {
      containers: [
        {
          name: 'synthetic'
          image: image
          command: [ 'node', 'e2e/run-synthetic.mjs' ]
          resources: {
            cpu: json('2.0')
            memory: '4.0Gi'
          }
          env: concat(
            [
              { name: 'LOOM_URL', value: loomUrl }
              { name: 'SESSION_SECRET', secretRef: 'session-secret' }
              { name: 'LOOM_UAT_RESULTS_ACCOUNT', value: resultsAccount }
              { name: 'LOOM_UAT_RESULTS_CONTAINER', value: resultsContainer }
              { name: 'LOOM_UAMI_CLIENT_ID', value: consoleUamiClientId }
              { name: 'LOOM_ALERT_ACTION_GROUP_ID', value: alertActionGroupId }
              { name: 'LOOM_AUTOMATION_UPN', value: 'loom-synthetic@automation.local' }
              { name: 'LOOM_AUTOMATION_NAME', value: 'Loom Synthetic Monitor [automation]' }
            ],
            !empty(automationOid) ? [
              { name: 'LOOM_AUTOMATION_OID', value: automationOid }
            ] : [],
            loginProbeWired ? [
              { name: 'SYNTHETIC_LOGIN_UPN', value: syntheticLoginUpn }
              { name: 'SYNTHETIC_LOGIN_SECRET', secretRef: 'synthetic-login-secret' }
            ] : []
          )
        }
      ]
    }
  }
}

@description('The synthetic-monitor Job resource id.')
output jobId string = syntheticMonitorJob.id

@description('The synthetic-monitor Job name.')
output jobName string = syntheticMonitorJob.name
