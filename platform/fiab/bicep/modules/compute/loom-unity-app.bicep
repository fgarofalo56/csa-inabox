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
// public) AND — since LU-2 — Entra-backed authorization ON by default, with an
// optional IP allow-list pinning ingress to the Console subnet. The catalog DB is
// the default H2 file DB persisted on a mounted Azure Files share (so the catalog
// survives restarts); Postgres is opt-in via LOOM_UNITY_DB_URL. minReplicas:1 —
// the catalog is on the metadata hot path.
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
//        unityUamiId=<uami-id> entraClientId=<loom-unity-app-reg-client-id> \
//        consoleAllowedCidrs='["<cae-infrastructure-subnet-cidr>"]' \
//        complianceTags='{ "env": "gov" }'
//   # then: az containerapp update -n <console> -g <admin-rg> --set-env-vars \
//   #         LOOM_UC_BACKEND=oss LOOM_UNITY_URL=https://<this-app-fqdn> \
//   #         LOOM_UNITY_CLIENT_ID=<loom-unity-app-reg-client-id>

targetScope = 'resourceGroup'

@description('Container App name (DNS-label safe, <= 32 chars).')
@maxLength(32)
param name string = 'loom-unity'

@description('Deployment region (e.g. usgovvirginia / centralus).')
param location string

@description('Container Apps managed-environment (CAE) resource id — the console VNet-integrated env.')
param environmentId string

@description('UserAssigned UAMI resource id — assigned for ACR image pull, for resolving the Key Vault secretrefs below (needs "Key Vault Secrets User" on the vault), and as the app identity via IMDS. The catalog DB is a file mount; optional ADLS vending uses a service principal whose secret arrives as a Key Vault secretref, never inline.')
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

// ── LU-2 — AuthN/Z hardening ────────────────────────────────────────────────
// Before LU-2 this app shipped `server.authorization=disable` and the CAE VNet was
// the ONLY control: any workload that could reach the environment could read AND
// mutate Loom Unity catalog metadata anonymously (and, with vending wired, mint
// ADLS delegation SAS). LU-2 makes Entra-backed authorization the DEFAULT, moves
// every credential to a Key Vault secretref, and lets the operator pin ingress to
// the Console's subnet. Threat model: docs/fiab/security/loom-unity-threat-model.md.

@description('Loom Unity authorization posture. "entra" (DEFAULT) enables the upstream OSS authorization server with Microsoft Entra as the identity provider — issuer and audience are pinned, and the server refuses to boot half-configured. "disabled" is an explicit, audited opt-out that leaves the catalog readable/writable by anything on the VNet (the pre-LU-2 posture); the container logs a SECURITY WARNING on every boot and the Console health probe reports it as a failing check.')
@allowed([
  'entra'
  'disabled'
])
param authMode string = 'entra'

@description('Entra tenant id whose tokens Loom Unity accepts. Defaults to the deployment tenant. The allowed issuer is derived as https://<authorityHost>/<tenantId>/v2.0 (the form upstream documents for Microsoft Entra ID).')
param entraTenantId string = tenant().tenantId

@description('Entra application (client) id that fronts Loom Unity — the audience the Console requests its bearer for. Pass the SAME app registration the Console signs in with (LOOM_MSAL_CLIENT_ID) unless you registered a dedicated one. Accepted audiences are derived as "api://<clientId>,<clientId>". Leaving this EMPTY leaves authorization OFF (no audience can be pinned, and an authorization server with no pinned audience is worse than an honest open door) — the container then logs a SECURITY WARNING on every boot and the Console reports the `svc-loom-unity-authz` gate + a failing `probe-loom-unity-authz` health check with this exact remediation.')
param entraClientId string = ''

@description('Key Vault secret URI (https://<vault>.vault.azure.net/secrets/<name>) holding the Entra client secret for the OSS authorization server. Wired as a Container Apps SECRET REFERENCE resolved by unityUamiId — NEVER an inline literal. Empty => no client secret is rendered (pure bearer-validation mode, which is all the Console path needs).')
param entraClientSecretUri string = ''

@description('Entra authority host for the ACTIVE cloud. Empty => derived from environment().authentication.loginEndpoint (login.microsoftonline.com in Commercial, login.microsoftonline.us in Azure Government) — never hard-coded on a code path.')
param authorityHost string = ''

@description('Explicit comma-separated JWT audiences override. Empty => derived from entraClientId.')
param entraAudiences string = ''

@description('CIDR ranges allowed to reach this app on top of internal-ingress isolation — normally ONLY the Container Apps environment infrastructure subnet the Console runs in. Empty => no IP rules (internal ingress remains the sole network control, the pre-LU-2 posture). ACA supports Allow-only or Deny-only rule sets; these are emitted as Allow rules, so anything outside them is denied.')
param consoleAllowedCidrs array = []

// ── Optional ADLS credential vending (opt-in; secret via Key Vault only) ────

@description('ADLS Gen2 storage account Loom Unity may vend short-lived delegation-SAS credentials for. Empty (DEFAULT) => no vending; data access stays on Loom managed-identity / ACL paths.')
param adlsAccount string = ''

@description('Entra tenant of the vending service principal. Empty => entraTenantId.')
param adlsTenantId string = ''

@description('Client id of the vending service principal.')
param adlsClientId string = ''

