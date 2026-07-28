// CSA Loom — E2 copilot-evaluator (scheduled + on-demand Container App Job).
//
// A `Microsoft.App/jobs` with a Schedule trigger (default nightly 07:00 UTC —
// off-peak so LLM-judge spend never competes with business-hours Copilot AOAI
// TPM) in the console's VNet-integrated Container Apps Environment. Each
// execution runs `node dist/azure-functions/copilot-evaluator/src/main.js` from
// the loom-copilot-evaluator image (built by
// scripts/csa-loom/deploy-copilot-evaluator-job.sh /
// azure-functions/copilot-evaluator/Dockerfile): it executes the E1 golden
// Q/A sets against the REAL Copilot retrieval + AOAI path (via the console's
// internal eval-probe route — byte-identical searchDocs + tier routing), runs
// the deterministic mustMention/mustNotMention guards BEFORE the capped LLM
// judge, and writes scored eval-run/eval-result docs to Cosmos
// `loom-copilot-evals`. SRCH1 federated-search relevance and E6 tier-router
// decision evals ride the same execution (deterministic — zero judge spend).
//
// ── WHY AN ACA JOB, NOT A Y1 FUNCTION (B-FN, operator decision 2026-07-23) ──
// Y1 Linux Consumption Functions are structurally broken on this estate: Azure
// Policy seals the storage data-plane (publicNetworkAccess=Disabled, AAD-only,
// no private endpoint) and the multitenant Y1 runtime is not a trusted service,
// so host keys / timer leases fail. ALL scheduled/background compute uses the
// in-VNet ACA-job pattern (this module mirrors cost-anomaly-monitor-job.bicep /
// lineage-extractor-job.bicep). This module REPLACES
// copilot-evaluator-function.bicep, which is deleted.
//
// ── WHAT CHANGED FOR "RUN NOW" (E5) ────────────────────────────────────────
// The retired Function exposed an authLevel='function' HTTP trigger and the
// Console proxied it with a host key (LOOM_COPILOT_EVALUATOR_URL). A job has no
// ingress, so on-demand runs are now an ARM job-start: the Console POSTs
// `{jobId}/start` with an execution-template override that sets
// COPILOT_EVAL_MODE / COPILOT_EVAL_SURFACES / COPILOT_EVAL_DOMAINS /
// COPILOT_EVAL_TRIGGER (lib/azure/copilot-evaluator-client.ts). That removes
// the host key AND the public *.azurewebsites.net surface entirely. Per Learn,
// the caller needs Contributor on the job resource — granted below to the
// Console UAMI, scoped to THIS job only (never subscription-wide).
//
// ── IDENTITY (what the job needs, and why no new grants) ────────────────────
// The job runs as the CONSOLE UAMI, which already holds every data-plane role
// the evaluator uses: Cognitive Services OpenAI User (judge calls), Search
// Index Data Reader (retrieval via the probe), and Cosmos DB Built-in Data
// Contributor (loom-copilot-evals writes). Dropping the Function also drops its
// host storage account and the Blob Data Owner / Queue Contributor grants that
// existed only to satisfy the Functions runtime.
//
// Azure-native only (Container Apps Jobs + AOAI + AI Search + Cosmos). No
// Microsoft Fabric dependency (.claude/rules/no-fabric-dependency.md).
//
// Wired into admin-plane/main.bicep via the R0 functionAppsConfig bag
// (copilotEvaluatorEnabled, default-ON, opt-out) — never a new top-level param.
//
// ── Rollback ───────────────────────────────────────────────────────────────
// Disable: set functionAppsConfig.copilotEvaluatorEnabled=false and redeploy
// (removes the job), or opt out at runtime with LOOM_COPILOT_EVAL_ENABLED=false
// (the entrypoint no-ops immediately, no roll needed). The Copilot itself is
// untouched — this job only SCORES it. Eval docs already in Cosmos are inert.
// Roll the image back with `az containerapp job update --image <prev-tag>` via
// scripts/csa-loom/deploy-copilot-evaluator-job.sh. No state migration.
//
// Grounded in Microsoft Learn:
//   Container Apps jobs (Schedule trigger, cron is 5-field UTC; start-with-
//   override replaces the whole execution template)
//   https://learn.microsoft.com/azure/container-apps/jobs

targetScope = 'resourceGroup'

@description('Deployment region (e.g. centralus / usgovvirginia).')
param location string

@description('Container Apps managed-environment (CAE) resource id — the console VNet-integrated env.')
param environmentId string

@description('uami-loom-console resource id — ACR pull + the identity the job runs as.')
param consoleUamiId string

@description('uami-loom-console clientId (AZURE_CLIENT_ID / LOOM_UAMI_CLIENT_ID).')
param consoleUamiClientId string

@description('uami-loom-console principalId — granted Contributor on THIS job so the Console "Run now" button can start an execution. Empty skips the grant (scheduled runs still work; "Run now" then 403s with an honest error).')
param consoleUamiPrincipalId string = ''

@description('ACR login server, e.g. acrloomk6mvh5sm6z7do.azurecr.io.')
param acrLoginServer string

@description('Evaluator image. Default = loom-copilot-evaluator:latest (built by scripts/csa-loom/deploy-copilot-evaluator-job.sh). The first scheduled execution fails honestly until that image is pushed — build it in the post-deploy app phase.')
param image string = '${acrLoginServer}/loom-copilot-evaluator:latest'

@description('Schedule cron — STANDARD 5-FIELD, UTC (Container Apps jobs, not the 6-field NCRONTAB the retired Y1 Function used). Default nightly 07:00 UTC. Not secret material — a cron string, hence the lint suppression.')
#disable-next-line secure-secrets-in-params
param cronExpression string = '0 7 * * *'

