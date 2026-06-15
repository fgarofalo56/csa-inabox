/**
 * Databricks scale client — instance pools, environment libraries (install /
 * uninstall) and the Spark-conf builder for the Spark / compute configuration
 * surface (F13). This is the Azure-native default backend for the Fabric
 * "Spark settings" object (Pool / Environment / Jobs); no Fabric capacity or
 * workspace is required — see .claude/rules/no-fabric-dependency.md.
 *
 * These functions deliberately live OUTSIDE the already-large
 * databricks-client.ts (warehouses / clusters / statement execution). They
 * share the exact same auth model:
 *   - AAD token for resource 2ff814a6-3304-4ab8-85cb-cd0e6f879c1d (Azure
 *     Databricks). The Console UAMI must be a workspace user/admin AND hold the
 *     "Allow pool creation" entitlement (workspace admins have it by default;
 *     otherwise grant it via SCIM) — see docs/fiab/v3-tenant-bootstrap.md.
 *   - Hostname from env LOOM_DATABRICKS_HOSTNAME, e.g.
 *     adb-7405613013893759.19.azuredatabricks.net
 *
 * REST surfaces (Microsoft Learn):
 *   Instance Pools  https://learn.microsoft.com/azure/databricks/compute/pools
 *                   /api/2.0/instance-pools/{create,edit,delete,get,list}
 *   Libraries       https://learn.microsoft.com/azure/databricks/libraries
 *                   /api/2.0/libraries/{install,uninstall}
 *   Spark conf      https://learn.microsoft.com/azure/databricks/spark/conf
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';

const DBX_SCOPE = '2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

function host(): string {
  const h = process.env.LOOM_DATABRICKS_HOSTNAME;
  if (!h) throw new Error('LOOM_DATABRICKS_HOSTNAME not configured');
  return h.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

async function dbxToken(): Promise<string> {
  const t = await credential.getToken(DBX_SCOPE);
  if (!t?.token) throw new Error('Failed to acquire Databricks AAD token');
  return t.token;
}

async function dbxFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await dbxToken();
  return fetchWithTimeout(`https://${host()}${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });
}

async function asJsonOrThrow<T>(res: Response, op: string): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    const err: Error & { status?: number; body?: string } = new Error(
      `${op} failed ${res.status}: ${text || res.statusText}`,
    );
    err.status = res.status;
    err.body = text;
    throw err;
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : ({} as T)) as T;
}

// ============================================================
// Instance Pools — /api/2.0/instance-pools
// ============================================================

/** Azure-specific pool attributes (availability + spot bid). */
export interface InstancePoolAzureAttributes {
  /** ON_DEMAND_AZURE keeps idle instances on guaranteed capacity; SPOT_AZURE
   *  uses spot for cost savings (instances may be evicted). */
  availability?: 'ON_DEMAND_AZURE' | 'SPOT_AZURE';
  /** Max spot price as a percentage of the on-demand price. -1 == market price. */
  spot_bid_max_price?: number;
}

/** Live pool stats reported by GET — drives the Pool tab's capacity badges. */
export interface InstancePoolStats {
  used_count?: number;
  idle_count?: number;
  pending_used_count?: number;
  pending_idle_count?: number;
}

/** Create / edit spec for an instance pool. */
export interface InstancePoolCreateSpec {
  instance_pool_name: string;
  node_type_id: string;
  /** Idle instances kept pre-warmed (ready for immediate cluster attach). */
  min_idle_instances?: number;
  /** Hard cap on total instances (idle + in-use). Omit for no cap. */
  max_capacity?: number;
  /** Auto-terminate idle instances after this many minutes (>=0). */
  idle_instance_autotermination_minutes?: number;
  azure_attributes?: InstancePoolAzureAttributes;
  /** Autoscaling local storage. */
  enable_elastic_disk?: boolean;
  custom_tags?: Record<string, string>;
  /** Preloaded Databricks runtime versions for faster cluster start. */
  preloaded_spark_versions?: string[];
}

/** Pool as returned by list/get (spec fields + state + live stats). */
export interface InstancePool extends InstancePoolCreateSpec {
  instance_pool_id: string;
  state?: 'ACTIVE' | 'DELETED' | string;
  stats?: InstancePoolStats;
  default_tags?: Record<string, string>;
}

export async function listInstancePools(): Promise<InstancePool[]> {
  const res = await dbxFetch('/api/2.0/instance-pools/list');
  const body = await asJsonOrThrow<{ instance_pools?: InstancePool[] }>(res, 'listInstancePools');
  return body.instance_pools || [];
}

