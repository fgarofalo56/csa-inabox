/**
 * Spark configuration PRESET CATALOG — best-practice, work-type-specific Spark
 * configurations users pick from in the notebook "Configure session" builder
 * (Synapse Spark via Livy) and the Databricks cluster builder.
 *
 * NO freeform JSON anywhere (per loom-no-freeform-config): a preset is a curated
 * set of structured `spark.*` key/values + sizing; the builder also exposes a
 * structured key/value editor (one row per conf), never a textarea.
 *
 * Grounded in:
 *   - Synapse Apache Spark configuration (key/value spark.* props, applied per
 *     pool / session / job): https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-azure-create-spark-configuration
 *   - Synapse Spark → Log Analytics (spark.synapse.logAnalytics.*):
 *     https://learn.microsoft.com/azure/synapse-analytics/spark/data-collector-api-to-log-ingestion-api
 *   - Databricks Spark conf + cluster config (spark_conf, autoscale, Photon):
 *     https://learn.microsoft.com/azure/databricks/spark/conf
 *     https://learn.microsoft.com/azure/databricks/compute/configure
 *   - Apache Spark AQE / tuning: https://spark.apache.org/docs/latest/sql-performance-tuning.html
 *
 * Note on Databricks: Databricks manages executor lifecycle via platform
 * autoscaling — NEVER set spark.dynamicAllocation.* on a Databricks cluster
 * (it conflicts with autoscaling). Those confs are Synapse-only here.
 */

export type SparkConf = Record<string, string>;

/** Synapse Spark session sizing (maps to the Livy session-create body). */
export interface SynapseSizing {
  numExecutors: number;
  executorMemoryGb: number;
  timeoutMinutes: number;
}

/** Databricks cluster shape (maps to the clusters/create API). */
export interface DatabricksShape {
  /** Worker (and default driver) VM size. */
  nodeTypeId: string;
  /** Autoscale bounds (Databricks autoscaling, NOT spark dynamicAllocation). */
  minWorkers: number;
  maxWorkers: number;
  /** Photon vectorized engine (recommended for SQL/Delta). */
  photon: boolean;
  /** Idle auto-termination (minutes). */
  autoterminationMinutes: number;
  /** Use Azure Spot VMs for workers (cost-optimized; driver stays on-demand). */
  spot?: boolean;
  /** Hint for the runtime channel: 'lts' | 'latest' | 'ml'. The builder maps
   *  this to the concrete spark_version it discovers from the workspace. */
  runtimeChannel?: 'lts' | 'latest' | 'ml';
}

export interface SparkPreset {
  id: string;
  label: string;
  /** One-line summary shown in the picker. */
  summary: string;
  /** When a user should pick this — the "different work types" guidance. */
  whenToUse: string;
  /** Fluent icon name (resolved in the UI). */
  icon: string;
  /** Where this preset applies. */
  targets: ('synapse' | 'databricks')[];
  /** Curated spark.* properties for this work type (applied to both backends
   *  unless a key is backend-specific — see dbxOnlyConf / synapseOnlyConf). */
  sparkConf: SparkConf;
  /** Confs valid ONLY on Synapse Spark (e.g. dynamicAllocation). */
  synapseOnlyConf?: SparkConf;
  /** Confs valid ONLY on Databricks (e.g. delta optimizeWrite). */
  dbxOnlyConf?: SparkConf;
  synapse: SynapseSizing;
  databricks: DatabricksShape;
}

/**
 * The catalog. Ordered from general → specialized. Each preset's sparkConf is a
 * conservative, documented best-practice set (Adaptive Query Execution is on by
 * default in modern Spark/Databricks; we still pin the knobs that matter per
 * work type so the choice is explicit and reviewable).
 */
