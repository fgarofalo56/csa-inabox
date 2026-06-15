/**
 * Data-quality monitor client — Azure-native, NO Microsoft Fabric dependency.
 *
 * Two complementary "always-on" DQ enforcement/observability mechanisms that
 * complement the on-demand rule run in {@link ./data-quality-client}:
 *
 *   1. Delta enforced constraints (Databricks SQL / any Delta table). A Loom DQ
 *      rule compiles 1:1 onto a Delta CHECK / NOT NULL constraint that the
 *      engine enforces on every write:
 *        not-null → ALTER TABLE t ALTER COLUMN c SET NOT NULL
 *        regex    → ALTER TABLE t ADD CONSTRAINT n CHECK (c RLIKE '<pat>')
 *        range    → ALTER TABLE t ADD CONSTRAINT n CHECK (c BETWEEN min AND max)
 *      Grounded in Microsoft Learn — "Constraints on Azure Databricks":
 *      https://learn.microsoft.com/azure/databricks/tables/constraints
 *
 *   2. Databricks data quality monitoring / data profiling (Unity Catalog). A
 *      snapshot/time-series profile that produces UC metric tables + a dashboard
 *      and can be refreshed on demand.
 *
 *      Default REST surface is the GA `data-quality` API, keyed by the table's
 *      UUID (`object_id` = `table_id`):
 *        POST   /api/data-quality/v1/monitors
 *        GET    /api/data-quality/v1/monitors/table/{table_id}
 *        DELETE /api/data-quality/v1/monitors/table/{table_id}
 *        POST   /api/data-quality/v1/monitors/table/{table_id}/refreshes
 *        GET    /api/data-quality/v1/monitors/table/{table_id}/refreshes
 *      Grounded in Microsoft Learn — "Create a data profile using the API"
 *      (databricks-sdk >= 0.68.0, `w.data_quality.create_monitor(...)`):
 *      https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/data-quality-monitoring/data-profiling/create-monitor-api
 *      and the REST reference https://docs.databricks.com/api/azure/workspace/dataquality
 *
 *      The earlier `quality_monitors` surface
 *      (`/api/2.1/unity-catalog/tables/{name}/monitor`) is DEPRECATED — Learn now
 *      says "Use the `data-quality` commands instead." It is retained here as an
 *      operator-selectable fallback (`LOOM_DBX_DQ_MONITOR_API=legacy`) for
 *      sovereign regions where the GA surface may not yet be enabled.
 *
 * Both run through the workspace's own Databricks SQL Warehouse / REST — no
 * Fabric, no Power BI. Honest config gate {@link dqMonitorConfigGate} surfaces
 * the exact missing env var (a MessageBar in the UI) when the workspace isn't
 * wired.
 */

import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { executeStatement } from './databricks-client';
import type { DqRule } from './data-quality-client';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';

const DBX_SCOPE = '2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
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

/**
 * Honest gate: a Databricks workspace + a SQL Warehouse are required for Delta
 * constraints; Lakehouse Monitoring additionally needs a Unity Catalog table.
 * Returns the exact missing env var so the BFF can 503 with a precise MessageBar.
 */
export function dqMonitorConfigGate(): { missing: string } | null {
  if (!process.env.LOOM_DATABRICKS_HOSTNAME) return { missing: 'LOOM_DATABRICKS_HOSTNAME' };
  if (!process.env.LOOM_DATABRICKS_SQL_WAREHOUSE_ID) return { missing: 'LOOM_DATABRICKS_SQL_WAREHOUSE_ID' };
  return null;
}

function warehouse(explicit?: string): string {
  const w = (explicit || process.env.LOOM_DATABRICKS_SQL_WAREHOUSE_ID || '').trim();
  if (!w) throw new Error('No Databricks SQL Warehouse — set LOOM_DATABRICKS_SQL_WAREHOUSE_ID');
  return w;
}

