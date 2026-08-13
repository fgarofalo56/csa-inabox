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

@description('Storage account that holds the transform artifacts container (manifest.json / run_results.json / plan snapshots). Bound unconditionally as LOOM_TRANSFORM_ARTIFACTS_ACCOUNT — the runner is wired to its artifact store on every topology. Empty only when the deployment genuinely has no lake, in which case artifacts stay in the per-run temp dir and are returned inline to the Console.')
param artifactsStorageAccountName string = ''

@description('App Insights connection string')
param appInsightsConnectionString string

@description('Compliance tags')
param complianceTags object

// The lake grant does NOT live here. An `existing` storage reference declared
// inside this module resolves in the APP's resource group, and the lake is not
// there — it is in the DLZ RG, and on a dlz-attach estate in another
// subscription entirely. Declaring it here is what broke the Commercial deploy
// on 2026-08-13 the moment this runner was activated:
//
//   transform-runner -> DeploymentFailed
//     -> ResourceNotFound: …/storageAccounts/saloomdefault… under resource
//        group 'rg-csa-loom-admin-centralus' was not found
//
// The grant now lives in data-plane/transform-runner-lake-rbac.bicep, which the
// orchestrator invokes with an explicit `scope: resourceGroup(<lakeRg>)` — the
// same pattern the other six lake consumers in admin-plane already used.
//
// The BINDING stays here: LOOM_TRANSFORM_ARTIFACTS_ACCOUNT below is a plain
// string, so the runner is wired to its artifact store on EVERY topology,
// including the ones where this deployment cannot create the role assignment
// (auto-bind-by-default.md — bind always, grant where it is possible).

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
