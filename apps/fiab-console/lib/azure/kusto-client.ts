/**
 * Azure Data Explorer (Kusto) client — raw REST against the Loom shared
 * cluster `adx-csa-loom-shared.eastus2.kusto.windows.net`.
 *
 * Auth: Console UAMI via ManagedIdentityCredential, chained with
 * DefaultAzureCredential for local dev. The UAMI holds AllDatabasesAdmin
 * on the cluster (granted out-of-band via `az kusto
 * cluster-principal-assignment create`), so it can run queries, mgmt
 * commands, and ingest.
 *
 * Endpoints used:
 *   POST /v1/rest/query — KQL queries (table-shaped results)
 *   POST /v1/rest/mgmt  — control commands (.show, .create, .add, .ingest)
 *
 * v1 response shape:
 *   { Tables: [{ TableName, Columns: [{ColumnName, DataType}], Rows: [[...]] }] }
 * The primary results table is `Table_0`; subsequent tables are query
 * properties / completion metadata. We surface Table_0 only.
 */

import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { itemsContainer, workspacesContainer } from './cosmos-client';

const CLUSTER_URI = process.env.LOOM_KUSTO_CLUSTER_URI || 'https://adx-csa-loom-shared.eastus2.kusto.windows.net';
const DEFAULT_DB = process.env.LOOM_KUSTO_DEFAULT_DB || 'loomdb-default';
const MAX_ROWS = 5_000;

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

export class KustoError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'KustoError';
    this.status = status;
    this.body = body;
  }
}

export interface KustoQueryResult {
  columns: string[];
  columnTypes: string[];
  rows: unknown[][];
  rowCount: number;
  executionMs: number;
  truncated: boolean;
}

export function clusterUri(): string {
  return CLUSTER_URI;
}

export function defaultDatabase(): string {
  return DEFAULT_DB;
}

async function getToken(): Promise<string> {
  const scope = `${CLUSTER_URI}/.default`;
  const t = await credential.getToken(scope);
  if (!t?.token) throw new KustoError('Failed to acquire AAD token for Kusto', 401);
  return t.token;
}

