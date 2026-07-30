// CSA Loom — loom-sharing: the OSS Delta Sharing reference server Container App.
//
// LU-9. Backs LOOM_SHARING_URL for the Console's Delta Sharing BFF
// (apps/fiab-console/lib/sharing/*) so Azure Government gets a real
// open-protocol sharing endpoint over the SAME ADLS Gen2 Delta tables the Loom
// lakehouse already writes. Databricks Delta Sharing has NO Azure Government
// endpoint and OSS Unity Catalog 0.5 does not implement the sharing server, so
// this is the only in-boundary, license-clean way to speak the protocol.
//
// Azure-native only — no Microsoft Fabric / Power BI / OneLake dependency
// (.claude/rules/no-fabric-dependency.md).
//
// ── WHY INGRESS IS INTERNAL-ONLY AND HAS NO "external" PARAM ───────────────
// The upstream reference server's ONLY authorization primitive is a single
// global bearer token (ServerConfig.scala / Authorization on v0.7.8). It cannot
// scope a caller to a subset of shares: every holder of that token sees every
// share in the config. So the server can never be the recipient-facing
// endpoint, and this module deliberately exposes no switch to make it one.
//
// Recipients terminate on the Loom Console at /api/delta-sharing/*, where they
// present a Microsoft Entra token, the recipient→share grant is resolved from
// Cosmos, and anything outside that grant is refused BEFORE a byte is proxied
// here. The bearer below is a Console→server credential vended from Key Vault,
// and consoleAllowedCidrs pins the socket to the Console's subnet on top of
// internal-ingress isolation.
// Threat model: docs/fiab/security/loom-sharing-threat-model.md.
//
// STANDALONE ENTRYPOINT: admin-plane/main.bicep is at the ARM 256-parameter
// ceiling, so this deploys out-of-band (like loom-unity-app.bicep), then
// LOOM_SHARING_URL is set on the Console app. Until wired, the sharing BFF
// honest-gates (LoomSharingNotConfiguredError) and Commercial keeps using
// Databricks Delta Sharing. Orphan-allowlisted in scripts/ci/check-bicep-sync.mjs.
//
//   az deployment group create -g <admin-rg> \
//     -f platform/fiab/bicep/modules/compute/loom-sharing-app.bicep \
//     -p location=<region> environmentId=<cae-id> \
//        acrLoginServer=<acr>.azurecr.io image=<acr>.azurecr.io/loom-sharing:<tag> \
//        sharingUamiId=<uami-id> \
//        sharingBearerSecretUri=https://<vault>.vault.azure.net/secrets/loom-sharing-bearer \
//        adlsAccount=<lake-account> adlsClientId=<sp-client-id> \
//        adlsClientSecretUri=https://<vault>.vault.azure.net/secrets/loom-sharing-adls \
//        consoleAllowedCidrs='["<cae-infrastructure-subnet-cidr>"]' \
//        complianceTags='{ "env": "gov" }'
//   # then: az containerapp update -n <console> -g <admin-rg> --set-env-vars \
//   #         LOOM_SHARING_URL=https://<this-app-fqdn>
//   #       and set the LOOM_SHARING_BEARER secretref on the Console app so the
//   #       BFF can authenticate to this server.

targetScope = 'resourceGroup'

@description('Container App name (DNS-label safe, <= 32 chars).')
@maxLength(32)
param name string = 'loom-sharing'

@description('Deployment region (e.g. usgovvirginia / centralus).')
param location string

@description('Container Apps managed-environment (CAE) resource id — the console VNet-integrated env.')
param environmentId string

@description('UserAssigned UAMI resource id — assigned for ACR image pull and for resolving the Key Vault secretrefs below (needs "Key Vault Secrets User" on the vault). NOTE: this identity is NOT how the server reads the lake — hadoop-azure cannot use a Container Apps managed identity (it asks the classic IMDS endpoint, which ACA does not serve), so storage access is the OAuth service principal below.')
param sharingUamiId string

@description('ACR login server, e.g. acrloom.azurecr.io.')
param acrLoginServer string

@description('Container image reference (the loom-sharing image in ACR — pin an explicit tag, never :latest).')
param image string

@description('Internal ingress target port the Delta Sharing server listens on.')
param targetPort int = 8080

@description('URL prefix the Delta Sharing protocol is served under. The Console BFF proxies to <fqdn><endpoint>/... — change both together or not at all.')
param sharingEndpoint string = '/delta-sharing'

// ── Authorization (fail-closed; there is no "no bearer" deployment) ─────────

