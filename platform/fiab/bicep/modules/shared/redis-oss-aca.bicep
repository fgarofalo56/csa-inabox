// CSA Loom — OSS Redis (Valkey) on Azure Container Apps  [#2642, sovereign path]
// ============================================================================
// WHY THIS MODULE EXISTS
// ---------------------------------------------------------------------------
// Loom needs ONE shared, cross-replica Redis substrate per estate. THIS MODULE
// BACKS EXACTLY ONE CONSUMER TODAY: the PSR-5/6 query result cache
// (LOOM_RESULT_CACHE_REDIS), which admin-plane/main.bicep binds when
// `redisOssActive` (see main.bicep:5142 / :5153 / :6403).
//
// It does NOT back the PSR-3 Spark warm-lease store (LOOM_SPARK_POOL_REDIS) or
// the HYP-9 Capacity Broker timepoint ledger (LOOM_BROKER_REDIS). Nothing binds
// either of those to this cache — main.bicep:5112 emits LOOM_BROKER_REDIS as the
// empty string, and LOOM_SPARK_POOL_REDIS is emitted by no bicep at all. Do not
// read this header as a promise that pointing a broker at the endpoint below
// will work: this module sets `requirepass`, and the broker's Go client cannot
// authenticate to a bare `host:port` — it needs the credential IN the connection
// string (`host:6379,password=…`, see docs/fiab/runbooks/redis-amr-cutover.md
// §6.2 trap 3) AND a non-LRU eviction policy, because a lease/ledger key evicted
// under memory pressure is silent data loss, not a cache miss. Wiring either
// consumer here is a real change with those two prerequisites, not a rename.
//
// Commercial gets that from **Azure Managed Redis** (modules/shared/managed-redis.bicep).
// SOVEREIGN BOUNDARIES CANNOT: Azure Managed Redis is Azure Public cloud only —
// Learn, "Azure Managed Redis planning FAQs": *"Azure Managed Redis is only
// available in the global Azure cloud."* Microsoft Q&A, on Azure Government
// specifically: *"Azure Managed Redis is not available at this time, and there
// is no publicly announced ETA."*
//   https://learn.microsoft.com/azure/redis/planning-faq
//   https://learn.microsoft.com/answers/a/12551338
// Their only Azure-first-party option is the RETIRING classic Azure Cache for
// Redis (Microsoft.Cache/redis), which Microsoft turns off on 2028-10-01.
//   https://learn.microsoft.com/azure/azure-cache-for-redis/cache-whats-new
//
// So under .claude/rules/cloud-parity.md §3 — "where a cloud genuinely lacks a
// dependency, Loom supplies the Azure-native/OSS equivalent" — this module is
// the sovereign forward path, and it does NOT wait on an AMR-in-Gov date that
// does not exist. Same capability, different implementation, no lesser product
// for the boundary that needs it most.
//
// ── WHAT RUNS: VALKEY, NOT REDIS ────────────────────────────────────────────
// Valkey (valkey-io/valkey) is the Linux Foundation fork of Redis 7.2.4, wire-
// and command-compatible, and it is **BSD-3-Clause**. Redis itself relicensed to
// RSALv2/SSPL in 2024 and to AGPLv3 in Redis 8 — neither is a licence a federal
// estate wants in its deploy path, and LIC0 (scripts/ci/check-license-inventory.mjs)
// only admits permissive SPDX ids. Valkey is a drop-in for everything Loom
// actually sends: Loom's two Redis clients are hand-rolled RESP2 speakers using
// AUTH / GET / SET…EX / DEL (apps/fiab-console/lib/azure/redis-cache-client.ts)
// and AUTH / HINCRBYFLOAT / HGETALL / EXPIRE / PING
// (apps/loom-capacity-broker/internal/ledger/redis_ledger.go). No modules, no
// cluster, no Redis Stack surface.
//
// The image is pulled from the ESTATE ACR MIRROR, always (#2682 / FINISHLINE
// D14). `acrLoginServer` is REQUIRED and the ref is COMPOSED from it, so this
// module structurally cannot emit a public-registry pull — an air-gapped IL5
// enclave can deploy it. The upstream coordinate + its pinned digest live in
// platform/fiab/images/upstream-images.json and both cloud lanes import it with
// scripts/ci/mirror-upstream-images.sh.
//
// ── SECURITY POSTURE — READ BEFORE CHANGING ANYTHING ────────────────────────
//   1. A PASSWORD IS MANDATORY AND THE CONTAINER FAILS CLOSED WITHOUT ONE.
//      Redis/Valkey ship with NO authentication. A Container Apps environment
//      gives every app a pod IP in the SAME infrastructure subnet, so
//      loom-script-runner and loom-udf-runtime — whose PURPOSE is executing
//      user-supplied code — sit one TCP connect away from any listener in the
//      environment. That is not a hypothetical: it is exactly how
//      data-plane/loom-risingwave-aca.bicep shipped an unauthenticated root
//      superuser on 2026-07-29, and how compute/loom-unity-app.bicep shipped an
//      anonymously-writable catalog (#2643). ACA `ipSecurityRestrictions` CANNOT
//      separate CAE siblings (they draw from one subnet, and ingress rules do
//      not govern a direct pod-IP connect), and a dedicated environment has the
//      same problem one level up. Only a credential they do not hold does.
//      The entrypoint below therefore REFUSES TO START when the password
//      resolves empty — including when a Key Vault secretRef silently returns
//      nothing — rather than serving an open cache.
//   2. THE CREDENTIAL IS NEVER A LITERAL. It arrives as a Key-Vault-backed
//      Container Apps secret (`keyVaultUrl` + `identity`, resolved by this app's
//      UAMI at revision start) so the value never enters the template, the ARM
//      deployment history, or `az containerapp show`. The @secure() inline param
//      is the out-of-band alternative for an incremental provision. The UAMI
//      needs "Key Vault Secrets User" on the vault. It is written to a 0600
//      config file inside the container rather than passed on argv, so it does
//      not appear in the process table either.
//   3. NO TLS ON THE WIRE, AND THAT IS STATED, NOT HIDDEN. ACA `transport: tcp`
//      ingress is raw TCP — it does not terminate TLS — so the RESP AUTH and
//      every GET/SET travel in cleartext over the Container Apps environment's
//      internal VNet hop. This is the SAME posture the estate already accepts
//      for the loom-risingwave Postgres wire (data-plane/loom-risingwave-aca.bicep),
//      and callers MUST be told: the module publishes `tlsOnTheWire = false` and
//      the orchestrator sets LOOM_RESULT_CACHE_REDIS_TLS=0 on the Console so the
//      client does not attempt a TLS handshake against a plaintext listener and
//      silently fall back to its local tiers. Do not "fix" this by flipping the
//      Console's TLS flag without terminating TLS somewhere real.
//   4. INTERNAL INGRESS ONLY, with an OPTIONAL `allowedCidrs` allow-list as
//      defence-in-depth. Never external. There is no public door.
//
// ── DURABILITY — WHAT THIS DEPLOYMENT DOES AND DOES NOT GUARANTEE ───────────
// DEFAULT (`persistence: 'none'`): **the data is EPHEMERAL.** The replica
// filesystem does not survive the replica. An ACA revision roll, a scale event,
// a platform replica replacement, or an image bump DROPS EVERY KEY. RDB
// snapshotting is explicitly disabled (`save ""`) so nothing pretends otherwise.
// That is the correct default for a CACHE and every Loom consumer is built for
// it — the result cache falls through to its in-process LRU and then an honest
// direct query, and the Spark lease store falls back to Cosmos — but it is NOT
// correct for anything that treats Redis as a system of record. This module
// therefore publishes `dataDurable` so a deploy receipt states the posture
// instead of leaving the next reader to assume it.
//
// OPTIONAL (`persistence: 'aof'`): an Azure Files share is created, mounted, and
// Valkey runs append-only with `appendfsync everysec`, so a replaced replica
// reloads the AOF. Honest limits, stated rather than implied: (a) `everysec`
// means up to one second of writes can be lost on an abrupt termination; (b) the
// share is SMB over the network, so AOF appends are materially slower than local
// disk and a share stall shows up as Redis write latency; (c) it makes the cache
// stateful, which is why `maxReplicas` is pinned to 1 either way.
//
// ── WHY maxReplicas IS FORCED TO 1 ──────────────────────────────────────────
// ACA ingress LOAD-BALANCES across replicas. Two Valkey replicas behind one
// ingress are two INDEPENDENT, NON-REPLICATING datasets, so a client's GET would
// hit whichever process the connection landed on: a "shared" cache that answers
// differently per connection, with no error anywhere. That is a correctness
// trap, not a tuning choice, so the cap is FORCED here and cannot be raised
// through the config bag. Horizontal scale needs real replication (Valkey
// Cluster / Sentinel) AND a cluster-aware client, and Loom has neither — see the
// EnterpriseCluster note in modules/shared/managed-redis.bicep for the same
// constraint on the Commercial backend.
//
// ── R0 PARAM-CAP RULE ───────────────────────────────────────────────────────
// admin-plane/main.bicep is at the ARM 256-parameter ceiling, so this module
// takes a single typed CONFIG-OBJECT bag (no new top-level params anywhere),
// exactly like the sibling data-plane/{loom-risingwave,s3-gateway,duckdb}-aca.bicep.
// It stays directly deployable out of band for an incremental sovereign
// provision:
//
//   az deployment group create -g <admin-rg> \
//     -f platform/fiab/bicep/modules/shared/redis-oss-aca.bicep \
//     -p location=<region> \
//        redisConfig='{ "environmentId": "<cae-id>", "uamiId": "<uami-id>", \
//                       "acrLoginServer": "<acr>.azurecr.io", \
//                       "passwordSecretUri": "https://<vault>.vault.azure.net/secrets/loom-redis-oss-password" }'
//
// Grounded in Microsoft Learn:
//   Container Apps TCP ingress        https://learn.microsoft.com/azure/container-apps/ingress-overview
//   Container Apps secrets (KV ref)   https://learn.microsoft.com/azure/container-apps/manage-secrets
//   Container Apps storage mounts     https://learn.microsoft.com/azure/container-apps/storage-mounts
//   AMR is Public-cloud only          https://learn.microsoft.com/azure/redis/planning-faq
// NO Microsoft Fabric / Power BI dependency (no-fabric-dependency.md): a Valkey
// container on this deployment's own Container Apps environment runs
// DISCONNECTED in an IL5 enclave.
// ============================================================================