function safeIdent(seg: string): string {
  if (!/^[A-Za-z0-9_ $-]+$/.test(seg)) throw new Error(`Unsafe SQL identifier: "${seg}"`);
  return seg;
}
function quoteSpark(name: string): string {
  return name.split('.').map((s) => `\`${safeIdent(s)}\``).join('.');
}
/** Escape a Spark SQL single-quoted string literal. */
function sqlStr(v: string): string {
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Parse a DQ rule scope into its table (+ optional column). */
function parseScope(scope: string): { table: string; column?: string } {
  if (scope.startsWith('column:')) {
    const rest = scope.slice('column:'.length);
    const dot = rest.indexOf('.');
    if (dot < 0) return { table: rest };
    return { table: rest.slice(0, dot), column: rest.slice(dot + 1) };
  }
  if (scope.startsWith('table:')) return { table: scope.slice('table:'.length) };
  const dot = scope.indexOf('.');
  return dot < 0 ? { table: scope } : { table: scope.slice(0, dot), column: scope.slice(dot + 1) };
}

function fqTable(table: string, catalog?: string, schema?: string): string {
  if (table.includes('.')) return quoteSpark(table);
  const parts: string[] = [];
  if (catalog) parts.push(catalog);
  if (schema) parts.push(schema);
  parts.push(table);
  return quoteSpark(parts.join('.'));
}

// ---------------------------------------------------------------------------
// Delta enforced constraints
// ---------------------------------------------------------------------------

export interface DeltaConstraintResult {
  ruleId: string;
  name: string;
  /** The exact DDL executed (or the reason it could not be compiled). */
  ddl: string;
  applied: boolean;
  detail: string;
}

/** Sanitize a rule into a Delta constraint identifier. */
function constraintName(rule: DqRule): string {
  const base = `loom_${rule.check}_${rule.id}`.replace(/[^A-Za-z0-9_]/g, '_');
  return base.slice(0, 240);
}

/**
 * Compile a Loom DQ rule to its Delta-constraint DDL. Returns null when the
 * check has no enforced-constraint equivalent (unique / freshness — Delta does
 * not enforce uniqueness, and freshness is a profiling metric, not a row CHECK).
 */
export function compileDeltaConstraintDdl(
  rule: DqRule,
  catalog?: string,
  schema?: string,
): { ddl: string } | { unsupported: string } {
  const { table, column } = parseScope(rule.scope);
  const T = fqTable(table, catalog, schema);
  if (rule.check !== 'freshness' && !column) {
    return { unsupported: `${rule.check} needs a column scope (column:<table>.<col>)` };
  }
  const colName = column ? (column.includes('.') ? column.split('.').slice(1).join('.') : column) : '';
  const C = colName ? quoteSpark(colName) : '';
  const cn = quoteSpark(constraintName(rule));
  switch (rule.check) {
    case 'not-null':
      return { ddl: `ALTER TABLE ${T} ALTER COLUMN ${C} SET NOT NULL` };
    case 'regex':
      if (!rule.pattern) return { unsupported: 'regex rule needs a pattern' };
      return { ddl: `ALTER TABLE ${T} ADD CONSTRAINT ${cn} CHECK (CAST(${C} AS STRING) RLIKE ${sqlStr(rule.pattern)})` };
    case 'range':
      if (typeof rule.min !== 'number' || typeof rule.max !== 'number') {
        return { unsupported: 'range rule needs numeric min + max' };
      }
      return { ddl: `ALTER TABLE ${T} ADD CONSTRAINT ${cn} CHECK (${C} BETWEEN ${rule.min} AND ${rule.max})` };
    case 'unique':
      return { unsupported: 'Delta does not enforce UNIQUE — use Lakehouse Monitoring or the rule run instead' };
    case 'freshness':
      return { unsupported: 'freshness is a profiling metric, not an enforced constraint — use a monitor or the rule run' };
    default:
      return { unsupported: 'unknown check' };
  }
}

/** Apply a single rule as a Delta enforced constraint (real ALTER TABLE). */
export async function applyDeltaConstraint(
  rule: DqRule,
  catalog?: string,
  schema?: string,
  warehouseId?: string,
): Promise<DeltaConstraintResult> {
  const name = constraintName(rule);
  const compiled = compileDeltaConstraintDdl(rule, catalog, schema);
  if ('unsupported' in compiled) {
    return { ruleId: rule.id, name, ddl: '', applied: false, detail: compiled.unsupported };
  }
  try {
    await executeStatement(warehouse(warehouseId), compiled.ddl, catalog, schema);
    return { ruleId: rule.id, name, ddl: compiled.ddl, applied: true, detail: 'constraint enforced on write' };
  } catch (e: any) {
    return { ruleId: rule.id, name, ddl: compiled.ddl, applied: false, detail: `error: ${e?.message || String(e)}` };
  }
}

export interface DeltaConstraint {
  name: string;
  expression: string;
}

/** List the Delta CHECK constraints on a table (from its table properties). */
export async function listDeltaConstraints(
  table: string,
  catalog?: string,
  schema?: string,
  warehouseId?: string,
): Promise<DeltaConstraint[]> {
  const T = fqTable(table, catalog, schema);
  const r = await executeStatement(warehouse(warehouseId), `SHOW TBLPROPERTIES ${T}`, catalog, schema);
  const keyIdx = r.columns.findIndex((c) => c.toLowerCase() === 'key');
  const valIdx = r.columns.findIndex((c) => c.toLowerCase() === 'value');
  const out: DeltaConstraint[] = [];
  for (const row of r.rows) {
    const key = String(row[keyIdx >= 0 ? keyIdx : 0] ?? '');
    const val = String(row[valIdx >= 0 ? valIdx : 1] ?? '');
    if (key.startsWith('delta.constraints.')) {
      out.push({ name: key.slice('delta.constraints.'.length), expression: val });
    }
  }
  return out;
}

/** Drop a Delta CHECK constraint by name. */
export async function dropDeltaConstraint(
  table: string,
  name: string,
  catalog?: string,
  schema?: string,
  warehouseId?: string,
): Promise<void> {
  const T = fqTable(table, catalog, schema);
  await executeStatement(warehouse(warehouseId), `ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS ${quoteSpark(name)}`, catalog, schema);
}

// ---------------------------------------------------------------------------
// Data quality monitoring / data profiling (Unity Catalog)
// ---------------------------------------------------------------------------

export type MonitorProfileType = 'snapshot' | 'time_series';
export type MonitorApiMode = 'data-quality' | 'legacy';

export interface LakehouseMonitor {
  tableName: string;
  /** UC table UUID (object_id) — present on the GA path. */
  tableId?: string;
  status?: string;
  profileMetricsTableName?: string;
  driftMetricsTableName?: string;
  dashboardId?: string;
  monitorVersion?: string;
  /** Which REST surface answered ('data-quality' GA or 'legacy'). */
  api?: MonitorApiMode;
  raw?: unknown;
}

export interface MonitorRefresh {
  refreshId: string;
  state: string;
  startTimeMs?: number;
  endTimeMs?: number;
  trigger?: string;
}

/**
 * Default to the GA `data-quality` API. Operators can force the deprecated
 * `quality_monitors` surface per-cloud (e.g. a sovereign region where GA isn't
 * yet enabled) with `LOOM_DBX_DQ_MONITOR_API=legacy`.
 */
export function monitorApiMode(): MonitorApiMode {
  return process.env.LOOM_DBX_DQ_MONITOR_API === 'legacy' ? 'legacy' : 'data-quality';
}

const GA_BASE = '/api/data-quality/v1/monitors';

/** Looks like a UC object UUID (8-4-4-4-12 hex). */
function isUuid(v: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v);
}

