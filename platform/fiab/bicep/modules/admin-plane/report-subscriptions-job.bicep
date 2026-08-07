// CSA Loom — WS-C2 report-subscriptions delivery runtime (scheduled Container App Job).
//
// A `Microsoft.App/jobs` with a Schedule trigger (default every 15 minutes) in
// the console's VNet-integrated Container Apps Environment. Each execution runs
// `node dist/src/main.js` from the loom-report-subscriptions image (built by
// scripts/csa-loom/deploy-report-subscriptions-job.sh /
// azure-functions/report-subscriptions/Dockerfile): it reads enabled report
// subscriptions from Cosmos, selects the ones whose OWN 6-field NCRONTAB cron is
// due this minute, renders each report Azure-native via the
// paginated-report-renderer (NOT Power BI ExportTo — Gov-safe, no Fabric
// dependency), POSTs the bytes to the delivery Logic App for Office 365 email,
// and appends a ReportDeliveryLog row the [subId]/logs route surfaces.
//
// ── WHY AN ACA JOB, NOT A Y1 FUNCTION (B-FN C3, operator decision 2026-07-23) ──
// The Function-hosted runtime on this estate executes nothing. Measured
// 2026-08-06 against rg-csa-loom-admin-centralus:
//
//   • LOAD-BEARING — FunctionExecutionCount (2026-07-25→08-06, P1D, Total) sums
//     to ZERO for ALL SEVEN Function Apps. errorCode=Success, 13 of 13
//     datapoints carrying an EXPLICIT `total: 0.0`, none absent — real measured
//     zeros, not missing data. Nothing has executed in 13 days.
//   • func-rptsub-… additionally indexes no functions at all
//     (`az functionapp function list` → `[]`, exit 0), so this timer had never
//     fired even once.
//
// The estate is NOT uniform, and `function list` alone would MISLEAD anyone who
// re-ran it: func-secexp-… and func-cpeval-… hold indexed, ENABLED functions
// (timers `0 0 6 * * *` and `0 0 7 * * *`), and func-loom-prpt-renderer-…'s
// list call FAILS outright — exit 1, `Operation returned an invalid status
// 'Bad Request'` (ServiceUnavailable from the host runtime), which is UNKNOWN,
// not empty. Only the execution metric covers all seven. Note the 400 is also
// the control that validates the empties: an unreachable host errors rather
// than returning `[]`.
//
// NO ROOT CAUSE IS ASSERTED HERE. Two hosts index fine under the same Azure
// Policy regime, so a "policy seals the storage data-plane, therefore the host
// cannot index" explanation would not account for its own variance. What is
// established is the outcome — zero executions — not the mechanism.
//
// ALL scheduled/background compute uses the in-VNet ACA-job pattern (this module
// mirrors secret-expiry-monitor-job.bicep and lineage-extractor-job.bicep, proven
// live by loom-uat / gh-aca-runner). This module REPLACES
// report-subscriptions-function.bicep.
//
// ── IDENTITY (what changed, and why it needs ZERO post-deploy grants) ───────
// The job runs as the CONSOLE UAMI, not a per-Function system identity. The
// retired Function's identity needed Cosmos DB Built-in Data Contributor +
// Storage Blob Data Contributor + Logic App Contributor granted AFTER deploy
// (grant-navigator-rbac.sh, keyed off the Function module's principalId output —
// a value that does not exist until the Function deploys, which is why it could
// never be done in-template). Running as the Console UAMI deletes that step
// entirely: the Console already holds every one of those grants, and
// integration/report-subscription-logicapp.bicep ALREADY grants the Console UAMI
// Logic App Contributor on the delivery workflow — the exact permission
// `deliverViaLogicApp` needs for listCallbackUrl. So this module declares NO
// role assignments and requires NO post-deploy RBAC (auto-bind-by-default.md §5).
//
// ── A REAL BUG THIS MODULE FIXES (C3, 2026-08-06) ──────────────────────────
// `src/clients.ts::renderReport` reads LOOM_REPORT_RENDERER_URL and throws an
// honest error when it is unset. That variable was set NOWHERE in bicep — grep
// for it across platform/fiab/bicep returned zero hits — so every delivery would
// have failed at the render step even if the timer had fired. The renderer URL
// the platform already knows (`loomPaginatedRenderUrl`, the same value the
// Console consumes as LOOM_PAGINATED_RENDER_URL) is now wired through here. A
// value the deploy can produce must be produced by the deploy, never asked for.
//
// Azure-native only (Container Apps Jobs + Cosmos + Logic Apps). No Microsoft
// Fabric / Power BI ExportTo dependency (.claude/rules/no-fabric-dependency.md).
//
// Wired into admin-plane/main.bicep via the R0 functionAppsConfig bag
// (reportSubscriptionsCron) — never a new top-level param.
//
// ── Rollback ───────────────────────────────────────────────────────────────
// Disable: set reportSubscriptionsEnabled=false and redeploy (removes the job),
// or one-shot `az containerapp job stop --name loom-report-subscriptions`. The
// console app and the subscriptions UI are untouched — the [subId]/logs route
// keeps reading whatever delivery history exists. No state migration either way.
// Roll the image back with `az containerapp job update --image <prev-tag>` via
// scripts/csa-loom/deploy-report-subscriptions-job.sh.
//
// Grounded in Microsoft Learn:
//   Container Apps jobs (Schedule trigger, cron is 5-field UTC)
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

@description('ACR login server, e.g. acrloomk6mvh5sm6z7do.azurecr.io.')
param acrLoginServer string

