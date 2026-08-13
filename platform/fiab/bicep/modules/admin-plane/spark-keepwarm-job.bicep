// CSA Loom — Spark warm-pool heartbeat (scheduled Container App Job). #3226
//
// A `Microsoft.App/jobs` with a Schedule trigger in the console's
// VNet-integrated Container Apps Environment. Each execution runs
// `node e2e/run-spark-keepwarm.mjs` from the loom-uat image (the console image
// is slimmed — .dockerignore excludes e2e/ — so the UAT image is the runner that
// carries the thin entrypoint): the entrypoint POSTs the in-VNet console's
// /api/internal/spark/keep-warm route with the shared internal token, and the
// console process does the REAL work — start the in-process sweeper after a
// replica recycle, re-adopt cross-replica warm sessions from the shared store,
// synchronously reconcile 'warming' slots against live Livy state, top the pool
// back up to `min`, and run the A11 faulted-pool auto-recovery tick.
//
// ── The defect this closes (#3226) ─────────────────────────────────────────
// The heartbeat used to be a GitHub Actions `schedule:` declaring
// `*/5 * * * *`. MEASURED over 200 consecutive scheduled runs
// (2026-08-04T04:31:08Z -> 2026-08-13T20:22:43Z, 231.9 h of wall clock):
//
//     declared   */5m          expected ticks   2782
//     delivered  200 runs      delivery rate    7.19%
//     min gap    22.0 min      median gap       56.9 min   (11.4x declared)
//     p90 gap   131.6 min      max gap         349.9 min
//     intervals exceeding the 15-min idle TTL:  199 / 199   (100%)
//
// GitHub delays and drops high-frequency schedules on busy repositories, so the
// heartbeat NEVER once beat the warm-session idle TTL
// (LOOM_SPARK_POOL_IDLE_TTL default 900s = 15 min) — nor the Spark pool's own
// autoPause.delayInMinutes, which landing-zone/synapse.bicep and
// landing-zone/synapse-spark-pools.bicep both default to 15. A heartbeat that
// cannot beat the TTL keeps nothing warm; the capability was inert by design.
//
// Azure's own scheduler honours the cron. A Container Apps Job Schedule trigger
// supports minute granularity (Learn documents `*/1 * * * *` as a valid
// cronExpression), and the job runs INSIDE the console's VNet-integrated CAE as
// the console UAMI with ZERO GitHub dependency — no repo secret, no public
// runner, so it works in a disconnected/air-gapped enclave. That is the same
// reasoning that already put loom-synthetic-monitor and the three loom-access-*
// sweeps on ACA jobs.
//
// The URL it POSTs follows the proven sibling convention (`loomUrl` below):
// Front Door when Front Door is enabled, else the CAE-internal
// `http://loom-console`. It is NOT unconditionally the internal name — that
// deviation is untested here and the sibling jobs do not take it.
//
// ── Exactly ONE scheduler (#3340) ──────────────────────────────────────────
// The GitHub workflow's `schedule:` block is REMOVED in the same change; it
// stays as a `workflow_dispatch`-only manual probe. Per #3340 a job has exactly
// one scheduler — this module is it. No third mechanism, no duplicate timer.
//
// ── Estate constraint (2026-07-23) ─────────────────────────────────────────
// Y1 Linux Consumption Functions are structurally broken on this estate (Azure
// Policy seals storage data-planes, so the multitenant Y1 runtime cannot take
// timer leases or mint host keys). ANY scheduled/background compute uses the
// IN-VNET ACA JOB pattern — this module mirrors access-governance-sweeper-job
// .bicep / cost-anomaly-monitor-job.bicep, the proven precedents.
//
// ── Auth: produced by the deploy, never asked of the user ───────────────────
// Per auto-bind-by-default.md §5 the job presents the SHARED
// `LOOM_INTERNAL_TOKEN` — the deterministic guid admin-plane/main.bicep already
// mints and wires to the Console UNCONDITIONALLY (`secretRef:
// 'loom-internal-token'`). There is no new env var for an operator to set. The
// token reaches the container as a Container Apps secretRef; its VALUE never
// appears in a param file, a log, or this template's outputs.
//
// ── Cost: this job is ~free; the WARM POOL it drives is NOT ─────────────────
// The job itself is 0.25 vCPU / 0.5 GiB for a few seconds per tick, scale-to-
// zero between runs — the same shape as its already-deployed siblings.
//
// The warm pool it keeps alive is the material cost, and it is why main.bicep
// leaves `sparkPoolEnabled` FALSE by default. Derived (not billed-measured)
// from published figures: a Synapse Spark instance runs a MINIMUM of 3 nodes
// (Learn: apache-spark-pool-configurations §Nodes) and the deployed default
// node size is Small = 4 vCore (Learn, same page; synapse.bicep
// sparkPoolNodeSize='Small'), so one continuously-warm session pins >= 12
// vCores. At the measured centralus retail Consumption rate of $0.14766 per
// vCore-hour (Azure Retail Prices API, meter "vCore", product "Azure Synapse
// Analytics Serverless Apache Spark Pool - Memory Optimized"), that is
// ~$1.77/hour ~= ~$1,293/month per warm session at LOOM_SPARK_POOL_MIN=1.
//
// THEREFORE this module is deployed ONLY when the operator has already opted
// into the warm pool (`sparkPoolEnabled=true`). When the pool is off there is no
// job, no cost, and no green tick over a no-op — instead of the previous state,
// where a heartbeat ran 200x/day and printed "warm pool topped up" while the
// console was replying `{"skipped":true,"reason":"warm pool disabled"}`.
// The opt-in is cost-material and is the narrow case auto-bind-by-default.md
// permits; it is NOT a plumbing gate — nothing is asked of the user except the
// spend decision itself.
//
// Azure-native only (Container Apps Jobs + Synapse Livy via the console).
// No Microsoft Fabric dependency (.claude/rules/no-fabric-dependency.md).
//
// Cloud parity (.claude/rules/cloud-parity.md): nothing here is
// Commercial-specific — the module takes the same branch in the Gov params,
// since it is gated only on `sparkPoolEnabled && containerPlatform ==
// 'containerApps' && deployAppsEnabled`, and gcc-high.bicepparam /
// il5.bicepparam both declare `containerPlatform = 'containerApps'` +
// `deployAppsEnabled = true`. `sparkPoolEnabled` is unset in EVERY shipped param
// file, so the warm pool is equally off — and equally enable-able with the same
// one-line flip — in every boundary. The job itself, the console and Livy are
// all inside the deployment's own VNet/tenant, so it runs disconnected in an
// air-gapped enclave.
//
// ── Rollback ───────────────────────────────────────────────────────────────
// Set functionAppsConfig.sparkKeepWarmEnabled=false and redeploy (removes the
// job), or one-shot `az containerapp job stop` — the console app is untouched
// and notebooks fall back to today's cold-start behaviour.
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