@description('REQUIRED. Key Vault secret URI (https://<vault>.vault.azure.net/secrets/<name>) holding the Console→server bearer. Wired as a Container Apps SECRET REFERENCE resolved by sharingUamiId — never an inline literal. The container REFUSES TO BOOT without it, because the upstream server treats a missing bearer as "no authentication required", which would expose every published share to anything that can reach the Container Apps environment.')
param sharingBearerSecretUri string

@description('REQUIRED - no default, so the network posture is a decision and not an omission. CIDR ranges allowed to reach this app on top of internal-ingress isolation: normally ONLY the Container Apps environment infrastructure subnet the Console runs in (az containerapp env show --query properties.vnetConfiguration.infrastructureSubnetId, then that subnet addressPrefix). ACA supports Allow-only or Deny-only rule sets; these are emitted as Allow rules, so anything outside them is denied. Pass [] to deliberately opt out - that leaves internal ingress as the SOLE control, so anything with a route into the Container Apps environment plus the Console bearer can read every published share (threat-model row E2).')
param consoleAllowedCidrs array

// ── Shared data (ADLS Gen2 Delta — the SAME lake the lakehouse item writes) ─

@description('ADLS Gen2 storage account holding the shared Delta tables. Empty => metadata-only: the server boots and answers the protocol, but table reads fail at the storage layer. Wire it for a functional deployment.')
param adlsAccount string = ''

@description('Entra tenant of the storage OAuth principal. Empty => the deployment tenant.')
param adlsTenantId string = ''

@description('Client id of the storage OAuth service principal. Grant it Storage Blob Data READER on the shared container(s) and nothing more — this server never writes.')
param adlsClientId string = ''

@description('Key Vault secret URI holding that service principal secret. Wired as a Container Apps SECRET REFERENCE resolved by sharingUamiId — never inline, never on an `az containerapp update --set-env-vars` line (that lands the secret in ARM deployment history and shell history).')
param adlsClientSecretUri string = ''

@description('Entra authority host for the ACTIVE cloud. Empty => derived from environment().authentication.loginEndpoint (login.microsoftonline.com in Commercial, login.microsoftonline.us in Azure Government) — never hard-coded on a code path.')
param authorityHost string = ''

@description('ADLS dfs endpoint suffix. Empty => derived from environment().suffixes.storage (core.windows.net / core.usgovcloudapi.net) so Gov never points at a Commercial endpoint.')
param adlsSuffix string = ''

// ── Published shares ───────────────────────────────────────────────────────

@description('base64 of the YAML `shares:` block published to this server, as rendered by the Console (GET /api/marketplace/sharing/manifest). Empty => an EMPTY share list, which is the correct day-one state: the server runs and lists nothing until an operator publishes. base64 because a YAML document does not survive an ACA env-var round trip intact.')
param sharesManifestB64 string = ''

// ── Lifetimes ──────────────────────────────────────────────────────────────

@description('Lifetime of the pre-signed/SAS file URLs the server hands to a recipient. That URL IS a bearer credential for the file, so the default is deliberately shorter than upstream\'s 3600s.')
@minValue(60)
@maxValue(3600)
param urlTimeoutSeconds int = 900

@description('Maximum replica count. The reference server is stateless (config + Delta log reads), so it scales horizontally.')
@minValue(1)
@maxValue(10)
param maxReplicas int = 3

@description('Minimum replica count. NOT scale-to-zero — a cold JVM makes the first recipient request time out.')
@minValue(1)
@maxValue(10)
param minReplicas int = 1

@description('Concurrent HTTP requests per replica before the server scales out.')
@minValue(1)
param scaleConcurrentRequests int = 40

@description('Compliance/cost tags.')
param complianceTags object = {}

// Sovereign-safe derivations — never a hard-coded host on a code path.
var derivedAuthorityHost = replace(replace(environment().authentication.loginEndpoint, 'https://', ''), '/', '')
var effectiveAuthorityHost = empty(authorityHost) ? derivedAuthorityHost : authorityHost
var effectiveAdlsSuffix = empty(adlsSuffix) ? 'dfs.${environment().suffixes.storage}' : adlsSuffix
// A storage account with no principal would boot a server that lists shares it
// cannot read; the entrypoint fails closed on exactly that, so keep the two
// halves together here too.
var adlsWired = !empty(adlsAccount) && !empty(adlsClientId) && !empty(adlsClientSecretUri)

