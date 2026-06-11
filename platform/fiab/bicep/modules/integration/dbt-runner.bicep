// CSA Loom — integration/dbt-runner.bicep
// Azure-native dbt execution runtime for the Synapse dedicated SQL pool and
// (opt-in) Fabric Warehouse adapters. Synapse/Fabric have NO native "dbt task"
// the way Databricks Jobs do, so dbt-core runs here: a Container App with
// dbt-core + dbt-synapse + dbt-fabric + ODBC Driver 18 for SQL Server. The
// Console (dbt-runner.ts) POSTs a generated dbt project + commands to /run; the
// app authenticates to the pool with its managed identity (authentication=CLI)
// and returns the dbt log + run_results.
//
// The Databricks adapter does NOT use this runtime (it runs natively as a
// Databricks Job dbt_task) — this module is only required to execute the
// Synapse/Fabric targets. When absent, the Console surfaces an honest gate.
//
// No Fabric dependency: Synapse is the default ODBC target; the dbt-fabric
// adapter is bundled but only used when a user explicitly selects the Fabric
// adapter on a dbt-job item.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Container Apps Environment ID')
param caeId string

@description('ACR login server (image pulled from here for boundary-local availability)')
param acrLoginServer string

@description('dbt-runner image tag in ACR')
param imageTag string = 'v0.1'

@description('Runner UAMI resource ID (ACR pull + Synapse SQL token source)')
param uamiId string

@description('Runner UAMI client ID (injected as AZURE_CLIENT_ID for managed-identity auth)')
param uamiClientId string

@description('App Insights connection string')
param appInsightsConnectionString string

@description('Compliance tags')
param complianceTags object

resource dbtRunner 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: 'loom-dbt-runner'
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
        // VNet-internal only — reached by the Console over the CAE network.
        external: false
        targetPort: 8080
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
    }
    template: {
      containers: [
        {
          name: 'loom-dbt-runner'
          image: '${acrLoginServer}/loom-dbt-runner:${imageTag}'
          env: [
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
            { name: 'AZURE_CLIENT_ID', value: uamiClientId }
            { name: 'OTEL_RESOURCE_ATTRIBUTES', value: 'service.name=loom-dbt-runner,csa-loom.app=dbt-runner' }
          ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/health', port: 8080 }
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/health', port: 8080 }
              periodSeconds: 10
              failureThreshold: 3
              initialDelaySeconds: 5
            }
          ]
        }
      ]
      scale: {
        // Scale to zero between dbt runs — this is a batch runtime, not a hot path.
        minReplicas: 0
        maxReplicas: 3
        rules: [
          {
            name: 'http-rule'
            http: { metadata: { concurrentRequests: '5' } }
          }
        ]
      }
    }
  }
}

output dbtRunnerAppId string = dbtRunner.id
output dbtRunnerAppName string = dbtRunner.name
// Internal endpoint the Console reads as LOOM_DBT_RUNNER_URL.
output dbtRunnerInternalEndpoint string = 'https://${dbtRunner.properties.configuration.ingress.fqdn}'