targetScope = 'resourceGroup'

@description('Container App name (DNS-label safe, <= 32 chars). Keep it stable: the Console reaches this app by its internal FQDN `<name>.internal.<cae-default-domain>`, which the orchestrator CONSTRUCTS rather than reading from an output.')
@maxLength(32)
param name string = 'loom-redis-oss'

@description('Deployment region (e.g. usgovvirginia / usgovarizona / centralus).')
param location string = resourceGroup().location

@description('''R0 config bag — every setting for the OSS Redis substrate in ONE typed object (admin-plane/main.bicep is at the ARM 256-param cap, so no new top-level params are added anywhere).

Required keys:
  environmentId       Container Apps managed-environment resource id (in-VNet).
  uamiId              User-assigned managed identity RESOURCE id. Needs AcrPull on the
                      registry AND "Key Vault Secrets User" on the vault holding the
                      password, or the revision cannot resolve its credential and the
                      container fails closed by design.
  acrLoginServer      Estate ACR login server, e.g. acrloom.azurecr.io. REQUIRED with no
                      default: the image ref is composed from it, so this module cannot
                      express a public-registry pull (#2682).

Auth (EXACTLY ONE is required — with neither the container refuses to start):
  passwordSecretUri   Key Vault secret URI https://<vault>.vault.azure.net/secrets/<name>
                      holding the Valkey `requirepass` value. PREFERRED. Rendered as a
                      Key-Vault-backed Container Apps secret resolved by uamiId at
                      revision start; the value never enters the template or the ARM
                      deployment history.
                      (The inline alternative is the top-level @secure() `password` param.)

Optional keys:
  valkeyImage         Valkey REPOSITORY:TAG **without a registry host** (default
                      'valkey/valkey:8.1.10-alpine'). Recorded in
                      platform/fiab/images/upstream-images.json as the mirror
                      source-of-truth AND the LIC0 licence record; the deploy lane
                      imports exactly that ref BY DIGEST into the estate ACR. The
                      EFFECTIVE pull is always `<acrLoginServer>/<valkeyImage>`.
  targetPort          TCP port Valkey listens on (default 6379). Published as both
                      targetPort and exposedPort on the internal TCP ingress.
  cpu / memory        Container resources (default 0.5 vCPU / 1.0Gi). ACA Consumption
                      accepts ONLY pairs where memory == 2 x vCPU GiB.
  maxmemoryMb         Valkey `maxmemory` in MiB (default 700 — ~70% of a 1.0Gi container,
                      leaving headroom for fragmentation, COW and the AOF buffer). Set
                      this WITH the container memory: an unbounded Valkey grows until the
                      container is OOM-killed, which reads as a mystery restart loop.
  maxmemoryPolicy     Eviction policy (default 'allkeys-lru' — correct for a pure cache;
                      the Broker ledger uses short TTLs and does not rely on eviction).
  persistence         'none' (DEFAULT — EPHEMERAL, see the durability block above) or
                      'aof' (Azure Files + appendfsync everysec).
  fileShareQuotaGb    Azure Files share quota in GiB when persistence='aof' (default 16).
  storageAccountName  Storage account name for the AOF share when persistence='aof'.
                      Empty => derived as take('stloomredis<uniqueString(rg)>', 24).
  allowedCidrs        Optional ACA ingress IP allow-list (defence-in-depth). NOT a
                      substitute for the password: every app in a Container Apps
                      environment draws its pod IP from the SAME infrastructure subnet,
                      so any CIDR that admits the Console also admits the code-execution
                      apps, and an ingress rule does not govern a direct pod-IP connect.
  workspaceId         Log Analytics workspace resource id for diagnostics. Empty skips
                      the wiring (honest no-op — nothing fake is created).''')
