// CSA Loom — LIN-GC-2 lineage garbage collection (scheduled Container App Job).
//
// A `Microsoft.App/jobs` with a Schedule trigger (default daily 04:30 UTC) in
// the console's VNet-integrated Container Apps Environment. Each execution runs
// `node e2e/run-lineage-reconcile.mjs` from the loom-uat image (the console
// image is slimmed — .dockerignore excludes e2e/ — so the UAT image is the
// runner that carries the thin entrypoint): the entrypoint POSTs the in-VNet
// console's /api/internal/lineage/reconcile with the shared internal token, and
// the console process runs the same lib/azure/lineage-gc.ts functions the
// Governance → Lineage → Reconcile dialog calls. One source of truth, rather
// than a second implementation that can drift from the interactive one.
//
// WHY THIS EXISTS. Delete-time cleanup (LIN-GC-1) is already wired into the
// per-item DELETE, the workspace cascade and bulk-delete. What never existed is
// the SWEEP, and three classes of debris only a sweep can reach:
//   · items deleted BEFORE LIN-GC-1 shipped — the 2026-07-08 UAT purge left
//     orphaned Thread edges that nothing has ever cleaned;
//   · items deleted out-of-band, straight from the portal, or by a failed
//     provision that registered a Purview entity and then rolled back;
//   · a delete whose cleanup half failed. cleanupItemMetadata is deliberately
//     FIRE-AND-FORGET, so a Purview outage during a delete loses that
//     reconciliation silently and permanently — nothing ever retries it.
// The operator reported the gap on 2026-08-30 asking where "the cleanup engine"
// was: the dialog existed, the delete-time path existed, nothing scheduled
// either.
//
// SCAN-ONLY BY DEFAULT, and that asymmetry is the point. The route deletes
// nothing unless LOOM_LINEAGE_GC_PURGE is explicitly set. An unattended purge
// would delete metadata for an item whose absence might be a READ failure rather
// than a real deletion — the unknown-spent-as-a-negative shape, with permanent
// consequences. The schedule makes debris VISIBLE; a human authorises removal.
//
// COST. One short daily execution on 0.5 vCPU / 1.0Gi, scale-to-zero between
// runs — the same ~$0-idle profile as the cost-anomaly monitor beside it.
//
// Disable: set observabilityConfig.lineageGcEnabled=false and redeploy (removes
// the job), or one-shot `az containerapp job stop` / delete the job — the
// console app is untouched, and the reconcile dialog keeps working either way.
// Last-known-good runner: the loom-uat image tag (rebuild via
// scripts/csa-loom/deploy-loom-uat-job.sh); roll back by pointing `image` at the
// prior tag and redeploying this module.

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

@description('Runner image. Default = the loom-uat image (carries e2e/run-lineage-reconcile.mjs). The first scheduled execution fails honestly until that image is pushed — build it in the post-deploy app phase.')
param image string = '${acrLoginServer}/loom-uat:latest'

@description('In-VNet console base URL the runner POSTs (Front Door / vanity URL, or the internal http://loom-console).')
param loomUrl string

@description('Schedule cron (standard 5-field). Default daily 04:30 UTC — off the :00 mark and clear of the 06:00 cost-anomaly run, so the two do not contend for the same console.')
param cronExpression string = '30 4 * * *'

@description('Shared VNet-internal trust token (LOOM_INTERNAL_TOKEN) — the deterministic guid main.bicep also wires to the Console, so the two match.')
@secure()
param internalToken string = ''

@description('Max seconds one sweep may take before the execution is terminated. 15 min — the scan reads every item across three planes, so it is given more room than the cost monitor.')
param replicaTimeout int = 900

@description('Compliance/cost tags.')
param complianceTags object = {}

// COST0 tag convention: every loom-next-level program resource carries the
// `loom-next-level` tag so program-budget.bicep's tag-filtered Consumption
// budget bounds the program's aggregate run-rate.
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
// (cost-anomaly-monitor-job.bicep / synthetic-monitor-job.bicep) — bicep/runtime
// sync.
resource lineageGcJob 'Microsoft.App/jobs@2025-02-02-preview' = {
  name: 'loom-lineage-gc'
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
          name: 'lineage-gc'
          image: image
          command: [ 'node', 'e2e/run-lineage-reconcile.mjs' ]
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

@description('The lineage-gc Job resource id.')
output jobId string = lineageGcJob.id

@description('The lineage-gc Job name.')
output jobName string = lineageGcJob.name
