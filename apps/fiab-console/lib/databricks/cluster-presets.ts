/**
 * Databricks CLUSTER SIZE-TIER catalog — curated, best-practice, T-shirt-sized
 * cluster shapes (std-xs-single-node … std-xl-photon) users pick from when
 * creating a Databricks interactive/job cluster, instead of hand-filling a raw
 * form. This is the sizing axis; the work-type spark-conf profiles live in
 * `lib/spark/config-presets` (SPARK_PRESETS). The two compose: a tier answers
 * "how big", a profile answers "tuned for what".
 *
 * Why tiers: Databricks' own cost-optimization guidance is to establish
 * standardized "T-shirt size" compute policies (Small / Medium / Large) at
 * deployment so clusters are right-sized and consistent rather than ad-hoc.
 * These tiers codify that. The tier ids match the operator's canonical
 * workspace cluster names (std-xs-single-node / std-s / std-m-photon /
 * std-l-photon).
 *
 * Every tier ALWAYS:
 *   - sets `autotermination_minutes` (no immortal clusters — auto-terminate all
 *     interactive compute, 30–60 min per Databricks WAF cost guidance),
 *   - tags `{ 'loom-managed': 'true', 'loom-preset': <tierId> }` for hygiene +
 *     cost allocation,
 *   - carries a best-practice `spark_conf` (Adaptive Query Execution on, skew-join
 *     handling, Kryo serializer; Photon tiers add Delta optimize-write/auto-compact).
 *
 * Grounded in Microsoft Learn:
 *   - Azure Databricks WAF — cost optimization (right-size compute, T-shirt
 *     size policies, dev = single/small 2-4 workers, batch ETL = medium 8-16
 *     memory-optimized workers, autoscale, auto-terminate 30-60 min, spot for
 *     fault-tolerant jobs):
 *     https://learn.microsoft.com/azure/well-architected/service-guides/azure-databricks#cost-optimization
 *     https://learn.microsoft.com/azure/databricks/lakehouse-architecture/cost-optimization/best-practices
 *   - Compute sizing patterns (small 2-8 / medium 8-32 / large 32+; memory-
 *     optimized E-series for large in-memory/ETL; single node for dev/test):
 *     https://learn.microsoft.com/azure/databricks/lakehouse-architecture/deployment-guide/compute
 *   - Photon (vectorized engine — analytical ETL/BI/SQL) + AQE + executor
 *     memory 2-8 GB best practices:
 *     https://learn.microsoft.com/azure/databricks/compute/photon
 *     https://learn.microsoft.com/azure/databricks/spark/conf
 *   - cluster-config-best-practices (autoscale min 2, single-node profile):
 *     https://learn.microsoft.com/azure/databricks/compute/cluster-config-best-practices
 *
 * NO freeform JSON (per loom-no-freeform-config): a tier expands to a structured
 * ClusterSpec; the editor's key/value spark_conf + toggles fine-tune it.
 */

import type { ClusterSpec, Cluster } from '@/lib/azure/databricks-client';

/** Workload flavor — interactive (all-purpose, longer idle window, on-demand
 *  driver) vs jobs (fault-tolerant, spot workers, tighter auto-terminate). */
export type WorkloadFlavor = 'interactive' | 'jobs';

/** Runtime channel hint — the builder resolves this to a concrete spark_version
 *  discovered from the workspace (LTS is the safe default). */
export type RuntimeChannel = 'lts' | 'latest' | 'ml';

export interface ClusterTier {
  /** Stable id — also the `loom-preset` tag value + canonical cluster-name stem. */
  id: string;
  /** Short display label. */
  label: string;
  /** One-line summary shown on the tier card. */
  summary: string;
  /** When to pick this tier (the "different sizes" guidance). */
  whenToUse: string;
  /** Fluent icon name (resolved in the UI). */
  icon: string;
  /** Relative cost hint for the card ($ … $$$$). */
  costHint: string;
  /** Worker (and default driver) VM size. */
  nodeTypeId: string;
  /** Single-node cluster (driver only, num_workers 0) — dev/test/small data. */
  singleNode: boolean;
  /** Autoscale bounds (Databricks platform autoscaling — NOT spark
   *  dynamicAllocation, which conflicts). Ignored when singleNode. */
  minWorkers: number;
  maxWorkers: number;
  /** Photon vectorized engine (recommended for analytical ETL / SQL / Delta). */
  photon: boolean;
  /** Idle auto-termination in minutes (ALWAYS set — never 0/immortal). */
  autoterminationMinutes: number;
  /** Runtime channel hint the builder maps to a concrete spark_version. */
  runtimeChannel: RuntimeChannel;
  /** Curated best-practice spark.* confs baked into this tier. */
  sparkConf: Record<string, string>;
}