param redisConfig object

@description('''Valkey `requirepass` value, INLINE alternative to redisConfig.passwordSecretUri. @secure() so ARM redacts it from deployment history and outputs; rendered as a Container Apps SECRET, never an env literal. Prefer the Key Vault URI — this exists for out-of-band / incremental provisioning where the vault reference is not available. With NEITHER supplied the container fails closed at boot rather than serving an unauthenticated cache.''')
@secure()
param password string = ''

@description('Compliance/cost tags applied to every resource. The loom-next-level tag is unioned in.')
param complianceTags object = {}

// ── Config-bag unpacking (typed locals; every optional key has a real default) ─
var environmentId = redisConfig.environmentId
var uamiId = redisConfig.uamiId

// ── Image: the estate ACR mirror, ALWAYS (#2682 / FINISHLINE D14) ────────────
// `acrLoginServer` is REQUIRED (no '' default) and the ref is COMPOSED from it,
// so there is deliberately no way to express a public-registry pull here. The
// upstream coordinate + its pinned digest live in
// platform/fiab/images/upstream-images.json.
var acrLoginServer = redisConfig.acrLoginServer
var valkeyImage = string(redisConfig.?valkeyImage ?? 'valkey/valkey:8.1.10-alpine')
var image = '${acrLoginServer}/${valkeyImage}'

