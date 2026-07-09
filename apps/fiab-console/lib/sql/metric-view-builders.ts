/**
 * metric-view-builders — pure, dependency-free compilers for CSA Loom's
 * governed **Metric Views** (Databricks parity item DBX-6).
 *
 * A metric view is a reusable, governed set of business KPIs (measures) plus the
 * dimensions they slice by, defined ONCE over a fact table and queried by many
 * downstream surfaces (dashboards, the Data Agent, reports). Databricks ships
 * this as a Unity Catalog "metric view"; Loom's DEFAULT is its own Azure-native
 * semantic layer (compile each measure to a DAX measure on the Loom tabular
 * model, and compile the whole metric to a runnable GROUP BY SELECT that
 * executes against Synapse / the lakehouse). The Databricks UC metric view is
 * the OPT-IN backend — selected only when a workspace is bound.
 *
 * This module is the single home for that compilation and is 100% pure (no
 * network, no React) so it is exhaustively unit-testable. It emits THREE
 * artifacts from one typed spec:
 *
 *   1. compileMetricViewSelect(spec)  → Azure-native default. A read-only
 *      GROUP BY SELECT (dialect-aware: Synapse T-SQL brackets, Databricks SQL
 *      back-ticks) that produces the real aggregate rows — this is the "real
 *      query execution" path.
 *   2. compileMeasureDax(measure)     → Azure-native default. A DAX measure
 *      expression saved onto the Loom semantic model via the existing XMLA
 *      measure-write path.
 *   3. buildCreateMetricViewDdl(spec) → Databricks OPT-IN. A real
 *      `CREATE OR REPLACE VIEW … WITH METRICS LANGUAGE YAML AS $$…$$` statement
 *      executed via the Statement Execution API on a bound warehouse.
 *
 * SECURITY MODEL:
 *   - Every identifier (catalog/schema/table/dimension/measure name) is emitted
 *     through {@link quoteIdent} (dialect-correct delimiter doubling) and each
 *     name is validated against a strict identifier allowlist first.
 *   - Filter / string values are single-quote-escaped via
 *     {@link escapeSqlLiteral} (the one audited primitive).
 *   - Free-text SQL EXPRESSIONS (measure/dimension expr) are 1:1 with the
 *     Databricks "Custom expression" mode and the Synapse expression builder —
 *     an allowed free-text code surface. They are still hardened: `;`, the `$$`
 *     YAML/SQL delimiter, and SQL comment openers are rejected so a single
 *     expression can never break out of its statement or the `$$` YAML block.
 *
 * Grounded in Microsoft Learn (Databricks metric views):
 *   Create:  https://learn.microsoft.com/azure/databricks/business-semantics/metric-views/create
 *   YAML:    https://learn.microsoft.com/azure/databricks/business-semantics/metric-views/yaml-reference
 *   Query:   https://learn.microsoft.com/azure/databricks/business-semantics/metric-views/query
 *   CREATE VIEW … WITH METRICS: https://learn.microsoft.com/azure/databricks/sql/language-manual/sql-ref-syntax-ddl-create-view
 */

import { escapeSqlLiteral, quoteIdent, type SqlDialect } from '@/lib/sql/quoting';

/** Throwable for all build-time validation failures (surfaced as HTTP 400). */
export class MetricBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricBuildError';
  }
}

/** Aggregation kinds the Builder mode exposes (Databricks "Builder" parity) +
 *  a CUSTOM escape hatch that takes a full expression verbatim. */
export type MetricAggregation =
  | 'SUM'
  | 'AVG'
  | 'COUNT'
  | 'COUNT_DISTINCT'
  | 'MIN'
  | 'MAX'
  | 'CUSTOM';

export const METRIC_AGGREGATIONS: MetricAggregation[] = [
  'SUM', 'AVG', 'COUNT', 'COUNT_DISTINCT', 'MIN', 'MAX', 'CUSTOM',
];

export interface MetricDimension {
  /** Dimension name — becomes the SELECT alias / YAML `name`. */
  name: string;
  /** SQL expression for the dimension (a bare column or an expression). */
  expr: string;
  /** Optional description (YAML comment / metadata). */
  comment?: string;
}