// --- Shared best-practice spark confs ---------------------------------------
// AQE (Adaptive Query Execution) is Databricks-recommended: it coalesces small
// shuffle partitions ("shuffle partitions auto"), switches join strategies at
// runtime, and splits skewed joins — so we DON'T pin spark.sql.shuffle.partitions
// (AQE derives it). Kryo serializer is the recommended fast path.
const BASE_CONF: Record<string, string> = {
  'spark.sql.adaptive.enabled': 'true',
  'spark.sql.adaptive.coalescePartitions.enabled': 'true',
  'spark.sql.adaptive.skewJoin.enabled': 'true',
  'spark.serializer': 'org.apache.spark.serializer.KryoSerializer',
};
// Delta lakehouse write optimizations — pair with Photon tiers where analytical
// Delta MERGE/INSERT dominates. Databricks-only confs.
const DELTA_CONF: Record<string, string> = {
  'spark.databricks.delta.optimizeWrite.enabled': 'true',
  'spark.databricks.delta.autoCompact.enabled': 'true',
};

/**
 * The tier catalog — ordered smallest → largest. Node types:
 *   - Standard_DS3_v2 (4 vCPU / 14 GB) — general-purpose, dev/small ETL.
 *   - Standard_E8ds_v4 (8 vCPU / 64 GB) — memory-optimized, production ETL.
 *   - Standard_E16ds_v4 (16 vCPU / 128 GB) — memory-optimized, large batch/ML.
 */
export const CLUSTER_TIERS: ClusterTier[] = [
  {
    id: 'std-xs-single-node',
    label: 'XS · Single node',
    summary: 'One driver, no workers. Cheapest — dev, testing, small data.',
    whenToUse: 'Development, unit tests, small datasets, and pandas/driver-only work. Cheapest option.',
    icon: 'Laptop20Regular',
    costHint: '$',
    nodeTypeId: 'Standard_DS3_v2',
    singleNode: true,
    minWorkers: 0,
    maxWorkers: 0,
    photon: false,
    autoterminationMinutes: 30,
    runtimeChannel: 'lts',
    sparkConf: { ...BASE_CONF },
  },
  {
    id: 'std-s',
    label: 'S · Small',
    summary: 'Autoscale 2–4 general-purpose workers. Interactive analytics & light ETL.',
    whenToUse: 'Exploratory analysis, small-to-moderate ETL, mixed interactive workloads. A solid default.',
    icon: 'Cube20Regular',
    costHint: '$$',
    nodeTypeId: 'Standard_DS3_v2',
    singleNode: false,
    minWorkers: 2,
    maxWorkers: 4,
    photon: false,
    autoterminationMinutes: 30,
    runtimeChannel: 'lts',
    sparkConf: { ...BASE_CONF },
  },
  {
    id: 'std-m-photon',
    label: 'M · Medium (Photon)',
    summary: 'Autoscale 4–8 memory-optimized workers + Photon. Production ETL & BI.',
    whenToUse: 'Production ETL, joins/aggregations over larger tables, BI/analytical SQL. Photon accelerates it.',
    icon: 'DataBarVertical20Regular',
    costHint: '$$$',
    nodeTypeId: 'Standard_E8ds_v4',
    singleNode: false,
    minWorkers: 4,
    maxWorkers: 8,
    photon: true,
    autoterminationMinutes: 45,
    runtimeChannel: 'lts',
    sparkConf: { ...BASE_CONF, ...DELTA_CONF },
  },
  {
    id: 'std-l-photon',
    label: 'L · Large (Photon)',
    summary: 'Autoscale 8–16 memory-optimized workers + Photon. Heavy batch & big shuffles.',
    whenToUse: 'Large batch pipelines, wide shuffles, heavy Delta MERGE/medallion writes over big data.',
    icon: 'Server20Regular',
    costHint: '$$$$',
    nodeTypeId: 'Standard_E16ds_v4',
    singleNode: false,
    minWorkers: 8,
    maxWorkers: 16,
    photon: true,
    autoterminationMinutes: 60,
    runtimeChannel: 'lts',
    sparkConf: { ...BASE_CONF, ...DELTA_CONF },
  },
  {
    id: 'std-xl-photon',
    label: 'XL · Extra large (Photon)',
    summary: 'Autoscale 16–32 memory-optimized workers + Photon. Large-scale batch / ML training.',
    whenToUse: 'Large-scale batch processing, model training, and the biggest analytical workloads.',
    icon: 'Storage20Regular',
    costHint: '$$$$$',
    nodeTypeId: 'Standard_E16ds_v4',
    singleNode: false,
    minWorkers: 16,
    maxWorkers: 32,
    photon: true,
    autoterminationMinutes: 60,
    runtimeChannel: 'lts',
    sparkConf: { ...BASE_CONF, ...DELTA_CONF },
  },
];