var targetPort = int(redisConfig.?targetPort ?? 6379)
// ACA Consumption requires memory == 2 x vCPU GiB. 0.5/1.0Gi is the smallest
// pair that holds a useful working set for the result cache + lease store.
var cpu = string(redisConfig.?cpu ?? '0.5')
var memory = string(redisConfig.?memory ?? '1.0Gi')
var maxmemoryMb = int(redisConfig.?maxmemoryMb ?? 700)
var maxmemoryPolicy = string(redisConfig.?maxmemoryPolicy ?? 'allkeys-lru')
var allowedCidrs = redisConfig.?allowedCidrs ?? []
var workspaceId = string(redisConfig.?workspaceId ?? '')

// ── Mandatory credential ─────────────────────────────────────────────────────
// KV-backed is the preferred shape; the @secure() inline param is the
// out-of-band alternative. With NEITHER, the entrypoint exits 1 before binding
// the port (see startupScript), so the deployment surfaces as an unhealthy
// revision instead of an open cache on the CAE VNet.
var passwordSecretUri = string(redisConfig.?passwordSecretUri ?? '')
var passwordFromKeyVault = !empty(passwordSecretUri)
var passwordInline = empty(passwordSecretUri) && !empty(password)
var authConfigured = passwordFromKeyVault || passwordInline

