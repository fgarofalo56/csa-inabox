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

// ---------------------------------------------------------------------------
// Database dependency guard (#5099 phase B)
// ---------------------------------------------------------------------------

/** ARM types of the flexible servers the dependency guard judges. */
export const DB_TIER_TYPES: readonly string[] = [
  'microsoft.dbforpostgresql/flexibleservers',
  'microsoft.dbformysql/flexibleservers',
];

/** Types a database's consumer can be: the apps that connect to it. */
const CONSUMER_TYPES: readonly string[] = ['microsoft.app/containerapps', 'microsoft.web/sites'];

/** True for the databases the dependency guard governs. */
export function isDbTierType(resourceType: string): boolean {
  return DB_TIER_TYPES.includes(String(resourceType ?? '').toLowerCase());
}

/** True for a type that can be a database's consumer. */
export function isConsumerType(resourceType: string): boolean {
  return CONSUMER_TYPES.includes(String(resourceType ?? '').toLowerCase());
}

/**
 * The bicep-stamped tag naming the apps that connect to a database:
 * `loom-estate-pause-consumers=<comma-separated Container App / web app names>`.
 * Absent or empty = consumers UNKNOWN (the server is held out). The literal value
 * `none` is the one explicit way to say "no running app uses this", and is an
 * operator decision.
 */
export const CONSUMERS_TAG_KEY = 'loom-estate-pause-consumers';

export type ConsumersTag =
  | { state: 'unknown' }
  | { state: 'none' }
  | { state: 'listed'; names: string[] };

/** Parse the consumers tag. Names are lower-cased, trimmed and de-duplicated. */
export function parseConsumersTag(tags: Readonly<Record<string, string>> | null): ConsumersTag {
  if (!tags) return { state: 'unknown' };
  const raw = Object.entries(tags).find(([k]) => k.toLowerCase() === CONSUMERS_TAG_KEY)?.[1];
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return { state: 'unknown' };
  if (value === 'none') return { state: 'none' };
  const names = [...new Set(value.split(',').map((n) => n.trim()).filter(Boolean))];
  return names.length ? { state: 'listed', names } : { state: 'unknown' };
}

/** What the plan knows about the rest of the pause set, for judging a database's consumers. */
export interface PauseSetView {
  /** Lower-cased names of the consumer-type resources that WILL be paused. */
  pausing: ReadonlySet<string>;
  /** Lower-cased name -> why that consumer is held out of the set (when the plan knows). */
  heldOut: ReadonlyMap<string, string>;
}

/**
 * Decide whether a PostgreSQL / MySQL flexible server may be stopped. FAILS SAFE,
 * and the rule is dependency-aware: stopping a database under a running app breaks
 * the app, and most estate databases back apps on the never-pause list
 * (`loom-unity`, `loom-airflow`, `loom-duckdb`) or the console itself.
 *
 * ELIGIBLE only when EVERY consumer named by the `loom-estate-pause-consumers`
 * tag is in the same pause set (`view.pausing`) and so is stopped BEFORE the
 * database (data tier pauses after consumers), or the tag says `none`.
 *
 * Held out (left running) when ANY of these holds:
 *   - the tags could not be read;
 *   - `loom-estate-pause=exempt`;
 *   - the consumers tag is absent/empty: "consumers unknown";
 *   - a consumer is on the never-pause list, or is named like the console;
 *   - a consumer is not in the pause set (held out, opted out, or undiscovered).
 * The first consumer that pins the server is named in `reason` and `pinnedBy`.
 */
export function dbPauseGuard(
  db: { name: string; tags: Readonly<Record<string, string>> | null },
  view: PauseSetView,
): { eligible: boolean; reason: string; pinnedBy?: string } {
  const name = String(db.name ?? '').trim();
  if (!name) return { eligible: false, reason: 'A database server with no name cannot be identified. Left RUNNING.' };
  if (!db.tags) {
    return {
      eligible: false,
      reason: `The tags of ${name} could not be read, so its consumers could not be established. Left RUNNING.`,
    };
  }
  for (const [k, v] of Object.entries(db.tags)) {
    if (k.toLowerCase() === 'loom-estate-pause' && String(v).trim().toLowerCase() === 'exempt') {
      return { eligible: false, reason: `${name} is tagged loom-estate-pause=exempt. Left RUNNING.` };
    }
  }
  const consumers = parseConsumersTag(db.tags);
  if (consumers.state === 'unknown') {
    return {
      eligible: false,
      reason:
        `${name} is held out: consumers unknown (no ${CONSUMERS_TAG_KEY} tag), so it cannot be established `
        + 'that no running app depends on it. Left RUNNING.',
    };
  }
  if (consumers.state === 'none') {
    return { eligible: true, reason: `${name} is tagged ${CONSUMERS_TAG_KEY}=none: no running app depends on it.` };
  }
  for (const consumer of consumers.names) {
    const never = neverPauseReason(consumer);
    if (never) {
      return {
        eligible: false,
        pinnedBy: consumer,
        reason: `${name} is pinned by ${consumer}, which is on the never-pause list because ${never} Left RUNNING.`,
      };
    }
    if (consumer.includes('console')) {
      return {
        eligible: false,
        pinnedBy: consumer,
        reason: `${name} is pinned by ${consumer}, which is named like the Loom console and is never paused. Left RUNNING.`,
      };
    }
    if (!view.pausing.has(consumer)) {
      const why = view.heldOut.get(consumer);
      return {
        eligible: false,
        pinnedBy: consumer,
        reason:
          `${name} is pinned by ${consumer}, which is not in this pause set`
          + (why ? ` (${why.replace(/\s*Left RUNNING\.?\s*$/, '')})` : ' (not discovered, opted out, or not tagged for this estate)')
          + ', so stopping the server would break a running app. Left RUNNING.',
      };
    }
  }
  return {
    eligible: true,
    reason: `${name}: every consumer (${consumers.names.join(', ')}) is in this pause set and is stopped first.`,
  };
}

