/**
 * spark-config-client — orchestration layer for the Spark / compute
 * configuration surface (F13). Combines the Cosmos `workspace-spark-config`
 * store (the operator's desired Pool / Runtime / Environment / Jobs settings,
 * the source of truth) with the live Databricks REST surface (instance pools,
 * runtime/node-type catalogs, library install/uninstall). The BFF routes import
 * THIS module so the Cosmos-vs-Databricks decision is hidden from the routes.
 *
 * Azure-native default — Databricks is the backend; no Microsoft Fabric
 * capacity or workspace is required (see .claude/rules/no-fabric-dependency.md).
 * The only non-functional state is an honest config gate (Databricks host not
 * set, or a sovereign cloud where Azure Databricks is unavailable).
 */

import {
  workspaceSparkConfigContainer,
  type WorkspaceSparkConfig,
} from '@/lib/azure/cosmos-client';
import {
  databricksConfigGate,
  listNodeTypes,
  listSparkVersions,
  listClusters,
  listClusterLibraries,
  type NodeType,
  type SparkVersion,
  type Cluster,
  type LibraryStatus,
} from '@/lib/azure/databricks-client';
import {
  listInstancePools,
  createInstancePool,
  deleteInstancePool,
  installLibraries,
  uninstallLibraries,
  type InstancePool,
  type InstancePoolCreateSpec,
  type LibrarySpec,
} from '@/lib/azure/databricks-scale-client';
import { detectLoomCloud } from '@/lib/azure/cloud-endpoints';

export type { WorkspaceSparkConfig } from '@/lib/azure/cosmos-client';
export type {
  InstancePool,
  InstancePoolCreateSpec,
  LibrarySpec,
} from '@/lib/azure/databricks-scale-client';
export type { NodeType, SparkVersion, Cluster, LibraryStatus } from '@/lib/azure/databricks-client';

// ------------------------------------------------------------
// Honest config gate
// ------------------------------------------------------------

export interface SparkGate {
  /** Machine code for the UI to branch on. */
  code: 'not_configured' | 'not_available_in_cloud';
  /** Precise, actionable message (env var to set / why unavailable). */
  message: string;
  /** The exact missing env var, when code === 'not_configured'. */
  missing?: string;
}

/**
 * Returns an honest gate when the Spark compute surface cannot reach a real
 * Databricks workspace — either the host env var is unset, or the deployment
 * is in a sovereign cloud where Azure Databricks is not offered (GCC-High /
 * DoD). Returns null when the surface is fully functional.
 */
export function sparkConfigGate(): SparkGate | null {
  const cloud = detectLoomCloud();
  if (cloud === 'GCC-High' || cloud === 'DoD') {
    return {
      code: 'not_available_in_cloud',
      message:
        `Azure Databricks is not available in ${cloud}. Spark compute ` +
        'configuration requires a Commercial or GCC deployment. ' +
        'Use the Synapse Spark pool path for notebook compute in this cloud.',
    };
  }
  const g = databricksConfigGate();
  if (g) {
    return {
      code: 'not_configured',
      message:
        `Databricks workspace not configured: set ${g.missing} on the Console ` +
        'Container App (the workspace hostname from the DLZ deployment output, ' +
        'e.g. adb-1234567890.7.azuredatabricks.net). The Console UAMI must be a ' +
        'workspace admin (or hold the "Allow pool creation" entitlement) to ' +
        'create pools.',
      missing: g.missing,
    };
  }
  return null;
}

// ------------------------------------------------------------
// Cosmos CRUD for the per-workspace Spark config doc
// ------------------------------------------------------------

/** Default config used when a workspace has no stored Spark settings yet. */
export function defaultSparkConfig(workspaceId: string): WorkspaceSparkConfig {
  return {
    id: workspaceId,
    workspaceId,
    pool: { mode: 'starter' },
    runtime: {},
    environment: { pypi: [], maven: [], sessionLevelPackages: false },
    jobs: {
      session_timeout_minutes: 60,
      optimistic_admission: false,
      reserve_cores: 0,
      dynamic_executors: false,
    },
    updatedAt: new Date().toISOString(),
  };
}

