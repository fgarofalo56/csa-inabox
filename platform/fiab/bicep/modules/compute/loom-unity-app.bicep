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
// optional IP allow-list pinning ingress to the Console subnet.
//
// PERSISTENCE (LU-1): the DEFAULT is an Entra-only, private-endpoint-only Azure
// Database for PostgreSQL Flexible Server (data-plane/loom-unity-postgres.bicep)
// — pass its outputs as unityPostgresFqdn / unityPostgresDatabase / unityDbAadUser.
// The previous H2-file-DB-on-Azure-Files default is now a documented FALLBACK for
// deployments with no Postgres yet: it CrashLoopBackOff'd on Azure Government
// (CIFS mount blocks container start; H2's file-lock protocol has no reliable SMB
// semantics — see the dbEphemeral param), it has no backup/PITR, and being
// single-writer it pins the app to exactly ONE replica. With Postgres the app
// scales past one replica (maxReplicas below).
//
// DEPLOYED BY DEFAULT (svc-loom-unity-authz): admin-plane/main.bicep invokes this
// module on every boundary (`loomUnityActive` — Container Apps + deployAppsEnabled)
// and emits LOOM_UNITY_URL / LOOM_UNITY_CLIENT_ID / LOOM_UNITY_AUDIENCE /
// LOOM_UNITY_AUTH_MODE on the Console, so a FRESH deploy gets an Entra-secured,
// IP-pinned catalog with no manual step. It previously deployed only out-of-band,
// and every caller omitted entraClientId — which silently produced an anonymous,
// VNet-readable-AND-writable catalog. It is still deployable standalone (below)
// for a targeted redeploy; entraClientId is effectively REQUIRED, because
// authMode=entra with nothing pinnable now fails CLOSED at boot instead of
// downgrading.
//
//   az deployment group create -g <admin-rg> \
//     -f platform/fiab/bicep/modules/compute/loom-unity-app.bicep \
//     -p location=<region> environmentId=<cae-id> \
//        acrLoginServer=<acr>.azurecr.io image=<acr>.azurecr.io/loom-unity:<tag> \
//        unityUamiId=<uami-id> unityUamiClientId=<uami-client-id> \
//        unityPostgresFqdn=<pg-fqdn> unityDbAadUser=<uami-name> \
//        entraClientId=<loom-unity-app-reg-client-id> \
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

@description('UserAssigned UAMI resource id — assigned for ACR image pull, for resolving the Key Vault secretrefs below (needs "Key Vault Secrets User" on the vault), for the Entra-only Postgres login (LU-1: this UAMI is the flexible server\'s Entra administrator), and as the app identity via IMDS.')
param unityUamiId string

@description('CLIENT id (appId) of that same UAMI — surfaced to the container as AZURE_CLIENT_ID so the Postgres JDBC Entra plugin knows WHICH user-assigned identity to mint a token for. Required whenever Postgres persistence is used with the default Entra (passwordless) DB auth; an ACA container with more than one identity cannot infer it.')
param unityUamiClientId string = ''

@description('ACR login server, e.g. acrloom.azurecr.io.')
param acrLoginServer string

@description('Container image reference (the loom-unity image in ACR — pin an explicit tag, never :latest).')
param image string

@description('Internal ingress target port the OSS Unity Catalog server listens on.')
param targetPort int = 8080

@description('Azure Files storage account name for the FALLBACK H2 catalog DB (.mv.db). Only created when no Postgres is wired and dbEphemeral is false. Auto-derived from the app name + a uniqueString when left default.')
@maxLength(24)
param dbStorageAccountName string = take('st${replace(name, '-', '')}${uniqueString(resourceGroup().id, name)}', 24)

// ── LU-1 — Postgres-by-default persistence ──────────────────────────────────
// Before LU-1 the default was an H2 file DB on an SMB-mounted Azure Files share.
// That default is contradicted by this module's own dbEphemeral note (H2-on-SMB
// CrashLoopBackOffs on Azure Government), by the live Gov deployment (which runs
// Postgres), and by the fact that a single-writer file DB forces maxReplicas:1.
// LU-1 makes a provisioned, Entra-only, private-endpoint-only PostgreSQL
// Flexible Server (data-plane/loom-unity-postgres.bicep) the DEFAULT store.