@description('Job name.')
param jobName string = 'loom-spark-keepwarm'

@description('Runner image. Default = the loom-uat image (carries e2e/run-spark-keepwarm.mjs). The first scheduled execution fails honestly until that image is pushed — build it in the post-deploy app phase.')
param image string = '${acrLoginServer}/loom-uat:latest'

@description('In-VNet console base URL the runner POSTs (Front Door / vanity URL, or the internal http://loom-console).')
param loomUrl string

@description('Schedule cron (standard 5-field, UTC). Must stay comfortably under the warm-session idle TTL (LOOM_SPARK_POOL_IDLE_TTL, default 900s = 15 min) AND under the Spark pool autoPause delay (default 15 min) — */5 gives 3x margin. Container Apps jobs do NOT use the 6-field NCRONTAB.')
param cronExpression string = '*/5 * * * *'

@description('Shared VNet-internal trust token (LOOM_INTERNAL_TOKEN) — the deterministic guid main.bicep also wires to the Console, so the two match. Delivered as a Container Apps secretRef; never logged or output.')
@secure()
param internalToken string = ''

@description('Max seconds one heartbeat may take before the execution is terminated. 240s — a tick that provisions a fresh Livy session is the slow case, and it must finish well inside the */5 cadence so ticks never overlap.')
param replicaTimeout int = 240

@description('Compliance/cost tags.')
param complianceTags object = {}

// COST0 tag convention: every loom-next-level program resource carries the
// `loom-next-level` tag so program-budget.bicep's tag-filtered Consumption
// budget bounds the program's aggregate run-rate. This is a ~$0-idle scheduled
// job (one short execution per tick, 0.25 vCPU, scale-to-zero between runs).
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
// (access-governance-sweeper-job.bicep / cost-anomaly-monitor-job.bicep) —
// bicep/runtime sync.
resource sparkKeepWarmJob 'Microsoft.App/jobs@2025-02-02-preview' = {
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
      // No retry: the next tick is only 5 minutes away and is a full retry of
      // the same idempotent top-up. Retrying in-execution would only push a slow
      // tick into the next one's window.
      replicaRetryLimit: 0
      scheduleTriggerConfig: {
        cronExpression: cronExpression
        parallelism: 1
        // Exactly one replica per execution: two concurrent top-ups would race
        // to fill the same `min` slot and over-provision Livy sessions.
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
          name: 'spark-keepwarm'
          image: image
          command: [ 'node', 'e2e/run-spark-keepwarm.mjs' ]
          resources: {
            // The runner is a single HTTP POST — all the real work runs in the
            // console process, so this stays at the smallest valid size.
            cpu: json('0.25')
            memory: '0.5Gi'
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

@description('The Spark keep-warm Job resource id.')
output jobId string = sparkKeepWarmJob.id

@description('The Spark keep-warm Job name.')
output jobName string = sparkKeepWarmJob.name
