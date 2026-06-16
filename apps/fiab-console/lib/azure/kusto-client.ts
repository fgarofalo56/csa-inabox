/**
 * Azure Data Explorer (Kusto) client — raw REST against the Loom shared
 * cluster (default `adx-csa-loom-shared` in region `eastus2`; the hostname
 * suffix is sovereign-cloud-correct via cloud-endpoints.kustoClusterUri()).
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

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { itemsContainer, workspacesContainer } from './cosmos-client';
import { armBase, armScope, kustoClusterUri } from './cloud-endpoints';
import { buildCreateMaterializedViewCommand } from './kusto-mv-command';

const CLUSTER_URI = process.env.LOOM_KUSTO_CLUSTER_URI || kustoClusterUri('adx-csa-loom-shared', 'eastus2');
const DEFAULT_DB = process.env.LOOM_KUSTO_DEFAULT_DB || 'loomdb-default';
const MAX_ROWS = 5_000;

/**
 * Data Management (ingestion) endpoint — `.purge table records` commands MUST
 * target this URI, NOT the data-plane CLUSTER_URI. Grounded in Microsoft Learn
 * (Data purge):
 *   https://learn.microsoft.com/kusto/concepts/data-purge?view=azure-data-explorer
 * Topology: the engine URI `https://<c>.<region>.kusto.windows.net` maps to the
 * DM URI `https://ingest-<c>.<region>.kusto.windows.net`. The ARM
 * `clusterDataIngestionUri` output is wired into LOOM_KUSTO_DM_URI in
 * platform/fiab/bicep/modules/admin-plane/main.bicep; when unset we derive it by
 * prepending `ingest-` to the cluster host (works for Commercial + Gov suffixes).
 */
const DM_URI =
  process.env.LOOM_KUSTO_DM_URI ||
  CLUSTER_URI.replace(/^(https?:\/\/)/i, '$1ingest-');

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
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

/**
 * The `Visualization` annotation produced by the KQL `render` operator and
 * carried in the v1 response's `@ExtendedProperties` table. The ADX web UI uses
 * exactly this to auto-pick the chart for a query result. Grounded in Microsoft
 * Learn (Query/management HTTP response — `@ExtendedProperties`; render operator
 * supported properties):
 *   https://learn.microsoft.com/kusto/api/rest/response#the-meaning-of-tables-in-the-response
 *   https://learn.microsoft.com/kusto/query/render-operator
 */
export interface KustoVisualization {
  /** timechart | columnchart | barchart | piechart | linechart | scatterchart | card | … */
  Visualization?: string;
  Title?: string;
  XColumn?: string;
  YColumns?: string | string[];
  Series?: string | string[];
  Kind?: string;
  Accumulate?: boolean;
  XTitle?: string;
  YTitle?: string;
  [k: string]: unknown;
}

export interface KustoQueryResult {
  columns: string[];
  columnTypes: string[];
  rows: unknown[][];
  rowCount: number;
  executionMs: number;
  truncated: boolean;
  /**
   * The parsed `render` visualization hint, when the query ended with a
   * `| render <viz>` operator. Absent for queries / mgmt commands with no render.
   */
  visualization?: KustoVisualization;
}

export function clusterUri(): string {
  return CLUSTER_URI;
}

export function defaultDatabase(): string {
  return DEFAULT_DB;
}

/**
 * Honest config gate for the ADX navigator. The data-plane cluster URI has a
 * built-in default (the Loom shared cluster), but a deployment that hasn't
 * provisioned ADX should set `LOOM_KUSTO_CLUSTER_URI` explicitly. When neither
 * the explicit URI nor a default database is configured we surface the gate so
 * the UI shows a precise MessageBar instead of erroring against a phantom
 * cluster. Returns `{ missing }` when not configured, else `null`.
 */
export function kustoConfigGate(): { missing: string } | null {
  if (!process.env.LOOM_KUSTO_CLUSTER_URI) {
    return { missing: 'LOOM_KUSTO_CLUSTER_URI' };
  }
  return null;
}

/**
 * Build the ADX-proxy `cluster()` URI for the configured Log Analytics
 * workspace (or App Insights component).
 *
 * Uses `LOOM_LOG_ANALYTICS_RESOURCE_ID` (the full ARM resource ID emitted by
 * monitoring.bicep → main.bicep → the loom-console container env). The ADX
 * cluster resolves the cross-cluster reference server-side at query time; the
 * Console UAMI holds Log Analytics Reader on the workspace (granted by
 * monitoring.bicep `consoleLaReader`), so no separate token is needed — the
 * federated query runs as a normal ADX `/v1/rest/query`.
 *
 * Proxy hosts (grounded in Microsoft Learn — "Query data in Azure Monitor
 * using Azure Data Explorer", additional-syntax-examples):
 *   Commercial / GCC : adx.monitor.azure.com
 *   GCC-High / IL5   : adx.monitor.azure.us
 *
 * Returns `null` when `LOOM_LOG_ANALYTICS_RESOURCE_ID` is not configured
 * (the operator has not deployed a Log Analytics workspace / the env var is
 * unset) so callers can render an honest gate instead of a phantom call.
 */
export function laProxyClusterUri(): string | null {
  const rid = process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID?.trim();
  if (!rid) return null;
  const host = process.env.AZURE_CLOUD === 'AzureUSGovernment'
    ? 'adx.monitor.azure.us'
    : 'adx.monitor.azure.com';
  const path = rid.startsWith('/') ? rid : `/${rid}`;
  return `https://${host}${path}`;
}

/**
 * Extract the workspace (or component) name from
 * `LOOM_LOG_ANALYTICS_RESOURCE_ID`. The ARM resource ID ends with
 * `/workspaces/<name>` (Log Analytics) or `/components/<name>` (App Insights);
 * the ADX proxy `database()` argument is exactly that trailing name.
 * Returns `null` when the env var is unset.
 */
export function laWorkspaceName(): string | null {
  const rid = process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID?.trim();
  if (!rid) return null;
  return rid.split('/').filter(Boolean).pop() ?? null;
}

/**
 * Honest config gate for cross-service (ADX → Log Analytics / App Insights)
 * federated queries. Returns `{ missing }` naming the exact env var when
 * `LOOM_LOG_ANALYTICS_RESOURCE_ID` is absent, else `null` when the feature is
 * available.
 *
 * Unlike {@link kustoConfigGate}, this never gates on cloud boundary — the
 * `adx.monitor.azure.us` endpoint is supported for ADX-initiated cross-service
 * queries in Government clouds, so only the missing-env-var situation gates the
 * feature.
 */
export function laConfigGate(): { missing: string } | null {
  if (!process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID?.trim()) {
    return { missing: 'LOOM_LOG_ANALYTICS_RESOURCE_ID' };
  }
  return null;
}

/**
 * Normalise + validate a caller-supplied ADX cluster URI override. Only a
 * bare `https://<host>` Kusto/Trident engine host is accepted — never a path,
 * query, or non-https scheme — so a preview against a *discovered* ADX cluster
 * (RTI hub catalog) targets that cluster, not the env-pinned default. Returns
 * the trimmed `https://host` origin, or `null` when the input is absent/invalid
 * (callers fall back to the configured CLUSTER_URI).
 */
export function normalizeClusterUri(raw: string | undefined | null): string | null {
  const s = (raw || '').trim();
  if (!s) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  // ADX engine hosts: <name>.<region>.kusto.windows.net / kusto.<sovereign>,
  // the Trident/Fabric Eventhouse query host, or the Azure Monitor ADX proxy.
  if (!/\.(kusto\.|kustomfa\.|playfab\.|monitor\.azure\.)/i.test(u.host) &&
      !/\.kusto\.(windows\.net|usgovcloudapi\.net|chinacloudapi\.cn|core\.windows\.net)$/i.test(u.host) &&
      !/\.z\d+\.kusto\.fabric\.microsoft\.com$/i.test(u.host) &&
      !/\.kusto\.azuresynapse\./i.test(u.host)) {
    // Accept any *.kusto.* host defensively (covers regional + sovereign forms).
    if (!/\bkusto\b/i.test(u.host) && !/\badx\.monitor\./i.test(u.host)) return null;
  }
  return `${u.protocol}//${u.host}`;
}

async function getToken(clusterUri?: string): Promise<string> {
  const scope = `${clusterUri || CLUSTER_URI}/.default`;
  const t = await credential.getToken(scope);
  if (!t?.token) throw new KustoError('Failed to acquire AAD token for Kusto', 401);
  return t.token;
}

