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
//     Iceberg). Granted here via a guarded guid() role assignment when the lake
//     is in THIS resource group; the orchestrator instead passes
//     assignLakeRole:false and grants it from a DLZ-RG-scoped module, because
//     the lake normally lives outside the admin RG. Either way: NO storage keys,
//     NO SAS, NO connection strings in app settings.
//   - Source/sink credentials a specific connector still needs (e.g. an Event
//     Hubs SASL connection string on a local-auth namespace) are injected
//     per-DDL as Key-Vault-resolved values by the BFF, never baked here.
//
// DEFAULT-ON (loom_default_on_opt_out.md, 2026-07-28). This module is INVOKED BY
// THE ORCHESTRATOR — admin-plane/main.bicep deploys it whenever the deployment is
// on Container Apps with deployAppsEnabled, in EVERY boundary (Commercial, GCC,
// GCC-High, IL5), and wires LOOM_RISINGWAVE_URL onto the Console app from this
// module's `pgWireEndpoint` output. There is no operator step: a fresh
// push-button deploy brings the streaming tier up and sets the var.
//
// Admin opt-out (the rule requires a disable toggle, not an enable wizard):
//   -p loomBackends='{ "risingwave": "disabled" }'   → the module is skipped,
//   LOOM_RISINGWAVE_URL is emitted empty and the streaming-sql editor renders
//   fully with its honest Fix-it gate. Nothing else changes.
//
// COST — this is the one runtime in the band that CANNOT scale to zero: a
// single-node RisingWave holds materialized-view + meta state in-process, so a
// scaled-to-zero replica loses every MV definition and its progress. minReplicas
// is therefore 1 and the DEFAULT footprint is the smallest that runs the engine
// honestly: 2.0 vCPU / 4.0 GiB (an ACA Consumption-legal pair — the profile
// requires memory == 2 x vCPU GiB; the previous 2.0/8Gi default was NOT a legal
// combination and would have been rejected at deploy time). At ACA Consumption
// idle rates (no streams defined) that is roughly $45-55/mo/cloud; a replica
// continuously processing streams bills at active rates, roughly $155/mo/cloud.
// Raise to 4.0 vCPU / 8.0 GiB (the Consumption ceiling) via the config bag for
// heavier topologies.
//
// R0 PARAM-CAP RULE: admin-plane/main.bicep is near the ARM 256-parameter
// ceiling, so this module takes a single typed CONFIG-OBJECT bag (no new
// top-level params anywhere) exactly like the sibling data-plane/duckdb-aca.bicep.
// It remains directly deployable out of band for an incremental/sovereign
// provision (that is how the Gov estate gets it before its next full deploy):
//
//   az deployment group create -g <admin-rg> \
//     -f platform/fiab/bicep/modules/data-plane/loom-risingwave-aca.bicep \
//     -p location=<region> \
//        risingwaveConfig='{ "environmentId": "<cae-id>", "uamiId": "<uami-id>", \
//                            "uamiPrincipalId": "<uami-principal-id>", \
//                            "uamiClientId": "<uami-client-id>", \
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
  acrLoginServer         ACR login server, e.g. acrloom.azurecr.io.
  image                  loom-risingwave container image (pin an explicit tag, never :latest).

