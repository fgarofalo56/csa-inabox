/**
 * Shared Databricks cluster resolution — "notebooks are always runnable".
 *
 * The operator's #1 complaint was that installing an app with
 * databricks-notebook items gated with "No Databricks cluster is available to
 * run the notebook" whenever the workspace had no live all-purpose cluster —
 * so notebooks failed on install and when opened + Run in the editor. Databricks
 * auto-terminates and eventually removes idle clusters, so any pre-seeded
 * loom-cluster-* eventually disappears and the gate returns.
 *
 * `ensureRunnableCluster()` makes the default path self-healing: it resolves an
 * existing all-purpose cluster (RUNNING preferred, else a startable one), and
 * when NONE exists it AUTO-CREATES a stable, reusable `loom-notebook-default`
 * all-purpose cluster — pool-backed when a Loom instance pool exists, else a
 * small standalone cluster on the latest LTS runtime with a 30-min auto-term.
 * A hard remediation gate is returned ONLY when Databricks genuinely can't be
 * used (workspace not configured, or the UAMI lacks cluster list/create RBAC).
 *
 * Idempotent: `loom-notebook-default` is reused (and started) if it already
 * exists in any state, so repeated installs/opens never pile up duplicates.
 *
 * Both the install provisioners (runs/submit auto-starts a supplied
 * existing_cluster_id) and the notebook editor's Run path (Command Execution,
 * which needs a RUNNING cluster → autoStart) share this one resolver.
 *
 * Docs:
 *   https://learn.microsoft.com/azure/databricks/api/workspace/clusters/create
 *   https://learn.microsoft.com/azure/databricks/api/workspace/clusters/start
 *   https://learn.microsoft.com/azure/databricks/compute/pool-best-practices
 */
import {
  listClusters,
  createCluster,
  startCluster,
  listSparkVersions,
  isAllPurposeCluster,
  type Cluster,
  type ClusterSpec,
  type SparkVersion,
} from '@/lib/azure/databricks-client';
import { listInstancePools, type InstancePool } from '@/lib/azure/databricks-scale-client';
import { databricksClusterLogConf } from '@/lib/spark/config-presets';

/** Stable, reused name for the Loom-managed default notebook cluster. */
export const DEFAULT_CLUSTER_NAME = 'loom-notebook-default';

/** Small worker VM used for the standalone (non-pool) default cluster. Matches
 *  the 'balanced'/'cost-optimized' Spark presets. */
const DEFAULT_NODE_TYPE = 'Standard_DS3_v2';

/** Fallback runtime when the workspace's spark-versions list can't be read.
 *  A widely-available Databricks LTS key; only used if discovery fails. */
const FALLBACK_SPARK_VERSION = '15.4.x-scala2.12';

/** How many workers the standalone default cluster runs (a 2-node cluster:
 *  1 driver + 1 worker). Cheap but enough to execute demo/medallion notebooks. */
const DEFAULT_NUM_WORKERS = 1;

const DEFAULT_AUTOTERM_MINUTES = 30;

export interface ClusterResolution {
  clusterId?: string;
  /** True when THIS call created a brand-new cluster (it will be PENDING). */
  created?: boolean;
  /** True when the returned cluster is not yet RUNNING (freshly created, or a
   *  start was issued). A runs/submit against it queues; the editor should show
   *  a "starting (2–5 min)" state and enable Run once it reaches RUNNING. */
  starting?: boolean;
  /** Set only when Databricks genuinely can't produce a runnable cluster —
   *  carries the precise env var / RBAC remediation. */
  gate?: { reason: string; remediation: string };
}

/**
 * Pick the latest LTS Spark runtime key from the workspace's spark-versions
 * list. Filters out ML/GPU/Genomics/aarch64/Beta/RC channels (the notebook
 * default should be the standard LTS runtime) and sorts by the leading
 * major.minor in the version key (e.g. "15.4.x-scala2.12" → 15.4).
 */