/** The default tier (a small, general-purpose, autoscaling cluster). */
export const DEFAULT_TIER_ID = 'std-s';

export function findTier(id: string | null | undefined): ClusterTier | undefined {
  return CLUSTER_TIERS.find((t) => t.id === id);
}

export interface ClusterSpecFromTierOptions {
  /** Free-text cluster name (the one field the no-freeform rule allows). If
   *  omitted, a canonical `<tierId>-<flavor>` name is generated. */
  clusterName?: string;
  /** Concrete Databricks runtime discovered from the workspace. Required by the
   *  clusters/create API; the caller resolves it from the tier's runtimeChannel. */
  sparkVersion?: string;
  /** Workload flavor — modifies auto-terminate + spot + workload tag. */
  flavor?: WorkloadFlavor;
  /** Extra spark_conf merged OVER the tier's baked confs (builder overrides). */
  extraSparkConf?: Record<string, string>;
  /** Extra tags merged over the tier's loom-managed tags. */
  extraTags?: Record<string, string>;
}

/**
 * Expand a tier into a Databricks `clusters/create` spec. Deterministic and
 * pure — the log-delivery `cluster_log_conf` is injected server-side (it needs
 * env), so it is intentionally NOT set here. `spark_version` is left blank when
 * not supplied so the caller/route can fill the workspace-discovered runtime.
 */
export function clusterSpecFromTier(
  tier: ClusterTier,
  opts: ClusterSpecFromTierOptions = {},
): ClusterSpec {
  const flavor: WorkloadFlavor = opts.flavor || 'interactive';
  const name = (opts.clusterName || '').trim() || `${tier.id}-${flavor}`;

  const spec: ClusterSpec = {
    cluster_name: name,
    spark_version: opts.sparkVersion || '',
    node_type_id: tier.nodeTypeId,
    // ALWAYS auto-terminate. Jobs flavor tightens the window (fault-tolerant,
    // short-lived); interactive keeps the tier's window.
    autotermination_minutes: flavor === 'jobs'
      ? Math.min(tier.autoterminationMinutes, 20)
      : tier.autoterminationMinutes,
    runtime_engine: tier.photon ? 'PHOTON' : 'STANDARD',
    custom_tags: {
      'loom-managed': 'true',
      'loom-preset': tier.id,
      'loom-workload': flavor,
      ...(opts.extraTags || {}),
    },
  };

  // Sizing: single-node vs autoscale.
  if (tier.singleNode) {
    // Real Databricks single-node recipe: 0 workers + singleNode profile confs
    // + the ResourceClass:SingleNode tag.
    spec.num_workers = 0;
    spec.custom_tags = { ...spec.custom_tags, ResourceClass: 'SingleNode' };
  } else {
    spec.autoscale = { min_workers: tier.minWorkers, max_workers: tier.maxWorkers };
  }

  // Spot workers for fault-tolerant jobs (driver stays on-demand).
  if (flavor === 'jobs') {
    spec.azure_attributes = { availability: 'SPOT_WITH_FALLBACK_AZURE', first_on_demand: 1 };
  }

  // Spark conf: tier best-practice + single-node profile + builder overrides.
  const conf: Record<string, string> = { ...tier.sparkConf };
  if (tier.singleNode) {
    conf['spark.databricks.cluster.profile'] = 'singleNode';
    conf['spark.master'] = 'local[*]';
  }
  Object.assign(conf, opts.extraSparkConf || {});
  if (Object.keys(conf).length) spec.spark_conf = conf;

  return spec;
}

