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
  // ── DR0 — restore posture (verified live by probe-dr-restore-posture) ──
  'svc-dr-restore-posture': {
    surfaces: [{ path: '/admin/health', label: 'DR restore posture (Health & Reliability)' }],
    fixit: {
      kind: 'wizard',
      grantNote: 'The Cosmos side is fixable in-product: Admin → the Cosmos account-management surface PATCHes backupPolicy (Continuous tier switch is a hot in-place ARM update). The lake side is bicep-provisioned (recycleRetentionDays soft delete + change feed); blob versioning cannot be enabled on an HNS account (platform limitation).',
    },
    autoResolveNote: 'A push-button deploy ships the full posture by default: Cosmos Continuous backup (drConfig.cosmosBackupTier, default Continuous30Days) + lake soft-delete/change-feed (recycleRetentionDays).',
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
      'Opt-in Preview lab ALONGSIDE the N1 Iceberg REST Catalog. Unset → the DuckLake editor renders a guided empty state and honest-gates; N1\'s IRC (LOOM_ICEBERG_CATALOG_URL) and every other surface are unaffected. Point LOOM_DUCKLAKE_CATALOG_URL at an in-VNet Postgres store to try it.',
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
      'Opt-in on-ramp: /admin/migrate renders fully (guided empty state) with LOOM_MIGRATE_URL unset. Set it to the internal-ingress loom-migrate reader to enumerate a Snowflake / Databricks-UC / Fabric / Power BI estate. Each source still needs its own connection (URL + a Key-Vault-stored token) supplied per assessment; an unwired connector honest-gates rather than fabricating counts.',
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
      'Opt-in stateful-streaming tier: the streaming-sql editor renders fully (guided empty state) with LOOM_RISINGWAVE_URL unset. Set it to the internal-ingress loom-risingwave Container App to author streaming materialized views over Event Hubs sinking to Delta/Iceberg. Azure Stream Analytics (the stream-analytics-job item) still covers simple streaming jobs; RisingWave adds the stateful class (windowed joins, incremental aggregations). ~$150-300/mo/cloud when deployed.',
    legacyCodes: ['risingwave_not_configured'],
  },
};