export function pickLatestLtsSparkVersion(versions: SparkVersion[]): string | undefined {
  const excluded = /ML|GPU|Genomics|aarch64|Beta|\bRC\b|Snapshot/i;
  const lts = versions.filter((v) => /LTS/i.test(v.name) && !excluded.test(v.name));
  const pool = lts.length ? lts : versions.filter((v) => !excluded.test(v.name));
  const scored = pool
    .map((v) => ({ v, n: parseFloat((v.key.match(/^(\d+\.\d+)/) || [])[1] || '0') }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  return scored[0]?.v.key || pool[0]?.key;
}

/** Resolve the runtime key for the default cluster (latest LTS, else fallback). */
async function resolveDefaultSparkVersion(): Promise<string> {
  try {
    const versions = await listSparkVersions();
    return pickLatestLtsSparkVersion(versions) || FALLBACK_SPARK_VERSION;
  } catch {
    return FALLBACK_SPARK_VERSION;
  }
}

/** Find an ACTIVE Loom instance pool (name starts with `loom-pool`), preferring
 *  the smallest-looking one so the default cluster stays cheap. Returns
 *  undefined when there is no Loom pool (or pools can't be listed). */
async function findLoomPool(): Promise<InstancePool | undefined> {
  let pools: InstancePool[];
  try {
    pools = await listInstancePools();
  } catch {
    return undefined;
  }
  const loom = pools.filter(
    (p) => /^loom-pool/i.test(p.instance_pool_name || '') && (!p.state || p.state === 'ACTIVE'),
  );
  // Prefer a pool whose name hints "small" (loom-pool-s), else the first Loom pool.
  return loom.find((p) => /(-s\b|-small|-s$)/i.test(p.instance_pool_name || '')) || loom[0];
}

/** Build the clusters/create spec for the default cluster — pool-backed when a
 *  Loom pool exists (inherits node type + tags), else a small standalone cluster. */
async function buildDefaultClusterSpec(): Promise<ClusterSpec> {
  const spark_version = await resolveDefaultSparkVersion();
  const pool = await findLoomPool();

  if (pool) {
    // Pool-backed: node type comes from the pool. Do NOT set node_type_id or
    // custom_tags — the pool's inherited default tags collide with a
    // cluster-set 'loom-managed' tag (past install bug), so we leave tags to
    // the pool. Log delivery still applies (it isn't a tag).
    const spec: ClusterSpec = {
      cluster_name: DEFAULT_CLUSTER_NAME,
      spark_version,
      instance_pool_id: pool.instance_pool_id,
      num_workers: DEFAULT_NUM_WORKERS,
      autotermination_minutes: DEFAULT_AUTOTERM_MINUTES,
    };
    const logConf = databricksClusterLogConf();
    if (logConf) spec.cluster_log_conf = logConf;
    return spec;
  }

  const spec: ClusterSpec = {
    cluster_name: DEFAULT_CLUSTER_NAME,
    spark_version,
    node_type_id: DEFAULT_NODE_TYPE,
    num_workers: DEFAULT_NUM_WORKERS,
    autotermination_minutes: DEFAULT_AUTOTERM_MINUTES,
    custom_tags: { 'loom-managed': 'true', 'loom-role': 'notebook-default' },
  };
  const logConf = databricksClusterLogConf();
  if (logConf) spec.cluster_log_conf = logConf;
  return spec;
}

/**
 * Resolve — or, when necessary, auto-create — a runnable all-purpose Databricks
 * cluster for the notebook run path.
 *
 * Preference order:
 *   1. LOOM_DATABRICKS_CLUSTER_ID (explicit override).
 *   2. A RUNNING all-purpose cluster the UAMI can see.
 *   3. A startable all-purpose cluster (non-terminated preferred, else a
 *      TERMINATED one — runs/submit auto-starts it; editor autoStart starts it).
 *   4. AUTO-CREATE `loom-notebook-default` (pool-backed if a Loom pool exists),
 *      returning it PENDING.
 * Only returns a gate when Databricks can't be listed/created at all (config /
 * RBAC) — a missing cluster is NEVER a terminal gate on its own.
 *
 * @param opts.autoStart  When true (editor Command-Execution path, which needs
 *   a RUNNING cluster), issue clusters/start on a resolved-but-not-running
 *   cluster. Provisioners that use jobs/runs/submit can leave this false —
 *   runs/submit auto-starts the supplied existing_cluster_id.
 */
export async function ensureRunnableCluster(
  opts?: { autoStart?: boolean },
): Promise<ClusterResolution> {
  const autoStart = opts?.autoStart ?? false;

  const explicit = process.env.LOOM_DATABRICKS_CLUSTER_ID;
  if (explicit) {
    if (autoStart) await startCluster(explicit).catch(() => { /* may already be running */ });
    return { clusterId: explicit };
  }

  let clusters: Cluster[];
  try {
    clusters = await listClusters();
  } catch (e: any) {
    return {
      gate: {
        reason: `Could not list Databricks clusters: ${e?.message || String(e)}`,
        remediation:
          'Grant the Console UAMI workspace access on the Databricks workspace ' +
          '(SCIM bootstrap) so it can list + create clusters, or set ' +
          'LOOM_DATABRICKS_CLUSTER_ID to a specific cluster id the UAMI can run.',
      },
    };
  }

  // ONLY all-purpose (interactive) clusters are accepted by runs/submit
  // existing_cluster_id and the Command Execution API. clusters/list also
  // returns recently-run JOB clusters — filtering them out avoids the
  // "INVALID_PARAMETER_VALUE … is not an all-purpose cluster" error.
  const allPurpose = clusters.filter(isAllPurposeCluster);

  const running = allPurpose.find((c) => c.state === 'RUNNING');
  if (running) return { clusterId: running.cluster_id };

  const startable =
    allPurpose.find(
      (c) => c.state && !['TERMINATED', 'TERMINATING', 'ERROR'].includes(c.state),
    ) || allPurpose.find((c) => c.state === 'TERMINATED');
  if (startable) {
    if (autoStart && startable.state !== 'RUNNING') {
      await startCluster(startable.cluster_id).catch(() => { /* best-effort start */ });
    }
    return { clusterId: startable.cluster_id, starting: startable.state !== 'RUNNING' };
  }

  // No all-purpose cluster exists → auto-create the stable default. (A pre-existing
  // loom-notebook-default in any state would already be in `allPurpose` above, so
  // reaching here means we genuinely need to create one — idempotent by construction.)
  try {
    const spec = await buildDefaultClusterSpec();
    const { cluster_id } = await createCluster(spec);
    return { clusterId: cluster_id, created: true, starting: true };
  } catch (e: any) {
    return {
      gate: {
        reason: `Could not auto-create a Databricks cluster: ${e?.message || String(e)}`,
        remediation:
          'Grant the Console UAMI "Allow cluster creation" (Databricks workspace ' +
          'entitlement) and ensure the workspace has quota for a small ' +
          `${DEFAULT_NODE_TYPE} node, or set LOOM_DATABRICKS_CLUSTER_ID to an ` +
          'existing all-purpose cluster.',
      },
    };
  }
}