// ── Persistence ──────────────────────────────────────────────────────────────
var persistence = string(redisConfig.?persistence ?? 'none')
var useAof = persistence == 'aof'
var fileShareQuotaGb = int(redisConfig.?fileShareQuotaGb ?? 16)
var aofStorageAccountName = empty(string(redisConfig.?storageAccountName ?? ''))
  ? take('stloomredis${uniqueString(resourceGroup().id)}', 24)
  : string(redisConfig.?storageAccountName ?? '')
var aofShareName = 'loom-redis-aof'
var aofStorageLink = 'loom-redis-aof'
var aofMountPath = '/data'
// `dir` must be writable by the container. On the ephemeral path that is the
// replica's own /tmp; on the AOF path it is the Azure Files mount.
var dataDir = useAof ? aofMountPath : '/tmp/loom-redis'

var tags = union(complianceTags, { 'loom-next-level': 'true' })

// ── Entrypoint ───────────────────────────────────────────────────────────────
// A '''-quoted (non-interpolated) bicep string, so nothing in this shell script
// is substituted at compile time and every `$VAR` below is resolved by the
// container's own shell from the env/secretRef bindings declared further down.
// That is deliberate: the password must reach the config file WITHOUT ever being
// a value in the template.
//
// Written to a 0600 file rather than passed on argv so `ps` inside the container
// does not expose it. `save ""` disables RDB snapshotting so the ephemeral path
// makes no half-promise of durability. `protected-mode yes` is belt-and-braces
// on top of requirepass.
//
// PRIVILEGE DROP — attempted, not assumed. Overriding ACA `command` bypasses the
// image's own `docker-entrypoint.sh`, which is what normally re-execs the server
// as the unprivileged `valkey` user; without that, `valkey-server` would run as
// root. The script therefore drops privileges when the tools are demonstrably
// present (`su-exec` + a `valkey` account, both of which the upstream alpine
// image ships) and otherwise runs as-is, PRINTING WHICH HAPPENED. Hard-coding
// the drop would crash-loop the container on any image that lacks either piece,
// and silently skipping it would leave a security posture nobody can see in the
// logs — this does neither.
var startupScript = '''
set -e
if [ -z "$LOOM_REDIS_PASSWORD" ]; then
  echo "loom-redis-oss: FAIL CLOSED - no password resolved. Either redisConfig.passwordSecretUri was not supplied, or the Key Vault secretRef resolved empty (check that this app UAMI holds Key Vault Secrets User on the vault and that the secret exists). Refusing to start an UNAUTHENTICATED Redis on the Container Apps environment VNet, where loom-script-runner and loom-udf-runtime execute user-supplied code one TCP connect away." >&2
  exit 1
fi
mkdir -p "$LOOM_REDIS_DIR"
umask 077
CONF=/tmp/loom-valkey.conf
rm -f "$CONF"
touch "$CONF"
chmod 600 "$CONF"
{
  echo "port $LOOM_REDIS_PORT"
  echo "bind 0.0.0.0"
  echo "protected-mode yes"
  echo "requirepass $LOOM_REDIS_PASSWORD"
  echo "maxmemory ${LOOM_REDIS_MAXMEMORY_MB}mb"
  echo "maxmemory-policy $LOOM_REDIS_MAXMEMORY_POLICY"
  echo "dir $LOOM_REDIS_DIR"
  echo "appendonly $LOOM_REDIS_APPENDONLY"
  echo "appendfsync everysec"
  echo 'save ""'
} > "$CONF"
echo "loom-redis-oss: starting valkey-server on port $LOOM_REDIS_PORT (maxmemory ${LOOM_REDIS_MAXMEMORY_MB}mb/$LOOM_REDIS_MAXMEMORY_POLICY, appendonly=$LOOM_REDIS_APPENDONLY, dir=$LOOM_REDIS_DIR, auth=on)"
if [ "$(id -u)" = "0" ] && command -v su-exec >/dev/null && id valkey >/dev/null; then
  chown valkey "$CONF"
  chown -R valkey "$LOOM_REDIS_DIR" || echo "loom-redis-oss: could not chown $LOOM_REDIS_DIR (an Azure Files mount ignores chown); continuing - the SMB mount is world-writable by design"
  echo "loom-redis-oss: dropping privileges to the valkey user"
  exec su-exec valkey valkey-server "$CONF"
fi
echo "loom-redis-oss: running as uid $(id -u) - no privilege drop was possible (su-exec or the valkey account is absent from this image)"
exec valkey-server "$CONF"
'''