/**
 * Map a human granularity (what the UI sends, e.g. "1 day") onto the GA
 * `AGGREGATION_GRANULARITY_*` enum. Passes through values already in enum form.
 */
export function granularityToEnum(g: string): string {
  const v = String(g || '').trim();
  if (/^AGGREGATION_GRANULARITY_/i.test(v)) return v.toUpperCase();
  const key = v.toLowerCase().replace(/\s+/g, ' ');
  const map: Record<string, string> = {
    '5 minutes': 'AGGREGATION_GRANULARITY_5_MINUTES',
    '30 minutes': 'AGGREGATION_GRANULARITY_30_MINUTES',
    '1 hour': 'AGGREGATION_GRANULARITY_1_HOUR',
    '1 day': 'AGGREGATION_GRANULARITY_1_DAY',
    '1 week': 'AGGREGATION_GRANULARITY_1_WEEK',
    '2 weeks': 'AGGREGATION_GRANULARITY_2_WEEKS',
    '3 weeks': 'AGGREGATION_GRANULARITY_3_WEEKS',
    '4 weeks': 'AGGREGATION_GRANULARITY_4_WEEKS',
    '1 month': 'AGGREGATION_GRANULARITY_1_MONTH',
    '1 year': 'AGGREGATION_GRANULARITY_1_YEAR',
  };
  return map[key] || 'AGGREGATION_GRANULARITY_1_DAY';
}

/**
 * Build the GA `create_monitor` request body. Pure (no network) so it is unit
 * testable. `objectId` is the table UUID; `outputSchemaId` is the destination
 * schema UUID.
 */