export interface MetricMeasure {
  /** Measure name — becomes the SELECT alias / YAML `name` / DAX measure name. */
  name: string;
  /** Aggregation applied to `expr`. CUSTOM emits `expr` verbatim as the whole
   *  measure expression (e.g. `SUM(a) / COUNT(DISTINCT b)`). */
  aggregation: MetricAggregation;
  /** For non-CUSTOM: the column/expression being aggregated. For CUSTOM: the
   *  full measure expression. COUNT with an empty expr → `COUNT(1)`. */
  expr?: string;
  /** Optional description (YAML comment / metadata). */
  comment?: string;
}

export interface MetricViewSpec {
  /** Source fact object. 1–3 dotted identifier parts (`orders`,
   *  `schema.orders`, or `catalog.schema.orders`). */
  source: string;
  dimensions: MetricDimension[];
  measures: MetricMeasure[];
  /** Optional row filter applied before aggregation (a boolean SQL predicate).*/
  filter?: string;
  /** Optional metric-view comment (YAML `comment`). */
  comment?: string;
}

// ------------------------------------------------------------
// Validation helpers
// ------------------------------------------------------------

/** A strict object-name allowlist for names we emit as aliases / YAML keys. */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertName(name: string, what: string): string {
  const s = String(name ?? '').trim();
  if (!s) throw new MetricBuildError(`${what} is required`);
  if (!NAME_RE.test(s)) {
    throw new MetricBuildError(
      `${what} "${s}" must start with a letter/underscore and contain only letters, digits, and underscores`,
    );
  }
  if (s.length > 128) throw new MetricBuildError(`${what} is too long (>128): ${s.slice(0, 32)}…`);
  return s;
}

// Sequences that must never appear in a free-text expression: a statement
// terminator, the `$$` YAML-body delimiter, or a SQL comment opener. Each would
// let one expression escape its statement / the `$$` block.
const EXPR_FORBIDDEN = /(;|\$\$|--|\/\*|\*\/)/;