@description('LU-1 DEFAULT persistence: fully-qualified name of the Loom Unity PostgreSQL Flexible Server (the `fqdn` output of data-plane/loom-unity-postgres.bicep). Set this and the catalog is durable, backed up, and multi-writer. EMPTY => fall back to the legacy H2 file DB (single-writer, no backup, and known to CrashLoopBackOff on Azure Government SMB) and report it in the `persistenceBackend` output.')
param unityPostgresFqdn string = ''

@description('Catalog database on that server (the `databaseName` output of the Postgres module).')
param unityPostgresDatabase string = 'unitycatalog'

@description('PostgreSQL role Loom Unity authenticates as — the Entra principal NAME of unityUamiId (the `aadUser` output of the Postgres module). With Entra-only auth the role name must match the identity minting the token.')
param unityDbAadUser string = ''

@description('Database authentication mode. "entra" (DEFAULT) = passwordless: the JDBC driver mints an Entra access token from unityUamiClientId for every physical connection, so there is NO database password anywhere — matching the server\'s passwordAuth=Disabled. "password" is an explicit, audited opt-out for a BYO Postgres that still uses password auth; the password then MUST arrive as dbPasswordSecretUri (Key Vault), never inline.')
@allowed([
  'entra'
  'password'
])
param unityDbAuthMode string = 'entra'

@description('Key Vault secret URI holding the Postgres password. ONLY used when unityDbAuthMode=password (BYO server). Wired as a Container Apps SECRET REFERENCE resolved by unityUamiId — never an inline literal.')
param dbPasswordSecretUri string = ''

@description('Explicit Entra token RESOURCE for the Postgres data plane. Empty => derived per cloud (https://ossrdbms-aad.database.windows.net in Commercial/GCC, https://ossrdbms-aad.database.usgovcloudapi.net in GCC-High/IL5) from environment().suffixes.sqlServerHostname — never hard-coded on a code path.')
param unityDbAadResource string = ''

@description('Override the fully-formed JDBC URL (escape hatch for a BYO/external Postgres). Empty => derived from unityPostgresFqdn + unityPostgresDatabase. The entrypoint appends sslmode and, in entra mode, the authentication-plugin parameters.')
param unityDbUrl string = ''

@description('When true, back the FALLBACK H2 catalog DB with an EPHEMERAL EmptyDir volume instead of an Azure Files share — no storage account/share is created and no SMB mount is attached. This was the Azure-Government workaround before LU-1 (the CIFS mount blocks container start with CrashLoopBackOff before the app runs). Catalog metadata is NOT persisted across restarts. Ignored when Postgres is wired (Postgres owns its storage) — wire unityPostgresFqdn instead of reaching for this.')
param dbEphemeral bool = false

@description('Maximum replica count. Postgres is multi-writer, so LU-1 lifts the old hard cap of 1 (imposed by the single-writer H2 file DB) and lets the catalog scale + do a zero-downtime rolling revision. FORCED to 1 whenever the H2 fallback is in use, whatever this is set to.')
@minValue(1)
@maxValue(10)
param maxReplicas int = 3

@description('Minimum replica count. NOT scale-to-zero — the catalog is on the metadata hot path.')
@minValue(1)
@maxValue(10)
param minReplicas int = 1

@description('Concurrent HTTP requests per replica before the catalog scales out (only applied when Postgres persistence allows maxReplicas > 1).')
@minValue(1)
param scaleConcurrentRequests int = 40

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

@description('Entra application (client) id that fronts Loom Unity — the audience the Console requests its bearer for. Pass the SAME app registration the Console signs in with (LOOM_MSAL_CLIENT_ID) unless you registered a dedicated one. Accepted audiences are derived as "api://<clientId>,<clientId>". Leaving this EMPTY no longer downgrades to an anonymous catalog (that silent downgrade WAS the svc-loom-unity-authz finding): with authMode=entra the container is deployed with LOOM_UNITY_AUTH=enable and FAILS CLOSED at boot naming this exact var, so an unconfigured deployment serves nothing rather than serving everything. Deploy with authMode=disabled if — and only if — you are knowingly accepting the anonymous posture.')
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
// Authorization can only be ENFORCED when an audience can be pinned. Before the
// svc-loom-unity-authz fix, authMode=entra with no entraClientId SILENTLY
// rendered `server.authorization=disable` — i.e. the module's documented default
// ("Entra ON") produced an anonymous, VNet-readable-AND-writable catalog on any
// deployment that forgot one parameter. That silent downgrade is gone: authMode
// is now the ONLY thing that decides, and an unpinnable audience makes the
// container FAIL CLOSED at boot (the entrypoint dies naming the exact var)
// instead of quietly opening the door. `authorizationMisconfigured` surfaces the
// state as a deployment output so the receipt shows it without reading logs.
var audiencePinned = !empty(entraClientId) || !empty(entraAudiences)
var authEnabled = authMode == 'entra'
var authMisconfigured = authEnabled && !audiencePinned