Optional keys:
  uamiPrincipalId        That identity's PRINCIPAL (object) id — required only when
                         assignLakeRole is true (it names the role assignment).
  uamiClientId           That identity's CLIENT id — emitted as AZURE_CLIENT_ID so the
                         engine picks the RIGHT identity off IMDS when the container has
                         more than one assigned. Empty => omitted.
  lakeStorageAccountName DLZ ADLS Gen2 account the streaming sink writes Delta/Iceberg to.
                         Empty => no LOOM_LAKE_ACCOUNT and no role assignment; the engine
                         still runs (single-node local state) and the Postgres wire serves.
                         The lake usually lives in the DLZ resource group, in which case the
                         orchestrator passes assignLakeRole:false and grants the role from a
                         DLZ-scoped module instead.
  frontendPort           Postgres-wire frontend port (default 4566).
  minReplicas            Default 1 — the streaming tier holds MV state (CANNOT scale to zero:
                         a stopped replica loses every materialized view and its progress).
  maxReplicas            Default 1 — single-node RisingWave is not horizontally sharded here.
  cpu / memory           Container resources (default 2.0 vCPU / 4.0Gi) — the SMALLEST viable
                         always-on footprint and an ACA-Consumption-legal pair.
                         ACA Consumption only accepts memory == 2x cpu, so the
                         previous 2.0/8Gi default was NOT DEPLOYABLE — preflight
                         rejected it with ContainerAppInvalidResourceTotal. For a
                         heavier streaming workload use 4.0 vCPU / 8Gi (the next
                         valid step up, and the profile ceiling), not 2.0/8Gi.
  stateStore             Optional RW_STATE_STORE override (e.g. hummock+... on ADLS) for a
                         durable, scaled deployment; empty => single-node local state.
  dataDirectory          Optional RW_DATA_DIRECTORY when stateStore is set.
  assignLakeRole         Default true. Set false to skip the in-module role assignment when
                         the lake is in another resource group / granted out-of-band.''')
param risingwaveConfig object

@description('Compliance/cost tags. The loom-next-level tag is unioned in.')
param complianceTags object = {}

// ── Config-bag unpacking (typed locals; every optional key has a real default) ─
var environmentId = risingwaveConfig.environmentId
var uamiId = risingwaveConfig.uamiId
var uamiPrincipalId = string(risingwaveConfig.?uamiPrincipalId ?? '')
var uamiClientId = string(risingwaveConfig.?uamiClientId ?? '')
var acrLoginServer = risingwaveConfig.acrLoginServer
var image = risingwaveConfig.image
var lakeStorageAccountName = string(risingwaveConfig.?lakeStorageAccountName ?? '')
var frontendPort = int(risingwaveConfig.?frontendPort ?? 4566)
var minReplicas = int(risingwaveConfig.?minReplicas ?? 1)
var maxReplicas = int(risingwaveConfig.?maxReplicas ?? 1)
// ACA Consumption requires memory == 2 x vCPU GiB. 2.0/4.0Gi is the smallest
// pair that runs the engine honestly; 4.0/8.0Gi is the profile ceiling.
var cpu = string(risingwaveConfig.?cpu ?? '2.0')
// ACA Consumption accepts ONLY cpu/memory pairs where memory == 2x cpu
// (0.25/0.5Gi ... 4/8Gi). The former '8Gi' default paired with 2.0 vCPU is not a
// legal combination, so every deploy of this module failed preflight with
// ContainerAppInvalidResourceTotal. 4.0Gi is the valid partner for 2.0 vCPU and
// keeps the always-on streaming tier at the cheaper end (it cannot scale to zero:
// it holds materialized-view state).
var memory = string(risingwaveConfig.?memory ?? '4.0Gi')
var stateStore = string(risingwaveConfig.?stateStore ?? '')
var dataDirectory = string(risingwaveConfig.?dataDirectory ?? '')
// The lake role can only be assigned from THIS module when the account lives in
// THIS resource group and we know the principal id.
var assignLakeRole = bool(risingwaveConfig.?assignLakeRole ?? true) && !empty(lakeStorageAccountName) && !empty(uamiPrincipalId)

var tags = union(complianceTags, { 'loom-next-level': 'true' })

// Storage Blob Data Contributor — the streaming SINK writes Delta/Iceberg to the
// lake, so it needs WRITE (unlike the read-only DuckDB tier). Built-in role id
// is cloud-invariant.
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource lake 'Microsoft.Storage/storageAccounts@2024-01-01' existing = if (assignLakeRole) {
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

var lakeEnv = empty(lakeStorageAccountName) ? [] : [
  // Identity-based lake access — the container authenticates as the UAMI via
  // IMDS (AZURE_CLIENT_ID below). No account key, no SAS anywhere.
  { name: 'LOOM_LAKE_ACCOUNT', value: lakeStorageAccountName }
]

// Disambiguate IMDS when the container carries more than one assigned identity.
var identityEnv = empty(uamiClientId) ? [] : [
  { name: 'AZURE_CLIENT_ID', value: uamiClientId }
]

var stateEnv = empty(stateStore) ? [] : [
  { name: 'RW_STATE_STORE', value: stateStore }
  { name: 'RW_DATA_DIRECTORY', value: empty(dataDirectory) ? 'loom-risingwave' : dataDirectory }
]

var envVars = concat(lakeEnv, identityEnv, stateEnv)

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
      // CANNOT scale to zero and NOT sharded: single-node RisingWave holds the
      // materialized-view + meta state in ONE process, so a stopped replica
      // loses every MV definition and its progress. minReplicas 1 with the
      // smallest legal footprint (2.0 vCPU / 4.0Gi) is the honest floor:
      // ~$45-55/mo/cloud at ACA idle rates, ~$155/mo when continuously
      // processing streams. Disable with loomBackends.risingwave='disabled'.
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
