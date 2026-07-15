// CSA Loom — loom-unity: self-hosted OSS Unity Catalog server Container App.
//
// Backs LOOM_UNITY_URL for the Console's Unity Catalog client (uc-backend.ts)
// when LOOM_UC_BACKEND=oss — the Azure-Government default, because Databricks
// Unity Catalog has NO Azure Government endpoint. Runs the official OSS Unity
// Catalog server (packaged in apps/loom-unity) and exposes the same
// /api/2.1/unity-catalog/* REST surface the Loom client already speaks.
//
// Azure-native only — no Microsoft Fabric / Power BI / OneLake dependency
// (.claude/rules/no-fabric-dependency.md). OSS Unity Catalog IS the Azure-native
// Unity Catalog backend.
//
// Internal ingress only (reachable from the Console over the CAE VNet, never
// public). The catalog DB is the default H2 file DB persisted on a mounted Azure
// Files share (so the catalog survives restarts); Postgres is opt-in via
// LOOM_UNITY_DB_URL. minReplicas:1 — the catalog is on the metadata hot path.
//
// STANDALONE ENTRYPOINT: admin-plane/main.bicep is at the ARM 256-parameter
// ceiling, so this deploys out-of-band (like the Hyperscale-band modules), then
// LOOM_UNITY_URL + LOOM_UC_BACKEND=oss are set on the Console app. Until wired,
// the UC client honest-gates (OssUcNotConfiguredError) and Commercial keeps
// using Databricks UC. Orphan-allowlisted in scripts/ci/check-bicep-sync.mjs.
//
//   az deployment group create -g <admin-rg> \
//     -f platform/fiab/bicep/modules/compute/loom-unity-app.bicep \
//     -p location=<region> environmentId=<cae-id> \
//        acrLoginServer=<acr>.azurecr.io image=<acr>.azurecr.io/loom-unity:<tag> \
//        unityUamiId=<uami-id> complianceTags='{ "env": "gov" }'
//   # then: az containerapp update -n <console> -g <admin-rg> --set-env-vars \
//   #         LOOM_UC_BACKEND=oss LOOM_UNITY_URL=https://<this-app-fqdn>

targetScope = 'resourceGroup'

@description('Container App name (DNS-label safe, <= 32 chars).')
@maxLength(32)
param name string = 'loom-unity'

@description('Deployment region (e.g. usgovvirginia / centralus).')
param location string

@description('Container Apps managed-environment (CAE) resource id — the console VNet-integrated env.')
param environmentId string

@description('UserAssigned UAMI resource id — assigned for ACR image pull (and the app identity via IMDS). AcrPull on the registry is the only role it needs; the catalog DB is a file mount, and optional ADLS vending uses a service principal passed as env, not this UAMI.')
param unityUamiId string

@description('ACR login server, e.g. acrloom.azurecr.io.')
param acrLoginServer string

@description('Container image reference (the loom-unity image in ACR — pin an explicit tag, never :latest).')
param image string

@description('Internal ingress target port the OSS Unity Catalog server listens on.')
param targetPort int = 8080

@description('Azure Files storage account name for the persistent catalog DB (H2 .mv.db). Auto-derived from the app name + a uniqueString when left default.')
@maxLength(24)
param dbStorageAccountName string = take('st${replace(name, '-', '')}${uniqueString(resourceGroup().id, name)}', 24)

@description('Opt-in Postgres JDBC URL (jdbc:postgresql://host:5432/db). Empty => the DEFAULT H2 file DB on the mounted Azure Files share. Postgres requires a one-time UC schema migration (docs/fiab/unity-gov.md).')
param unityDbUrl string = ''

@description('When true, back the catalog DB with an EPHEMERAL EmptyDir volume instead of an Azure Files share — no storage account/share is created and no SMB mount is attached. Use in boundaries where H2-on-Azure-Files fails to mount/boot (observed on Azure Government: the CIFS mount blocks container start with CrashLoopBackOff before the app runs). Catalog metadata is NOT persisted across restarts; wire unityDbUrl (Postgres) for durable storage. Ignored when unityDbUrl is set (Postgres owns its storage).')
param dbEphemeral bool = false

@description('Log Analytics workspace resource id for storage diagnostics. Empty => no diagnostic settings (container stdout/stderr still flows through the CAE Log Analytics integration).')
param workspaceId string = ''

