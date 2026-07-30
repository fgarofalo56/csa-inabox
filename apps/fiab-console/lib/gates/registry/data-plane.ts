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
      'Unset → Delta↔Iceberg dual metadata still writes real Iceberg V2 metadata into your own ADLS Gen2 (the Interop tab keeps working and hands you the metadata path). The catalog adds discovery + credential vending on top; it is never on the data path.',
    legacyCodes: ['iceberg_catalog_not_configured'],
  },
  // ── N7e — Trino Federated SQL (the ONE opt-in carve-out; gates NO feature) ──
  'svc-loom-trino': {
    surfaces: [
      { path: '/items/sql-lab', label: 'SQL Lab → engine picker: "Federated SQL (Trino)"' },
      { path: '/api/sql/trino', label: 'Federated SQL execution edge (audited)' },
    ],
    fixit: { kind: 'env-picker' },
    autoResolveNote:
      'OPT-IN by design — this is the single non-default engine in the program. Unset → SQL Lab runs on the DEFAULT DuckDB tier (svc-loom-duckdb) with the identical result surface; only the additive "Federated SQL (Trino)" choice is gated. Deploying loom-trino-aks.bicep stands up a private AKS cluster (real, disclosed cost) that can join a Loom Iceberg table with an external Postgres table in one statement. Its absence removes no capability, so it never breaches loom_default_on_opt_out.',
    legacyCodes: ['trino_not_configured'],
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
    fixit: { kind: 'env-picker' },
    autoResolveNote:
      'Opt-in Preview lab. Unset → the surface documents that the N1 Iceberg REST Catalog + native ADLS/abfss path already give external engines governed access, so most deployments need no gateway. Set LOOM_S3_GATEWAY_URL only when you deploy an Apache-2.0 s3proxy for s3://-exclusive clients (the AGPL MinIO path is not used).',
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