@description('Loom Cosmos account endpoint (https://<acct>.documents.<suffix>:443/). Empty → every eval mode honest-gates (nothing to persist) and the execution exits 0.')
param loomCosmosEndpoint string = ''

@description('Loom Cosmos database id.')
param loomCosmosDatabase string = 'loom'

@description('Console base URL the eval-probe is POSTed at. In-VNet (http://loom-console) by default — unlike the retired Y1 Function, the job runs INSIDE the CAE, so the probe no longer has to leave the VNet through Front Door.')
param consoleBaseUrl string = 'http://loom-console'

@description('Shared VNet-internal trust token (LOOM_INTERNAL_TOKEN) — the deterministic guid main.bicep also wires to the Console, so the two match. Empty → the probe half honest-gates.')
@secure()
param internalToken string = ''

@description('AOAI / AI Foundry endpoint used for the LLM judge. Empty → judge scores are marked deferred (retrieval scoring still runs).')
param aoaiEndpoint string = ''

@description('Explicit judge deployment name. Empty → resolves strong → mini → default (never a hardcoded model name).')
param judgeDeployment string = ''

@description('Strong reasoning deployment name (judge fallback chain).')
param strongDeployment string = ''

@description('Mini deployment name (judge fallback chain).')
param miniDeployment string = ''

@description('Default chat deployment name (judge fallback chain).')
param defaultDeployment string = ''

@description('Daily LLM-judge call cap (round-3 F1). Over cap → retrieval-only scoring, judge scores marked deferred.')
param judgeDailyCap int = 500

@description('Max seconds one evaluation execution may take before it is terminated. 45 min — a full multi-surface judged pass is long.')
param replicaTimeout int = 2700

@description('Skip RBAC role assignments (reconcile passes on estates where grants already exist).')
param skipRoleGrants bool = false

@description('Compliance/cost tags.')
param complianceTags object = {}

// COST0 tag convention: every loom-next-level program resource carries the
// `loom-next-level` tag so program-budget.bicep's tag-filtered Consumption
// budget bounds the program's aggregate run-rate. Scale-to-zero scheduled job:
// ~$0/mo idle; the judge token spend is separately capped (judgeDailyCap).
var programTags = union(complianceTags, { 'loom-next-level': 'true' })

// Contributor — the ONLY role that can start a Container Apps job execution
// (Learn: "the identity used to generate the token must have Contributor
// permission to the Container Apps job resource"). Scoped to this job alone.
var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'

var internalTokenSecret = empty(internalToken)
  ? []
  : [
      {
        name: 'loom-internal-token'
        value: internalToken
      }
    ]

// Pinned to the same Container Apps api-version the sibling ACA job modules use
// (cost-anomaly-monitor-job.bicep / lineage-extractor-job.bicep) — bicep/runtime sync.
resource copilotEvaluatorJob 'Microsoft.App/jobs@2025-02-02-preview' = {
  name: 'loom-copilot-evaluator'
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
          name: 'evaluator'
          image: image
          resources: {
            cpu: json('1.0')
            memory: '2.0Gi'
          }
          env: concat(
            [
              { name: 'AZURE_CLIENT_ID', value: consoleUamiClientId }
              { name: 'LOOM_UAMI_CLIENT_ID', value: consoleUamiClientId }
              { name: 'LOOM_COSMOS_ENDPOINT', value: loomCosmosEndpoint }
              { name: 'LOOM_COSMOS_DATABASE', value: loomCosmosDatabase }
              { name: 'LOOM_EVAL_PROBE_URL', value: consoleBaseUrl }
              { name: 'LOOM_AOAI_ENDPOINT', value: aoaiEndpoint }
              { name: 'LOOM_COPILOT_EVAL_JUDGE_DEPLOYMENT', value: judgeDeployment }
              { name: 'LOOM_AOAI_STRONG_DEPLOYMENT', value: strongDeployment }
              { name: 'LOOM_AOAI_MINI_DEPLOYMENT', value: miniDeployment }
              { name: 'LOOM_AOAI_DEPLOYMENT', value: defaultDeployment }
              { name: 'LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP', value: string(judgeDailyCap) }
              { name: 'LOOM_COPILOT_EVAL_ENABLED', value: 'true' }
              { name: 'COPILOT_EVALUATOR_CRON', value: cronExpression }
              // Scheduled executions run every mode; an on-demand start
              // overrides these in the execution template.
              { name: 'COPILOT_EVAL_MODE', value: 'all' }
              { name: 'COPILOT_EVAL_TRIGGER', value: 'nightly' }
              { name: 'LOOM_ARM_ENDPOINT', value: environment().resourceManager }
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

// ── RBAC: let the Console start an on-demand execution ("Run now", E5) ──────
// Contributor scoped to THIS job resource only — the least privilege that
// satisfies the documented start-operation requirement.
resource jobStartContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants && !empty(consoleUamiPrincipalId)) {
  name: guid(copilotEvaluatorJob.id, consoleUamiPrincipalId, contributorRoleId)
  scope: copilotEvaluatorJob
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributorRoleId)
    principalId: consoleUamiPrincipalId
    principalType: 'ServicePrincipal'
  }
}

@description('The copilot-evaluator Job resource id — wired to the Console as LOOM_COPILOT_EVALUATOR_JOB_ID so "Run now" can start an execution.')
output jobId string = copilotEvaluatorJob.id

@description('The copilot-evaluator Job name.')
output jobName string = copilotEvaluatorJob.name