async function postRest(path: '/v1/rest/query' | '/v1/rest/mgmt', db: string, csl: string, clusterUri?: string): Promise<any> {
  const base = clusterUri || CLUSTER_URI;
  const token = await getToken(base);
  const url = `${base}${path}`;
  const res = await fetchWithTimeout(url, {
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

/**
 * Send a control command to the Data Management (ingestion) endpoint — required
 * for `.purge table records` (the engine endpoint rejects purge). Same v1
 * request/response shape as {@link postRest} but against {@link DM_URI}. The AAD
 * token scope stays the cluster URI's `.default` (the DM endpoint accepts the
 * same audience). Grounded in Microsoft Learn (Data purge).
 */
async function postMgmtDm(db: string, csl: string): Promise<any> {
  const token = await getToken();
  const url = `${DM_URI}/v1/rest/mgmt`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
      'accept': 'application/json',
      'x-ms-client-request-id': `loom-purge.${Math.random().toString(36).slice(2)}`,
    },
    body: JSON.stringify({ db, csl }),
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (json?.error?.['@message'] || json?.error?.message || text || 'Kusto DM request failed').toString();
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

/**
 * Pull the `render`-produced Visualization annotation out of the v1
 * `@ExtendedProperties` table. In the v1 protocol that table has a single
 * string column whose value is a JSON-encoded string such as
 * `{"Visualization":"piechart", …}` (or `{"Cursor":"…"}` for non-render rows).
 * We scan every cell for the one whose parsed JSON carries a `Visualization`.
 * Returns undefined when the query had no `| render`. Grounded in Learn
 * (Query/management HTTP response — `@ExtendedProperties`).
 */
function parseVisualization(tables: any[]): KustoVisualization | undefined {
  const ep = (tables || []).find((t: any) => t?.TableName === '@ExtendedProperties');
  if (!ep) return undefined;
  for (const row of ep.Rows || []) {
    for (const cell of row || []) {
      if (typeof cell !== 'string' || cell.indexOf('Visualization') < 0) continue;
      try {
        const parsed = JSON.parse(cell);
        if (parsed && typeof parsed === 'object' && 'Visualization' in parsed && parsed.Visualization) {
          return parsed as KustoVisualization;
        }
      } catch { /* not the JSON cell — keep scanning */ }
    }
  }
  return undefined;
}

/** Execute a KQL query. Returns the primary results table (Table_0).
 *  Pass `opts.clusterUri` to target a *different* ADX cluster than the
 *  env-configured default (e.g. previewing a cluster discovered in the RTI
 *  hub catalog) — it is used verbatim for both the request URL and the AAD
 *  token scope; validate it with {@link normalizeClusterUri} first. */
export async function executeQuery(database: string, kql: string, opts?: { clusterUri?: string }): Promise<KustoQueryResult> {
  const started = Date.now();
  const json = await postRest('/v1/rest/query', database || DEFAULT_DB, kql, opts?.clusterUri);
  const tables = json?.Tables || [];
  const primary = tables.find((t: any) => t?.TableName === 'Table_0') || tables[0];
  const visualization = parseVisualization(tables);
  if (!primary) {
    return { columns: [], columnTypes: [], rows: [], rowCount: 0, executionMs: Date.now() - started, truncated: false, visualization };
  }
  const shaped = shapeTable(primary, Date.now() - started);
  return visualization ? { ...shaped, visualization } : shaped;
}

/** Execute a Kusto control command (`.show`, `.create`, `.add`, `.ingest`, etc.).
 *  An optional `clusterUri` targets a *discovered* ADX cluster (RTI hub catalog)
 *  instead of the env-configured default; validate it with
 *  {@link normalizeClusterUri} first. */
export async function executeMgmtCommand(database: string, command: string, opts?: { clusterUri?: string }): Promise<KustoQueryResult> {
  const started = Date.now();
  const json = await postRest('/v1/rest/mgmt', database || DEFAULT_DB, command, opts?.clusterUri);
  const primary = (json?.Tables || [])[0];
  if (!primary) {
    return { columns: [], columnTypes: [], rows: [], rowCount: 0, executionMs: Date.now() - started, truncated: false };
  }
  return shapeTable(primary, Date.now() - started);
}

/** `.show databases` against NetDefaultDB. Optional `clusterUri` targets a
 *  discovered ADX cluster (RTI hub catalog) instead of the env default. */
export async function listDatabases(opts?: { clusterUri?: string }): Promise<Array<{ name: string; prettyName?: string; persistentStorage?: string }>> {
  const r = await executeMgmtCommand('NetDefaultDB', '.show databases', opts);
  const nameIdx = r.columns.indexOf('DatabaseName');
  const prettyIdx = r.columns.indexOf('PrettyName');
  const storIdx = r.columns.indexOf('PersistentStorage');
  return r.rows.map((row) => ({
    name: String(row[nameIdx >= 0 ? nameIdx : 0]),
    prettyName: prettyIdx >= 0 ? (row[prettyIdx] as string) : undefined,
    persistentStorage: storIdx >= 0 ? (row[storIdx] as string) : undefined,
  }));
}

/**
 * Per-database summary for the Databases browser (tile + list views).
 * Sourced from a single `.show databases details` bulk call.
 */
export interface KustoDatabaseSummary {
  name: string;
  prettyName?: string;
  persistentStorage?: string;
  /** TotalSize bytes → MB. */
  totalSizeMb?: number;
  /** RetentionPolicy.SoftDeletePeriod (timespan days component). */
  retentionDays?: number;
  /** CachingPolicy.DataHotSpan (timespan days component). */
  hotCacheDays?: number;
  /** NumberOfTables. */
  tableCount?: number;
}

/**
 * `.show databases details` — one bulk control command against NetDefaultDB
 * that returns size, retention, caching, and table count for every database
 * on the cluster. Used by the Databases browser so each tile/row shows real
 * size + retention without a per-database round trip.
 *
 * Grounded in Microsoft Learn (`.show databases details`): returns
 * DatabaseName, PrettyName, PersistentStorage, TotalSize (bytes),
 * RetentionPolicy (JSON), CachingPolicy (JSON), NumberOfTables.
 */
export async function listDatabasesWithDetails(): Promise<KustoDatabaseSummary[]> {
  const r = await executeMgmtCommand('NetDefaultDB', '.show databases details');
  const idx = (c: string) => r.columns.indexOf(c);
  const nameIdx = idx('DatabaseName');
  const prettyIdx = idx('PrettyName');
  const storIdx = idx('PersistentStorage');
  const sizeIdx = idx('TotalSize');
  const retIdx = idx('RetentionPolicy');
  const cacheIdx = idx('CachingPolicy');
  const tabIdx = idx('NumberOfTables');

  // Timespan-days parser: SoftDeletePeriod/DataHotSpan look like "365.00:00:00"
  // (days.hh:mm:ss). The leading integer before the first '.' is the day count.
  // A pure-time value ("06:00:00") has ':' in its head segment, so days = 0.
  function parseTimespanDays(raw: unknown): number | undefined {
    if (typeof raw !== 'string' || !raw) return undefined;
    const head = raw.split('.')[0];
    if (head.includes(':')) return 0;
    const days = parseInt(head, 10);
    return Number.isFinite(days) ? days : undefined;
  }

  function policyDays(policy: unknown, key: 'SoftDeletePeriod' | 'DataHotSpan'): number | undefined {
    if (typeof policy !== 'string' || !policy) return undefined;
    try {
      const p = JSON.parse(policy);
      return parseTimespanDays(p?.[key]);
    } catch {
      return undefined;
    }
  }

  return r.rows.map((row) => {
    const sizeRaw = sizeIdx >= 0 ? row[sizeIdx] : undefined;
    const sizeNum = typeof sizeRaw === 'number' ? sizeRaw : Number(sizeRaw);
    const tabRaw = tabIdx >= 0 ? row[tabIdx] : undefined;
    const tabNum = typeof tabRaw === 'number' ? tabRaw : Number(tabRaw);
    return {
      name: String(row[nameIdx >= 0 ? nameIdx : 0]),
      prettyName: prettyIdx >= 0 ? (row[prettyIdx] as string) || undefined : undefined,
      persistentStorage: storIdx >= 0 ? (row[storIdx] as string) || undefined : undefined,
      totalSizeMb: Number.isFinite(sizeNum) ? sizeNum / (1024 * 1024) : undefined,
      retentionDays: retIdx >= 0 ? policyDays(row[retIdx], 'SoftDeletePeriod') : undefined,
      hotCacheDays: cacheIdx >= 0 ? policyDays(row[cacheIdx], 'DataHotSpan') : undefined,
      tableCount: Number.isFinite(tabNum) ? tabNum : undefined,
    };
  });
}

/** `.show tables` for a given database. Optional `clusterUri` targets a
 *  discovered ADX cluster (RTI hub catalog) instead of the env default. */
export async function listTables(db: string, opts?: { clusterUri?: string }): Promise<Array<{ name: string; folder?: string; docString?: string }>> {
  const r = await executeMgmtCommand(db, '.show tables', opts);
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
export async function listFunctions(db: string): Promise<Array<{ name: string; parameters?: string; body?: string; folder?: string; docString?: string }>> {
  const r = await executeMgmtCommand(db, '.show functions');
  const nameIdx = r.columns.indexOf('Name');
  const paramIdx = r.columns.indexOf('Parameters');
  const bodyIdx = r.columns.indexOf('Body');
  const folderIdx = r.columns.indexOf('Folder');
  const docIdx = r.columns.indexOf('DocString');
  return r.rows.map((row) => ({
    name: String(row[nameIdx >= 0 ? nameIdx : 0]),
    parameters: paramIdx >= 0 ? (row[paramIdx] as string) : undefined,
    body: bodyIdx >= 0 ? ((row[bodyIdx] as string) || undefined) : undefined,
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

// ============================================================
// Purge helpers — GDPR record erasure via the ADX two-step `.purge`.
// Grounded in Microsoft Learn (Data purge):
//   https://learn.microsoft.com/kusto/concepts/data-purge?view=azure-data-explorer
// Commands target the DM endpoint (postMgmtDm), not the data endpoint, and
// require Database Admin on the target database. The Console UAMI holds
// AllDatabasesAdmin on the shared cluster. enablePurge: true is set in
// platform/fiab/bicep/modules/admin-plane/adx-cluster.bicep.
// ============================================================

/**
 * The KQL operators the guided predicate builder allows + the structured
 * predicate → `where` translation live in the dependency-free
 * `kusto-purge-predicate` module so they can be unit-tested without loading the
 * Azure SDKs. Re-exported here so the .purge route imports a single surface.
 */
export {
  PURGE_ALLOWED_OPS,
  PurgePredicateError,
  buildPurgeWhere,
} from './kusto-purge-predicate';
export type { PurgeOp, PurgePredicatePart } from './kusto-purge-predicate';
function purgeColIdx(cols: string[], key: string): number {
  return cols.findIndex((c) => c.toLowerCase().includes(key.toLowerCase()));
}

export interface PurgeVerifyResult {
  numRecordsToPurge: number;
  estimatedPurgeExecutionTime: string;
  verificationToken: string;
}

/**
 * Step 1 — verify: scans the predicate and returns the record count + a
 * verification token. NO records are deleted. The token is required for step 2.
 * Syntax: `.purge table ["T"] records in database ["DB"] <| where …`
 */
export async function executePurgeVerify(
  database: string,
  table: string,
  predicateWhere: string,
): Promise<PurgeVerifyResult> {
  const csl = `.purge table ["${table}"] records in database ["${database}"] <| ${predicateWhere}`;
  const json = await postMgmtDm(database, csl);
  const cols: string[] = ((json?.Tables?.[0]?.Columns) || []).map((c: any) => String(c.ColumnName));
  const row: unknown[] = json?.Tables?.[0]?.Rows?.[0] || [];
  return {
    numRecordsToPurge: Number(row[purgeColIdx(cols, 'numrecords')] ?? row[purgeColIdx(cols, 'num')] ?? 0),
    estimatedPurgeExecutionTime: String(row[purgeColIdx(cols, 'estimated')] ?? ''),
    verificationToken: String(row[purgeColIdx(cols, 'verification')] ?? row[purgeColIdx(cols, 'token')] ?? ''),
  };
}

export interface PurgeCommitResult {
  operationId: string;
  state: string;
  databaseName: string;
  tableName: string;
  scheduledTime: string;
}

/**
 * Step 2 — commit: executes the purge using the token from step 1. Deletion
 * begins asynchronously (irreversible). Returns the operation id for tracking.
 * Syntax: `.purge table ["T"] records in database ["DB"] with(verificationtoken=h'…') <| where …`
 */
export async function executePurgeCommit(
  database: string,
  table: string,
  predicateWhere: string,
  verificationToken: string,
): Promise<PurgeCommitResult> {
  const csl =
    `.purge table ["${table}"] records in database ["${database}"]` +
    ` with(verificationtoken=h'${verificationToken.replace(/'/g, "\\'")}')` +
    ` <| ${predicateWhere}`;
  const json = await postMgmtDm(database, csl);
  const cols: string[] = ((json?.Tables?.[0]?.Columns) || []).map((c: any) => String(c.ColumnName));
  const row: unknown[] = json?.Tables?.[0]?.Rows?.[0] || [];
  return {
    operationId: String(row[purgeColIdx(cols, 'operationid')] ?? row[purgeColIdx(cols, 'operation')] ?? ''),
    state: String(row[purgeColIdx(cols, 'state')] ?? 'Scheduled'),
    databaseName: String(row[purgeColIdx(cols, 'database')] ?? database),
    tableName: String(row[purgeColIdx(cols, 'table')] ?? table),
    scheduledTime: String(row[purgeColIdx(cols, 'scheduled')] ?? ''),
  };
}

// ============================================================
// kusto-mgmt-client surface — typed list/create/delete for the
// ADX/KQL database navigator (adx-database-tree).
//
// Every call below issues a real Kusto control command to
// `/v1/rest/mgmt` via {@link executeMgmtCommand}. No mocks.
// Grounded in Microsoft Learn (Kusto management commands):
//   .show tables details / .show functions / .show materialized-views
//   .show ingestion mappings / .show continuous-exports
//   .show database schema as json
//   .create table / .create-or-alter function / .create materialized-view
//   .create-or-alter table ... ingestion <kind> mapping
//   .drop table / .drop function / .drop materialized-view
//   .drop <table|database> ... ingestion <kind> mapping
// ============================================================

/** Safe-quote a KQL entity name as a bracketed string literal: `["name"]`. */
export function qName(name: string): string {
  return `["${name.replace(/"/g, '\\"')}"]`;
}

export interface KustoTableDetail {
  name: string;
  folder?: string;
  docString?: string;
  totalRowCount?: number;
  totalExtentSizeMb?: number;
  hotExtentSizeMb?: number;
}

/** `.show tables details` — tables with row counts + size (navigator counts). */
export async function listTableDetails(db: string): Promise<KustoTableDetail[]> {
  const r = await executeMgmtCommand(db, '.show tables details');
  const idx = (c: string) => r.columns.indexOf(c);
  const nameIdx = idx('TableName');
  const folderIdx = idx('Folder');
  const docIdx = idx('DocString');
  const rowsIdx = idx('TotalRowCount');
  const totSizeIdx = idx('TotalExtentSize');
  const hotSizeIdx = idx('HotExtentSize');
  const toMb = (v: unknown) => (typeof v === 'number' ? v / (1024 * 1024) : undefined);
  return r.rows.map((row) => ({
    name: String(row[nameIdx >= 0 ? nameIdx : 0]),
    folder: folderIdx >= 0 ? (row[folderIdx] as string) : undefined,
    docString: docIdx >= 0 ? (row[docIdx] as string) : undefined,
    totalRowCount: rowsIdx >= 0 ? (row[rowsIdx] as number) : undefined,
    totalExtentSizeMb: totSizeIdx >= 0 ? toMb(row[totSizeIdx]) : undefined,
    hotExtentSizeMb: hotSizeIdx >= 0 ? toMb(row[hotSizeIdx]) : undefined,
  }));
}

export interface KustoIngestionMapping {
  name: string;
  kind: string; // csv | json | avro | parquet | orc | w3clogfile
  table?: string; // empty/undefined → database-scoped mapping
  mapping?: string; // the JSON definition
}

/** `.show ingestion mappings` — every mapping (all kinds, db + table scope). */
export async function listIngestionMappings(db: string): Promise<KustoIngestionMapping[]> {
  const r = await executeMgmtCommand(db, '.show ingestion mappings');
  const idx = (c: string) => r.columns.indexOf(c);
  const nameIdx = idx('Name');
  const kindIdx = idx('Kind');
  const tableIdx = idx('Table');
  const mapIdx = idx('Mapping');
  return r.rows.map((row) => ({
    name: String(row[nameIdx >= 0 ? nameIdx : 0]),
    kind: kindIdx >= 0 ? String(row[kindIdx] || '') : '',
    table: tableIdx >= 0 ? (row[tableIdx] as string) || undefined : undefined,
    mapping: mapIdx >= 0 ? (row[mapIdx] as string) : undefined,
  }));
}

export interface KustoContinuousExport {
  name: string;
  externalTableName?: string;
  isRunning?: boolean;
  isDisabled?: boolean;
  lastRunResult?: string;
  exportedTo?: string;
}

/** `.show continuous-exports` — read-only continuous export jobs. */
export async function listContinuousExports(db: string): Promise<KustoContinuousExport[]> {
  const r = await executeMgmtCommand(db, '.show continuous-exports');
  const idx = (c: string) => r.columns.indexOf(c);
  const nameIdx = idx('Name');
  const extIdx = idx('ExternalTableName');
  const runIdx = idx('IsRunning');
  const disIdx = idx('IsDisabled');
  const resIdx = idx('LastRunResult');
  const expIdx = idx('ExportedTo');
  return r.rows.map((row) => ({
    name: String(row[nameIdx >= 0 ? nameIdx : 0]),
    externalTableName: extIdx >= 0 ? (row[extIdx] as string) : undefined,
    isRunning: runIdx >= 0 ? Boolean(row[runIdx]) : undefined,
    isDisabled: disIdx >= 0 ? Boolean(row[disIdx]) : undefined,
    lastRunResult: resIdx >= 0 ? (row[resIdx] as string) : undefined,
    exportedTo: expIdx >= 0 ? (row[expIdx] as string | undefined)?.toString() : undefined,
  }));
}

// ============================================================
// External Delta tables + query acceleration — the "lakehouse /
// warehouse endpoint" surface. Binds an ADLS Gen2 Delta Lake path to an
// ADX external table (schema auto-inferred from the delta log) and turns
// on the query_acceleration policy so the Delta data is queryable via KQL
// within seconds. Grounded in Microsoft Learn:
//   .create-or-alter external table … kind=delta
//     https://learn.microsoft.com/kusto/management/external-tables-delta-lake
//   .alter external table … policy query_acceleration
//     https://learn.microsoft.com/kusto/management/alter-query-acceleration-policy-command
//   .show external table … policy query_acceleration
//     https://learn.microsoft.com/kusto/management/show-query-acceleration-policy-command
//   external_table() + managed-identity storage auth
//     https://learn.microsoft.com/azure/data-explorer/external-tables-managed-identities
// ============================================================

export interface KustoExternalTable {
  name: string;
  tableType?: string; // 'Delta' for delta external tables
  folder?: string;
  docString?: string;
  properties?: string; // raw JSON properties blob
}

/** `.show external tables` — list every external table in a database. */
export async function listExternalTables(db: string): Promise<KustoExternalTable[]> {
  const r = await executeMgmtCommand(db, '.show external tables');
  const idx = (c: string) => r.columns.indexOf(c);
  const nameIdx = idx('TableName');
  const typeIdx = idx('TableType');
  const folderIdx = idx('Folder');
  const docIdx = idx('DocString');
  const propIdx = idx('Properties');
  return r.rows.map((row) => ({
    name: String(row[nameIdx >= 0 ? nameIdx : 0]),
    tableType: typeIdx >= 0 ? (row[typeIdx] as string) || undefined : undefined,
    folder: folderIdx >= 0 ? (row[folderIdx] as string) || undefined : undefined,
    docString: docIdx >= 0 ? (row[docIdx] as string) || undefined : undefined,
    properties: propIdx >= 0 ? (row[propIdx] as string) || undefined : undefined,
  }));
}

/**
 * `.create-or-alter external table T kind=delta (connStr) with (...)`.
 *
 * `abfssUri` is the Delta table ROOT (e.g.
 * `abfss://bronze@acct.dfs.core.windows.net/path`). Storage auth uses the
 * cluster system-assigned MI (`;managed_identity=system`) by default, or a
 * user-assigned MI object id when `opts.miObjectId` is supplied. The schema is
 * omitted so ADX auto-infers it from the latest delta-log version.
 *
 * Requires AllDatabasesAdmin on the cluster (the Console UAMI already holds
 * this); the cluster's MI must hold Storage Blob Data Reader on the ADLS
 * account. No Fabric / OneLake dependency — works against the stand-alone ADX
 * cluster.
 */
export async function createExternalDeltaTable(
  db: string,
  name: string,
  abfssUri: string,
  opts?: { folder?: string; docString?: string; miObjectId?: string },
): Promise<KustoQueryResult> {
  if (!name.trim()) throw new KustoError('createExternalDeltaTable: name is required', 400);
  const uri = abfssUri.trim();
  if (!uri || !/^abfss:\/\//i.test(uri)) {
    throw new KustoError('createExternalDeltaTable: abfssUri must be an abfss:// URI', 400);
  }
  const auth = opts?.miObjectId ? `;managed_identity=${opts.miObjectId}` : ';managed_identity=system';
  const connStr = `h@'${uri}${auth}'`;
  const withParts: string[] = [];
  if (opts?.folder) withParts.push(`folder = "${opts.folder.replace(/"/g, '\\"')}"`);
  if (opts?.docString) withParts.push(`docstring = "${opts.docString.replace(/"/g, '\\"')}"`);
  const withClause = withParts.length ? ` with (${withParts.join(', ')})` : '';
  const command = `.create-or-alter external table ${qName(name)}\nkind=delta\n(\n  ${connStr}\n)${withClause}`;
  return executeMgmtCommand(db, command);
}

/**
 * `.alter external table T policy query_acceleration '{"IsEnabled":true,"Hot":"Nd"}'`.
 *
 * `hotDays` is the number of days of Delta data cached for sub-second KQL
 * queries (minimum 1). The background caching job starts within seconds;
 * full build time scales with the Delta table size. Requires Database Admin.
 */
export async function setQueryAccelerationPolicy(
  db: string,
  externalTableName: string,
  hotDays: number,
): Promise<KustoQueryResult> {
  if (!externalTableName.trim()) {
    throw new KustoError('setQueryAccelerationPolicy: externalTableName is required', 400);
  }
  if (!Number.isFinite(hotDays) || hotDays < 1) {
    throw new KustoError('setQueryAccelerationPolicy: hotDays must be >= 1', 400);
  }
  const policy = JSON.stringify({ IsEnabled: true, Hot: `${Math.floor(hotDays)}.00:00:00` });
  const command = `.alter external table ${qName(externalTableName)} policy query_acceleration '${policy}'`;
  return executeMgmtCommand(db, command);
}

export interface QueryAccelerationPolicyResult {
  policyName?: string;
  entityName?: string;
  policy?: unknown;
  raw: string;
}

/**
 * `.show external table T policy query_acceleration` — the applied policy
 * (the receipt). Returns null when no policy is set on the table.
 */
export async function showQueryAccelerationPolicy(
  db: string,
  externalTableName: string,
): Promise<QueryAccelerationPolicyResult | null> {
  const r = await executeMgmtCommand(
    db,
    `.show external table ${qName(externalTableName)} policy query_acceleration`,
  );
  if (!r.rows.length) return null;
  const polIdx = r.columns.indexOf('Policy');
  const nameIdx = r.columns.indexOf('PolicyName');
  const entityIdx = r.columns.indexOf('EntityName');
  const raw = String(r.rows[0][polIdx >= 0 ? polIdx : r.columns.length - 1] ?? '');
  let policy: unknown = raw;
  try { policy = JSON.parse(raw); } catch { /* keep raw string */ }
  return {
    policyName: nameIdx >= 0 ? (r.rows[0][nameIdx] as string) : undefined,
    entityName: entityIdx >= 0 ? (r.rows[0][entityIdx] as string) : undefined,
    policy,
    raw,
  };
}

/**
 * The data formats an Azure-Storage external table may carry. Limited to the
 * four export-capable formats when the table is a continuous-export target —
 * Microsoft Learn: "When using an external table for export scenario, you're
 * limited to the following formats: CSV, TSV, JSON, and Parquet."
 *   https://learn.microsoft.com/kusto/management/external-tables-azure-storage
 */
export const KUSTO_EXTERNAL_TABLE_FORMATS = ['csv', 'tsv', 'json', 'parquet'] as const;
export type KustoExternalTableFormat = typeof KUSTO_EXTERNAL_TABLE_FORMATS[number];

/**
 * `.create-or-alter external table T (schema) kind=storage dataformat=<f>
 *   ( h@'<abfssUri>;managed_identity=system' )`.
 *
 * Creates an **Azure Storage** external table (the explicit-schema sibling of
 * {@link createExternalDeltaTable}, which auto-infers from the Delta log). The
 * schema is a structured `col:type, col:type` CSL string assembled by the UI's
 * ColumnGridDesigner — never raw KQL — so the loom-no-freeform-config rule is
 * honored. Storage auth uses the cluster system-assigned MI by default, or a
 * user-assigned MI object id via `opts.miObjectId`.
 *
 * Requires Database User (.create) / Table Admin (.alter) — the Console UAMI
 * holds AllDatabasesAdmin, which covers both. The cluster's MI needs Storage
 * Blob Data Reader (read) / Contributor (continuous-export write) on the ADLS
 * account. No Fabric / OneLake dependency — pure ADX ↔ ADLS Gen2.
 *
 * Grounded in Microsoft Learn:
 *   .create-or-alter external table … kind=storage
 *     https://learn.microsoft.com/kusto/management/external-tables-azure-storage
 *   managed-identity storage auth
 *     https://learn.microsoft.com/azure/data-explorer/external-tables-managed-identities
 */
export async function createExternalStorageTable(
  db: string,
  name: string,
  schema: string,
  abfssUri: string,
  dataFormat: KustoExternalTableFormat,
  opts?: { folder?: string; docString?: string; miObjectId?: string },
): Promise<KustoQueryResult> {
  if (!name.trim()) throw new KustoError('createExternalStorageTable: name is required', 400);
  const cslSchema = schema.trim();
  if (!cslSchema) throw new KustoError('createExternalStorageTable: schema is required', 400);
  if (!/^([A-Za-z_][A-Za-z0-9_]*\s*:\s*[A-Za-z]+)(\s*,\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*[A-Za-z]+)*$/.test(cslSchema)) {
    throw new KustoError('createExternalStorageTable: schema must be a CSL list of col:type pairs', 400);
  }
  const uri = abfssUri.trim();
  if (!uri || !/^abfss:\/\//i.test(uri)) {
    throw new KustoError('createExternalStorageTable: abfssUri must be an abfss:// URI', 400);
  }
  if (!(KUSTO_EXTERNAL_TABLE_FORMATS as readonly string[]).includes(dataFormat)) {
    throw new KustoError(`createExternalStorageTable: dataFormat must be one of ${KUSTO_EXTERNAL_TABLE_FORMATS.join(', ')}`, 400);
  }
  const auth = opts?.miObjectId ? `;managed_identity=${opts.miObjectId}` : ';managed_identity=system';
  const connStr = `h@'${uri}${auth}'`;
  const withParts: string[] = [];
  if (opts?.folder) withParts.push(`folder = "${opts.folder.replace(/"/g, '\\"')}"`);
  if (opts?.docString) withParts.push(`docstring = "${opts.docString.replace(/"/g, '\\"')}"`);
  const withClause = withParts.length ? ` with (${withParts.join(', ')})` : '';
  const command = `.create-or-alter external table ${qName(name)} (${cslSchema})\nkind=storage\ndataformat=${dataFormat}\n(\n  ${connStr}\n)${withClause}`;
  return executeMgmtCommand(db, command);
}

/**
 * `.drop external table T` — removes the external-table *definition* (the
 * referenced storage data is NOT deleted). Microsoft Learn:
 *   https://learn.microsoft.com/kusto/management/drop-external-table
 * Requires Database Admin. `ifexists` makes the drop idempotent.
 */
export async function dropExternalTable(db: string, name: string): Promise<KustoQueryResult> {
  if (!name.trim()) throw new KustoError('dropExternalTable: name is required', 400);
  return executeMgmtCommand(db, `.drop external table ${qName(name)} ifexists`);
}

/**
 * `.create-or-alter function NAME() { external_table("T") }` — a stored KQL
 * function that wraps the external Delta table so callers can query the
 * mirrored view with a clean `NAME()` invocation instead of remembering the
 * `external_table(...)` syntax. This is the "mirrored KQL view".
 */
export async function createExternalTableView(
  db: string,
  viewName: string,
  externalTableName: string,
): Promise<KustoQueryResult> {
  if (!viewName.trim() || !externalTableName.trim()) {
    throw new KustoError('createExternalTableView: viewName and externalTableName are required', 400);
  }
  const body = `external_table("${externalTableName.replace(/"/g, '\\"')}")`;
  return executeMgmtCommand(
    db,
    `.create-or-alter function with (folder = "Loom Delta", docstring = "Delta view via CSA Loom") ${viewName}() { ${body} }`,
  );
}

export interface KustoDatabasePolicy {
  /** Policy name: retention | caching | sharding | mergepolicy | streamingingestion. */
  kind: string;
  /** Parsed policy object (or the raw string if it didn't parse as JSON). */
  policy: unknown;
  /** The raw policy JSON string as returned by Kusto. */
  raw: string;
}

/**
 * `.show database <db> policy <kind>` for each read-only database policy.
 *
 * Issues one real management command per policy via {@link executeMgmtCommand},
 * each wrapped in try/catch so a policy that is unset / unsupported on this
 * cluster is simply skipped (NOT surfaced as an error). Each command returns a
 * row with a "Policy" column holding the policy JSON string; we parse it for
 * `policy` and keep the original string in `raw`. Only policies that actually
 * returned a row are included. No mocks — every value comes from the live
 * cluster. Read-only: the navigator never alters these.
 */
export async function showDatabasePolicies(db: string): Promise<KustoDatabasePolicy[]> {
  const kinds = ['retention', 'caching', 'sharding', 'mergepolicy', 'streamingingestion'];
  const out: KustoDatabasePolicy[] = [];
  for (const kind of kinds) {
    try {
      const r = await executeMgmtCommand(db, `.show database ${qName(db)} policy ${kind}`);
      if (!r.rows.length) continue;
      const polIdx = r.columns.indexOf('Policy');
      const idx = polIdx >= 0 ? polIdx : r.columns.length - 1;
      const raw = String(r.rows[0][idx] ?? '');
      let policy: unknown = raw;
      try { policy = JSON.parse(raw); } catch { policy = raw; }
      out.push({ kind, policy, raw });
    } catch {
      // Missing / unsupported policy on this database — skip, not an error.
    }
  }
  return out;
}

// ============================================================
// Cluster capacity policy + live capacity (Capacity / throttle panel).
//
// Grounded in Microsoft Learn (Kusto management commands):
//   .show cluster policy capacity  — full capacity policy JSON (AllDatabasesMonitor)
//   .show capacity                 — live slot utilization for every op type
//   .alter-merge cluster policy capacity ```<json>``` — patch the policy (AllDatabasesAdmin)
// The capacity policy object components: IngestionCapacity, ExportCapacity,
// ExtentsMergeCapacity, ExtentsPartitionCapacity, MaterializedViewsCapacity,
// QueryAccelerationCapacity, … (see capacity-policy doc).
// ============================================================

/** Allow-listed capacity-policy component names a Loom user may patch. */
export const CAPACITY_POLICY_COMPONENTS = [
  'IngestionCapacity',
  'ExportCapacity',
  'ExtentsMergeCapacity',
  'ExtentsPartitionCapacity',
  'MaterializedViewsCapacity',
] as const;
export type CapacityPolicyComponent = (typeof CAPACITY_POLICY_COMPONENTS)[number];

/**
 * `.show cluster policy capacity` — the full cluster capacity policy as a
 * parsed JSON object (`{ IngestionCapacity: {…}, ExportCapacity: {…}, … }`).
 * Requires AllDatabasesMonitor (the Console UAMI holds AllDatabasesAdmin which
 * is a superset). Runs against NetDefaultDB like the other cluster-scope
 * commands. The command returns a single row; the policy JSON lives in a
 * "Policy" column (some cluster builds name it "PolicyText") — we scan the row
 * for the cell that parses to a JSON object carrying a capacity component.
 */
export async function showClusterCapacityPolicy(): Promise<Record<string, unknown>> {
  const r = await executeMgmtCommand('NetDefaultDB', '.show cluster policy capacity');
  if (!r.rows.length) return {};
  const row = r.rows[0];
  // Prefer an explicitly named column.
  const named = ['Policy', 'PolicyText', 'PolicyName'];
  for (const colName of named) {
    const idx = r.columns.indexOf(colName);
    if (idx >= 0) {
      const parsed = tryParsePolicy(row[idx]);
      if (parsed) return parsed;
    }
  }
  // Fallback: scan every cell for a JSON object that looks like a capacity policy.
  for (const cell of row) {
    const parsed = tryParsePolicy(cell);
    if (parsed) return parsed;
  }
  return {};
}

function tryParsePolicy(cell: unknown): Record<string, unknown> | null {
  if (typeof cell !== 'string') return null;
  const t = cell.trim();
  if (!t.startsWith('{')) return null;
  try {
    const obj = JSON.parse(t);
    if (obj && typeof obj === 'object') return obj as Record<string, unknown>;
  } catch { /* not the JSON cell */ }
  return null;
}

export interface CapacitySlot {
  resource: string;
  total: number;
  consumed: number;
  remaining: number;
  origin: string;
}

/**
 * `.show capacity` — live slot utilization for every data-management operation
 * type. Columns: Resource | Total | Consumed | Remaining | Origin. Requires
 * Database User (the UAMI has it). Runs against NetDefaultDB (cluster scope).
 */
export async function showCapacitySlots(): Promise<CapacitySlot[]> {
  const r = await executeMgmtCommand('NetDefaultDB', '.show capacity');
  const idx = (c: string) => r.columns.indexOf(c);
  const resIdx = idx('Resource');
  const totIdx = idx('Total');
  const conIdx = idx('Consumed');
  const remIdx = idx('Remaining');
  const oriIdx = idx('Origin');
  const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);
  return r.rows.map((row) => ({
    resource: String(row[resIdx >= 0 ? resIdx : 0] ?? ''),
    total: num(row[totIdx >= 0 ? totIdx : 1]),
    consumed: num(row[conIdx >= 0 ? conIdx : 2]),
    remaining: num(row[remIdx >= 0 ? remIdx : 3]),
    origin: String(row[oriIdx >= 0 ? oriIdx : 4] ?? ''),
  }));
}

/**
 * `.alter-merge cluster policy capacity ```<json>``` ` — patch-merge one or
 * more capacity-policy components into the existing policy (un-mentioned
 * components are preserved). Requires AllDatabasesAdmin. `patch` keys MUST be
 * allow-listed capacity component names. Returns the raw mgmt result (the new
 * effective policy).
 */
export async function alterMergeCapacityPolicy(patch: Record<string, unknown>): Promise<KustoQueryResult> {
  const keys = Object.keys(patch || {});
  if (!keys.length) throw new KustoError('alterMergeCapacityPolicy: patch must contain at least one capacity component', 400);
  for (const k of keys) {
    if (!(CAPACITY_POLICY_COMPONENTS as readonly string[]).includes(k)) {
      throw new KustoError(`alterMergeCapacityPolicy: unsupported component "${k}"`, 400);
    }
  }
  const json = JSON.stringify(patch);
  const command = `.alter-merge cluster policy capacity \`\`\`${json}\`\`\``;
  return executeMgmtCommand('NetDefaultDB', command);
}

export interface KustoUpdatePolicyEntry {
  IsEnabled: boolean;
  Source: string;
  Query: string;
  IsTransactional: boolean;
  PropagateIngestionProperties: boolean;
}

/**
 * `.alter table ["<target>"] policy update @'[...]'` — set the table update
 * policy (transform-on-ingest ETL). `policies` is the serialized array of
 * policy objects; each fires the `Query` (a stored function call or inline KQL
 * over the `Source` table) whenever data lands in `Source`, routing the
 * transformed rows into `<target>`. Uses the `@'...'` verbatim-string form so
 * the embedded JSON only needs single-quote escaping (same pattern as
 * {@link createIngestionMapping}). Real Kusto control command — no mocks.
 *
 * @see https://learn.microsoft.com/azure/data-explorer/kusto/management/alter-table-update-policy-command
 */
export async function setTableUpdatePolicy(
  db: string,
  targetTable: string,
  policies: KustoUpdatePolicyEntry[],
): Promise<KustoQueryResult> {
  const escaped = JSON.stringify(policies).replace(/'/g, "\\'");
  return executeMgmtCommand(
    db,
    `.alter table ${qName(targetTable)} policy update @'${escaped}'`,
  );
}

/**
 * `.show table ["<target>"] policy update` — read the table's update policy.
 * Returns the parsed policy plus the raw JSON string Kusto reports back (the
 * "receipt" confirming the cluster accepted the config), or null when the
 * command returns no rows. Mirrors {@link showDatabasePolicies} in shape.
 *
 * @see https://learn.microsoft.com/azure/data-explorer/kusto/management/show-table-update-policy-command
 */
export async function showTableUpdatePolicy(
  db: string,
  targetTable: string,
): Promise<{ policy: unknown; raw: string } | null> {
  const r = await executeMgmtCommand(db, `.show table ${qName(targetTable)} policy update`);
  if (!r.rows.length) return null;
  const polIdx = r.columns.indexOf('Policy');
  const idx = polIdx >= 0 ? polIdx : r.columns.length - 1;
  const raw = String(r.rows[0][idx] ?? '');
  let policy: unknown = raw;
  try { policy = JSON.parse(raw); } catch { policy = raw; }
  return { policy, raw };
}

// ============================================================
// Database / table RBAC — Kusto data-plane principal management.
//
// ADX database & table security roles are NOT Azure RBAC roleDefinitions; they
// are assigned with Kusto control commands against /v1/rest/mgmt. The caller
// (Console UAMI) holds AllDatabasesAdmin on the cluster (adx-cluster.bicep
// `adxConsoleAdmin` principalAssignment), so it can add/drop database- and
// table-scoped principals. Grounded in Microsoft Learn:
//   .show database <db> principals / .show table <T> principals
//   .add/.drop database <db> <role> ('<fqn>')
//   .add/.drop table <T> <role> ('<fqn>')
// Database roles: admins | users | viewers | unrestrictedviewers | ingestors | monitors
// Table roles:    admins | ingestors
// Principal FQN:  aaduser=<email>  |  aadapp=<appId>;<tenantId>  |  aadgroup=<email>
// No mocks — every value comes from a live control command.
// ============================================================

/** Database-scoped security roles a Loom user may assign. */
export const KUSTO_DATABASE_ROLES = [
  'admins', 'users', 'viewers', 'unrestrictedviewers', 'ingestors', 'monitors',
] as const;
export type KustoDatabaseRole = (typeof KUSTO_DATABASE_ROLES)[number];

/** Table-scoped security roles (ADX exposes only these two at table scope). */
export const KUSTO_TABLE_ROLES = ['admins', 'ingestors'] as const;
export type KustoTableRole = (typeof KUSTO_TABLE_ROLES)[number];

export type KustoPrincipalType = 'User' | 'App' | 'Group';

export interface KustoPrincipalRow {
  role: string;
  principalType: string;
  displayName: string;
  objectId: string;
  fqn: string;
}

/**
 * Build the Kusto principal FQN literal from a structured type + value.
 *   User  → aaduser=<email>
 *   App   → aadapp=<appId>;<tenantId>   (value already in "appId;tenantId" form)
 *   Group → aadgroup=<email-or-objectId>
 * Exported so the BFF route assembles the FQN server-side (the UI never builds
 * raw KQL — loom-no-freeform-config). Throws on an obviously malformed value.
 */
export function buildKustoPrincipalFqn(type: KustoPrincipalType, value: string): string {
  const v = (value || '').trim();
  if (!v) throw new KustoError('buildKustoPrincipalFqn: principal value is required', 400);
  // FQN literals are embedded inside a single-quoted KQL string; reject quotes
  // / parens so we can't break out of the literal.
  if (/['()]/.test(v)) {
    throw new KustoError('buildKustoPrincipalFqn: principal value contains illegal characters', 400);
  }
  if (type === 'App') {
    // appId;tenantId — both required for an application principal.
    if (!/^[^;]+;[^;]+$/.test(v)) {
      throw new KustoError("buildKustoPrincipalFqn: App principal must be 'appId;tenantId'", 400);
    }
    return `aadapp=${v}`;
  }
  if (v.includes(';')) {
    throw new KustoError('buildKustoPrincipalFqn: User/Group value must not contain ";"', 400);
  }
  return type === 'Group' ? `aadgroup=${v}` : `aaduser=${v}`;
}

function shapePrincipalRows(r: KustoQueryResult): KustoPrincipalRow[] {
  const idx = (c: string) => r.columns.indexOf(c);
  const roleIdx = idx('Role');
  const typeIdx = idx('PrincipalType');
  const nameIdx = idx('PrincipalDisplayName');
  const oidIdx = idx('PrincipalObjectId');
  const fqnIdx = idx('PrincipalFQN');
  return r.rows.map((row) => ({
    role: String(row[roleIdx >= 0 ? roleIdx : 0] ?? ''),
    principalType: typeIdx >= 0 ? String(row[typeIdx] ?? '') : '',
    displayName: nameIdx >= 0 ? String(row[nameIdx] ?? '') : '',
    objectId: oidIdx >= 0 ? String(row[oidIdx] ?? '') : '',
    fqn: fqnIdx >= 0 ? String(row[fqnIdx] ?? '') : '',
  }));
}

/** `.show database ["db"] principals` — every assigned database-scope principal. */
export async function showDatabasePrincipals(db: string): Promise<KustoPrincipalRow[]> {
  const r = await executeMgmtCommand(db, `.show database ${qName(db)} principals`);
  return shapePrincipalRows(r);
}

/** `.show table ["T"] principals` — every assigned table-scope principal. */
export async function showTablePrincipals(db: string, table: string): Promise<KustoPrincipalRow[]> {
  if (!table.trim()) throw new KustoError('showTablePrincipals: table is required', 400);
  const r = await executeMgmtCommand(db, `.show table ${qName(table)} principals`);
  return shapePrincipalRows(r);
}

function assertDatabaseRole(role: string): KustoDatabaseRole {
  if (!(KUSTO_DATABASE_ROLES as readonly string[]).includes(role)) {
    throw new KustoError(`Unsupported database role "${role}"`, 400);
  }
  return role as KustoDatabaseRole;
}
function assertTableRole(role: string): KustoTableRole {
  if (!(KUSTO_TABLE_ROLES as readonly string[]).includes(role)) {
    throw new KustoError(`Unsupported table role "${role}" (table scope allows admins | ingestors)`, 400);
  }
  return role as KustoTableRole;
}

/** `.add database ["db"] <role> ('<fqn>') skip-results`. */
export async function addDatabasePrincipal(db: string, role: string, fqn: string): Promise<KustoQueryResult> {
  const r = assertDatabaseRole(role);
  return executeMgmtCommand(db, `.add database ${qName(db)} ${r} ('${fqn}') skip-results`);
}
/** `.drop database ["db"] <role> ('<fqn>') skip-results`. */
export async function dropDatabasePrincipal(db: string, role: string, fqn: string): Promise<KustoQueryResult> {
  const r = assertDatabaseRole(role);
  return executeMgmtCommand(db, `.drop database ${qName(db)} ${r} ('${fqn}') skip-results`);
}
/** `.add table ["T"] <role> ('<fqn>') skip-results`. */
export async function addTablePrincipal(db: string, table: string, role: string, fqn: string): Promise<KustoQueryResult> {
  if (!table.trim()) throw new KustoError('addTablePrincipal: table is required', 400);
  const r = assertTableRole(role);
  return executeMgmtCommand(db, `.add table ${qName(table)} ${r} ('${fqn}') skip-results`);
}
/** `.drop table ["T"] <role> ('<fqn>') skip-results`. */
export async function dropTablePrincipal(db: string, table: string, role: string, fqn: string): Promise<KustoQueryResult> {
  if (!table.trim()) throw new KustoError('dropTablePrincipal: table is required', 400);
  const r = assertTableRole(role);
  return executeMgmtCommand(db, `.drop table ${qName(table)} ${r} ('${fqn}') skip-results`);
}

// ============================================================
// Row-Level Security (RLS) policy authoring — Kusto control commands.
//
// Grounded in Microsoft Learn (Row Level Security policy):
//   .alter table ["T"] policy row_level_security enable|disable "<KQL query>"
//   .show  table ["T"] policy row_level_security
// The Query parameter is a full KQL expression string (or a stored-function
// call like "MyRlsFunction()"). Requires Table Admin / Database Admin — the
// Console UAMI holds AllDatabasesAdmin. The query validator lives in
// kusto-rls-predicate.ts (re-exported below) and runs server-side before the
// command is issued. No Fabric dependency — applies to ADX + Eventhouse alike.
// ============================================================

export { KUSTO_RLS_QUERY_MAX, validateKustoRlsQuery } from './kusto-rls-predicate';

export interface KustoRlsPolicy {
  isEnabled: boolean;
  query: string;
  raw: string;
}

/**
 * `.show table ["T"] policy row_level_security` — the current RLS policy.
 * The Policy column carries `{ "Query": "...", "IsEnabled": true|false }`.
 * Returns null when no RLS policy is set on the table.
 */
export async function showTableRlsPolicy(db: string, table: string): Promise<KustoRlsPolicy | null> {
  if (!table.trim()) throw new KustoError('showTableRlsPolicy: table is required', 400);
  const r = await executeMgmtCommand(db, `.show table ${qName(table)} policy row_level_security`);
  if (!r.rows.length) return null;
  const polIdx = r.columns.indexOf('Policy');
  const idx = polIdx >= 0 ? polIdx : r.columns.length - 1;
  const raw = String(r.rows[0][idx] ?? '');
  if (!raw.trim()) return null;
  try {
    const p = JSON.parse(raw);
    return { isEnabled: !!p?.IsEnabled, query: String(p?.Query ?? ''), raw };
  } catch {
    return { isEnabled: false, query: '', raw };
  }
}

/**
 * `.alter table ["T"] policy row_level_security (enable|disable) "<query>"`.
 *
 * When enabling, `query` is the KQL predicate that filters rows for the calling
 * principal (validated by validateKustoRlsQuery before this is called by the
 * BFF). When disabling we still pass the query through so it is retained for a
 * later re-enable. A non-empty, validatable query is required to enable.
 */
export async function alterTableRlsPolicy(
  db: string, table: string, enabled: boolean, query: string,
): Promise<KustoQueryResult> {
  if (!table.trim()) throw new KustoError('alterTableRlsPolicy: table is required', 400);
  const q = (query || '').trim();
  if (enabled && !q) {
    throw new KustoError('alterTableRlsPolicy: a KQL predicate query is required to enable RLS', 400);
  }
  // The query is embedded in a double-quoted KQL string literal; escape any
  // embedded backslashes + double-quotes.
  const escaped = q.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const verb = enabled ? 'enable' : 'disable';
  return executeMgmtCommand(
    db,
    `.alter table ${qName(table)} policy row_level_security ${verb} "${escaped}"`,
  );
}

/** `.show database <db> schema as json` — flat read-only schema object. */
export async function getDatabaseSchemaJson(db: string): Promise<unknown> {
  const r = await executeMgmtCommand(db, `.show database ${qName(db)} schema as json`);
  if (!r.rows.length) return null;
  const schemaIdx = r.columns.findIndex((c) => /schema/i.test(c));
  const raw = r.rows[0][schemaIdx >= 0 ? schemaIdx : r.columns.length - 1];
  try { return JSON.parse(String(raw)); } catch { return raw; }
}

/** `.create table T (schema)` — schema is `col:type, col:type`. */
export async function createTable(db: string, name: string, schema: string): Promise<KustoQueryResult> {
  const cols = schema.trim();
  if (!cols) throw new KustoError('createTable: schema is required (e.g. "ts:datetime, value:long")', 400);
  return executeMgmtCommand(db, `.create table ${qName(name)} (${cols})`);
}

/**
 * `.alter-merge table T (schema)` — ADDITIVE schema change. New columns are
 * appended; existing columns and their data are preserved. This is the safe
 * "add column" path used by the schema designer's ALTER flow. (A full
 * `.alter table` replaces the schema and drops omitted columns with data loss,
 * so it is intentionally NOT exposed.) Requires Table Admin.
 * Grounded in Microsoft Learn: `.alter-merge table` command.
 */
export async function alterMergeTable(db: string, name: string, schema: string): Promise<KustoQueryResult> {
  const cols = schema.trim();
  if (!cols) throw new KustoError('alterMergeTable: schema is required (e.g. "newcol:string")', 400);
  return executeMgmtCommand(db, `.alter-merge table ${qName(name)} (${cols})`);
}

/**
 * `.show table T cslschema` — returns the table's schema as a CSL string
 * (`col:type,col:type`) for pre-populating the schema designer's ALTER grid.
 */
export async function getTableCslSchema(db: string, table: string): Promise<string> {
  const r = await executeMgmtCommand(db, `.show table ${qName(table)} cslschema`);
  if (!r.rows.length) return '';
  const schemaIdx = r.columns.findIndex((c) => /schema/i.test(c));
  return String(r.rows[0][schemaIdx >= 0 ? schemaIdx : 1] ?? '');
}

/** `.drop table T ifexists`. */
export async function dropTable(db: string, name: string): Promise<KustoQueryResult> {
  return executeMgmtCommand(db, `.drop table ${qName(name)} ifexists`);
}

/** `.create-or-alter function NAME(args) { body }`. */
export async function createFunction(
  db: string, name: string, args: string, body: string,
): Promise<KustoQueryResult> {
  const b = body.trim();
  if (!b) throw new KustoError('createFunction: body is required', 400);
  return executeMgmtCommand(
    db,
    `.create-or-alter function with (folder = "Loom", docstring = "Created via CSA Loom") ${name}(${args.trim()}) { ${b} }`,
  );
}

/** `.drop function NAME ifexists`. */
export async function dropFunction(db: string, name: string): Promise<KustoQueryResult> {
  return executeMgmtCommand(db, `.drop function ${name} ifexists`);
}

/**
 * `buildCreateMaterializedViewCommand` (pure command builder) lives in the
 * dependency-free `kusto-mv-command` module and is re-exported here for
 * callers that import from `kusto-client`. `createMaterializedView` is the
 * runtime entry point.
 */
export { buildCreateMaterializedViewCommand };

/**
 * `.create [async] materialized-view [with (backfill=true)] NAME on table SRC { query }`.
 *
 * When `opts.backfill` is true the view is created over the source table's
 * existing data. Per ADX/Eventhouse rules a backfilling create MUST be `async`
 * (the mgmt endpoint returns an operation row rather than blocking until the
 * backfill finishes — track it with `.show operations`).
 */
export async function createMaterializedView(
  db: string, name: string, sourceTable: string, query: string,
  opts?: { backfill?: boolean },
): Promise<KustoQueryResult> {
  if (!sourceTable.trim() || !query.trim()) {
    throw new KustoError('createMaterializedView: source table and query are required', 400);
  }
  return executeMgmtCommand(db, buildCreateMaterializedViewCommand(name, sourceTable, query, opts));
}

/** `.drop materialized-view NAME ifexists`. */
export async function dropMaterializedView(db: string, name: string): Promise<KustoQueryResult> {
  return executeMgmtCommand(db, `.drop materialized-view ${name} ifexists`);
}

/**
 * `.create-or-alter table T ingestion <kind> mapping "NAME" 'json'`.
 * `mappingJson` is the mapping definition formatted as a JSON value.
 */
export async function createIngestionMapping(
  db: string, table: string, kind: string, name: string, mappingJson: string,
): Promise<KustoQueryResult> {
  const k = kind.trim().toLowerCase();
  if (!table.trim()) throw new KustoError('createIngestionMapping: table is required', 400);
  if (!/^(csv|json|avro|parquet|orc|w3clogfile)$/.test(k)) {
    throw new KustoError(`createIngestionMapping: unsupported kind "${kind}"`, 400);
  }
  let json = mappingJson.trim();
  try { JSON.parse(json); } catch { throw new KustoError('createIngestionMapping: mapping must be valid JSON', 400); }
  // Single-quote the JSON literal; escape embedded single quotes the KQL way.
  json = json.replace(/'/g, "\\'");
  return executeMgmtCommand(
    db,
    `.create-or-alter table ${qName(table.trim())} ingestion ${k} mapping "${name}" '${json}'`,
  );
}

/** `.drop <table|database> ... ingestion <kind> mapping "NAME"`. */
export async function dropIngestionMapping(
  db: string, kind: string, name: string, table?: string,
): Promise<KustoQueryResult> {
  const k = kind.trim().toLowerCase();
  const scope = table && table.trim() ? `table ${qName(table.trim())}` : `database ${qName(db)}`;
  return executeMgmtCommand(db, `.drop ${scope} ingestion ${k} mapping "${name}"`);
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
 * `.create-or-alter external table <Name> kind=delta (h@'<abfssUri>;impersonate')`
 *
 * Creates the Delta external table that a continuous-export job writes into.
 * The `;impersonate` suffix routes storage auth through the cluster's
 * system-assigned managed identity — no SAS key or storage account key.
 *
 * Requires the cluster MI to hold Storage Blob Data Contributor on the
 * target ADLS Gen2 account (provisioned by adx-cluster.bicep).
 *
 * Per Learn:
 *   https://learn.microsoft.com/kusto/management/external-tables-delta-lake
 *   https://learn.microsoft.com/kusto/management/data-export/continuous-export-with-managed-identity
 *
 * @param db       KQL database name
 * @param extName  External table name (must be unique; must not clash with a regular table)
 * @param abfssUri Full abfss:// URI for the Delta folder (WITHOUT ;impersonate)
 *                 Example: abfss://bronze@mystorageaccount.dfs.core.windows.net/exports/orders
 */
export async function createOrAlterExternalTableDelta(
  db: string,
  extName: string,
  abfssUri: string,
): Promise<KustoQueryResult> {
  if (!extName.trim()) throw new KustoError('createOrAlterExternalTableDelta: extName required', 400);
  if (!/^abfss:\/\//i.test(abfssUri)) {
    throw new KustoError('createOrAlterExternalTableDelta: abfssUri must start with abfss://', 400);
  }
  // Escape single-quotes inside the URI for the KQL string literal.
  const escaped = abfssUri.replace(/'/g, "\\'");
  const cmd = `.create-or-alter external table ${qName(extName)} kind=delta (h@'${escaped};impersonate')`;
  return executeMgmtCommand(db, cmd);
}

/**
 * `.create-or-alter continuous-export <Name>
 *    over (<sourceTable>)
 *    to table <extTableName>
 *    with (intervalBetweenRuns=<interval>, managedIdentity=system)
 *  <| <sourceTable>`
 *
 * Exports new rows from a KQL fact table into a Delta external table on each
 * interval. Uses `managedIdentity=system` because the external table's
 * connection string uses impersonation (cluster system-assigned MI), which
 * is required per the Kusto docs.
 *
 * Per Learn:
 *   https://learn.microsoft.com/kusto/management/data-export/create-alter-continuous
 *
 * @param db           KQL database name
 * @param exportName   Unique continuous-export name within the database
 * @param sourceTable  Fact-table name in the database (the `over (T)` clause)
 * @param extTableName External Delta table name (created by createOrAlterExternalTableDelta)
 * @param interval     KQL timespan string: '5m' | '15m' | '1h' | '6h' | '24h' etc.
 *                     Minimum 1 minute per docs; recommended >= several minutes.
 */
export async function createOrAlterContinuousExport(
  db: string,
  exportName: string,
  sourceTable: string,
  extTableName: string,
  interval: string,
): Promise<KustoQueryResult> {
  if (!exportName.trim() || !sourceTable.trim() || !extTableName.trim() || !interval.trim()) {
    throw new KustoError('createOrAlterContinuousExport: all params required', 400);
  }
  // Validate interval looks like a KQL timespan (e.g. 5m, 1h, 24h)
  if (!/^\d+[smhd]$/.test(interval.trim())) {
    throw new KustoError(`createOrAlterContinuousExport: invalid interval "${interval}" — use KQL timespan e.g. 5m, 1h, 24h`, 400);
  }
  const cmd = [
    `.create-or-alter continuous-export ${qName(exportName)}`,
    `over (${qName(sourceTable)})`,
    `to table ${qName(extTableName)}`,
    `with (intervalBetweenRuns=${interval.trim()}, managedIdentity=system)`,
    `<| ${qName(sourceTable)}`,
  ].join(' ');
  return executeMgmtCommand(db, cmd);
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
    const t = await credential.getToken(armScope());
    if (!t?.token) throw new KustoError('Failed to acquire ARM token', 401);
    return t.token;
  })();
  const apiVersion = '2023-08-15';
  const url = `${armBase()}/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Kusto/clusters/${cluster}/databases/${encodeURIComponent(name)}?api-version=${apiVersion}`;
  const body = {
    location,
    kind: 'ReadWrite',
    properties: {
      softDeletePeriod: `P${opts?.softDeleteDays ?? 30}D`,
      hotCachePeriod: `P${opts?.hotCacheDays ?? 7}D`,
    },
  };
  const res = await fetchWithTimeout(url, {
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
  // App-install provisioning creates a DEDICATED ADX database for a
  // bundle-installed kql-database (e.g. 'Change_Feed_Monitoring') and seeds its
  // tables there, recording the real database name on
  // `state.provisioning.secondaryIds.database` / `state.provisioning.resourceId`.
  // Honor it so the query route + sibling Real-Time Dashboard target the
  // database where the tables ACTUALLY live — instead of the shared default DB
  // (which has none of those tables, surfacing as "Failed to resolve table").
  const prov = (item?.state as any)?.provisioning;
  if (prov && (prov.status === 'created' || prov.status === 'exists')) {
    const provDb = prov.secondaryIds?.database || prov.resourceId;
    if (typeof provDb === 'string' && provDb.trim()) return provDb.trim();
  }
  return DEFAULT_DB;
}

/**
 * Resolve the ADX database a kql-dashboard's tiles should query.
 *
 * A bundle-installed Real-Time Dashboard (e.g. "Change Feed Health") has no
 * database of its own — its tiles query the DEDICATED database that the sibling
 * `kql-database` item in the SAME app install provisions (e.g.
 * 'Change_Feed_Monitoring'). When the dashboard item itself carries no resolved
 * database, find that sibling and use its provisioned database, so the tiles
 * run against the database where the seeded tables actually live instead of the
 * shared default DB (where they don't exist → "Failed to resolve table").
 *
 * Falls back to the dashboard item's own resolveDatabase() when no provisioned
 * sibling is found (a hand-authored dashboard, or one whose db is explicit).
 */
export async function resolveDashboardDatabase(item: KustoItem | null): Promise<string> {
  if (!item) return DEFAULT_DB;
  // Explicit/own provisioned DB on the dashboard item wins.
  const own = resolveDatabase(item);
  if (own !== DEFAULT_DB) return own;
  try {
    const items = await itemsContainer();
    const { resources } = await items.items
      .query<KustoItem>({
        query: 'SELECT * FROM c WHERE c.workspaceId = @w AND c.itemType = @t',
        parameters: [
          { name: '@w', value: item.workspaceId },
          { name: '@t', value: 'kql-database' },
        ],
      }, { partitionKey: item.workspaceId })
      .fetchAll();
    // Prefer a sibling sharing the dashboard's sourceApp, else any provisioned one.
    const sourceApp = (item.state as any)?.sourceApp;
    const candidates = sourceApp
      ? resources.filter((r) => (r.state as any)?.sourceApp === sourceApp)
      : resources;
    for (const cand of (candidates.length ? candidates : resources)) {
      const db = resolveDatabase(cand);
      if (db !== DEFAULT_DB) return db;
    }
  } catch { /* best-effort — fall through to default */ }
  return own;
}
