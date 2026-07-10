// CSA Loom — Loom OneLake namespace/catalog service Container App (HYP-1 / HYP-16).
//
// Backs LOOM_ONELAKE_URL for the console's /api/onelake/resolve BFF proxy. The
// service owns one loom://<tenant>/<workspace>/<item>/<path> address space and
// resolves it to the REAL physical ADLS Gen2 location (abfss + SAS-less
// managed-identity passthrough auth) every Loom engine already speaks, backed
// by a Cosmos registry (createIfNotExists). Azure-native only — no Microsoft
// Fabric / OneLake / Power BI dependency (.claude/rules/no-fabric-dependency.md);
// the service NEVER reaches an onelake.dfs.fabric.microsoft.com host.
//
// Internal ingress only (reachable from the console over the CAE VNet, never
// public). minReplicas:1 — namespace resolution is on the hot path, so unlike
// the scale-to-zero script-runner this keeps one warm replica.
//
// LEAST-PRIVILEGE identity (the ACA app exposes its UAMI to in-container code
// via IMDS): a dedicated uami-loom-onelake holding ONLY
//   - AcrPull (image pull),
//   - Storage Blob Data Contributor on the DLZ lake (resolve + register), and
//   - Cosmos DB Built-in Data Contributor on the registry containers.
// Nothing else. The role assignments + the UAMI are declared in main.bicep
// alongside the other app UAMIs (script-runner/dbt-runner pattern); this module
// only consumes the UAMI id.
//
// ---------------------------------------------------------------------------
// TODO — wire into platform/fiab/bicep/modules/admin-plane/main.bicep
//   (the HYP-16 / platform workflow owns main.bicep; do NOT edit it from here,
//    to avoid conflicts across the parallel Hyperscale-band PRs):
//
//     var oneLakeActive = oneLakeEnabled
//       && containerPlatform == 'containerApps' && deployAppsEnabled
//
//     resource oneLakeUami 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = if (oneLakeActive) {
//       name: 'uami-loom-onelake'
//       location: location
//     }
//     // + AcrPull on the registry, Storage Blob Data Contributor on the DLZ lake,
//     //   and Cosmos SQL role 'Cosmos DB Built-in Data Contributor' on the account
//     //   (all guarded by `if (oneLakeActive && !skipRoleGrants)`).
//
//     module loomOneLake '../compute/loom-onelake-app.bicep' = if (oneLakeActive) {
//       name: 'loom-onelake'
//       params: {
//         name: 'loom-onelake'
//         location: location
//         environmentId: containerPlatform_env.outputs.environmentId
//         oneLakeUamiId: oneLakeUami.outputs.id
//         oneLakeUamiClientId: oneLakeUami.properties.clientId
//         acrLoginServer: registry.outputs.acrLoginServer
//         image: '${registry.outputs.acrLoginServer}/loom-onelake:${appImageTags.oneLake}'
//         defaultAccount: dlzLakeAccountName          // the DLZ ADLS Gen2 account
//         cosmosEndpoint: cosmosAccount.outputs.endpoint
//         azureCloud: environment().name
//         complianceTags: complianceTags
//       }
//     }
//
//   And add to the console env array (near LOOM_DBT_RUNNER_URL / LOOM_SCRIPT_RUNNER_URL):
//     { name: 'LOOM_ONELAKE_URL', value: oneLakeActive ? 'https://${loomOneLake!.outputs.fqdn}' : '' }
//   (one env line — no new main.bicep PARAM, so this does not touch the 256-param ceiling.)
// ---------------------------------------------------------------------------

targetScope = 'resourceGroup'

@description('Container App name (DNS-label safe, <= 32 chars).')
@maxLength(32)
param name string

@description('Deployment region (e.g. centralus / usgovvirginia).')
param location string

@description('Container Apps managed-environment (CAE) resource id — the console VNet-integrated env.')
param environmentId string

