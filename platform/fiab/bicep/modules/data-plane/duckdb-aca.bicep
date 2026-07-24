// CSA Loom — N2b/N3 loom-duckdb: the DuckDB serving tier + Arrow Flight SQL wire.
//
// Backs LOOM_DUCKDB_URL (HTTP, Arrow IPC) and LOOM_FLIGHTSQL_URL (gRPC Flight
// SQL). An embedded DuckDB with the azure / httpfs / delta / iceberg extensions
// reads Delta, Iceberg and Parquet IN PLACE on the deployment's own ADLS Gen2:
// the "fast path" tier BELOW Spark (sub-second cold start instead of 1–5 min)
// and the ADBC/JDBC serving wire that replaces row-by-row ODBC serialization
// with Arrow RecordBatches.
//
// Azure-native / OSS only. DuckDB is a single embedded binary and its
// extensions are baked into the image at build time, so the whole capability
// runs DISCONNECTED in an IL5 / air-gapped enclave. No Microsoft Fabric, no
// OneLake, no Power BI, no SaaS query service (.claude/rules/no-fabric-dependency.md).
//
// SECURITY POSTURE
//   - INTERNAL ingress only. HTTP is reached solely by the Console BFF
//     (/api/duckdb/*), which authenticates the caller and writes a data-access
//     audit row per query. Flight requires a short-lived, Entra-scoped ticket
//     the BFF mints (and audits) — there is no anonymous path.
//   - IDENTITY-BASED storage auth: a user-assigned managed identity with
//     **Storage Blob Data Reader** on the DLZ lake, declared IN THIS MODULE via
//     a guarded guid() role assignment. NO storage keys, NO SAS, NO connection
//     strings. The engine is read-only by construction (app/sqlguard.py).
//   - The Flight ticket signing key is injected as a Key Vault secretRef, never
//     as a literal app setting.
//
// R0 PARAM-CAP RULE: admin-plane/main.bicep is at the ARM 256-parameter
// ceiling, so this module takes a single typed CONFIG-OBJECT bag and deploys
// OUT OF BAND (standalone entrypoint, orphan-allowlisted in
// scripts/ci/check-bicep-sync.mjs) exactly like the sibling
// data-plane/iceberg-catalog-aca.bicep.
//
//   az deployment group create -g <admin-rg> \
//     -f platform/fiab/bicep/modules/data-plane/duckdb-aca.bicep \
//     -p location=<region> \
//        duckdbConfig='{ "environmentId": "<cae-id>", "uamiId": "<uami-id>", \
//                        "uamiPrincipalId": "<uami-principal-id>", \
//                        "acrLoginServer": "<acr>.azurecr.io", \
//                        "image": "<acr>.azurecr.io/loom-duckdb:<tag>", \
//                        "lakeStorageAccountName": "<dlz-adls-account>" }'
//   # then: az containerapp update -n <console> -g <admin-rg> --set-env-vars \
//   #         LOOM_DUCKDB_URL=https://<this-app-fqdn> \
//   #         LOOM_FLIGHTSQL_URL=grpc://<this-app-fqdn>:8815

targetScope = 'resourceGroup'

@description('Container App name (DNS-label safe, <= 32 chars).')
@maxLength(32)
param name string = 'loom-duckdb'

@description('Deployment region (e.g. usgovvirginia / centralus).')
param location string = resourceGroup().location

@description('''R0 config bag — every setting for the DuckDB serving tier in ONE typed object (admin-plane/main.bicep is at the ARM 256-param cap, so no new top-level params are added anywhere).

Required keys:
  environmentId          Container Apps managed-environment resource id (in-VNet).
  uamiId                 User-assigned managed identity RESOURCE id (ACR pull + lake read).
  uamiPrincipalId        That identity's PRINCIPAL (object) id — used for the role assignment.
  acrLoginServer         ACR login server, e.g. acrloom.azurecr.io.
  image                  loom-duckdb container image (pin an explicit tag, never :latest).
  lakeStorageAccountName DLZ ADLS Gen2 account the engine reads Delta/Iceberg/Parquet from.

Optional keys:
  targetPort             Internal HTTP ingress port (default 8080).
  flightPort             Flight SQL gRPC port (default 8815). Set flightEnabled=false to disable.
  flightEnabled          Default true — the ADBC/JDBC serving wire.
  ticketSecretUri        Key Vault secret URI holding the Flight ticket HMAC key.
                         Empty => Flight runs on in-VNet trust and every access
                         row is honestly marked ticketVerified:false.
  maxRows                Hard per-response row cap (default 200000).
  threads / memoryLimit  Engine sizing (defaults 4 / '3GB').
  minReplicas            Default 1 — the serving tier is interactive (never scale-to-zero).
  maxReplicas            Default 3.
  cpu / memory           Container resources (default 2.0 vCPU / 4Gi).
  assignLakeRole         Set false to skip the in-module role assignment when the
                         identity is granted out-of-band by an estate policy.''')
param duckdbConfig object

@description('Compliance/cost tags. The loom-next-level tag is unioned in.')
param complianceTags object = {}

