/**
 * metric-compiler.ts — Loom's OWN native metric compiler (N15).
 *
 * `compileMetricQuery({metric, dimensions, filters, grain, engine})` folds a
 * governed metric definition (resolved from the MetricFlow-compatible spec that
 * EXTENDS N9's contract store) into a real SQL/KQL query for the target engine —
 * Synapse serverless (default), Synapse-over-lakehouse, or Azure Data Explorer.
 *
 * NO RUNTIME MetricFlow / dbt engine (die-hard N15 rule): there is no MetricFlow
 * process, no embedded Python, no extra ACA service, no dbt-coupled runtime. This
 * pure function emits the SQL itself — the same pattern the DAX fold engine
 * (lib/azure/dax/fold.ts) and wells-to-sql use. It is the SINGLE compile path all
 * three consumers (report designer, Copilot NL2SQL, the SDK/API) funnel through,
 * so the "one metric ⇒ one number everywhere" contract holds by construction.
 *
 * INJECTION-SAFE, no exceptions:
 *   • Identifiers (relation, dimension/measure expressions) come ONLY from the
 *     governed spec and are whitelisted against it — a requested dimension not
 *     declared in the model is REJECTED, never emitted — then quoted through the
 *     central `@/lib/sql/quoting` helpers (bracket/quoteIdent).
 *   • Filter VALUES are NEVER spliced: the T-SQL engines bind them as TDS
 *     parameters (`@p0`, `@p1`, …); the KQL engine escapes them through the
 *     central `escapeSqlLiteral` (the documented SQL/KQL/DAX single-quote-doubling
 *     helper).
 *
 * MOAT / IL5: the compiled query executes ENTIRELY in-boundary (Synapse / ADX /
 * lakehouse — all Gov-GA), so a metric compiles + serves with zero external
 * egress even in an air-gapped IL5 enclave.
 *
 * Per-cloud: identical everywhere — pure string folding; the executing route
 * picks the cloud-correct endpoint via the existing clients.
 */

import { bracket, escapeSqlLiteral } from '@/lib/sql/quoting';
import type { SynapseQueryParam } from '@/lib/azure/synapse-sql-client';
import {
  resolveMetricMeasure,
  type MetricFlowSpec,
  type MfAgg,
  type MfDimension,
  type MfMeasure,
  type MfSemanticModel,
} from './metricflow-spec';

/** The target execution engine for a compiled metric query. */
export type MetricEngine = 'synapse' | 'lakehouse' | 'adx';

/** Every supported engine, in default-preference order. */
export const METRIC_ENGINES: readonly MetricEngine[] = ['synapse', 'lakehouse', 'adx'];

/** A structured, injection-safe filter predicate on a governed dimension. */
export interface MetricFilter {
  /** Dimension name — MUST be declared on the metric's semantic model. */
  dimension: string;
  op: '=' | '!=' | '>' | '>=' | '<' | '<=' | 'in';
  /** Scalar (or array, for `in`). Bound as a parameter / escaped — never spliced. */
  value: string | number | Array<string | number>;
}

/** Arguments to {@link compileMetricQuery}. */
export interface CompileMetricArgs {
  /** The governed MetricFlow spec (from the extended N9 contract store). */
  spec: MetricFlowSpec;
  /** The metric name/id to compile. */
  metric: string;
  /** Group-by dimensions (each whitelisted against the model). */
  dimensions?: string[];
  /** Structured filter predicates (each whitelisted + bound). */
  filters?: MetricFilter[];
  /**
   * ENGINE-LEVEL ROW-LEVEL SECURITY predicates, keyed on the EMBED-TOKEN
   * effective identity (N18). These are ANDed into the WHERE / `| where` right
   * after the metric-level filter and BEFORE the caller's own `filters`, so two
   * different token identities compile to DIFFERENT rows from the SAME governed
   * metric — enforced at the query engine (a bound TDS parameter / centrally
   * escaped KQL literal), NEVER by hiding rows client-side. Each predicate is
   * whitelisted against the model exactly like a requested filter (an RLS claim
   * on an undeclared dimension REJECTS the query — fail-closed, never all-rows).
   * A request without an embed identity passes none. RLS narrows only: it is
   * ANDed, so a viewer can never widen past their claims by adding `filters`.
   */
  rls?: MetricFilter[];
  /** Time-grain override for the first time dimension (day|week|month|quarter|year). */
  grain?: string;
  /** Target engine (default `synapse`). */
  engine?: MetricEngine;
}

