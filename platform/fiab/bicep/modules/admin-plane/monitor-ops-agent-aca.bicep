// CSA Loom — Operations Agent evaluator, OSS / air-gapped-Gov fallback (G3).
//
// The DEFAULT operations-agent evaluator is the Consumption Function App +
// approval Logic App in monitor-ops-agent.bicep. In air-gapped Gov (IL5+) or any
// sovereign region where Consumption Functions / the Teams + Logic App path are
// unavailable, this module provides an ALTERNATE evaluator built entirely on
// Azure Container Apps + KEDA — no Logic Apps, no Teams connector, no Consumption
// plan. Same evaluator container (azure-functions/ops-agent-evaluator runnable as
// a plain Node process), scheduled by the KEDA `cron` scaler as a
// Microsoft.App/jobs Scheduled job. When a trigger fires it reasons over the
// event with the in-boundary Azure OpenAI and dispatches via email / webhook
// (Azure Monitor action group) instead of Teams — fully OSS / air-gap-safe.
//
// Azure-native only (Container Apps Jobs + KEDA cron scaler). No Microsoft Fabric
// / Power Automate dependency (.claude/rules/no-fabric-dependency.md).
//
// Grounded in Microsoft Learn:
//   Container Apps Jobs (Scheduled trigger / cron):
//     https://learn.microsoft.com/azure/container-apps/jobs
//   KEDA cron scaler:
//     https://keda.sh/docs/scalers/cron/
//
// Standalone entrypoint: deployed out-of-band into a Gov landing zone that lacks
// the Consumption/Logic-App path (admin-plane/main.bicep is at the 256-param
// ceiling). Allowlisted in scripts/ci/check-bicep-sync.mjs.
//
//   az deployment group create -g <rg> \
//     -f platform/fiab/bicep/modules/admin-plane/monitor-ops-agent-aca.bicep \
//     -p location=<region> environmentId=<CAE id> uamiId=<UAMI id> \
//        acrLoginServer=<acr>.azurecr.io evaluatorImage=<acr>/ops-agent-evaluator:latest \
//        aoaiEndpoint=<https://…> cosmosEndpoint=<https://…> kustoClusterUri=<https://…>

targetScope = 'resourceGroup'

@description('Primary region.')
param location string = resourceGroup().location

@description('Container Apps managed-environment resource id the job runs in (in-VNet for Gov).')
param environmentId string

@description('User-assigned managed identity resource id — the evaluator runs as this identity (granted Cosmos Data Contributor + ADX Database Viewer + Monitoring Reader out-of-band / by the sibling module).')
param uamiId string

@description('ACR login server the evaluator image is pulled from.')
param acrLoginServer string

@description('Evaluator container image (the azure-functions/ops-agent-evaluator core, packaged to run as a one-shot Node process).')
param evaluatorImage string = '${acrLoginServer}/ops-agent-evaluator:latest'

@description('Cron schedule (standard 5-field) for the KEDA cron scaler. Default every 5 minutes — the operations-agent parity cadence.')
param cronExpression string = '*/5 * * * *'

@description('Timezone for the cron scaler (IANA name).')
param cronTimezone string = 'Etc/UTC'

@description('Azure OpenAI endpoint (in-boundary) the evaluator reasons with.')
param aoaiEndpoint string = ''

@description('Azure OpenAI chat deployment name.')
param aoaiDeployment string = 'gpt-4o'

@description('Loom Cosmos account endpoint the evaluator reads agents + triggers from.')
param cosmosEndpoint string = ''

@description('Loom Cosmos database id.')
param cosmosDatabase string = 'loom'

@description('ADX / Eventhouse cluster query URI the evaluator runs trigger KQL against.')
param kustoClusterUri string = ''

@description('ADX / Eventhouse default database.')
param kustoDefaultDb string = 'loomdb'

@description('ARM management endpoint (sovereign-aware).')
param armEndpoint string = environment().resourceManager

@description('Replica timeout (seconds) for one evaluator run.')
param replicaTimeout int = 600

@description('vCPU for the evaluator replica.')
param cpu string = '0.5'

@description('Memory for the evaluator replica.')
param memory string = '1.0Gi'

@description('Compliance tags.')
param complianceTags object = {}

resource evaluatorJob 'Microsoft.App/jobs@2025-02-02-preview' = {
  name: 'ops-agent-evaluator'
  location: location
  tags: complianceTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${uamiId}': {}
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
          identity: uamiId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'evaluator'
          image: evaluatorImage
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: [
            { name: 'OPS_AGENT_EVALUATOR_MODE', value: 'oneshot' }
            { name: 'OPS_AGENT_EVALUATOR_CRON_TZ', value: cronTimezone }
            { name: 'LOOM_AOAI_ENDPOINT', value: aoaiEndpoint }
            { name: 'LOOM_AOAI_DEPLOYMENT', value: aoaiDeployment }
            { name: 'LOOM_COSMOS_ENDPOINT', value: cosmosEndpoint }
            { name: 'LOOM_COSMOS_DATABASE', value: cosmosDatabase }
            { name: 'LOOM_KUSTO_CLUSTER_URI', value: kustoClusterUri }
            { name: 'LOOM_KUSTO_DEFAULT_DB', value: kustoDefaultDb }
            { name: 'LOOM_ARM_ENDPOINT', value: armEndpoint }
            // Air-gapped fallback: dispatch via Azure Monitor action-group
            // email/webhook receivers (the trigger's own action group), NOT the
            // Teams + Logic App path — so no Logic App resource id is wired here.
            { name: 'LOOM_OPS_AGENT_DISPATCH', value: 'action-group' }
            { name: 'AZURE_CLIENT_ID', value: '' }
          ]
        }
      ]
    }
  }
}

@description('The KEDA-cron evaluator job resource id.')
output evaluatorJobId string = evaluatorJob.id
output evaluatorJobName string = evaluatorJob.name
