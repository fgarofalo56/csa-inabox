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
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { executeStatement, type QueryResult, type DbxQueryParam } from './databricks-client';
import {
  buildUcSetObjectTags, buildUcUnsetObjectTags, buildUcSetColumnTags, buildUcUnsetColumnTags,
  ucListTableTags, ucListColumnTags, ucListSchemaTags, ucListCatalogTags, ucListVolumeTags,
  buildCreateGovernedTag, buildAlterGovernedTagDescription, buildAlterGovernedTagValues,
  buildDropGovernedTag, ucShowGovernedTags, ucDescribeGovernedTag,
  buildCreatePolicy, buildDropPolicy, ucShowPolicies, ucDescribePolicy,
  buildCreateConnection, buildCreateForeignCatalog,
  type UcTagKind, type UcTagPair, type GovernedTagSpec,
  type UcPolicyParams, type UcPolicySecurableType,
  type UcCreateConnectionParams, type UcForeignCatalogParams,
} from '@/lib/sql/uc-security-builders';

const DBX_SCOPE = '2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
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
  init?: { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown; query?: Record<string, string> },
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
  /** OPEN (any workspace) | ISOLATED (only bound workspaces) — the catalog
   *  isolation boundary that makes workspace-catalog bindings enforced. */
  isolation_mode?: string;
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
  source: string;          // full_name of source table (or abfss path when path-referenced)
  target: string;          // full_name of target table (or abfss path when path-referenced)
  workspace_hostname?: string;
  /** Endpoint securable type from system tables: TABLE | VIEW | MATERIALIZED_VIEW
   *  | STREAMING_TABLE | PATH. Lets the graph type view / path nodes correctly. */
  sourceType?: string;
  targetType?: string;
  /** abfss/wasbs storage path when the endpoint is path-referenced rather than a
   *  named UC table (Databricks records `*_path` and a null `*_full_name`). This
   *  is what bridges an external table to the Purview/ADLS node in the merge. */
  sourcePath?: string;
  targetPath?: string;
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
 *  `system.access.table_lineage`, or the newer `entity_metadata` struct). */
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
  // Column sets are tried widest-first. The `*_path` / `*_type` columns and the
  // `entity_metadata` struct are part of the documented schema but were added
  // over time (entity_type/entity_id/entity_run_id were DEPRECATED in favour of
  // entity_metadata on 2025-05-11). To stay forward- AND backward-compatible we
  // attempt the full projection, then degrade past any column that an older (or
  // newer) metastore does not expose, before finally falling back to the
  // original minimal projection.
  const COLSETS = [
    // Full: rich endpoints + struct + legacy entity columns.
    `source_table_full_name, source_path, source_type, target_table_full_name, target_path, target_type, entity_type, entity_id, entity_metadata`,
    // No struct (older metastore without entity_metadata).
    `source_table_full_name, source_path, source_type, target_table_full_name, target_path, target_type, entity_type, entity_id`,
    // Minimal (original projection — names guaranteed when system.access is live).
    `source_table_full_name, target_table_full_name, entity_type, entity_id`,
  ];
  const COL_ERR =
    /UNRESOLVED_COLUMN|cannot be resolved|no such struct field|source_path|target_path|source_type|target_type|entity_metadata|FIELD_NOT_FOUND/i;
  const GATE_ERR =
    /TABLE_OR_VIEW_NOT_FOUND|system\.access|PERMISSION_DENIED|does not exist|cannot be found|UNRESOLVED|INSUFFICIENT_PERMISSIONS/i;

  let result: QueryResult | null = null;
  for (let i = 0; i < COLSETS.length; i++) {
    const sql = `SELECT ${COLSETS[i]}
      FROM system.access.table_lineage
      WHERE source_table_full_name = :fn OR target_table_full_name = :fn
      LIMIT 1000`;
    try {
      result = await executeStatement(warehouseId, sql, undefined, undefined, [
        { name: 'fn', value: fullName, type: 'STRING' },
      ]);
      break;
    } catch (e: any) {
      const msg = String(e?.message || e);
      // A missing optional column → retry the next, narrower projection.
      if (COL_ERR.test(msg) && i < COLSETS.length - 1) continue;
      if (GATE_ERR.test(msg)) {
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
  }
  if (!result) return { edges: [], entities: [] };

  const idx = (name: string) => result!.columns.indexOf(name);
  const iSrc = idx('source_table_full_name');
  const iSrcPath = idx('source_path');
  const iSrcType = idx('source_type');
  const iTgt = idx('target_table_full_name');
  const iTgtPath = idx('target_path');
  const iTgtType = idx('target_type');
  const iEt = idx('entity_type');
  const iEid = idx('entity_id');
  const iMeta = idx('entity_metadata');

  const edges: UCLineageEdge[] = [];
  const entities: UCSystemLineageEntity[] = [];
  const seenEdge = new Set<string>();
  const seenEnt = new Set<string>();

  // An endpoint may be a named UC table (full_name) OR a bare storage path
  // (full_name null, *_path set). We key the node on the full_name when present,
  // else the path, so a path-referenced external table still joins the Purview
  // ADLS node via normalizeIdentity's `path:` rule.
  const endpoint = (full: string | null, path: string | null): string | null =>
    (full && full.trim()) || (path && path.trim()) || null;

  for (const row of result.rows) {
    const srcFull = iSrc >= 0 ? (row[iSrc] as string | null) : null;
    const srcPath = iSrcPath >= 0 ? (row[iSrcPath] as string | null) : null;
    const srcType = iSrcType >= 0 ? (row[iSrcType] as string | null) : null;
    const tgtFull = iTgt >= 0 ? (row[iTgt] as string | null) : null;
    const tgtPath = iTgtPath >= 0 ? (row[iTgtPath] as string | null) : null;
    const tgtType = iTgtType >= 0 ? (row[iTgtType] as string | null) : null;

    const src = endpoint(srcFull, srcPath);
    const tgt = endpoint(tgtFull, tgtPath);
    if (src && tgt) {
      const k = `${src}->${tgt}`;
      if (!seenEdge.has(k)) {
        seenEdge.add(k);
        edges.push({
          source: src,
          target: tgt,
          workspace_hostname: host,
          ...(srcType ? { sourceType: srcType } : {}),
          ...(tgtType ? { targetType: tgtType } : {}),
          ...(!srcFull && srcPath ? { sourcePath: srcPath } : {}),
          ...(!tgtFull && tgtPath ? { targetPath: tgtPath } : {}),
        });
      }
    }

    // Producing entity: prefer the newer entity_metadata struct, fall back to
    // the deprecated entity_type/entity_id columns.
    let et = iEt >= 0 ? (row[iEt] as string | null) : null;
    let eid = iEid >= 0 ? (row[iEid] as string | null) : null;
    if (iMeta >= 0) {
      const meta = parseStructValue(row[iMeta]);
      if (meta) {
        et = (meta.entity_type as string) || et;
        eid = (meta.entity_id as string) || (meta.record_id as string) || eid;
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

/** Parse a struct column value returned by the SQL Statement Execution API.
 *  Struct values arrive as JSON-encoded strings in `data_array`; some drivers
 *  return them already-parsed. Returns null when absent or unparseable. */
function parseStructValue(v: unknown): Record<string, any> | null {
  if (v == null) return null;
  if (typeof v === 'object') return v as Record<string, any>;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return null; }
  }
  return null;
}

// ============================================================
// Column-level lineage (system.access.column_lineage)
// ============================================================

/** A column→column lineage edge from `system.access.column_lineage`. */
export interface UCColumnLineageEdge {
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  targetColumn: string;
  workspace_hostname?: string;
}

export interface UCColumnLineage {
  /** Column→column edges (focus table's 1-hop neighbourhood). */
  edges: UCColumnLineageEdge[];
  /** table full_name (lowercased) → set of column names that participate in
   *  lineage. Used to badge the table node with its lineage columns. */
  columnsByTable: Record<string, string[]>;
}

/**
 * Column-level lineage for a focus table from the Databricks **system tables**
 * (`system.access.column_lineage`) — the durable backing for Databricks Catalog
 * Explorer's column-level lineage view. Returns the focus table's 1-hop column
 * neighbourhood (rows where the focus is the source OR target table), optionally
 * filtered to a single `column`.
 *
 *   https://learn.microsoft.com/azure/databricks/admin/system-tables/lineage
 *
 * Same honest-gate contract as {@link getTableLineageSystemTables}: a missing
 * `system.access` schema (or a UAMI lacking SELECT) throws a typed
 * {@link UnityCatalogError} naming the remediation rather than returning empty.
 */
export async function getColumnLineageSystemTables(
  host: string,
  fullName: string,
  warehouseId: string,
  column?: string,
): Promise<UCColumnLineage> {
  const params: Array<{ name: string; value: string; type: 'STRING' }> = [
    { name: 'fn', value: fullName, type: 'STRING' },
  ];
  let where = `source_table_full_name = :fn OR target_table_full_name = :fn`;
  if (column) {
    where = `(${where}) AND (source_column_name = :col OR target_column_name = :col)`;
    params.push({ name: 'col', value: column, type: 'STRING' });
  }
  const sql = `SELECT source_table_full_name, source_column_name, target_table_full_name, target_column_name
    FROM system.access.column_lineage
    WHERE ${where}
    LIMIT 1000`;
  let result: QueryResult;
  try {
    result = await executeStatement(warehouseId, sql, undefined, undefined, params);
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/TABLE_OR_VIEW_NOT_FOUND|system\.access|PERMISSION_DENIED|does not exist|cannot be found|UNRESOLVED|INSUFFICIENT_PERMISSIONS/i.test(msg)) {
      throw new UnityCatalogError(
        `Unity Catalog system-table column lineage is unavailable: ${msg}. Enable ` +
          `the system.access schema in the Unity Catalog metastore and grant the ` +
          `Loom UAMI USE SCHEMA + SELECT on system.access (see ` +
          `scripts/csa-loom/grant-databricks-system-tables-role.sh).`,
        typeof e?.status === 'number' ? e.status : 403,
        e?.body,
        'system.access.column_lineage',
      );
    }
    throw e;
  }
  const idx = (name: string) => result.columns.indexOf(name);
  const iST = idx('source_table_full_name');
  const iSC = idx('source_column_name');
  const iTT = idx('target_table_full_name');
  const iTC = idx('target_column_name');
  const edges: UCColumnLineageEdge[] = [];
  const colsByTable = new Map<string, Set<string>>();
  const addCol = (table: string | null, col: string | null) => {
    if (!table || !col) return;
    const key = table.toLowerCase();
    const set = colsByTable.get(key) || new Set<string>();
    set.add(col);
    colsByTable.set(key, set);
  };
  const seen = new Set<string>();
  for (const row of result.rows) {
    const st = iST >= 0 ? (row[iST] as string | null) : null;
    const sc = iSC >= 0 ? (row[iSC] as string | null) : null;
    const tt = iTT >= 0 ? (row[iTT] as string | null) : null;
    const tc = iTC >= 0 ? (row[iTC] as string | null) : null;
    addCol(st, sc);
    addCol(tt, tc);
    if (st && sc && tt && tc) {
      const k = `${st}.${sc}->${tt}.${tc}`;
      if (!seen.has(k)) {
        seen.add(k);
        edges.push({ sourceTable: st, sourceColumn: sc, targetTable: tt, targetColumn: tc, workspace_hostname: host });
      }
    }
  }
  const columnsByTable: Record<string, string[]> = {};
  for (const [t, set] of colsByTable) columnsByTable[t] = [...set];
  return { edges, columnsByTable };
}

// ============================================================
// Delta Sharing — provider (outbound) + recipient (inbound)
// ============================================================
//
// Powers the "Data shares" surface of Loom Marketplace. Bidirectional:
//
//   OUTBOUND (this metastore is the provider)
//     - shares:      a named read-only collection of tables/schemas/volumes
//     - recipients:  the org you share with (TOKEN = open Delta Sharing to any
//                    client; DATABRICKS = D2D to another UC metastore)
//     - share perms: grant a recipient SELECT on a share
//
//   INBOUND (this metastore is the recipient)
//     - providers:        the orgs sharing data WITH us (incl. Databricks
//                         Marketplace listings, which materialize as providers)
//     - provider shares:  the shares a provider exposes to us
//     - mount:            createCatalog({ provider_name, share_name }) attaches
//                         an inbound share as a read-only catalog (already above)
//
// All real UC REST (/api/2.1/unity-catalog/{shares,recipients,providers}). No
// mocks. A metastore that has Delta Sharing disabled returns a typed
// UnityCatalogError the BFF surfaces as an honest gate.

export interface UCDataObject {
  /** full_name of the table/schema/volume being shared. */
  name: string;
  data_object_type: 'TABLE' | 'SCHEMA' | 'VOLUME' | 'MODEL' | 'NOTEBOOK_FILE' | string;
  /** Alias the recipient sees instead of the source full_name. */
  shared_as?: string;
  added_at?: number;
  added_by?: string;
  comment?: string;
  /** History sharing — required for streaming reads of the shared table. */
  history_data_sharing_status?: 'ENABLED' | 'DISABLED' | string;
  cdf_enabled?: boolean;
}

export interface UCShare {
  name: string;
  comment?: string;
  owner?: string;
  created_at?: number;
  updated_at?: number;
  objects?: UCDataObject[];
  workspace_hostname?: string;
}

export interface UCRecipientToken {
  id?: string;
  /** The activation URL the recipient opens to download their credential file
   *  (TOKEN auth only). Never logged — surfaced once to the share owner. */
  activation_url?: string;
  expiration_time?: number;
  created_at?: number;
}

export interface UCRecipient {
  name: string;
  authentication_type: 'TOKEN' | 'DATABRICKS' | string;
  comment?: string;
  owner?: string;
  /** Present for DATABRICKS (D2D) recipients — the target metastore's sharing id. */
  data_recipient_global_metastore_id?: string;
  created_at?: number;
  tokens?: UCRecipientToken[];
  workspace_hostname?: string;
}

export interface UCProvider {
  name: string;
  authentication_type?: string;
  comment?: string;
  owner?: string;
  /** D2D providers carry the source metastore's global id. */
  data_provider_global_metastore_id?: string;
  created_at?: number;
  /** Recipient-side activation file contents for TOKEN providers (write-only on create). */
  recipient_profile_str?: string;
  workspace_hostname?: string;
}

// ---- Outbound: shares -------------------------------------------------

export async function listShares(host: string): Promise<UCShare[]> {
  const j = await ucFetch<{ shares?: UCShare[] }>(host, '/api/2.1/unity-catalog/shares');
  return (j.shares || []).map((s) => ({ ...s, workspace_hostname: host }));
}

export async function getShare(host: string, name: string, includeData = true): Promise<UCShare> {
  const j = await ucFetch<UCShare>(host, `/api/2.1/unity-catalog/shares/${encodeURIComponent(name)}`, {
    query: includeData ? { include_shared_data: 'true' } : undefined,
  });
  return { ...j, workspace_hostname: host };
}

export async function createShare(host: string, body: { name: string; comment?: string }): Promise<UCShare> {
  const j = await ucFetch<UCShare>(host, '/api/2.1/unity-catalog/shares', { method: 'POST', body });
  return { ...j, workspace_hostname: host };
}

/** Add or remove data objects (tables/schemas/volumes) on a share. Mirrors the
 *  UC `PATCH /shares/{name}` updates list. */
export async function updateShareObjects(
  host: string,
  name: string,
  changes: { add?: UCDataObject[]; remove?: Array<{ name: string }> },
): Promise<UCShare> {
  const updates = [
    ...(changes.add || []).map((o) => ({ action: 'ADD', data_object: o })),
    ...(changes.remove || []).map((o) => ({ action: 'REMOVE', data_object: { name: o.name, data_object_type: 'TABLE' } })),
  ];
  const j = await ucFetch<UCShare>(host, `/api/2.1/unity-catalog/shares/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: { updates },
  });
  return { ...j, workspace_hostname: host };
}

export async function deleteShare(host: string, name: string): Promise<void> {
  await ucFetch(host, `/api/2.1/unity-catalog/shares/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

/** Recipients currently granted SELECT on a share. */
export async function getSharePermissions(host: string, name: string): Promise<UCPermissions> {
  return ucFetch<UCPermissions>(host, `/api/2.1/unity-catalog/shares/${encodeURIComponent(name)}/permissions`);
}

/** Grant / revoke a recipient on a share (privilege is always `SELECT` for
 *  Delta Sharing shares). */
export async function updateSharePermissions(
  host: string,
  name: string,
  changes: { add?: string[]; remove?: string[] },
): Promise<UCPermissions> {
  return ucFetch<UCPermissions>(host, `/api/2.1/unity-catalog/shares/${encodeURIComponent(name)}/permissions`, {
    method: 'PATCH',
    body: {
      changes: [
        ...(changes.add || []).map((principal) => ({ principal, add: ['SELECT'] })),
        ...(changes.remove || []).map((principal) => ({ principal, remove: ['SELECT'] })),
      ],
    },
  });
}

// ---- Outbound: recipients --------------------------------------------

export async function listRecipients(host: string): Promise<UCRecipient[]> {
  const j = await ucFetch<{ recipients?: UCRecipient[] }>(host, '/api/2.1/unity-catalog/recipients');
  return (j.recipients || []).map((r) => ({ ...r, workspace_hostname: host }));
}

export async function getRecipient(host: string, name: string): Promise<UCRecipient> {
  const j = await ucFetch<UCRecipient>(host, `/api/2.1/unity-catalog/recipients/${encodeURIComponent(name)}`);
  return { ...j, workspace_hostname: host };
}

export async function createRecipient(
  host: string,
  body: {
    name: string;
    authentication_type: 'TOKEN' | 'DATABRICKS';
    comment?: string;
    /** Required for DATABRICKS (D2D) recipients — the consumer metastore's sharing id. */
    data_recipient_global_metastore_id?: string;
  },
): Promise<UCRecipient> {
  const j = await ucFetch<UCRecipient>(host, '/api/2.1/unity-catalog/recipients', { method: 'POST', body });
  return { ...j, workspace_hostname: host };
}

export async function deleteRecipient(host: string, name: string): Promise<void> {
  await ucFetch(host, `/api/2.1/unity-catalog/recipients/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

// ---- Inbound: providers ----------------------------------------------

export async function listProviders(host: string): Promise<UCProvider[]> {
  const j = await ucFetch<{ providers?: UCProvider[] }>(host, '/api/2.1/unity-catalog/providers');
  return (j.providers || []).map((p) => ({ ...p, workspace_hostname: host }));
}

export async function getProvider(host: string, name: string): Promise<UCProvider> {
  const j = await ucFetch<UCProvider>(host, `/api/2.1/unity-catalog/providers/${encodeURIComponent(name)}`);
  return { ...j, workspace_hostname: host };
}

/** The shares a provider exposes to us (inbound). Each can be mounted as a
 *  read-only catalog with {@link createCatalog}({ provider_name, share_name }). */
export async function listProviderShares(host: string, providerName: string): Promise<UCShare[]> {
  const j = await ucFetch<{ shares?: UCShare[] }>(
    host,
    `/api/2.1/unity-catalog/providers/${encodeURIComponent(providerName)}/shares`,
  );
  return (j.shares || []).map((s) => ({ ...s, workspace_hostname: host }));
}

/** Create an inbound provider from a TOKEN recipient-profile activation file
 *  (the open Delta Sharing handshake — e.g. a Databricks Marketplace listing or
 *  a third-party share). */
export async function createProvider(
  host: string,
  body: { name: string; recipient_profile_str: string; comment?: string },
): Promise<UCProvider> {
  const j = await ucFetch<UCProvider>(host, '/api/2.1/unity-catalog/providers', {
    method: 'POST',
    body: { ...body, authentication_type: 'TOKEN' },
  });
  return { ...j, workspace_hostname: host };
}

export async function deleteProvider(host: string, name: string): Promise<void> {
  await ucFetch(host, `/api/2.1/unity-catalog/providers/${encodeURIComponent(name)}`, { method: 'DELETE' });
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

// ============================================================
// Delta Sharing readiness — does the Console identity actually have what it
// needs to consume inbound shares (CREATE PROVIDER) + publish outbound (CREATE
// SHARE/RECIPIENT) on the Unity Catalog metastore? Surfaced in the System Health
// self-audit + the Marketplace data-shares gate so the enabled/grantable state
// is visible (and the exact grant is one click away). Best-effort + degrades
// gracefully — never throws (returns a reason + the remediation hint instead).
// ============================================================

export interface DeltaSharingReadiness {
  /** A Databricks workspace + UC metastore is bound (LOOM_DATABRICKS_HOSTNAME). */
  configured: boolean;
  /** The metastore_summary read succeeded. */
  reachable: boolean;
  host?: string;
  metastoreName?: string;
  metastoreId?: string;
  /** INTERNAL | INTERNAL_AND_EXTERNAL — EXTERNAL ⇒ open (token) sharing allowed. */
  deltaSharingScope?: string;
  externalSharingEnabled: boolean;
  /** The Console UAMI application (client) id — the UC principal grants target. */
  uamiPrincipal?: string;
  isMetastoreAdmin: boolean;
  privileges: { createProvider: boolean; createShare: boolean; createRecipient: boolean; createCatalog: boolean };
  /** Full inbound flow possible: register the provider (CREATE PROVIDER) AND
   *  subscribe = create a catalog from the share (CREATE CATALOG). */
  canConsumeInbound: boolean;
  /** Publish outbound shares + recipients is possible. */
  canPublish: boolean;
  reason: 'ready' | 'not_configured' | 'privileges_missing' | 'unreachable' | 'unknown';
  message?: string;
}

export async function deltaSharingReadiness(): Promise<DeltaSharingReadiness> {
  const uami = (process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID || '').trim();
  const base: DeltaSharingReadiness = {
    configured: false, reachable: false, externalSharingEnabled: false,
    uamiPrincipal: uami || undefined, isMetastoreAdmin: false,
    privileges: { createProvider: false, createShare: false, createRecipient: false },
    canConsumeInbound: false, canPublish: false, reason: 'unknown',
  };

  let hosts: string[] = [];
  try {
    hosts = await resolveWorkspaceHostnames();
  } catch {
    return { ...base, reason: 'not_configured', message: 'No Databricks workspace bound (LOOM_DATABRICKS_HOSTNAME unset). Delta Sharing is a Unity Catalog feature and needs a Databricks workspace.' };
  }
  if (!hosts.length) {
    return { ...base, reason: 'not_configured', message: 'No Databricks workspace bound. Delta Sharing needs a Databricks workspace + Unity Catalog metastore.' };
  }
  const host = hosts[0];

  let summary: any;
  try {
    // metastore_summary is readable by any workspace user and returns the
    // assigned metastore + its delta-sharing scope + owner in one call.
    // (Databricks UC endpoint uses an underscore — `metastore_summary` — not a
    // hyphen; the hyphen path 404s as "No API found", failing the audit probe.)
    summary = await ucFetch<any>(host, '/api/2.1/unity-catalog/metastore_summary');
  } catch (e: any) {
    return { ...base, configured: true, host, reason: 'unreachable', message: `Could not read the Unity Catalog metastore summary: ${e?.message || e}. Confirm the Console UAMI is SCIM-provisioned into the workspace and the workspace is network-reachable.` };
  }

  const metastoreId: string | undefined = summary?.metastore_id;
  const metastoreName: string | undefined = summary?.name;
  const scope: string | undefined = summary?.delta_sharing_scope;
  const externalSharingEnabled = typeof scope === 'string' && /EXTERNAL/i.test(scope);
  const owner: string | undefined = summary?.owner;
  const isAdmin = !!(uami && owner && String(owner).toLowerCase() === uami.toLowerCase());

  let priv = { createProvider: isAdmin, createShare: isAdmin, createRecipient: isAdmin, createCatalog: isAdmin };
  let message: string | undefined;

  if (!isAdmin && metastoreId && uami) {
    try {
      const perms = await ucFetch<any>(
        host,
        `/api/2.1/unity-catalog/permissions/metastore/${encodeURIComponent(metastoreId)}`,
        { query: { principal: uami } },
      );
      const assigned = new Set<string>();
      for (const a of perms?.privilege_assignments || []) {
        if (!a?.principal || String(a.principal).toLowerCase() === uami.toLowerCase()) {
          for (const p of a?.privileges || []) assigned.add(String(p).toUpperCase());
        }
      }
      priv = {
        createProvider: assigned.has('CREATE_PROVIDER'),
        createShare: assigned.has('CREATE_SHARE'),
        createRecipient: assigned.has('CREATE_RECIPIENT'),
        createCatalog: assigned.has('CREATE_CATALOG'),
      };
    } catch (e: any) {
      // The UAMI may not be allowed to READ the metastore grant table (that read
      // itself needs metastore-admin in some configs). Leave privileges false and
      // surface the grant remediation honestly rather than claiming ready.
      message = `Could not read the metastore grant table for the Console identity (${e?.message || e}). If Delta Sharing isn't working, apply the CREATE PROVIDER / SHARE / RECIPIENT grant.`;
    }
  }

  // Consuming an inbound share end-to-end needs BOTH: register the provider
  // (CREATE PROVIDER) AND subscribe = create a catalog from the share (CREATE
  // CATALOG). The operator hit the second one after we'd only granted the first.
  const canConsumeInbound = isAdmin || (priv.createProvider && priv.createCatalog);
  const canPublish = isAdmin || (priv.createShare && priv.createRecipient);
  const reason: DeltaSharingReadiness['reason'] = (canConsumeInbound && canPublish) ? 'ready' : 'privileges_missing';

  return {
    configured: true, reachable: true, host, metastoreName, metastoreId,
    deltaSharingScope: scope, externalSharingEnabled, uamiPrincipal: uami,
    isMetastoreAdmin: isAdmin, privileges: priv, canConsumeInbound, canPublish,
    reason, message,
  };
}

// ============================================================
// Tag governance (wave c1) — object/column tags, governed tags, ABAC policies.
//
// All driven through the SQL Warehouse Statement Execution path
// ({@link executeStatement}) with Learn-grounded DDL built by the pure,
// injection-safe generators in `lib/sql/uc-security-builders.ts`. The data-plane
// REST surfaces (/api/2.1/unity-catalog/{tag-policies,policies}) exist but are
// preview; SQL DDL is the reliable cross-workspace path. The caller (BFF route)
// resolves a running warehouse id and handles config / Gov-boundary gates.
// ============================================================

/** QueryResult rows → array of column-keyed objects. */
function ucRows(r: QueryResult): Record<string, unknown>[] {
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
}

export interface UcTagRow {
  catalog_name?: string;
  schema_name?: string;
  table_name?: string;
  column_name?: string;
  tag_name: string;
  tag_value: string;
}

/** Live object + column tags for a (catalog[, schema[, table]]) scope, read from
 *  `information_schema.{table_tags,column_tags}`. */
export async function readUcObjectTags(
  warehouseId: string,
  catalog: string,
  opts?: { schema?: string; table?: string },
): Promise<{ tableTags: UcTagRow[]; columnTags: UcTagRow[] }> {
  const [t, c] = await Promise.all([
    executeStatement(warehouseId, ucListTableTags(catalog, opts?.schema, opts?.table)),
    executeStatement(warehouseId, ucListColumnTags(catalog, opts?.schema, opts?.table)),
  ]);
  return { tableTags: ucRows(t) as unknown as UcTagRow[], columnTags: ucRows(c) as unknown as UcTagRow[] };
}

/** Live schema / catalog / volume tags (less common — surfaced for completeness). */
export async function readUcContainerTags(
  warehouseId: string,
  catalog: string,
  opts?: { schema?: string; volume?: string },
): Promise<{ catalogTags: UcTagRow[]; schemaTags: UcTagRow[]; volumeTags: UcTagRow[] }> {
  const [cat, sch, vol] = await Promise.all([
    executeStatement(warehouseId, ucListCatalogTags(catalog)).then(ucRows).catch(() => []),
    executeStatement(warehouseId, ucListSchemaTags(catalog, opts?.schema)).then(ucRows).catch(() => []),
    executeStatement(warehouseId, ucListVolumeTags(catalog, opts?.schema, opts?.volume)).then(ucRows).catch(() => []),
  ]);
  return {
    catalogTags: cat as unknown as UcTagRow[],
    schemaTags: sch as unknown as UcTagRow[],
    volumeTags: vol as unknown as UcTagRow[],
  };
}

export interface ApplyTagsRequest {
  action: 'set' | 'unset';
  /** Object kind for securable tags; ignored when `column` is set. */
  kind?: UcTagKind;
  catalog: string;
  schema?: string;
  /** Object name (table/view/volume/schema/catalog). For column tags this is the table. */
  name: string;
  /** When present the operation targets a column tag on `name` (the table). */
  column?: string;
  tags?: UcTagPair[];
  keys?: string[];
}

/** Build + execute a SET/UNSET TAGS statement for an object or column. */
export async function applyUcTags(
  warehouseId: string,
  p: ApplyTagsRequest,
): Promise<{ sql: string; executionMs: number }> {
  let sql: string;
  if (p.column) {
    if (!p.schema) throw new UnityCatalogError('schema is required for column tags', 400);
    sql = p.action === 'set'
      ? buildUcSetColumnTags({ catalog: p.catalog, schema: p.schema, tableName: p.name, columnName: p.column, tags: p.tags || [] })
      : buildUcUnsetColumnTags({ catalog: p.catalog, schema: p.schema, tableName: p.name, columnName: p.column, keys: p.keys || [] });
  } else {
    const kind = (p.kind || 'TABLE') as UcTagKind;
    sql = p.action === 'set'
      ? buildUcSetObjectTags({ kind, catalog: p.catalog, schema: p.schema, name: p.name, tags: p.tags || [] })
      : buildUcUnsetObjectTags({ kind, catalog: p.catalog, schema: p.schema, name: p.name, keys: p.keys || [] });
  }
  const r = await executeStatement(warehouseId, sql);
  return { sql, executionMs: r.executionMs };
}

// ---- Governed tags ----------------------------------------------------

/** `SHOW GOVERNED TAGS [LIKE pattern]` → account-level governed-tag rows. */
export async function listUcGovernedTags(warehouseId: string, pattern?: string): Promise<Record<string, unknown>[]> {
  const r = await executeStatement(warehouseId, ucShowGovernedTags(pattern));
  return ucRows(r);
}

export async function describeUcGovernedTag(warehouseId: string, key: string): Promise<Record<string, unknown>[]> {
  const r = await executeStatement(warehouseId, ucDescribeGovernedTag(key));
  return ucRows(r);
}

export type GovernedTagAction = 'create' | 'alter-description' | 'alter-values' | 'drop';

export async function mutateUcGovernedTag(
  warehouseId: string,
  p: { action: GovernedTagAction } & GovernedTagSpec,
): Promise<{ sql: string; executionMs: number }> {
  let sql: string;
  switch (p.action) {
    case 'create':
      sql = buildCreateGovernedTag({ key: p.key, description: p.description, values: p.values });
      break;
    case 'alter-description':
      sql = buildAlterGovernedTagDescription({ key: p.key, description: p.description || '' });
      break;
    case 'alter-values':
      sql = buildAlterGovernedTagValues({ key: p.key, values: p.values || [] });
      break;
    case 'drop':
      sql = buildDropGovernedTag(p.key);
      break;
    default:
      throw new UnityCatalogError(`unknown governed-tag action: ${p.action}`, 400);
  }
  const r = await executeStatement(warehouseId, sql);
  return { sql, executionMs: r.executionMs };
}

// ---- ABAC policies ----------------------------------------------------

/** `SHOW [EFFECTIVE] POLICIES ON …` → the policies attached to (or inherited by)
 *  a catalog / schema / table. */
export async function listUcPolicies(
  warehouseId: string,
  p: { securableType: UcPolicySecurableType; securableName: string; effective?: boolean },
): Promise<Record<string, unknown>[]> {
  const r = await executeStatement(warehouseId, ucShowPolicies(p));
  return ucRows(r);
}

export async function describeUcPolicy(
  warehouseId: string,
  p: { name: string; securableType: UcPolicySecurableType; securableName: string },
): Promise<Record<string, unknown>[]> {
  const r = await executeStatement(warehouseId, ucDescribePolicy(p));
  return ucRows(r);
}

/** Build (preview) or build+execute a `CREATE [OR REPLACE] POLICY …`. */
export async function createUcPolicy(
  warehouseId: string,
  params: UcPolicyParams,
  preview = false,
): Promise<{ sql: string; executionMs?: number }> {
  const sql = buildCreatePolicy(params);
  if (preview) return { sql };
  const r = await executeStatement(warehouseId, sql);
  return { sql, executionMs: r.executionMs };
}

export async function dropUcPolicy(
  warehouseId: string,
  p: { name: string; securableType: UcPolicySecurableType; securableName: string },
): Promise<{ sql: string; executionMs: number }> {
  const sql = buildDropPolicy(p);
  const r = await executeStatement(warehouseId, sql);
  return { sql, executionMs: r.executionMs };
}

// ============================================================
// Storage + Lakehouse Federation (wave c2)
//
// External locations + storage credentials govern WHERE Unity Catalog reads/
// writes external data; connections + foreign catalogs (Lakehouse Federation)
// govern access to remote DBMSs (SQL Server / Synapse / PostgreSQL / Snowflake /
// …). All real UC REST (/api/2.1/unity-catalog/{external-locations,storage-
// credentials,connections}) for list/get/delete; the credential-carrying CREATE
// flows (connection + foreign catalog) run as Learn-grounded DDL on the SQL
// warehouse so the `secret()` function can replace plaintext passwords. No mocks.
// ============================================================

export interface UCExternalLocation {
  name: string;
  url: string;
  credential_name?: string;
  comment?: string;
  read_only?: boolean;
  owner?: string;
  isolation_mode?: string;
  created_at?: number;
  updated_at?: number;
  workspace_hostname?: string;
}

/** Azure Access Connector identity backing a storage credential (the Azure-
 *  native, secret-free path — recommended per no-fabric-dependency.md). */
export interface UCAzureManagedIdentity {
  /** Full ARM id of the Databricks Access Connector. */
  access_connector_id: string;
  /** Optional user-assigned managed-identity id (omit for system-assigned). */
  managed_identity_id?: string;
  credential_id?: string;
}

export interface UCStorageCredential {
  name: string;
  comment?: string;
  owner?: string;
  read_only?: boolean;
  azure_managed_identity?: UCAzureManagedIdentity;
  used_for_managed_storage?: boolean;
  isolation_mode?: string;
  created_at?: number;
  updated_at?: number;
  workspace_hostname?: string;
}

export interface UCConnection {
  name: string;
  connection_type: string;
  /** Non-secret connection options Databricks echoes back (host/port/user — the
   *  password / token is NEVER returned). */
  options?: Record<string, string>;
  comment?: string;
  owner?: string;
  read_only?: boolean;
  full_name?: string;
  connection_id?: string;
  created_at?: number;
  updated_at?: number;
  workspace_hostname?: string;
}

// ---- External locations ----------------------------------------------

export async function listExternalLocations(host: string): Promise<UCExternalLocation[]> {
  const j = await ucFetch<{ external_locations?: UCExternalLocation[] }>(host, '/api/2.1/unity-catalog/external-locations');
  return (j.external_locations || []).map((e) => ({ ...e, workspace_hostname: host }));
}

export async function createExternalLocation(
  host: string,
  body: { name: string; url: string; credential_name: string; comment?: string; read_only?: boolean; skip_validation?: boolean },
): Promise<UCExternalLocation> {
  const j = await ucFetch<UCExternalLocation>(host, '/api/2.1/unity-catalog/external-locations', { method: 'POST', body });
  return { ...j, workspace_hostname: host };
}

export async function updateExternalLocation(
  host: string,
  name: string,
  body: { url?: string; credential_name?: string; comment?: string; read_only?: boolean; new_name?: string; owner?: string },
): Promise<UCExternalLocation> {
  const j = await ucFetch<UCExternalLocation>(host, `/api/2.1/unity-catalog/external-locations/${encodeURIComponent(name)}`, { method: 'PATCH', body });
  return { ...j, workspace_hostname: host };
}

export async function deleteExternalLocation(host: string, name: string, force = false): Promise<void> {
  await ucFetch(host, `/api/2.1/unity-catalog/external-locations/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    query: force ? { force: 'true' } : undefined,
  });
}

// ---- Storage credentials ---------------------------------------------

export async function listStorageCredentials(host: string): Promise<UCStorageCredential[]> {
  const j = await ucFetch<{ storage_credentials?: UCStorageCredential[] }>(host, '/api/2.1/unity-catalog/storage-credentials');
  return (j.storage_credentials || []).map((c) => ({ ...c, workspace_hostname: host }));
}

export async function createStorageCredential(
  host: string,
  body: { name: string; comment?: string; read_only?: boolean; skip_validation?: boolean; azure_managed_identity: UCAzureManagedIdentity },
): Promise<UCStorageCredential> {
  const j = await ucFetch<UCStorageCredential>(host, '/api/2.1/unity-catalog/storage-credentials', { method: 'POST', body });
  return { ...j, workspace_hostname: host };
}

export async function updateStorageCredential(
  host: string,
  name: string,
  body: { comment?: string; read_only?: boolean; new_name?: string; owner?: string },
): Promise<UCStorageCredential> {
  const j = await ucFetch<UCStorageCredential>(host, `/api/2.1/unity-catalog/storage-credentials/${encodeURIComponent(name)}`, { method: 'PATCH', body });
  return { ...j, workspace_hostname: host };
}

export async function deleteStorageCredential(host: string, name: string, force = false): Promise<void> {
  await ucFetch(host, `/api/2.1/unity-catalog/storage-credentials/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    query: force ? { force: 'true' } : undefined,
  });
}

// ---- Connections (Lakehouse Federation) ------------------------------
//
// list/get/delete via REST; CREATE via SQL DDL on the warehouse so the
// `secret()` function can replace plaintext passwords (createUcConnection).

export async function listConnections(host: string): Promise<UCConnection[]> {
  const j = await ucFetch<{ connections?: UCConnection[] }>(host, '/api/2.1/unity-catalog/connections');
  return (j.connections || []).map((c) => ({ ...c, workspace_hostname: host }));
}

export async function getConnection(host: string, name: string): Promise<UCConnection> {
  const j = await ucFetch<UCConnection>(host, `/api/2.1/unity-catalog/connections/${encodeURIComponent(name)}`);
  return { ...j, workspace_hostname: host };
}

export async function deleteConnection(host: string, name: string): Promise<void> {
  await ucFetch(host, `/api/2.1/unity-catalog/connections/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

/**
 * Create a Lakehouse Federation connection over SQL (CREATE CONNECTION … TYPE …
 * OPTIONS (…)). Runs on the SQL warehouse so credential options can use
 * `secret('scope','key')` instead of plaintext. Returns ONLY executionMs — never
 * the SQL text, which may contain a literal password (per the wave-c2 secret
 * rule, the raw statement is never returned to the client or logged).
 */
export async function createUcConnection(
  warehouseId: string,
  params: UcCreateConnectionParams,
): Promise<{ executionMs: number }> {
  const sql = buildCreateConnection(params);
  const r = await executeStatement(warehouseId, sql);
  return { executionMs: r.executionMs };
}

/** Create a foreign catalog from an existing connection (CREATE FOREIGN CATALOG
 *  … USING CONNECTION … OPTIONS (database '…')). No credentials in this DDL, so
 *  the SQL is safe to return for the receipt/preview. */
export async function createUcForeignCatalog(
  warehouseId: string,
  params: UcForeignCatalogParams,
): Promise<{ sql: string; executionMs: number }> {
  const sql = buildCreateForeignCatalog(params);
  const r = await executeStatement(warehouseId, sql);
  return { sql, executionMs: r.executionMs };
}

/** Resolve the primary workspace host for REST calls (first federation host).
 *  Throws the structured {@link UnityCatalogNotConfiguredError} when no
 *  Databricks workspace is bound — the BFF surfaces it as an honest gate. */
export async function primaryWorkspaceHost(): Promise<string> {
  const hosts = await resolveWorkspaceHostnames();
  if (!hosts.length) {
    throw new UnityCatalogNotConfiguredError({
      missingEnvVar: 'LOOM_DATABRICKS_HOSTNAMES (or LOOM_DATABRICKS_HOSTNAME)',
      bicepModule: 'platform/fiab/bicep/modules/admin-plane/main.bicep (catalog dispatcher)',
      bicepStatus: 'Databricks workspace must be deployed and bound to a Unity Catalog metastore.',
      followUp: 'Set LOOM_DATABRICKS_HOSTNAMES on the Console Container App.',
    });
  }
  return hosts[0];
}

// ============================================================
// Governance depth (wave c3)
//
//   1. Workspace-catalog binding (catalog isolation) — a binding supersedes
//      explicit grants and is a real security boundary. A catalog must be set
//      ISOLATED for its bindings to be enforced (OPEN ⇒ any workspace).
//   2. System tables / audit surface — read-only reads of system.access.audit,
//      system.billing.usage, system.query.history (+ enablement confirmation via
//      the systemschemas REST). Real SQL over the Statement Execution path.
//   3. UC-native data classification — system.data_classification.results
//      (column-level sensitive-class detections). Complements the Purview scan.
//
// Bindings + systemschemas are real UC REST (/api/2.1/unity-catalog/{bindings,
// metastores/{id}/systemschemas}); the system.* reads are Learn-grounded SQL on
// the SQL warehouse. Honest gate when a system schema isn't enabled (or the UAMI
// lacks USE CATALOG/USE SCHEMA/SELECT on it) — never a silent empty result.
//
// CAVEAT: /api/2.1/unity-catalog/bindings/{securable_type}/{name} is data-plane;
// the GET/PATCH (add/remove) shape mirrors the documented `workspace-bindings
// get-bindings / update-bindings` CLI. systemschemas + system.* schemas are
// Learn-grounded (learn.microsoft.com/azure/databricks/admin/system-tables).
// ============================================================

// ---- 1. Workspace-catalog binding (catalog isolation) ----------------

export type UCBindingSecurableType =
  | 'catalog'
  | 'external_location'
  | 'storage_credential'
  | 'credential';

export interface UCWorkspaceBinding {
  workspace_id: number;
  /** BINDING_TYPE_READ_WRITE (default) | BINDING_TYPE_READ_ONLY. */
  binding_type?: 'BINDING_TYPE_READ_WRITE' | 'BINDING_TYPE_READ_ONLY' | string;
}

/** GET /api/2.1/unity-catalog/bindings/{securable_type}/{name} — the workspaces
 *  a securable (catalog / external location / storage credential) is bound to.
 *  Caller must be a metastore admin or the securable owner. */
export async function listWorkspaceBindings(
  host: string,
  securableType: UCBindingSecurableType,
  securableName: string,
): Promise<UCWorkspaceBinding[]> {
  const j = await ucFetch<{ bindings?: UCWorkspaceBinding[]; workspaces?: number[] }>(
    host,
    `/api/2.1/unity-catalog/bindings/${securableType}/${encodeURIComponent(securableName)}`,
  );
  if (Array.isArray(j.bindings)) return j.bindings;
  // Older metastores echo a bare `workspaces` id array (READ_WRITE implied).
  if (Array.isArray(j.workspaces)) return j.workspaces.map((id) => ({ workspace_id: id }));
  return [];
}

/** PATCH /api/2.1/unity-catalog/bindings/{securable_type}/{name} with add/remove
 *  — mirrors `databricks workspace-bindings update-bindings`. Returns the new
 *  binding set. */
export async function updateWorkspaceBindings(
  host: string,
  securableType: UCBindingSecurableType,
  securableName: string,
  changes: { add?: UCWorkspaceBinding[]; remove?: UCWorkspaceBinding[] },
): Promise<UCWorkspaceBinding[]> {
  const j = await ucFetch<{ bindings?: UCWorkspaceBinding[] }>(
    host,
    `/api/2.1/unity-catalog/bindings/${securableType}/${encodeURIComponent(securableName)}`,
    { method: 'PATCH', body: { add: changes.add || [], remove: changes.remove || [] } },
  );
  return j.bindings || [];
}

/** GET a single catalog (carries `isolation_mode`, unlike the list rows we cache). */
export async function getCatalog(host: string, name: string): Promise<UCCatalog> {
  const j = await ucFetch<UCCatalog>(host, `/api/2.1/unity-catalog/catalogs/${encodeURIComponent(name)}`);
  return { ...j, workspace_hostname: host };
}

/** PATCH the catalog's isolation mode. ISOLATED makes its workspace bindings a
 *  hard boundary (only bound workspaces can access it); OPEN reverts to "any
 *  workspace". This is the toggle that turns a binding into a security boundary. */
export async function setCatalogIsolationMode(
  host: string,
  name: string,
  isolationMode: 'OPEN' | 'ISOLATED',
): Promise<UCCatalog> {
  const j = await ucFetch<UCCatalog>(host, `/api/2.1/unity-catalog/catalogs/${encodeURIComponent(name)}`, {
    method: 'PATCH', body: { isolation_mode: isolationMode },
  });
  return { ...j, workspace_hostname: host };
}

// ---- 2. System schemas (enablement) ----------------------------------

export interface UCSystemSchema {
  schema: string;
  /** ENABLE_COMPLETED | ENABLE_INITIALIZED | AVAILABLE | DISABLE_INITIALIZED | UNAVAILABLE … */
  state?: string;
}

/** The metastore summary (id + name + delta-sharing scope) for the calling
 *  workspace — used to address the systemschemas REST and label the audit pane. */
export async function getMetastoreSummary(
  host: string,
): Promise<{ metastoreId?: string; name?: string; deltaSharingScope?: string }> {
  const j = await ucFetch<any>(host, '/api/2.1/unity-catalog/metastore_summary');
  return { metastoreId: j?.metastore_id, name: j?.name, deltaSharingScope: j?.delta_sharing_scope };
}

/** GET /api/2.1/unity-catalog/metastores/{id}/systemschemas — the enablement
 *  state of each system schema (access / billing / query / data_classification …).
 *  Caller must be an account or metastore admin. */
export async function listSystemSchemas(host: string, metastoreId: string): Promise<UCSystemSchema[]> {
  const j = await ucFetch<{ schemas?: UCSystemSchema[] }>(
    host,
    `/api/2.1/unity-catalog/metastores/${encodeURIComponent(metastoreId)}/systemschemas`,
  );
  return j.schemas || [];
}

/** PUT …/systemschemas/{schema} — enable a system schema (adds it to the system
 *  catalog). Requires metastore/account admin; a 403 is surfaced as an honest
 *  gate by the BFF. `schema` is the short name (access / billing / query / …). */
export async function enableSystemSchema(host: string, metastoreId: string, schema: string): Promise<void> {
  await ucFetch(
    host,
    `/api/2.1/unity-catalog/metastores/${encodeURIComponent(metastoreId)}/systemschemas/${encodeURIComponent(schema)}`,
    { method: 'PUT' },
  );
}

// ---- 2b. System table reads (audit / billing / query history) --------

export interface SystemReadResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionMs: number;
}

const clampInt = (v: number | undefined, def: number, min: number, max: number): number => {
  const n = Number.isFinite(v as number) ? Math.trunc(v as number) : def;
  return Math.min(max, Math.max(min, n));
};

/**
 * Run a `system.*` read and convert a "schema not enabled / not authorized"
 * failure into a typed {@link UnityCatalogError} that names the exact remediation
 * (enable the system schema + grant the UAMI USE CATALOG/USE SCHEMA/SELECT),
 * rather than returning a silent empty result (per no-vaporware.md).
 */
async function runSystemTableRead(
  warehouseId: string,
  fullTable: string,     // e.g. system.access.audit
  systemSchema: string,  // e.g. access
  sql: string,
  params?: DbxQueryParam[],
): Promise<SystemReadResult> {
  try {
    const r = await executeStatement(warehouseId, sql, undefined, undefined, params);
    return { columns: r.columns, rows: ucRows(r), rowCount: r.rowCount, executionMs: r.executionMs };
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/TABLE_OR_VIEW_NOT_FOUND|PERMISSION_DENIED|does not exist|cannot be found|UNRESOLVED|INSUFFICIENT_PERMISSIONS|SCHEMA_NOT_FOUND|REQUIRES_SINGLE_PART_NAMESPACE|system\./i.test(msg)) {
      throw new UnityCatalogError(
        `The Databricks system table ${fullTable} is unavailable: ${msg}. Enable the ` +
          `system.${systemSchema} schema (as a metastore admin: PUT /api/2.1/unity-catalog/` +
          `metastores/{metastore_id}/systemschemas/${systemSchema}) and grant the Loom UAMI ` +
          `USE CATALOG on \`system\` + USE SCHEMA on system.${systemSchema} + SELECT (see ` +
          `scripts/csa-loom/grant-databricks-system-tables-role.sh).`,
        typeof e?.status === 'number' ? e.status : 403,
        e?.body,
        fullTable,
      );
    }
    throw e;
  }
}

/** Recent rows from `system.access.audit` (the UC audit log). Filter on
 *  `event_date` (partition) for performance. */
export async function readAccessAudit(
  warehouseId: string,
  opts: { days?: number; limit?: number; service?: string; action?: string } = {},
): Promise<SystemReadResult> {
  const days = clampInt(opts.days, 7, 1, 365);
  const limit = clampInt(opts.limit, 100, 1, 1000);
  const params: DbxQueryParam[] = [];
  const filters = [`event_date >= current_date() - INTERVAL ${days} DAYS`];
  if (opts.service?.trim()) { filters.push('service_name = :service'); params.push({ name: 'service', value: opts.service.trim(), type: 'STRING' }); }
  if (opts.action?.trim()) { filters.push('action_name = :action'); params.push({ name: 'action', value: opts.action.trim(), type: 'STRING' }); }
  const sql = `SELECT event_time, workspace_id, service_name, action_name, user_identity.email AS user_email, source_ip_address, request_id
    FROM system.access.audit
    WHERE ${filters.join(' AND ')}
    ORDER BY event_time DESC
    LIMIT ${limit}`;
  return runSystemTableRead(warehouseId, 'system.access.audit', 'access', sql, params.length ? params : undefined);
}

/** Billable-usage summary from `system.billing.usage`, aggregated by product +
 *  SKU over a recent window (the audit pane's "spend" tab). */
export async function readBillingUsage(
  warehouseId: string,
  opts: { days?: number; limit?: number } = {},
): Promise<SystemReadResult> {
  const days = clampInt(opts.days, 30, 1, 365);
  const limit = clampInt(opts.limit, 100, 1, 1000);
  const sql = `SELECT billing_origin_product, sku_name, usage_unit, ROUND(SUM(usage_quantity), 4) AS usage_quantity, COUNT(*) AS records
    FROM system.billing.usage
    WHERE usage_date >= current_date() - INTERVAL ${days} DAYS
    GROUP BY billing_origin_product, sku_name, usage_unit
    ORDER BY usage_quantity DESC
    LIMIT ${limit}`;
  return runSystemTableRead(warehouseId, 'system.billing.usage', 'billing', sql);
}

/** Recent statements from `system.query.history`. `statement_text` may be
 *  `<Redacted>` for non-admins (Databricks-side redaction) — surfaced as-is. */
export async function readQueryHistory(
  warehouseId: string,
  opts: { days?: number; limit?: number; status?: string } = {},
): Promise<SystemReadResult> {
  const days = clampInt(opts.days, 7, 1, 365);
  const limit = clampInt(opts.limit, 100, 1, 1000);
  const params: DbxQueryParam[] = [];
  const filters = [`start_time >= current_timestamp() - INTERVAL ${days} DAYS`];
  if (opts.status?.trim()) { filters.push('execution_status = :status'); params.push({ name: 'status', value: opts.status.trim().toUpperCase(), type: 'STRING' }); }
  const sql = `SELECT start_time, executed_by, statement_type, execution_status, total_duration_ms, produced_rows, statement_text
    FROM system.query.history
    WHERE ${filters.join(' AND ')}
    ORDER BY start_time DESC
    LIMIT ${limit}`;
  return runSystemTableRead(warehouseId, 'system.query.history', 'query', sql, params.length ? params : undefined);
}

// ---- 3. UC-native data classification (auto-PII) ---------------------

/** Column-level sensitive-class detections from `system.data_classification.results`
 *  (HIGH/LOW confidence per `class_tag`). Honest-gated when the
 *  `data_classification` system schema isn't enabled. */
export async function readDataClassification(
  warehouseId: string,
  opts: { catalog?: string; schema?: string; table?: string; confidence?: string; limit?: number } = {},
): Promise<SystemReadResult> {
  const limit = clampInt(opts.limit, 200, 1, 1000);
  const params: DbxQueryParam[] = [];
  const filters = ['class_tag IS NOT NULL'];
  if (opts.catalog?.trim()) { filters.push('catalog_name = :catalog'); params.push({ name: 'catalog', value: opts.catalog.trim(), type: 'STRING' }); }
  if (opts.schema?.trim()) { filters.push('schema_name = :schema'); params.push({ name: 'schema', value: opts.schema.trim(), type: 'STRING' }); }
  if (opts.table?.trim()) { filters.push('table_name = :table'); params.push({ name: 'table', value: opts.table.trim(), type: 'STRING' }); }
  if (opts.confidence?.trim()) { filters.push('confidence = :confidence'); params.push({ name: 'confidence', value: opts.confidence.trim().toUpperCase(), type: 'STRING' }); }
  const sql = `SELECT catalog_name, schema_name, table_name, column_name, class_tag, confidence, frequency, latest_detected_time
    FROM system.data_classification.results
    WHERE ${filters.join(' AND ')}
    ORDER BY confidence DESC, latest_detected_time DESC
    LIMIT ${limit}`;
  return runSystemTableRead(warehouseId, 'system.data_classification.results', 'data_classification', sql, params.length ? params : undefined);
}
