// CSA Loom — N7a loom-risingwave: the stateful streaming-SQL tier (Openness T2-A).
//
// Backs LOOM_RISINGWAVE_URL. A single-node RisingWave (Apache-2.0) authors
// streaming MATERIALIZED VIEWS in SQL over Azure Event Hubs (via its Kafka
// endpoint) and sinks the maintained results to Delta/Iceberg on the
// deployment's own ADLS Gen2 (the N1 lake) or serves them over the Postgres
// wire. The tier ABOVE Azure Stream Analytics — ASA stays the LIGHT default;
// RisingWave is the stateful class (windowed joins, incremental aggregations).
//
// Azure-native / OSS only. RisingWave is a self-contained Rust binary with no
// external control plane, so the whole capability runs DISCONNECTED in an IL5 /
// air-gapped enclave against the in-boundary Event Hubs Kafka endpoint + ADLS
// Gen2. No Microsoft Fabric, no OneLake, no Power BI, no SaaS streaming service
// is in the path (.claude/rules/no-fabric-dependency.md).
//
// SECURITY POSTURE
//   - INTERNAL ingress only, transport 'tcp' on the Postgres-wire frontend port
//     (4566). The Console BFF is the sole door; every statement goes through the
//     audited /api/streaming-sql/* routes. There is no anonymous / public path.
//   - IDENTITY-BASED lake auth: a user-assigned managed identity with **Storage
//     Blob Data Contributor** on the DLZ lake (the streaming sink WRITES Delta /
//     Iceberg), declared IN THIS MODULE via a guarded guid() role assignment.
//     NO storage keys, NO SAS, NO connection strings in app settings.
//   - Source/sink credentials a specific connector still needs (e.g. an Event
//     Hubs SASL connection string on a local-auth namespace) are injected
//     per-DDL as Key-Vault-resolved values by the BFF, never baked here.
//
// R0 PARAM-CAP RULE: admin-plane/main.bicep is at the ARM 256-parameter ceiling,
// so this module takes a single typed CONFIG-OBJECT bag and deploys OUT OF BAND
// (standalone entrypoint, orphan-allowlisted in scripts/ci/check-bicep-sync.mjs)
// exactly like the sibling data-plane/duckdb-aca.bicep.
//
//   az deployment group create -g <admin-rg> \
//     -f platform/fiab/bicep/modules/data-plane/loom-risingwave-aca.bicep \
//     -p location=<region> \
//        risingwaveConfig='{ "environmentId": "<cae-id>", "uamiId": "<uami-id>", \
//                            "uamiPrincipalId": "<uami-principal-id>", \
//                            "acrLoginServer": "<acr>.azurecr.io", \
//                            "image": "<acr>.azurecr.io/loom-risingwave:<tag>", \
//                            "lakeStorageAccountName": "<dlz-adls-account>" }'
//   # then: az containerapp update -n <console> -g <admin-rg> --set-env-vars \
//   #         LOOM_RISINGWAVE_URL=<this-app-fqdn>:4566

targetScope = 'resourceGroup'

@description('Container App name (DNS-label safe, <= 32 chars).')
@maxLength(32)
param name string = 'loom-risingwave'

@description('Deployment region (e.g. usgovvirginia / centralus).')
param location string = resourceGroup().location

@description('''R0 config bag — every setting for the streaming-SQL tier in ONE typed object (admin-plane/main.bicep is at the ARM 256-param cap, so no new top-level params are added anywhere).

Required keys:
  environmentId          Container Apps managed-environment resource id (in-VNet).
  uamiId                 User-assigned managed identity RESOURCE id (ACR pull + lake write).
  uamiPrincipalId        That identity's PRINCIPAL (object) id — used for the role assignment.
  acrLoginServer         ACR login server, e.g. acrloom.azurecr.io.
  image                  loom-risingwave container image (pin an explicit tag, never :latest).
  lakeStorageAccountName DLZ ADLS Gen2 account the streaming sink writes Delta/Iceberg to.

Optional keys:
  frontendPort           Postgres-wire frontend port (default 4566).
  minReplicas            Default 1 — the streaming tier holds MV state (never scale-to-zero).
  maxReplicas            Default 1 — single-node RisingWave is not horizontally sharded here.
  cpu / memory           Container resources (default 2.0 vCPU / 8Gi — stateful streaming).
  stateStore             Optional RW_STATE_STORE override (e.g. hummock+... on ADLS) for a
                         durable, scaled deployment; empty => single-node local state.
  dataDirectory          Optional RW_DATA_DIRECTORY when stateStore is set.
  assignLakeRole         Set false to skip the in-module role assignment when the
                         identity is granted out-of-band by an estate policy.''')
