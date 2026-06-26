/**
 * wells-to-sql — compile the report designer's visual field-wells into a
 * parameterized T-SQL `SELECT … GROUP BY` over Synapse (dedicated warehouse or
 * serverless-over-lakehouse). This is the Azure-native equivalent of
 * `aas-dax.buildDaxFromVisual`: it lets a Loom report render REAL aggregated
 * rows WITHOUT Azure Analysis Services / Power BI / Fabric in the loop
 * (no-fabric-dependency.md). The companion `buildDaxFilterWrapper` /
 * `wrapDaxWithFilters` append the SAME structured filters to the existing AAS
 * DAX path, so both backends honor the Filters pane.
 *
 * Pure + credential-free (mirrors aas-dax.ts): no Azure SDK, no network — only
 * string synthesis — so the SQL compiler can be unit-tested in isolation and the
 * two report routes (/fields, /query) stay thin dispatchers. The caller runs the
 * returned `{ sql, parameters }` through `synapse-sql-client.executeQuery`.
 *
 * Rules compliance:
 *  - no-vaporware: every branch emits a real, runnable query against a real
 *    Synapse relation; values are bound as TDS parameters and rows come back
 *    from the pool — no mock arrays, no `return []`.
 *  - no-freeform-config: the user never types SQL/DAX here. Wells + filters are
 *    structured picker output; the ONLY free text is the (already sql-guard'd)
 *    direct-query `SELECT` the resolver hands us as a derived FROM.
 *  - injection-safe: identifiers are NEVER taken from the client. Every column /
 *    table / measure is resolved against the resolver-supplied `SqlSource`
 *    whitelist and bracket-quoted (`]` → `]]`); a field not in the whitelist is
 *    skipped, never emitted. All literal values bind as `@p<n>` parameters
 *    (mirrors sql-to-pushdataset's `bracket` + sql-guard's read-only contract).
 */

import type { DaxVisual, DaxWellField } from './aas-dax';
import type { SynapseQueryParam } from './synapse-sql-client';

// ── SQL source (resolver-supplied; the FROM relation + identifier whitelist) ───

/** A base table the FROM clause can target (`[schema].[table]`). */
export interface SqlSourceTable {
  kind: 'table';
  schema?: string;
  table: string;
}

/**
 * A derived relation — the resolver hands us a single read-only `SELECT`
 * (direct-query source, or a multi-table model the resolver already flattened
 * into a join). It is wrapped as `(<sql>) AS [src]`. The SQL is validated by
 * `sql-guard.readOnlySelect` upstream; this module never authors it.
 */
export interface SqlSourceDerived {
  kind: 'derived';
  sql: string;
}

export type SqlSourceFrom = SqlSourceTable | SqlSourceDerived;

/**
 * A column the FROM relation exposes. The compiler only ever emits a bracketed
 * identifier that appears here, so a well/filter field that doesn't resolve to
 * one of these is dropped (defense in depth against identifier injection). For a
 * semantic-model source these come from `SemanticModelContent.tables`; for a
 * direct-query source from a `SELECT TOP 0` introspection — real schema, no mock.
 */
export interface SqlSourceColumn {
  /** Model table this column belongs to (matches the well field's `table`). */
  table?: string;
  /** Column name as exposed by the FROM relation (used verbatim, bracket-quoted). */
  name: string;
  /** Optional SQL type hint (informational; values still bind as parameters). */
  dataType?: string;
}

/**
 * A model measure pre-resolved to a SQL aggregate EXPRESSION by the resolver
 * (e.g. `SUM([Amount])`, `COUNT(DISTINCT [CustomerId])`). Built from
 * `SemanticModelContent.measures` — never from client text — so it is safe to
 * inline. Used for value-well measures and for measure-scoped filters (HAVING).
 */
export interface SqlSourceMeasure {
  /** Measure name (matches a value-well field's / filter's `measure`). */
  name: string;
  /** Resolver-built SQL aggregate expression. */
  expr: string;
}

/** Everything the compiler needs to turn wells into a real, runnable query. */
export interface SqlSource {
  /** The FROM relation (base table or derived SELECT), aliased `[src]`. */
  from: SqlSourceFrom;
  /** Whitelist of selectable columns (the only legal identifiers). */
  columns: SqlSourceColumn[];
  /** Whitelist of measure → SQL aggregate expressions. */
  measures?: SqlSourceMeasure[];
}

