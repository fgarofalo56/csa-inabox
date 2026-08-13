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
//     **Storage Blob Data Reader** on the DLZ lake. NO storage keys, NO SAS, NO
//     connection strings. The engine is read-only by construction
//     (app/sqlguard.py). The GRANT is NOT made here — see BIND vs GRANT below.
//   - The Flight ticket signing key is injected as a Key Vault secretRef, never
//     as a literal app setting.
//
// BIND vs GRANT (#3357). This module BINDS the lake — LOOM_LAKE_ACCOUNT below is
// a plain string, so the engine is wired to its account on EVERY topology — and
// it makes NO role assignment. It used to declare `resource lake … existing`,
// which resolves in THIS module's resource group; the lake is in the DLZ RG, and
// on a dlz-attach estate in a different SUBSCRIPTION. That is the exact shape
// that failed two full Commercial deploys on 2026-08-13 from
// transform-runner-aca.bicep (#3333/#3329). Here it was dormant only because
// every call site passed `assignLakeRole: false` — dormant is not fixed, so the
// dereference is gone. The Storage Blob Data Reader grant now lives in
// data-plane/serving-tier-lake-rbac.bicep, which the orchestrator invokes with
// an explicit `scope: resourceGroup(<lakeRg>)`.
//
// R0 PARAM-CAP RULE: admin-plane/main.bicep is at the ARM 256-parameter
// ceiling, so this module takes a single typed CONFIG-OBJECT bag.
//
// DEPLOYED BY DEFAULT (round-2 change). It used to be an out-of-band standalone
// entrypoint, which meant LOOM_DUCKDB_URL was emitted by NO bicep anywhere and
// every DuckDB-backed surface — including the DuckLake catalog whose Postgres
// store IS deployed by default — honest-gated on `duckdb_tier_required` on a
// fresh install. `admin-plane/main.bicep` now invokes it (`duckdbTierActive`,
// var-gated, no new top-level params) and binds LOOM_DUCKDB_URL +
// LOOM_FLIGHTSQL_URL on the Console. The standalone invocation below still
// works for an out-of-band redeploy (grant the identity Storage Blob Data Reader
// on the lake separately — this module will not do it):
//
//   az deployment group create -g <admin-rg> \
//     -f platform/fiab/bicep/modules/data-plane/duckdb-aca.bicep \
//     -p location=<region> \
//        duckdbConfig='{ "environmentId": "<cae-id>", "uamiId": "<uami-id>", \
//                        "acrLoginServer": "<acr>.azurecr.io", \
//                        "image": "<acr>.azurecr.io/loom-duckdb:<tag>", \
//                        "lakeStorageAccountName": "<dlz-adls-account>" }'

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
  acrLoginServer         ACR login server, e.g. acrloom.azurecr.io.
  image                  loom-duckdb container image (pin an explicit tag, never :latest).
  lakeStorageAccountName DLZ ADLS Gen2 account the engine reads Delta/Iceberg/Parquet from.