param risingwaveConfig object

@description('Compliance/cost tags. The loom-next-level tag is unioned in.')
param complianceTags object = {}

// ── Config-bag unpacking (typed locals; every optional key has a real default) ─
var environmentId = risingwaveConfig.environmentId
var uamiId = risingwaveConfig.uamiId
var uamiPrincipalId = risingwaveConfig.uamiPrincipalId
var acrLoginServer = risingwaveConfig.acrLoginServer
var image = risingwaveConfig.image
var lakeStorageAccountName = risingwaveConfig.lakeStorageAccountName
var frontendPort = int(risingwaveConfig.?frontendPort ?? 4566)
var minReplicas = int(risingwaveConfig.?minReplicas ?? 1)
var maxReplicas = int(risingwaveConfig.?maxReplicas ?? 1)
var cpu = string(risingwaveConfig.?cpu ?? '2.0')
var memory = string(risingwaveConfig.?memory ?? '8Gi')
var stateStore = string(risingwaveConfig.?stateStore ?? '')
var dataDirectory = string(risingwaveConfig.?dataDirectory ?? '')
var assignLakeRole = bool(risingwaveConfig.?assignLakeRole ?? true)

var tags = union(complianceTags, { 'loom-next-level': 'true' })

// Storage Blob Data Contributor — the streaming SINK writes Delta/Iceberg to the
// lake, so it needs WRITE (unlike the read-only DuckDB tier). Built-in role id
// is cloud-invariant.
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource lake 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {
  name: lakeStorageAccountName
}

// Guarded guid() name — deterministic per (scope, identity, role) so a re-deploy
// is idempotent and two modules granting the same pair never collide.
resource lakeWriteRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (assignLakeRole) {
  name: guid(lake.id, uamiPrincipalId, storageBlobDataContributorRoleId)
  scope: lake
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalId: uamiPrincipalId
    principalType: 'ServicePrincipal'
  }
}

var baseEnv = [
  // Identity-based lake access — the container authenticates as the UAMI via
  // IMDS (AZURE_CLIENT_ID). No account key, no SAS anywhere.
  { name: 'LOOM_LAKE_ACCOUNT', value: lakeStorageAccountName }
]

var stateEnv = empty(stateStore) ? [] : [
  { name: 'RW_STATE_STORE', value: stateStore }
  { name: 'RW_DATA_DIRECTORY', value: empty(dataDirectory) ? 'loom-risingwave' : dataDirectory }
]

var envVars = concat(baseEnv, stateEnv)

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
      ingress: {
        // INTERNAL only — the Console BFF is the sole door. TCP transport so the
        // raw Postgres-wire frontend is reachable in-VNet on the frontend port.
        external: false
        targetPort: frontendPort
        exposedPort: frontendPort
        transport: 'tcp'
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
              // The frontend has no HTTP health on the SQL port; a TCP connect to
              // the Postgres-wire port is the honest liveness/readiness signal.
              type: 'Liveness'
              tcpSocket: { port: frontendPort }
              initialDelaySeconds: 20
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              tcpSocket: { port: frontendPort }
              initialDelaySeconds: 10
              periodSeconds: 10
              failureThreshold: 6
            }
          ]
        }
      ]
      // NOT scale-to-zero and NOT sharded: single-node RisingWave holds the
      // materialized-view state in one process. Cost ~$150–300/mo/cloud (the
      // opt-in stateful-streaming tier).
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
  dependsOn: assignLakeRole ? [ lakeWriteRole ] : []
}

@description('Internal FQDN — set on the Console app as LOOM_RISINGWAVE_URL (append :<frontendPort>).')
output fqdn string = app.properties.configuration.ingress.fqdn

@description('The Postgres-wire endpoint the Console BFF connects to (LOOM_RISINGWAVE_URL).')
output pgWireEndpoint string = '${app.properties.configuration.ingress.fqdn}:${frontendPort}'

@description('Container App resource id.')
output appId string = app.id
