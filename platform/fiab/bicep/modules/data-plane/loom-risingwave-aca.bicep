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
//   - ONE ROUTABLE PORT, AND IT REQUIRES A PASSWORD. Two separate defects, both
//     closed in the image (apps/loom-risingwave/scripts/entrypoint.sh):
//
//     (a) THE WIRE HAD NO CREDENTIAL (2026-07-29). RisingWave ships a `root`
//     SUPERUSER with NO password: with `AuthInfo` unset the frontend's
//     `UserAuthenticator` is `None`, so anything that can open a TCP connection
//     IS root. Deployed to the live Commercial estate this module produced a
//     container with env `[LOOM_LAKE_ACCOUNT]` and ZERO secrets, sharing
//     `cae-csa-loom-centralus` with `loom-script-runner` and `loom-udf-runtime`
//     — two services whose purpose is executing user-supplied code. It was
//     removed from the estate. This module now REQUIRES a root credential:
//     `rootPasswordSecretUri` (a Key Vault secret URI resolved at revision start
//     by the app's own managed identity) or the @secure() `rootPassword` param.
//     Either renders a Container Apps SECRET and binds it as
//     `LOOM_RW_ROOT_PASSWORD` via `secretRef` — NEVER a plain env literal. With
//     neither, the entrypoint refuses to start (fail-closed), so an
//     unauthenticated loom-risingwave cannot exist.
//
//     (b) THE CREDENTIAL ONLY COVERED 4566 (2026-07-30, round-4 review).
//     Measured on the pinned image with `/proc/net/tcp`, stock `single_node`
//     binds FIVE routable ports, and four of them have NO authentication at
//     all: compute-node gRPC 5688, meta-node gRPC 5690 (create/drop catalog
//     objects), meta dashboard + REST 5691, compactor gRPC 6660. Upstream
//     hard-codes those addresses in `map_single_node_opts_to_standalone_opts`
//     and exposes no flag or env var for them, so the entrypoint runs the engine
//     in `standalone` mode with every non-wire listener pinned to 127.0.0.1 —
//     byte-identical opts otherwise — and ASSERTS the surface at runtime: zero
//     ENGINE-OWNED routable sockets while sealed, exactly one (the wire port)
//     while serving, container dies otherwise. FIVE routable ports became ONE.
//     The assertion is scoped to sockets the engine's process tree owns
//     (/proc/<pid>/fd inodes joined to /proc/net/tcp) because an ACA replica
//     SHARES its network namespace with platform-injected agent listeners this
//     container neither creates nor can remove — the original whole-netns scan
//     crash-looped every ACA replica on those (measured 2026-08-06).
//
//     WHY THE SEAL IS IN THE IMAGE AND NOT A NETWORK RULE: ACA ingress
//     publishes only `targetPort`, but ingress is not a firewall — a replica
//     holds a VNet IP from the environment's infrastructure subnet, so a
//     sibling app reaches any listening port on the POD IP directly, past
//     ingress and past `ipSecurityRestrictions`. And every app in the
//     environment draws from that same subnet, so no CIDR can admit the Console
//     without admitting loom-script-runner and loom-udf-runtime; a dedicated
//     environment has the identical problem one level up. An in-container
//     packet filter needs NET_ADMIN, which Container Apps does not grant.
//     Removing the listener is strictly stronger than filtering it.
//   - INTERNAL ingress only, transport 'tcp' on the Postgres-wire frontend port
//     (4566) — the only port the container listens on off-loopback — with an
//     OPTIONAL `allowedCidrs` IP allow-list on top as defence-in-depth against
//     the wider VNet. The Console BFF is the sole door; every statement goes
//     through the audited /api/streaming-sql/* routes. There is no anonymous /
//     public path. The Key Vault secret is readable only by the two identities
//     granted "Key Vault Secrets User" on it (this app's UAMI and the
//     Console's), so the code-execution apps cannot obtain the credential.
//   - IDENTITY-BASED lake auth: a user-assigned managed identity with **Storage
//     Blob Data Contributor** on the DLZ lake (the streaming sink WRITES Delta /
//     Iceberg). The GRANT is NOT made here — the orchestrator makes it from
//     `risingwaveLakeRbac`, a module it invokes at
//     `scope: resourceGroup(loomDlzRg)`, because the lake lives outside the
//     admin RG. This module only BINDS the account name. NO storage keys, NO
//     SAS, NO connection strings in app settings.
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
// combination and would have been rejected at deploy time). BUDGET THE ACTIVE
// RATE — about $150/mo/cloud, 24/7. ACA's idle rate applies only while a replica
// is under 0.01 vCPU AND under 1 KB/s
// (learn.microsoft.com/azure/container-apps/billing); a single-node engine
// running meta heartbeats, barriers and periodic compaction does not qualify, so
// planning against an "idle" number would understate the bill.
// DURABILITY CAVEAT: minReplicas 1 buys continuity WITHIN a revision, not
// durability. There is no volume mount and stateStore is empty by default, so the
// replica filesystem is ephemeral — an ACA revision roll or a platform replica
// replacement drops the MVs regardless. Set stateStore (RW_STATE_STORE) to the
// ADLS hummock store for a genuinely durable deployment.
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
//                            "uamiClientId": "<uami-client-id>", \
//                            "acrLoginServer": "<acr>.azurecr.io", \
//                            "image": "<acr>.azurecr.io/loom-risingwave:<tag>", \
//                            "lakeStorageAccountName": "<dlz-adls-account>", \
//                            "rootPasswordSecretUri": "https://<vault>.vault.azure.net/secrets/loom-risingwave-root-password" }'
//   # The UAMI must hold "Key Vault Secrets User" on that vault, or the revision
//   # cannot resolve the secret. Omitting BOTH rootPasswordSecretUri and the
//   # @secure() rootPassword param is not a shortcut — the container refuses to
//   # start rather than serve an unauthenticated database.
//   # then, on the Console (the password is a secretRef there too, never a
//   # plain env literal):
//   #   az containerapp secret set -n <console> -g <admin-rg> --secrets \
//   #     loom-risingwave-password=keyvaultref:<same-secret-uri>,identityref:<console-uami-id>
//   #   az containerapp update -n <console> -g <admin-rg> --set-env-vars \
//   #     LOOM_RISINGWAVE_URL=<this-app-fqdn>:4566 \
//   #     LOOM_RISINGWAVE_PASSWORD=secretref:loom-risingwave-password

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
  uamiClientId           That identity's CLIENT id — emitted as AZURE_CLIENT_ID so the
                         engine picks the RIGHT identity off IMDS when the container has
                         more than one assigned. Empty => omitted.
  lakeStorageAccountName DLZ ADLS Gen2 account the streaming sink writes Delta/Iceberg to.
                         Empty => no LOOM_LAKE_ACCOUNT; the engine still runs (single-node
                         local state) and the Postgres wire serves. This module only BINDS
                         the account — the Storage Blob Data Contributor grant is made by
                         `risingwaveLakeRbac`, which the orchestrator invokes at the lake's
                         own RG scope.
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
  rootPasswordSecretUri  REQUIRED (or the @secure() rootPassword param). Key Vault secret URI
                         https://<vault>.vault.azure.net/secrets/<name> holding the Postgres-wire
                         root password. Rendered as a Key-Vault-backed Container Apps SECRET
                         resolved by uamiId at revision start — the value never enters the
                         template, the deployment history, or `az containerapp show`. The UAMI
                         needs "Key Vault Secrets User" on that vault.
  allowedCidrs           Optional ACA ingress IP allow-list (defence-in-depth against the wider
                         VNet). NOT a substitute for the credential OR the in-image port seal:
                         every app in a Container Apps environment draws its pod IP from the SAME
                         infrastructure subnet, so any CIDR that admits the Console also admits
                         the code-execution apps — and ingress rules only govern the ingress path,
                         not a direct pod-IP connect. Empty (default) => internal ingress plus the
                         image's own single-listener seal are the network controls.
  livenessInitialDelay   Seconds before the first liveness probe (default 10; CLAMPED to the ACA
                         cap of 60 — ARM preflight rejects anything higher with
                         ContainerAppProbeInitialDelaySecondsOutOfRange, which is why the previous
                         150s default made this module UNDEPLOYABLE). The long sealed bootstrap
                         (the engine boots TWICE — once with every listener on loopback to install
                         the credential and assert zero routable ports, once serving, so the
                         routable port does not exist for the first ~15s measured) is absorbed by
                         the dedicated STARTUP probe below, which suppresses liveness/readiness
                         until it succeeds — so this delay no longer needs to cover the boot.
  readinessInitialDelay  Seconds before the first readiness probe (default 10; clamped to 60 the
                         same way).''')
param risingwaveConfig object

@description('''Postgres-wire root password, INLINE alternative to risingwaveConfig.rootPasswordSecretUri. @secure() so ARM redacts it from deployment history and outputs; rendered as a Container Apps SECRET (never an env literal). Prefer the Key Vault URI — this exists for out-of-band / incremental provisioning where the vault reference is not available. Exactly one of the two must be supplied: with neither, the container fails closed at boot rather than serving an unauthenticated database.''')
@secure()
param rootPassword string = ''

@description('Compliance/cost tags. The loom-next-level tag is unioned in.')
param complianceTags object = {}

// ── Config-bag unpacking (typed locals; every optional key has a real default) ─
var environmentId = risingwaveConfig.environmentId
var uamiId = risingwaveConfig.uamiId
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

// ── Mandatory root credential ────────────────────────────────────────────────
// KV-backed is the default and preferred shape; the @secure() inline param is
// the out-of-band alternative. With NEITHER the container fails closed at boot
// (apps/loom-risingwave/scripts/entrypoint.sh exits 1 before binding a routable
// port), so the deployment surfaces as an unhealthy revision instead of an
// unauthenticated database.
var rootPasswordSecretUri = string(risingwaveConfig.?rootPasswordSecretUri ?? '')
var rootPasswordFromKeyVault = !empty(rootPasswordSecretUri)
var rootPasswordInline = empty(rootPasswordSecretUri) && !empty(rootPassword)
var rootAuthConfigured = rootPasswordFromKeyVault || rootPasswordInline

// ACA ingress IP allow-list — defence-in-depth only. It CANNOT separate this app
// from its Container Apps environment siblings (they share the infrastructure
// subnet), which is exactly why the credential above is mandatory rather than
// optional. Empty by default.
var allowedCidrs = risingwaveConfig.?allowedCidrs ?? []

// The engine boots twice (sealed → serving), so the routable port is absent for
// the first ~15s (measured; ~10x headroom budgeted). That grace now lives in the
// STARTUP probe (see the probes array) because ACA hard-caps every probe's
// initialDelaySeconds at 60 — the previous 150s liveness default failed ARM
// preflight with ContainerAppProbeInitialDelaySecondsOutOfRange on EVERY deploy,
// so this module could never reach the estate. Liveness/readiness only begin
// after the startup probe succeeds, so their delays stay small; max(1, min(60, x))
// clamps any legacy config-bag value into ACA's documented 1-60 range so a stale
// operator bag can never re-break preflight.
var livenessInitialDelay = max(1, min(60, int(risingwaveConfig.?livenessInitialDelay ?? 10)))
var readinessInitialDelay = max(1, min(60, int(risingwaveConfig.?readinessInitialDelay ?? 10)))

var tags = union(complianceTags, { 'loom-next-level': 'true' })

// NO `resource lake … existing` HERE, DELIBERATELY (#3357).
//
// An unscoped `existing` resolves in THIS module's resource group, and the lake
// is in the DLZ RG — on a dlz-attach estate, a different SUBSCRIPTION. That is
// the shape that failed two full Commercial deploys on 2026-08-13 from
// transform-runner-aca.bicep (#3333/#3329). Here it was already DEAD CODE: the
// orchestrator has granted Storage Blob Data Contributor from `risingwaveLakeRbac`
// at `scope: resourceGroup(loomDlzRg)` — the correct pattern — while passing
// `assignLakeRole: false`, so this declaration only ever sat waiting for someone
// to flip that boolean. Removed rather than left loaded.
//
// The BIND stays here: LOOM_LAKE_ACCOUNT below is a plain string, so the engine
// is wired to its lake on every topology
// (.claude/rules/auto-bind-by-default.md — bind always, grant where possible).
// The role is UNCHANGED — Contributor, because the streaming sink WRITES
// Delta/Iceberg (unlike the read-only DuckDB and Iceberg-catalog tiers).

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

// The root credential — ALWAYS a secretRef, never `value:`. The entrypoint reads
// it, applies `ALTER USER root PASSWORD` against a loopback-only frontend, and
// only then binds the routable port.
var authEnv = rootAuthConfigured ? [
  { name: 'LOOM_RW_ROOT_PASSWORD', secretRef: 'risingwave-root-password' }
] : []

// Key-Vault-backed when a secret URI is supplied (`keyVaultUrl` + `identity`
// means the platform resolves it with the UAMI at revision start and the value
// never enters the template or the deployment history); the @secure() inline
// param otherwise.
var appSecrets = rootPasswordFromKeyVault ? [
  { name: 'risingwave-root-password', keyVaultUrl: rootPasswordSecretUri, identity: uamiId }
] : (rootPasswordInline ? [
  { name: 'risingwave-root-password', value: rootPassword }
] : [])

// The frontend port has to reach the ENGINE, not just ACA's ingress. Without
// this, setting risingwaveConfig.frontendPort to anything but 4566 pointed
// targetPort and both probes at a port the entrypoint never bound (it defaults
// to 4566 internally), so the revision would never become healthy. Always
// emitted so the container and the ingress cannot disagree.
var portEnv = [
  { name: 'LOOM_RW_FRONTEND_PORT', value: string(frontendPort) }
]

var envVars = concat(lakeEnv, identityEnv, stateEnv, authEnv, portEnv)

// INTERNAL ingress + an optional Allow-only IP rule set. ACA supports Allow-only
// or Deny-only; anything outside the listed CIDRs is denied.
var ingressIpRules = [for (cidr, i) in allowedCidrs: {
  name: 'allow-loom-console-${i}'
  description: 'Defence-in-depth: narrow the VNet reach of the streaming wire port.'
  ipAddressRange: cidr
  action: 'Allow'
}]
var ingressBase = {
  // INTERNAL only — the Console BFF is the sole door. TCP transport so the raw
  // Postgres-wire frontend is reachable in-VNet on the frontend port.
  external: false
  targetPort: frontendPort
  exposedPort: frontendPort
  transport: 'tcp'
}
var ingressConfig = empty(allowedCidrs) ? ingressBase : union(ingressBase, {
  ipSecurityRestrictions: ingressIpRules
})

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
          env: envVars
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          probes: [
            {
              // STARTUP — absorbs the SEALED bootstrap. The frontend has no HTTP
              // health on the SQL port; a TCP connect to the Postgres-wire port
              // is the honest signal. During phase 1 every listener including the
              // frontend is bound to 127.0.0.1, so a probe from the pod IP
              // correctly fails until the serving engine binds the routable port.
              //
              // MEASURED on the built image (2 vCPU / 6 GiB, docker, 2026-07-30):
              // sealed engine answering SQL at +8.4s, port assertion + ALTER USER
              // + verification done at +8.8s, serving engine's routable port up
              // and re-asserted at +14.7s. Grace here = 10s initial + 15s x 10
              // attempts = 160s (~10x headroom for a cold pull on a busier node)
              // — the same budget the old 150s liveness delay carried before ACA's
              // preflight cap (initialDelaySeconds <= 60,
              // ContainerAppProbeInitialDelaySecondsOutOfRange) made that shape
              // undeployable. failureThreshold 10 and periodSeconds 240 are the
              // ACA documented maxima; raise periodSeconds first if a heavier
              // image ever needs more grace.
              // Liveness and readiness are SUPPRESSED until this succeeds, so
              // neither can kill the container mid-credential-install.
              type: 'Startup'
              tcpSocket: { port: frontendPort }
              initialDelaySeconds: 10
              periodSeconds: 15
              timeoutSeconds: 5
              failureThreshold: 10
            }
            {
              // Runs only after the startup probe has proven the routable port,
              // so the small (ACA-capped <= 60s) delay is safe.
              type: 'Liveness'
              tcpSocket: { port: frontendPort }
              initialDelaySeconds: livenessInitialDelay
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              // failureThreshold 10 is the ACA documented maximum (the previous
              // 30 was out of range — a second latent preflight failure hiding
              // behind the liveness one). 10s delay + 10s x 10 still gives 100s
              // of post-startup grace before the revision is failed.
              type: 'Readiness'
              tcpSocket: { port: frontendPort }
              initialDelaySeconds: readinessInitialDelay
              periodSeconds: 10
              failureThreshold: 10
            }
          ]
        }
      ]
      // CANNOT scale to zero and NOT sharded: single-node RisingWave holds the
      // materialized-view + meta state in ONE process, so a stopped replica
      // loses every MV definition and its progress. minReplicas 1 with the
      // smallest legal footprint (2.0 vCPU / 4.0Gi) is the honest floor. Budget
      // the ACTIVE rate (~$150/mo/cloud): the ACA idle rate needs <0.01 vCPU and
      // <1 KB/s, which this engine does not hold. Disable with
      // loomBackends.risingwave='disabled'.
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

@description('Internal FQDN — set on the Console app as LOOM_RISINGWAVE_URL (append :<frontendPort>).')
output fqdn string = app.properties.configuration.ingress.fqdn

@description('The Postgres-wire endpoint the Console BFF connects to (LOOM_RISINGWAVE_URL).')
output pgWireEndpoint string = '${app.properties.configuration.ingress.fqdn}:${frontendPort}'

@description('Container App resource id.')
output appId string = app.id

@description('How the mandatory root credential was supplied: keyVault | inline | NONE. "NONE" means the container will FAIL CLOSED at boot (the entrypoint refuses to bind a routable port without a password) — it is surfaced as an output so a deploy log shows the posture without reading the secret.')
output rootAuthMode string = rootPasswordFromKeyVault ? 'keyVault' : (rootPasswordInline ? 'inline' : 'NONE')

@description('True when an ACA ingress IP allow-list is applied on top of internal ingress. Defence-in-depth only — it cannot separate this app from its Container Apps environment siblings, which share the infrastructure subnet.')
output ingressIpRestricted bool = !empty(allowedCidrs)