var envVars = concat(
  [
    { name: 'LOOM_SHARING_PORT', value: string(targetPort) }
    { name: 'LOOM_SHARING_HOST', value: '0.0.0.0' }
    { name: 'LOOM_SHARING_ENDPOINT', value: sharingEndpoint }
    { name: 'LOOM_SHARING_AUTHORITY_HOST', value: effectiveAuthorityHost }
    { name: 'LOOM_SHARING_URL_TIMEOUT_SECONDS', value: string(urlTimeoutSeconds) }
    { name: 'LOOM_SHARING_CREDENTIAL_VALIDITY_SECONDS', value: string(urlTimeoutSeconds) }
    // Fail-closed bearer. Always a secretref; there is no literal path.
    { name: 'LOOM_SHARING_BEARER', secretRef: 'sharing-bearer' }
  ],
  empty(sharesManifestB64) ? [] : [
    { name: 'LOOM_SHARING_SHARES_B64', value: sharesManifestB64 }
  ],
  adlsWired ? [
    { name: 'LOOM_SHARING_ADLS_ACCOUNT', value: adlsAccount }
    { name: 'LOOM_SHARING_ADLS_SUFFIX', value: effectiveAdlsSuffix }
    { name: 'LOOM_SHARING_ADLS_TENANT', value: empty(adlsTenantId) ? tenant().tenantId : adlsTenantId }
    { name: 'LOOM_SHARING_ADLS_CLIENT_ID', value: adlsClientId }
    { name: 'LOOM_SHARING_ADLS_CLIENT_SECRET', secretRef: 'sharing-adls-client-secret' }
  ] : []
)

// Key-Vault-backed Container Apps secrets. `keyVaultUrl` + `identity` means the
// platform resolves the secret with the UAMI at revision start — the secret
// VALUE never enters the template, the deployment history, or
// `az containerapp show`. The UAMI needs "Key Vault Secrets User" on the vault.
var appSecrets = concat(
  [
    { name: 'sharing-bearer', keyVaultUrl: sharingBearerSecretUri, identity: sharingUamiId }
  ],
  adlsWired ? [
    { name: 'sharing-adls-client-secret', keyVaultUrl: adlsClientSecretUri, identity: sharingUamiId }
  ] : []
)

// INTERNAL only — reached by the Console over the CAE network, NEVER public.
// See the header: the upstream server cannot scope a caller to a subset of
// shares, so a public ingress would hand every recipient every share.
var ingressIpRules = [for (cidr, i) in consoleAllowedCidrs: {
  name: 'allow-loom-console-${i}'
  description: 'LU-9: only the Loom Console subnet may reach the sharing server.'
  ipAddressRange: cidr
  action: 'Allow'
}]
var ingressBase = {
  external: false
  targetPort: targetPort
  transport: 'auto'
}
var ingressConfig = empty(consoleAllowedCidrs) ? ingressBase : union(ingressBase, {
  ipSecurityRestrictions: ingressIpRules
})

// Pinned to the same Container Apps api-version the sibling ACA modules use
// (loom-unity-app.bicep / loom-onelake-app.bicep) — bicep/runtime sync.
resource app 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: name
  location: location
  tags: complianceTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${sharingUamiId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: ingressConfig
      secrets: appSecrets
      registries: [
        {
          server: acrLoginServer
          identity: sharingUamiId
        }
      ]
    }
    template: {
      containers: [
        {
          name: name
          image: image
          env: envVars
          // 1 vCPU / 2Gi — a JVM reading Delta logs and signing URLs; the data
          // itself never transits this process (recipients fetch files direct
          // from storage with the short-lived URL).
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          // The Delta Sharing protocol has no unauthenticated health path (every
          // route sits behind the bearer), so liveness/readiness are TCP connects
          // to the API port — the honest "server is listening" signal rather than
          // a fabricated 200. The Console's own probe exercises the real protocol.
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
      scale: {
        minReplicas: minReplicas
        maxReplicas: max(maxReplicas, minReplicas)
        rules: [
          {
            name: 'sharing-http'
            http: {
              metadata: {
                concurrentRequests: string(scaleConcurrentRequests)
              }
            }
          }
        ]
      }
    }
  }
}

@description('Internal FQDN of the deployed Delta Sharing server (the Console reads it as LOOM_SHARING_URL, prefixed https://).')
output fqdn string = app.properties.configuration.ingress.fqdn

@description('Container App resource id.')
output appId string = app.id

@description('The protocol prefix the server answers on — the Console BFF proxies to https://<fqdn><endpoint>/shares/...')
output sharingEndpoint string = sharingEndpoint

@description('TRUE when ingress is pinned to an IP allow-list on top of internal-ingress isolation. Ingress is internal in EVERY configuration — this module exposes no way to publish the server publicly, by design.')
output ingressIpRestricted bool = !empty(consoleAllowedCidrs)

@description('TRUE when the server can actually READ the shared tables (storage account + OAuth principal + Key Vault secret all wired). FALSE means metadata-only: shares list, table reads fail at the storage layer.')
output storageWired bool = adlsWired
