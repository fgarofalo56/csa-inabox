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

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
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

/** Execute a KQL query. Returns the primary results table (Table_0). */
export async function executeQuery(database: string, kql: string): Promise<KustoQueryResult> {
  const started = Date.now();
  const json = await postRest('/v1/rest/query', database || DEFAULT_DB, kql);
  const tables = json?.Tables || [];
  const primary = tables.find((t: any) => t?.TableName === 'Table_0') || tables[0];
  const visualization = parseVisualization(tables);
  if (!primary) {
    return { columns: [], columnTypes: [], rows: [], rowCount: 0, executionMs: Date.now() - started, truncated: false, visualization };
  }
  const shaped = shapeTable(primary, Date.now() - started);
  return visualization ? { ...shaped, visualization } : shaped;
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
function qName(name: string): string {
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

/** `.create materialized-view NAME on table SRC { query }`. */
export async function createMaterializedView(
  db: string, name: string, sourceTable: string, query: string,
): Promise<KustoQueryResult> {
  if (!sourceTable.trim() || !query.trim()) {
    throw new KustoError('createMaterializedView: source table and query are required', 400);
  }
  return executeMgmtCommand(
    db,
    `.create materialized-view ${name} on table ${qName(sourceTable.trim())} { ${query.trim()} }`,
  );
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
