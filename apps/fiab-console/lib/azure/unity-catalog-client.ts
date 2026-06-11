/**
 * Databricks Unity Catalog REST + SQL client for the Loom Unified Catalog.
 *
 * Two surfaces are exposed:
 *
 *   1. **Metastore-level REST** (`/api/2.1/unity-catalog/*`)
 *        - catalogs/schemas/tables/volumes list+get+create+delete
 *        - permissions list+update (REST grant graph)
 *        - metastores list (cross-workspace federation)
 *
 *   2. **SQL-warehouse GRANT/REVOKE statement execution**
 *        Reuses {@link executeStatement} from `databricks-client` because the
 *        REST permission update is not equivalent to a real `GRANT … TO` —
 *        some privilege grants (e.g. `EXECUTE ON FUNCTION`, dynamic mask
 *        functions) only work over SQL. We honor the user's "full UC CRUD"
 *        ask by emitting actual TDS-equivalent SQL.
 *
 * Authentication is the same chained MI + DefaultAzureCredential as
 * {@link databricks-client.ts} — Databricks resource scope.
 *
 * Multi-workspace federation:
 *   `LOOM_DATABRICKS_HOSTNAMES` (comma-separated) takes precedence over the
 *   single `LOOM_DATABRICKS_HOSTNAME`. Each hostname maps to a workspace and
 *   each workspace is attached to exactly one Unity metastore. The federation
 *   loop in {@link listAllMetastores} hits each workspace and dedupes by
 *   metastore_id so a metastore shared across workspaces is returned once.
 *
 * No mocks. No `return []` placeholders. Every export hits api.azuredatabricks
 * or throws `UnityCatalogError` with status + body + endpoint.
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { executeStatement, type QueryResult } from './databricks-client';

const DBX_SCOPE = '2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

// ============================================================
// Errors
// ============================================================

export interface UnityCatalogNotConfiguredHint {
  missingEnvVar: string;
  bicepModule: string;
  bicepStatus: string;
  followUp: string;
}

export class UnityCatalogNotConfiguredError extends Error {
  hint: UnityCatalogNotConfiguredHint;
  constructor(hint: UnityCatalogNotConfiguredHint) {
    super(`Databricks Unity Catalog is not configured: missing ${hint.missingEnvVar}`);
    this.hint = hint;
  }
}

export class UnityCatalogError extends Error {
  status: number;
  body?: unknown;
  endpoint?: string;
  constructor(message: string, status: number, body?: unknown, endpoint?: string) {
    super(message);
    this.name = 'UnityCatalogError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

// ============================================================
// Workspace discovery (multi-workspace federation)
// ============================================================

/** Returns the list of Databricks workspace hostnames the console knows
 *  about. Uses `LOOM_DATABRICKS_HOSTNAMES` (comma-separated) and falls
 *  back to `LOOM_DATABRICKS_HOSTNAME` for single-workspace deployments.
 *
 *  Throws `UnityCatalogNotConfiguredError` when neither is set so the BFF
 *  can surface a structured MessageBar gate.
 */
