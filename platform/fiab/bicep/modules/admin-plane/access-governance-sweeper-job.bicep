// CSA Loom — C17 access-governance sweeper (scheduled Container App Job).
//
// A `Microsoft.App/jobs` with a Schedule trigger in the console's
// VNet-integrated Container Apps Environment. Each execution runs
// `node e2e/run-access-sweep.mjs` from the loom-uat image (the console image is
// slimmed — .dockerignore excludes e2e/ — so the UAT image is the runner that
// carries the thin entrypoint): the entrypoint POSTs the in-VNet console's
// access-governance sweep route(s) with the shared internal token, and the
// console process does the REAL work — find ledger assignments past their
// expiresAt and REVOKE the real grant (revokeStructuredGrant for SQL/ADX +
// revokeAccessGrant for the ARM role assignment), close past-deadline review
// campaigns (auto-revoking undecided grants and sealing the hash-chained
// evidence record), and reconcile Entra group-targeted packages against LIVE
// Graph membership.
//
// ── The defect this closes (a SECURITY finding, not a wiring nit) ───────────
// Measured 2026-08-08 on origin/main:
//   grep -rn "LOOM_SWEEPER_TOKEN" platform/ scripts/ .github/   → exit 1, ZERO hits
//   grep -rni "sweeper"           platform/                     → exit 1, ZERO hits
// The `azure-functions/access-governance-sweeper` Function was ABSENT from
// platform bicep entirely, and the shared secret its three timers needed was set
// nowhere by any deploy. The console routes fail closed when that variable is
// unset, so EVERY scheduled call was rejected — on every estate, since the
// routes were written.
//
// Consequence: expiry auto-revoke was ADMIN-BUTTON-ONLY. Time-bound access that
// should have expired stayed LIVE — a real ARM role assignment and a real
// SQL/ADX data-plane grant — until a human tenant-admin happened to press "Run
// sweep". Review campaigns past their deadline never auto-closed, so undecided
// grants were never revoked. A governance control that cannot run is not a
// control; it reads as coverage while enforcing nothing.
//
// ── Estate constraint (2026-07-23) ─────────────────────────────────────────
// Y1 Linux Consumption Functions are structurally broken on this estate (policy
// seals storage data-planes; the multitenant Y1 runtime is not a trusted
// service, so host keys / timer leases fail). ANY scheduled/background compute
// uses the IN-VNET ACA JOB pattern instead — this module mirrors
// cost-anomaly-monitor-job.bicep / asset-reconciler-job.bicep, the proven
// precedents, and completes the `access-governance-sweeper` row of
// docs/fiab/functions-to-aca-jobs.md §4.
//
// ── Auth: produced by the deploy, never asked of the user ───────────────────
// Per auto-bind-by-default.md §5 the job presents the SHARED
// `LOOM_INTERNAL_TOKEN` — the deterministic guid admin-plane/main.bicep already
// mints and wires to the Console UNCONDITIONALLY (`secretRef:
// 'loom-internal-token'`). There is no new env var for an operator to set and no
// "set LOOM_SWEEPER_TOKEN" terminal state. The token reaches the container as a
// Container Apps secretRef; its VALUE never appears in a param file, a log, or
// this template's outputs.
//
// This module is instantiated ONCE PER SCHEDULE (expiry / reviews / group-sync)
// so each pass keeps the independent cadence the three retired timers had, and
// each cron stays independently tunable.
//
// Azure-native only (Container Apps Jobs + Cosmos + ARM/Graph via the console).
// No Microsoft Fabric dependency (.claude/rules/no-fabric-dependency.md).
//
// Cloud parity (.claude/rules/cloud-parity.md): nothing here is
// Commercial-specific — the module takes the same branch in Gov params, since it
// is gated only on `containerPlatform == 'containerApps' && deployAppsEnabled`,
// exactly like its already-deployed siblings.
//
// IL5 / sovereign: fully in-boundary. Every hop (the console, Cosmos, ARM, the
// data-plane grants) is inside the deployment's own VNet/tenant, so the control
// runs disconnected in an air-gapped enclave.
//
// ── Rollback ───────────────────────────────────────────────────────────────
// Set functionAppsConfig.accessSweeperEnabled=false and redeploy (removes the
// jobs), or one-shot `az containerapp job stop` — the console app is untouched
// and the admin "Run sweep" button keeps working exactly as before.
// Last-known-good runner: the loom-uat image tag (rebuild via
// scripts/csa-loom/deploy-loom-uat-job.sh).

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

@description('Job name — one per schedule (loom-access-sweep / loom-access-review-sweep / loom-access-group-sync).')
param jobName string

@description('Which pass this instance runs (ACCESS_SWEEP_MODE): expiry | reviews | group-sync | all.')
@allowed([ 'expiry', 'reviews', 'group-sync', 'all' ])
param sweepMode string

@description('Runner image. Default = the loom-uat image (carries e2e/run-access-sweep.mjs). The first scheduled execution fails honestly until that image is pushed — build it in the post-deploy app phase.')
param image string = '${acrLoginServer}/loom-uat:latest'

@description('In-VNet console base URL the runner POSTs (Front Door / vanity URL, or the internal http://loom-console).')
param loomUrl string

@description('Schedule cron (standard 5-field, UTC). Container Apps jobs do NOT use the 6-field NCRONTAB the retired Y1 Function used.')
param cronExpression string

@description('Shared VNet-internal trust token (LOOM_INTERNAL_TOKEN) — the deterministic guid main.bicep also wires to the Console, so the two match. Delivered as a Container Apps secretRef; never logged or output.')
@secure()
param internalToken string = ''

@description('Max seconds one sweep pass may take before the execution is terminated. 15 min — a large ledger with many real ARM/data-plane revokes is the slow case.')
param replicaTimeout int = 900

@description('Compliance/cost tags.')
param complianceTags object = {}

// COST0 tag convention: every loom-next-level program resource carries the
// `loom-next-level` tag so program-budget.bicep's tag-filtered Consumption
// budget bounds the program's aggregate run-rate. These are ~$0-idle scheduled
// jobs (one short execution per tick, 0.25 vCPU, scale-to-zero between runs).
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
// (cost-anomaly-monitor-job.bicep / asset-reconciler-job.bicep) — bicep/runtime sync.
resource accessSweeperJob 'Microsoft.App/jobs@2025-02-02-preview' = {
  name: jobName
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
        // select the same expired assignment and issue duplicate revokes before
        // either wrote the ledger row back to 'expired'.
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
          name: 'access-sweeper'
          image: image
          command: [ 'node', 'e2e/run-access-sweep.mjs' ]
          resources: {
            // The runner is a single HTTP POST per pass — all the real work runs
            // in the console process, so this stays at the smallest valid size.
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: concat(
            [
              { name: 'LOOM_URL', value: loomUrl }
              { name: 'LOOM_UAMI_CLIENT_ID', value: consoleUamiClientId }
              { name: 'ACCESS_SWEEP_MODE', value: sweepMode }
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

@description('The access-governance sweeper Job resource id.')
output jobId string = accessSweeperJob.id

@description('The access-governance sweeper Job name.')
output jobName string = accessSweeperJob.name
