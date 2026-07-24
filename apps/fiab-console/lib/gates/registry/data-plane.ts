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
};