export function buildGaMonitorBody(args: {
  objectId: string;
  outputSchemaId: string;
  assetsDir: string;
  profileType: MonitorProfileType;
  timestampCol?: string;
  granularities?: string[];
}): Record<string, unknown> {
  const profiling: Record<string, unknown> = {
    output_schema_id: args.outputSchemaId,
    assets_dir: args.assetsDir,
  };
  if (args.profileType === 'time_series') {
    profiling.time_series = {
      timestamp_column: args.timestampCol,
      granularities: (args.granularities?.length ? args.granularities : ['1 day']).map(granularityToEnum),
    };
  } else {
    profiling.snapshot = {};
  }
  return {
    object_type: 'table',
    object_id: args.objectId,
    data_profiling_config: profiling,
  };
}

// --- Unity Catalog object-id resolution (GA path keys on UUIDs) -------------

/** Resolve a UC table's UUID (`table_id`) from its three-part name. */
export async function getTableId(fullName: string): Promise<string> {
  const res = await dbxFetch(`/api/2.1/unity-catalog/tables/${encodeURIComponent(fullName)}`);
  if (!res.ok) throw new Error(`resolve table_id ${res.status}: ${await res.text()}`);
  const j: any = await res.json();
  const id = j?.table_id;
  if (!id) throw new Error(`table ${fullName} has no table_id`);
  return String(id);
}

/** Resolve a UC schema's UUID (`schema_id`) from its `catalog.schema` name. */
export async function getSchemaId(fullSchemaName: string): Promise<string> {
  if (isUuid(fullSchemaName)) return fullSchemaName;
  const res = await dbxFetch(`/api/2.1/unity-catalog/schemas/${encodeURIComponent(fullSchemaName)}`);
  if (!res.ok) throw new Error(`resolve schema_id ${res.status}: ${await res.text()}`);
  const j: any = await res.json();
  const id = j?.schema_id;
  if (!id) throw new Error(`schema ${fullSchemaName} has no schema_id`);
  return String(id);
}

// --- legacy (deprecated quality_monitors) path ------------------------------

function legacyMonitorPath(fullName: string, sub = ''): string {
  return `/api/2.1/unity-catalog/tables/${encodeURIComponent(fullName)}/monitor${sub}`;
}

function mapLegacyMonitor(fullName: string, j: any): LakehouseMonitor {
  return {
    tableName: fullName,
    status: j?.status,
    profileMetricsTableName: j?.profile_metrics_table_name,
    driftMetricsTableName: j?.drift_metrics_table_name,
    dashboardId: j?.dashboard_id,
    monitorVersion: j?.monitor_version != null ? String(j.monitor_version) : undefined,
    api: 'legacy',
    raw: j,
  };
}

function mapGaMonitor(fullName: string, tableId: string, j: any): LakehouseMonitor {
  // GA nests profile fields under data_profiling_config; tolerate flat too.
  const cfg = j?.data_profiling_config || j?.profiling_config || j || {};
  return {
    tableName: fullName,
    tableId,
    status: j?.status || j?.monitor_status || cfg?.status,
    profileMetricsTableName: cfg?.profile_metrics_table_name || j?.profile_metrics_table_name,
    driftMetricsTableName: cfg?.drift_metrics_table_name || j?.drift_metrics_table_name,
    dashboardId: cfg?.dashboard_id || j?.dashboard_id,
    monitorVersion: (cfg?.monitor_version ?? j?.monitor_version) != null
      ? String(cfg?.monitor_version ?? j?.monitor_version) : undefined,
    api: 'data-quality',
    raw: j,
  };
}

function mapRefresh(r: any): MonitorRefresh {
  // GA states look like MONITOR_REFRESH_STATE_PENDING; trim the prefix for the UI.
  const rawState = String(r?.state || r?.refresh_state || 'UNKNOWN');
  const state = rawState.replace(/^MONITOR_REFRESH_STATE_/, '');
  return {
    refreshId: String(r?.refresh_id ?? r?.refreshId ?? ''),
    state: state || 'UNKNOWN',
    startTimeMs: r?.start_time_ms ?? r?.start_time,
    endTimeMs: r?.end_time_ms ?? r?.end_time,
    trigger: r?.trigger || r?.trigger_type,
  };
}

/** Read the monitor on a UC table (null when no monitor / not found). */
export async function getMonitor(fullName: string): Promise<LakehouseMonitor | null> {
  if (monitorApiMode() === 'legacy') {
    const res = await dbxFetch(legacyMonitorPath(fullName));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`getMonitor ${res.status}: ${await res.text()}`);
    return mapLegacyMonitor(fullName, await res.json());
  }
  const tableId = await getTableId(fullName);
  const res = await dbxFetch(`${GA_BASE}/table/${encodeURIComponent(tableId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getMonitor ${res.status}: ${await res.text()}`);
  return mapGaMonitor(fullName, tableId, await res.json());
}