async function postRest(path: '/v1/rest/query' | '/v1/rest/mgmt', db: string, csl: string): Promise<any> {
  const token = await getToken();
  const url = `${CLUSTER_URI}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
      'accept': 'application/json',
      'x-ms-client-request-id': `loom-console.${Math.random().toString(36).slice(2)}`,
    },
    body: JSON.stringify({ db, csl }),
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (json?.error?.['@message'] || json?.error?.message || text || 'Kusto request failed').toString();
    throw new KustoError(msg, res.status, json || text);
  }
  return json;
}

function shapeTable(table: any, executionMs: number): KustoQueryResult {
  const cols: { ColumnName: string; DataType?: string; ColumnType?: string }[] = table?.Columns || [];
  const rawRows: unknown[][] = table?.Rows || [];
  const columns = cols.map((c) => c.ColumnName);
  const columnTypes = cols.map((c) => c.DataType || c.ColumnType || '');
  const truncated = rawRows.length > MAX_ROWS;
  const rows = truncated ? rawRows.slice(0, MAX_ROWS) : rawRows;
  return {
    columns,
    columnTypes,
    rows,
    rowCount: rawRows.length,
    executionMs,
    truncated,
  };
}

/** Execute a KQL query. Returns the primary results table (Table_0). */
export async function executeQuery(database: string, kql: string): Promise<KustoQueryResult> {
  const started = Date.now();
  const json = await postRest('/v1/rest/query', database || DEFAULT_DB, kql);
  const primary = (json?.Tables || []).find((t: any) => t?.TableName === 'Table_0') || json?.Tables?.[0];
  if (!primary) {
    return { columns: [], columnTypes: [], rows: [], rowCount: 0, executionMs: Date.now() - started, truncated: false };
  }
  return shapeTable(primary, Date.now() - started);
}

/** Execute a Kusto control command (`.show`, `.create`, `.add`, `.ingest`, etc.). */
export async function executeMgmtCommand(database: string, command: string): Promise<KustoQueryResult> {
  const started = Date.now();
  const json = await postRest('/v1/rest/mgmt', database || DEFAULT_DB, command);
  const primary = (json?.Tables || [])[0];
  if (!primary) {
    return { columns: [], columnTypes: [], rows: [], rowCount: 0, executionMs: Date.now() - started, truncated: false };
  }
  return shapeTable(primary, Date.now() - started);
}

/** `.show databases` against NetDefaultDB. */
export async function listDatabases(): Promise<Array<{ name: string; prettyName?: string; persistentStorage?: string }>> {
  const r = await executeMgmtCommand('NetDefaultDB', '.show databases');
  const nameIdx = r.columns.indexOf('DatabaseName');
  const prettyIdx = r.columns.indexOf('PrettyName');
  const storIdx = r.columns.indexOf('PersistentStorage');
  return r.rows.map((row) => ({
    name: String(row[nameIdx >= 0 ? nameIdx : 0]),
    prettyName: prettyIdx >= 0 ? (row[prettyIdx] as string) : undefined,
    persistentStorage: storIdx >= 0 ? (row[storIdx] as string) : undefined,
  }));
}

/** `.show tables` for a given database. */
export async function listTables(db: string): Promise<Array<{ name: string; folder?: string; docString?: string }>> {
  const r = await executeMgmtCommand(db, '.show tables');
  const nameIdx = r.columns.indexOf('TableName');
  const folderIdx = r.columns.indexOf('Folder');
  const docIdx = r.columns.indexOf('DocString');
  return r.rows.map((row) => ({
    name: String(row[nameIdx >= 0 ? nameIdx : 0]),
    folder: folderIdx >= 0 ? (row[folderIdx] as string) : undefined,
    docString: docIdx >= 0 ? (row[docIdx] as string) : undefined,
  }));
}

/** `.show functions` — stored KQL functions (ADX schema-tree parity). */
export async function listFunctions(db: string): Promise<Array<{ name: string; parameters?: string; folder?: string; docString?: string }>> {
  const r = await executeMgmtCommand(db, '.show functions');
  const nameIdx = r.columns.indexOf('Name');
  const paramIdx = r.columns.indexOf('Parameters');
  const folderIdx = r.columns.indexOf('Folder');
  const docIdx = r.columns.indexOf('DocString');
  return r.rows.map((row) => ({
    name: String(row[nameIdx >= 0 ? nameIdx : 0]),
    parameters: paramIdx >= 0 ? (row[paramIdx] as string) : undefined,
    folder: folderIdx >= 0 ? (row[folderIdx] as string) : undefined,
    docString: docIdx >= 0 ? (row[docIdx] as string) : undefined,
  }));
}

/** `.show materialized-views` — materialized views (ADX schema-tree parity). */
export async function listMaterializedViews(db: string): Promise<Array<{ name: string; sourceTable?: string; query?: string }>> {
  const r = await executeMgmtCommand(db, '.show materialized-views');
  const nameIdx = r.columns.indexOf('Name');
  const srcIdx = r.columns.indexOf('SourceTable');
  const qIdx = r.columns.indexOf('Query');
  return r.rows.map((row) => ({
    name: String(row[nameIdx >= 0 ? nameIdx : 0]),
    sourceTable: srcIdx >= 0 ? (row[srcIdx] as string) : undefined,
    query: qIdx >= 0 ? (row[qIdx] as string) : undefined,
  }));
}

/** `.show database <db> details` — size, retention, hot cache. */
export async function getDatabaseDetails(db: string): Promise<Record<string, unknown> | null> {
  // Quote DB name; KQL identifiers tolerate `["name"]` form for hyphens.
  const r = await executeMgmtCommand(db, `.show database ["${db}"] details`);
  if (!r.rows.length) return null;
  const out: Record<string, unknown> = {};
  r.columns.forEach((c, i) => { out[c] = r.rows[0][i]; });
  return out;
}

/** `.show table T schema as json` — returns the parsed schema object. */
export async function getTableSchema(db: string, table: string): Promise<unknown> {
  const r = await executeMgmtCommand(db, `.show table ["${table}"] schema as json`);
  if (!r.rows.length) return null;
  const schemaIdx = r.columns.indexOf('Schema');
  const raw = r.rows[0][schemaIdx >= 0 ? schemaIdx : 1];
  try { return JSON.parse(String(raw)); } catch { return raw; }
}

/**
 * Inline ingest of small (<= a few hundred rows) ad-hoc data.
 * `rows` is a 2-D array of cell values; rendered as CSV after the `<|`
 * separator. Strings are double-quoted with `"` doubled to escape.
 */
export async function ingestInline(db: string, table: string, rows: unknown[][]): Promise<KustoQueryResult> {
  if (!rows.length) throw new KustoError('ingestInline: rows must be non-empty', 400);
  const csv = rows
    .map((row) => row.map((cell) => {
      if (cell === null || cell === undefined) return '';
      const s = String(cell);
      // RFC-4180-ish: quote if contains comma, quote, or newline
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    }).join(','))
    .join('\n');
  const command = `.ingest inline into table ["${table}"] <|\n${csv}`;
  return executeMgmtCommand(db, command);
}

/**
 * Create a Kusto database via ARM. Database creation is an ARM-plane
 * operation (not a KQL control command) because it allocates persistent
 * storage. Requires the caller identity to have Contributor on the
 * cluster.
 */
export async function createDatabase(
  name: string,
  opts?: { hotCacheDays?: number; softDeleteDays?: number; location?: string },
): Promise<{ provisioningState: string; id: string }> {
  const sub = required('LOOM_SUBSCRIPTION_ID');
  const rg = process.env.LOOM_KUSTO_RG || 'rg-csa-loom-admin-eastus2';
  const cluster = process.env.LOOM_KUSTO_CLUSTER_NAME || 'adx-csa-loom-shared';
  const location = opts?.location || process.env.LOOM_KUSTO_LOCATION || 'eastus2';
  const armToken = await (async () => {
    const t = await credential.getToken('https://management.azure.com/.default');
    if (!t?.token) throw new KustoError('Failed to acquire ARM token', 401);
    return t.token;
  })();
  const apiVersion = '2023-08-15';
  const url = `https://management.azure.com/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Kusto/clusters/${cluster}/databases/${encodeURIComponent(name)}?api-version=${apiVersion}`;
  const body = {
    location,
    kind: 'ReadWrite',
    properties: {
      softDeletePeriod: `P${opts?.softDeleteDays ?? 30}D`,
      hotCachePeriod: `P${opts?.hotCacheDays ?? 7}D`,
    },
  };
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'authorization': `Bearer ${armToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const msg = (json?.error?.message || text || 'createDatabase failed').toString();
    throw new KustoError(msg, res.status, json || text);
  }
  return { provisioningState: json?.properties?.provisioningState || 'Accepted', id: json?.id || '' };
}

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new KustoError(`Missing env var: ${key}`, 500);
  return v;
}

// ============================================================
// Cosmos item helpers — shared by all Kusto-backed routes.
// ============================================================

export interface KustoItem {
  id: string;
  workspaceId: string;
  itemType: string;
  displayName: string;
  state?: Record<string, any>;
}

/**
 * Load a Cosmos item by id+type and verify the caller's tenant owns
 * the parent workspace. Returns null on miss/mismatch.
 */
export async function loadKustoItem(itemId: string, itemType: string, tenantId: string): Promise<KustoItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<KustoItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: itemId },
        { name: '@t', value: itemType },
      ],
    })
    .fetchAll();
  const item = resources[0];
  if (!item) return null;
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(item.workspaceId, tenantId).read<{ tenantId: string }>();
    if (!resource || resource.tenantId !== tenantId) return null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
  return item;
}

/** Save state onto a Cosmos item; merges shallow into existing state. */
export async function saveItemState(item: KustoItem, patch: Record<string, any>): Promise<KustoItem> {
  const items = await itemsContainer();
  const { resource } = await items.item(item.id, item.workspaceId).read<KustoItem & Record<string, any>>();
  if (!resource) throw new KustoError('item not found during save', 404);
  const next = {
    ...resource,
    state: { ...(resource.state || {}), ...patch },
    updatedAt: new Date().toISOString(),
  };
  const { resource: saved } = await items.item(item.id, item.workspaceId).replace(next);
  return saved as KustoItem;
}

/** Resolve the database name for a Kusto-backed item; falls back to default. */
export function resolveDatabase(item: KustoItem | null): string {
  const name = item?.state?.databaseName;
  if (typeof name === 'string' && name.trim()) return name.trim();
  return DEFAULT_DB;
}
