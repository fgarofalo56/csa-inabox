// CSA Loom — N1 iceberg-catalog: the Apache Iceberg REST Catalog (IRC) service.
//
// Backs LOOM_ICEBERG_CATALOG_URL. Runs **Unity Catalog OSS** (the operator's
// chosen backend — it natively bridges Delta and Iceberg over the SAME storage,
// and Loom already builds/ships this container for the Gov UC path) as an
// INTERNAL-ingress Azure Container App exposing the standard Iceberg REST
// Catalog surface at /api/2.1/unity-catalog/iceberg/v1/*.
//
// This is the "defector-maker": any external engine (Trino, Spark, DuckDB,
// Snowflake, Databricks) reads Loom's tables off the CUSTOMER'S OWN ADLS Gen2
// with ZERO copy, through a standard catalog — no export, no second warehouse.
//
// Azure-native / OSS only. No Microsoft Fabric, no OneLake, no Power BI, and no
// SaaS catalog (.claude/rules/no-fabric-dependency.md). Because the catalog is
// a container on this deployment's own Container Apps environment reading this
// deployment's own storage, the full capability runs DISCONNECTED in an IL5 /
// air-gapped enclave — that is precisely the sovereign moat for data interop.
//
// SECURITY POSTURE
//   - INTERNAL ingress only. The catalog is never public; external engines
//     reach it through the Console BFF proxy (/api/catalog/iceberg/*), which
//     authenticates the caller (session cookie or a scoped Loom API token),
//     injects Entra auth on the upstream hop, and writes a data-access audit
//     row for every read/write.
//   - IDENTITY-BASED storage auth: a user-assigned managed identity with
//     **Storage Blob Data Reader** on the DLZ lake, declared IN THIS MODULE via
//     a guarded guid() role assignment. NO storage account keys, NO connection
//     strings, NO secrets in app settings.
//
// R0 PARAM-CAP RULE: admin-plane/main.bicep is at the ARM 256-parameter
// ceiling, so this module takes a single typed CONFIG-OBJECT bag rather than a
// spray of top-level params, and deploys OUT OF BAND (standalone entrypoint,
// orphan-allowlisted in scripts/ci/check-bicep-sync.mjs) exactly like the
// sibling compute/loom-unity-app.bicep.
//
//   az deployment group create -g <admin-rg> \
//     -f platform/fiab/bicep/modules/data-plane/iceberg-catalog-aca.bicep \
//     -p location=<region> \
//        catalogConfig='{ "environmentId": "<cae-id>", "uamiId": "<uami-id>", \
//                         "uamiPrincipalId": "<uami-principal-id>", \
//                         "acrLoginServer": "<acr>.azurecr.io", \
//                         "image": "<acr>.azurecr.io/loom-unity:<tag>", \
//                         "lakeStorageAccountName": "<dlz-adls-account>" }'
//   # then: az containerapp update -n <console> -g <admin-rg> --set-env-vars \
//   #         LOOM_ICEBERG_CATALOG_URL=https://<this-app-fqdn>

targetScope = 'resourceGroup'

@description('Container App name (DNS-label safe, <= 32 chars).')
@maxLength(32)
param name string = 'iceberg-catalog'

@description('Deployment region (e.g. usgovvirginia / centralus).')
param location string = resourceGroup().location

@description('''R0 config bag — every setting for the Iceberg REST Catalog app in ONE typed object (admin-plane/main.bicep is at the ARM 256-param cap, so no new top-level params are added anywhere).

Required keys:
  environmentId          Container Apps managed-environment resource id (in-VNet).
  uamiId                 User-assigned managed identity RESOURCE id (ACR pull + lake read).
  uamiPrincipalId        That identity's PRINCIPAL (object) id — used for the role assignment.
  acrLoginServer         ACR login server, e.g. acrloom.azurecr.io.
  image                  Catalog container image (pin an explicit tag, never :latest).
  lakeStorageAccountName DLZ ADLS Gen2 account the catalog reads table metadata from.

Optional keys:
  targetPort             Internal ingress port (default 8080).
  warehouse              Unity Catalog catalog name backing the Loom namespaces (default 'loom').
  catalogDbUrl           Postgres JDBC URL for durable catalog metadata. Empty => the
                         container's local (ephemeral) store; set this for production.
  minReplicas            Default 1 — the catalog is on the metadata hot path (never scale-to-zero).
  maxReplicas            Default 1 (single-writer local metadata store; raise with Postgres).
  cpu / memory           Container resources (default 1.0 vCPU / 2Gi).
  assignLakeRole         Set false to skip the in-module role assignment when the
                         identity is granted out-of-band by an estate policy.''')
param catalogConfig object

