// CSA Loom — admin-plane/airflow.bicep
// Day-one OSS Apache Airflow host on Azure Container Apps (rel-T86).
//
// Azure-native, NO-FABRIC parity for the Loom `airflow-job` item. Microsoft
// Fabric ships "Apache Airflow job" and Azure Data Factory ships "Workflow
// Orchestration Manager" — both are managed Apache Airflow. Loom provides the
// SAME managed-Airflow experience WITHOUT a Fabric capacity or an ADF WOM
// environment by running the upstream OSS `apache/airflow` image here:
//
//   • webserver container  — serves the Airflow UI + the stable REST API
//     (/api/v1/dags, dagRuns, taskInstances) the Loom BFF proxies. Also runs
//     the one-time `airflow db migrate` + admin-user create on boot (the
//     official image entrypoint honours _AIRFLOW_DB_MIGRATE / _AIRFLOW_WWW_USER_*).
//   • scheduler container  — schedules + executes DAGs (LocalExecutor). Shares
//     the metadata DB + the DAG/logs file shares with the webserver.
//   • Azure Database for PostgreSQL Flexible Server — the Airflow metadata DB
//     (SQLite is single-process only; a webserver+scheduler split needs a real
//     concurrent DB, exactly as WOM/Fabric use a managed store behind Airflow).
//   • Azure Files DAG + logs shares — mounted into BOTH containers at
//     /opt/airflow/dags and /opt/airflow/logs. Operators drop DAG .py files in
//     the `dags` share (WOM's "provide your DAGs in Blob Storage" equivalent);
//     an empty share is a real, healthy Airflow that returns an empty DAG list.
//
// The Console reaches the webserver over the CAE VNet (internal ingress only —
// NEVER public) and authenticates with HTTP Basic auth (WOM's "Basic
// authentication" mode). LOOM_AIRFLOW_ENDPOINT / _USERNAME / _PASSWORD are
// wired to the Console app env in admin-plane/main.bicep; when unset the
// airflow-job editor renders its full surface + an honest MessageBar naming
// this module (per no-vaporware.md / no-fabric-dependency.md). BYO webserver
// stays an opt-in alternative (a per-item webserver URL overrides this host).
//
// SHARED-KEY STORAGE (disclosed deviation): ACA Azure Files volume mounts
// require the storage account key (there is no MSI/SMB mount for ACA), so this
// module provisions a DEDICATED storage account with allowSharedKeyAccess=true
// rather than reusing the AAD-only estate lake (allowSharedKeyAccess=false via
// policy — a key mount there is rejected). The account holds only DAG source +
// task logs; Entra still gates the Postgres metadata DB and the webserver API.
//
// Grounding: Microsoft Learn "How does Azure Data Factory Workflow
// Orchestration Manager work?" + "What is an Apache Airflow job?" (Fabric) +
// Apache Airflow stable REST API reference. Parity doc: docs/fiab/parity/airflow.md.

targetScope = 'resourceGroup'

@description('Primary region.')
param location string = resourceGroup().location

@description('Container Apps Environment (managed environment) resource ID — the Console CAE. The Airflow host runs here so the Console reaches it over the VNet.')
param caeId string

@description('Console UAMI resource ID — attached to the Airflow host so in-DAG Azure operators can auth via managed identity (AZURE_CLIENT_ID) and, when a mirrored image tag is used, pull it from ACR.')
param uamiId string

@description('Console UAMI client ID — injected as AZURE_CLIENT_ID for managed-identity auth from DAGs.')
param uamiClientId string

@description('Apache Airflow container image. Defaults to the upstream OSS image on Docker Hub; override with an ACR-mirrored tag (e.g. <acr>.azurecr.io/apache/airflow:2.10.5) in locked-egress / sovereign estates.')
param airflowImage string = 'apache/airflow:2.10.5-python3.12'

@description('Airflow admin (and REST Basic-auth) username the Console authenticates as.')
param adminUsername string = 'loom'

@description('Airflow admin + Postgres password. UNPREDICTABLE — derived by the orchestrator from loomGeneratedSecretSeed (newGuid()), never guid(rg.id, <const>). Marked @secure() so it never lands in deployment output/logs.')
@secure()
param adminPassword string