// Positive allowlist for the whole free-text expression: the exact character
// set a scalar SQL expression needs — identifiers, numbers, whitespace,
// string/quoted-identifier delimiters (' " [ ] `), arithmetic/comparison
// operators, parentheses, dotted/comma-separated argument lists, `|` (concat /
// bitwise), and `:` (`::` casts). This is an anchored, full-string allowlist:
// nothing outside the set can appear, so backslash escapes, `@`/`#` variables,
// `{}` blocks, `$` and control characters are all rejected. It is the primary
// SQL-injection barrier for the executed GROUP BY SELECT (the free-text
// expression is the only value inlined rather than identifier-quoted/bound);
// the EXPR_FORBIDDEN blocklist above still rejects the `--` / `/* */` / `;` /
// `$$` multi-char breakout sequences that this class would otherwise permit.
const EXPR_ALLOWED = /^[A-Za-z0-9_ \t\r\n.,()'"[\]`+\-*/%<>=!|:]+$/;

function assertExpr(expr: string, what: string): string {
  const s = String(expr ?? '').trim();
  if (!s) throw new MetricBuildError(`${what} expression is required`);
  if (s.length > 4000) throw new MetricBuildError(`${what} expression is too long (>4000)`);
  if (!EXPR_ALLOWED.test(s)) {
    throw new MetricBuildError(
      `${what} expression contains characters outside the allowed set ` +
        `(letters, digits, _ . , ( ) ' " [ ] \` + - * / % < > = ! | : and whitespace)`,
    );
  }
  if (EXPR_FORBIDDEN.test(s)) {
    throw new MetricBuildError(
      `${what} expression may not contain ';', '$$', or SQL comment markers`,
    );
  }
  return s;
}

/** Validate + back-tick / bracket quote a 1–3 part dotted source name. */
function quoteSource(source: string, dialect: SqlDialect): string {
  const parts = String(source ?? '').split('.').map((p) => p.trim()).filter(Boolean);
  if (!parts.length || parts.length > 3) {
    throw new MetricBuildError('source must be a 1–3 part name (table, schema.table, or catalog.schema.table)');
  }
  return parts.map((p) => quoteIdent(assertName(p, 'source part'), dialect)).join('.');
}

/** The UNQUOTED dotted source (for the YAML `source:` line, which takes a plain
 *  fully-qualified name). Each part is still identifier-validated. */
function plainSource(source: string): string {
  const parts = String(source ?? '').split('.').map((p) => p.trim()).filter(Boolean);
  if (!parts.length || parts.length > 3) {
    throw new MetricBuildError('source must be a 1–3 part name (table, schema.table, or catalog.schema.table)');
  }
  return parts.map((p) => assertName(p, 'source part')).join('.');
}

function assertNonEmptyMembers(spec: MetricViewSpec): void {
  if (!spec.dimensions?.length && !spec.measures?.length) {
    throw new MetricBuildError('a metric view needs at least one dimension or measure');
  }
  if (!spec.measures?.length) {
    throw new MetricBuildError('a metric view needs at least one measure');
  }
}

// ------------------------------------------------------------
// 1. Azure-native default — runnable GROUP BY SELECT
// ------------------------------------------------------------

/** Render one measure as a SQL aggregate over its expression. */
function measureSql(m: MetricMeasure): string {
  const name = assertName(m.name, 'measure name');
  const agg = m.aggregation;
  if (agg === 'CUSTOM') {
    return assertExpr(m.expr || '', `measure "${name}"`);
  }
  if (agg === 'COUNT') {
    // COUNT with no column counts rows; with a column counts non-nulls.
    const inner = m.expr && m.expr.trim() ? assertExpr(m.expr, `measure "${name}"`) : '1';
    return `COUNT(${inner})`;
  }
  const inner = assertExpr(m.expr || '', `measure "${name}"`);
  switch (agg) {
    case 'SUM': return `SUM(${inner})`;
    case 'AVG': return `AVG(${inner})`;
    case 'MIN': return `MIN(${inner})`;
    case 'MAX': return `MAX(${inner})`;
    case 'COUNT_DISTINCT': return `COUNT(DISTINCT ${inner})`;
    default:
      throw new MetricBuildError(`unsupported aggregation: ${String(agg)}`);
  }
}

export interface CompileSelectOptions {
  /** SQL dialect for identifier quoting. Default 'synapse' (the Azure-native
   *  default backend); use 'databricks-sql' when running on a warehouse. */
  dialect?: SqlDialect;
  /** Row cap. Synapse family emits `TOP n`; other dialects emit `LIMIT n`. */
  limit?: number;
}

/**
 * Compile the metric view to a runnable, read-only GROUP BY SELECT that returns
 * the real aggregate rows — the Azure-native default execution path.
 */
export function compileMetricViewSelect(spec: MetricViewSpec, opts: CompileSelectOptions = {}): string {
  assertNonEmptyMembers(spec);
  const dialect = opts.dialect ?? 'synapse';
  const src = quoteSource(spec.source, dialect);
  const bracketed = dialect === 'tsql' || dialect === 'synapse' || dialect === 'generic-sql' || !dialect;

  const dimCols: string[] = [];
  const groupBys: string[] = [];
  for (const d of spec.dimensions || []) {
    const alias = quoteIdent(assertName(d.name, 'dimension name'), dialect);
    const expr = assertExpr(d.expr, `dimension "${d.name}"`);
    dimCols.push(`${expr} AS ${alias}`);
    groupBys.push(expr);
  }

  const measureCols = (spec.measures || []).map((m) => {
    const alias = quoteIdent(assertName(m.name, 'measure name'), dialect);
    return `${measureSql(m)} AS ${alias}`;
  });

  const selectList = [...dimCols, ...measureCols].join(',\n  ');
  const limit = Number.isInteger(opts.limit) && (opts.limit as number) > 0 ? opts.limit : undefined;
  const top = limit && bracketed ? `TOP ${limit} ` : '';

  const lines: string[] = [`SELECT ${top}\n  ${selectList}`, `FROM ${src}`];
  if (spec.filter && spec.filter.trim()) {
    lines.push(`WHERE ${assertExpr(spec.filter, 'filter')}`);
  }
  if (groupBys.length) lines.push(`GROUP BY ${groupBys.join(', ')}`);
  if (limit && !bracketed) lines.push(`LIMIT ${limit}`);
  return lines.join('\n') + ';';
}

// ------------------------------------------------------------
// 2. Azure-native default — DAX measure per measure
// ------------------------------------------------------------

/** Wrap a bare column reference `[col]` around a plain identifier, or pass a
 *  full expression through when it is not a simple column. */
function daxOperand(expr: string, tableRef?: string): string {
  const s = expr.trim();
  const isBareCol = /^[A-Za-z_][A-Za-z0-9_ ]*$/.test(s);
  if (isBareCol) {
    // DAX column ref `[col]` — bracket-quote (doubles any `]`) via the audited
    // quoteIdent primitive (T-SQL bracket dialect), never an inline replace.
    const col = quoteIdent(s);
    return tableRef ? `${tableRef}${col}` : col;
  }
  return s; // already an expression (e.g. contains functions/operators)
}

/**
 * Compile one measure to a DAX measure expression for the Loom semantic model.
 * `tableRef` (e.g. `'Sales'`) qualifies bare column references.
 */
export function compileMeasureDax(m: MetricMeasure, tableRef?: string): string {
  const name = assertName(m.name, 'measure name');
  // DAX single-quoted table name — escape embedded quotes via escapeSqlLiteral
  // (the audited single-quote-doubling primitive).
  const table = tableRef ? `'${escapeSqlLiteral(tableRef)}'` : undefined;
  if (m.aggregation === 'CUSTOM') {
    // A custom DAX/SQL-ish expression is passed through (expression builder).
    return assertExpr(m.expr || '', `measure "${name}"`);
  }
  if (m.aggregation === 'COUNT') {
    return table ? `COUNTROWS ( ${table} )` : 'COUNTROWS ( )';
  }
  const operand = daxOperand(assertExpr(m.expr || '', `measure "${name}"`), table);
  switch (m.aggregation) {
    case 'SUM': return `SUM ( ${operand} )`;
    case 'AVG': return `AVERAGE ( ${operand} )`;
    case 'MIN': return `MIN ( ${operand} )`;
    case 'MAX': return `MAX ( ${operand} )`;
    case 'COUNT_DISTINCT': return `DISTINCTCOUNT ( ${operand} )`;
    default:
      throw new MetricBuildError(`unsupported aggregation: ${String(m.aggregation)}`);
  }
}

// ------------------------------------------------------------
// 3. Databricks opt-in — CREATE … WITH METRICS LANGUAGE YAML
// ------------------------------------------------------------

/** Escape a value for a YAML double-quoted flow scalar. NOT a SQL literal — a
 *  YAML scalar — so it does not go through escapeSqlLiteral. Newlines are
 *  folded to `\n` (single-line scalar) and the `$$` delimiter is already
 *  rejected upstream by assertExpr. */
function yamlDq(value: string): string {
  const escaped = String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n');
  return `"${escaped}"`;
}

/** Build the metric-view YAML body (between the `$$` delimiters). Uses the
 *  low-code editor's `dimensions` keyword. */
export function buildMetricViewYaml(spec: MetricViewSpec): string {
  assertNonEmptyMembers(spec);
  const lines: string[] = ['version: 0.1', `source: ${plainSource(spec.source)}`];
  if (spec.comment && spec.comment.trim()) lines.push(`comment: ${yamlDq(spec.comment.trim())}`);
  if (spec.filter && spec.filter.trim()) lines.push(`filter: ${yamlDq(assertExpr(spec.filter, 'filter'))}`);

  if (spec.dimensions?.length) {
    lines.push('dimensions:');
    for (const d of spec.dimensions) {
      const name = assertName(d.name, 'dimension name');
      lines.push(`  - name: ${name}`);
      lines.push(`    expr: ${yamlDq(assertExpr(d.expr, `dimension "${name}"`))}`);
      if (d.comment && d.comment.trim()) lines.push(`    comment: ${yamlDq(d.comment.trim())}`);
    }
  }

  lines.push('measures:');
  for (const m of spec.measures) {
    const name = assertName(m.name, 'measure name');
    lines.push(`  - name: ${name}`);
    lines.push(`    expr: ${yamlDq(measureSql(m))}`);
    if (m.comment && m.comment.trim()) lines.push(`    comment: ${yamlDq(m.comment.trim())}`);
  }
  return lines.join('\n');
}

export interface CreateMetricViewParams {
  catalog: string;
  schema: string;
  name: string;
  spec: MetricViewSpec;
  orReplace?: boolean;
}

/** `CREATE [OR REPLACE] VIEW cat.schema.name WITH METRICS LANGUAGE YAML AS $$…$$` */
export function buildCreateMetricViewDdl(p: CreateMetricViewParams): string {
  const cat = assertName(p.catalog, 'catalog');
  const sch = assertName(p.schema, 'schema');
  const name = assertName(p.name, 'metric view name');
  const yaml = buildMetricViewYaml(p.spec); // validates + rejects `$$`
  const fq = `${quoteIdent(cat, 'databricks-sql')}.${quoteIdent(sch, 'databricks-sql')}.${quoteIdent(name, 'databricks-sql')}`;
  return [
    `CREATE ${p.orReplace ? 'OR REPLACE ' : ''}VIEW ${fq}`,
    'WITH METRICS',
    'LANGUAGE YAML',
    'AS $$',
    yaml,
    '$$;',
  ].join('\n');
}

/** `DROP VIEW IF EXISTS cat.schema.name` — a metric view is dropped as a view. */
export function buildDropMetricViewDdl(catalog: string, schema: string, name: string): string {
  const fq = `${quoteIdent(assertName(catalog, 'catalog'), 'databricks-sql')}.${quoteIdent(assertName(schema, 'schema'), 'databricks-sql')}.${quoteIdent(assertName(name, 'metric view name'), 'databricks-sql')}`;
  return `DROP VIEW IF EXISTS ${fq};`;
}

/**
 * Compile a metric-view QUERY against a Databricks UC metric view — the
 * `SELECT dim, MEASURE(measure) FROM cat.schema.mv GROUP BY dim` form Databricks
 * requires (measures are only accessible through the `MEASURE()` function).
 */
export function compileMetricViewQuery(p: {
  catalog: string; schema: string; name: string;
  dimensions: string[]; measures: string[]; limit?: number;
}): string {
  const fq = `${quoteIdent(assertName(p.catalog, 'catalog'), 'databricks-sql')}.${quoteIdent(assertName(p.schema, 'schema'), 'databricks-sql')}.${quoteIdent(assertName(p.name, 'metric view name'), 'databricks-sql')}`;
  const dims = (p.dimensions || []).map((d) => quoteIdent(assertName(d, 'dimension name'), 'databricks-sql'));
  const meas = (p.measures || []).map((m) => `MEASURE(${quoteIdent(assertName(m, 'measure name'), 'databricks-sql')})`);
  if (!dims.length && !meas.length) throw new MetricBuildError('a query needs at least one dimension or measure');
  const selectList = [...dims, ...meas].join(', ');
  const lines = [`SELECT ${selectList}`, `FROM ${fq}`];
  if (dims.length) lines.push(`GROUP BY ${dims.join(', ')}`);
  const limit = Number.isInteger(p.limit) && (p.limit as number) > 0 ? p.limit : 100;
  lines.push(`LIMIT ${limit}`);
  return lines.join('\n') + ';';
}

/** `SHOW VIEWS IN cat.schema` — metric views appear as views; the caller filters
 *  to metric views by DESCRIBE. */
export function buildShowViewsDdl(catalog: string, schema: string): string {
  return `SHOW VIEWS IN ${quoteIdent(assertName(catalog, 'catalog'), 'databricks-sql')}.${quoteIdent(assertName(schema, 'schema'), 'databricks-sql')};`;
}

// ------------------------------------------------------------
// Data-Agent grounding (DBX-5 delta) — governed measure definitions
// ------------------------------------------------------------

/**
 * Produce the grounding text a Data Agent uses when a metric view is attached
 * as a source: it lists the governed dimensions + measures (with their compiled
 * SQL) so the model resolves NL questions to the GOVERNED KPI definitions
 * instead of guessing raw-column aggregates. Pure — reused by the agent editor
 * to seed a source's instructions and unit-tested.
 */
export function metricViewGroundingText(spec: MetricViewSpec, viewName?: string): string {
  const lines: string[] = [];
  const ref = viewName ? assertName(viewName, 'metric view name') : plainSource(spec.source);
  lines.push(`## Metric view: ${ref}`);
  lines.push(`Source table: ${plainSource(spec.source)}`);
  if (spec.filter && spec.filter.trim()) lines.push(`Base filter: ${spec.filter.trim()}`);
  if (spec.dimensions?.length) {
    lines.push('');
    lines.push('## Governed dimensions (slice measures by these)');
    for (const d of spec.dimensions) {
      lines.push(`- ${assertName(d.name, 'dimension name')} = ${assertExpr(d.expr, `dimension "${d.name}"`)}${d.comment ? ` — ${d.comment.trim()}` : ''}`);
    }
  }
  lines.push('');
  lines.push('## Governed measures (use these EXACT aggregate definitions)');
  for (const m of spec.measures) {
    lines.push(`- ${assertName(m.name, 'measure name')} = ${measureSql(m)}${m.comment ? ` — ${m.comment.trim()}` : ''}`);
  }
  lines.push('');
  lines.push('When asked for a KPI, GROUP BY the requested governed dimension(s) and select the governed measure expression(s) above. Do not invent alternative aggregations.');
  return lines.join('\n');
}
