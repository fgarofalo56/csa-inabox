// CSA Loom — N8 lab 3: the S3-compatible ADLS gateway (DEFAULT-ON).
//
// Backs LOOM_S3_GATEWAY_URL. An internal-ingress Container App running
// **s3proxy** (github.com/gaul/s3proxy, **Apache-2.0**) in front of the
// deployment's own ADLS Gen2, so s3://-native OSS clients (Trino, Spark,
// DuckDB's httpfs/s3 extension, boto3) can address the lake with an S3 API.
//
// WHY THIS EXISTS (loom_default_on_opt_out — .claude/rules): until now
// `svc-s3-gateway` was documented as "operator-deployed … out-of-band", i.e. a
// day-one gate the operator had to close by hand. That is exactly the opt-IN
// posture the default-ON rule forbids. This module makes the gateway a
// first-class, deployed-by-default Container App so a FRESH push-button deploy
// into an empty subscription lights the gate with no manual step.
//
// ── LICENSE (LIC0) ──────────────────────────────────────────────────────────
// s3proxy is Apache-2.0 (LICENSE at github.com/gaul/s3proxy — "Licensed under
// the Apache License, Version 2.0"), and the published image
// `andrewgaul/s3proxy` is built from that same tree. The MinIO gateway path is
// NOT used: MinIO's gateway is deprecated AND AGPL-v3, which LIC0 hard-blocks.
// Registered in THIRD_PARTY_LICENSES.md under "Container-baked engines".
//
// ── SECURITY POSTURE ────────────────────────────────────────────────────────
//   * INTERNAL ingress only (external:false). There is no public listener; the
//     gateway is reachable only from inside the Container Apps environment's
//     VNet (the Console BFF, the DuckDB tier, an in-VNet Trino/Spark).
//   * IDENTITY-BASED storage auth. `jclouds.provider=azureblob-sdk` with BOTH
//     `jclouds.identity` and `jclouds.credential` EMPTY makes the backend build
//     an Azure `DefaultAzureCredential`, which picks up the container's
//     user-assigned managed identity via IMDS (`AZURE_CLIENT_ID`). **No storage
//     account key, no SAS, no connection string anywhere.** `AZURE_AUTHORITY_HOST`
//     is derived per cloud so the same template authenticates in Azure
//     Government.
//   * READ-ONLY BY DEFAULT (`s3proxy.read-only-blobstore=true`). The gateway
//     exists so external engines can READ the governed lake; write verbs are
//     refused by the proxy itself, which makes the posture structural rather
//     than advisory. Flip `readOnly:false` in the config bag for an
//     Iceberg-writer client.
//   * The S3 wire credential is NEVER the shipped default. The upstream image
//     ships `S3PROXY_IDENTITY=local-identity` / `S3PROXY_CREDENTIAL=
//     local-credential` — a publicly-known pair. This module ALWAYS overrides
//     both with unpredictable, seed-derived values delivered as Container Apps
//     **secrets** (never plain env), and mirrors them into the Loom Key Vault so
//     an operator can hand them to a client without reading the container spec.
//   * Scale-to-zero. `minReplicas: 0` — an idle deployment runs no replica, so
//     "on by default" is also free by default (see COST).
//
// ── COST (idle, per cloud) ──────────────────────────────────────────────────
//   minReplicas 0 ⇒ **$0 idle**. Container Apps consumption bills vCPU-seconds
//   and GiB-seconds only while a replica is running, and the monthly free grant
//   (180,000 vCPU-s + 360,000 GiB-s) absorbs light interactive use outright. The
//   trade is a JVM cold start (~5–15 s) on the first request after an idle
//   window; that is the correct trade for a client-compatibility shim nobody
//   calls on the hot path. Set `minReplicas: 1` (~$15–25/mo/cloud at 0.5 vCPU /
//   1 GiB) only if a latency-sensitive S3 client is pointed at it.
//
// Azure-native / OSS only. The proxy is a permissively-licensed binary running
// in-boundary over the deployment's own storage — no SaaS object gateway is in
// the path, so an air-gapped enclave can still expose an S3 face (mirror the
// image into the local ACR and pass `image`). No Microsoft Fabric, no OneLake,
// no Power BI (.claude/rules/no-fabric-dependency.md).

targetScope = 'resourceGroup'

@description('Container App name (DNS-label safe, <= 32 chars).')
@maxLength(32)
param name string = 'loom-s3-gateway'

