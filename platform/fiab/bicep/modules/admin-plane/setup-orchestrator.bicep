// CSA Loom — Setup Orchestrator Container App
//
// The browser-driven Setup Wizard's "Deploy" step POSTs the captured deployment
// config to this internal service (LOOM_SETUP_ORCHESTRATOR_URL on the console),
// which runs the real `az deployment sub create -f platform/fiab/bicep/main.bicep`
// for single- AND multi-subscription Data Landing Zone rollouts under its own
// identity — then reports progress the wizard polls via /api/setup/deploy-status.
//
// Modeled on mcp-catalog-app.bicep / copilot/maf.bicep: a UserAssigned-identity
// Container App with INTERNAL ingress only (reachable from the console over the
// CAE VNet, never public). Authenticated with the shared internal token. The
// orchestrator identity is granted Contributor on each TARGET subscription by
// setup-orchestrator-rbac.bicep (the multi-sub deploy-auth piece) — that grant
// is what lets it deploy across subscriptions.
//
// Azure-native (Container Apps + ARM) — no Microsoft Fabric dependency
// (no-fabric-dependency.md). On the AKS boundaries (GCC-High / IL5) the
// orchestrator deploys via the cluster GitOps manifest path instead; this
// Container App module is gated off there by the caller.

targetScope = 'resourceGroup'

@description('Container App name (DNS-label safe, <= 32 chars).')
@maxLength(32)
param name string = 'loom-setup-orchestrator'

@description('Deployment region.')
param location string

@description('Container Apps managed-environment (CAE) resource id.')
param environmentId string

@description('UserAssigned identity resource id assigned to the app (runs az deployment sub create + pulls the image). This identity must hold Contributor on every target subscription — see setup-orchestrator-rbac.bicep.')
param uamiId string

@description('UserAssigned identity client id (AZURE_CLIENT_ID inside the container).')
param uamiClientId string

@description('ACR login server the orchestrator image is pulled from (when private).')
param acrLoginServer string = ''

@description('Container image reference for the orchestrator service.')
param image string

@description('Internal ingress target port the orchestrator listens on.')
param targetPort int = 8080

@description('Shared internal token (Container Apps secret) the console presents as Bearer to authenticate to the orchestrator.')
@secure()
param internalToken string = ''

@description('ARM management endpoint for the active cloud (https://management.azure.com | https://management.usgovcloudapi.net).')
param armEndpoint string

@description('Application Insights connection string for telemetry. Empty disables.')
param appInsightsConnectionString string = ''

@description('Compliance tags.')
param complianceTags object = {}

var usesAcr = !empty(acrLoginServer) && startsWith(image, acrLoginServer)
var hasToken = !empty(internalToken)

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  tags: union(complianceTags, { 'csa-loom': 'setup-orchestrator' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${uamiId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: false
        targetPort: targetPort
        transport: 'auto'
        allowInsecure: false
        traffic: [
          { latestRevision: true, weight: 100 }
        ]
      }
      registries: usesAcr ? [
        { server: acrLoginServer, identity: uamiId }
      ] : []
      secrets: hasToken ? [
        { name: 'internal-token', value: internalToken }
      ] : []
    }
    template: {
      containers: [
        {
          name: 'orchestrator'
          image: image
          env: concat(
            [
              { name: 'AZURE_CLIENT_ID', value: uamiClientId }
              { name: 'LOOM_ARM_ENDPOINT', value: armEndpoint }
              { name: 'PORT', value: string(targetPort) }
            ],
            hasToken ? [ { name: 'LOOM_INTERNAL_TOKEN', secretRef: 'internal-token' } ] : [],
            empty(appInsightsConnectionString) ? [] : [
              { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
            ]
          )
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 2
        rules: [
          { name: 'http-rule', http: { metadata: { concurrentRequests: '20' } } }
        ]
      }
    }
  }
}

@description('Internal FQDN of the deployed Setup Orchestrator.')
output fqdn string = app.properties.configuration.ingress.fqdn

@description('Internal base URL the console wires as LOOM_SETUP_ORCHESTRATOR_URL.')
output url string = 'https://${app.properties.configuration.ingress.fqdn}'

@description('Container App resource id.')
output appId string = app.id