/** A compiled, ready-to-execute metric query. */
export interface CompiledMetricQuery {
  /** The metric this query computes. */
  metric: string;
  engine: MetricEngine;
  /** The SQL dialect / query language the text is in. */
  dialect: 'synapse' | 'kql';
  /** The compiled query text (T-SQL or KQL). */
  sql: string;
  /** Bound parameters for the T-SQL engines (empty for KQL — values are escaped). */
  params: SynapseQueryParam[];
  /** The resolved group-by dimension names (in emit order). */
  groupBy: string[];
}

/** Thrown for an unresolvable metric / unknown dimension / bad grain. */
export class MetricCompileError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'MetricCompileError';
  }
}

// ── Resolution ───────────────────────────────────────────────────────────────

interface ResolvedMetric {
  metric: string;
  model: MfSemanticModel;
  measure: MfMeasure;
  /** Dimension lookup by name (whitelist). */
  dimByName: Map<string, MfDimension>;
  /** The metric-level filter, parsed structurally (or null). */
  metricFilter: MetricFilter | null;
}

/** Parse a metric-level `<column> <op> <value>` filter into a structured predicate. */
function parseMetricFilter(raw: string, model: MfSemanticModel): MetricFilter | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = /^([A-Za-z0-9_]+)\s*(=|!=|<>|>=|<=|>|<)\s*(.+)$/.exec(s);
  if (!m) {
    throw new MetricCompileError(
      `Metric filter "${raw}" is not a supported "<column> <op> <value>" predicate.`,
    );
  }
  const dimension = m[1];
  const op = (m[2] === '<>' ? '!=' : m[2]) as MetricFilter['op'];
  let rawVal = m[3].trim();
  // Strip surrounding quotes if present (governed authors may quote strings).
  if ((rawVal.startsWith("'") && rawVal.endsWith("'")) || (rawVal.startsWith('"') && rawVal.endsWith('"'))) {
    rawVal = rawVal.slice(1, -1);
  }
  const num = Number(rawVal);
  const value: string | number = rawVal !== '' && Number.isFinite(num) && /^[-\d.]+$/.test(rawVal) ? num : rawVal;
  // The column must be a declared dimension OR the measure's own expr column —
  // in the subset we require it to be a declared dimension (whitelist).
  if (!model.dimensions.some((d) => d.name === dimension || d.expr === dimension)) {
    throw new MetricCompileError(
      `Metric filter references "${dimension}", which is not a declared dimension of model "${model.name}".`,
    );
  }
  return { dimension, op, value };
}

function resolveMetric(spec: MetricFlowSpec, metricName: string): ResolvedMetric {
  const metric = spec.metrics.find((m) => m.name === metricName);
  if (!metric) {
    throw new MetricCompileError(`Metric "${metricName}" is not defined in the governed spec.`, 404);
  }
  const resolved = resolveMetricMeasure(spec, metric);
  if (!resolved) {
    throw new MetricCompileError(
      `Metric "${metricName}" references measure "${metric.measure}", which no semantic_model defines.`,
    );
  }
  const dimByName = new Map<string, MfDimension>();
  for (const d of resolved.model.dimensions) dimByName.set(d.name, d);
  return {
    metric: metric.name,
    model: resolved.model,
    measure: resolved.measure,
    dimByName,
    metricFilter: parseMetricFilter(metric.filter, resolved.model),
  };
}

/** Look up a requested dimension, rejecting anything not on the model (whitelist). */
function requireDimension(rm: ResolvedMetric, name: string): MfDimension {
  const d = rm.dimByName.get(name);
  if (!d) {
    throw new MetricCompileError(
      `Dimension "${name}" is not declared on semantic model "${rm.model.name}" for metric "${rm.metric}".`,
    );
  }
  return d;
}

// ── T-SQL (Synapse serverless / lakehouse) ───────────────────────────────────

const TSQL_AGG: Record<MfAgg, (col: string) => string> = {
  sum: (c) => `SUM(${c})`,
  count: () => 'COUNT(*)',
  count_distinct: (c) => `COUNT(DISTINCT ${c})`,
  average: (c) => `AVG(${c})`,
  min: (c) => `MIN(${c})`,
  max: (c) => `MAX(${c})`,
};

