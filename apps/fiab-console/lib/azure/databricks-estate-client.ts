/**
 * Databricks WORKSPACE data-plane client for the estate Pause/Resume feature
 * (#4876). Lists, stops and starts SQL warehouses and all-purpose clusters of ONE
 * workspace, addressed by an EXPLICIT workspace host.
 *
 * ── WHY THIS IS NOT databricks-client.ts / databricks-scale-client.ts ─────────
 * Those clients take their host from `LOOM_DATABRICKS_HOSTNAME`. An estate pause
 * must act on the workspace whose Loom ownership was VERIFIED (the ARM resource,
 * its tag), never on whatever the env names - the exact retargeting defect
 * `pause-actuator.ts` `assertActuationTarget` records. So every function here
 * takes `host` as an argument and nothing in this file reads
 * `LOOM_DATABRICKS_HOSTNAME`.
 *
 * ── CLOUD PARITY ──────────────────────────────────────────────────────────────
 * The host is `properties.workspaceUrl` of the ARM workspace resource, so it is
 * `*.azuredatabricks.net` in Commercial and `*.databricks.azure.us` in Azure
 * Government with no cloud switch here. `assertDatabricksHost` accepts exactly
 * those two suffixes (plus the China cloud's) and refuses anything else, so a
 * tampered or mis-read value cannot point a bearer token at an arbitrary host.
 * The token audience is the Azure Databricks first-party application id
 * (2ff814a6-3304-4ab8-85cb-cd0e6f879c1d), which is the same in every cloud; the
 * sovereign authority comes from the shared credential chain
 * (`loomServerCredential`, driven by AZURE_AUTHORITY_HOST), exactly as every
 * other client in lib/azure does. Gov is supported-in-code and UNEXERCISED here.
 *
 * ── CLUSTER TERMINATE IS NOT DELETE ───────────────────────────────────────────
 * `POST /api/2.0/clusters/delete` TERMINATES a cluster and keeps its
 * configuration (it can be started again); `permanent-delete` is a different
 * endpoint that this file never calls. Only clusters created from the UI or API
 * are managed: job and pipeline clusters are owned by their run and are skipped.
 */

import { loomServerCredential } from './aca-managed-identity';
import { fetchWithTimeout } from './fetch-with-timeout';

/** Azure Databricks first-party application (resource) id - identical in all clouds. */
const DBX_SCOPE = '2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/.default';

/** Workspace host suffixes: Commercial, Azure Government, Azure China. */
const DBX_HOST_SUFFIXES: readonly string[] = [
  '.azuredatabricks.net',
  '.databricks.azure.us',
  '.databricks.azure.cn',
];

/** DNS-label characters only: no scheme, path, port, userinfo or whitespace. */
const HOST_CHARS = /^[a-z0-9.-]+$/;

/**
 * Validate and normalise a workspace host taken from ARM. Throws (it never
 * silently falls back) so the caller reports an unusable workspace instead of
 * sending a bearer token somewhere unexpected.
 */
export function assertDatabricksHost(raw: unknown): string {
  const host = String(raw ?? '').trim().toLowerCase();
  if (!host || !HOST_CHARS.test(host)) {
    throw new Error(`Databricks workspace host '${String(raw ?? '')}' is not a bare DNS host name.`);
  }
  if (!DBX_HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length)) {
    throw new Error(
      `Databricks workspace host '${host}' is not under a known Azure Databricks domain `
        + `(${DBX_HOST_SUFFIXES.join(', ')}); refusing to send a token to it.`,
    );
  }
  return host;
}

export type DbxComputeKind = 'sql-warehouse' | 'cluster';

/** One managed compute resource, normalised across the two APIs. */
export interface DbxCompute {
  kind: DbxComputeKind;
  id: string;
  name: string;
  /** Raw Databricks state, upper-case (RUNNING, STOPPED, TERMINATED, ...). */
  state: string;
  /** Minutes of idleness before Databricks stops it itself; 0/undefined = never. */
  autoStopMins?: number;
}

