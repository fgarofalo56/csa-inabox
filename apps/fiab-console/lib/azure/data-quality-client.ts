/**
 * Loom-native data-quality + data-health client (F19 / F20).
 *
 * Azure-native, NO Microsoft Fabric dependency. The data-observability surface
 * is powered entirely by:
 *   - Azure Data Explorer (ADX / Kusto) — health charts + DQ score, via
 *     `kusto-client.executeQuery` (real `POST /v1/rest/query`).
 *   - The Loom-native data-quality rule store (Cosmos `tenantSettings`, doc
 *     `dq-rules:<tenantId>`) — the same rules authored under
 *     Governance → Data quality (`/api/admin/data-quality-rules`).
 *
 * DQ score formula (grounded in Microsoft Learn — Purview "Review data quality
 * scores"): per enabled rule we run a KQL aggregate that yields a 0–100 pass
 * percentage; a rule passes when its percentage meets the rule threshold; the
 * composite score is the mean of the per-rule percentages. No mock data — every
 * number comes from a live ADX query against the product's dataset tables.
 *
 * Honest gate: when `LOOM_KUSTO_CLUSTER_URI` is unset {@link adxConfigGate}
 * returns `{ missing }` so the BFF surfaces a Fluent MessageBar (no fake
 * charts) instead of querying a phantom cluster.
 */

import { executeQuery, kustoConfigGate, getTableCslSchema, qName, KustoError } from './kusto-client';
import { tenantSettingsContainer } from './cosmos-client';
import {
  executeStatement as dbxExecuteStatement,
  databricksConfigGate,
  type DbxQueryParam,
} from './databricks-client';
import {
  executeQuery as synapseExecuteQuery,
  serverlessTarget,
  dedicatedTarget,
  type SynapseTarget,
} from './synapse-sql-client';

/** Re-export of the ADX (Kusto) config gate under the observability vocabulary. */
export { kustoConfigGate as adxConfigGate };

// ------------------------------------------------------------------
// DQ rule shape — mirrors app/api/admin/data-quality-rules/route.ts so the
// observability score uses the SAME rules the operator authors in
// Governance → Data quality. We read the doc directly (no HTTP hop) so the
// server-side score computation stays in one transaction.
// ------------------------------------------------------------------
export interface DqRule {
  id: string;
  name: string;
  /** "table:<name>" or "column:<table>.<column>". */
  scope: string;
  check: 'not-null' | 'unique' | 'range' | 'regex' | 'freshness';
  /** % for not-null/unique/range/regex; days for freshness. */
  threshold: number;
  pattern?: string;
  min?: number;
  max?: number;
  enabled: boolean;
}

interface DqRulesDoc {
  id: string;
  tenantId: string;
  kind: 'dq-rules';
  items: DqRule[];
  updatedAt: string;
}

export interface DqRuleResult {
  ruleId: string;
  name: string;
  check: DqRule['check'];
  scope: string;
  /** 0–100 pass percentage from the live KQL aggregate (null when the rule could not run). */
  percentage: number | null;
  passed: boolean;
  detail: string;
}

export interface DqScoreResult {
  /** Composite 0–100 score (mean of per-rule percentages); null when no rule could be scored. */
  score: number | null;
  ruleCount: number;
  passingRules: number;
  breakdown: DqRuleResult[];
  computedAt: string;
}

export interface HealthChart {
  title: string;
  /** The exact KQL that was executed (shown in the UI for transparency). */
  kql: string;
  columns: string[];
  rows: unknown[][];
  /** `render`-operator visualization hint, when present. */
  visualization?: string;
  /** Set when this specific chart failed (the others still render). */
  error?: string;
}

/** Reference a KQL column safely as a bracketed identifier (`["col"]`). */
function colRef(name: string): string {
  return qName(name);
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
  // Bare "table.column" or "table".
  const dot = scope.indexOf('.');
  return dot < 0 ? { table: scope } : { table: scope.slice(0, dot), column: scope.slice(dot + 1) };
}