@description('Deployment region (e.g. usgovvirginia / centralus).')
param location string = resourceGroup().location

@description('''R0 config bag — every setting for the S3 gateway in ONE typed object (admin-plane/main.bicep is at the ARM 256-param cap, so no new top-level params are added anywhere).

Required keys:
  environmentId          Container Apps managed-environment resource id (in-VNet).
  uamiId                 User-assigned managed identity RESOURCE id (ADLS data-plane access + Key Vault secretRef).
  uamiClientId           That identity's CLIENT id — exported as AZURE_CLIENT_ID so
                         DefaultAzureCredential targets it over IMDS.
  lakeStorageAccountName ADLS Gen2 account the gateway fronts. S3 "buckets" map 1:1 to
                         its blob containers.

Optional keys:
  image                  s3proxy image. Default pins the upstream Apache-2.0 release
                         tag; pass an ACR-mirrored tag in locked-egress / sovereign
                         estates (e.g. <acr>.azurecr.io/s3proxy:3.3.0).
  acrLoginServer         ACR login server — set ONLY when `image` is an ACR-mirrored
                         tag, so the app pulls with the UAMI. Empty (default) => the
                         public upstream image is pulled anonymously.
  targetPort             Internal HTTP ingress port (default 80 — the image's own).
  readOnly               Default TRUE — s3proxy refuses every write verb.
  authorization          S3 signature mode (default 'aws-v2-or-v4'). 'none' disables
                         S3 credential checking entirely (in-VNet trust); only pick it
                         for a client that cannot sign.
  minReplicas            Default 0 (scale-to-zero — see the COST block).
  maxReplicas            Default 3.
  cpu / memory           Container resources (default 0.5 vCPU / 1Gi).''')
param s3GatewayConfig object

@description('S3 wire access-key id ("identity"). UNPREDICTABLE — derived by the orchestrator from loomGeneratedSecretSeed (newGuid()). @secure() so it never lands in deployment output.')
@secure()
param s3AccessKey string

@description('S3 wire secret access key ("credential"). UNPREDICTABLE — derived by the orchestrator from loomGeneratedSecretSeed (newGuid()). @secure() so it never lands in deployment output.')
@secure()
param s3SecretKey string

@description('Loom Key Vault resource id. The S3 wire credential pair is mirrored there so an operator can hand it to a client without reading the container spec. Empty => no secrets are written.')
param keyVaultId string = ''

@description('Key Vault secret name for the S3 access-key id.')
param accessKeySecretName string = 'loom-s3-gateway-access-key'

@description('Key Vault secret name for the S3 secret access key.')
param secretKeySecretName string = 'loom-s3-gateway-secret-key'

@description('Compliance/cost tags.')
param complianceTags object = {}

// ── Config-bag unpacking (typed locals; every optional key has a real default) ─
var environmentId = s3GatewayConfig.environmentId
var uamiId = s3GatewayConfig.uamiId
var uamiClientId = s3GatewayConfig.uamiClientId
var lakeStorageAccountName = s3GatewayConfig.lakeStorageAccountName
// Pinned upstream Apache-2.0 release tag — never :latest (supply-chain drift).
var image = string(s3GatewayConfig.?image ?? 'docker.io/andrewgaul/s3proxy:3.3.0')
var acrLoginServer = string(s3GatewayConfig.?acrLoginServer ?? '')
var targetPort = int(s3GatewayConfig.?targetPort ?? 80)
var readOnly = bool(s3GatewayConfig.?readOnly ?? true)
var authorization = string(s3GatewayConfig.?authorization ?? 'aws-v2-or-v4')
var minReplicas = int(s3GatewayConfig.?minReplicas ?? 0)
var maxReplicas = int(s3GatewayConfig.?maxReplicas ?? 3)
var cpu = string(s3GatewayConfig.?cpu ?? '0.5')
var memory = string(s3GatewayConfig.?memory ?? '1Gi')

var tags = union(complianceTags, { 'loom-band': 'data-plane', 'loom-item': 's3-gateway' })

