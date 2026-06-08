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