// ============================================================================
// Cluster HYGIENE — pure helpers for the "stale cluster" cleanup surface.
// Grounded in the same Databricks WAF guidance: interactive clusters should
// auto-terminate (30-60 min) and idle/abandoned clusters are waste. These
// classify a live cluster list so the UI can surface + bulk-clean the cruft.
// ============================================================================

/** A cluster is "stale terminated" once it has been TERMINATED this many days. */
export const STALE_TERMINATED_DAYS = 7;
/** A RUNNING cluster is "stale idle" after this many days with no activity. */
export const STALE_RUNNING_IDLE_DAYS = 2;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The most relevant activity timestamp (ms epoch) for a cluster:
 *   - RUNNING/PENDING → last_activity_time (last command), else last_restarted_time,
 *     else start_time.
 *   - TERMINATED → terminated_time.
 * Returns undefined when nothing is known.
 */
export function clusterActivityTime(c: Cluster): number | undefined {
  const state = (c.state || '').toUpperCase();
  if (state === 'TERMINATED' || state === 'TERMINATING') {
    return c.terminated_time || c.last_activity_time || c.last_restarted_time || c.start_time;
  }
  return c.last_activity_time || c.last_restarted_time || c.start_time || c.terminated_time;
}

/** Whole days since the cluster's relevant activity timestamp (0 if unknown). */
export function idleDays(c: Cluster, now: number = Date.now()): number {
  const t = clusterActivityTime(c);
  if (!t || t <= 0) return 0;
  return Math.max(0, Math.floor((now - t) / MS_PER_DAY));
}

/**
 * True when a cluster is stale cruft worth cleaning:
 *   - TERMINATED and terminated > STALE_TERMINATED_DAYS ago, OR
 *   - RUNNING/PENDING and idle > STALE_RUNNING_IDLE_DAYS (no recent activity).
 * Job/pipeline clusters (ephemeral, not user-created) are never flagged — they
 * are managed by their run and disappear on their own.
 */
export function isStale(c: Cluster, now: number = Date.now()): boolean {
  const src = (c.cluster_source || '').toUpperCase();
  if (src && src !== 'UI' && src !== 'API') return false; // JOB/PIPELINE/MODELS/SQL
  const state = (c.state || '').toUpperCase();
  const days = idleDays(c, now);
  if (state === 'TERMINATED') return days > STALE_TERMINATED_DAYS;
  if (state === 'RUNNING' || state === 'PENDING') return days > STALE_RUNNING_IDLE_DAYS;
  return false;
}

/** Human source label — UI / API / JOB / PIPELINE / MODELS / SQL / UNKNOWN. */
export function clusterSourceLabel(c: Cluster): string {
  return (c.cluster_source || 'UNKNOWN').toUpperCase();
}

/** True when this cluster was created by Loom (carries the loom-managed tag). */
export function isLoomManaged(c: Cluster): boolean {
  return c.custom_tags?.['loom-managed'] === 'true';
}

/** The tier/preset id a Loom-managed cluster was created from (if any). */
export function loomPresetOf(c: Cluster): string | undefined {
  const p = c.custom_tags?.['loom-preset'];
  return p ? String(p) : undefined;
}

/** A per-cluster hygiene row — the enriched shape the hygiene BFF returns. */
export interface ClusterHygieneRow {
  cluster_id: string;
  cluster_name?: string;
  state?: string;
  node_type_id?: string;
  source: string;
  idleDays: number;
  stale: boolean;
  loomManaged: boolean;
  loomPreset?: string;
  /** All-purpose (interactive) clusters are user-created; job clusters are ephemeral. */
  allPurpose: boolean;
}

/** Enrich a raw cluster into a hygiene row (pure — used by the BFF + tests). */
export function toHygieneRow(c: Cluster, now: number = Date.now()): ClusterHygieneRow {
  const src = (c.cluster_source || '').toUpperCase();
  return {
    cluster_id: c.cluster_id,
    cluster_name: c.cluster_name,
    state: c.state,
    node_type_id: c.node_type_id,
    source: clusterSourceLabel(c),
    idleDays: idleDays(c, now),
    stale: isStale(c, now),
    loomManaged: isLoomManaged(c),
    loomPreset: loomPresetOf(c),
    allPurpose: !src || src === 'UI' || src === 'API',
  };
}