// ── AOF persistence substrate (created ONLY when persistence='aof') ──────────
// Same shape as compute/loom-unity-app.bicep's H2 share: a dedicated storage
// account + file share linked to the Container Apps environment. ACA Azure Files
// mounts authenticate with the account key, so allowSharedKeyAccess must be true
// on THIS account; it holds nothing but the AOF and is never a data lake.
resource aofStorage 'Microsoft.Storage/storageAccounts@2024-01-01' = if (useAof) {
  name: aofStorageAccountName
  location: location
  tags: complianceTags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    // SMB from the Container Apps environment authenticates with the account
    // key, so shared-key access cannot be turned off here without breaking the
    // mount. It is the reason the AOF path is opt-in rather than the default.
    allowSharedKeyAccess: true
    supportsHttpsTrafficOnly: true
    allowCrossTenantReplication: false
    // #4265 — this account holds the AOF journal, i.e. CACHED QUERY RESULTS at
    // rest, and until now it declared NO network posture at all. It now declares
    // one explicitly, matching admin-plane/main.bicep:3245-3254 (the loom-mcp SMB
    // account): `Allow` + AzureServices bypass, and NOT `publicNetworkAccess:
    // 'Disabled'`.
    //
    // The omission is deliberate and is the strictly safer ordering, for the same
    // reason recorded there: the platform Azure Policy assignment
    // `StorageAccount_PublicNetwork_Modify` (effect: modify) performs the seal on
    // the next ARM write. Writing 'Disabled' from here would make Loom the actor
    // for a cut-over that cannot be rehearsed without a deploy.
    //
    // STATED HONESTLY, because it is a real residual gap: unlike the loom-mcp
    // account, this one has NO `file` private endpoint (this module takes no
    // subnet parameter), so if policy seals it the SMB mount loses its network
    // path and the AOF branch fails. That is a second reason `persistence: 'aof'`
    // is opt-in and unproven — do not enable it without adding the private
    // endpoint first. Nothing in Loom's shipped params sets it today.
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource aofFileSvc 'Microsoft.Storage/storageAccounts/fileServices@2024-01-01' = if (useAof) {
  parent: aofStorage
  name: 'default'
}

resource aofShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2024-01-01' = if (useAof) {
  parent: aofFileSvc
  name: aofShareName
  properties: {
    shareQuota: fileShareQuotaGb
  }
}