/** `[schema].[table]` (bracket-quoted, injection-safe) from a `schema.table` relation. */
function tsqlRelation(relation: string): string {
  const parts = relation.split('.').filter((p) => p.trim() !== '');
  return parts.map((p) => bracket(p.trim())).join('.');
}

/** A time-dimension group expression bucketed to a grain, over a bracket-quoted column. */
function tsqlTimeBucket(colSql: string, grain: string): string {
  switch (grain) {
    case 'year':
      return `DATEFROMPARTS(YEAR(${colSql}), 1, 1)`;
    case 'quarter':
      return `DATEFROMPARTS(YEAR(${colSql}), ((DATEPART(QUARTER, ${colSql}) - 1) * 3) + 1, 1)`;
    case 'month':
      return `DATEFROMPARTS(YEAR(${colSql}), MONTH(${colSql}), 1)`;
    case 'week':
      return `DATEADD(DAY, 1 - DATEPART(WEEKDAY, ${colSql}), CONVERT(date, ${colSql}))`;
    case 'day':
    default:
      return `CONVERT(date, ${colSql})`;
  }
}

/** The group-by SQL expression for a dimension (time buckets to grain). */
function tsqlDimExpr(dim: MfDimension, grainOverride: string | undefined): string {
  const col = bracket(dim.expr);
  if (dim.type === 'time') return tsqlTimeBucket(col, grainOverride || dim.grain || 'day');
  return col;
}

function compileTsql(rm: ResolvedMetric, args: CompileMetricArgs, engine: MetricEngine): CompiledMetricQuery {
  const dims = args.dimensions ?? [];
  const groupBy: string[] = [];
  const selectDims: string[] = [];
  const groupExprs: string[] = [];
  let firstTimeGrainUsed = false;
  for (const name of dims) {
    const dim = requireDimension(rm, name);
    // Apply the grain override to the FIRST time dimension only.
    const grain = dim.type === 'time' && !firstTimeGrainUsed ? args.grain : undefined;
    if (dim.type === 'time' && !firstTimeGrainUsed) firstTimeGrainUsed = true;
    const expr = tsqlDimExpr(dim, grain);
    selectDims.push(`${expr} AS ${bracket(dim.name)}`);
    groupExprs.push(expr);
    groupBy.push(dim.name);
  }

  const aggSql = TSQL_AGG[rm.measure.agg](bracket(rm.measure.expr));
  const selectList = [...selectDims, `${aggSql} AS ${bracket(rm.metric)}`].join(', ');

  // WHERE — metric-level filter + requested filters, all parameterised.
  const params: SynapseQueryParam[] = [];
  const whereParts: string[] = [];
  // Order is load-bearing for RLS: metric-level filter, then the identity's RLS
  // predicates, then the caller's own filters. RLS is ANDed in every case so a
  // requested filter can only NARROW, never widen past the token identity.
  const allFilters: MetricFilter[] = [
    ...(rm.metricFilter ? [rm.metricFilter] : []),
    ...(args.rls ?? []),
    ...(args.filters ?? []),
  ];
  for (const f of allFilters) {
    const dim = requireDimension(rm, f.dimension);
    const col = bracket(dim.expr);
    if (f.op === 'in') {
      const values = Array.isArray(f.value) ? f.value : [f.value];
      if (values.length === 0) {
        whereParts.push('1 = 0'); // empty IN () — no rows, never a syntax error
        continue;
      }
      const markers = values.map((v) => {
        const name = `p${params.length}`;
        params.push({ name, value: v === null || v === undefined ? null : String(v) });
        return `@${name}`;
      });
      whereParts.push(`${col} IN (${markers.join(', ')})`);
    } else {
      const name = `p${params.length}`;
      const scalar = Array.isArray(f.value) ? f.value[0] : f.value;
      params.push({ name, value: scalar === null || scalar === undefined ? null : String(scalar) });
      whereParts.push(`${col} ${f.op} @${name}`);
    }
  }

  const from = tsqlRelation(rm.model.relation);
  let sql = `SELECT ${selectList} FROM ${from}`;
  if (whereParts.length) sql += ` WHERE ${whereParts.join(' AND ')}`;
  if (groupExprs.length) sql += ` GROUP BY ${groupExprs.join(', ')}`;

  return { metric: rm.metric, engine, dialect: 'synapse', sql, params, groupBy };
}

// ── KQL (Azure Data Explorer) ────────────────────────────────────────────────