// ── Config-bag unpacking (typed locals; every optional key has a real default) ─
var environmentId = duckdbConfig.environmentId
var uamiId = duckdbConfig.uamiId
var uamiPrincipalId = duckdbConfig.uamiPrincipalId
var acrLoginServer = duckdbConfig.acrLoginServer
var image = duckdbConfig.image
var lakeStorageAccountName = duckdbConfig.lakeStorageAccountName
var targetPort = int(duckdbConfig.?targetPort ?? 8080)
var flightPort = int(duckdbConfig.?flightPort ?? 8815)
var flightEnabled = bool(duckdbConfig.?flightEnabled ?? true)
var ticketSecretUri = string(duckdbConfig.?ticketSecretUri ?? '')
var maxRows = int(duckdbConfig.?maxRows ?? 200000)
var threads = int(duckdbConfig.?threads ?? 4)
var memoryLimit = string(duckdbConfig.?memoryLimit ?? '3GB')
var minReplicas = int(duckdbConfig.?minReplicas ?? 1)
var maxReplicas = int(duckdbConfig.?maxReplicas ?? 3)
var cpu = string(duckdbConfig.?cpu ?? '2.0')
var memory = string(duckdbConfig.?memory ?? '4Gi')
var assignLakeRole = bool(duckdbConfig.?assignLakeRole ?? true)

var tags = union(complianceTags, { 'loom-next-level': 'true' })

// Storage Blob Data Reader — the serving tier only READS lake files. The SQL
// guard in the app refuses every write verb, and READER makes that structural
// rather than advisory. Built-in role id is cloud-invariant.
var storageBlobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'

resource lake 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {
  name: lakeStorageAccountName
}

// Guarded guid() name — deterministic per (scope, identity, role) so a
// re-deploy is idempotent and two modules granting the same pair never collide.
resource lakeReadRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (assignLakeRole) {
  name: guid(lake.id, uamiPrincipalId, storageBlobDataReaderRoleId)
  scope: lake
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderRoleId)
    principalId: uamiPrincipalId
    principalType: 'ServicePrincipal'
  }
}

var baseEnv = [
  // Identity-based ADLS access — DuckDB's CREDENTIAL_CHAIN Azure secret
  // authenticates as the UAMI via IMDS. No account key, no SAS anywhere.
  { name: 'LOOM_LAKE_ACCOUNT', value: lakeStorageAccountName }
  { name: 'LOOM_DUCKDB_EXT_DIR', value: '/opt/duckdb-extensions' }
  { name: 'LOOM_DUCKDB_MAX_ROWS', value: string(maxRows) }
  { name: 'LOOM_DUCKDB_THREADS', value: string(threads) }
  { name: 'LOOM_DUCKDB_MEMORY_LIMIT', value: memoryLimit }
  { name: 'LOOM_FLIGHT_ENABLED', value: flightEnabled ? '1' : '0' }
  { name: 'LOOM_FLIGHT_PORT', value: string(flightPort) }
]

var envVars = empty(ticketSecretUri) ? baseEnv : concat(baseEnv, [
  { name: 'LOOM_FLIGHT_TICKET_SECRET', secretRef: 'flight-ticket-secret' }
])

// Pinned to the same Container Apps api-version the sibling ACA modules use.
resource app 'Microsoft.App/containerApps@2025-02-02-preview' = {
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
    environmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: empty(ticketSecretUri) ? [] : [
        {
          name: 'flight-ticket-secret'
          keyVaultUrl: ticketSecretUri
          identity: uamiId
        }
      ]
      ingress: {
        // INTERNAL only — the Console BFF is the sole door. `http2` transport so
        // the SAME ingress serves the Flight gRPC additionalPortMapping below.
        external: false
        targetPort: targetPort
        transport: 'auto'
        additionalPortMappings: flightEnabled ? [
          {
            external: false
            targetPort: flightPort
            exposedPort: flightPort
          }
        ] : []
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
          name: name
          image: image
          env: envVars
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/health', port: targetPort }
              initialDelaySeconds: 15
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/health', port: targetPort }
              initialDelaySeconds: 5
              periodSeconds: 10
              failureThreshold: 6
            }
          ]
        }
      ]
      // NOT scale-to-zero: this is the interactive tier — a cold start would
      // hand back the very latency it exists to remove. Cost ~$120–240/mo/cloud.
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-concurrency'
            http: { metadata: { concurrentRequests: '20' } }
          }
        ]
      }
    }
  }
  dependsOn: assignLakeRole ? [ lakeReadRole ] : []
}

@description('Internal FQDN — set on the Console app as LOOM_DUCKDB_URL (prefix https://).')
output fqdn string = app.properties.configuration.ingress.fqdn

@description('Flight SQL endpoint — set on the Console app as LOOM_FLIGHTSQL_URL. Empty when the Flight wire is disabled.')
output flightEndpoint string = flightEnabled ? 'grpc://${app.properties.configuration.ingress.fqdn}:${flightPort}' : ''

@description('Container App resource id.')
output appId string = app.id

@description('True when Flight tickets are cryptographically verified (a Key Vault signing key is wired). False => in-VNet trust, and every access row says so.')
output flightTicketsVerified bool = !empty(ticketSecretUri)