@description('Compliance/cost tags.')
param complianceTags object = {}

var dbShareName = 'unity-db'
var dbStorageLink = 'unity-db'
var dbMountPath = '/home/unitycatalog/etc/db'

// ── Persistent catalog DB: dedicated Azure Files share (shared-key for the ACA
//    mount, exactly like the airflow metadata store). The H2 .mv.db lives here so
//    the catalog survives container restarts.
var useAzureFiles = !dbEphemeral && empty(unityDbUrl)
resource dbStorage 'Microsoft.Storage/storageAccounts@2024-01-01' = if (useAzureFiles) {
  name: dbStorageAccountName
  location: location
  tags: complianceTags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    // ACA Azure Files volume mounts authenticate with the account key.
    allowSharedKeyAccess: true
    supportsHttpsTrafficOnly: true
  }
}

resource fileSvc 'Microsoft.Storage/storageAccounts/fileServices@2024-01-01' = if (useAzureFiles) {
  parent: dbStorage
  name: 'default'
}

resource dbShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2024-01-01' = if (useAzureFiles) {
  parent: fileSvc
  name: dbShareName
  properties: {
    shareQuota: 50
  }
}

resource dbDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (useAzureFiles && !empty(workspaceId)) {
  name: 'diag-loom-unity-db'
  scope: fileSvc
  properties: {
    workspaceId: workspaceId
    metrics: [
      {
        category: 'Transaction'
        enabled: true
      }
    ]
  }
}

resource cae 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: last(split(environmentId, '/'))
}

resource dbCaeStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = if (useAzureFiles) {
  parent: cae
  name: dbStorageLink
  properties: {
    azureFile: {
      accountName: dbStorage.name
      accountKey: dbStorage.listKeys().keys[0].value
      shareName: dbShareName
      accessMode: 'ReadWrite'
    }
  }
  dependsOn: [
    dbShare
  ]
}

var envVars = concat(
  [
    { name: 'LOOM_UNITY_PORT', value: string(targetPort) }
  ],
  // Azure Files DB path only when we actually mount it; otherwise force the
  // entrypoint's local ephemeral H2 dir (no SMB mount to fail on start).
  useAzureFiles ? [
    { name: 'LOOM_UNITY_DB_DIR', value: dbMountPath }
  ] : [
    { name: 'LOOM_UNITY_DB_LOCAL', value: '1' }
  ],
  empty(unityDbUrl) ? [] : [
    { name: 'LOOM_UNITY_DB_URL', value: unityDbUrl }
  ]
)

// Pinned to the same Container Apps api-version the sibling ACA modules use
// (loom-onelake-app.bicep / script-runner-app.bicep) — bicep/runtime sync.
resource app 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: name
  location: location
  tags: complianceTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${unityUamiId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        // INTERNAL only — reached by the Console over the CAE network. The OSS
        // server runs with authorization disabled by default; the VNet boundary
        // IS the security perimeter (identical to the sibling loom-onelake).
        external: false
        targetPort: targetPort
        transport: 'auto'
      }
      registries: [
        {
          server: acrLoginServer
          identity: unityUamiId
        }
      ]
    }
    template: {
      containers: [
        {
          name: name
          image: image
          env: envVars
          volumeMounts: useAzureFiles ? [
            { volumeName: 'unity-db', mountPath: dbMountPath }
          ] : []
          // 1 vCPU / 2Gi — the JVM UC server + H2 has a steady, modest footprint.
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          // OSS Unity Catalog 0.5 exposes no unauthenticated HTTP health path,
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
      volumes: useAzureFiles ? [
        { name: 'unity-db', storageType: 'AzureFile', storageName: dbStorageLink }
      ] : []
      // NOT scale-to-zero: the catalog is on the metadata hot path AND the H2
      // file DB is single-writer, so pin exactly one warm replica.
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
  dependsOn: [
    dbCaeStorage
  ]
}

@description('Internal FQDN of the deployed OSS Unity Catalog service (Console reads it as LOOM_UNITY_URL, prefixed https://).')
output fqdn string = app.properties.configuration.ingress.fqdn

@description('Container App resource id.')
output appId string = app.id

@description('Persistent catalog DB storage account name (empty when dbEphemeral / Postgres — no Azure Files share is created).')
output dbStorageAccountName string = useAzureFiles ? dbStorage.name : ''