// Per-cloud, never hard-coded on a code path: the blob data-plane host suffix
// (core.windows.net / core.usgovcloudapi.net) and the Entra authority the Java
// azure-identity DefaultAzureCredential must talk to.
var blobEndpoint = 'https://${lakeStorageAccountName}.blob.${environment().suffixes.storage}'
var authorityHost = environment().authentication.loginEndpoint

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
        // INTERNAL only — NEVER public. In-VNet callers (Console BFF, DuckDB
        // tier, an in-VNet Trino/Spark) are the whole audience.
        external: false
        targetPort: targetPort
        transport: 'http'
        allowInsecure: false
        traffic: [
          { latestRevision: true, weight: 100 }
        ]
      }
      // The S3 wire credential never appears as a plain env value.
      secrets: [
        { name: 's3-access-key', value: s3AccessKey }
        { name: 's3-secret-key', value: s3SecretKey }
      ]
      // Only when the image was mirrored into the Loom ACR — the public
      // upstream image needs no registry credential (and admin-enabled
      // registries are forbidden, so this is UAMI-based when used).
      registries: empty(acrLoginServer) ? [] : [
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
          env: [
            { name: 'S3PROXY_ENDPOINT', value: 'http://0.0.0.0:${targetPort}' }
            { name: 'S3PROXY_AUTHORIZATION', value: authorization }
            // NEVER the image's shipped local-identity/local-credential pair.
            { name: 'S3PROXY_IDENTITY', secretRef: 's3-access-key' }
            { name: 'S3PROXY_CREDENTIAL', secretRef: 's3-secret-key' }
            { name: 'S3PROXY_READ_ONLY_BLOBSTORE', value: readOnly ? 'true' : 'false' }
            // The Azure SDK backend (the jclouds one is deprecated upstream).
            { name: 'JCLOUDS_PROVIDER', value: 'azureblob-sdk' }
            // BOTH EMPTY ON PURPOSE: that is the documented switch that makes
            // the backend construct a DefaultAzureCredential instead of using a
            // static account key. No key, no SAS, no connection string.
            { name: 'JCLOUDS_IDENTITY', value: '' }
            { name: 'JCLOUDS_CREDENTIAL', value: '' }
            { name: 'JCLOUDS_ENDPOINT', value: blobEndpoint }
            // Target the user-assigned identity + the correct sovereign authority.
            { name: 'AZURE_CLIENT_ID', value: uamiClientId }
            { name: 'AZURE_AUTHORITY_HOST', value: authorityHost }
          ]
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          probes: [
            {
              // /healthz answers WITHOUT authentication (upstream Dockerfile).
              type: 'Liveness'
              httpGet: { path: '/healthz', port: targetPort }
              initialDelaySeconds: 20
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/healthz', port: targetPort }
              initialDelaySeconds: 5
              periodSeconds: 10
              failureThreshold: 6
            }
          ]
        }
      ]
      scale: {
        // Scale-to-zero: default-ON stays free-at-idle. The cost of that is a
        // JVM cold start on the first request after an idle window, which is
        // the right trade for a client-compatibility shim off the hot path.
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

// ── Operator-retrievable copy of the S3 wire credential ─────────────────────
resource keyVault 'Microsoft.KeyVault/vaults@2024-04-01-preview' existing = if (!empty(keyVaultId)) {
  name: last(split(keyVaultId, '/'))
}

resource accessKeySecret 'Microsoft.KeyVault/vaults/secrets@2024-04-01-preview' = if (!empty(keyVaultId)) {
  parent: keyVault
  name: accessKeySecretName
  properties: {
    value: s3AccessKey
    contentType: 's3-gateway-access-key-id'
    attributes: { enabled: true }
  }
}

resource secretKeySecret 'Microsoft.KeyVault/vaults/secrets@2024-04-01-preview' = if (!empty(keyVaultId)) {
  parent: keyVault
  name: secretKeySecretName
  properties: {
    value: s3SecretKey
    contentType: 's3-gateway-secret-access-key'
    attributes: { enabled: true }
  }
}

@description('Internal FQDN — the Console binds https://<this> as LOOM_S3_GATEWAY_URL.')
output fqdn string = app.properties.configuration.ingress.fqdn

@description('Internal endpoint the Console reads as LOOM_S3_GATEWAY_URL.')
output internalEndpoint string = 'https://${app.properties.configuration.ingress.fqdn}'

@description('Container App resource id.')
output appId string = app.id

@description('TRUE — identity-based ADLS access only (DefaultAzureCredential over IMDS); no storage key/SAS/connection string is present anywhere in this deployment. Emitted so the deploy receipt can assert the posture.')
output identityBasedStorageAuth bool = true

@description('TRUE when the proxy refuses every write verb (s3proxy.read-only-blobstore).')
output readOnly bool = readOnly