export async function getSparkConfig(workspaceId: string): Promise<WorkspaceSparkConfig> {
  const c = await workspaceSparkConfigContainer();
  try {
    const { resource } = await c.item(workspaceId, workspaceId).read<WorkspaceSparkConfig>();
    if (resource) {
      // Backfill any newly-added sub-objects so the editor never reads undefined.
      const d = defaultSparkConfig(workspaceId);
      return {
        ...d,
        ...resource,
        pool: { ...d.pool, ...(resource.pool || {}) },
        runtime: { ...d.runtime, ...(resource.runtime || {}) },
        environment: { ...d.environment, ...(resource.environment || {}) },
        jobs: { ...d.jobs, ...(resource.jobs || {}) },
      };
    }
  } catch {
    // 404 → no doc yet; fall through to default.
  }
  return defaultSparkConfig(workspaceId);
}

export async function upsertSparkConfig(
  workspaceId: string,
  patch: Partial<Omit<WorkspaceSparkConfig, 'id' | 'workspaceId'>>,
  updatedBy?: string,
): Promise<WorkspaceSparkConfig> {
  const c = await workspaceSparkConfigContainer();
  const current = await getSparkConfig(workspaceId);
  const next: WorkspaceSparkConfig = {
    ...current,
    ...patch,
    // Deep-merge the four sub-objects so a partial save (e.g. only `jobs`)
    // never clobbers the others.
    pool: { ...current.pool, ...(patch.pool || {}) },
    runtime: { ...current.runtime, ...(patch.runtime || {}) },
    environment: { ...current.environment, ...(patch.environment || {}) },
    jobs: { ...current.jobs, ...(patch.jobs || {}) },
    id: workspaceId,
    workspaceId,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || current.updatedBy,
  };
  const { resource } = await c.items.upsert<WorkspaceSparkConfig>(next);
  return (resource as WorkspaceSparkConfig) || next;
}

// ------------------------------------------------------------
// Pools (live Databricks REST)
// ------------------------------------------------------------

export async function listPools(): Promise<InstancePool[]> {
  return listInstancePools();
}

export async function createPool(
  spec: InstancePoolCreateSpec,
): Promise<{ instance_pool_id: string }> {
  return createInstancePool(spec);
}

export async function deletePool(poolId: string): Promise<void> {
  return deleteInstancePool(poolId);
}

// ------------------------------------------------------------
// Runtime catalogs (live Databricks REST)
// ------------------------------------------------------------

export async function listRuntimeVersions(): Promise<SparkVersion[]> {
  return listSparkVersions();
}

export async function listAvailableNodeTypes(): Promise<NodeType[]> {
  return listNodeTypes();
}

// ------------------------------------------------------------
// Environment libraries (live Databricks REST, cluster-scoped)
// ------------------------------------------------------------

export async function listWorkspaceClusters(): Promise<Cluster[]> {
  return listClusters();
}

export async function listEnvironmentLibraries(clusterId: string): Promise<LibraryStatus[]> {
  return listClusterLibraries(clusterId);
}

export async function installEnvironmentLibraries(
  clusterId: string,
  libs: LibrarySpec[],
): Promise<void> {
  return installLibraries(clusterId, libs);
}

export async function uninstallEnvironmentLibraries(
  clusterId: string,
  libs: LibrarySpec[],
): Promise<void> {
  return uninstallLibraries(clusterId, libs);
}

/**
 * Translate the operator's "pypi"/"maven" string lists (stored in Cosmos) into
 * the Databricks LibrarySpec[] shape for install/uninstall. A pypi entry is the
 * raw package spec ('pandas==2.2.2'); a maven entry is the coordinates
 * ('com.example:lib:1.0'). Empty/blank entries are dropped.
 */
export function toLibrarySpecs(opts: { pypi?: string[]; maven?: string[] }): LibrarySpec[] {
  const out: LibrarySpec[] = [];
  for (const p of opts.pypi || []) {
    const v = p.trim();
    if (v) out.push({ pypi: { package: v } });
  }
  for (const m of opts.maven || []) {
    const v = m.trim();
    if (v) out.push({ maven: { coordinates: v } });
  }
  return out;
}