// ── Structured filter input (mirror of the designer's wired filter shape) ──────

/** Filter operators surfaced by the Filters pane (no typed predicates). */
export type ReportFilterOp = 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'in' | 'contains' | 'between';

/**
 * A single structured filter as sent by the designer (`wireFilters` strips the
 * client-only `id`). Field is a model column (`table`+`column`) or a `measure`.
 */
export interface ReportFilterInput {
  table?: string;
  column?: string;
  measure?: string;
  op: ReportFilterOp;
  /** Single value (eq/ne/gt/ge/lt/le/contains) or the lower bound (between). */
  value?: string;
  /** Upper bound for `between`. */
  value2?: string;
  /** Allowed set for `in` (also editable as a comma list). */
  values?: string[];
}

// ── Compiled output ────────────────────────────────────────────────────────────

/** The runnable artifact: a SQL text + the parameters to bind via executeQuery. */
export interface CompiledSql {
  sql: string;
  parameters: SynapseQueryParam[];
}

// ── Maps ───────────────────────────────────────────────────────────────────────

/** Loom aggregation choice → T-SQL aggregate function. Mirrors aas-dax's map. */
export const SQL_AGG_FN: Record<string, string> = {
  Sum: 'SUM',
  Avg: 'AVG',
  Count: 'COUNT',
  Min: 'MIN',
  Max: 'MAX',
};

/** Scalar comparison operators (in/contains/between handled separately). */
const SQL_SCALAR_OP: Partial<Record<ReportFilterOp, string>> = {
  eq: '=',
  ne: '<>',
  gt: '>',
  ge: '>=',
  lt: '<',
  le: '<=',
};

/** Row cap for grouped / projection queries (executeQuery further caps at 5k). */
const ROW_CAP = 1000;

// ── Identifier helpers (injection-safe) ────────────────────────────────────────

/** Bracket-quote a SQL identifier (double any `]`). Mirrors sql-to-pushdataset. */
export function bracket(ident: string): string {
  return `[${ident.replace(/]/g, ']]')}]`;
}

/** A `[src].[Column]` reference for a whitelisted column. */
function colRef(name: string): string {
  return `[src].${bracket(name)}`;
}

/** Render the FROM relation, aliased `[src]`. */
function renderFrom(src: SqlSource): string {
  if (src.from.kind === 'table') {
    const schema = src.from.schema ? `${bracket(src.from.schema)}.` : '';
    return `${schema}${bracket(src.from.table)} AS [src]`;
  }
  // Derived: resolver-supplied, sql-guard-validated read-only SELECT.
  return `(${src.from.sql.trim().replace(/;+\s*$/, '')}) AS [src]`;
}

/**
 * Resolve a well/filter column against the whitelist. Prefers an exact
 * (table,column) match; falls back to a unique case-insensitive name match.
 * Returns the canonical whitelisted column name (so the EMITTED identifier comes
 * from the resolver, never from the client), or null when not whitelisted.
 */
function resolveColumn(src: SqlSource, table: string | undefined, column: string | undefined): string | null {
  if (!column) return null;
  const wantCol = column.trim().toLowerCase();
  const wantTbl = (table || '').trim().toLowerCase();
  if (wantTbl) {
    const exact = src.columns.find(
      (c) => c.name.toLowerCase() === wantCol && (c.table || '').toLowerCase() === wantTbl,
    );
    if (exact) return exact.name;
  }
  const byName = src.columns.filter((c) => c.name.toLowerCase() === wantCol);
  return byName.length ? byName[0].name : null;
}

/** Resolve a measure name to its resolver-built SQL aggregate expression. */
function resolveMeasure(src: SqlSource, measure: string | undefined): string | null {
  if (!measure) return null;
  const want = measure.trim().toLowerCase();
  const m = (src.measures || []).find((x) => x.name.toLowerCase() === want);
  return m ? m.expr : null;
}

// ── Parameter bag ──────────────────────────────────────────────────────────────

/** Sequential `@p0, @p1 …` parameter allocator (values bound, never inlined). */
function paramBag() {
  const parameters: SynapseQueryParam[] = [];
  return {
    parameters,
    /** Register a value, returning its `@p<n>` marker. */
    add(value: string | null): string {
      const name = `p${parameters.length}`;
      parameters.push({ name, value });
      return `@${name}`;
    },
  };
}

