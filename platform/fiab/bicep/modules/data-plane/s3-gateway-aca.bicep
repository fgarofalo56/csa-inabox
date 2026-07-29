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
//   * DEDICATED LEAST-PRIVILEGE IDENTITY (round-2 fix). The container runs with
//     TWO user-assigned identities: the caller-supplied `uamiId` is used ONLY as
//     the ACR pull credential, and a UAMI **created by this module**
//     (`uami-loom-s3gw-<location>`) is the one `AZURE_CLIENT_ID` selects for the
//     storage data plane. The lake grant for that identity is **Storage Blob
//     Data READER**, applied at the lake's own scope by the sibling
//     `s3-gateway-lake-rbac.bicep` (which this module's `storageUamiPrincipalId`
//     output feeds). Round 1 ran the proxy as the Console UAMI — an identity
//     that also holds Storage Blob Data CONTRIBUTOR, Key Vault Secrets User,
//     Network Contributor and AKS Cluster Admin — so compromising a Java proxy
//     that parses attacker-influenced S3 signatures and XML yielded the whole
//     Console token. `read-only-blobstore` is a proxy-layer control; it does not
//     survive a container compromise. The IAM boundary does.
//   * IDENTITY-BASED storage auth. `jclouds.provider=azureblob-sdk` with BOTH
//     `jclouds.identity` and `jclouds.credential` EMPTY makes the backend build
//     an Azure `DefaultAzureCredential`. On Container Apps that resolves through
//     the **IDENTITY_ENDPOINT / IDENTITY_HEADER** pair the platform injects (ACA
//     does NOT expose the IMDS 169.254.169.254 endpoint — see the
//     AcaManagedIdentityCredential incident note in docs/fiab/), selecting the
//     identity named by `AZURE_CLIENT_ID`. **No storage account key, no SAS, no
//     connection string anywhere.** `AZURE_AUTHORITY_HOST` is derived per cloud
//     so the same template authenticates in Azure Government.
//     UNVERIFIED-IN-PRODUCT: whether the Java azure-identity bundled in s3proxy
//     3.3.0 resolves the ACA endpoint has NOT been proven by a live run. If it
//     does not, /healthz stays green (it needs no storage) while every S3
//     request 403s — so the deploy receipt MUST include a real GET, not a probe.
//   * READ-ONLY BY DEFAULT (`s3proxy.read-only-blobstore=true`). The gateway
//     exists so external engines can READ the governed lake; write verbs are
//     refused by the proxy itself, which makes the posture structural rather
//     than advisory. Flip `readOnly:false` in the config bag for an
//     Iceberg-writer client — and note the IAM grant is READER, so a writer
//     client also needs an explicit Contributor grant.
//   * NO ANONYMOUS MODE (round-2 fix). S3 signature checking is ALWAYS on.
//     Round 1 exposed an `authorization` key that accepted `'none'`, which was
//     one config-bag typo away from an unauthenticated S3 face over the
//     governed lake. The key now accepts only signed modes and anything else
//     (including 'none') is COERCED to `aws-v2-or-v4`.
//   * The S3 wire credential is NEVER the shipped default. The upstream image
//     ships `S3PROXY_IDENTITY=local-identity` / `S3PROXY_CREDENTIAL=
//     local-credential` — a publicly-known pair. This module ALWAYS overrides
//     both, delivered as Container Apps **secrets** (never plain env), and
//     mirrors them into the Loom Key Vault (when `keyVaultId` is supplied) so an
//     operator can hand them to a client without reading the container spec.
//   * CREDENTIAL SOURCE — TWO MODES, BOTH DISCLOSED (round-2 fix).
//       (a) `s3AccessKey`/`s3SecretKey` supplied: the orchestrator derives them
//           from `loomGeneratedSecretSeed`, which is `newGuid()` in
//           platform/fiab/bicep/main.bicep. UNPREDICTABLE — but it CHANGES ON
//           EVERY FULL REDEPLOY, so any external S3 client (Trino, Spark, boto3)
//           holding the old pair starts failing with SignatureDoesNotMatch until
//           it re-reads `loom-s3-gateway-access-key` /
//           `loom-s3-gateway-secret-key` from Key Vault. Round 1 shipped this
//           mode and did not say so.
//       (b) both EMPTY (the default, and what the dlz-attach pass uses): derived
//           from this module's own dedicated storage identity's principal id.
//           STABLE across redeploys — no silent client breakage — at the cost of
//           being recomputable by a principal that already holds Reader on this
//           resource group. The gateway is internal-ingress-only and the S3
//           signature is a second factor on top of the VNet perimeter, so that
//           is the right default; pick (a) where the RG has broad reader access.
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
  uamiId                 User-assigned managed identity RESOURCE id used ONLY as the
                         ACR pull credential (and Key Vault secretRef reader). The
                         STORAGE data plane runs as this module's own dedicated
                         least-privilege identity, NOT this one.
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
  authorization          S3 signature mode. Only signed modes are honoured
                         ('aws-v2', 'aws-v4', 'aws-v2-or-v4'); ANY other value —
                         including 'none' — is coerced to 'aws-v2-or-v4'. There is
                         deliberately no way to reach an unauthenticated S3 face.
  minReplicas            Default 0 (scale-to-zero — see the COST block).
  maxReplicas            Default 3.
  cpu / memory           Container resources (default 0.5 vCPU / 1Gi).''')
param s3GatewayConfig object

@description('S3 wire access-key id ("identity"). OPTIONAL. When supplied the orchestrator derives it from loomGeneratedSecretSeed (newGuid()) — unpredictable, but it ROTATES on every full redeploy. When EMPTY the module derives a stable value from its own dedicated storage identity\'s principal id, which survives redeploys but is recomputable by a principal holding Reader on this resource group. Pick per estate; both are documented in the SECURITY POSTURE block. @secure() so it never lands in deployment output.')
@secure()
param s3AccessKey string = ''

@description('S3 wire secret access key ("credential"). Same optional/stable-vs-unpredictable trade as s3AccessKey. @secure() so it never lands in deployment output.')
@secure()
param s3SecretKey string = ''

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
var lakeStorageAccountName = s3GatewayConfig.lakeStorageAccountName
// Pinned upstream Apache-2.0 release tag — never :latest (supply-chain drift).
var image = string(s3GatewayConfig.?image ?? 'docker.io/andrewgaul/s3proxy:3.3.0')
var acrLoginServer = string(s3GatewayConfig.?acrLoginServer ?? '')
var targetPort = int(s3GatewayConfig.?targetPort ?? 80)
var readOnly = bool(s3GatewayConfig.?readOnly ?? true)
// SIGNED MODES ONLY. Anything else — notably 'none', which would disable S3
// credential checking entirely and expose an unauthenticated face over the
// governed lake — is coerced to the default. There is no config-bag path to an
// anonymous gateway.
var requestedAuthorization = string(s3GatewayConfig.?authorization ?? 'aws-v2-or-v4')
var authorization = contains(['aws-v2', 'aws-v4', 'aws-v2-or-v4'], requestedAuthorization) ? requestedAuthorization : 'aws-v2-or-v4'
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

// ── Dedicated least-privilege storage identity ───────────────────────────────
// The proxy parses attacker-influenced S3 signatures and XML. It must NOT hold
// the Console UAMI's token. This identity is granted ONLY Storage Blob Data
// Reader on the lake, by s3-gateway-lake-rbac.bicep at the lake's own scope
// (which may be a different RG — and, on a dlz-attach estate, a different
// SUBSCRIPTION — from this module's).
resource storageIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'uami-loom-s3gw-${location}'
  location: location
  tags: tags
}

// Effective S3 wire credential. Orchestrator-supplied (unpredictable, rotates)
// wins; otherwise a value derived from the dedicated identity's principal id,
// which is STABLE across redeploys — so an external S3 client (Trino, Spark,
// boto3) does not start failing with SignatureDoesNotMatch after a routine
// redeploy. Either way it is never the image's shipped local-identity /
// local-credential pair, and it is delivered as a Container Apps SECRET.
var derivedAccessKey = 'loom${uniqueString(storageIdentity.properties.principalId, 'loom-s3-gw-id-v1')}'
var derivedSecretKey = 'S3g${uniqueString(storageIdentity.properties.principalId, 'loom-s3-gw-key-v1')}${uniqueString(storageIdentity.properties.principalId, 'loom-s3-gw-key-v2')}'
var effAccessKey = empty(s3AccessKey) ? derivedAccessKey : s3AccessKey
var effSecretKey = empty(s3SecretKey) ? derivedSecretKey : s3SecretKey

resource app 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      // ACR pull credential (and Key Vault secretRef reader) only.
      '${uamiId}': {}
      // The STORAGE data-plane identity AZURE_CLIENT_ID selects below. Reader
      // on the lake, nothing else.
      '${storageIdentity.id}': {}
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
        { name: 's3-access-key', value: effAccessKey }
        { name: 's3-secret-key', value: effSecretKey }
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
            // Target the DEDICATED least-privilege identity (Storage Blob Data
            // Reader on the lake, nothing else) + the correct sovereign
            // authority. On Container Apps DefaultAzureCredential resolves this
            // through IDENTITY_ENDPOINT/IDENTITY_HEADER, not IMDS.
            { name: 'AZURE_CLIENT_ID', value: storageIdentity.properties.clientId }
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
    value: effAccessKey
    contentType: 's3-gateway-access-key-id'
    attributes: { enabled: true }
  }
}

resource secretKeySecret 'Microsoft.KeyVault/vaults/secrets@2024-04-01-preview' = if (!empty(keyVaultId)) {
  parent: keyVault
  name: secretKeySecretName
  properties: {
    value: effSecretKey
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

@description('PRINCIPAL (object) id of the dedicated storage identity. Feed this to s3-gateway-lake-rbac.bicep AT THE LAKE\'S OWN SCOPE (its RG, and on a dlz-attach estate its SUBSCRIPTION) to grant Storage Blob Data Reader. The gateway serves 403s until that grant exists — which is the correct fail-closed order.')
output storageUamiPrincipalId string = storageIdentity.properties.principalId

@description('CLIENT id of the dedicated storage identity (what AZURE_CLIENT_ID selects).')
output storageUamiClientId string = storageIdentity.properties.clientId

@description('Resource id of the dedicated storage identity.')
output storageUamiId string = storageIdentity.id

@description('S3 signature mode actually applied. Always a SIGNED mode — an anonymous gateway is unreachable through the config bag.')
output authorizationMode string = authorization

@description('TRUE — identity-based ADLS access only (DefaultAzureCredential over the Container Apps identity endpoint, as a DEDICATED Storage-Blob-Data-Reader UAMI); no storage key/SAS/connection string is present anywhere in this deployment. Emitted so the deploy receipt can assert the posture.')
output identityBasedStorageAuth bool = true

@description('TRUE when the proxy refuses every write verb (s3proxy.read-only-blobstore).')
output readOnly bool = readOnly