@description('Key Vault secret URI holding the vending service-principal secret. Wired as a Container Apps SECRET REFERENCE resolved by unityUamiId — never inline (the pre-LU-2 docs told operators to pass it on an `az containerapp update --set-env-vars` line, which lands the secret in ARM deployment history and shell history).')
param adlsClientSecretUri string = ''

var dbShareName = 'unity-db'
var dbStorageLink = 'unity-db'
var dbMountPath = '/home/unitycatalog/etc/db'

// Sovereign-safe authority host: strip scheme + trailing slash off the cloud's
// login endpoint (Commercial https://login.microsoftonline.com/, Azure Government
// https://login.microsoftonline.us/) so Gov never sees a Commercial issuer.
var derivedAuthorityHost = replace(replace(environment().authentication.loginEndpoint, 'https://', ''), '/', '')
var effectiveAuthorityHost = empty(authorityHost) ? derivedAuthorityHost : authorityHost
// Authorization can only be ENFORCED when an audience can be pinned. authMode=entra
// with no entraClientId (and no explicit entraAudiences) would render an
// authorization server that validates the issuer but accepts ANY audience — a
// worse posture than an honest open door — so we keep it off and surface the gate.
var audiencePinned = !empty(entraClientId) || !empty(entraAudiences)
var authEnabled = authMode == 'entra' && audiencePinned

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
  ],
  // LU-2 — Entra authorization. LOOM_UNITY_AUTH is explicit in BOTH directions so
  // the running container never depends on the entrypoint's inference: 'enable'
  // (with a pinned issuer + audience, else the container fails closed on boot) or
  // 'disable' (an audited opt-out that logs a SECURITY WARNING every boot).
  authEnabled ? [
    { name: 'LOOM_UNITY_AUTH', value: 'enable' }
    { name: 'LOOM_UNITY_ENTRA_TENANT_ID', value: entraTenantId }
    { name: 'LOOM_UNITY_ENTRA_CLIENT_ID', value: entraClientId }
    { name: 'LOOM_UNITY_AUTHORITY_HOST', value: effectiveAuthorityHost }
    { name: 'LOOM_UNITY_AUDIENCES', value: entraAudiences }
  ] : [
    { name: 'LOOM_UNITY_AUTH', value: 'disable' }
  ],
  (authEnabled && !empty(entraClientSecretUri)) ? [
    { name: 'LOOM_UNITY_ENTRA_CLIENT_SECRET', secretRef: 'unity-entra-client-secret' }
  ] : [],
  // Optional ADLS credential vending — secret ALWAYS via Key Vault secretref.
  empty(adlsAccount) ? [] : [
    { name: 'LOOM_UNITY_ADLS_ACCOUNT', value: adlsAccount }
    { name: 'LOOM_UNITY_ADLS_TENANT', value: empty(adlsTenantId) ? entraTenantId : adlsTenantId }
    { name: 'LOOM_UNITY_ADLS_CLIENT_ID', value: adlsClientId }
  ],
  (!empty(adlsAccount) && !empty(adlsClientSecretUri)) ? [
    { name: 'LOOM_UNITY_ADLS_CLIENT_SECRET', secretRef: 'unity-adls-client-secret' }
  ] : []
)

// Key-Vault-backed Container Apps secrets. `keyVaultUrl` + `identity` means the
// platform resolves the secret with the UAMI at revision start — the secret VALUE
// never enters the template, the deployment history, or `az containerapp show`.
// The UAMI needs "Key Vault Secrets User" on the vault (grant in the KV module).
var appSecrets = concat(
  (authEnabled && !empty(entraClientSecretUri)) ? [
    { name: 'unity-entra-client-secret', keyVaultUrl: entraClientSecretUri, identity: unityUamiId }
  ] : [],
  (!empty(adlsAccount) && !empty(adlsClientSecretUri)) ? [
    { name: 'unity-adls-client-secret', keyVaultUrl: adlsClientSecretUri, identity: unityUamiId }
  ] : []
)

// INTERNAL only — reached by the Console over the CAE network, never public.
// LU-2 adds an optional IP allow-list on top so that "on the VNet" is no longer
// sufficient: only the Console's subnet(s) may open a connection.
var ingressIpRules = [for (cidr, i) in consoleAllowedCidrs: {
  name: 'allow-loom-console-${i}'
  description: 'LU-2: only the Loom Console subnet may reach Loom Unity.'
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
      ingress: ingressConfig
      secrets: appSecrets
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

@description('LU-2 — TRUE only when Loom Unity actually enforces Entra bearer authorization (authMode=entra AND an audience is pinned). FALSE means the catalog is reachable anonymously by anything that can reach it on the network; wire entraClientId and redeploy. Cross-check live with the Console health probe probe-loom-unity-authz.')
output authorizationEnforced bool = authEnabled

@description('LU-2 — TRUE when ingress is pinned to an IP allow-list on top of internal-ingress isolation.')
output ingressIpRestricted bool = !empty(consoleAllowedCidrs)

@description('LU-2 — the Entra audiences Loom Unity accepts (empty when authorization is not enforced). Set the Console app LOOM_UNITY_CLIENT_ID to the same app registration so it mints a matching bearer.')
output acceptedAudiences string = authEnabled ? (empty(entraAudiences) ? 'api://${entraClientId},${entraClientId}' : entraAudiences) : ''