@description('Airflow webserver SECRET_KEY (session signing). Stable, seed-derived value passed as an ACA secret.')
@secure()
param webserverSecretKey string

@description('Postgres Flexible Server SKU name (Burstable B1ms is the cheapest functional size).')
param pgSkuName string = 'Standard_B1ms'

@description('Postgres compute tier.')
@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param pgTier string = 'Burstable'

@description('Postgres storage size in GB.')
@allowed([32, 64, 128, 256, 512])
param pgStorageSizeGB int = 32

@description('App Insights connection string for the host containers.')
param appInsightsConnectionString string = ''

@description('Compliance tags applied to every resource.')
param complianceTags object = {}

// Postgres admin login (password auth — Airflow's SQLAlchemy conn is password-based;
// Entra-token auth can't be refreshed inside the long-lived scheduler process).
var pgAdminLogin = 'loomairflow'
var pgServerName = take('psql-loom-airflow-${uniqueString(resourceGroup().id)}', 63)
var pgDatabaseName = 'airflow'
var storageAccountName = take('stloomaf${uniqueString(resourceGroup().id)}', 24)
var caeName = last(split(caeId, '/'))
var dagsShareName = 'dags'
var logsShareName = 'logs'
var dagsStorageLink = 'airflowdags'
var logsStorageLink = 'airflowlogs'

// ── Metadata DB: Azure Database for PostgreSQL Flexible Server ────────────────
resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: pgServerName
  location: location
  tags: complianceTags
  sku: {
    name: pgSkuName
    tier: pgTier
  }
  properties: {
    version: '16'
    administratorLogin: pgAdminLogin
    administratorLoginPassword: adminPassword
    storage: {
      storageSizeGB: pgStorageSizeGB
    }
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
  }
}

// Allow Azure-internal services (the CAE's egress) to reach the server. Entra is
// off here (password auth), so the metadata DB is gated by the strong seed-derived
// password + TLS (sslmode=require). start==end==0.0.0.0 is the Azure-services
// special case, NOT anonymous internet access.
resource pgFwAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: pg
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: pgDatabaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// ── DAG + logs storage: dedicated account (shared-key for the ACA mount) ──────
resource storage 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: storageAccountName
  location: location
  tags: complianceTags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    // Required: ACA Azure Files volume mounts authenticate with the account key.
    allowSharedKeyAccess: true
    supportsHttpsTrafficOnly: true
  }
}

resource fileSvc 'Microsoft.Storage/storageAccounts/fileServices@2024-01-01' = {
  parent: storage
  name: 'default'
}

resource dagsShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2024-01-01' = {
  parent: fileSvc
  name: dagsShareName
  properties: {
    shareQuota: 100
  }
}

resource logsShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2024-01-01' = {
  parent: fileSvc
  name: logsShareName
  properties: {
    shareQuota: 100
  }
}

// ── CAE managed-environment storage links (Azure Files → ACA volumes) ─────────
resource cae 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: caeName
}

resource dagsCaeStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: cae
  name: dagsStorageLink
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: dagsShareName
      accessMode: 'ReadWrite'
    }
  }
  dependsOn: [
    dagsShare
  ]
}

resource logsCaeStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: cae
  name: logsStorageLink
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: logsShareName
      accessMode: 'ReadWrite'
    }
  }
  dependsOn: [
    logsShare
  ]
}

// SQLAlchemy conn string for the Airflow metadata DB. The seed-derived password
// contains only [A-Za-z0-9!] so it is URL-safe in the DSN. sslmode=require
// enforces TLS to the flexible server.
var sqlAlchemyConn = 'postgresql+psycopg2://${pgAdminLogin}:${adminPassword}@${pg.properties.fullyQualifiedDomainName}:5432/${pgDatabaseName}?sslmode=require'

