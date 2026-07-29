// CSA Loom — data-plane/loom-trino-aca.bicep  (N7e, default-ON Federated SQL)
//
// The **Federated SQL (Trino)** engine behind SQL Lab, as a scale-to-zero
// INTERNAL-ingress Container App. This is the DEFAULT-ON path
// (.claude/rules — every feature ships enabled, opt-OUT); the multi-node
// private-AKS module next door (`loom-trino-aks.bicep`) is now the OPT-IN
// SCALE-OUT upgrade for large federations, not the only way to get Trino.
//
// WHY THIS SHAPE
//   Trino's supported single-process deployment (`coordinator=true` +
//   `node-scheduler.include-coordinator=true`) runs the whole engine in ONE
//   container. That means the "spendy runtime" objection to default-ON Trino
//   disappears: with `minReplicas: 0` the engine costs NOTHING while nobody is
//   querying, and Container Apps activates it on the first request from the
//   Console BFF. An AKS cluster cannot do this — its system node pool cannot
//   scale below 1, so AKS bills an always-on node whether or not anyone runs a
//   federated join. See the README for the cost comparison.
//
// SECURITY POSTURE (unchanged from the AKS module)
//   - INTERNAL ingress only. The engine is never public. The sole door is the
//     Console BFF at /api/sql/trino, which authenticates the caller, forwards
//     the principal as the Trino user, and writes a data-access audit row per
//     query (lib/azure/trino-client.ts).
//   - IDENTITY-BASED storage auth. Trino's native Azure filesystem runs with
//     `azure.auth-type=DEFAULT`, which resolves the user-assigned managed
//     identity named by AZURE_CLIENT_ID. NO storage keys, NO SAS, NO connection
//     strings in app settings. The in-module role assignment is Storage Blob
//     Data **Reader** — read-only by construction.
//   - Federated sources that need a password are supplied as Key Vault
//     secretRef env vars (LOOM_TRINO_CATALOG_<NAME>), never literals.
//
// AZURE-NATIVE / OSS ONLY. Trino is Apache-2.0 and self-hosted in the
// deployment's own VNet; it reads the deployment's own ADLS Gen2 through the N1
// Iceberg REST Catalog. No Starburst Galaxy, no Athena, no Microsoft Fabric /
// OneLake / Power BI on any path (.claude/rules/no-fabric-dependency.md), so
// the capability runs DISCONNECTED in a GCC-High / IL5 enclave.
//
// ── Rollback ───────────────────────────────────────────────────────────────
// Disable: set `loomBackends.trino = 'disabled'` and redeploy (removes the
// Container App; LOOM_TRINO_URL is emitted empty and SQL Lab's engine picker
// honest-gates the Trino option while DuckDB / Synapse Serverless keep serving).
// No state migration either way — Trino holds no durable state of its own.

targetScope = 'resourceGroup'

@description('Container App name (DNS-label safe, <= 32 chars).')
@maxLength(32)
param name string = 'loom-trino'

@description('Deployment region (e.g. centralus / usgovvirginia).')
param location string

@description('Container Apps managed-environment (CAE) resource id — the console VNet-integrated env.')
param caeId string

@description('ACR login server, e.g. acrloomk6mvh5sm6z7do.azurecr.io.')
param acrLoginServer string

@description('loom-trino image tag in ACR (apps/loom-trino). Pin an explicit tag, never :latest.')
param imageTag string = 'v0.1'

@description('User-assigned managed identity RESOURCE id — ACR pull + lake read (the Console UAMI on a push-button deploy).')
param uamiId string

@description('That identity\'s CLIENT id — injected as AZURE_CLIENT_ID so Trino\'s native Azure filesystem (azure.auth-type=DEFAULT) authenticates as it.')
param uamiClientId string

@description('That identity\'s PRINCIPAL (object) id — used for the lake read grant. Empty skips the grant.')
param uamiPrincipalId string = ''

@description('DLZ ADLS Gen2 account the Iceberg connector reads Delta/Iceberg/Parquet from. Empty skips the grant (the engine still serves its jmx/memory catalogs and any operator-supplied federation catalog).')
param lakeStorageAccountName string = ''

@description('N1 Iceberg REST Catalog base URL (LOOM_ICEBERG_CATALOG_URL). Empty => no lake catalog is rendered; the engine still starts and serves. Never fabricated.')
param icebergCatalogUrl string = ''

@description('IRC path prefix. Default matches the Unity-Catalog-shaped endpoint the Console client uses (lib/azure/iceberg-catalog-client.ts DEFAULT_IRC_PREFIX).')
param icebergCatalogPrefix string = '/api/2.1/unity-catalog/iceberg'

@description('IRC warehouse identifier the Trino Iceberg catalog binds to.')
param icebergCatalogWarehouse string = 'loom'