async function token(): Promise<string> {
  const t = await loomServerCredential.getToken(DBX_SCOPE);
  if (!t?.token) throw new Error('Failed to acquire an Azure Databricks AAD token.');
  return t.token;
}

async function call(host: string, path: string, init?: { method?: string; body?: unknown }): Promise<any> {
  const h = assertDatabricksHost(host);
  const res = await fetchWithTimeout(`https://${h}${path}`, {
    method: init?.method ?? 'GET',
    headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 403
        ? ' The Loom managed identity must be a workspace user with CAN MANAGE on the compute '
          + '(Databricks workspace > Settings > Identity and access).'
        : '';
    throw new Error(`Databricks ${init?.method ?? 'GET'} ${path} failed ${res.status}: ${text.slice(0, 400)}.${hint}`);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Databricks ${path} returned a non-JSON body.`);
  }
}

function toWarehouse(w: any): DbxCompute {
  return {
    kind: 'sql-warehouse',
    id: String(w?.id ?? ''),
    name: String(w?.name ?? w?.id ?? ''),
    state: String(w?.state ?? '').toUpperCase(),
    ...(typeof w?.auto_stop_mins === 'number' ? { autoStopMins: w.auto_stop_mins } : {}),
  };
}

function toCluster(c: any): DbxCompute {
  return {
    kind: 'cluster',
    id: String(c?.cluster_id ?? ''),
    name: String(c?.cluster_name ?? c?.cluster_id ?? ''),
    state: String(c?.state ?? '').toUpperCase(),
    ...(typeof c?.autotermination_minutes === 'number' ? { autoStopMins: c.autotermination_minutes } : {}),
  };
}

/** Cluster sources that a user owns; JOB / PIPELINE / MODELS clusters belong to their run. */
const USER_CLUSTER_SOURCES: readonly string[] = ['UI', 'API'];

export async function listWarehouses(host: string): Promise<DbxCompute[]> {
  const body = await call(host, '/api/2.0/sql/warehouses');
  return (Array.isArray(body?.warehouses) ? body.warehouses : []).map(toWarehouse).filter((w: DbxCompute) => w.id);
}

export async function listUserClusters(host: string): Promise<DbxCompute[]> {
  const body = await call(host, '/api/2.0/clusters/list');
  return (Array.isArray(body?.clusters) ? body.clusters : [])
    .filter((c: any) => USER_CLUSTER_SOURCES.includes(String(c?.cluster_source ?? '').toUpperCase()))
    .map(toCluster)
    .filter((c: DbxCompute) => c.id);
}

export async function getWarehouse(host: string, id: string): Promise<DbxCompute> {
  return toWarehouse(await call(host, `/api/2.0/sql/warehouses/${encodeURIComponent(id)}`));
}

export async function getCluster(host: string, id: string): Promise<DbxCompute> {
  return toCluster(await call(host, `/api/2.0/clusters/get?cluster_id=${encodeURIComponent(id)}`));
}

export async function stopWarehouse(host: string, id: string): Promise<void> {
  await call(host, `/api/2.0/sql/warehouses/${encodeURIComponent(id)}/stop`, { method: 'POST', body: {} });
}

export async function startWarehouse(host: string, id: string): Promise<void> {
  await call(host, `/api/2.0/sql/warehouses/${encodeURIComponent(id)}/start`, { method: 'POST', body: {} });
}

/** TERMINATE (not permanent-delete): the configuration is kept and it can be started again. */
export async function terminateCluster(host: string, id: string): Promise<void> {
  await call(host, '/api/2.0/clusters/delete', { method: 'POST', body: { cluster_id: id } });
}

export async function startCluster(host: string, id: string): Promise<void> {
  await call(host, '/api/2.0/clusters/start', { method: 'POST', body: { cluster_id: id } });
}
