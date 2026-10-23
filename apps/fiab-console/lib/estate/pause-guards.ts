/**
 * Pause-safety guards shared by the orchestrator (plan + act time) and the ARM
 * actuator (defence in depth). Kept in its own module so the actuator can use it
 * without importing the orchestrator.
 */

/** Tag values that mark a Container App as the surface that resumes the estate. */
const RESUME_SURFACE_TAG_VALUES: readonly string[] = ['console', 'resume-surface'];

/**
 * Container Apps that must NEVER be scaled to zero, with the evidence for each
 * (operator decision 2026-10-22: Container Apps are paused by default; these are
 * the measured exceptions). Keys are lower-case Container App names. Each reason
 * quotes the Bicep module that documents it. Lifting an entry is a code change
 * that accepts the stated loss - it is deliberately not a runtime setting.
 *
 * The console itself is NOT listed here: it is held by name/identity/tag in
 * `containerAppPauseGuard` below, which fails safe when it cannot tell.
 */
export const NEVER_PAUSE_CONTAINER_APPS: Readonly<Record<string, string>> = {
  'loom-risingwave':
    'holds materialized-view and meta state IN PROCESS; a scaled-to-zero replica loses every MV definition and its progress '
    + '(modules/data-plane/loom-risingwave-aca.bicep, "CANNOT scale to zero").',
  'iceberg-catalog':
    'the catalog is on the metadata hot path and cold-starts in 23-30s against a hard 30s Front Door ceiling, so the first '
    + 'federation call after a pause would get a 504 (admin-plane/main.bicep, iceberg-catalog minReplicas comment, #3110 section 2).',
  'loom-unity':
    'it runs the same image and cold-start profile as iceberg-catalog (23-30s vs the 30s Front Door ceiling) and, where the durable Postgres '
    + 'store is not wired, an ephemeral H2 catalog that scale-to-zero destroys (modules/compute/loom-unity-app.bicep).',
  'loom-redis-oss':
    'a shared cache that scales to zero loses every key each idle window and looks warm while empty '
    + '(modules/shared/redis-oss-aca.bicep, "minReplicas 1").',
  'loom-capacity-broker':
    'it is HA-critical admission control (minReplicas 2); a cold start on the job-submit hot path would stall every job '
    + '(modules/compute/loom-capacity-broker-app.bicep).',
  'loom-onelake':
    'namespace resolution is on the hot path, so it deliberately keeps one warm replica (modules/compute/loom-onelake-app.bicep).',
  'loom-activator':
    'it is a background worker with no inbound traffic and is pinned to minReplicas 1 on purpose, so pausing it silently stops '
    + 'Activator rule evaluation and nothing wakes it (admin-plane/main.bicep, loom-activator app entry).',
  'loom-mirroring':
    'it is a background replication worker with no inbound traffic and is pinned to minReplicas 1 on purpose, so pausing it '
    + 'silently stops Mirroring replication and nothing wakes it (admin-plane/main.bicep, loom-mirroring app entry).',
  'loom-airflow':
    'LocalExecutor runs the webserver and the singleton scheduler in one replica pinned to minReplicas 1, so pausing it silently '
    + 'stops every cron DAG and nothing wakes it (modules/admin-plane/airflow.bicep, "scheduler must be a singleton").',
  'loom-mcp':
    'the console calls it synchronously on user request paths (agent flows, MCP server list and test-connection) with a 5s client '
    + 'timeout (lib/azure/mcp-client.ts), and its wake time from zero, with an Azure Files volume to mount, is unmeasured, '
    + 'so a first call could time out as a false "unreachable".',
  'loom-mcp-bridge':
    'the console fetches its catalog synchronously when the External-MCP panel opens, aborting after 5s '
    + '(app/api/admin/mcp-servers/bridge/route.ts); its wake time from zero is unmeasured, so the first open could report a false timeout.',
  'loom-duckdb':
    'the interactive serving tier is documented "never scale-to-zero" (modules/data-plane/duckdb-aca.bicep).',
};

/** True when `name` is on the never-pause list (case-insensitive). */
export function neverPauseReason(name: string): string | null {
  return NEVER_PAUSE_CONTAINER_APPS[String(name ?? '').trim().toLowerCase()] ?? null;
}

/**
 * Decide whether a Container App may be scaled to zero. FAILS SAFE: an app is
 * eligible only when it can be POSITIVELY identified as not the console.
 *
 * Held out (left running) when ANY of these holds:
 *   - this process's own app name (`CONTAINER_APP_NAME`, set by the platform)
 *     is unknown - we cannot tell which app is us, so none may be touched;
 *   - the app is named the same as this process (it IS the running console);
 *   - the app's name contains "console" (the deployed name is `loom-console`);
 *   - it is on {@link NEVER_PAUSE_CONTAINER_APPS} (data loss / hard outage on wake);
 *   - a `loom-role` or `loom-estate-pause` tag marks it console / resume-surface
 *     / exempt.
 */