/** Escape LIKE metacharacters so `contains` matches the literal substring. */
function likePattern(v: string): string {
  const esc = v.replace(/[\\%_[]/g, (c) => `\\${c}`);
  return `%${esc}%`;
}

// ── Value-well → aggregate projection ──────────────────────────────────────────

interface Projection { expr: string; alias: string }

/**
 * Build the aggregate expression + result alias for a value-well field. Measures
 * use their whitelisted SQL expression; columns are wrapped in their aggregation
 * (defaulting to SUM, matching the DAX path). Alias mirrors aas-dax's labels
 * (`<Agg> of <Column>` / `Sum of <Column>` / `<Measure>`) so SQL and DAX results
 * carry the same column names and the client renders/filters them identically.
 */
function aggProjection(src: SqlSource, w: DaxWellField): Projection | null {
  const mExpr = resolveMeasure(src, w.measure);
  if (mExpr && w.measure) return { expr: mExpr, alias: w.measure };

  const name = resolveColumn(src, w.table, w.column);
  if (name && w.column) {
    const useAgg = w.aggregation && w.aggregation !== 'None';
    const fn = useAgg ? SQL_AGG_FN[w.aggregation as string] || 'SUM' : 'SUM';
    const alias = useAgg ? `${w.aggregation} of ${w.column}` : `Sum of ${w.column}`;
    return { expr: `${fn}(${colRef(name)})`, alias };
  }
  return null;
}

/** Resolve a group/category well field to a `{ ref, alias }` (raw column). */
function groupColumn(src: SqlSource, w: DaxWellField): { ref: string; alias: string } | null {
  const name = resolveColumn(src, w.table, w.column);
  if (!name) return null;
  return { ref: colRef(name), alias: name };
}

// ── WHERE / HAVING from structured filters ─────────────────────────────────────

/**
 * Compile structured filters into parameterized predicates. Column filters land
 * in WHERE (pre-aggregation); measure filters land in HAVING (only meaningful
 * when the query aggregates). A filter whose field isn't whitelisted, or whose
 * value(s) are incomplete, is silently skipped — the client also applies filters
 * post-hoc, so a skipped predicate never blanks the visual.
 */
function compileFilters(
  src: SqlSource,
  filters: ReportFilterInput[] | undefined,
  pb: ReturnType<typeof paramBag>,
  allowHaving: boolean,
): { where: string[]; having: string[] } {
  const where: string[] = [];
  const having: string[] = [];
  for (const f of filters || []) {
    // Measure filter → HAVING (aggregated queries only).
    if (f.measure) {
      if (!allowHaving) continue;
      const expr = resolveMeasure(src, f.measure);
      if (!expr) continue;
      const pred = scalarPredicate(expr, f, pb);
      if (pred) having.push(pred);
      continue;
    }
    // Column filter → WHERE.
    const name = resolveColumn(src, f.table, f.column);
    if (!name) continue;
    const pred = scalarPredicate(colRef(name), f, pb);
    if (pred) where.push(pred);
  }
  return { where, having };
}

/** Build a single predicate for `ref <op> value(s)`, binding values as params. */
function scalarPredicate(ref: string, f: ReportFilterInput, pb: ReturnType<typeof paramBag>): string | null {
  switch (f.op) {
    case 'eq':
    case 'ne':
    case 'gt':
    case 'ge':
    case 'lt':
    case 'le': {
      if (f.value == null || f.value === '') return null;
      return `${ref} ${SQL_SCALAR_OP[f.op]} ${pb.add(f.value)}`;
    }
    case 'contains': {
      if (f.value == null || f.value === '') return null;
      return `${ref} LIKE ${pb.add(likePattern(f.value))} ESCAPE '\\'`;
    }
    case 'between': {
      if (!f.value || !f.value2) return null;
      return `${ref} BETWEEN ${pb.add(f.value)} AND ${pb.add(f.value2)}`;
    }
    case 'in': {
      const set = (f.values && f.values.length ? f.values : (f.value || '').split(','))
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
      if (!set.length) return null;
      return `${ref} IN (${set.map((v) => pb.add(v)).join(', ')})`;
    }
    default:
      return null;
  }
}

/** Join collected WHERE / HAVING / ORDER BY clauses onto a SELECT skeleton. */
function assemble(
  select: string,
  from: string,
  where: string[],
  groupBy: string[],
  having: string[],
  orderBy: string | null,
): string {
  let sql = `${select}\nFROM ${from}`;
  if (where.length) sql += `\nWHERE ${where.join(' AND ')}`;
  if (groupBy.length) sql += `\nGROUP BY ${groupBy.join(', ')}`;
  if (having.length) sql += `\nHAVING ${having.join(' AND ')}`;
  if (orderBy) sql += `\nORDER BY ${orderBy}`;
  return sql;
}

// ── Public: visual wells → SQL ─────────────────────────────────────────────────

/**
 * Compile a designer visual + structured filters into a parameterized T-SQL
 * query over `sqlSource`. Returns null when the visual has no whitelisted fields
 * (caller skips the visual / returns 400, exactly like `buildDaxFromVisual`).
 *
 *   card                      → SELECT <AGG(value) …>            (single row)
 *   slicer / category-only    → SELECT DISTINCT <category>       (ORDER BY it)
 *   table                     → SELECT TOP N <projection>        (raw columns)
 *   chart / matrix (grp+vals) → SELECT <grp>, <AGG(vals)> … GROUP BY <grp>
 *
 * Column filters become a parameterized WHERE; measure filters a HAVING (when
 * the query aggregates). Every identifier is whitelisted via `sqlSource`; every
 * value binds as `@p<n>` — no injection, no Fabric/AAS.
 */
export function buildSqlFromVisual(
  visual: DaxVisual,
  filters: ReportFilterInput[] | undefined,
  sqlSource: SqlSource,
): CompiledSql | null {
  const from = renderFrom(sqlSource);
  const wells = visual.wells || {};
  const category = wells.category || [];
  const values = wells.values || [];
  const legend = wells.legend || [];
  const type = (visual.type || '').toLowerCase();

  // ── table → raw projection (no aggregation, no grouping) ────────────────────
  if (type === 'table') {
    const cols = [...category, ...values]
      .map((w) => resolveColumn(sqlSource, w.table, w.column))
      .filter((n): n is string => !!n);
    const uniq = Array.from(new Set(cols));
    if (!uniq.length) return null;
    const pb = paramBag();
    const { where } = compileFilters(sqlSource, filters, pb, false);
    const select = `SELECT TOP ${ROW_CAP} ${uniq.map((n) => `${colRef(n)} AS ${bracket(n)}`).join(', ')}`;
    return { sql: assemble(select, from, where, [], [], bracket(uniq[0])), parameters: pb.parameters };
  }

  // ── slicer → distinct category values ───────────────────────────────────────
  if (type === 'slicer') {
    const g = category.map((w) => groupColumn(sqlSource, w)).filter((x): x is { ref: string; alias: string } => !!x);
    if (!g.length) return null;
    const pb = paramBag();
    const { where } = compileFilters(sqlSource, filters, pb, false);
    const select = `SELECT DISTINCT TOP ${ROW_CAP} ${g.map((c) => `${c.ref} AS ${bracket(c.alias)}`).join(', ')}`;
    return { sql: assemble(select, from, where, [], [], bracket(g[0].alias)), parameters: pb.parameters };
  }

  // ── card / chart / matrix → aggregate (optionally grouped) ──────────────────
  const groups = (type === 'card' ? [] : [...category, ...legend])
    .map((w) => groupColumn(sqlSource, w))
    .filter((x): x is { ref: string; alias: string } => !!x);
  // Dedupe group columns by alias (category+legend may overlap).
  const seen = new Set<string>();
  const group = groups.filter((g) => (seen.has(g.alias) ? false : (seen.add(g.alias), true)));

  const aggs = values
    .map((w) => aggProjection(sqlSource, w))
    .filter((x): x is Projection => !!x);

  if (group.length === 0 && aggs.length === 0) return null;

  const pb = paramBag();

  // No values → distinct grouping (acts like a slicer/category table).
  if (aggs.length === 0) {
    const { where } = compileFilters(sqlSource, filters, pb, false);
    const select = `SELECT DISTINCT TOP ${ROW_CAP} ${group.map((c) => `${c.ref} AS ${bracket(c.alias)}`).join(', ')}`;
    return { sql: assemble(select, from, where, [], [], bracket(group[0].alias)), parameters: pb.parameters };
  }

  // Aggregated query (card = no group; chart/matrix = grouped).
  const { where, having } = compileFilters(sqlSource, filters, pb, true);
  const selectCols = [
    ...group.map((c) => `${c.ref} AS ${bracket(c.alias)}`),
    ...aggs.map((a) => `${a.expr} AS ${bracket(a.alias)}`),
  ];
  const cap = group.length ? `TOP ${ROW_CAP} ` : '';
  const select = `SELECT ${cap}${selectCols.join(', ')}`;
  const groupBy = group.map((c) => c.ref);
  // Order grouped results by the first aggregate DESC so a TOP N keeps the most
  // significant rows; a card (no group) needs no ordering.
  const orderBy = group.length ? `${bracket(aggs[0].alias)} DESC` : null;
  return { sql: assemble(select, from, where, groupBy, having, orderBy), parameters: pb.parameters };
}

// ── Public: structured filters → DAX (AAS path) ────────────────────────────────

/** A `'Table'[Column]` reference for a DAX boolean predicate (table required). */
function daxQualifiedColumn(table: string, column: string): string {
  const t = `'${table.replace(/'/g, "''")}'`;
  return `${t}[${column.replace(/\]/g, ']]')}]`;
}

/** Emit a DAX literal: numeric when value looks numeric, else a quoted string. */
function daxLiteral(v: string): string {
  return /^-?\d+(\.\d+)?$/.test(v.trim()) ? v.trim() : `"${v.replace(/"/g, '""')}"`;
}

/** Build one DAX boolean predicate for a column filter (null → skip). */
function daxPredicate(f: ReportFilterInput): string | null {
  // CALCULATETABLE boolean predicates require a fully-qualified column; measure
  // filters (and table-less columns) are skipped here — the client applies them
  // post-hoc on the returned rows, so the visual is never blanked.
  if (f.measure || !f.table || !f.column) return null;
  const ref = daxQualifiedColumn(f.table, f.column);
  switch (f.op) {
    case 'eq': return f.value != null && f.value !== '' ? `${ref} = ${daxLiteral(f.value)}` : null;
    case 'ne': return f.value != null && f.value !== '' ? `${ref} <> ${daxLiteral(f.value)}` : null;
    case 'gt': return f.value != null && f.value !== '' ? `${ref} > ${daxLiteral(f.value)}` : null;
    case 'ge': return f.value != null && f.value !== '' ? `${ref} >= ${daxLiteral(f.value)}` : null;
    case 'lt': return f.value != null && f.value !== '' ? `${ref} < ${daxLiteral(f.value)}` : null;
    case 'le': return f.value != null && f.value !== '' ? `${ref} <= ${daxLiteral(f.value)}` : null;
    case 'contains':
      return f.value != null && f.value !== '' ? `SEARCH(${daxLiteral(f.value)}, ${ref}, 1, 0) > 0` : null;
    case 'between':
      return f.value && f.value2 ? `${ref} >= ${daxLiteral(f.value)} && ${ref} <= ${daxLiteral(f.value2)}` : null;
    case 'in': {
      const set = (f.values && f.values.length ? f.values : (f.value || '').split(','))
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
      return set.length ? `${ref} IN {${set.map(daxLiteral).join(', ')}}` : null;
    }
    default:
      return null;
  }
}

/**
 * Compile structured filters into a comma-joined list of DAX boolean predicates
 * suitable as the trailing filter arguments of `CALCULATETABLE(<table>, …)` (or
 * `SUMMARIZECOLUMNS(<grp>, FILTER(…), …)`). Returns '' when no column filter is
 * applicable. The user never types DAX — this is the structured Filters pane
 * compiled to a predicate, the AAS-side mirror of the SQL WHERE above.
 */
export function buildDaxFilterWrapper(filters: ReportFilterInput[] | undefined): string {
  return (filters || [])
    .map(daxPredicate)
    .filter((p): p is string => !!p)
    .join(', ');
}

/**
 * Wrap a DAX `EVALUATE <tableExpr>` (e.g. the output of `buildDaxFromVisual`) so
 * the structured filters apply, via `CALCULATETABLE`. No-op when there are no
 * applicable filters or the input isn't an EVALUATE we can wrap — so the existing
 * AAS path is never regressed; filters are purely additive.
 */
export function wrapDaxWithFilters(dax: string, filters: ReportFilterInput[] | undefined): string {
  const preds = buildDaxFilterWrapper(filters);
  if (!preds) return dax;
  const m = /^\s*EVALUATE\b([\s\S]*)$/i.exec(dax || '');
  if (!m) return dax;
  const body = m[1].trim();
  if (!body) return dax;
  return `EVALUATE CALCULATETABLE(${body}, ${preds})`;
}