/** Pull the first numeric cell out of a single-row KQL result. */
function firstNumber(cols: string[], rows: unknown[][], colName: string): number | null {
  if (!rows.length) return null;
  const idx = cols.indexOf(colName);
  const v = rows[0][idx >= 0 ? idx : 0];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Load the tenant's DQ rules (the same store as Governance → Data quality). */
async function loadRules(tenantId: string): Promise<DqRule[]> {
  const c = await tenantSettingsContainer();
  const docId = `dq-rules:${tenantId}`;
  try {
    const { resource } = await c.item(docId, tenantId).read<DqRulesDoc>();
    return resource?.items || [];
  } catch (e: any) {
    if (e?.code === 404) return [];
    throw e;
  }
}

/**
 * Run a single DQ rule's KQL aggregate and return a 0–100 pass percentage.
 * Returns null when the rule is malformed for its check type (no column where
 * one is required). Throws KustoError on a real backend error so the caller can
 * record an honest per-rule detail.
 */
async function scoreRule(database: string, rule: DqRule): Promise<{ percentage: number | null; detail: string }> {
  const { table, column } = parseScope(rule.scope);
  const T = qName(table);

  // Column-bound checks require a column scope.
  const needsColumn = rule.check !== 'freshness';
  if (needsColumn && !column) {
    return { percentage: null, detail: `${rule.check} rule needs a column scope (column:<table>.<col>)` };
  }
  const C = column ? colRef(column) : '';

  switch (rule.check) {
    case 'not-null': {
      const kql = `${T} | summarize total=count(), bad=countif(isnull(${C})) | project pct=iff(total==0, 100.0, todouble(total-bad)/total*100)`;
      const r = await executeQuery(database, kql);
      const pct = firstNumber(r.columns, r.rows, 'pct');
      return { percentage: pct, detail: pct == null ? 'no rows' : `${pct.toFixed(1)}% non-null` };
    }
    case 'unique': {
      const kql = `${T} | summarize total=count(), distinctCount=dcount(${C}) | project pct=iff(total==0, 100.0, todouble(distinctCount)/total*100)`;
      const r = await executeQuery(database, kql);
      const pct = firstNumber(r.columns, r.rows, 'pct');
      return { percentage: pct, detail: pct == null ? 'no rows' : `${pct.toFixed(1)}% distinct` };
    }
    case 'range': {
      if (typeof rule.min !== 'number' || typeof rule.max !== 'number') {
        return { percentage: null, detail: 'range rule needs numeric min + max' };
      }
      const kql = `${T} | summarize total=count(), inRange=countif(${C} >= ${rule.min} and ${C} <= ${rule.max}) | project pct=iff(total==0, 100.0, todouble(inRange)/total*100)`;
      const r = await executeQuery(database, kql);
      const pct = firstNumber(r.columns, r.rows, 'pct');
      return { percentage: pct, detail: pct == null ? 'no rows' : `${pct.toFixed(1)}% within [${rule.min}, ${rule.max}]` };
    }
    case 'regex': {
      if (!rule.pattern) return { percentage: null, detail: 'regex rule needs a pattern' };
      const pat = rule.pattern.replace(/"/g, '\\"');
      const kql = `${T} | summarize total=count(), matching=countif(tostring(${C}) matches regex @"${pat}") | project pct=iff(total==0, 100.0, todouble(matching)/total*100)`;
      const r = await executeQuery(database, kql);
      const pct = firstNumber(r.columns, r.rows, 'pct');
      return { percentage: pct, detail: pct == null ? 'no rows' : `${pct.toFixed(1)}% match /${rule.pattern}/` };
    }
    case 'freshness': {
      const days = rule.threshold > 0 ? rule.threshold : 1;
      const kql = `${T} | summarize latest=max(ingestion_time()) | extend fresh=(latest >= ago(${days}d)), ageHours=datetime_diff('hour', now(), latest) | project pct=iff(fresh, 100.0, 0.0), ageHours`;
      const r = await executeQuery(database, kql);
      const pct = firstNumber(r.columns, r.rows, 'pct');
      const age = firstNumber(r.columns, r.rows, 'ageHours');
      return {
        percentage: pct,
        detail: pct == null ? 'no ingestion timestamp' : pct >= 100 ? `fresh (${age ?? '?'}h old)` : `stale (${age ?? '?'}h old, limit ${days}d)`,
      };
    }
    default:
      return { percentage: null, detail: 'unknown check' };
  }
}

/**
 * Compute the composite DQ score for a data product. `tableNames` are the
 * product's dataset table names (ADX tables); only rules scoped to one of these
 * tables are evaluated. Returns score=null + ruleCount=0 when no matching,
 * enabled rule exists (the UI then shows an honest "no rules" note rather than a
 * fabricated number).
 */
export async function computeDqScore(
  tenantId: string,
  database: string,
  tableNames: string[],
): Promise<DqScoreResult> {
  const computedAt = new Date().toISOString();
  const rules = await loadRules(tenantId);
  const wanted = new Set(tableNames.map((t) => t.toLowerCase()).filter(Boolean));
  const applicable = rules.filter((r) => {
    if (!r.enabled) return false;
    const { table } = parseScope(r.scope);
    // With no datasets we still score every enabled rule (the product may be
    // table-less in Cosmos but its rules target real ADX tables).
    return wanted.size === 0 ? true : wanted.has(table.toLowerCase());
  });

  if (applicable.length === 0) {
    return { score: null, ruleCount: 0, passingRules: 0, breakdown: [], computedAt };
  }

  const breakdown: DqRuleResult[] = [];
  for (const rule of applicable) {
    try {
      const { percentage, detail } = await scoreRule(database, rule);
      const passed = percentage != null && percentage >= rule.threshold;
      breakdown.push({ ruleId: rule.id, name: rule.name, check: rule.check, scope: rule.scope, percentage, passed, detail });
    } catch (e: any) {
      const msg = e instanceof KustoError ? e.message : (e?.message || String(e));
      breakdown.push({ ruleId: rule.id, name: rule.name, check: rule.check, scope: rule.scope, percentage: null, passed: false, detail: `error: ${msg}` });
    }
  }

  const scored = breakdown.map((b) => b.percentage).filter((p): p is number => p != null);
  const score = scored.length ? Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 10) / 10 : null;
  const passingRules = breakdown.filter((b) => b.passed).length;
  return { score, ruleCount: breakdown.length, passingRules, breakdown, computedAt };
}

/**
 * Run the data-health charts for a product against ADX. Always runs a
 * cluster-reachability probe (a live `print` query that confirms ADX
 * connectivity regardless of table existence — guarantees a real KQL response
 * in the receipt). When `tableName` is provided we add three table-scoped
 * charts: ingestion volume (7d timechart), a freshness/row-count summary, and a
 * null-rate-by-column breakdown (columns enumerated from `.show table cslschema`
 * — never free-constructed). A failing per-table chart records its honest error
 * without blocking the others.
 */
export async function runHealthCharts(database: string, tableName?: string): Promise<HealthChart[]> {
  const charts: HealthChart[] = [];

  // 1. Cluster reachability — always a live, valid KQL response.
  {
    const kql = `print Status="reachable", Database="${database.replace(/"/g, '')}", CheckedAt=now()`;
    try {
      const r = await executeQuery(database, kql);
      charts.push({ title: 'ADX cluster reachability', kql, columns: r.columns, rows: r.rows, visualization: r.visualization?.Visualization });
    } catch (e: any) {
      charts.push({ title: 'ADX cluster reachability', kql, columns: [], rows: [], error: e?.message || String(e) });
    }
  }

  if (!tableName) return charts;
  const T = qName(tableName);

  // 2. Ingestion volume over the last 7 days (timechart).
  {
    const kql = `${T} | where ingestion_time() > ago(7d) | summarize RowCount=count() by bin(ingestion_time(), 1d) | order by ingestion_time() asc | render timechart with (title="Ingestion volume (7d)")`;
    try {
      const r = await executeQuery(database, kql);
      charts.push({ title: 'Ingestion volume (7d)', kql, columns: r.columns, rows: r.rows, visualization: r.visualization?.Visualization || 'timechart' });
    } catch (e: any) {
      charts.push({ title: 'Ingestion volume (7d)', kql, columns: [], rows: [], error: e?.message || String(e) });
    }
  }

  // 3. Freshness + row-count summary (card).
  {
    const kql = `${T} | summarize TotalRows=count(), LatestIngestion=max(ingestion_time()) | extend FreshnessHours=datetime_diff('hour', now(), LatestIngestion)`;
    try {
      const r = await executeQuery(database, kql);
      charts.push({ title: 'Freshness & volume', kql, columns: r.columns, rows: r.rows, visualization: r.visualization?.Visualization });
    } catch (e: any) {
      charts.push({ title: 'Freshness & volume', kql, columns: [], rows: [], error: e?.message || String(e) });
    }
  }

  // 4. Null-rate by column (columns enumerated from the real schema).
  {
    let kql = '';
    try {
      const cslschema = await getTableCslSchema(database, tableName);
      const columns = cslschema
        .split(',')
        .map((seg) => seg.split(':')[0].trim().replace(/^\[?['"]?|['"]?\]?$/g, ''))
        .filter(Boolean)
        .slice(0, 15);
      if (columns.length === 0) {
        charts.push({ title: 'Null-rate by column', kql: `.show table ${tableName} cslschema`, columns: [], rows: [], error: 'table has no columns' });
      } else {
        const aggs = columns.map((c) => `${qName(`${c}_nullPct`)}=round(todouble(countif(isnull(${colRef(c)})))/Total*100, 2)`).join(', ');
        kql = `${T} | summarize Total=count(), ${aggs}`;
        const r = await executeQuery(database, kql);
        charts.push({ title: 'Null-rate by column (%)', kql, columns: r.columns, rows: r.rows, visualization: r.visualization?.Visualization });
      }
    } catch (e: any) {
      charts.push({ title: 'Null-rate by column (%)', kql: kql || `.show table ${tableName} cslschema`, columns: [], rows: [], error: e?.message || String(e) });
    }
  }

  return charts;
}

// ==================================================================
// Multi-backend rule execution (DQ run + results) — F19 extension.
//
// computeDqScore (above) scores the SAME Loom rules against ADX/Kusto. This
// section adds SQL-engine execution so the operator can RUN the rule set on
// the workspace's own engine and capture a run-history record:
//   - 'databricks' → SQL Statement Execution API (Spark SQL dialect)
//   - 'synapse'    → Synapse Serverless / dedicated SQL pool (T-SQL dialect)
//   - 'kusto'      → ADX (delegates to scoreRule above)
// Azure-native default in every case — no Fabric / Power BI dependency. Each
// backend has an honest config gate so the BFF surfaces a MessageBar (never a
// fabricated number) when the engine isn't wired.
// ==================================================================

export type DqRunBackend = 'kusto' | 'databricks' | 'synapse';

export interface DqRunOptions {
  backend: DqRunBackend;
  /** Kusto database OR Synapse SQL database (serverless 'master' default). */
  database?: string;
  /** Databricks SQL Warehouse id (defaults to LOOM_DATABRICKS_SQL_WAREHOUSE_ID). */
  warehouseId?: string;
  /** Three-part-name catalog (Databricks Unity Catalog / Synapse). */
  catalog?: string;
  /** Schema namespace. */
  schema?: string;
  /** Synapse pool: 'serverless' (default) or 'dedicated'. */
  synapsePool?: 'serverless' | 'dedicated';
  /** Restrict to rules whose scope table is in this set (empty = all enabled). */
  tableNames?: string[];
}

export interface DqRunResult extends DqScoreResult {
  backend: DqRunBackend;
  /** Echoes the resolved target for the receipt (warehouse id / db / pool). */
  target: string;
}

/** Honest config gate for a chosen run backend (mirrors the per-client gates). */
export function dqRunConfigGate(backend: DqRunBackend): { missing: string } | null {
  if (backend === 'kusto') return kustoConfigGate();
  if (backend === 'databricks') {
    const g = databricksConfigGate();
    if (g) return g;
    if (!process.env.LOOM_DATABRICKS_SQL_WAREHOUSE_ID) {
      return { missing: 'LOOM_DATABRICKS_SQL_WAREHOUSE_ID' };
    }
    return null;
  }
  if (backend === 'synapse') {
    if (!process.env.LOOM_SYNAPSE_WORKSPACE) return { missing: 'LOOM_SYNAPSE_WORKSPACE' };
    return null;
  }
  return { missing: 'unknown-backend' };
}

/** Validate + quote a SQL identifier segment (reject anything injectable). */
function safeIdent(seg: string): string {
  if (!/^[A-Za-z0-9_ $-]+$/.test(seg)) {
    throw new Error(`Unsafe SQL identifier: "${seg}"`);
  }
  return seg;
}

/** Backtick-quote a (possibly dotted) Spark SQL name. */
function quoteSpark(name: string): string {
  return name.split('.').map((s) => `\`${safeIdent(s)}\``).join('.');
}

/** Bracket-quote a (possibly dotted) T-SQL name. */
function quoteTsql(name: string): string {
  return name.split('.').map((s) => `[${safeIdent(s)}]`).join('.');
}

/** Build the fully-qualified table reference for a backend, honoring catalog/schema. */
function fqTable(backend: 'spark' | 'tsql', table: string, catalog?: string, schema?: string): string {
  const q = backend === 'spark' ? quoteSpark : quoteTsql;
  // Already three-part? leave it.
  if (table.includes('.')) return q(table);
  const parts: string[] = [];
  if (catalog) parts.push(catalog);
  if (schema) parts.push(schema);
  parts.push(table);
  return q(parts.join('.'));
}

/** First numeric column out of a SQL single-row result. */
function firstNumberSql(cols: string[], rows: unknown[][], colName: string): number | null {
  if (!rows.length) return null;
  const idx = cols.findIndex((c) => c.toLowerCase() === colName.toLowerCase());
  const v = rows[0][idx >= 0 ? idx : 0];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Score one rule on Databricks SQL (Spark dialect). Regex binds the pattern as a
 * named parameter (`:pat`) so it is never concatenated into the statement.
 */
async function scoreRuleDatabricks(
  rule: DqRule,
  warehouseId: string,
  catalog?: string,
  schema?: string,
): Promise<{ percentage: number | null; detail: string }> {
  const { table, column } = parseScope(rule.scope);
  if (rule.check !== 'freshness' && !column) {
    return { percentage: null, detail: `${rule.check} rule needs a column scope (column:<table>.<col>)` };
  }
  const T = fqTable('spark', table, catalog, schema);
  const C = column ? quoteSpark(column.includes('.') ? column.split('.').slice(1).join('.') : column) : '';
  const params: DbxQueryParam[] = [];
  let sql = '';
  switch (rule.check) {
    case 'not-null':
      sql = `SELECT (CAST(SUM(CASE WHEN ${C} IS NOT NULL THEN 1 ELSE 0 END) AS DOUBLE) / NULLIF(COUNT(*), 0)) * 100 AS pct FROM ${T}`;
      break;
    case 'unique':
      sql = `SELECT (CAST(COUNT(DISTINCT ${C}) AS DOUBLE) / NULLIF(COUNT(*), 0)) * 100 AS pct FROM ${T}`;
      break;
    case 'range':
      if (typeof rule.min !== 'number' || typeof rule.max !== 'number') {
        return { percentage: null, detail: 'range rule needs numeric min + max' };
      }
      sql = `SELECT (CAST(SUM(CASE WHEN ${C} BETWEEN ${rule.min} AND ${rule.max} THEN 1 ELSE 0 END) AS DOUBLE) / NULLIF(COUNT(*), 0)) * 100 AS pct FROM ${T}`;
      break;
    case 'regex':
      if (!rule.pattern) return { percentage: null, detail: 'regex rule needs a pattern' };
      params.push({ name: 'pat', value: rule.pattern, type: 'STRING' });
      sql = `SELECT (CAST(SUM(CASE WHEN CAST(${C} AS STRING) RLIKE :pat THEN 1 ELSE 0 END) AS DOUBLE) / NULLIF(COUNT(*), 0)) * 100 AS pct FROM ${T}`;
      break;
    case 'freshness': {
      if (!column) return { percentage: null, detail: 'freshness rule needs a timestamp column scope' };
      const days = rule.threshold > 0 ? Math.floor(rule.threshold) : 1;
      sql = `SELECT CASE WHEN MAX(${C}) >= current_timestamp() - INTERVAL ${days} DAYS THEN 100.0 ELSE 0.0 END AS pct FROM ${T}`;
      break;
    }
    default:
      return { percentage: null, detail: 'unknown check' };
  }
  const r = await dbxExecuteStatement(warehouseId, sql, catalog, schema, params.length ? params : undefined);
  const pct = firstNumberSql(r.columns, r.rows, 'pct');
  return { percentage: pct, detail: pct == null ? 'no rows' : `${pct.toFixed(1)}% (Databricks SQL)` };
}

/**
 * Score one rule on Synapse SQL (T-SQL dialect). T-SQL has no native regex, so
 * a regex check returns an honest null + detail (use Databricks or Kusto for
 * regex). not-null / unique / range / freshness run as ANSI/T-SQL aggregates.
 */
async function scoreRuleSynapse(
  rule: DqRule,
  target: SynapseTarget,
  catalog?: string,
  schema?: string,
): Promise<{ percentage: number | null; detail: string }> {
  const { table, column } = parseScope(rule.scope);
  if (rule.check !== 'freshness' && !column) {
    return { percentage: null, detail: `${rule.check} rule needs a column scope (column:<table>.<col>)` };
  }
  const T = fqTable('tsql', table, catalog, schema);
  const C = column ? quoteTsql(column.includes('.') ? column.split('.').slice(1).join('.') : column) : '';
  let sql = '';
  switch (rule.check) {
    case 'not-null':
      sql = `SELECT (CAST(SUM(CASE WHEN ${C} IS NOT NULL THEN 1 ELSE 0 END) AS FLOAT) / NULLIF(COUNT(*), 0)) * 100 AS pct FROM ${T}`;
      break;
    case 'unique':
      sql = `SELECT (CAST(COUNT(DISTINCT ${C}) AS FLOAT) / NULLIF(COUNT(*), 0)) * 100 AS pct FROM ${T}`;
      break;
    case 'range':
      if (typeof rule.min !== 'number' || typeof rule.max !== 'number') {
        return { percentage: null, detail: 'range rule needs numeric min + max' };
      }
      sql = `SELECT (CAST(SUM(CASE WHEN ${C} BETWEEN ${rule.min} AND ${rule.max} THEN 1 ELSE 0 END) AS FLOAT) / NULLIF(COUNT(*), 0)) * 100 AS pct FROM ${T}`;
      break;
    case 'regex':
      return { percentage: null, detail: 'regex unsupported on Synapse T-SQL backend — run on Databricks or Kusto' };
    case 'freshness': {
      if (!column) return { percentage: null, detail: 'freshness rule needs a timestamp column scope' };
      const days = rule.threshold > 0 ? Math.floor(rule.threshold) : 1;
      sql = `SELECT CASE WHEN MAX(${C}) >= DATEADD(DAY, -${days}, SYSUTCDATETIME()) THEN CAST(100.0 AS FLOAT) ELSE CAST(0.0 AS FLOAT) END AS pct FROM ${T}`;
      break;
    }
    default:
      return { percentage: null, detail: 'unknown check' };
  }
  const r = await synapseExecuteQuery(target, sql);
  const pct = firstNumberSql(r.columns, r.rows, 'pct');
  return { percentage: pct, detail: pct == null ? 'no rows' : `${pct.toFixed(1)}% (Synapse SQL)` };
}

/**
 * Run the tenant's DQ rule set against a chosen engine and return the per-rule
 * breakdown + composite score. The result is identical in shape to
 * {@link computeDqScore} so the Results UI renders one component for every
 * backend. The caller (BFF) persists this into the `dq-runs:<tenantId>` history.
 */
export async function runDqRules(tenantId: string, opts: DqRunOptions): Promise<DqRunResult> {
  const computedAt = new Date().toISOString();
  const rules = await loadRules(tenantId);
  const wanted = new Set((opts.tableNames || []).map((t) => t.toLowerCase()).filter(Boolean));
  const applicable = rules.filter((r) => {
    if (!r.enabled) return false;
    const { table } = parseScope(r.scope);
    return wanted.size === 0 ? true : wanted.has(table.toLowerCase());
  });

  let target = '';
  let scorer: (rule: DqRule) => Promise<{ percentage: number | null; detail: string }>;

  if (opts.backend === 'databricks') {
    const warehouseId = (opts.warehouseId || process.env.LOOM_DATABRICKS_SQL_WAREHOUSE_ID || '').trim();
    if (!warehouseId) throw new Error('No Databricks SQL Warehouse — set LOOM_DATABRICKS_SQL_WAREHOUSE_ID or pass warehouseId');
    target = `databricks:${warehouseId}`;
    scorer = (rule) => scoreRuleDatabricks(rule, warehouseId, opts.catalog, opts.schema);
  } else if (opts.backend === 'synapse') {
    const tgt = opts.synapsePool === 'dedicated' ? dedicatedTarget() : serverlessTarget(opts.database || 'master');
    target = `synapse:${opts.synapsePool || 'serverless'}:${tgt.database}`;
    scorer = (rule) => scoreRuleSynapse(rule, tgt, opts.catalog, opts.schema);
  } else {
    const db = opts.database || process.env.LOOM_KUSTO_DEFAULT_DB || 'loomdb-default';
    target = `kusto:${db}`;
    scorer = (rule) => scoreRule(db, rule);
  }

  const breakdown: DqRuleResult[] = [];
  for (const rule of applicable) {
    try {
      const { percentage, detail } = await scorer(rule);
      const passed = percentage != null && percentage >= rule.threshold;
      breakdown.push({ ruleId: rule.id, name: rule.name, check: rule.check, scope: rule.scope, percentage, passed, detail });
    } catch (e: any) {
      const msg = e instanceof KustoError ? e.message : (e?.message || String(e));
      breakdown.push({ ruleId: rule.id, name: rule.name, check: rule.check, scope: rule.scope, percentage: null, passed: false, detail: `error: ${msg}` });
    }
  }

  const scored = breakdown.map((b) => b.percentage).filter((p): p is number => p != null);
  const score = scored.length ? Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 10) / 10 : null;
  const passingRules = breakdown.filter((b) => b.passed).length;
  return { score, ruleCount: breakdown.length, passingRules, breakdown, computedAt, backend: opts.backend, target };
}