Optional keys:
  targetPort             Internal HTTP ingress port (default 8080).
  flightPort             Flight SQL gRPC port (default 8815). Set flightEnabled=false to disable.
  flightEnabled          Default true — the ADBC/JDBC serving wire.
  flightAllowBareSql     Default true — serve DoGet(Ticket(b'SELECT ...')) for plain
                         Arrow Flight clients that never call GetFlightInfo. Set
                         false so ONLY the GetFlightInfo->handle->DoGet handshake is
                         served, which makes the single-use/TTL statement handle a
                         real replay boundary. Conformant Flight SQL / ADBC / JDBC
                         clients are unaffected either way.
  ticketSecretUri        Key Vault secret URI holding the Flight ticket HMAC key.
                         Empty => Flight runs on in-VNet trust and every access
                         row is honestly marked ticketVerified:false.
  maxRows                Hard per-response row cap (default 200000).
  threads / memoryLimit  Engine sizing (defaults 4 / '3GB').
  minReplicas            Default 1 — the serving tier is interactive (never scale-to-zero).
  maxReplicas            Default 3.
  cpu / memory           Container resources (default 2.0 vCPU / 4Gi).''')
param duckdbConfig object

@description('Compliance/cost tags. The loom-next-level tag is unioned in.')
param complianceTags object = {}

// ── Config-bag unpacking (typed locals; every optional key has a real default) ─
var environmentId = duckdbConfig.environmentId
var uamiId = duckdbConfig.uamiId
var acrLoginServer = duckdbConfig.acrLoginServer
var image = duckdbConfig.image
var lakeStorageAccountName = duckdbConfig.lakeStorageAccountName
var targetPort = int(duckdbConfig.?targetPort ?? 8080)
var flightPort = int(duckdbConfig.?flightPort ?? 8815)
var flightEnabled = bool(duckdbConfig.?flightEnabled ?? true)
var flightAllowBareSql = bool(duckdbConfig.?flightAllowBareSql ?? true)
var ticketSecretUri = string(duckdbConfig.?ticketSecretUri ?? '')
var maxRows = int(duckdbConfig.?maxRows ?? 200000)
var threads = int(duckdbConfig.?threads ?? 4)
var memoryLimit = string(duckdbConfig.?memoryLimit ?? '3GB')
var minReplicas = int(duckdbConfig.?minReplicas ?? 1)
var maxReplicas = int(duckdbConfig.?maxReplicas ?? 3)
var cpu = string(duckdbConfig.?cpu ?? '2.0')
var memory = string(duckdbConfig.?memory ?? '4Gi')

var tags = union(complianceTags, { 'loom-next-level': 'true' })

// NO `resource lake … existing` HERE, DELIBERATELY (#3357).
//
// An unscoped `existing` resolves in THIS module's resource group. The lake
// almost never lives there — single-sub puts it in the DLZ RG, dlz-attach puts
// it in a different SUBSCRIPTION — so the reference fails with ResourceNotFound
// and takes the WHOLE deployment down with it. That is exactly what happened on
// 2026-08-13 from transform-runner-aca.bicep (#3333), twice.
//
// This module carried the identical shape. It never fired only because
// admin-plane/main.bicep passed `assignLakeRole: false`, which left the
// `existing` unreferenced so ARM never resolved it. Dormant is not fixed — it is
// one boolean from the outage, which is precisely how transform-runner sat until
// `dbtRunnerImageReady` flipped.
//
// BIND stays here, GRANT moves out. `LOOM_LAKE_ACCOUNT` below is a plain string,
// so the engine is wired to its lake on EVERY topology, including ones where
// this deployment could not create a role assignment
// (.claude/rules/auto-bind-by-default.md — bind always, grant where possible).
// The Storage Blob Data Reader grant — same role, unchanged — now lives in
// data-plane/serving-tier-lake-rbac.bicep, which the orchestrator invokes with
// an explicit `scope: resourceGroup(<lakeRg>)`.

var baseEnv = [
  // Identity-based ADLS access — DuckDB's CREDENTIAL_CHAIN Azure secret
  // authenticates as the UAMI via IMDS. No account key, no SAS anywhere.
  { name: 'LOOM_LAKE_ACCOUNT', value: lakeStorageAccountName }
  { name: 'LOOM_DUCKDB_EXT_DIR', value: '/opt/duckdb-extensions' }
  { name: 'LOOM_DUCKDB_MAX_ROWS', value: string(maxRows) }
  { name: 'LOOM_DUCKDB_THREADS', value: string(threads) }
  { name: 'LOOM_DUCKDB_MEMORY_LIMIT', value: memoryLimit }
  { name: 'LOOM_FLIGHT_ENABLED', value: flightEnabled ? '1' : '0' }
  { name: 'LOOM_FLIGHT_ALLOW_BARE_SQL', value: flightAllowBareSql ? '1' : '0' }
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
}

@description('Internal FQDN — set on the Console app as LOOM_DUCKDB_URL (prefix https://).')
output fqdn string = app.properties.configuration.ingress.fqdn

@description('Flight SQL endpoint — set on the Console app as LOOM_FLIGHTSQL_URL. Empty when the Flight wire is disabled.')
output flightEndpoint string = flightEnabled ? 'grpc://${app.properties.configuration.ingress.fqdn}:${flightPort}' : ''

@description('Container App resource id.')
output appId string = app.id

@description('True when Flight tickets are cryptographically verified (a Key Vault signing key is wired). False => in-VNet trust, and every access row says so.')
output flightTicketsVerified bool = !empty(ticketSecretUri)