export async function getInstancePool(poolId: string): Promise<InstancePool> {
  const res = await dbxFetch(
    `/api/2.0/instance-pools/get?instance_pool_id=${encodeURIComponent(poolId)}`,
  );
  return asJsonOrThrow<InstancePool>(res, 'getInstancePool');
}

export async function createInstancePool(
  spec: InstancePoolCreateSpec,
): Promise<{ instance_pool_id: string }> {
  const res = await dbxFetch('/api/2.0/instance-pools/create', {
    method: 'POST',
    body: JSON.stringify(spec),
  });
  return asJsonOrThrow<{ instance_pool_id: string }>(res, 'createInstancePool');
}

export async function editInstancePool(
  poolId: string,
  spec: InstancePoolCreateSpec,
): Promise<void> {
  // /edit requires instance_pool_name + node_type_id alongside the pool id.
  const res = await dbxFetch('/api/2.0/instance-pools/edit', {
    method: 'POST',
    body: JSON.stringify({ instance_pool_id: poolId, ...spec }),
  });
  await asJsonOrThrow<unknown>(res, 'editInstancePool');
}

export async function deleteInstancePool(poolId: string): Promise<void> {
  const res = await dbxFetch('/api/2.0/instance-pools/delete', {
    method: 'POST',
    body: JSON.stringify({ instance_pool_id: poolId }),
  });
  await asJsonOrThrow<unknown>(res, 'deleteInstancePool');
}

// ============================================================
// Environment libraries — /api/2.0/libraries/{install,uninstall}
// ============================================================

/** A single library spec (one of pypi / maven / cran / jar / whl / requirements). */
export interface LibrarySpec {
  pypi?: { package: string; repo?: string };
  maven?: { coordinates: string; repo?: string; exclusions?: string[] };
  cran?: { package: string; repo?: string };
  jar?: string;
  egg?: string;
  whl?: string;
  requirements?: string;
}

export async function installLibraries(
  clusterId: string,
  libraries: LibrarySpec[],
): Promise<void> {
  const res = await dbxFetch('/api/2.0/libraries/install', {
    method: 'POST',
    body: JSON.stringify({ cluster_id: clusterId, libraries }),
  });
  await asJsonOrThrow<unknown>(res, 'installLibraries');
}

export async function uninstallLibraries(
  clusterId: string,
  libraries: LibrarySpec[],
): Promise<void> {
  // uninstall is scheduled and applied on the next cluster restart.
  const res = await dbxFetch('/api/2.0/libraries/uninstall', {
    method: 'POST',
    body: JSON.stringify({ cluster_id: clusterId, libraries }),
  });
  await asJsonOrThrow<unknown>(res, 'uninstallLibraries');
}

// ============================================================
// Jobs / session Spark-conf builder
//
// The Fabric "Jobs" tab (session timeout, optimistic admission, reserved
// cores, dynamic executors) maps onto Databricks cluster-level settings:
//   - session timeout    → autotermination_minutes on ClusterSpec
//   - optimistic admiss. → spark.databricks.optimisticAdmission spark_conf
//   - reserved cores     → spark.databricks.driver.reservedCores spark_conf
//   - dynamic executors  → Databricks autoscale (NOT spark.dynamicAllocation —
//                          that family is unsupported on classic clusters, per
//                          https://learn.microsoft.com/azure/databricks/spark/conf)
//
// These are stored as defaults in Cosmos and merged into the ClusterSpec when
// a cluster is created/edited from the workspace template — applying them to a
// real Databricks session. buildJobSparkConf is a pure function (no fetch).
// ============================================================

export interface JobsConfig {
  /** Idle minutes before the session auto-terminates (autotermination_minutes). */
  session_timeout_minutes: number;
  /** Start sessions while the cluster is still initializing. */
  optimistic_admission: boolean;
  /** Cores reserved on the driver for the runtime (>0 to set). */
  reserve_cores: number;
  /** When true, the workspace template uses Databricks autoscale (min/max). */
  dynamic_executors?: boolean;
  min_executors?: number;
  max_executors?: number;
}

/**
 * Build the spark_conf dict applied to clusters created from this workspace's
 * template. Pure — no network. dynamic_executors is intentionally NOT emitted
 * as spark.dynamicAllocation.* (unsupported on Databricks classic compute); the
 * UI surfaces the autoscale path instead and the route maps min/max_executors
 * onto ClusterSpec.autoscale.
 */
export function buildJobSparkConf(opts: JobsConfig): Record<string, string> {
  const conf: Record<string, string> = {};
  if (opts.optimistic_admission) {
    conf['spark.databricks.optimisticAdmission'] = 'true';
  }
  if (opts.reserve_cores && opts.reserve_cores > 0) {
    conf['spark.databricks.driver.reservedCores'] = String(opts.reserve_cores);
  }
  return conf;
}
