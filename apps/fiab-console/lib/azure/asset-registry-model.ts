/**
 * loom-assets — SOFTWARE-DEFINED ASSET registry doc shape + PURE policy helpers
 * + MIG1 versioned-migration registration (N5).
 *
 * N5 reframes the estate as a graph of ASSETS: every lakehouse table, MLV,
 * SQLMesh/dbt model (N4) and pipeline output is an asset with a DECLARED
 * freshness policy and a materializer binding. Dagster's software-defined-asset
 * SEMANTICS are adopted natively — asset key, declared deps, freshness policy,
 * data-aware (upstream-changed) scheduling, materialize — with **NO Dagster
 * runtime** anywhere in the path. The scheduler is a Loom ACA Job; the
 * materializers are the SAME Synapse / Databricks / SQLMesh clients the rest of
 * the product already calls.
 *
 * The GRAPH is never authored here: deps are DERIVED from WS-L's
 * `lib/azure/unified-lineage.ts` (and N4's `lib/transform/transform-dag.ts`
 * asset descriptors) by `lib/assets/asset-graph.ts`. This container persists
 * ONLY what lineage cannot know: the operator's freshness policy, the
 * materializer binding, and the observed run/version watermarks the reconciler
 * writes. A doc is therefore a SIDECAR on a derived asset — never a second
 * source of truth for lineage.
 *
 * This module is a LEAF: it imports ONLY `cosmos-migrations` (no cosmos-client,
 * no Azure SDK, no next), so `cosmos-client` can import it at module scope to
 * register the migrator chain before any read materializes — the
 * semantic-contract-model / prompt-registry-model / lakehouse-interop-model
 * precedent. It is therefore also safe to import from a client component for
 * the shared types + the pure policy/freshness helpers.
 *
 * CURRENT SCHEMA VERSION: 1 (every doc is stamped `schemaVersion: 1` at write).
 * A future breaking shape change bumps ASSET_REGISTRY_SCHEMA_VERSION to N+1 and
 * registers its `fromVersion: N` migrator in {@link registerAssetRegistryMigrators}
 * (called at module scope). Per MIG1 there is deliberately NO v1 migrator today.
 *
 * Per-cloud: identical Commercial / GCC-High / IL5 — pure metadata in the
 * deployment's OWN Cosmos. SOVEREIGN MOAT / IL5: the whole asset plane is
 * in-boundary. Policies live in this deployment's Cosmos, versions are read
 * from the `_delta_log` in the customer's own ADLS Gen2, signals come from the
 * deployment's own Event Hubs namespace, and materialization runs on the
 * customer's own Synapse / Databricks / transform-runner. Nothing here reaches
 * a SaaS control plane (no Dagster Cloud, no Fabric, no Power BI), so the full
 * capability runs DISCONNECTED in an IL5 air-gapped enclave.
 */

import { registerMigrator, type DocMigrator } from './cosmos-migrations';

export const ASSET_REGISTRY_CONTAINER = 'loom-assets';
export const ASSET_REGISTRY_SCHEMA_VERSION = 1;

// ── Asset taxonomy ──────────────────────────────────────────────────────────

/** What an asset physically is. Mirrors the lineage node types N5 keeps. */
export type AssetKind =
  | 'table'
  | 'view'
  | 'materialized-view'
  | 'streaming-table'
  | 'model'
  | 'source'
  | 'path'
  | 'dataset'
  | 'semantic-model'
  | 'report'
  | 'unknown';

/**
 * How an asset is MATERIALIZED. Each value maps 1:1 onto an EXISTING Loom
 * client — N5 dispatches, it never re-implements a runner:
 *   sqlmesh / dbt      → lib/transform/transform-runner-client.runnerRun
 *   synapse-pipeline   → lib/azure/synapse-dev-client.runPipeline
 *   databricks-job     → lib/azure/databricks-client.runJob
 *   none               → no binding yet (Materialize returns an honest gate)
 */
export type AssetMaterializerKind = 'sqlmesh' | 'dbt' | 'synapse-pipeline' | 'databricks-job' | 'activation-sync' | 'none';

/** Declared refresh cadence. Dropdown-only (loom_no_freeform_config). */
export type FreshnessCadence = 'none' | '15m' | 'hourly' | '4h' | 'daily' | 'weekly' | 'monthly';

/** Cadence → its period in MINUTES. `none` = unmanaged (0). */
export const CADENCE_MINUTES: Record<FreshnessCadence, number> = {
  none: 0,
  '15m': 15,
  hourly: 60,
  '4h': 240,
  daily: 1440,
  weekly: 10080,
  monthly: 43200,
};