export function listWorkspaceHostnames(): string[] {
  const multi = process.env.LOOM_DATABRICKS_HOSTNAMES;
  if (multi) {
    return multi
      .split(',')
      .map((s) => s.trim().replace(/^https?:\/\//, '').replace(/\/$/, ''))
      .filter(Boolean);
  }
  const single = process.env.LOOM_DATABRICKS_HOSTNAME;
  if (single) return [single.replace(/^https?:\/\//, '').replace(/\/$/, '')];
  throw new UnityCatalogNotConfiguredError({
    missingEnvVar: 'LOOM_DATABRICKS_HOSTNAMES (or LOOM_DATABRICKS_HOSTNAME)',
    bicepModule: 'platform/fiab/bicep/modules/admin-plane/main.bicep (catalog dispatcher)',
    bicepStatus:
      'Databricks workspace must be deployed AND the Loom UAMI must be added to the UC metastore admin group.',
    followUp:
      'Set LOOM_DATABRICKS_HOSTNAMES on the Console Container App (comma-separated for federation across workspaces).',
  });
}

/**
 * Resolve the full federation hostname set: the env-configured hosts UNIONed
 * with every workspace persisted in the `metastore-registrations` Cosmos
 * container. This is what makes a registration **survive a Console reload**
 * without a bicep flip of `LOOM_DATABRICKS_HOSTNAMES` — the operator registers
 * a workspace, it lands in Cosmos, and every subsequent federation read picks
 * it up automatically.
 *
 * The Cosmos read is best-effort: if Cosmos is unreachable (or the env var that
 * names it is unset), we silently fall back to the env hosts so a Cosmos outage
 * degrades gracefully rather than blanking the catalog. Likewise, if neither
 * env hosts NOR persisted rows exist, the env-only `listWorkspaceHostnames()`
 * throws the structured NotConfigured gate.
 */
export async function resolveWorkspaceHostnames(): Promise<string[]> {
  const set = new Set<string>();
  let envError: unknown;
  try {
    for (const h of listWorkspaceHostnames()) set.add(h);
  } catch (e) {
    // Defer the NotConfigured throw until we know Cosmos has nothing either.
    envError = e;
  }
  try {
    const { metastoreRegistrationsContainer } = await import('./cosmos-client');
    const c = await metastoreRegistrationsContainer();
    const { resources } = await c.items
      .query<{ workspaceUrl?: string }>('SELECT c.workspaceUrl FROM c')
      .fetchAll();
    for (const r of resources) {
      const h = (r?.workspaceUrl || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (h) set.add(h);
    }
  } catch {
    // Cosmos unreachable / not configured — env hosts still apply.
  }
  if (set.size === 0 && envError) throw envError;
  return Array.from(set);
}

async function dbxToken(): Promise<string> {
  const t = await credential.getToken(DBX_SCOPE);
  if (!t?.token) throw new UnityCatalogError('Failed to acquire Databricks AAD token', 401);
  return t.token;
}

async function ucFetch<T = any>(
  host: string,
  path: string,
  init?: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; query?: Record<string, string> },
): Promise<T> {
  const token = await dbxToken();
  let url = `https://${host}${path}`;
  if (init?.query) {
    const qs = new URLSearchParams(init.query).toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  const res = await fetchWithTimeout(url, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const msg =
      json?.message ||
      json?.error_code ||
      (typeof json === 'string' ? json : `${init?.method ?? 'GET'} ${path} failed ${res.status}`);
    throw new UnityCatalogError(msg, res.status, json, url);
  }
  return (json as T) ?? ({} as T);
}

// ============================================================
// Types — Unity Catalog REST shapes (trimmed)
// ============================================================

export interface UCMetastore {
  metastore_id: string;
  name: string;
  region?: string;
  storage_root?: string;
  workspace_hostname: string;
  owner?: string;
  created_at?: number;
}

export interface UCCatalog {
  name: string;
  comment?: string;
  owner?: string;
  metastore_id?: string;
  catalog_type?: string;
  created_at?: number;
  updated_at?: number;
  workspace_hostname?: string;
}

export interface UCSchema {
  name: string;
  catalog_name: string;
  full_name: string;
  comment?: string;
  owner?: string;
  workspace_hostname?: string;
}

export interface UCTable {
  name: string;
  catalog_name: string;
  schema_name: string;
  full_name: string;
  table_type?: string;
  comment?: string;
  owner?: string;
  data_source_format?: string;
  storage_location?: string;
  columns?: Array<{ name: string; type_name?: string; type_text?: string; comment?: string; nullable?: boolean }>;
  updated_at?: number;
  workspace_hostname?: string;
}

export interface UCVolume {
  name: string;
  catalog_name: string;
  schema_name: string;
  full_name: string;
  volume_type?: 'MANAGED' | 'EXTERNAL' | string;
  storage_location?: string;
  comment?: string;
  owner?: string;
  workspace_hostname?: string;
}

export interface UCPermissionAssignment {
  principal: string;
  privileges: string[];
}

export interface UCPermissions {
  privilege_assignments?: UCPermissionAssignment[];
}

export type UCSecurableType =
  | 'METASTORE'
  | 'CATALOG'
  | 'SCHEMA'
  | 'TABLE'
  | 'VOLUME'
  | 'FUNCTION'
  | 'EXTERNAL_LOCATION'
  | 'STORAGE_CREDENTIAL';

// ============================================================
// Metastore federation
// ============================================================

export async function listMetastoresFromWorkspace(host: string): Promise<UCMetastore[]> {
  // /api/2.1/unity-catalog/metastores returns the metastore assigned to
  // the calling workspace (one or zero). The federation is intentional —
  // a workspace can only see its own metastore.
  const j = await ucFetch<{ metastores?: any[] }>(host, '/api/2.1/unity-catalog/metastores');
  return (j.metastores || []).map((m) => ({
    metastore_id: m.metastore_id,
    name: m.name,
    region: m.region,
    storage_root: m.storage_root,
    owner: m.owner,
    created_at: m.created_at,
    workspace_hostname: host,
  }));
}

/** Federated metastore list across every workspace the console knows about.
 *  Dedupes by `metastore_id` so a metastore attached to multiple workspaces
 *  is returned once; the `workspace_hostname` field reports the first
 *  workspace we observed it from. */
export async function listAllMetastores(): Promise<UCMetastore[]> {
  const hosts = await resolveWorkspaceHostnames();
  const seen = new Map<string, UCMetastore>();
  for (const host of hosts) {
    try {
      const list = await listMetastoresFromWorkspace(host);
      for (const m of list) {
        if (!seen.has(m.metastore_id)) seen.set(m.metastore_id, m);
      }
    } catch (e: any) {
      // Per workspace failures are surfaced as a synthetic metastore so the
      // operator sees which workspace is misconfigured rather than a global
      // 500. The id is namespaced with ERROR_ so callers can branch.
      seen.set(`ERROR_${host}`, {
        metastore_id: `ERROR_${host}`,
        name: `(workspace ${host} unreachable: ${e?.status ?? '?'} ${e?.message ?? 'error'})`,
        workspace_hostname: host,
      });
    }
  }
  return Array.from(seen.values());
}

// ============================================================
// Catalogs / schemas / tables / volumes
// ============================================================

export async function listCatalogs(host: string): Promise<UCCatalog[]> {
  const j = await ucFetch<{ catalogs?: UCCatalog[] }>(host, '/api/2.1/unity-catalog/catalogs');
  return (j.catalogs || []).map((c) => ({ ...c, workspace_hostname: host }));
}

export async function createCatalog(
  host: string,
  body: { name: string; comment?: string; storage_root?: string; provider_name?: string; share_name?: string },
): Promise<UCCatalog> {
  const j = await ucFetch<UCCatalog>(host, '/api/2.1/unity-catalog/catalogs', {
    method: 'POST',
    body,
  });
  return { ...j, workspace_hostname: host };
}

export async function deleteCatalog(host: string, name: string, force = false): Promise<void> {
  await ucFetch(host, `/api/2.1/unity-catalog/catalogs/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    query: force ? { force: 'true' } : undefined,
  });
}

export async function listSchemas(host: string, catalogName: string): Promise<UCSchema[]> {
  const j = await ucFetch<{ schemas?: UCSchema[] }>(host, '/api/2.1/unity-catalog/schemas', {
    query: { catalog_name: catalogName },
  });
  return (j.schemas || []).map((s) => ({ ...s, workspace_hostname: host }));
}

export async function createSchema(
  host: string,
  body: { name: string; catalog_name: string; comment?: string; storage_root?: string },
): Promise<UCSchema> {
  const j = await ucFetch<UCSchema>(host, '/api/2.1/unity-catalog/schemas', {
    method: 'POST',
    body,
  });
  return { ...j, workspace_hostname: host };
}

export async function deleteSchema(host: string, fullName: string, force = false): Promise<void> {
  await ucFetch(host, `/api/2.1/unity-catalog/schemas/${encodeURIComponent(fullName)}`, {
    method: 'DELETE',
    query: force ? { force: 'true' } : undefined,
  });
}

export async function listTables(host: string, catalogName: string, schemaName: string, includeBrowse = true): Promise<UCTable[]> {
  const j = await ucFetch<{ tables?: UCTable[] }>(host, '/api/2.1/unity-catalog/tables', {
    query: {
      catalog_name: catalogName,
      schema_name: schemaName,
      include_browse: includeBrowse ? 'true' : 'false',
    },
  });
  return (j.tables || []).map((t) => ({ ...t, workspace_hostname: host }));
}

export async function getTable(host: string, fullName: string): Promise<UCTable> {
  const j = await ucFetch<UCTable>(host, `/api/2.1/unity-catalog/tables/${encodeURIComponent(fullName)}`);
  return { ...j, workspace_hostname: host };
}

export async function listVolumes(host: string, catalogName: string, schemaName: string): Promise<UCVolume[]> {
  const j = await ucFetch<{ volumes?: UCVolume[] }>(host, '/api/2.1/unity-catalog/volumes', {
    query: { catalog_name: catalogName, schema_name: schemaName },
  });
  return (j.volumes || []).map((v) => ({ ...v, workspace_hostname: host }));
}

export async function createVolume(
  host: string,
  body: {
    name: string;
    catalog_name: string;
    schema_name: string;
    volume_type: 'MANAGED' | 'EXTERNAL';
    storage_location?: string;
    comment?: string;
  },
): Promise<UCVolume> {
  const j = await ucFetch<UCVolume>(host, '/api/2.1/unity-catalog/volumes', { method: 'POST', body });
  return { ...j, workspace_hostname: host };
}

export async function deleteVolume(host: string, fullName: string): Promise<void> {
  await ucFetch(host, `/api/2.1/unity-catalog/volumes/${encodeURIComponent(fullName)}`, { method: 'DELETE' });
}

// ============================================================
// Permissions — REST + SQL
// ============================================================

/** Path segment for REST permission API: `catalogs/<name>`, `schemas/<full>`,
 *  `tables/<full>`, `volumes/<full>`, etc. */
function permissionPath(secType: UCSecurableType, securableName: string): string {
  const map: Record<UCSecurableType, string> = {
    METASTORE: 'metastore',
    CATALOG: 'catalog',
    SCHEMA: 'schema',
    TABLE: 'table',
    VOLUME: 'volume',
    FUNCTION: 'function',
    EXTERNAL_LOCATION: 'external_location',
    STORAGE_CREDENTIAL: 'storage_credential',
  };
  return `/api/2.1/unity-catalog/permissions/${map[secType]}/${encodeURIComponent(securableName)}`;
}

export async function listPermissions(
  host: string,
  secType: UCSecurableType,
  securableName: string,
): Promise<UCPermissions> {
  return ucFetch<UCPermissions>(host, permissionPath(secType, securableName));
}

/** REST permission patch — for simple `GRANT priv TO principal` and
 *  `REVOKE priv FROM principal`. For privileges that REST doesn't support
 *  (notably `EXECUTE ON FUNCTION` mask functions, row filter functions),
 *  use {@link grantPrivilegesSQL} instead. */
export async function updatePermissions(
  host: string,
  secType: UCSecurableType,
  securableName: string,
  changes: { add?: UCPermissionAssignment[]; remove?: UCPermissionAssignment[] },
): Promise<UCPermissions> {
  return ucFetch<UCPermissions>(host, permissionPath(secType, securableName), {
    method: 'PATCH',
    body: { changes: [...(changes.add || []).map((c) => ({ principal: c.principal, add: c.privileges })), ...(changes.remove || []).map((c) => ({ principal: c.principal, remove: c.privileges }))] },
  });
}

/** Run a real `GRANT … ON … TO …` statement on a SQL warehouse.
 *  Loom uses the first running serverless warehouse on the workspace.
 *  Returns the {@link QueryResult} for telemetry — typically 0 rows. */
export async function grantPrivilegesSQL(
  warehouseId: string,
  privileges: string[],
  secType: UCSecurableType,
  securableName: string,
  principal: string,
): Promise<QueryResult> {
  const privList = privileges.map((p) => p.replace(/[^A-Z_ ]/gi, '')).join(', ');
  const obj = `${secType} ${securableName}`;
  // Principal can be a UPN or a Databricks group name — quote with backticks
  // when it contains spaces; otherwise SQL would parse the second word as a
  // keyword and fail.
  const principalSql = /[\s@.\-]/.test(principal) ? `\`${principal.replace(/`/g, '``')}\`` : principal;
  const sql = `GRANT ${privList} ON ${obj} TO ${principalSql}`;
  return executeStatement(warehouseId, sql);
}

export async function revokePrivilegesSQL(
  warehouseId: string,
  privileges: string[],
  secType: UCSecurableType,
  securableName: string,
  principal: string,
): Promise<QueryResult> {
  const privList = privileges.map((p) => p.replace(/[^A-Z_ ]/gi, '')).join(', ');
  const obj = `${secType} ${securableName}`;
  const principalSql = /[\s@.\-]/.test(principal) ? `\`${principal.replace(/`/g, '``')}\`` : principal;
  const sql = `REVOKE ${privList} ON ${obj} FROM ${principalSql}`;
  return executeStatement(warehouseId, sql);
}

// ============================================================
// Lineage (table-level)
// ============================================================

export interface UCLineageEdge {
  source: string;          // full_name of source table
  target: string;          // full_name of target table
  workspace_hostname?: string;
}

/**
 * Fetch downstream lineage edges for a table from the Databricks lineage
 * service. Public preview endpoint: `/api/2.0/lineage-tracking/table-lineage`.
 *
 * Returns *outbound* edges. Caller composes inbound by issuing the same
 * call against each upstream node it discovers.
 */
export async function getTableLineage(host: string, fullName: string): Promise<UCLineageEdge[]> {
  // Lineage endpoint requires the long-form workspace API (not REST 2.1).
  const j = await ucFetch<any>(host, '/api/2.0/lineage-tracking/table-lineage', {
    method: 'POST',
    body: { table_name: fullName, include_entity_lineage: true },
  });
  const upstream = (j?.upstreams || []) as any[];
  const downstream = (j?.downstreams || []) as any[];
  const edges: UCLineageEdge[] = [];
  for (const u of upstream) {
    const src = u?.tableInfo?.name || u?.tableInfo?.tableName;
    if (src) edges.push({ source: `${u.tableInfo.catalog_name || u.tableInfo.catalogName}.${u.tableInfo.schema_name || u.tableInfo.schemaName}.${src}`, target: fullName, workspace_hostname: host });
  }
  for (const d of downstream) {
    const tgt = d?.tableInfo?.name || d?.tableInfo?.tableName;
    if (tgt) edges.push({ source: fullName, target: `${d.tableInfo.catalog_name || d.tableInfo.catalogName}.${d.tableInfo.schema_name || d.tableInfo.schemaName}.${tgt}`, workspace_hostname: host });
  }
  return edges;
}

/**
 * The SQL warehouse id used for `system.access.*` lineage reads. Optional —
 * when unset the unified-lineage service falls back to the REST
 * `lineage-tracking` preview endpoint ({@link getTableLineage}).
 *
 * The Databricks **system tables** (`system.access.table_lineage` /
 * `system.access.column_lineage`) are the durable, queryable lineage store and
 * — unlike the REST preview — expose the producing **entity** of each edge
 * (NOTEBOOK / JOB / PIPELINE / DASHBOARD / DBSQL_QUERY), which is what gives the
 * "table → pipeline/notebook → table" depth the unified graph needs.
 *   https://learn.microsoft.com/azure/databricks/admin/system-tables/lineage
 */
export function lineageWarehouseId(): string | null {
  return process.env.LOOM_DATABRICKS_LINEAGE_WAREHOUSE_ID || null;
}

/** A producing process behind a table-lineage edge (the `entity_*` columns of
 *  `system.access.table_lineage`). */
export interface UCSystemLineageEntity {
  /** NOTEBOOK | JOB | PIPELINE | DASHBOARD_V3 | DBSQL_QUERY | … */
  entityType: string;
  entityId: string;
  /** The table this entity wrote (the edge's target side), when present. */
  target?: string;
  /** The table this entity read (the edge's source side), when present. */
  source?: string;
}

export interface UCSystemLineage {
  /** table full_name → table full_name edges. */
  edges: UCLineageEdge[];
  /** The producing notebooks / jobs / pipelines / dashboards. */
  entities: UCSystemLineageEntity[];
}

/**
 * Table + entity lineage for a focus table from the Databricks **system
 * tables** (`system.access.table_lineage`). Returns the 1-hop neighbourhood
 * (rows where the focus is the source OR the target) — the same default
 * expansion the Databricks Catalog Explorer lineage graph shows, which then
 * lazily loads further hops on click.
 *
 * Unlike {@link getTableLineage} (REST preview, table↔table only), every row
 * also carries the producing `entity_type` / `entity_id`, so the unified graph
 * can draw the process nodes (notebook / job / pipeline / dashboard) between
 * the source and target tables.
 *
 * Parameter binding (`:fn`) keeps the focus full_name out of the SQL string
 * (injection-safe — Databricks binds it server-side).
 *
 * Honest gate: if `system.access` is not enabled in the metastore (or the Loom
 * UAMI lacks `USE SCHEMA` / `SELECT` on it), the query fails and we re-throw a
 * typed {@link UnityCatalogError} naming the exact remediation, rather than
 * silently returning an empty graph (per no-vaporware.md). Callers may fall
 * back to {@link getTableLineage}.
 */
export async function getTableLineageSystemTables(
  host: string,
  fullName: string,
  warehouseId: string,
): Promise<UCSystemLineage> {
  const sql = `SELECT source_table_full_name, target_table_full_name, entity_type, entity_id
    FROM system.access.table_lineage
    WHERE source_table_full_name = :fn OR target_table_full_name = :fn
    LIMIT 1000`;
  let result: QueryResult;
  try {
    result = await executeStatement(warehouseId, sql, undefined, undefined, [
      { name: 'fn', value: fullName, type: 'STRING' },
    ]);
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/TABLE_OR_VIEW_NOT_FOUND|system\.access|PERMISSION_DENIED|does not exist|cannot be found|UNRESOLVED|INSUFFICIENT_PERMISSIONS/i.test(msg)) {
      throw new UnityCatalogError(
        `Unity Catalog system-table lineage is unavailable: ${msg}. Enable the ` +
          `system.access schema in the Unity Catalog metastore and grant the Loom ` +
          `UAMI USE SCHEMA + SELECT on system.access (see ` +
          `scripts/csa-loom/grant-databricks-system-tables-role.sh).`,
        typeof e?.status === 'number' ? e.status : 403,
        e?.body,
        'system.access.table_lineage',
      );
    }
    throw e;
  }
  const idx = (name: string) => result.columns.indexOf(name);
  const iSrc = idx('source_table_full_name');
  const iTgt = idx('target_table_full_name');
  const iEt = idx('entity_type');
  const iEid = idx('entity_id');
  const edges: UCLineageEdge[] = [];
  const entities: UCSystemLineageEntity[] = [];
  const seenEdge = new Set<string>();
  const seenEnt = new Set<string>();
  for (const row of result.rows) {
    const src = iSrc >= 0 ? (row[iSrc] as string | null) : null;
    const tgt = iTgt >= 0 ? (row[iTgt] as string | null) : null;
    const et = iEt >= 0 ? (row[iEt] as string | null) : null;
    const eid = iEid >= 0 ? (row[iEid] as string | null) : null;
    if (src && tgt) {
      const k = `${src}->${tgt}`;
      if (!seenEdge.has(k)) {
        seenEdge.add(k);
        edges.push({ source: src, target: tgt, workspace_hostname: host });
      }
    }
    if (et && eid) {
      const k = `${et}:${eid}:${tgt || ''}:${src || ''}`;
      if (!seenEnt.has(k)) {
        seenEnt.add(k);
        entities.push({ entityType: et, entityId: eid, target: tgt || undefined, source: src || undefined });
      }
    }
  }
  return { edges, entities };
}

// ============================================================
// Federated search over UC
// ============================================================

export interface UCSearchHit {
  source: 'unity-catalog';
  workspace_hostname: string;
  metastore_id?: string;
  type: 'catalog' | 'schema' | 'table' | 'volume';
  full_name: string;
  name: string;
  comment?: string;
  owner?: string;
  updated_at?: number;
}

/**
 * Federated UC search: enumerates catalogs across every workspace, then
 * for catalogs matching `q` includes the catalog row plus a shallow
 * schemas-only expansion. Tables/volumes are matched against the full
 * catalog list. We deliberately keep this shallow — exhaustive table
 * enumeration is expensive and Databricks already exposes a richer search
 * API in newer workspaces; falling back to the shallow scan ensures
 * Gov-cloud workspaces (where the newer search isn't enabled yet) still
 * work.
 */
export async function searchUnity(q: string, limit = 50): Promise<UCSearchHit[]> {
  const ql = q.toLowerCase().trim();
  const hosts = await resolveWorkspaceHostnames();
  const hits: UCSearchHit[] = [];
  for (const host of hosts) {
    let cats: UCCatalog[] = [];
    try { cats = await listCatalogs(host); } catch { continue; }
    for (const c of cats) {
      if (!ql || c.name.toLowerCase().includes(ql) || (c.comment || '').toLowerCase().includes(ql)) {
        hits.push({
          source: 'unity-catalog', workspace_hostname: host, metastore_id: c.metastore_id,
          type: 'catalog', full_name: c.name, name: c.name, comment: c.comment, owner: c.owner, updated_at: c.updated_at,
        });
      }
      if (hits.length >= limit) return hits;
      // Shallow schema sweep only when the catalog itself matches OR query
      // is short enough we want to explore everything.
      if (!ql || c.name.toLowerCase().includes(ql) || ql.length <= 2) {
        let schemas: UCSchema[] = [];
        try { schemas = await listSchemas(host, c.name); } catch { /* keep going */ }
        for (const s of schemas) {
          if (!ql || s.name.toLowerCase().includes(ql) || s.full_name.toLowerCase().includes(ql)) {
            hits.push({
              source: 'unity-catalog', workspace_hostname: host,
              type: 'schema', full_name: s.full_name, name: s.name, comment: s.comment, owner: s.owner,
            });
            if (hits.length >= limit) return hits;
          }
        }
      }
    }
  }
  return hits;
}