@description('UserAssigned UAMI resource id — assigned to the app for ACR pull AND the app identity. MUST be a dedicated least-privilege uami-loom-onelake: AcrPull + Storage Blob Data Contributor on the DLZ lake + Cosmos Built-in Data Contributor on the registry, and NOTHING else (the ACA app exposes this identity to in-container code via IMDS).')
param oneLakeUamiId string

@description('Client id of the same UAMI — set as LOOM_UAMI_CLIENT_ID so the Cosmos AAD credential chain binds to it.')
param oneLakeUamiClientId string

@description('ACR login server, e.g. acrloomk6mvh5sm6z7do.azurecr.io.')
param acrLoginServer string

@description('Container image reference (the loom-onelake image in ACR — pin an explicit tag, never :latest).')
param image string

@description('DLZ ADLS Gen2 account name the convention/relative loom:// paths resolve onto (LOOM_ONELAKE_DEFAULT_ACCOUNT).')
param defaultAccount string

@description('Convention-fallback container (LOOM_ONELAKE_DEFAULT_CONTAINER). Default bronze.')
param defaultContainer string = 'bronze'

@description('Cosmos account endpoint for the namespace registry (LOOM_ONELAKE_COSMOS_ENDPOINT). Empty => the service resolves by convention only and honest-503s on /register.')
param cosmosEndpoint string = ''

@description('Cosmos database id for the registry (default loom).')
param cosmosDatabase string = 'loom'

@description('Active Azure cloud name (environment().name) — flips the DFS suffix for Gov (AzureUSGovernment => dfs.core.usgovcloudapi.net).')
param azureCloud string = 'AzureCloud'

@description('Internal ingress target port the service listens on (matches PORT env / server.mjs).')
param targetPort int = 8080

@description('Compliance/cost tags.')
param complianceTags object = {}

// Non-secret env only — the service authenticates to Cosmos + ADLS with its
// UAMI (AAD), so there is NO connection string / key to store as a secret.
var envVars = concat(
  [
    { name: 'PORT', value: string(targetPort) }
    { name: 'LOOM_ONELAKE_DEFAULT_ACCOUNT', value: defaultAccount }
    { name: 'LOOM_ONELAKE_DEFAULT_CONTAINER', value: defaultContainer }
    { name: 'LOOM_UAMI_CLIENT_ID', value: oneLakeUamiClientId }
    { name: 'AZURE_CLOUD', value: azureCloud }
    { name: 'LOOM_ONELAKE_COSMOS_DATABASE', value: cosmosDatabase }
  ],
  empty(cosmosEndpoint) ? [] : [
    { name: 'LOOM_ONELAKE_COSMOS_ENDPOINT', value: cosmosEndpoint }
  ]
)

// Pinned to the same Container Apps api-version the sibling ACA modules use
// (script-runner-app.bicep, mcp-catalog-app.bicep) — bicep/runtime sync.
resource app 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: name
  location: location
  tags: complianceTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${oneLakeUamiId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        // INTERNAL only — reached by the Console BFF over the CAE network.
        external: false
        targetPort: targetPort
        transport: 'auto'
      }
      registries: [
        {
          server: acrLoginServer
          identity: oneLakeUamiId
        }
      ]
    }
    template: {
      containers: [
        {
          name: name
          image: image
          env: envVars
          // 0.5 vCPU / 1Gi — the resolver is a Cosmos point-read + string map;
          // memory footprint is small and steady.
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: targetPort
                scheme: 'HTTP'
              }
              initialDelaySeconds: 10
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health'
                port: targetPort
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 15
              failureThreshold: 6
            }
          ]
        }
      ]
      // NOT scale-to-zero: namespace resolution is on the hot path (every engine
      // resolves loom:// before a read/write), so keep one warm replica.
      scale: {
        minReplicas: 1
        maxReplicas: 4
      }
    }
  }
}

@description('Internal FQDN of the deployed OneLake service (Console reads it as LOOM_ONELAKE_URL, prefixed https://).')
output fqdn string = app.properties.configuration.ingress.fqdn

@description('Container App resource id.')
output appId string = app.id