/**
 * Create a snapshot or time-series quality monitor on a UC table. Metric tables
 * + a dashboard are written under `assetsDir` / `outputSchema`.
 */
export async function createMonitor(args: {
  fullName: string;
  outputSchema: string;
  assetsDir: string;
  profileType: MonitorProfileType;
  /** Required for time_series profiles. */
  timestampCol?: string;
  /** Required for time_series profiles (e.g. ['1 day']). */
  granularities?: string[];
  warehouseId?: string;
}): Promise<LakehouseMonitor> {
  if (monitorApiMode() === 'legacy') {
    const body: Record<string, unknown> = {
      assets_dir: args.assetsDir,
      output_schema_name: args.outputSchema,
    };
    if (args.warehouseId || process.env.LOOM_DATABRICKS_SQL_WAREHOUSE_ID) {
      body.warehouse_id = args.warehouseId || process.env.LOOM_DATABRICKS_SQL_WAREHOUSE_ID;
    }
    if (args.profileType === 'time_series') {
      body.time_series = {
        timestamp_col: args.timestampCol,
        granularities: args.granularities?.length ? args.granularities : ['1 day'],
      };
    } else {
      body.snapshot = {};
    }
    const res = await dbxFetch(legacyMonitorPath(args.fullName), { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`createMonitor ${res.status}: ${await res.text()}`);
    return mapLegacyMonitor(args.fullName, await res.json());
  }

  // GA path: resolve the table UUID and the output-schema UUID.
  const tableId = await getTableId(args.fullName);
  // The output schema may be a UUID, a catalog.schema name, or a bare schema —
  // in the bare case, qualify it with the monitored table's catalog.
  let outputSchema = args.outputSchema.trim();
  if (!isUuid(outputSchema) && !outputSchema.includes('.')) {
    const catalog = args.fullName.split('.')[0];
    if (catalog) outputSchema = `${catalog}.${outputSchema}`;
  }
  const outputSchemaId = await getSchemaId(outputSchema);
  const body = buildGaMonitorBody({
    objectId: tableId,
    outputSchemaId,
    assetsDir: args.assetsDir,
    profileType: args.profileType,
    timestampCol: args.timestampCol,
    granularities: args.granularities,
  });
  const res = await dbxFetch(GA_BASE, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`createMonitor ${res.status}: ${await res.text()}`);
  return mapGaMonitor(args.fullName, tableId, await res.json());
}

/** Delete the monitor on a UC table. */
export async function deleteMonitor(fullName: string): Promise<void> {
  if (monitorApiMode() === 'legacy') {
    const res = await dbxFetch(legacyMonitorPath(fullName), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`deleteMonitor ${res.status}: ${await res.text()}`);
    return;
  }
  const tableId = await getTableId(fullName);
  const res = await dbxFetch(`${GA_BASE}/table/${encodeURIComponent(tableId)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`deleteMonitor ${res.status}: ${await res.text()}`);
}

/** Trigger a metric refresh; returns the refresh id + state. */
export async function refreshMonitor(fullName: string): Promise<MonitorRefresh> {
  if (monitorApiMode() === 'legacy') {
    const res = await dbxFetch(legacyMonitorPath(fullName, '/refreshes'), { method: 'POST' });
    if (!res.ok) throw new Error(`refreshMonitor ${res.status}: ${await res.text()}`);
    const j: any = await res.json();
    return { ...mapRefresh(j), state: j?.state || 'PENDING' };
  }
  const tableId = await getTableId(fullName);
  const res = await dbxFetch(`${GA_BASE}/table/${encodeURIComponent(tableId)}/refreshes`, {
    method: 'POST',
    body: JSON.stringify({ object_type: 'table', object_id: tableId }),
  });
  if (!res.ok) throw new Error(`refreshMonitor ${res.status}: ${await res.text()}`);
  return mapRefresh(await res.json());
}

/** List refresh history for a monitor (most recent first, as returned). */
export async function listRefreshes(fullName: string): Promise<MonitorRefresh[]> {
  const path = monitorApiMode() === 'legacy'
    ? legacyMonitorPath(fullName, '/refreshes')
    : `${GA_BASE}/table/${encodeURIComponent(await getTableId(fullName))}/refreshes`;
  const res = await dbxFetch(path);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`listRefreshes ${res.status}: ${await res.text()}`);
  const j: any = await res.json();
  const arr = Array.isArray(j?.refreshes) ? j.refreshes : [];
  return arr.map(mapRefresh);
}
