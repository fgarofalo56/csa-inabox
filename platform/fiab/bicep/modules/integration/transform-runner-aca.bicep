// CSA Loom — integration/transform-runner-aca.bicep  (loom-next-level N4)
//
// The dual-engine transformation runtime behind the `transformation-project`
// item: ONE Container App carrying BOTH dbt-core (the ecosystem default, kept
// for continuity) and SQLMesh (virtual data environments + Terraform-style
// plan/apply + column-level model diff), plus the Microsoft ODBC Driver 18 the
// Synapse / Fabric adapters need.
//
// Relationship to `integration/dbt-runner.bicep`: that app stays as-is for the
// existing `dbt-job` item. This one is additive — new `transformation-project`
// items target it, and it surfaces `target/manifest.json` in exactly the shape
// the Console's L6 dbt manifest-lineage parser already consumes, so lineage
// keeps flowing with no parser change.
//
// Identity-based auth ONLY: the app runs as the Console UAMI (already holds the
// Synapse SQL / Databricks / ADLS data-plane access) and authenticates over
// ODBC / the Azure SDK with that identity. There are NO storage account keys,
// NO connection strings, and NO secrets in app settings.
//
// No Fabric dependency: Synapse dedicated SQL pool, Databricks SQL, and
// DuckDB-over-ADLS are the default engines; the bundled `dbt-fabric` adapter is
// reachable only when a project explicitly selects it.
//
// SOVEREIGN MOAT: OSS Python on ACA with INTERNAL ingress inside the
// deployment's own VNet, state stored in the target engine itself. No dbt Cloud,
// no Tobiko Cloud, no SaaS control plane — the full capability runs
// DISCONNECTED in an IL5 / air-gapped enclave.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Container Apps Environment ID')
param caeId string

@description('ACR login server (image pulled from here for boundary-local availability)')
param acrLoginServer string

@description('loom-transform-runner image tag in ACR')
param imageTag string = 'v0.1'

@description('Runner UAMI resource ID (ACR pull + Synapse/Databricks/ADLS token source)')
param uamiId string

@description('Runner UAMI client ID (injected as AZURE_CLIENT_ID for managed-identity auth)')
param uamiClientId string

@description('Runner UAMI principal (object) ID — used for the artifact-store role assignment. Empty skips the grant.')
param uamiPrincipalId string = ''

@description('Storage account that holds the transform artifacts container (manifest.json / run_results.json / plan snapshots). Empty skips the role assignment; artifacts then stay in the per-run temp dir and are returned inline to the Console.')
param artifactsStorageAccountName string = ''

@description('App Insights connection string')
param appInsightsConnectionString string

@description('Compliance tags')
param complianceTags object

// Storage Blob Data Contributor — the runner writes dbt/SQLMesh artifacts
// (target/manifest.json, run_results.json, plan snapshots) to the deployment's
// own ADLS so L6 lineage + plan history survive the ephemeral container. The
// guid() name is derived from (scope, principal, role) so a re-deploy — or an
// identical grant already made elsewhere for the same Console UAMI — collapses
// onto the SAME assignment instead of erroring on a duplicate.
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var grantArtifactsAccess = !empty(artifactsStorageAccountName) && !empty(uamiPrincipalId)

resource artifactsStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = if (grantArtifactsAccess) {
  name: empty(artifactsStorageAccountName) ? 'placeholderaccount' : artifactsStorageAccountName
}

resource artifactsRbac 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (grantArtifactsAccess) {
  name: guid(artifactsStorage.id, uamiPrincipalId, storageBlobDataContributorRoleId)
  scope: artifactsStorage
  properties: {
    principalId: uamiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
  }
}

resource transformRunner 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: 'loom-transform-runner'
  location: location
  tags: union(complianceTags, { 'loom-next-level': 'true' })
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
          name: 'loom-transform-runner'
          image: '${acrLoginServer}/loom-transform-runner:${imageTag}'
          env: [
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
            { name: 'AZURE_CLIENT_ID', value: uamiClientId }
            { name: 'OTEL_RESOURCE_ATTRIBUTES', value: 'service.name=loom-transform-runner,csa-loom.app=transform-runner' }
            { name: 'LOOM_TRANSFORM_ARTIFACTS_ACCOUNT', value: artifactsStorageAccountName }
          ]
          resources: { cpu: json('0.75'), memory: '1.5Gi' }
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
        // min 1: `plan` is an INTERACTIVE surface (the wizard re-plans as the
        // operator changes environment/selection), so a cold start on every
        // plan would make the impact grid unusable. Cost of the always-on
        // replica: ~$100-200/month/cloud (documented in the app README).
        minReplicas: 1
        maxReplicas: 4
        rules: [
          {
            name: 'http-rule'
            http: { metadata: { concurrentRequests: '4' } }
          }
        ]
      }
    }
  }
}

output transformRunnerAppId string = transformRunner.id
output transformRunnerAppName string = transformRunner.name
// Internal endpoint the Console reads as LOOM_TRANSFORM_RUNNER_URL.
output transformRunnerInternalEndpoint string = 'https://${transformRunner.properties.configuration.ingress.fqdn}'