@description('App Insights connection string (OpenTelemetry resource attributes only — Trino itself emits JVM logs to the CAE Log Analytics workspace).')
param appInsightsConnectionString string = ''

@description('Skip the in-module lake read grant (set true when an estate policy grants it out-of-band, or when the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

@description('Container vCPU. 2.0 with 4Gi matches the baked -Xmx2G in apps/loom-trino/etc/jvm.config — keep them in step.')
param cpu string = '2.0'

@description('Container memory. 4Gi with the baked -Xmx2G leaves headroom for the JVM\'s non-heap footprint.')
param memory string = '4Gi'

@description('Minimum replicas. ZERO is the point of this module: default-ON at zero idle cost. Set 1 only when a warm engine is worth the always-on bill.')
param minReplicas int = 0

@description('Maximum replicas. A single-node Trino does not shard a query across replicas, so this bounds CONCURRENT sessions, not one query\'s parallelism.')
param maxReplicas int = 2

@description('Compliance/cost tags. The loom-next-level tag is unioned in.')
param complianceTags object = {}

// Storage Blob Data Reader — the federated engine only READS lake files. The
// built-in role id is cloud-invariant. Guarded guid() name is deterministic per
// (scope, principal, role) so a re-deploy is idempotent and a duplicate grant
// from another module collapses onto the same assignment.
var storageBlobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
var grantLakeRead = !empty(lakeStorageAccountName) && !empty(uamiPrincipalId) && !skipRoleGrants

var tags = union(complianceTags, { 'loom-next-level': 'true' })

resource lake 'Microsoft.Storage/storageAccounts@2024-01-01' existing = if (grantLakeRead) {
  name: empty(lakeStorageAccountName) ? 'placeholderaccount' : lakeStorageAccountName
}

resource lakeReadRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (grantLakeRead) {
  name: guid(lake.id, uamiPrincipalId, storageBlobDataReaderRoleId)
  scope: lake
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderRoleId)
    principalId: uamiPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource trino 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: name
  location: location
  tags: tags
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
        // VNet-internal only — reached by the Console BFF over the CAE network.
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
          name: 'trino'
          image: '${acrLoginServer}/loom-trino:${imageTag}'
          env: concat(
            [
              // Resolves the user-assigned identity for azure.auth-type=DEFAULT.
              { name: 'AZURE_CLIENT_ID', value: uamiClientId }
              // Consumed by apps/loom-trino/docker-entrypoint.sh to render the
              // Iceberg catalog. Empty => no catalog file is written at all
              // (SHOW CATALOGS never lists a phantom source).
              { name: 'LOOM_ICEBERG_CATALOG_URL', value: icebergCatalogUrl }
              { name: 'LOOM_ICEBERG_CATALOG_PREFIX', value: icebergCatalogPrefix }
              { name: 'LOOM_ICEBERG_CATALOG_WAREHOUSE', value: icebergCatalogWarehouse }
              { name: 'LOOM_LAKE_ACCOUNT', value: lakeStorageAccountName }
              { name: 'OTEL_RESOURCE_ATTRIBUTES', value: 'service.name=loom-trino,csa-loom.app=trino' }
            ],
            empty(appInsightsConnectionString) ? [] : [
              { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
            ]
          )
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          probes: [
            {
              // /v1/info is Trino's own readiness surface: it reports
              // {"starting": true} until the server can accept queries, so a
              // cold-started replica is only routed traffic once it can serve.
              type: 'Startup'
              httpGet: { path: '/v1/info', port: 8080 }
              periodSeconds: 5
              // JVM boot from a cold replica is ~20-40s; 36 x 5s = 3 min of
              // headroom before Container Apps gives up on the replica.
              failureThreshold: 36
              initialDelaySeconds: 5
            }
            {
              type: 'Readiness'
              httpGet: { path: '/v1/info', port: 8080 }
              periodSeconds: 10
              failureThreshold: 3
            }
            {
              type: 'Liveness'
              httpGet: { path: '/v1/info', port: 8080 }
              periodSeconds: 30
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        // minReplicas 0 — the whole reason this module exists. Idle cost is the
        // Container Apps consumption floor for a scaled-to-zero app: nothing.
        // The first query after an idle period pays a JVM cold start, which the
        // BFF budgets for (TRINO_FETCH_TIMEOUT_MS in lib/azure/trino-client.ts).
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-rule'
            http: { metadata: { concurrentRequests: '8' } }
          }
        ]
      }
    }
  }
}

@description('Container App resource id.')
output trinoAppId string = trino.id

@description('Container App name.')
output trinoAppName string = trino.name

@description('Internal coordinator endpoint the Console reads as LOOM_TRINO_URL.')
output trinoInternalEndpoint string = 'https://${trino.properties.configuration.ingress.fqdn}'

@description('True when the in-module lake read grant was created.')
output lakeRoleAssigned bool = grantLakeRead