// ── LU-1 — persistence resolution ───────────────────────────────────────────
// Postgres wins whenever it is wired (explicit URL override, or the FQDN from
// data-plane/loom-unity-postgres.bicep). Only then is the Azure Files H2 share
// skipped; only then can the app run more than one replica.
var derivedDbUrl = empty(unityPostgresFqdn) ? '' : 'jdbc:postgresql://${unityPostgresFqdn}:5432/${unityPostgresDatabase}'
var effectiveDbUrl = empty(unityDbUrl) ? derivedDbUrl : unityDbUrl
var usePostgres = !empty(effectiveDbUrl)
var dbEntraAuth = usePostgres && unityDbAuthMode == 'entra'
// Sovereign-safe Entra resource for the Postgres data plane. sqlServerHostname
// is '.database.windows.net' in Commercial/GCC and '.database.usgovcloudapi.net'
// in GCC-High/IL5, and the OSS-RDBMS Entra app id URI tracks the same suffix.
var derivedDbAadResource = 'https://ossrdbms-aad${environment().suffixes.sqlServerHostname}'
var effectiveDbAadResource = empty(unityDbAadResource) ? derivedDbAadResource : unityDbAadResource
// H2 is single-writer: a second replica would silently corrupt or lock the file
// DB, so the cap is FORCED to 1 on that path regardless of what was asked for.
var effectiveMaxReplicas = usePostgres ? max(maxReplicas, minReplicas) : 1
var effectiveMinReplicas = usePostgres ? minReplicas : 1