export function containerAppPauseGuard(
  app: { name: string; tags: Readonly<Record<string, string>> | null },
  selfAppName: string | undefined,
): { eligible: boolean; reason: string } {
  const self = String(selfAppName ?? '').trim().toLowerCase();
  const name = String(app.name ?? '').trim().toLowerCase();
  if (!self) {
    return {
      eligible: false,
      reason:
        `${app.name} is a Container App and this process could not identify its own app name `
        + '(CONTAINER_APP_NAME unset), so it cannot be established that the app is not the console. Left RUNNING.',
    };
  }
  if (!name) return { eligible: false, reason: 'A Container App with no name cannot be identified. Left RUNNING.' };
  if (name === self) {
    return { eligible: false, reason: `${app.name} is the app running this console; pausing it would strand the resume surface. Left RUNNING.` };
  }
  if (name.includes('console')) {
    return { eligible: false, reason: `${app.name} is named like the Loom console, the surface that resumes the estate. Left RUNNING.` };
  }
  const never = neverPauseReason(name);
  if (never) {
    return { eligible: false, reason: `${app.name} is on the never-pause list because ${never} Left RUNNING.` };
  }
  if (!app.tags) {
    return { eligible: false, reason: `The tags of ${app.name} could not be read, so an exempt marker could not be ruled out. Left RUNNING.` };
  }
  for (const [k, v] of Object.entries(app.tags)) {
    const key = k.toLowerCase();
    const val = String(v).trim().toLowerCase();
    if (key === 'loom-role' && RESUME_SURFACE_TAG_VALUES.includes(val)) {
      return { eligible: false, reason: `${app.name} is tagged loom-role=${v}, the resume surface. Left RUNNING.` };
    }
    if (key === 'loom-estate-pause' && val === 'exempt') {
      return { eligible: false, reason: `${app.name} is tagged loom-estate-pause=exempt. Left RUNNING.` };
    }
  }
  return { eligible: true, reason: `${app.name} is positively identified as a non-console Loom app.` };
}

/**
 * Decide whether an AKS managed cluster may be stopped (#5099). FAILS SAFE, and
 * is the AKS mirror of {@link containerAppPauseGuard}: on `containerPlatform=aks`
 * the console itself runs ON a cluster, and stopping that cluster would strand
 * the only surface that can start it again.
 *
 * Held out (left running) when ANY of these holds:
 *   - this process runs on AKS (`LOOM_CONTAINER_PLATFORM=aks`, or the pod-injected
 *     `KUBERNETES_SERVICE_HOST`) and its own cluster name (`LOOM_AKS_CLUSTER_NAME`)
 *     is unknown - we cannot tell which cluster is ours, so none may be touched;
 *   - the cluster is named the same as this process's own cluster (the name match
 *     is deliberately NOT narrowed by resource group: holding out too much is the
 *     safe error);
 *   - its tags could not be read;
 *   - a `loom-role` or `loom-estate-pause` tag marks it console / resume-surface /
 *     exempt.
 */
export function aksPauseGuard(
  cluster: { name: string; tags: Readonly<Record<string, string>> | null },
  env: NodeJS.ProcessEnv = process.env,
): { eligible: boolean; reason: string } {
  const name = String(cluster.name ?? '').trim().toLowerCase();
  if (!name) return { eligible: false, reason: 'An AKS cluster with no name cannot be identified. Left RUNNING.' };
  const platform = String(env.LOOM_CONTAINER_PLATFORM ?? '').trim().toLowerCase();
  const inCluster = platform === 'aks' || String(env.KUBERNETES_SERVICE_HOST ?? '').trim() !== '';
  const self = String(env.LOOM_AKS_CLUSTER_NAME ?? '').trim().toLowerCase();
  if (inCluster) {
    if (!self) {
      return {
        eligible: false,
        reason:
          `${cluster.name} is an AKS cluster and this console runs on AKS but could not identify its own cluster `
          + '(LOOM_AKS_CLUSTER_NAME unset), so it cannot be established that the cluster is not the one hosting the console. Left RUNNING.',
      };
    }
    if (name === self) {
      return {
        eligible: false,
        reason: `${cluster.name} is the AKS cluster hosting this console (containerPlatform=aks); stopping it would strand the resume surface. Left RUNNING.`,
      };
    }
  }
  if (!cluster.tags) {
    return { eligible: false, reason: `The tags of ${cluster.name} could not be read, so an exempt marker could not be ruled out. Left RUNNING.` };
  }
  for (const [k, v] of Object.entries(cluster.tags)) {
    const key = k.toLowerCase();
    const val = String(v).trim().toLowerCase();
    if (key === 'loom-role' && RESUME_SURFACE_TAG_VALUES.includes(val)) {
      return { eligible: false, reason: `${cluster.name} is tagged loom-role=${v}, the resume surface. Left RUNNING.` };
    }
    if (key === 'loom-estate-pause' && val === 'exempt') {
      return { eligible: false, reason: `${cluster.name} is tagged loom-estate-pause=exempt. Left RUNNING.` };
    }
  }
  return { eligible: true, reason: `${cluster.name} is positively identified as an AKS cluster that does not host the console.` };
}

/** True for the types whose loss can strand the console, and so carry a per-resource guard. */
export function guardedTierType(resourceType: string): boolean {
  const t = String(resourceType ?? '').toLowerCase();
  return t === 'microsoft.app/containerapps' || t === 'microsoft.containerservice/managedclusters';
}

/**
 * The per-type guard the planner and the act-time re-check share. Every other
 * type is eligible here and is judged by ownership alone.
 */
export function tierPauseGuard(
  resource: { resourceType: string; name: string; tags: Readonly<Record<string, string>> | null },
  selfAppName: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { eligible: boolean; reason: string } {
  const t = String(resource.resourceType ?? '').toLowerCase();
  if (t === 'microsoft.app/containerapps') return containerAppPauseGuard(resource, selfAppName);
  if (t === 'microsoft.containerservice/managedclusters') return aksPauseGuard(resource, env);
  return { eligible: true, reason: '' };
}
