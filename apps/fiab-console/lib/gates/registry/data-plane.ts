/**
 * R30 fragment — the 'data-plane' domain slice of GATE_META (formerly part of the
 * lib/gates/registry.ts monolith; entries sit in the same domain as their
 * ENV_CHECKS spec in lib/admin/env-checks/data-plane.ts). ./index.ts merges every
 * fragment into the same exported GATE_META shape (public API unchanged).
 * Import ONLY from './types' here — never './index' (barrel-cycle rule).
 */
import { L, type GateMeta } from './types';

export const DATA_PLANE_GATE_META: Record<string, GateMeta> = {
  'cosmos-config': {
    surfaces: [{ path: '*', label: 'The Loom store (workspaces, items, grants, config)' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_COSMOS_ENDPOINT: L.cosmos },
  },
  subscription: {
    surfaces: [
      { path: '/admin/capacity', label: 'ARM discovery + capacity' },
      { path: '/admin/scaling', label: 'Scale by SKU' },
      { path: '/api/azure/*', label: 'Azure navigators' },
    ],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['LOOM_SUBSCRIPTION_ID not configured', 'LOOM_SUBSCRIPTION_ID not set'],
  },
  // ── Hyperscale band (optional substrates; unset = fully-functional default) ──
  'svc-loom-onelake': {
    surfaces: [{ path: '/onelake', label: 'OneLake namespace service (scale-out)' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Unset → the per-item library path (adls-client / lakehouse-shortcuts) serves everything with no loss of function.',
  },
  'svc-loom-directlake': {
    surfaces: [{ path: '/items/semantic-model', label: 'Direct Lake columnar cache (scale-out)' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Unset → the AAS fast-path or Synapse-Serverless cold path serves DAX-class queries unchanged.',
  },
  // ── DR0 + CMK1 — restore/at-rest posture (verified live by probe-dr-restore-posture) ──
  'svc-dr-restore-posture': {
    surfaces: [{ path: '/admin/health', label: 'DR restore posture (Health & Reliability)' }],
    fixit: {
      kind: 'wizard',
      grantNote: 'The Cosmos side is fixable in-product: Admin → the Cosmos account-management surface PATCHes backupPolicy (Continuous tier switch is a hot in-place ARM update). CMK-at-rest (CMK1) is a bicep/ARM posture: opt in via drConfig.cosmosRequireCmk + cosmosCmkKeyUri + cosmosCmkIdentityId (or the documented two-step az cosmosdb update — default-identity first, then --key-uri — on an existing continuous-backup account); the probe asserts it only where LOOM_COSMOS_REQUIRE_CMK=true. The lake side is bicep-provisioned (recycleRetentionDays soft delete + change feed); blob versioning cannot be enabled on an HNS account (platform limitation).',
    },
    autoResolveNote: 'A push-button deploy ships the full posture by default: Cosmos Continuous backup (drConfig.cosmosBackupTier, default Continuous30Days) + lake soft-delete/change-feed (recycleRetentionDays). CMK-at-rest stays service-managed unless the deploy mandates customer-managed keys (drConfig.cosmosRequireCmk — the IL5 posture), and the row reports whichever is live honestly.',
  },
  'perf-spark-warm-pool-store': {
    surfaces: [{ path: '/items/notebook', label: 'Warm Spark pool — cross-replica leases' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Unset → the warm pool runs per-replica (still fully functional, just not shared).',
  },
  'svc-spark-autorecover': {
    surfaces: [{ path: '/admin/health', label: 'Spark pool auto-recovery (Health & Reliability → Spark pools)' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Default-ON — unset auto-detects + delete/recreates a FAULTED pool from the keep-warm heartbeat (thrash-guarded, operator-alerted). Set LOOM_SPARK_AUTORECOVER_ENABLED=0 or flip the a11-spark-autorecover runtime flag to detect-and-alert only (manual Recreate button).',
  },
  'svc-spark-vcore-budget': {
    surfaces: [{ path: '/admin/health', label: 'Spark session quota / vCore budget (Health & Reliability → Spark pools)' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Default-ON — safe built-in session cap + vCore budget apply when unset; a new session past the ceiling gets an honest "session quota reached" error, never a hang. Set the two vars to tune to your Synapse workspace vCore quota.',
  },
  'svc-spark-chaos-drill': {
    surfaces: [{ path: '/admin/health', label: 'Spark chaos-drill harness (Health & Reliability → Spark pools)' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'OFF by default (the intended production posture). Enable only for a non-prod resilience drill: LOOM_SPARK_CHAOS_ENABLED=true AND a valid LOOM_INTERNAL_TOKEN on the tenant-admin request.',
  },
  // ── CH1 — dependency-fault chaos harness (Cosmos / AOAI / ADX / KV) ──
  'svc-dependency-chaos-drill': {
    surfaces: [{ path: '/admin/health?tab=chaos', label: 'Dependency chaos harness (Health & Reliability → Chaos)' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'OFF by default (the intended production posture — no fault injection). Enable only for a non-prod resilience drill: the ch1-dependency-chaos runtime flag ON + LOOM_DEPENDENCY_CHAOS_ENABLED=true + a valid LOOM_INTERNAL_TOKEN; every armed fault auto-expires (≤5 min).',
  },
  // ── N2b — DuckDB serving tier (interactive fast path below Spark) ──
  'svc-loom-duckdb': {
    surfaces: [
      { path: '/items/sql-lab', label: 'SQL Lab — interactive SQL over the lake' },
      { path: '/api/duckdb/query', label: 'SQL Lab execution edge (audited)' },
    ],
    fixit: { kind: 'env-picker' },
    autoResolveNote:
      'Unset → SQL Lab executes the identical statement on Synapse Serverless and says so in the status bar. Deploying the DuckDB tier changes latency and unlocks the Arrow transport the in-browser Local analysis tab reuses; it never changes results.',
    legacyCodes: ['duckdb_not_configured'],
  },
  // ── N3 — Arrow Flight SQL wire (ADBC / JDBC serving) ──
  'svc-flight-sql': {
    surfaces: [
      { path: '/items/lakehouse', label: 'Lakehouse → Connect tab (ADBC / Flight / JDBC)' },
      { path: '/items/warehouse', label: 'Warehouse → Connect tab' },
      { path: '/api/flightsql/session', label: 'Short-lived Flight ticket minting (audited)' },
    ],
    fixit: { kind: 'env-picker' },
    autoResolveNote:
      'Unset → the Connect tab still renders and Loom still streams the same Arrow batches over the audited HTTP tier past the Arrow threshold. The tab reports the endpoint state honestly rather than printing an internal address that would not resolve.',
    legacyCodes: ['flightsql_not_configured'],
  },
  // ── N1 — Iceberg REST Catalog (zero-copy external-engine interop) ──
  'svc-iceberg-catalog': {
    surfaces: [
      { path: '/admin/catalog', label: 'Catalog federation — namespaces, formats, connect strings' },
      { path: '/items/lakehouse', label: 'Lakehouse → Interop tab (expose as Iceberg)' },
      { path: '/api/catalog/iceberg/*', label: 'Iceberg REST Catalog proxy (external engines)' },
    ],
    fixit: { kind: 'env-picker' },
    autoResolveNote:
      'DEFAULT-ON: admin-plane/main.bicep deploys data-plane/iceberg-catalog-aca.bicep (internal-ingress Unity Catalog OSS serving the standard Apache Iceberg REST Catalog surface, minReplicas 0 so idle cost is nothing) and emits LOOM_ICEBERG_CATALOG_URL on the Console, in Commercial and in Gov. Unset or holding an unreachable placeholder therefore means the admin-plane deployment has not been re-run since this shipped, the loom-unity image is not in this ACR, or an operator set loomBackends.icebergCatalog=\'disabled\'. THIS GATE NOW GOES RED FOR THAT: it used to be optionalDefault + presence-only, so the live Commercial estate scored Ready while carrying the placeholder https://0.0.0.0:3000/api/catalog/iceberg and 503-ing every federation request. Until it is wired, Delta↔Iceberg dual metadata still writes real Iceberg V2 metadata into your own ADLS Gen2 (the Interop tab keeps working and hands you the metadata path) — but catalog DISCOVERY and credential vending, i.e. the surface external engines actually browse, are absent, and the Trino engine sees no lake catalog at all.',
    legacyCodes: ['iceberg_catalog_not_configured'],
  },
  // ── N7e — Trino Federated SQL. DEFAULT-ON since the engine moved off AKS ──
  'svc-loom-trino': {
    surfaces: [
      { path: '/items/sql-lab', label: 'SQL Lab → engine picker: "Federated SQL (Trino)"' },
      { path: '/api/sql/trino', label: 'Federated SQL execution edge (audited)' },
    ],
    fixit: { kind: 'env-picker' },
    autoResolveNote:
      'DEFAULT-ON since the engine moved off AKS: every push-button deploy stands up a single-node Trino OSS Container App with INTERNAL ingress and minReplicas 0 (data-plane/loom-trino-aca.bicep) and wires LOOM_TRINO_URL, in Commercial and in Gov. Idle cost is nothing — a replica only exists while a query is running. Empty means an explicit opt-out (loomBackends.trino=\'disabled\'), a non-Container-Apps boundary, or the loom-trino image not yet in this ACR; SQL Lab then keeps executing on the DEFAULT DuckDB tier (svc-loom-duckdb) with the identical result surface. LAKE FEDERATION: the same deploy stands up the N1 Iceberg REST Catalog (svc-iceberg-catalog) and hands the engine its URL, so SHOW CATALOGS includes the Loom lake on a first install — it no longer returns jmx + memory only. Add external sources declaratively with loomBackends.trinoCatalogs / trinoCatalogSecrets (rendered as LOOM_TRINO_CATALOG_<NAME>). Runtime kill switch without a redeploy: the n7e-trino-federation flag. Heavy federated joins can be moved to the opt-in multi-node AKS cluster (data-plane/loom-trino-aks.bicep) by repointing the same var. SECURITY POSTURE — default-ON here means default-SAFE, not merely running: the engine enforces Entra bearer authorization (Trino JWT authenticator against the active cloud\'s Entra JWKS, audience pinned), because internal ingress alone would leave it queryable by anything on the VNet with an arbitrary X-Trino-User. On a from-scratch install there is no app registration to pin yet (ARM cannot create a Graph object), so it deploys SEALED — authorization enforced against a sentinel audience nothing can mint, minReplicas 0 so it bills nothing, serving NOBODY, and LOOM_TRINO_AUTH_MODE reports "sealed" so /items/sql-lab shows this note instead of firing a query that would 401. Run .github/workflows/csa-loom-post-deploy-bootstrap.yml (the sign-in bootstrap every estate needs anyway) and redeploy with LOOM_MSAL_CLIENT_ID set — or pin a dedicated app with loomBackends.trinoAudienceClientId — to un-seal it. loomBackends.trinoAuthMode=\'disabled\' restores the anonymous posture as an explicit, logged opt-out, and the svc-loom-trino env-check now reports THAT as a defect instead of green.',
    legacyCodes: ['trino_not_configured'],
  },
  // The engine's AUTHORIZATION posture, tracked separately from its reachability
  // so an honest health finding can never 503 a working estate (/api/sql/trino
  // hard-gates on svc-loom-trino, not on this id).
  'svc-loom-trino-authz': {
    surfaces: [
      { path: '/items/sql-lab', label: 'SQL Lab -> engine picker: "Federated SQL (Trino)"' },
      { path: '/api/sql/trino', label: 'Federated SQL execution edge (audited)' },
    ],
    fixit: { kind: 'env-picker' },
    autoResolveNote:
      'DEFAULT-SAFE: data-plane/loom-trino-aca.bicep turns on the Trino JWT authenticator (Entra JWKS for the active cloud, audience pinned) and admin-plane/main.bicep reports the resulting posture here. "entra" = enforced and a token can be minted. "sealed" = enforced against a sentinel audience nothing can mint, which is the CORRECT from-scratch state (ARM cannot create the Entra app registration) and is treated as configured, not as a defect - run csa-loom-post-deploy-bootstrap.yml and redeploy to un-seal it. "disabled" is an explicit, audited opt-out that puts the engine back to queryable-by-anything-on-the-VNet with an arbitrary X-Trino-User, bypassing the BFF session check AND the audit row; this gate now REJECTS that value instead of counting it as present. When LOOM_TRINO_URL is unset the engine is not deployed here at all, so the check reports not-applicable rather than a false red.',
    legacyCodes: [],
  },
  'svc-cosmos-control': {
    surfaces: [
      { path: '/admin/scaling', label: 'Cosmos account scaling' },
      { path: '/items/*', label: 'Item version restore' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_COSMOS_ACCOUNT: L.cosmosAccountName },
    legacyCodes: ['cosmos_not_configured'],
  },
  'svc-medallion-layers': {
    surfaces: [
      { path: '/onelake', label: 'OneLake paths (silver/gold)' },
      { path: '/items/semantic-model', label: 'Direct Lake (gold layer)' },
    ],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['gold_url_not_configured', 'mirror_not_configured'],
  },
  'svc-redis-result-cache': {
    surfaces: [{ path: '/items/kql-database', label: 'Query result cache (scale-out)' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Unset → the built-in per-replica in-memory result cache serves everything with zero loss of function.',
  },
  // ── N8 lab 1 — DuckLake catalog option (Preview) ──
  'svc-ducklake-catalog': {
    surfaces: [
      { path: '/items/ducklake-catalog', label: 'DuckLake catalog editor — Postgres-backed lakehouse metadata (Preview)' },
      { path: '/api/ducklake/catalog', label: 'DuckLake catalog listing edge (audited)' },
    ],
    fixit: { kind: 'env-picker' },
    autoResolveNote:
      'DEFAULT-ON IN COMMERCIAL: data-plane/ducklake-catalog-postgres.bicep provisions the private-endpoint-only Postgres store and admin-plane/main.bicep binds LOOM_DUCKLAKE_CATALOG_URL as a Key Vault secretRef, so a from-scratch Commercial deploy arrives wired. Reading the catalog additionally needs the N2 DuckDB tier (LOOM_DUCKDB_URL), which admin-plane/main.bicep also deploys by default (duckdbTierActive, both clouds) — it is the engine that runs the read-only ATTACH. It is unset in exactly four cases: the apps tier is off (deployAppsEnabled=false — the store is deliberately NOT billed before a Console exists to read it), an AKS boundary (the DuckDB engine that runs the ATTACH is Container-Apps-only, so a store there would have no reader), postgresQuotaAvailable=false, or you point it at your own server. GCC-HIGH AND IL5 SET postgresQuotaAvailable=false TODAY, so this gate is the expected state there: PostgreSQL Flexible Server IS an Azure Government service, but the same flag also gates the OSS Airflow host, whose image is an unmirrored docker.io pull and whose metadata Postgres is created with public network access — both are being fixed before the sovereign flip (see the params file comment). Unset → the DuckLake editor renders a guided empty state and honest-gates; N1\'s Iceberg REST Catalog (LOOM_ICEBERG_CATALOG_URL) and every other surface are unaffected.',
    legacyCodes: ['ducklake_not_configured'],
  },
  // ── N8 lab 3 — S3-compatible ADLS gateway (Preview) ──
  'svc-s3-gateway': {
    surfaces: [
      { path: '/items/s3-gateway', label: 'S3-compatible ADLS gateway config (Preview)' },
      { path: '/api/s3-gateway/info', label: 'S3 gateway connect-info edge' },
    ],
    // NOT `env-picker` (#3337). Typing a URL into LOOM_S3_GATEWAY_URL cannot
    // resolve this gate — when it is open there is no gateway to point at, and a
    // hand-set URL would be exactly the bound-but-ungranted state the deploy
    // refuses to ship. The one action that closes it is an RBAC grant, so the
    // Fix-it says so and names the role AND the scope (deploy-integrity R6).
    fixit: {
      kind: 'role-grant',
      grantNote:
        'If the lake was adopted from a Data Landing Zone SUBSCRIPTION, the gateway\'s dedicated identity cannot be granted Storage Blob Data Reader by the admin-plane deployment — a subscription-scoped deployment cannot create a role assignment in another subscription. The cross-subscription grant pass (modules/data-plane/dlz-lake-grant-pass.bicep, #3336) does it instead, but arms ONLY when the deploy lane measured that the deploying service principal holds Microsoft.Authorization/roleAssignments/write at the lake. Grant that principal "User Access Administrator" (or "Role Based Access Control Administrator", or Owner) on the lake\'s subscription or resource group, then re-run deploy-fiab-commercial.yml: the deploy re-measures, arms the pass, and the gateway deploys already granted. Until then the gateway is deliberately NOT deployed rather than shipped with a URL that would 403 every bucket.',
    },
    autoResolveNote:
      'DEFAULT-ON (#2682 / D16): the Apache-2.0 s3proxy Container App is deployed by the pass that owns the lake — admin-plane/main.bicep whenever a lake is BOUND and its grant has an owner, otherwise the dlz-attach pass, which also patches LOOM_S3_GATEWAY_URL onto the running Console. The image is pulled from the deployment\'s OWN ACR (digest-pinned mirror, platform/fiab/images/upstream-images.json); the module has no public-registry branch. BINDING AND GRANTING ARE NOW SEPARATE (#3337): until 2026-08-13 `s3GatewayActive` also required the lake to be in the deployment\'s own subscription, so on any tenant estate whose lake was discovered in a DLZ subscription BOTH deploy paths were shut — admin-plane\'s on that condition and the dlz-attach pass\'s on `topology == \'dlz-attach\'` — and no gateway existed at all while 28 other Loom apps ran. The deploy condition is now "a lake is bound AND its grant has an owner"; the owner is s3-gateway-lake-rbac.bicep same-sub, or the measured cross-sub pass otherwise. Unset now means: the deploying principal cannot grant at a cross-subscription lake (see the Fix-it — one role assignment closes it), the s3proxy image is not yet in this ACR (run the cloud\'s image lane), a dlz-attach run carried no hub ACR / Container Apps environment coordinate, or the apps tier is off. Nothing else degrades: the N1 Iceberg REST Catalog + native ADLS/abfss path still give external engines governed access; only s3://-exclusive clients need this face. (The AGPL MinIO gateway path is not used.)',
    legacyCodes: ['s3_gateway_not_configured'],
  },
  // ── M1 — estate assessment reader (inbound-migration on-ramp) ──
  'svc-loom-migrate': {
    surfaces: [
      { path: '/admin/migrate', label: 'Estate assessment — migration-readiness report' },
      { path: '/api/migrate/assess', label: 'Estate enumeration edge (audited)' },
    ],
    fixit: { kind: 'env-picker' },
    autoResolveNote:
      'DEFAULT-ON since 2026-07-28: admin-plane/main.bicep deploys the loom-migrate reader (data-plane/loom-migrate-aca.bicep) on every apps-enabled deploy in every boundary and sets LOOM_MIGRATE_URL from its FQDN, so a fresh push-button deploy closes this gate with no operator step. The reader scales to zero (~$0 idle) — it only runs during an assessment. This gate can only be open on a pre-2026-07-28 estate that has not been redeployed, before the apps tier deploys, or when an admin opted out with loomBackends.loomMigrate=\'disabled\'; /admin/migrate still renders fully (guided empty state) in that case. Each SOURCE estate still needs its own connection (URL + a Key-Vault-stored token) supplied per assessment — that is a per-source credential, not a deployment gate; an unwired connector honest-gates rather than fabricating counts.',
    legacyCodes: ['migrate_not_configured'],
  },
  // ── N7a — RisingWave stateful streaming-SQL tier (Openness Tier-2 T2-A) ──
  'svc-loom-risingwave': {
    surfaces: [
      { path: '/items/streaming-sql', label: 'Streaming SQL — materialized views over Event Hubs' },
      { path: '/api/streaming-sql/mv', label: 'Streaming MV authoring edge (audited)' },
      { path: '/api/streaming-sql/query', label: 'Streaming SQL read edge (audited)' },
    ],
    fixit: { kind: 'env-picker' },
    autoResolveNote:
      'DEFAULT-ON since 2026-07-28: admin-plane/main.bicep deploys the single-node RisingWave Container App (data-plane/loom-risingwave-aca.bicep) on every apps-enabled deploy in every boundary and sets LOOM_RISINGWAVE_URL to <fqdn>:4566, so a fresh push-button deploy closes this gate with no operator step. DEFAULT-ON HERE MEANS SEALED, NOT OPEN: the same deploy generates an unpredictable Postgres-wire root password, stores it in the Loom Key Vault and binds it on both the engine and the Console as a Key-Vault-backed Container Apps secretRef (LOOM_RISINGWAVE_PASSWORD). That is not optional hardening — RisingWave ships `root` with no password, and because every app in a Container Apps environment draws its pod IP from the same infrastructure subnet, an unauthenticated engine is reachable as root by loom-script-runner and loom-udf-runtime, which execute user-supplied code. The image refuses to start without the credential, and only the engine UAMI and the Console UAMI can read it. The credential alone was not enough either: stock RisingWave single-node binds FIVE routable ports and only the Postgres wire (4566) has any authentication — meta gRPC 5690 can create and drop catalog objects, and ACA ingress is not a firewall because a replica is reachable on its pod IP. The image now runs the engine so that meta, dashboard, compute and compactor listen on 127.0.0.1 only, and asserts that at boot: zero routable sockets while sealed, exactly one while serving, container dies otherwise. COST DISCLOSURE: this is the one tier that cannot scale to zero — a single-node engine keeps materialized-view and meta state in process — so it runs 1 replica at the smallest ACA-legal footprint (2.0 vCPU / 4.0Gi). Budget the ACTIVE rate, about $150/mo per cloud: ACA bills idle rates only while a replica stays under 0.01 vCPU and 1 KB/s, which an engine running meta heartbeats, barriers and compaction does not. Admins opt OUT with loomBackends.risingwave=\'disabled\' (or by blanking the var in /admin/env-config); the streaming-sql editor then renders fully with this Fix-it and Azure Stream Analytics (the stream-analytics-job item) still covers simple streaming jobs.',
    legacyCodes: ['risingwave_not_configured'],
  },
};