export const SPARK_PRESETS: SparkPreset[] = [
  {
    id: 'balanced',
    label: 'Balanced (general purpose)',
    summary: 'Sensible defaults for interactive analytics and most ETL.',
    whenToUse: 'Exploratory analysis, moderate ETL, mixed read/transform/write. Start here.',
    icon: 'Options20Regular',
    targets: ['synapse', 'databricks'],
    sparkConf: {
      'spark.sql.adaptive.enabled': 'true',
      'spark.sql.adaptive.coalescePartitions.enabled': 'true',
      'spark.sql.adaptive.skewJoin.enabled': 'true',
      'spark.serializer': 'org.apache.spark.serializer.KryoSerializer',
      'spark.sql.shuffle.partitions': '200',
    },
    synapse: { numExecutors: 2, executorMemoryGb: 4, timeoutMinutes: 60 },
    databricks: { nodeTypeId: 'Standard_DS3_v2', minWorkers: 2, maxWorkers: 4, photon: true, autoterminationMinutes: 30, runtimeChannel: 'lts' },
  },
  {
    id: 'large-shuffle',
    label: 'Large joins & aggregations (memory-optimized)',
    summary: 'Big shuffles, wide joins, heavy group-bys — more memory + skew handling.',
    whenToUse: 'Joining/aggregating large tables, wide shuffles, or jobs that spill to disk.',
    icon: 'DatabaseStack20Regular',
    targets: ['synapse', 'databricks'],
    sparkConf: {
      'spark.sql.adaptive.enabled': 'true',
      'spark.sql.adaptive.coalescePartitions.enabled': 'true',
      'spark.sql.adaptive.skewJoin.enabled': 'true',
      'spark.sql.adaptive.advisoryPartitionSizeInBytes': '128m',
      'spark.sql.shuffle.partitions': '400',
      'spark.sql.autoBroadcastJoinThreshold': '52428800', // 50MB
      'spark.serializer': 'org.apache.spark.serializer.KryoSerializer',
      'spark.shuffle.file.buffer': '1m',
    },
    synapse: { numExecutors: 4, executorMemoryGb: 8, timeoutMinutes: 90 },
    databricks: { nodeTypeId: 'Standard_E8ds_v4', minWorkers: 2, maxWorkers: 8, photon: true, autoterminationMinutes: 30, runtimeChannel: 'lts' },
  },
  {
    id: 'high-parallelism',
    label: 'Many small files / high parallelism',
    summary: 'Read thousands of small files or maximize task parallelism.',
    whenToUse: 'Ingesting many small files, highly partitioned sources, or embarrassingly-parallel maps.',
    icon: 'Grid20Regular',
    targets: ['synapse', 'databricks'],
    sparkConf: {
      'spark.sql.adaptive.enabled': 'true',
      'spark.sql.adaptive.coalescePartitions.enabled': 'true',
      'spark.sql.files.maxPartitionBytes': '67108864', // 64MB — smaller input splits
      'spark.sql.files.openCostInBytes': '4194304',
      'spark.sql.shuffle.partitions': '600',
      'spark.default.parallelism': '600',
    },
    synapse: { numExecutors: 8, executorMemoryGb: 4, timeoutMinutes: 60 },
    databricks: { nodeTypeId: 'Standard_DS3_v2', minWorkers: 4, maxWorkers: 12, photon: true, autoterminationMinutes: 30, runtimeChannel: 'lts' },
  },
  {
    id: 'streaming',
    label: 'Structured streaming / low-latency',
    summary: 'Steady, fixed-size compute for continuous/streaming reads.',
    whenToUse: 'Structured Streaming, micro-batch pipelines, or latency-sensitive continuous jobs.',
    icon: 'Flash20Regular',
    targets: ['synapse', 'databricks'],
    sparkConf: {
      'spark.sql.adaptive.enabled': 'false', // AQE off for stable streaming plans
      'spark.sql.shuffle.partitions': '64',
      'spark.streaming.backpressure.enabled': 'true',
      'spark.sql.streaming.metricsEnabled': 'true',
    },
    synapseOnlyConf: { 'spark.dynamicAllocation.enabled': 'false' }, // stable executors for streaming
    synapse: { numExecutors: 3, executorMemoryGb: 8, timeoutMinutes: 1440 },
    databricks: { nodeTypeId: 'Standard_DS3_v2', minWorkers: 2, maxWorkers: 2, photon: false, autoterminationMinutes: 0, runtimeChannel: 'lts' },
  },
  {
    id: 'ml-compute',
    label: 'ML / heavy single-node compute',
    summary: 'Bigger driver for collect()/training; ML runtime on Databricks.',
    whenToUse: 'Model training, pandas/scikit on the driver, or collect()-heavy analysis.',
    icon: 'BrainCircuit20Regular',
    targets: ['synapse', 'databricks'],
    sparkConf: {
      'spark.sql.adaptive.enabled': 'true',
      'spark.driver.maxResultSize': '4g',
      'spark.serializer': 'org.apache.spark.serializer.KryoSerializer',
      'spark.task.cpus': '1',
    },
    synapse: { numExecutors: 2, executorMemoryGb: 8, timeoutMinutes: 120 },
    databricks: { nodeTypeId: 'Standard_DS4_v2', minWorkers: 1, maxWorkers: 4, photon: false, autoterminationMinutes: 60, runtimeChannel: 'ml' },
  },
  {
    id: 'delta-optimized',
    label: 'Delta / lakehouse writes (Databricks)',
    summary: 'Optimized Delta writes — auto optimize-write + compaction.',
    whenToUse: 'Heavy Delta MERGE/UPDATE/INSERT, lakehouse medallion writes (Databricks).',
    icon: 'Layer20Regular',
    targets: ['databricks'],
    sparkConf: {
      'spark.sql.adaptive.enabled': 'true',
      'spark.sql.shuffle.partitions': '200',
    },
    dbxOnlyConf: {
      'spark.databricks.delta.optimizeWrite.enabled': 'true',
      'spark.databricks.delta.autoCompact.enabled': 'true',
      'spark.databricks.delta.merge.repartitionBeforeWrite.enabled': 'true',
    },
    synapse: { numExecutors: 4, executorMemoryGb: 8, timeoutMinutes: 90 },
    databricks: { nodeTypeId: 'Standard_DS3_v2', minWorkers: 2, maxWorkers: 8, photon: true, autoterminationMinutes: 30, runtimeChannel: 'lts' },
  },
  {
    id: 'cost-optimized',
    label: 'Cost-optimized / dev',
    summary: 'Smallest viable session, short idle timeout, Spot workers on Databricks.',
    whenToUse: 'Development, light queries, demos — minimize spend.',
    icon: 'Savings20Regular',
    targets: ['synapse', 'databricks'],
    sparkConf: {
      'spark.sql.adaptive.enabled': 'true',
      'spark.sql.adaptive.coalescePartitions.enabled': 'true',
      'spark.sql.shuffle.partitions': '64',
    },
    synapse: { numExecutors: 1, executorMemoryGb: 4, timeoutMinutes: 20 },
    databricks: { nodeTypeId: 'Standard_DS3_v2', minWorkers: 1, maxWorkers: 2, photon: true, autoterminationMinutes: 15, spot: true, runtimeChannel: 'lts' },
  },
];

