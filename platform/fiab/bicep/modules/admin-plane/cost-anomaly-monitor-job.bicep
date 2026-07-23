// CSA Loom — C3 cost-anomaly monitor (scheduled Container App Job).
//
// A `Microsoft.App/jobs` with a Schedule trigger (default daily 06:00 UTC) in
// the console's VNet-integrated Container Apps Environment. Each execution runs
// `node e2e/run-cost-anomaly.mjs` from the loom-uat image (the console image is
// slimmed — .dockerignore excludes e2e/ — so the UAT image is the runner that
// carries the thin entrypoint): the entrypoint POSTs the in-VNet console's
// /api/internal/cost-anomaly/run with the shared internal token, and the
// console process runs the REAL Cost Management pull + the shared
// cost-anomaly-core detector + the loom-notifications writes + the shared
// action-group alert dispatch (lib/azure/alert-dispatch.ts, O1).
//
// ── Estate constraint (2026-07-23) ─────────────────────────────────────────
// Y1 Linux Consumption Functions are structurally broken on this estate (policy
// seals storage data-planes; the multitenant Y1 runtime is not a trusted
// service, so host keys / timer leases fail). ANY new scheduled/background
// compute uses the IN-VNET ACA JOB pattern instead — this module mirrors
// synthetic-monitor-job.bicep, the proven precedent. There is NO
// cost-anomaly Function.
//
// Wired into admin-plane/main.bicep via the R0 observabilityConfig bag
// (default-ON, opt-out) — never a new top-level param.
//
// Azure-native only (Container Apps Jobs + Cost Management + Cosmos + Action
// Groups). No Microsoft Fabric dependency (.claude/rules/no-fabric-dependency.md).
//
// ── Rollback ───────────────────────────────────────────────────────────────
// Disable: set observabilityConfig.costAnomalyEnabled=false and redeploy
// (removes the job), or one-shot `az containerapp job stop` / delete the job —
// the console app is untouched. The seeded loom-cost-anomaly-rules docs are
// inert without the job; no state migration either way. Last-known-good runner:
// the loom-uat image tag (rebuild via scripts/csa-loom/deploy-loom-uat-job.sh);
// roll back by pointing `image` at the prior tag and redeploying this module.

targetScope = 'resourceGroup'

@description('Deployment region (e.g. centralus / usgovvirginia).')
param location string

@description('Container Apps managed-environment (CAE) resource id — the console VNet-integrated env.')
param environmentId string

@description('uami-loom-console resource id — ACR pull + the identity the job runs as.')
param consoleUamiId string

@description('uami-loom-console clientId (LOOM_UAMI_CLIENT_ID).')
param consoleUamiClientId string

@description('ACR login server, e.g. acrloomk6mvh5sm6z7do.azurecr.io.')
param acrLoginServer string

@description('Runner image. Default = the loom-uat image (carries e2e/run-cost-anomaly.mjs). The first scheduled execution fails honestly until that image is pushed — build it in the post-deploy app phase.')
param image string = '${acrLoginServer}/loom-uat:latest'

@description('In-VNet console base URL the runner POSTs (Front Door / vanity URL, or the internal http://loom-console).')
param loomUrl string

@description('Schedule cron (standard 5-field) for the anomaly evaluation. Default daily 06:00 UTC.')
param cronExpression string = '0 6 * * *'

@description('Shared VNet-internal trust token (LOOM_INTERNAL_TOKEN) — the deterministic guid main.bicep also wires to the Console, so the two match.')
@secure()
param internalToken string = ''

@description('Max seconds one evaluation run may take before the execution is terminated. 10 min.')
param replicaTimeout int = 600

@description('Compliance/cost tags.')
param complianceTags object = {}

// COST0 tag convention: every loom-next-level program resource carries the
// `loom-next-level` tag so program-budget.bicep's tag-filtered Consumption
// budget bounds the program's aggregate run-rate. The cost-anomaly job is a
// ~$0-idle scheduled job (one short daily execution) — see the cost note.
var programTags = union(complianceTags, { 'loom-next-level': 'true' })

var internalTokenSecret = empty(internalToken)
  ? []
  : [
      {
        name: 'loom-internal-token'
        value: internalToken
      }
    ]

// Pinned to the same Container Apps api-version the sibling ACA job modules use
// (synthetic-monitor-job.bicep / gh-runner-job.bicep) — bicep/runtime sync.
resource costAnomalyJob 'Microsoft.App/jobs@2025-02-02-preview' = {
  name: 'loom-cost-anomaly-monitor'
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
      secrets: internalTokenSecret
    }
    template: {
      containers: [
        {
          name: 'cost-anomaly'
          image: image
          command: [ 'node', 'e2e/run-cost-anomaly.mjs' ]
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          env: concat(
            [
              { name: 'LOOM_URL', value: loomUrl }
              { name: 'LOOM_UAMI_CLIENT_ID', value: consoleUamiClientId }
            ],
            empty(internalToken) ? [] : [
              { name: 'LOOM_INTERNAL_TOKEN', secretRef: 'loom-internal-token' }
            ]
          )
        }
      ]
    }
  }
}

@description('The cost-anomaly-monitor Job resource id.')
output jobId string = costAnomalyJob.id

@description('The cost-anomaly-monitor Job name.')
output jobName string = costAnomalyJob.name