resource cae 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: last(split(environmentId, '/'))
}

resource aofCaeStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = if (useAof) {
  parent: cae
  name: aofStorageLink
  properties: {
    azureFile: {
      accountName: aofStorage.name
      accountKey: aofStorage.listKeys().keys[0].value
      shareName: aofShareName
      accessMode: 'ReadWrite'
    }
  }
}

// ── Container Apps secret + env wiring ───────────────────────────────────────
// The credential is ALWAYS a secretRef, never `value:`. Key-Vault-backed when a
// secret URI is supplied (`keyVaultUrl` + `identity` => the platform resolves it
// with the UAMI at revision start and the value never enters the template or the
// deployment history); the @secure() inline param otherwise.
var appSecrets = passwordFromKeyVault ? [
  { name: 'redis-password', keyVaultUrl: passwordSecretUri, identity: uamiId }
] : (passwordInline ? [
  { name: 'redis-password', value: password }
] : [])

// LOOM_REDIS_PASSWORD is bound ONLY when a credential exists. When it does not,
// the variable is absent, the entrypoint's `[ -z ... ]` guard fires, and the
// revision fails closed — which is the intended, visible outcome.
var authEnv = authConfigured ? [
  { name: 'LOOM_REDIS_PASSWORD', secretRef: 'redis-password' }
] : []

var envVars = concat(
  [
    { name: 'LOOM_REDIS_PORT', value: string(targetPort) }
    { name: 'LOOM_REDIS_MAXMEMORY_MB', value: string(maxmemoryMb) }
    { name: 'LOOM_REDIS_MAXMEMORY_POLICY', value: maxmemoryPolicy }
    { name: 'LOOM_REDIS_DIR', value: dataDir }
    { name: 'LOOM_REDIS_APPENDONLY', value: useAof ? 'yes' : 'no' }
  ],
  authEnv
)

// INTERNAL ingress + an optional Allow-only IP rule set. ACA supports Allow-only
// or Deny-only; anything outside the listed CIDRs is denied.
var ingressIpRules = [for (cidr, i) in allowedCidrs: {
  name: 'allow-loom-console-${i}'
  description: 'Defence-in-depth: narrow the VNet reach of the OSS Redis port.'
  ipAddressRange: cidr
  action: 'Allow'
}]
var ingressBase = {
  // INTERNAL only — the Console BFF and the Capacity Broker are the callers,
  // over the CAE network. Never external. TCP transport because RESP is not HTTP.
  external: false
  targetPort: targetPort
  exposedPort: targetPort
  transport: 'tcp'
}
var ingressConfig = empty(allowedCidrs) ? ingressBase : union(ingressBase, {
  ipSecurityRestrictions: ingressIpRules
})