export function findPreset(id: string | undefined | null): SparkPreset | undefined {
  return SPARK_PRESETS.find((p) => p.id === id);
}

/** Resolve a preset's effective Synapse spark.* confs (base + synapse-only). */
export function synapseConfFor(p: SparkPreset): SparkConf {
  return { ...p.sparkConf, ...(p.synapseOnlyConf || {}) };
}

/** Resolve a preset's effective Databricks spark.* confs (base + dbx-only). */
export function databricksConfFor(p: SparkPreset): SparkConf {
  return { ...p.sparkConf, ...(p.dbxOnlyConf || {}) };
}

/**
 * Common spark.* keys surfaced as suggestions in the key/value builder (so the
 * user doesn't have to memorize them). Curated, documented knobs only.
 */
export const COMMON_SPARK_CONF_KEYS: { key: string; hint: string }[] = [
  { key: 'spark.sql.shuffle.partitions', hint: 'Partitions for shuffles/joins (default 200).' },
  { key: 'spark.sql.adaptive.enabled', hint: 'Adaptive Query Execution (re-optimize at runtime).' },
  { key: 'spark.sql.adaptive.coalescePartitions.enabled', hint: 'Auto-coalesce small post-shuffle partitions.' },
  { key: 'spark.sql.adaptive.skewJoin.enabled', hint: 'Split skewed partitions in joins.' },
  { key: 'spark.sql.autoBroadcastJoinThreshold', hint: 'Max table bytes to broadcast in a join (-1 disables).' },
  { key: 'spark.sql.files.maxPartitionBytes', hint: 'Max bytes per input partition when reading files.' },
  { key: 'spark.serializer', hint: 'Use org.apache.spark.serializer.KryoSerializer for speed.' },
  { key: 'spark.driver.maxResultSize', hint: 'Max total size of collected results (e.g. 4g).' },
  { key: 'spark.default.parallelism', hint: 'Default parallelism for RDD ops.' },
  { key: 'spark.dynamicAllocation.enabled', hint: 'Synapse only — set false to pin executors.' },
];

/**
 * Synapse Spark → Loom Log Analytics diagnostic confs. Returns the
 * spark.synapse.logAnalytics.* properties that make a Spark session emit its
 * logging events, metrics, and listener events to the Loom Log Analytics
 * workspace (SparkLoggingEvent_CL / SparkMetrics_CL / SparkListenerEvent_CL).
 *
 * Honest gate (no-vaporware): returns {} when the LA workspace id + key are not
 * configured (env unset) — the caller then runs WITHOUT LA emission rather than
 * injecting broken confs. Wire LOOM_SPARK_LA_WORKSPACE_ID + LOOM_SPARK_LA_KEY
 * (or the Key-Vault refs) via bicep (see docs/fiab/spark-observability-plan.md).
 *
 * @param env defaults to process.env (server-side).
 */
export function synapseLogAnalyticsConf(env: NodeJS.ProcessEnv = process.env): SparkConf {
  const workspaceId = (env.LOOM_SPARK_LA_WORKSPACE_ID || '').trim();
  const secret = (env.LOOM_SPARK_LA_KEY || '').trim();
  const kvName = (env.LOOM_SPARK_LA_KEYVAULT_NAME || '').trim();
  const kvSecretName = (env.LOOM_SPARK_LA_KEYVAULT_SECRET || '').trim();
  if (!workspaceId) return {};
  const conf: SparkConf = {
    'spark.synapse.logAnalytics.enabled': 'true',
    'spark.synapse.logAnalytics.workspaceId': workspaceId,
  };
  // Prefer a Key Vault-backed secret; fall back to an inline shared key.
  if (kvName && kvSecretName) {
    conf['spark.synapse.logAnalytics.keyVault.name'] = kvName;
    conf['spark.synapse.logAnalytics.keyVault.key'] = kvSecretName;
  } else if (secret) {
    conf['spark.synapse.logAnalytics.secret'] = secret;
  } else {
    // Workspace id set but no key → can't authenticate the emitter; skip.
    return {};
  }
  return conf;
}

/** True when Synapse→LA diagnostics are configured in this deployment. */
export function synapseLogAnalyticsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.keys(synapseLogAnalyticsConf(env)).length > 0;
}
