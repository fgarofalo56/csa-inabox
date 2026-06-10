// CSA Loom — copilot/maf.bicep
// Microsoft Agent Framework (MAF) orchestration tier Container App for
// GCC-High / IL5. Serves POST /orchestrate → SSE OrchestratorStep stream with
// the SAME contract + transcript shape as the Foundry tier, but calls Gov AOAI
// (*.openai.azure.us) DIRECTLY — no AI Foundry Hub, no services.ai.azure.com
// Agent Service. Auto-selected by copilot-orchestrator.ts when LOOM_MAF_ENDPOINT
// is wired (set only when this module deploys) + isGovCloud().
//
// Tool dispatch + OBO are delegated back to the Console's token-gated internal
// endpoints (/api/internal/copilot/tools/*), so the exact same handlers run.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Container Apps Environment ID')
param caeId string

@description('ACR login server (image pulled from here for boundary-local availability)')
param acrLoginServer string

@description('MAF image tag in ACR')
param imageTag string = 'v0.1'

@description('MAF UAMI resource ID (ACR pull + AOAI token source)')
param uamiId string

@description('MAF UAMI client ID')
param uamiClientId string

@description('Gov AOAI inference endpoint (https://<account>.openai.azure.us/). Empty → honest infra gate at runtime.')
param aoaiEndpoint string

@description('AOAI chat deployment name (e.g. gpt-4o)')
param aoaiDeployment string

@description('AOAI API version')
param aoaiApiVersion string = '2024-10-21'

@description('Console internal base URL for the tool-dispatch callback (e.g. http://loom-console)')
param consoleInternalEndpoint string = 'http://loom-console'

@description('Shared internal trust token authenticating the MAF → Console tool-dispatch callback (Bicep-wired to both apps; same value).')
@secure()
param internalToken string

@description('Boundary — GCC-High or IL5 (both map to AzureUSGovernment)')
@allowed(['GCC-High', 'IL5'])
param boundary string

@description('App Insights connection string')
param appInsightsConnectionString string

@description('Compliance tags')
param complianceTags object

resource mafApp 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: 'loom-copilot-maf'
  location: location
  tags: complianceTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${uamiId}': {}
    }
  }
  properties: {
    managedEnvironmentId: caeId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        // VNet-internal only — the Console reaches it over the CAE internal
        // network. Never publicly exposed.
        external: false
        targetPort: 3100
        transport: 'http'
        allowInsecure: false
        traffic: [
          { latestRevision: true, weight: 100 }
        ]
      }
      registries: [
        {
          server: acrLoginServer
          identity: uamiId
        }
      ]
      secrets: [
        { name: 'loom-internal-token', value: internalToken }
      ]
    }
    template: {
      containers: [
        {
          name: 'loom-copilot-maf'
          image: '${acrLoginServer}/loom-copilot-maf:${imageTag}'
          env: [
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
            { name: 'AZURE_CLIENT_ID', value: uamiClientId }
            { name: 'LOOM_TIER', value: 'maf' }
            { name: 'AZURE_CLOUD', value: 'AzureUSGovernment' }
            // IL5 collapses to GCC-High (same AzureUSGovernment endpoints).
            { name: 'LOOM_CLOUD', value: boundary == 'IL5' ? 'GCC-High' : boundary }
            { name: 'LOOM_CLOUD_BOUNDARY', value: boundary }
            // Gov AOAI direct — the whole reason this tier exists.
            { name: 'LOOM_AOAI_ENDPOINT', value: aoaiEndpoint }
            { name: 'LOOM_AOAI_DEPLOYMENT', value: aoaiDeployment }
            { name: 'LOOM_AOAI_API_VERSION', value: aoaiApiVersion }
            { name: 'LOOM_AOAI_AUDIENCE', value: 'https://cognitiveservices.azure.us' }
            // Console internal callback for tool dispatch (same handlers + OBO).
            { name: 'LOOM_CONSOLE_ENDPOINT', value: consoleInternalEndpoint }
            { name: 'LOOM_INTERNAL_TOKEN', secretRef: 'loom-internal-token' }
            { name: 'OTEL_RESOURCE_ATTRIBUTES', value: 'service.name=loom-copilot-maf,csa-loom.app=copilot-maf,csa-loom.tier=maf' }
          ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/health', port: 3100 }
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/health', port: 3100 }
              periodSeconds: 10
              failureThreshold: 3
              initialDelaySeconds: 5
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
        rules: [
          {
            name: 'http-rule'
            http: { metadata: { concurrentRequests: '20' } }
          }
        ]
      }
    }
  }
}

output mafAppId string = mafApp.id
output mafAppName string = mafApp.name
// Internal endpoint the Console reads as LOOM_MAF_ENDPOINT. Container Apps
// internal ingress is reachable over its FQDN from inside the environment.
output mafInternalEndpoint string = 'https://${mafApp.properties.configuration.ingress.fqdn}'