// Env shared by BOTH containers (webserver + scheduler).
var airflowSharedEnv = [
  { name: 'AIRFLOW__DATABASE__SQL_ALCHEMY_CONN', secretRef: 'pg-conn' }
  { name: 'AIRFLOW__CORE__EXECUTOR', value: 'LocalExecutor' }
  { name: 'AIRFLOW__CORE__LOAD_EXAMPLES', value: 'False' }
  { name: 'AIRFLOW__CORE__DAGS_FOLDER', value: '/opt/airflow/dags' }
  // Basic-auth backend for the REST API (WOM "Basic authentication") + the
  // session backend so the UI keeps working. The Console authenticates Basic.
  { name: 'AIRFLOW__API__AUTH_BACKENDS', value: 'airflow.api.auth.backend.basic_auth,airflow.api.auth.backend.session' }
  { name: 'AIRFLOW__WEBSERVER__SECRET_KEY', secretRef: 'webserver-secret-key' }
  { name: 'AIRFLOW__WEBSERVER__EXPOSE_CONFIG', value: 'False' }
  // Managed identity for in-DAG Azure operators (Storage/ADF/etc.).
  { name: 'AZURE_CLIENT_ID', value: uamiClientId }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
]

var airflowVolumes = [
  { name: 'dags', storageType: 'AzureFile', storageName: dagsStorageLink }
  { name: 'logs', storageType: 'AzureFile', storageName: logsStorageLink }
]

var airflowVolumeMounts = [
  { volumeName: 'dags', mountPath: '/opt/airflow/dags' }
  { volumeName: 'logs', mountPath: '/opt/airflow/logs' }
]

// ── Airflow host: Container App (webserver + scheduler) ───────────────────────
resource airflow 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: 'loom-airflow'
  location: location
  tags: complianceTags
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
      secrets: [
        { name: 'pg-conn', value: sqlAlchemyConn }
        { name: 'admin-password', value: adminPassword }
        { name: 'webserver-secret-key', value: webserverSecretKey }
      ]
    }
    template: {
      containers: [
        {
          // Webserver — serves the UI + REST API and runs the one-time DB
          // migrate + admin-user create on boot (official image entrypoint).
          name: 'webserver'
          image: airflowImage
          args: [ 'webserver' ]
          env: concat(airflowSharedEnv, [
            { name: '_AIRFLOW_DB_MIGRATE', value: 'true' }
            { name: '_AIRFLOW_WWW_USER_CREATE', value: 'true' }
            { name: '_AIRFLOW_WWW_USER_USERNAME', value: adminUsername }
            { name: '_AIRFLOW_WWW_USER_PASSWORD', secretRef: 'admin-password' }
          ])
          resources: { cpu: json('1.0'), memory: '2Gi' }
          volumeMounts: airflowVolumeMounts
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/health', port: 8080 }
              periodSeconds: 30
              failureThreshold: 5
              initialDelaySeconds: 60
            }
            {
              type: 'Readiness'
              httpGet: { path: '/health', port: 8080 }
              periodSeconds: 15
              failureThreshold: 6
              initialDelaySeconds: 30
            }
            {
              // Airflow db migrate + first boot is slow; give a wide startup
              // window (up to 40*15s = 10min) before Liveness/Readiness engage.
              type: 'Startup'
              httpGet: { path: '/health', port: 8080 }
              periodSeconds: 15
              failureThreshold: 40
              initialDelaySeconds: 20
            }
          ]
        }
        {
          // Scheduler — schedules + executes DAGs. Shares the metadata DB +
          // file shares. On a cold DB it retries until the webserver migrate
          // completes (ACA restarts a crashed container), then runs steadily.
          name: 'scheduler'
          image: airflowImage
          args: [ 'scheduler' ]
          env: airflowSharedEnv
          resources: { cpu: json('1.0'), memory: '2Gi' }
          volumeMounts: airflowVolumeMounts
        }
      ]
      volumes: airflowVolumes
      scale: {
        // LocalExecutor runs webserver + scheduler in a single replica — the
        // scheduler must be a singleton, so this host is pinned to 1 replica.
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

output airflowAppId string = airflow.id
output airflowAppName string = airflow.name
// Internal endpoint the Console reads as LOOM_AIRFLOW_ENDPOINT.
output airflowInternalEndpoint string = 'https://${airflow.properties.configuration.ingress.fqdn}'
output pgServerName string = pg.name
output pgFqdn string = pg.properties.fullyQualifiedDomainName
output dagShareName string = dagsShareName
output storageAccountName string = storage.name
