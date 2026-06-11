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
 *   2. Databricks Lakehouse Monitoring (Unity Catalog quality monitors). A
 *      snapshot/time-series profile that produces UC metric tables + a dashboard
 *      and can be refreshed on demand. GA REST surface
 *      (`/api/2.1/unity-catalog/tables/{name}/monitor`), grounded in:
 *      https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/data-quality-monitoring/
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
  return fetch(`https://${host()}${path}`, {
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
// Lakehouse Monitoring (Unity Catalog quality monitors)
// ---------------------------------------------------------------------------

export type MonitorProfileType = 'snapshot' | 'time_series';

export interface LakehouseMonitor {
  tableName: string;
  status?: string;
  profileMetricsTableName?: string;
  driftMetricsTableName?: string;
  dashboardId?: string;
  monitorVersion?: string;
  raw?: unknown;
}

export interface MonitorRefresh {
  refreshId: string;
  state: string;
  startTimeMs?: number;
  endTimeMs?: number;
  trigger?: string;
}

function monitorPath(fullName: string, sub = ''): string {
  // GA quality-monitors REST surface keyed by the three-part table name.
  return `/api/2.1/unity-catalog/tables/${encodeURIComponent(fullName)}/monitor${sub}`;
}

function mapMonitor(fullName: string, j: any): LakehouseMonitor {
  return {
    tableName: fullName,
    status: j?.status,
    profileMetricsTableName: j?.profile_metrics_table_name,
    driftMetricsTableName: j?.drift_metrics_table_name,
    dashboardId: j?.dashboard_id,
    monitorVersion: j?.monitor_version ? String(j.monitor_version) : undefined,
    raw: j,
  };
}

/** Read the monitor on a UC table (null when no monitor / not found). */
export async function getMonitor(fullName: string): Promise<LakehouseMonitor | null> {
  const res = await dbxFetch(monitorPath(fullName));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getMonitor ${res.status}: ${await res.text()}`);
  return mapMonitor(fullName, await res.json());
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
  const res = await dbxFetch(monitorPath(args.fullName), { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`createMonitor ${res.status}: ${await res.text()}`);
  return mapMonitor(args.fullName, await res.json());
}

/** Delete the monitor on a UC table. */
export async function deleteMonitor(fullName: string): Promise<void> {
  const res = await dbxFetch(monitorPath(fullName), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`deleteMonitor ${res.status}: ${await res.text()}`);
}

/** Trigger a metric refresh; returns the refresh id + state. */
export async function refreshMonitor(fullName: string): Promise<MonitorRefresh> {
  const res = await dbxFetch(monitorPath(fullName, '/refreshes'), { method: 'POST' });
  if (!res.ok) throw new Error(`refreshMonitor ${res.status}: ${await res.text()}`);
  const j: any = await res.json();
  return {
    refreshId: String(j?.refresh_id ?? ''),
    state: j?.state || 'PENDING',
    startTimeMs: j?.start_time_ms,
    endTimeMs: j?.end_time_ms,
    trigger: j?.trigger,
  };
}

/** List refresh history for a monitor (most recent first, as returned). */
export async function listRefreshes(fullName: string): Promise<MonitorRefresh[]> {
  const res = await dbxFetch(monitorPath(fullName, '/refreshes'));
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`listRefreshes ${res.status}: ${await res.text()}`);
  const j: any = await res.json();
  const arr = Array.isArray(j?.refreshes) ? j.refreshes : [];
  return arr.map((r: any) => ({
    refreshId: String(r?.refresh_id ?? ''),
    state: r?.state || 'UNKNOWN',
    startTimeMs: r?.start_time_ms,
    endTimeMs: r?.end_time_ms,
    trigger: r?.trigger,
  }));
}