@description('Compliance/cost tags. The loom-next-level tag is unioned in.')
param complianceTags object = {}

// ── Config-bag unpacking (typed locals; every optional key has a real default) ─
var environmentId = catalogConfig.environmentId
var uamiId = catalogConfig.uamiId
var uamiPrincipalId = catalogConfig.uamiPrincipalId
var acrLoginServer = catalogConfig.acrLoginServer
var image = catalogConfig.image
var lakeStorageAccountName = catalogConfig.lakeStorageAccountName
var targetPort = int(catalogConfig.?targetPort ?? 8080)
var warehouse = string(catalogConfig.?warehouse ?? 'loom')
var catalogDbUrl = string(catalogConfig.?catalogDbUrl ?? '')
var minReplicas = int(catalogConfig.?minReplicas ?? 1)
var maxReplicas = int(catalogConfig.?maxReplicas ?? 1)
var cpu = string(catalogConfig.?cpu ?? '1.0')
var memory = string(catalogConfig.?memory ?? '2Gi')
var assignLakeRole = bool(catalogConfig.?assignLakeRole ?? true)

var tags = union(complianceTags, { 'loom-next-level': 'true' })

// Storage Blob Data Reader — the catalog only READS table metadata + data files
// to answer catalog requests and vend scoped credentials. It never writes to the
// lake (Loom's Spark jobs own the writes), so READER is the least privilege that
// works. Built-in role id is cloud-invariant.
var storageBlobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'

resource lake 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {
  name: lakeStorageAccountName
}

// Guarded guid() name — deterministic per (scope, identity, role) so a re-deploy
// is idempotent and two modules granting the same pair never collide.
resource lakeReadRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (assignLakeRole) {
  name: guid(lake.id, uamiPrincipalId, storageBlobDataReaderRoleId)
  scope: lake
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderRoleId)
    principalId: uamiPrincipalId
    principalType: 'ServicePrincipal'
  }
}

var envVars = concat(
  [
    { name: 'LOOM_UNITY_PORT', value: string(targetPort) }
    // The Unity Catalog catalog name that backs the Loom Iceberg namespaces.
    { name: 'LOOM_ICEBERG_WAREHOUSE', value: warehouse }
    // Identity-based ADLS access — the container authenticates as the UAMI via
    // IMDS. No account key, no SAS, no connection string anywhere in this app.
    { name: 'LOOM_LAKE_ACCOUNT', value: lakeStorageAccountName }
    { name: 'LOOM_LAKE_AUTH_MODE', value: 'managed-identity' }
  ],
  empty(catalogDbUrl) ? [
    // No Postgres wired: the container uses its LOCAL metadata store. Catalog
    // metadata is then NOT durable across restarts — honestly surfaced as the
    // output note below rather than silently assumed.
    { name: 'LOOM_UNITY_DB_LOCAL', value: '1' }
  ] : [
    { name: 'LOOM_UNITY_DB_URL', value: catalogDbUrl }
  ]
)

// Pinned to the same Container Apps api-version the sibling ACA modules use
// (compute/loom-unity-app.bicep / compute/loom-onelake-app.bicep).
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
        // INTERNAL only — reached by the Console BFF over the CAE network. The
        // BFF is the sole public door and it authenticates + audits every call.
        external: false
        targetPort: targetPort
        transport: 'auto'
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
          // The OSS catalog server exposes no unauthenticated HTTP health path,
          // so liveness/readiness are TCP connects to the API port — the honest
          // "server is listening" signal (no fabricated /healthz 200).
          probes: [
            {
              type: 'Liveness'
              tcpSocket: { port: targetPort }
              initialDelaySeconds: 20
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              tcpSocket: { port: targetPort }
              initialDelaySeconds: 10
              periodSeconds: 15
              failureThreshold: 6
            }
          ]
        }
      ]
      // NOT scale-to-zero: the catalog is on the metadata hot path for every
      // external-engine query plan. Cost note: ~$100–200/mo/cloud always-on.
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
  dependsOn: assignLakeRole ? [ lakeReadRole ] : []
}

@description('Internal FQDN — set on the Console app as LOOM_ICEBERG_CATALOG_URL (prefix https://).')
output fqdn string = app.properties.configuration.ingress.fqdn

@description('Container App resource id.')
output appId string = app.id

@description('The Unity Catalog catalog name backing the Loom Iceberg namespaces (LOOM_ICEBERG_CATALOG_WAREHOUSE).')
output warehouse string = warehouse

@description('True when catalog metadata is durable (Postgres wired). False => the local store resets on restart; wire catalogConfig.catalogDbUrl for production.')
output metadataDurable bool = !empty(catalogDbUrl)