const KQL_AGG: Record<MfAgg, (col: string) => string> = {
  sum: (c) => `sum(${c})`,
  count: () => 'count()',
  count_distinct: (c) => `dcount(${c})`,
  average: (c) => `avg(${c})`,
  min: (c) => `min(${c})`,
  max: (c) => `max(${c})`,
};

const KQL_TIMESPAN: Record<string, string> = {
  day: '1d',
  week: '7d',
  month: '30d',
  quarter: '91d',
  year: '365d',
};

/** Bracket-quote a KQL entity name: `['name']` (names are whitelisted from the spec). */
function kqlIdent(name: string): string {
  // Defence-in-depth: strip anything outside the whitelisted grammar. Names reach
  // here ONLY from the governed spec (already validated), so this never alters a
  // legitimate name — it just guarantees no control chars can appear.
  return `['${escapeSqlLiteral(String(name))}']`;
}

/** A KQL scalar literal — numbers inline, strings single-quoted + escaped. */
function kqlLiteral(value: string | number): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return `'${escapeSqlLiteral(String(value))}'`;
}

function kqlDimExpr(dim: MfDimension, grainOverride: string | undefined): string {
  const col = kqlIdent(dim.expr);
  if (dim.type === 'time') {
    const span = KQL_TIMESPAN[grainOverride || dim.grain || 'day'] || '1d';
    return `bin(${col}, ${span})`;
  }
  return col;
}

function compileKql(rm: ResolvedMetric, args: CompileMetricArgs): CompiledMetricQuery {
  const dims = args.dimensions ?? [];
  const groupBy: string[] = [];
  const byExprs: string[] = [];
  let firstTimeGrainUsed = false;
  for (const name of dims) {
    const dim = requireDimension(rm, name);
    const grain = dim.type === 'time' && !firstTimeGrainUsed ? args.grain : undefined;
    if (dim.type === 'time' && !firstTimeGrainUsed) firstTimeGrainUsed = true;
    byExprs.push(`${kqlIdent(dim.name)} = ${kqlDimExpr(dim, grain)}`);
    groupBy.push(dim.name);
  }

  const allFilters: MetricFilter[] = [
    ...(rm.metricFilter ? [rm.metricFilter] : []),
    ...(args.rls ?? []),
    ...(args.filters ?? []),
  ];
  const whereParts: string[] = [];
  for (const f of allFilters) {
    const dim = requireDimension(rm, f.dimension);
    const col = kqlIdent(dim.expr);
    if (f.op === 'in') {
      const values = Array.isArray(f.value) ? f.value : [f.value];
      if (values.length === 0) {
        whereParts.push('false');
        continue;
      }
      whereParts.push(`${col} in (${values.map((v) => kqlLiteral(v as string | number)).join(', ')})`);
    } else {
      const scalar = Array.isArray(f.value) ? f.value[0] : f.value;
      const kop = f.op === '=' ? '==' : f.op;
      whereParts.push(`${col} ${kop} ${kqlLiteral(scalar as string | number)}`);
    }
  }

  // The relation's last segment is the ADX table name.
  const table = kqlIdent(rm.model.relation.split('.').filter(Boolean).pop() || rm.model.relation);
  const summarize = `${kqlIdent(rm.metric)} = ${KQL_AGG[rm.measure.agg](kqlIdent(rm.measure.expr))}`;
  let kql = table;
  if (whereParts.length) kql += `\n| where ${whereParts.join(' and ')}`;
  kql += `\n| summarize ${summarize}`;
  if (byExprs.length) kql += ` by ${byExprs.join(', ')}`;

  return { metric: rm.metric, engine: 'adx', dialect: 'kql', sql: kql, params: [], groupBy };
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Compile a governed metric + its requested dimensions/filters/grain into a real
 * query for the target engine. Pure — no Azure, no I/O. This is the single
 * compile path the report designer, the Copilot NL2SQL path, and the REST/SDK
 * endpoint all call, guaranteeing the same governed number everywhere.
 */
export function compileMetricQuery(args: CompileMetricArgs): CompiledMetricQuery {
  const engine: MetricEngine = args.engine ?? 'synapse';
  const rm = resolveMetric(args.spec, args.metric);
  if (engine === 'adx') return compileKql(rm, args);
  // 'synapse' + 'lakehouse' both fold to the same bracket-quoted T-SQL; only the
  // resolved Synapse target differs (serverless-over-Delta vs pool), chosen by the
  // executing route.
  return compileTsql(rm, args, engine);
}
