// CSA Loom — Microsoft Presidio sidecar
// PII redaction service. Deployed as a Container App alongside Loom
// Copilot in Gov boundaries where Azure AI Content Safety isn't GA
// or where PII redaction needs to be source-of-truth.
//
// Image: vendor-pinned `mcr.microsoft.com/presidio/analyzer:latest`
// and `mcr.microsoft.com/presidio/anonymizer:latest`. Operator
// pre-pulls + re-tags to the customer ACR for boundary-local availability.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Container Apps Environment ID')
param caeId string

@description('ACR login server (image pulled from here for boundary-local availability)')
param acrLoginServer string

@description('UAMI ID for the Presidio sidecar (ACR pull access)')
param uamiId string

@description('UAMI client ID. Reserved for v3.x — Presidio currently authenticates outbound calls via uamiId; clientId will be wired for federated identity workflows.')
#disable-next-line no-unused-params
param uamiClientId string

@description('App Insights connection string')
param appInsightsConnectionString string

@description('CSA Loom boundary tag')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string

@description('Compliance tags')
param complianceTags object

// Analyzer service
resource analyzer 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: 'loom-presidio-analyzer'
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
        external: false
        targetPort: 3000
        transport: 'http'
        allowInsecure: false
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
          name: 'analyzer'
          image: '${acrLoginServer}/presidio/analyzer:2.2.358'
          env: [
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
            { name: 'CSA_LOOM_BOUNDARY', value: boundary }
            { name: 'LOOM_TIER', value: 'sidecar' }
            { name: 'OTEL_RESOURCE_ATTRIBUTES', value: 'service.name=loom-presidio-analyzer,csa-loom.app=presidio,csa-loom.tier=analyzer' }
          ]
          resources: { cpu: json('1.0'), memory: '2Gi' }
          probes: [
            { type: 'Liveness', httpGet: { path: '/health', port: 3000 }, periodSeconds: 30, failureThreshold: 3 }
            { type: 'Readiness', httpGet: { path: '/health', port: 3000 }, periodSeconds: 10, initialDelaySeconds: 10 }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 4 }
    }
  }
}

// Anonymizer service
resource anonymizer 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: 'loom-presidio-anonymizer'
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
        external: false
        targetPort: 3000
        transport: 'http'
        allowInsecure: false
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
          name: 'anonymizer'
          image: '${acrLoginServer}/presidio/anonymizer:2.2.358'
          env: [
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
            { name: 'CSA_LOOM_BOUNDARY', value: boundary }
            { name: 'LOOM_TIER', value: 'sidecar' }
            { name: 'OTEL_RESOURCE_ATTRIBUTES', value: 'service.name=loom-presidio-anonymizer,csa-loom.app=presidio,csa-loom.tier=anonymizer' }
          ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
          probes: [
            { type: 'Liveness', httpGet: { path: '/health', port: 3000 }, periodSeconds: 30, failureThreshold: 3 }
            { type: 'Readiness', httpGet: { path: '/health', port: 3000 }, periodSeconds: 10, initialDelaySeconds: 5 }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 4 }
    }
  }
}

output analyzerEndpoint string = 'https://${analyzer.properties.configuration.ingress.fqdn}'
output anonymizerEndpoint string = 'https://${anonymizer.properties.configuration.ingress.fqdn}'