/** The cadence dropdown (id + label), in the order the editor renders it. */
export const CADENCE_OPTIONS: ReadonlyArray<{ id: FreshnessCadence; label: string }> = [
  { id: 'none', label: 'Unmanaged — no freshness expectation' },
  { id: '15m', label: 'Every 15 minutes' },
  { id: 'hourly', label: 'Hourly' },
  { id: '4h', label: 'Every 4 hours' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
];

/** Grace allowance before an overdue asset is flagged. Dropdown-only. */
export type FreshnessGrace = 'none' | '15m' | 'hourly' | '4h' | 'daily';

export const GRACE_MINUTES: Record<FreshnessGrace, number> = {
  none: 0,
  '15m': 15,
  hourly: 60,
  '4h': 240,
  daily: 1440,
};

export const GRACE_OPTIONS: ReadonlyArray<{ id: FreshnessGrace; label: string }> = [
  { id: 'none', label: 'No grace — overdue the moment the cadence lapses' },
  { id: '15m', label: '15 minutes' },
  { id: 'hourly', label: '1 hour' },
  { id: '4h', label: '4 hours' },
  { id: 'daily', label: '1 day' },
];

/**
 * Whether the reconciler may materialize this asset on its own.
 *   auto   — data-aware + cadence triggers dispatch the real backing job.
 *   manual — only the Materialize button runs it; the reconciler still
 *            evaluates freshness and can alert, it just never triggers.
 */
export type MaterializationMode = 'auto' | 'manual';

export const MODE_OPTIONS: ReadonlyArray<{ id: MaterializationMode; label: string }> = [
  { id: 'auto', label: 'Auto — reconcile when upstreams change or the cadence lapses' },
  { id: 'manual', label: 'Manual — only the Materialize action runs this asset' },
];

/** Alert severity routed through the O1 shared action group. `none` = silent. */
export type AssetAlertSeverity = 'none' | 'P3' | 'P2' | 'P1';

export const ALERT_OPTIONS: ReadonlyArray<{ id: AssetAlertSeverity; label: string }> = [
  { id: 'none', label: 'No alert — surface the stale badge only' },
  { id: 'P3', label: 'P3 — email band (informational)' },
  { id: 'P2', label: 'P2 — urgent (all receivers)' },
  { id: 'P1', label: 'P1 — page (all receivers + on-call webhook)' },
];

/** The per-asset freshness policy. Every field is dropdown-backed. */
export interface AssetFreshnessPolicy {
  cadence: FreshnessCadence;
  grace: FreshnessGrace;
  mode: MaterializationMode;
  alertSeverity: AssetAlertSeverity;
}

/** Outcome of the last materialization the reconciler / UI observed. */
export type AssetRunOutcome = 'succeeded' | 'failed' | 'running' | 'skipped';

/** How an asset's materialization is dispatched (the real backing job). */
export interface AssetMaterializerBinding {
  kind: AssetMaterializerKind;
  /** transformation-project item id (sqlmesh / dbt). */
  itemId?: string;
  /** SQLMesh virtual environment / dbt target. */
  environment?: string;
  /** Synapse pipeline name. */
  pipelineName?: string;
  /** Databricks job id. */
  jobId?: number;
}

/**
 * One asset's registry sidecar. PK /tenantId; id `asset:<encoded assetKey>` so
 * a policy read is a point-read inside the tenant's single partition.
 */
export interface AssetDoc {
  id: string;
  /** Partition key — the owning principal's Entra oid (Loom tenant scope). */
  tenantId: string;
  docType: 'asset';
  schemaVersion: number;
  /** Canonical asset key (see assetKeyFromIdentity / the N4 asset descriptor). */
  assetKey: string;
  /** Display name at the time the policy was saved (lineage remains the source). */
  name?: string;
  kind?: AssetKind;
  group?: string;
  policy: AssetFreshnessPolicy;
  materializer: AssetMaterializerBinding;
  /** Last successful materialization (drives freshness). */
  lastMaterializedAt?: string;
  /** Delta commit version / eventstream watermark AT that materialization. */
  materializedVersion?: number;
  /** Newest Delta commit version / watermark the reconciler has observed. */
  observedVersion?: number;
  observedAt?: string;
  /** Last time a materialization was DISPATCHED (the thrash-guard watermark). */
  lastTriggerAt?: string;
  lastRunId?: string;
  lastRunOutcome?: AssetRunOutcome;
  /** Honest detail from the last dispatch (engine error, gate, run id). */
  lastDetail?: string;
  /** Consecutive failed materializations — drives the reconciler backoff. */
  consecutiveFailures?: number;
  /** Last time an overdue alert fired (alert dedup). */
  lastAlertAt?: string;
  updatedAt: string;
  updatedBy?: string;
}

// ── PURE helpers ────────────────────────────────────────────────────────────

/** The default policy for a newly-seen asset — unmanaged + manual, so a freshly
 *  derived graph is never red and never self-triggers before an operator opts in. */
export function defaultAssetPolicy(): AssetFreshnessPolicy {
  return { cadence: 'none', grace: 'hourly', mode: 'manual', alertSeverity: 'none' };
}

/** Cosmos id for an asset's sidecar doc. */
export function assetDocId(assetKey: string): string {
  return `asset:${encodeURIComponent(String(assetKey).trim())}`;
}

/**
 * Normalize an asset key: trimmed, lower-cased, no trailing slash. Returns ''
 * for anything unusable so callers can 400 instead of writing a junk partition
 * entry. Keys are `<namespace>:<identifier>` (`table:` / `path:` / `item:` /
 * `model:` / `source:` / `asset:`).
 */
export function normalizeAssetKey(raw: unknown): string {
  const s = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!s || s.length > 512) return '';
  if (s.includes('\n') || s.includes('\r')) return '';
  return s.toLowerCase();
}

