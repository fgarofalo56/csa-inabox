// CSA Loom — N5 asset-reconciler (scheduled Container App Job).
//
// A `Microsoft.App/jobs` with a Schedule trigger (default every 15 minutes) in
// the console's VNet-integrated Container Apps Environment. Each execution runs
// `node e2e/run-asset-reconcile.mjs` from the loom-uat image (the console image
// is slimmed — .dockerignore excludes e2e/ — so the UAT image is the runner that
// carries the thin entrypoint): the entrypoint POSTs the in-VNet console's
// /api/internal/assets/reconcile with the shared internal token, and the console
// process does the REAL work — derive the software-defined-asset graph from
// unified lineage, read REAL Delta commit versions out of `_delta_log` in the
// customer's own ADLS Gen2 (plus Event Hubs Capture landing watermarks), run the
// pure decision engine with its cooldown / in-flight / failure-backoff thrash
// guards, dispatch the REAL backing job (Synapse pipeline, Databricks job, or
// the SQLMesh/dbt transform runner), and alert overdue assets through the shared
// action group (lib/azure/alert-dispatch.ts, O1).
//
// ── Estate constraint (2026-07-23) ─────────────────────────────────────────
// Y1 Linux Consumption Functions are structurally broken on this estate (policy
// seals storage data-planes; the multitenant Y1 runtime is not a trusted
// service, so host keys / timer leases fail). ANY new scheduled/background
// compute uses the IN-VNET ACA JOB pattern instead — this module mirrors
// cost-anomaly-monitor-job.bicep / synthetic-monitor-job.bicep, the proven
// precedents. There is NO asset-reconciler Function, and NO Dagster runtime:
// Dagster's software-defined-asset SEMANTICS are adopted natively, its runtime
// is not deployed anywhere.
//
// Wired into admin-plane/main.bicep via the R0 observabilityConfig bag
// (default-ON, opt-out) — never a new top-level param.
//
// Azure-native only (Container Apps Jobs + ADLS Gen2 + Cosmos + Synapse /
// Databricks / the transform runner + Action Groups). No Microsoft Fabric
// dependency (.claude/rules/no-fabric-dependency.md); OneLake paths are
// explicitly NOT observed by the signal reader.
//
// IL5 / sovereign: fully in-boundary. Every hop the pass makes (Cosmos, the
// lake, Synapse/Databricks, the transform-runner Container App, the Azure
// Monitor action group) is inside the deployment's own VNet/tenant, so the
// capability runs disconnected in an air-gapped enclave.
//
// ── Rollback ───────────────────────────────────────────────────────────────
// Instant (no roll): flip the `n5-asset-reconciler` runtime flag OFF on
// /admin/runtime-flags — the very next pass becomes a no-op. Infra-level:
// set observabilityConfig.assetReconcilerEnabled=false and redeploy (removes the
// job), or one-shot `az containerapp job stop` / delete the job — the console app
// is untouched and every saved freshness policy is retained. Last-known-good
// runner: the loom-uat image tag (rebuild via
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

@description('Runner image. Default = the loom-uat image (carries e2e/run-asset-reconcile.mjs). The first scheduled execution fails honestly until that image is pushed — build it in the post-deploy app phase.')
param image string = '${acrLoginServer}/loom-uat:latest'

@description('In-VNet console base URL the runner POSTs (Front Door / vanity URL, or the internal http://loom-console).')
param loomUrl string

@description('Schedule cron (standard 5-field) for the reconciliation pass. Default every 15 minutes — overlap is harmless: the pass is idempotent and every dispatch is cooldown-guarded.')
param cronExpression string = '*/15 * * * *'

@description('Shared VNet-internal trust token (LOOM_INTERNAL_TOKEN) — the deterministic guid main.bicep also wires to the Console, so the two match.')
@secure()
param internalToken string = ''

@description('Per-pass dispatch bound (LOOM_ASSET_MAX_TRIGGERS). 0 = use the code default (25). A pass can never dispatch more materializations than this.')
param maxTriggers int = 0

@description('Max seconds one reconciliation pass may take before the execution is terminated. 15 min.')
param replicaTimeout int = 900

@description('Compliance/cost tags.')
param complianceTags object = {}

// COST0 tag convention: every loom-next-level program resource carries the
// `loom-next-level` tag so program-budget.bicep's tag-filtered Consumption
// budget bounds the program's aggregate run-rate. The reconciler is a ~$0-idle
// scheduled job (one short execution per 15 min, 0.5 vCPU) — the materializations
// it triggers bill to the engines they run on, which the same tag-filtered budget
// already covers.
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
// (cost-anomaly-monitor-job.bicep / synthetic-monitor-job.bicep) — bicep/runtime sync.
resource assetReconcilerJob 'Microsoft.App/jobs@2025-02-02-preview' = {
  name: 'loom-asset-reconciler'
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
        // Exactly one replica per execution: two concurrent passes could both
        // decide to dispatch the same asset before either wrote its
        // lastTriggerAt watermark (the cooldown guard reads that watermark).
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
          name: 'asset-reconciler'
          image: image
          command: [ 'node', 'e2e/run-asset-reconcile.mjs' ]
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          env: concat(
            [
              { name: 'LOOM_URL', value: loomUrl }
              { name: 'LOOM_UAMI_CLIENT_ID', value: consoleUamiClientId }
            ],
            maxTriggers > 0 ? [
              { name: 'LOOM_ASSET_MAX_TRIGGERS', value: string(maxTriggers) }
            ] : [],
            empty(internalToken) ? [] : [
              { name: 'LOOM_INTERNAL_TOKEN', secretRef: 'loom-internal-token' }
            ]
          )
        }
      ]
    }
  }
}

@description('The asset-reconciler Job resource id.')
output jobId string = assetReconcilerJob.id

@description('The asset-reconciler Job name.')
output jobName string = assetReconcilerJob.name