/**
 * ACT-TIME form of {@link dbPauseGuard}. By the time a database is reached its
 * consumers have already been dispatched (consumers pause first), so the check is
 * against what ACTUALLY happened: each consumer must have been `dispatched` or
 * already paused. A consumer that was skipped, failed, or is not yet in
 * `actions` pins the database, because the plan-time verdict is a prediction and
 * this is the evidence.
 */
export function dbActGuard(
  db: { name: string; tags: Readonly<Record<string, string>> | null },
  actions: ReadonlyArray<{ name: string; resourceType: string; status: string }>,
): { eligible: boolean; reason: string; pinnedBy?: string; consumers: string[] } {
  const parsed = parseConsumersTag(db.tags);
  const listed = parsed.state === 'listed' ? parsed.names : [];
  // Treat every named consumer as "in the set": what remains ineligible is then
  // exactly what the TAGS alone decide (unreadable, exempt, unknown, never-pause,
  // console), judged identically to plan time. The evidence loop below does the rest.
  const byTags = dbPauseGuard(db, { pausing: new Set(listed), heldOut: new Map() });
  if (!byTags.eligible || listed.length === 0) return { ...byTags, consumers: listed };
  for (const consumer of listed) {
    const done = actions.find(
      (a) => isConsumerType(a.resourceType) && a.name.trim().toLowerCase() === consumer,
    );
    if (!done || (done.status !== 'dispatched' && done.status !== 'already-paused')) {
      return {
        eligible: false,
        pinnedBy: consumer,
        consumers: listed,
        reason:
          `${db.name} is pinned by ${consumer}: ${done ? `its pause ended as '${done.status}'` : 'it has not been paused in this run'}, `
          + 'so stopping the server now would break a running app. Left RUNNING.',
      };
    }
  }
  return {
    eligible: true,
    consumers: listed,
    reason: `${db.name}: every consumer (${listed.join(', ')}) was stopped in this run.`,
  };
}

/** Tag-only part of the App Gateway guard (the backend-pool read is in ./pause-appgateway-guard). */
export function appGatewayTagGuard(
  gateway: { name: string; tags: Readonly<Record<string, string>> | null },
): { eligible: boolean; reason: string } {
  if (!gateway.tags) {
    return { eligible: false, reason: `The tags of ${gateway.name} could not be read, so an exempt marker could not be ruled out. Left RUNNING.` };
  }
  for (const [k, v] of Object.entries(gateway.tags)) {
    const key = k.toLowerCase();
    const val = String(v).trim().toLowerCase();
    if (key === 'loom-role' && RESUME_SURFACE_TAG_VALUES.includes(val)) {
      return { eligible: false, reason: `${gateway.name} is tagged loom-role=${v}, the resume surface. Left RUNNING.` };
    }
    if (key === 'loom-estate-pause' && val === 'exempt') {
      return { eligible: false, reason: `${gateway.name} is tagged loom-estate-pause=exempt. Left RUNNING.` };
    }
  }
  return { eligible: true, reason: `${gateway.name} carries no exempt marker.` };
}

/** True for the types whose loss can strand the console or an app, and so carry a per-resource guard. */
export function guardedTierType(resourceType: string): boolean {
  const t = String(resourceType ?? '').toLowerCase();
  return (
    t === 'microsoft.app/containerapps'
    || t === 'microsoft.containerservice/managedclusters'
    || t === 'microsoft.network/applicationgateways'
    || isDbTierType(t)
  );
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
  // The gateway's BACKEND-POOL guard needs an ARM read (./pause-appgateway-guard);
  // only its tag half is synchronous. Databases are judged against the whole set
  // by `dbPauseGuard` in `planPause`, not one resource at a time.
  if (t === 'microsoft.network/applicationgateways') return appGatewayTagGuard(resource);
  return { eligible: true, reason: '' };
}
