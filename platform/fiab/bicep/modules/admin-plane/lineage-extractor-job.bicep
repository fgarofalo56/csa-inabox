// CSA Loom — column-lineage extractor (scheduled Container App Job). L3 of the
// loom-next-level Column-Level-Lineage workstream (WS-L).
//
// A `Microsoft.App/jobs` with a Schedule trigger (default every 15 minutes) in
// the console's VNet-integrated Container Apps Environment. Each execution runs
// `node dist/src/main.js` from the loom-lineage-extractor image (built by
// scripts/csa-loom/deploy-lineage-extractor-job.sh / azure-functions/
// lineage-extractor/Dockerfile): it lists COMPLETED ADF / Synapse Copy-activity
// runs since a Cosmos watermark, parses each Copy's `translator.mappings`
// (source→sink column map), resolves the datasets to Loom items, and UPSERTs the
// derived column lineage into the `thread-edges` L1 column model. Idempotent
// (deterministic edge ids + processed-run cache).
//
// WHY AN ACA JOB, NOT A Y1 FUNCTION (estate constraint 2026-07-23): Y1 Linux
// Consumption Functions are structurally broken on this estate — policy seals
// the storage data-plane (publicNetworkAccess=Disabled, AAD-only, no PE) and the
// multitenant Y1 runtime is not a trusted service, so host keys / timer leases
// fail. ALL new scheduled/background compute uses the in-VNet ACA-job pattern
// (this module mirrors synthetic-monitor-job.bicep, proven live by loom-uat /
// gh-aca-runner). Managed-identity auth only — no storage account, no keys.
//
// Azure-native only (Container Apps Jobs + ADF/Synapse REST + Cosmos). No
// Microsoft Fabric dependency — the column model is Loom-native (L1); Purview is
// the opt-in push in L4.
//
// Wired into admin-plane/main.bicep via the R0 observabilityConfig bag
// (default-ON, opt-out) — never a new top-level param.
//
// ── Rollback ───────────────────────────────────────────────────────────────
// Disable: set observabilityConfig.lineageExtractorEnabled=false and redeploy
// (removes the job), or one-shot `az containerapp job stop --name
// loom-lineage-extractor` / delete the job — the console app is untouched. The
// column edges already written to thread-edges are idempotent and harmless; the
// watermark doc (partition __lineage_extractor__) ages out on next run. Roll the
// image back with `az containerapp job update --image <prev-tag>` (last-known-
// good tag) via the deploy-lineage-extractor-job.sh script. No state migration.

targetScope = 'resourceGroup'

@description('Deployment region (e.g. centralus / usgovvirginia).')
param location string

@description('Container Apps managed-environment (CAE) resource id — the console VNet-integrated env.')
param environmentId string

@description('uami-loom-console resource id — ACR pull + managed-identity Cosmos/ADF/Synapse calls (the UAMI already holds the Cosmos data-plane + Data Factory/Synapse Reader roles granted in post-deploy bootstrap).')
param consoleUamiId string

@description('uami-loom-console clientId — targets the ACA managed-identity token fetch (AZURE_CLIENT_ID).')
param consoleUamiClientId string

@description('ACR login server, e.g. acrloomk6mvh5sm6z7do.azurecr.io.')
param acrLoginServer string

@description('Extractor image. Default = loom-lineage-extractor:latest (built by scripts/csa-loom/deploy-lineage-extractor-job.sh). The first scheduled execution exits cleanly (honest gate) until that image is pushed — build it in the post-deploy app phase.')
param image string = '${acrLoginServer}/loom-lineage-extractor:latest'

@description('Cron for the extraction pass. Default every 15 minutes (overlap is idempotent).')
param cronExpression string = '*/15 * * * *'

@description('Loom Cosmos account endpoint (https://<acct>.documents.<suffix>:443/). Empty → the extractor exits cleanly (honest gate; nothing to write).')
param loomCosmosEndpoint string = ''

@description('Loom Cosmos database id.')
param loomCosmosDatabase string = 'loom'

@description('ADF factory name the extractor reads runs from (LOOM_ADF_NAME). Empty → ADF source skipped.')
param adfFactoryName string = ''

@description('Resource group of the ADF factory (LOOM_ADF_RG). Empty → falls back to the deployment RG at runtime.')
param adfResourceGroup string = ''

@description('Subscription id of the ADF factory (LOOM_ADF_SUB). Empty → falls back to the deployment subscription at runtime.')
param adfSubscriptionId string = ''

@description('Synapse workspace name the extractor reads runs from (LOOM_SYNAPSE_WORKSPACE). Empty → Synapse source skipped.')
param synapseWorkspace string = ''

@description('Max seconds one extraction pass may take before the execution is terminated. 10 min — well under the 15-min cadence.')
param replicaTimeout int = 600

@description('Compliance/cost tags.')
param complianceTags object = {}

// COST0 tag convention: every loom-next-level program resource carries the
// `loom-next-level` tag so program-budget.bicep's tag-filtered Consumption
// budget bounds the program's aggregate run-rate. Scale-to-zero scheduled job:
// ~$0/mo idle, a few cents/mo of vCPU-seconds per 15-min pass.
var programTags = union(complianceTags, { 'loom-next-level': 'true' })

// ARM management endpoint for the sovereign cloud (LOOM_ARM_ENDPOINT).
var armEndpoint = environment().resourceManager

// Synapse dev-endpoint suffix per cloud (dev.azuresynapse.net /
// dev.azuresynapse.usgovcloudapi.net) so the extractor reaches the right host.
var synapseDevSuffix = environment().suffixes.storage == 'core.usgovcloudapi.net' ? 'dev.azuresynapse.usgovcloudapi.net' : 'dev.azuresynapse.net'

// Pinned to the same Container Apps api-version the sibling ACA job modules use
// (synthetic-monitor-job.bicep / gh-runner-job.bicep) — bicep/runtime sync.
resource lineageExtractorJob 'Microsoft.App/jobs@2025-02-02-preview' = {
  name: 'loom-lineage-extractor'
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
    }
    template: {
      containers: [
        {
          name: 'extractor'
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
            { name: 'LINEAGE_EXTRACTOR_CRON', value: cronExpression }
            { name: 'LOOM_ADF_NAME', value: adfFactoryName }
            { name: 'LOOM_ADF_RG', value: adfResourceGroup }
            { name: 'LOOM_ADF_SUB', value: adfSubscriptionId }
            { name: 'LOOM_SYNAPSE_WORKSPACE', value: synapseWorkspace }
            { name: 'LOOM_SYNAPSE_DEV_SUFFIX', value: synapseDevSuffix }
            { name: 'LOOM_ARM_ENDPOINT', value: armEndpoint }
          ]
        }
      ]
    }
  }
}

@description('The lineage-extractor Job resource id.')
output jobId string = lineageExtractorJob.id

@description('The lineage-extractor Job name.')
output jobName string = lineageExtractorJob.name