// Pinned to the same Container Apps api-version the sibling ACA modules use
// (data-plane/loom-risingwave-aca.bicep, compute/loom-unity-app.bicep).
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
      ingress: ingressConfig
      secrets: appSecrets
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
          // ACA `command` overrides the image ENTRYPOINT. The Valkey image's
          // stock entrypoint cannot install a password from a secret, so the
          // shell above renders the config file and execs the server. `exec`
          // keeps valkey-server as PID 1 so SIGTERM on a revision drain reaches
          // it (and, on the AOF path, flushes the buffer) instead of the shell.
          command: ['/bin/sh', '-c']
          args: [startupScript]
          env: envVars
          volumeMounts: useAof ? [
            { volumeName: 'redis-aof', mountPath: aofMountPath }
          ] : []
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          // Valkey speaks RESP, not HTTP, so there is no health URL to GET. A
          // TCP connect to the data port is the honest "server is listening"
          // signal — the same choice compute/loom-unity-app.bicep and
          // data-plane/iceberg-catalog-aca.bicep make, and no fabricated
          // /healthz 200. It does NOT prove AUTH works; the deploy receipt for
          // that is a real client round trip (see the runbook).
          probes: [
            {
              type: 'Liveness'
              tcpSocket: { port: targetPort }
              initialDelaySeconds: 10
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              tcpSocket: { port: targetPort }
              initialDelaySeconds: 5
              periodSeconds: 10
              failureThreshold: 6
            }
          ]
        }
      ]
      volumes: useAof ? [
        { name: 'redis-aof', storageType: 'AzureFile', storageName: aofStorageLink }
      ] : []
      // minReplicas 1: a cache that scales to zero loses every key on each idle
      // window, which is worse than no cache (it looks warm and never is).
      // maxReplicas FORCED to 1 — see the header: ACA ingress load-balances, and
      // two Valkey processes behind one ingress are two independent datasets.
      // This is not configurable through the bag ON PURPOSE.
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

// Same name/categories as modules/shared/diagnostic-settings.bicep so DSC
// drift-detection stays consistent (that helper deploys only at resourceGroup
// scope — BCP134 — so a cross-resource diag setting is declared where the
// resource lives).
resource appDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  name: 'diag-loom-stdz'
  scope: app
  properties: {
    workspaceId: workspaceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

// ── Outputs ──────────────────────────────────────────────────────────────────

@description('Container App resource id.')
output appId string = app.id

@description('Internal FQDN of the Valkey app. Reached in-environment over the CAE network; never public.')
output fqdn string = app.properties.configuration.ingress.fqdn

@description('The LOOM_*_REDIS client contract value: <host>:<port>. Publish THIS rather than composing a port by hand — the three Redis backends listen on three different ports (OSS 6379, classic 6380, Azure Managed Redis 10000).')
output endpoint string = '${app.properties.configuration.ingress.fqdn}:${targetPort}'

@description('TCP port Valkey listens on.')
output port int = targetPort

@description('How the MANDATORY password was supplied: keyVault | inline | NONE. "NONE" means the container FAILS CLOSED at boot (the entrypoint exits before binding the port) — surfaced as an output so a deploy log shows the posture without reading the secret.')
output authMode string = passwordFromKeyVault ? 'keyVault' : (passwordInline ? 'inline' : 'NONE')

@description('FALSE always, and deliberately: ACA `transport: tcp` ingress does not terminate TLS, so RESP AUTH and every GET/SET cross the Container Apps environment VNet hop in cleartext. Callers MUST set their client TLS flag off (the Console reads LOOM_RESULT_CACHE_REDIS_TLS=0) or the handshake fails and the tier degrades silently. Stated as an output so no deploy receipt can imply otherwise.')
output tlsOnTheWire bool = false

@description('TRUE only when persistence=\'aof\' wired an Azure Files share. FALSE means the cache is EPHEMERAL: an ACA revision roll, scale event, platform replica replacement, or image bump DROPS EVERY KEY, and RDB snapshotting is disabled so nothing pretends otherwise. Every shipped Loom consumer tolerates that (result cache -> in-process LRU -> honest direct query; Spark leases -> Cosmos; Broker ledger -> in-process), but a caller that treats Redis as a system of record MUST NOT deploy on the default.')
output dataDurable bool = useAof

@description('Persistence mode actually deployed: none | aof.')
output persistenceMode string = persistence

@description('Storage account holding the AOF share, or empty on the ephemeral path.')
output aofStorageAccountName string = useAof ? aofStorage.name : ''

@description('TRUE when an ACA ingress IP allow-list is applied on top of internal ingress. Defence-in-depth only — it cannot separate this app from its Container Apps environment siblings, which share the infrastructure subnet, which is why the password is mandatory rather than optional.')
output ingressIpRestricted bool = !empty(allowedCidrs)