/** Coerce an arbitrary payload into a VALID policy (dropdown values only). */
export function coerceAssetPolicy(raw: unknown): AssetFreshnessPolicy {
  const p = (raw ?? {}) as Partial<AssetFreshnessPolicy>;
  const cadence: FreshnessCadence = CADENCE_OPTIONS.some((o) => o.id === p.cadence)
    ? (p.cadence as FreshnessCadence)
    : 'none';
  const grace: FreshnessGrace = GRACE_OPTIONS.some((o) => o.id === p.grace)
    ? (p.grace as FreshnessGrace)
    : 'hourly';
  const mode: MaterializationMode = p.mode === 'auto' ? 'auto' : 'manual';
  const alertSeverity: AssetAlertSeverity = ALERT_OPTIONS.some((o) => o.id === p.alertSeverity)
    ? (p.alertSeverity as AssetAlertSeverity)
    : 'none';
  return { cadence, grace, mode, alertSeverity };
}

/** Coerce an arbitrary payload into a VALID materializer binding. */
export function coerceMaterializer(raw: unknown): AssetMaterializerBinding {
  const m = (raw ?? {}) as Partial<AssetMaterializerBinding>;
  const kinds: AssetMaterializerKind[] = ['sqlmesh', 'dbt', 'synapse-pipeline', 'databricks-job', 'activation-sync', 'none'];
  const kind: AssetMaterializerKind = kinds.includes(m.kind as AssetMaterializerKind)
    ? (m.kind as AssetMaterializerKind)
    : 'none';
  const jobId = Number(m.jobId);
  return {
    kind,
    ...(typeof m.itemId === 'string' && m.itemId.trim() ? { itemId: m.itemId.trim() } : {}),
    ...(typeof m.environment === 'string' && m.environment.trim() ? { environment: m.environment.trim() } : {}),
    ...(typeof m.pipelineName === 'string' && m.pipelineName.trim() ? { pipelineName: m.pipelineName.trim() } : {}),
    ...(Number.isFinite(jobId) && jobId > 0 ? { jobId } : {}),
  };
}

/** A fresh sidecar doc for an asset that has never had one written. */
export function emptyAssetDoc(tenantId: string, assetKey: string): AssetDoc {
  return {
    id: assetDocId(assetKey),
    tenantId,
    docType: 'asset',
    schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
    assetKey,
    policy: defaultAssetPolicy(),
    materializer: { kind: 'none' },
    updatedAt: new Date().toISOString(),
  };
}

// ── MIG1 registration ───────────────────────────────────────────────────────

/**
 * MIG1 — register the `loom-assets` migrator chain. Called at module scope so
 * the chain is in place before `cosmos-client` materializes any read. There is
 * deliberately NO v1 migrator: version 1 is the initial shape. The FIRST
 * breaking change adds:
 *
 *   const v1toV2: DocMigrator = (doc) => ({ ...doc, …, schemaVersion: 2 });
 *   registerMigrator(ASSET_REGISTRY_CONTAINER, 1, v1toV2);
 */
export function registerAssetRegistryMigrators(): void {
  const chain: Array<[number, DocMigrator]> = [];
  for (const [fromVersion, migrate] of chain) {
    registerMigrator(ASSET_REGISTRY_CONTAINER, fromVersion, migrate);
  }
}

registerAssetRegistryMigrators();
