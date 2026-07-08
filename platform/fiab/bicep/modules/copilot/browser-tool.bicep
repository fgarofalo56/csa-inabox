// CSA Loom — copilot/browser-tool.bicep
// Browser-automation tool runner (AIF-18). A scale-to-zero Azure Container Apps
// JOB running Playwright, driven by the agent's `browser_automation` function
// tool. The Azure-native substitute for a native browser-automation PaaS — the
// whole path stays Loom-owned + in-VNet, so it is Gov-portable with zero
// external browser service (no-fabric-dependency, no-vaporware).
//
// The Console starts an execution per task via ARM
// (browser-tool-client.runBrowserTask), passing the task JSON as a BROWSER_TASK
// env override. The Console reads this job's resource id as LOOM_BROWSER_TOOL_JOB
// (module output `browserToolJobId`); when unset the tool honest-gates.
//
// Manual-trigger job (no schedule) → scale-to-zero: costs nothing until an agent
// invokes the tool. Reuses the ACR + UAMI pattern from platform/runners and
// copilot/maf.bicep.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Container Apps Environment ID (same CAE as the Console + MAF tier)')
param caeId string

@description('ACR login server (image pulled for boundary-local availability)')
param acrLoginServer string

@description('Browser-runner image tag in ACR (loom-browser-tool:<tag>)')
param imageTag string = 'v0.1'

@description('Runner UAMI resource ID (ACR pull; no data-plane grants needed by default)')
param uamiId string

@description('Runner UAMI client ID')
param uamiClientId string

@description('App Insights connection string')
param appInsightsConnectionString string

@description('Compliance tags')
param complianceTags object

resource browserJob 'Microsoft.App/jobs@2025-02-02-preview' = {
  name: 'loom-browser-tool'
  location: location
  tags: complianceTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${uamiId}': {}
    }
  }
  properties: {
    environmentId: caeId
    configuration: {
      // Manual trigger — the Console starts one execution per browser task via
      // ARM /start (scale-to-zero between tasks; no idle cost).
      triggerType: 'Manual'
      replicaTimeout: 300
      replicaRetryLimit: 1
      manualTriggerConfig: {
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
          name: 'browser-runner'
          image: '${acrLoginServer}/loom-browser-tool:${imageTag}'
          resources: { cpu: json('1.0'), memory: '2Gi' }
          env: [
            { name: 'AZURE_CLIENT_ID', value: uamiClientId }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
            // BROWSER_TASK is injected per-execution as an env override on /start.
            { name: 'BROWSER_TASK', value: '' }
            { name: 'OTEL_RESOURCE_ATTRIBUTES', value: 'service.name=loom-browser-tool,csa-loom.app=browser-tool' }
          ]
        }
      ]
    }
  }
}

output browserToolJobId string = browserJob.id
output browserToolJobName string = browserJob.name