@description('Delivery runtime image. Default = loom-report-subscriptions:latest (built by scripts/csa-loom/deploy-report-subscriptions-job.sh). The first scheduled execution fails honestly until that image is pushed — build it in the post-deploy app phase.')
param image string = '${acrLoginServer}/loom-report-subscriptions:latest'

@description('Loom Cosmos data-plane endpoint holding the report-subscriptions + report-delivery-log containers. Empty → each pass honest-gates (ran:false) and exits 0 without touching anything.')
param loomCosmosEndpoint string = ''

@description('Cosmos database name.')
param loomCosmosDatabase string = 'loom'

@description('Tick schedule — STANDARD 5-FIELD, UTC (Container Apps jobs, not the 6-field NCRONTAB the retired Y1 Function used). Default every 15 minutes. NOTE: each SUBSCRIPTION carries its own 6-field cron and schedule.ts matches it at MINUTE resolution against this tick, so a subscription whose cron targets a minute this tick never lands on cannot fire. Keep the tick divisor aligned with the minutes the subscriptions UI can emit. Not secret material — a cron string, hence the lint suppression.')
#disable-next-line secure-secrets-in-params
param cronExpression string = '*/15 * * * *'

@description('Base URL of the paginated-report-renderer (loomPaginatedRenderUrl) — the Azure-native export path (NOT Power BI ExportTo). Empty → every render honest-errors per subscription and the failure is recorded on the delivery-log row.')
param reportRendererUrl string = ''

@description('Loom lake storage account used for the report archive.')
param adlsAccount string = ''

@description('Subscription id used for the Logic App listCallbackUrl lookup.')
param loomSubscriptionId string = ''

@description('Delivery Logic App workflow name (integration/report-subscription-logicapp.bicep). Empty → delivery honest-errors per subscription.')
param subscriptionLogicAppName string = ''

@description('Resource group holding the delivery Logic App.')
param subscriptionLogicAppRg string = ''

@description('Loom DLZ resource group (fallback for the Logic App lookup).')
param loomDlzRg string = ''

@description('AOAI endpoint for B-N19d digest narration. Empty → digests deliver the deterministic summary instead.')
param aoaiEndpoint string = ''

@description('AOAI chat deployment for B-N19d digest narration.')
param aoaiDeployment string = ''

@description('AOAI API version.')
param aoaiApiVersion string = '2024-10-21'

@description('Application Insights connection string for the job execution telemetry.')
param appInsightsConnectionString string = ''

@description('Max seconds one delivery pass may take before the execution is terminated. Default 840s (14 min) — deliberately UNDER the 15-minute default tick so a hung pass is reaped before the next execution starts rather than accumulating overlapping replicas.')
param replicaTimeout int = 840

@description('Compliance/cost tags.')
param complianceTags object = {}

// COST0 tag convention: every loom-next-level program resource carries the
// `loom-next-level` tag so program-budget.bicep's tag-filtered Consumption
// budget bounds the program's aggregate run-rate. Scale-to-zero scheduled job:
// ~$0/mo idle, a few cents/mo of vCPU-seconds per pass.
var programTags = union(complianceTags, { 'loom-next-level': 'true' })

// Pinned to the same Container Apps api-version the sibling ACA job modules use
// (secret-expiry-monitor-job.bicep / lineage-extractor-job.bicep) — bicep/runtime sync.
resource reportSubscriptionsJob 'Microsoft.App/jobs@2025-02-02-preview' = {
  name: 'loom-report-subscriptions'
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
      // No retry: a failed pass is re-attempted by the NEXT tick, and every
      // per-subscription failure is already durable on the delivery-log row.
      // Retrying the whole batch would re-deliver the subscriptions that
      // succeeded before the fault — duplicate email is worse than a 15-minute
      // delay.
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
    }
    template: {
      containers: [
        {
          name: 'report-subscriptions'
          image: image
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          env: [
            { name: 'AZURE_CLIENT_ID', value: consoleUamiClientId }
            { name: 'LOOM_UAMI_CLIENT_ID', value: consoleUamiClientId }
            { name: 'LOOM_COSMOS_ENDPOINT', value: loomCosmosEndpoint }
            { name: 'LOOM_COSMOS_DATABASE', value: loomCosmosDatabase }
            { name: 'REPORT_SUBSCRIPTIONS_CRON', value: cronExpression }
            // C3 fix: the runtime has always read this name and bicep never set
            // it, so every render threw. Wired from loomPaginatedRenderUrl.
            { name: 'LOOM_REPORT_RENDERER_URL', value: reportRendererUrl }
            { name: 'LOOM_ADLS_ACCOUNT', value: adlsAccount }
            { name: 'LOOM_SUBSCRIPTION_ID', value: loomSubscriptionId }
            { name: 'LOOM_SUBSCRIPTION_LOGIC_APP_NAME', value: subscriptionLogicAppName }
            { name: 'LOOM_SUBSCRIPTION_LOGIC_APP_RG', value: subscriptionLogicAppRg }
            { name: 'LOOM_DLZ_RG', value: loomDlzRg }
            // Sovereign endpoints derived from the deployment environment.
            { name: 'LOOM_ARM_ENDPOINT', value: environment().resourceManager }
            { name: 'LOOM_STORAGE_SUFFIX', value: environment().suffixes.storage }
            { name: 'LOOM_AOAI_ENDPOINT', value: aoaiEndpoint }
            { name: 'LOOM_AOAI_DEPLOYMENT', value: aoaiDeployment }
            { name: 'LOOM_AOAI_API_VERSION', value: aoaiApiVersion }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
          ]
        }
      ]
    }
  }
}

@description('The report-subscriptions Job resource id.')
output jobId string = reportSubscriptionsJob.id

@description('The report-subscriptions Job name.')
output jobName string = reportSubscriptionsJob.name