// ── Persistent catalog DB (FALLBACK path only) ──────────────────────────────
//    Dedicated Azure Files share (shared-key for the ACA mount, exactly like the
//    airflow metadata store) holding the H2 .mv.db. LU-1: created ONLY when no
//    Postgres is wired — with Postgres there is no share, no storage account,
//    no account key, and no SMB mount to fail on boot.
var useAzureFiles = !dbEphemeral && !usePostgres
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
    // Sovereign Entra authority host — emitted UNCONDITIONALLY (LU-1) because
    // BOTH the LU-2 authorization block and the LU-1 passwordless Postgres login
    // derive their endpoints from it. Emitting it once here keeps a single
    // runtime occurrence of the name (no branch can duplicate it).
    { name: 'LOOM_UNITY_AUTHORITY_HOST', value: effectiveAuthorityHost }
  ],
  // Azure Files DB path only when we actually mount it; otherwise force the
  // entrypoint's local ephemeral H2 dir (no SMB mount to fail on start).
  useAzureFiles ? [
    { name: 'LOOM_UNITY_DB_DIR', value: dbMountPath }
  ] : [
    { name: 'LOOM_UNITY_DB_LOCAL', value: '1' }
  ],
  // LU-1 — Postgres persistence (the DEFAULT). LOOM_UNITY_DB_AUTH is explicit in
  // both directions so the container never infers its DB credential posture:
  // 'entra' renders the passwordless JDBC authentication plugin (no password
  // exists anywhere), 'password' resolves a Key Vault secretref.
  usePostgres ? [
    { name: 'LOOM_UNITY_DB_URL', value: effectiveDbUrl }
    { name: 'LOOM_UNITY_DB_USER', value: unityDbAadUser }
    { name: 'LOOM_UNITY_DB_AUTH', value: unityDbAuthMode }
  ] : [],
  dbEntraAuth ? [
    { name: 'LOOM_UNITY_DB_AAD_RESOURCE', value: effectiveDbAadResource }
    // The Java Entra plugin resolves the user-assigned identity by client id —
    // an ACA container with more than one identity cannot infer which to use.
    { name: 'AZURE_CLIENT_ID', value: unityUamiClientId }
  ] : [],
  (usePostgres && unityDbAuthMode == 'password' && !empty(dbPasswordSecretUri)) ? [
    { name: 'LOOM_UNITY_DB_PASSWORD', secretRef: 'unity-db-password' }
  ] : [],
  // LU-2 — Entra authorization. LOOM_UNITY_AUTH is explicit in BOTH directions so
  // the running container never depends on the entrypoint's inference: 'enable'
  // (with a pinned issuer + audience, else the container fails closed on boot) or
  // 'disable' (an audited opt-out that logs a SECURITY WARNING every boot).
  authEnabled ? [
    { name: 'LOOM_UNITY_AUTH', value: 'enable' }
    { name: 'LOOM_UNITY_ENTRA_TENANT_ID', value: entraTenantId }
    { name: 'LOOM_UNITY_ENTRA_CLIENT_ID', value: entraClientId }
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
  (usePostgres && unityDbAuthMode == 'password' && !empty(dbPasswordSecretUri)) ? [
    { name: 'unity-db-password', keyVaultUrl: dbPasswordSecretUri, identity: unityUamiId }
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
      // NOT scale-to-zero — the catalog is on the metadata hot path.
      // LU-1: with Postgres the metastore is multi-writer, so the app scales out
      // and can do a zero-downtime rolling revision. On the H2 fallback the file
      // DB is single-writer and the cap is FORCED back to exactly one replica
      // (a second writer would corrupt or lock the .mv.db).
      scale: usePostgres ? {
        minReplicas: effectiveMinReplicas
        maxReplicas: effectiveMaxReplicas
        rules: [
          {
            name: 'catalog-http'
            http: {
              metadata: {
                concurrentRequests: string(scaleConcurrentRequests)
              }
            }
          }
        ]
      } : {
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

@description('LU-1 — which store actually backs the catalog: "postgres" (the default, durable + backed up + multi-writer), "h2-azure-files" (legacy fallback: single-writer, no backup, known to CrashLoopBackOff on Azure Government SMB), or "h2-ephemeral" (NOT persisted across restarts).')
output persistenceBackend string = usePostgres ? 'postgres' : (useAzureFiles ? 'h2-azure-files' : 'h2-ephemeral')

@description('LU-1 — TRUE when the catalog store authenticates with Entra tokens only, so no database credential exists anywhere (Postgres + entra auth mode). FALSE means either a credential-authenticated BYO Postgres or the H2 fallback.')
output dbEntraTokenAuth bool = dbEntraAuth

@description('LU-1 — the replica ceiling actually applied. Forced to 1 on the single-writer H2 fallback, whatever maxReplicas asked for.')
output effectiveMaxReplicas int = effectiveMaxReplicas

@description('LU-2 — TRUE only when Loom Unity actually enforces Entra bearer authorization (authMode=entra). FALSE means authMode=disabled was explicitly chosen and the catalog is reachable anonymously by anything that can reach it on the network. Cross-check live with the Console health probe probe-loom-unity-authz.')
output authorizationEnforced bool = authEnabled

@description('svc-loom-unity-authz — TRUE when authorization was REQUESTED (authMode=entra) but no audience could be pinned (both entraClientId and entraAudiences empty). The container then FAILS CLOSED at boot rather than serving anonymously: set entraClientId to the Entra app registration fronting Loom Unity (normally LOOM_MSAL_CLIENT_ID) and redeploy.')
output authorizationMisconfigured bool = authMisconfigured

@description('LU-2 — TRUE when ingress is pinned to an IP allow-list on top of internal-ingress isolation.')
output ingressIpRestricted bool = !empty(consoleAllowedCidrs)

@description('LU-2 — the Entra audiences Loom Unity accepts (empty only when authMode=disabled or nothing could be pinned). Set the Console app LOOM_UNITY_CLIENT_ID to the same app registration so it mints a matching bearer.')
output acceptedAudiences string = (authEnabled && audiencePinned) ? (empty(entraAudiences) ? 'api://${entraClientId},${entraClientId}' : entraAudiences) : ''
