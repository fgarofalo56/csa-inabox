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
import type { SynapseQueryParam, SynapseTarget } from './synapse-sql-client';

// ── SQL source (resolver-supplied; the FROM relation + identifier whitelist) ───

/**
 * Target SQL dialect for identifier quoting and row capping. The compiler's
 * DEFAULT — `undefined`, treated as `'tsql'`/`'synapse'` — emits exactly the
 * T-SQL it always has (byte-for-byte), so the existing Synapse `/query` callers
 * (who pass none) are never regressed. The Wave-1 Get-Data executors pass the
 * bound engine's dialect so the SAME wells→SQL pass also targets Azure SQL /
 * Synapse / generic SQL Server (bracket-quoted, `TOP n`), PostgreSQL (`"id"`,
 * `LIMIT n`), and MySQL / Databricks SQL (`` `id` ``, `LIMIT n`). Only identifier
 * quoting + the row-cap form differ across dialects — never the structured
 * wells/filters logic. See `quoteIdent` / `rowCap`.
 */
export type SqlDialect = 'tsql' | 'synapse' | 'generic-sql' | 'postgres' | 'mysql' | 'databricks-sql';

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
  /**
   * Target SQL dialect (default `undefined` === `'tsql'`/`'synapse'`). Undefined
   * and the T-SQL-family values emit byte-identical T-SQL, so the existing
   * Synapse callers — who pass none — are unchanged. Other engines
   * (`generic-sql`/`postgres`/`mysql`/`databricks-sql`) only change identifier
   * quoting and the row-cap form (`TOP n` → `LIMIT n`); see `quoteIdent`/`rowCap`.
   */
  dialect?: SqlDialect;
}

// ── Structured filter input (mirror of the designer's wired filter shape) ──────

/**
 * Filter operators surfaced by the Filters pane (no typed predicates).
 *
 * The scalar/set ops (`eq`…`in`) compile to a parameterized WHERE/HAVING
 * predicate. Two Wave-1 additions mirror the Power BI "Filter type" dropdown
 * 1:1 (no-freeform-config: both are structured picker output, never typed):
 *  - `relativeDate` — a rolling date window (last/next N days|months|years)
 *    relative to the server clock. Compiles to a parameterized `DATEADD` /
 *    `GETDATE()` range WHERE (and a `TODAY()` / `EDATE()` range on the DAX
 *    mirror), so the same Filters pane drives both backends.
 *  - `topN` — Power BI "Top N": keep the N rows with the largest by-measure.
 *    It is NOT a row predicate; it shapes the grouped query (ORDER BY the
 *    by-measure DESC + a `TOP <N>` cap) and is consumed in `buildSqlFromVisual`
 *    (DAX mirror: a `TOPN(...)` wrapper — see `daxPredicate`). It therefore
 *    emits no WHERE/HAVING and is skipped by `scalarPredicate`.
 */
export type ReportFilterOp =
  | 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'in' | 'contains' | 'between'
  | 'relativeDate' | 'topN';

/**
 * Granularity for a `relativeDate` window. The original three (day/month/year)
 * match PBI's calendar units; Wave-8 adds the SUB-DAY units `minutes` / `hours`
 * (Power BI's relative-time filter). Sub-day windows anchor on the live wall
 * clock (`GETDATE()` / `NOW()`) instead of midnight `CAST(… AS date)` so an
 * "last 6 hours" window is exact to the second.
 */
export type RelativeDateUnit = 'days' | 'months' | 'years' | 'minutes' | 'hours';

/** Direction of a `relativeDate` window relative to the server clock (now). */
export type RelativeDateDirection = 'last' | 'next' | 'this';

/**
 * A single structured filter as sent by the designer (`wireFilters` strips the
 * client-only `id`). Field is a model column (`table`+`column`) or a `measure`.
 * Every input is structured picker output — the user never types SQL/DAX
 * (no-freeform-config.md).
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
  /**
   * `relativeDate`: window size (N units). Clamped to a safe integer range.
   * The Filters pane (`wireFilters`) and the /definition route emit `relN`; the
   * verbose `relativeN` is accepted as an alias for any older caller.
   */
  relN?: number;
  relativeN?: number;
  /** `relativeDate`: window granularity (day/month/year). Wire: `relUnit`. Defaults to `days`. */
  relUnit?: RelativeDateUnit;
  relativeUnit?: RelativeDateUnit;
  /** `relativeDate`: window direction. Wire: `relDir`. Defaults to `last`. */
  relDir?: RelativeDateDirection;
  relativeDirection?: RelativeDateDirection;
  /** `topN`: rows to keep. Clamped to ROW_CAP. */
  topN?: number;
  /** `topN`: keep the largest (`top`, default) or smallest (`bottom`) N. Wire: `topNType`. */
  topNType?: 'top' | 'bottom';
  /**
   * `topN` RANK TARGET — the measure/column the Top-N ranks by. The Filters pane
   * authors this SEPARATELY from the filter's own field (which is the CATEGORY
   * column being limited), so it is read from `byMeasure` / `byColumn` (+`byTable`),
   * NOT from `measure`. Mirrors `applyFilters`, which ranks rows by this same field.
   */
  byMeasure?: string;
  byTable?: string;
  byColumn?: string;
  /**
   * Wave-8 "exclude" (PBI): keep rows that do NOT match this predicate. The
   * compiled WHERE/HAVING predicate is wrapped in `NOT (...)`; `topN` (a global
   * slice, not a row predicate) ignores it. Mirrors the client `passesFilter`.
   */
  exclude?: boolean;
}

// ── Compiled output ────────────────────────────────────────────────────────────

/** The runnable artifact: a SQL text + the parameters to bind via executeQuery. */
export interface CompiledSql {
  sql: string;
  parameters: SynapseQueryParam[];
}

// ── Wave-8 interactivity compile options (drill + what-if) ─────────────────────

/**
 * One fixed ancestor level of an in-visual drill path: the category column and
 * the member value the user drilled INTO. Compiled to an `eq` WHERE predicate so
 * the deeper level is real-queried filtered to that member (Power BI drill-down).
 */
export interface DrillPathStep {
  table?: string;
  column?: string;
  value: string;
}

/**
 * In-visual drill state (Power BI: multiple Axis fields = a hierarchy). `level`
 * is the 0-based active hierarchy level shown. `path` carries the fixed ancestor
 * member at each level above `level`. With `expandAll` the grouping spans
 * category[0..level] (expand-all-down); otherwise only the single active level
 * category[level] (drill-down). Either way every step in `path` becomes an `eq`
 * WHERE — so a drilled visual re-queries REAL Synapse rows for the sub-level.
 */
export interface DrillState {
  level: number;
  path?: DrillPathStep[];
  expandAll?: boolean;
}

/**
 * A bound what-if / numeric-range parameter value flowed INTO the SELECT. The
 * value binds as a TDS parameter and is applied to value-well aggregate(s):
 * `multiply` (× value) or `add` (+ value). `targetAlias` scopes it to one
 * aggregate (by its result-alias); omitted ⇒ every value aggregate. This is the
 * Azure-native analogue of a Power BI what-if parameter feeding a measure — no
 * Fabric, no AAS; the picked value genuinely changes the returned rows.
 */
export interface ScalarParamBinding {
  value: number;
  apply?: 'multiply' | 'add';
  targetAlias?: string;
}

/** Optional Wave-8 compile inputs (drill + what-if). Undefined ⇒ byte-identical. */
export interface VisualCompileOptions {
  drill?: DrillState;
  whatIf?: ScalarParamBinding[];
  /** WAVE-9 export-data: project row-level columns of every well (no GROUP BY). */
  underlying?: boolean;
  /** WAVE-9 export-data: override the default row cap (csv 30k / xlsx 150k). */
  rowCapOverride?: number;
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

/** `relativeDate` granularity → T-SQL `DATEADD` datepart keyword. Whitelisted
 *  (never client text), so it is safe to inline into the `DATEADD` call while
 *  the numeric offset still binds as a parameter. */
const SQL_DATE_PART: Record<RelativeDateUnit, string> = {
  days: 'DAY',
  months: 'MONTH',
  years: 'YEAR',
  minutes: 'MINUTE',
  hours: 'HOUR',
};

/** Sub-day relative units anchor on the live clock (GETDATE()) rather than midnight. */
const SUB_DAY_UNITS: ReadonlySet<RelativeDateUnit> = new Set(['minutes', 'hours']);

/**
 * Clamp a client-supplied count to a positive integer in `[1, max]`. Returns
 * null when it is not a finite number ≥ 1. The result is a validated integer,
 * so it is injection-safe to inline (the same contract under which `ROW_CAP` is
 * inlined into `TOP`); relative-date offsets still bind as `@p<n>` parameters.
 */
function clampCount(n: number | undefined, max: number): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < 1) return null;
  return Math.min(i, max);
}

// ── relative-date field accessors (field-name alignment with the Filters pane) ─
//
// The designer's `wireFilters` and the /definition route emit `relN` / `relUnit`
// / `relDir`. Earlier versions of this module read `relativeN` / `relativeUnit` /
// `relativeDirection`, so the documented date-range WHERE/DAX never compiled
// (the value was always undefined). These read the wire field first and fall
// back to the verbose alias, so BOTH backends (SQL `scalarPredicate` and the DAX
// `daxRelativeDate`) honor the same Filters-pane window.

/** Relative-date window size (N units). Wire `relN`, alias `relativeN`. */
function relDateN(f: ReportFilterInput): number | undefined {
  return f.relN ?? f.relativeN;
}
/** Relative-date unit. Wire `relUnit`, alias `relativeUnit`; defaults to `days`. */
function relDateUnit(f: ReportFilterInput): RelativeDateUnit {
  return f.relUnit ?? f.relativeUnit ?? 'days';
}
/** Relative-date direction. Wire `relDir`, alias `relativeDirection`; default `last`. */
function relDateDir(f: ReportFilterInput): RelativeDateDirection {
  return f.relDir ?? f.relativeDirection ?? 'last';
}

// ── Identifier helpers (injection-safe) ────────────────────────────────────────

/** Bracket-quote a SQL identifier (double any `]`). Mirrors sql-to-pushdataset. */
export function bracket(ident: string): string {
  return `[${ident.replace(/]/g, ']]')}]`;
}

/**
 * Dialect-aware identifier quote. The bracket dialects (T-SQL / Synapse / generic
 * SQL Server) reuse `bracket` verbatim, so output is byte-identical to the
 * pre-dialect compiler; PostgreSQL double-quotes (`"` → `""`); MySQL and
 * Databricks SQL back-tick (`` ` `` → ``` `` ```). Identifiers are still ONLY
 * ever resolver-whitelisted names — never client text — so dialect choice never
 * widens the injection surface.
 */
export function quoteIdent(name: string, dialect?: SqlDialect): string {
  switch (dialect) {
    case 'postgres':
      return `"${name.replace(/"/g, '""')}"`;
    case 'mysql':
    case 'databricks-sql':
      return '`' + name.replace(/`/g, '``') + '`';
    default:
      // tsql | synapse | generic-sql | undefined → bracket-quote (identical to bracket()).
      return bracket(name);
  }
}

/** A row cap rendered as a SELECT-list prefix and/or a trailing clause. */
export interface RowCap {
  /** Goes right after `SELECT [DISTINCT] ` — `'TOP n '` for the T-SQL family, else `''`. */
  prefix: string;
  /** Goes after ORDER BY — `'LIMIT n'` for PostgreSQL/MySQL/Databricks, else `''`. */
  suffix: string;
}

/**
 * Dialect-aware row cap. The T-SQL family (tsql/synapse/generic-sql — the
 * default) caps with a leading `TOP n` and no suffix, byte-identical to the
 * pre-dialect compiler. PostgreSQL / MySQL / Databricks SQL have no `TOP`, so
 * they cap with a trailing `LIMIT n` instead. `n` is always a validated integer
 * (ROW_CAP or a clamped Top-N), so it is injection-safe to inline.
 */
export function rowCap(dialect: SqlDialect | undefined, n: number): RowCap {
  switch (dialect) {
    case 'postgres':
    case 'mysql':
    case 'databricks-sql':
      return { prefix: '', suffix: `LIMIT ${n}` };
    default:
      return { prefix: `TOP ${n} `, suffix: '' };
  }
}

/** A `[src].[Column]` reference for a whitelisted column (dialect-quoted). */
function colRef(name: string, dialect?: SqlDialect): string {
  return `${quoteIdent('src', dialect)}.${quoteIdent(name, dialect)}`;
}

/** Render the FROM relation, aliased `[src]`. */
function renderFrom(src: SqlSource): string {
  const d = src.dialect;
  const alias = quoteIdent('src', d);
  if (src.from.kind === 'table') {
    const schema = src.from.schema ? `${quoteIdent(src.from.schema, d)}.` : '';
    return `${schema}${quoteIdent(src.from.table, d)} AS ${alias}`;
  }
  // Derived: resolver-supplied, sql-guard-validated read-only SELECT.
  return `(${src.from.sql.trim().replace(/;+\s*$/, '')}) AS ${alias}`;
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

interface Projection { expr: string; alias: string; column?: string; measure?: string }

/**
 * Build the aggregate expression + result alias for a value-well field. Measures
 * use their whitelisted SQL expression; columns are wrapped in their aggregation
 * (defaulting to SUM, matching the DAX path). Alias mirrors aas-dax's labels
 * (`<Agg> of <Column>` / `Sum of <Column>` / `<Measure>`) so SQL and DAX results
 * carry the same column names and the client renders/filters them identically.
 * `column`/`measure` carry the SOURCE field identity so a Top-N rank target can
 * be matched back to the aggregate it ranks by (see `topNOrderExpr`).
 */
function aggProjection(src: SqlSource, w: DaxWellField): Projection | null {
  const mExpr = resolveMeasure(src, w.measure);
  if (mExpr && w.measure) return { expr: mExpr, alias: w.measure, measure: w.measure };

  const name = resolveColumn(src, w.table, w.column);
  if (name && w.column) {
    const useAgg = w.aggregation && w.aggregation !== 'None';
    const fn = useAgg ? SQL_AGG_FN[w.aggregation as string] || 'SUM' : 'SUM';
    const alias = useAgg ? `${w.aggregation} of ${w.column}` : `Sum of ${w.column}`;
    return { expr: `${fn}(${colRef(name, src.dialect)})`, alias, column: name };
  }
  return null;
}

/** Resolve a group/category well field to a `{ ref, alias }` (raw column). */
function groupColumn(src: SqlSource, w: DaxWellField): { ref: string; alias: string } | null {
  const name = resolveColumn(src, w.table, w.column);
  if (!name) return null;
  return { ref: colRef(name, src.dialect), alias: name };
}

/**
 * Wave-8 what-if: wrap a value-well aggregate so a bound numeric parameter flows
 * INTO the SELECT (× for `multiply`, + for `add`), binding the value as a TDS
 * parameter (never inlined). A binding with a `targetAlias` only applies to the
 * aggregate whose result-alias matches; an aliasless binding applies to every
 * aggregate. No bindings ⇒ the original expression verbatim (byte-identical), so
 * the common path is unchanged. NaN / non-finite values are ignored.
 */
function whatIfExpr(a: Projection, whatIf: ScalarParamBinding[] | undefined, pb: ReturnType<typeof paramBag>): string {
  let expr = a.expr;
  for (const b of whatIf || []) {
    if (!b || !Number.isFinite(b.value)) continue;
    if (b.targetAlias && b.targetAlias.trim().toLowerCase() !== a.alias.trim().toLowerCase()) continue;
    const p = pb.add(String(b.value));
    expr = b.apply === 'add' ? `(${expr} + ${p})` : `(${expr} * ${p})`;
  }
  return expr;
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
  // Wrap a compiled predicate in NOT(...) when the filter is an "exclude" (Wave-8).
  const neg = (pred: string | null, f: ReportFilterInput): string | null =>
    pred && f.exclude ? `NOT (${pred})` : pred;
  for (const f of filters || []) {
    // Measure filter → HAVING (aggregated queries only).
    if (f.measure) {
      if (!allowHaving) continue;
      const expr = resolveMeasure(src, f.measure);
      if (!expr) continue;
      const pred = neg(scalarPredicate(expr, f, pb), f);
      if (pred) having.push(pred);
      continue;
    }
    // Column filter → WHERE.
    const name = resolveColumn(src, f.table, f.column);
    if (!name) continue;
    const pred = neg(scalarPredicate(colRef(name, src.dialect), f, pb), f);
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
    case 'relativeDate': {
      // Power BI "relative date" / "relative time": a rolling window vs the
      // server clock. The (signed) offset binds as a parameter; the DATEADD
      // datepart is a whitelisted keyword, so this stays injection-safe.
      //   last N  → ref >= DATEADD(unit, -N, anchor) AND ref < anchorEnd
      //   next N  → ref >= anchorStart        AND ref < DATEADD(unit,  N, anchorEnd)
      //   this    → treated as `last` (window ending now, inclusive).
      // Calendar units (day/month/year) anchor on midnight today and the upper
      // bound rolls to the start of tomorrow (whole-day inclusive — unchanged
      // byte-for-byte). Sub-day units (minutes/hours) anchor on the LIVE clock
      // GETDATE() so "last 6 hours" is exact to the second (Wave-8).
      const unit = relDateUnit(f);
      const n = clampCount(relDateN(f), 10_000_000);
      if (n == null) return null;
      const part = SQL_DATE_PART[unit];
      if (!part) return null;
      if (SUB_DAY_UNITS.has(unit)) {
        const now = 'GETDATE()';
        if (relDateDir(f) === 'next') {
          const pos = pb.add(String(n));
          return `${ref} >= ${now} AND ${ref} < DATEADD(${part}, ${pos}, ${now})`;
        }
        const neg = pb.add(String(-n));
        return `${ref} >= DATEADD(${part}, ${neg}, ${now}) AND ${ref} <= ${now}`;
      }
      const today = 'CAST(GETDATE() AS date)';
      if (relDateDir(f) === 'next') {
        const pos = pb.add(String(n));
        return `${ref} >= ${today} AND ${ref} < DATEADD(${part}, ${pos}, DATEADD(DAY, 1, ${today}))`;
      }
      const neg = pb.add(String(-n)); // signed offset bound directly (no unary-minus on a param)
      return `${ref} >= DATEADD(${part}, ${neg}, ${today}) AND ${ref} < DATEADD(DAY, 1, ${today})`;
    }
    case 'topN':
      // Top-N is a query-shape directive (ORDER BY + TOP), consumed in
      // buildSqlFromVisual via extractTopN — it emits no row predicate here.
      return null;
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
  limit?: string | null,
): string {
  let sql = `${select}\nFROM ${from}`;
  if (where.length) sql += `\nWHERE ${where.join(' AND ')}`;
  if (groupBy.length) sql += `\nGROUP BY ${groupBy.join(', ')}`;
  if (having.length) sql += `\nHAVING ${having.join(' AND ')}`;
  if (orderBy) sql += `\nORDER BY ${orderBy}`;
  // Trailing row cap for LIMIT dialects (postgres/mysql/databricks). The T-SQL
  // family caps with a leading `TOP n` instead and passes no limit, so this is a
  // no-op for them → emitted SQL is byte-identical to the pre-dialect compiler.
  if (limit) sql += `\n${limit}`;
  return sql;
}

// ── Top-N (query-shape directive, not a predicate) ─────────────────────────────

/**
 * Pull the active Power BI "Top N" directive (the first `op:'topN'` filter) out
 * of the Filters pane. `topN` (or, as a fallback, a numeric `value`) is the row
 * count. The RANK TARGET is authored SEPARATELY from the filter's own field —
 * the pane sets the field to the CATEGORY column being limited and the rank
 * target in `byMeasure` / `byColumn` (+`byTable`), exactly the fields the wire
 * payload and the /definition route carry — so we read those (with the legacy
 * `measure` accepted as a fallback). `dir` is the top/bottom choice (`topNType`).
 * Returns null when there is no Top-N filter or N is not a positive integer.
 * Top-N is NOT a row predicate — `compileFilters`/`scalarPredicate` skip it — it
 * shapes the grouped query in `buildSqlFromVisual` (ORDER BY rank-target +
 * `TOP <N>`, DESC for top / ASC for bottom).
 */
function extractTopN(
  filters: ReportFilterInput[] | undefined,
): { n: number; byMeasure?: string; byColumn?: string; byTable?: string; dir: 'top' | 'bottom' } | null {
  for (const f of filters || []) {
    if (f.op !== 'topN') continue;
    const raw = f.topN != null ? f.topN : Number(f.value);
    const n = clampCount(raw, ROW_CAP);
    if (n == null) continue;
    return {
      n,
      byMeasure: f.byMeasure ?? f.measure,
      byColumn: f.byColumn,
      byTable: f.byTable,
      dir: f.topNType === 'bottom' ? 'bottom' : 'top',
    };
  }
  return null;
}

/**
 * ORDER BY expression for a grouped/aggregated query: the Top-N rank target when
 * it resolves to (1) a real SQL measure expression, (2) a value-well aggregate
 * backed by the same measure/alias, or (3) a value-well aggregate over the same
 * source column — i.e. the displayed aggregate the user chose to rank by (which
 * is exactly what `applyFilters` ranks the result rows by, so the two paths now
 * agree). Falls back to the first value-well aggregate alias when the rank target
 * doesn't resolve, so a Top-N with an unresolved by-field — and every non-Top-N
 * query — keeps the pre-existing default ordering. Caller guarantees `aggs` is
 * non-empty.
 */
function topNOrderExpr(
  src: SqlSource,
  topN: { byMeasure?: string; byColumn?: string; byTable?: string } | null,
  aggs: Projection[],
): string {
  if (topN?.byMeasure) {
    const mExpr = resolveMeasure(src, topN.byMeasure);
    if (mExpr) return mExpr;
    const want = topN.byMeasure.trim().toLowerCase();
    const a = aggs.find(
      (x) => (x.measure || '').toLowerCase() === want || x.alias.toLowerCase() === want,
    );
    if (a) return quoteIdent(a.alias, src.dialect);
  }
  if (topN?.byColumn) {
    const name = resolveColumn(src, topN.byTable, topN.byColumn);
    if (name) {
      const lc = name.toLowerCase();
      const a = aggs.find((x) => (x.column || '').toLowerCase() === lc);
      if (a) return quoteIdent(a.alias, src.dialect);
    }
  }
  return quoteIdent(aggs[0].alias, src.dialect);
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
  opts?: VisualCompileOptions,
): CompiledSql | null {
  const d = sqlSource.dialect;
  const from = renderFrom(sqlSource);
  const wells = visual.wells || {};
  const category = wells.category || [];
  const values = wells.values || [];
  const legend = wells.legend || [];
  const type = (visual.type || '').toLowerCase();

  // ── WAVE-9 export-data → underlying-rows projection (every well column, no
  // aggregation / no GROUP BY). When `opts.underlying` is set, the export-data
  // route wants the ROW-LEVEL detail behind ANY visual type (chart/matrix/card
  // included), so we project ALL well columns ([...category, ...values,
  // ...legend]) raw — reusing the exact `type === 'table'` raw-projection logic
  // — under a caller-supplied row cap (`rowCapOverride`: csv 30k / xlsx 150k).
  // Column filters still compile to a parameterized WHERE; identifiers stay
  // resolver-whitelisted and values bind as @p<n> (no injection, real Synapse
  // rows). This branch runs ONLY for an explicit underlying export — every
  // existing caller passes no `underlying`, so the summarized/aggregate paths
  // below are reached unchanged and compile byte-identical SQL (no regression).
  if (opts?.underlying) {
    const cols = [...category, ...values, ...legend]
      .map((w) => resolveColumn(sqlSource, w.table, w.column))
      .filter((n): n is string => !!n);
    const uniq = Array.from(new Set(cols));
    if (!uniq.length) return null;
    const pb = paramBag();
    const { where } = compileFilters(sqlSource, filters, pb, false);
    const cap = rowCap(d, opts.rowCapOverride ?? ROW_CAP);
    const select = `SELECT ${cap.prefix}${uniq.map((n) => `${colRef(n, d)} AS ${quoteIdent(n, d)}`).join(', ')}`;
    return {
      sql: assemble(select, from, where, [], [], quoteIdent(uniq[0], d), cap.suffix || null),
      parameters: pb.parameters,
    };
  }

  // ── table → raw projection (no aggregation, no grouping) ────────────────────
  if (type === 'table') {
    const cols = [...category, ...values]
      .map((w) => resolveColumn(sqlSource, w.table, w.column))
      .filter((n): n is string => !!n);
    const uniq = Array.from(new Set(cols));
    if (!uniq.length) return null;
    const pb = paramBag();
    const { where } = compileFilters(sqlSource, filters, pb, false);
    const cap = rowCap(d, ROW_CAP);
    const select = `SELECT ${cap.prefix}${uniq.map((n) => `${colRef(n, d)} AS ${quoteIdent(n, d)}`).join(', ')}`;
    return {
      sql: assemble(select, from, where, [], [], quoteIdent(uniq[0], d), cap.suffix || null),
      parameters: pb.parameters,
    };
  }

  // ── slicer → distinct category values ───────────────────────────────────────
  if (type === 'slicer') {
    const g = category.map((w) => groupColumn(sqlSource, w)).filter((x): x is { ref: string; alias: string } => !!x);
    if (!g.length) return null;
    const pb = paramBag();
    const { where } = compileFilters(sqlSource, filters, pb, false);
    const cap = rowCap(d, ROW_CAP);
    const select = `SELECT DISTINCT ${cap.prefix}${g.map((c) => `${c.ref} AS ${quoteIdent(c.alias, d)}`).join(', ')}`;
    return {
      sql: assemble(select, from, where, [], [], quoteIdent(g[0].alias, d), cap.suffix || null),
      parameters: pb.parameters,
    };
  }

  // ── card / chart / matrix → aggregate (optionally grouped) ──────────────────
  // Wave-5 trellis (Small multiples / Details): the report designer folds the
  // chart "Small multiples" well into `wells.smallMultiples` and the treemap
  // "Details" well into `wells.details`. NEITHER lives on the owned
  // `DaxVisual.wells` type, so we read them through a NARROW local cast (no
  // aas-dax.ts edit, no new tsc error — all properties optional, so the assertion
  // is comparable to the source shape) and append the resolved facet group
  // columns AFTER [...category, ...legend] into the SAME `groups` array. The
  // existing alias-dedupe + GROUP BY + SELECT logic then emits them as ordinary
  // trailing `<facet> AS [facet]` group columns — a 2nd GROUP BY dimension on
  // purpose (one row per axis×facet, exactly what LoomChart's SmallMultiplesGrid
  // and the treemap detail partition consume). Result column order is therefore
  // category…, legend…, smallMultiples…, details…, <aggregates…>, so parseRows
  // still picks category[0] as the axis and the renderer pulls each facet by its
  // known alias. When no Small-multiples / Details well is bound, `trellis` is
  // empty and `[...category, ...legend, ...trellis]` === `[...category,
  // ...legend]`, so the no-trellis path (and the card branch's `[]`, and the
  // table/slicer branches above) compile byte-identical SQL. The DAX mirror
  // (buildDaxFromWells) is unaffected — it folds category+legend and can ride the
  // same trellis fold in a later pass; the SQL default path is what Wave-5 renders.
  const trellisWells = visual.wells as
    | { smallMultiples?: DaxWellField[]; details?: DaxWellField[] }
    | undefined;
  const trellis = [...(trellisWells?.smallMultiples ?? []), ...(trellisWells?.details ?? [])];
  // ── Wave-8 in-visual DRILL (Power BI: ordered category[] = a hierarchy). The
  // active `level` either expands one level DEEPER across all members
  // (expand-all-down ⇒ category[0..level+1]) or drills into just category[level]
  // (drill-down); each fixed ancestor member in `path` becomes an `eq` WHERE so
  // the sub-level re-queries REAL rows. Matching PBI's expand-all-down, the
  // expandAll branch adds the NEXT level (lvl+1) without filtering — so at the
  // default level=0 it groups by [cat0, cat1] rather than the no-op [cat0]
  // (clamped by `Math.min(lvl + 2, category.length)` so it never overruns the
  // hierarchy). No drill ⇒ effCategory === category and drillFilters === [], so
  // the grouped query is byte-identical to before (no regression).
  const drill = opts?.drill;
  let effCategory = category;
  const drillFilters: ReportFilterInput[] = [];
  if (drill && Number.isFinite(drill.level) && category.length > 1) {
    const lvl = Math.max(0, Math.min(Math.floor(drill.level), category.length - 1));
    effCategory = drill.expandAll
      ? category.slice(0, Math.min(lvl + 2, category.length))
      : category.slice(lvl, lvl + 1);
    for (const step of drill.path || []) {
      if (step && step.column != null && step.value != null) {
        drillFilters.push({ table: step.table, column: step.column, op: 'eq', value: String(step.value) });
      }
    }
  }
  const effFilters = drillFilters.length ? [...(filters || []), ...drillFilters] : filters;
  const groups = (type === 'card' ? [] : [...effCategory, ...legend, ...trellis])
    .map((w) => groupColumn(sqlSource, w))
    .filter((x): x is { ref: string; alias: string } => !!x);
  // Dedupe group columns by alias (category+legend may overlap).
  const seen = new Set<string>();
  const group = groups.filter((g) => (seen.has(g.alias) ? false : (seen.add(g.alias), true)));

  // Wave-1 multi-value contract: the new visual types fold every extra
  // measure-like input into `wells.values`, so they need NO new compile logic
  // here — each becomes one more aggregate projection automatically:
  //   • combo charts      → secondary-value (line) series are extra `values`
  //   • gauge / KPI       → Target / Min / Max are extra `values`
  //   • treemap / scatter → Details / size measures are extra `values`
  //   • tooltips          → tooltip measures are extra `values`
  // Small multiples / Details fold into the Wave-5 trellis group column(s) read
  // below (`wells.smallMultiples` / `wells.details`, appended after category +
  // legend), not into `values`. Each visual therefore returns REAL aggregated SQL
  // rows; LoomChart reads the extra
  // columns to draw the new chart shape. (DAX path keeps the SAME contract via
  // aas-dax.buildDaxFromWells, which maps every `values` field through
  // daxValueExpr.) So this single `values → aggProjection` pass already powers
  // the expanded Wave-1 gallery with zero per-visual branching.
  const aggs = values
    .map((w) => aggProjection(sqlSource, w))
    .filter((x): x is Projection => !!x);

  if (group.length === 0 && aggs.length === 0) return null;

  const pb = paramBag();

  // No values → distinct grouping (acts like a slicer/category table).
  if (aggs.length === 0) {
    const { where } = compileFilters(sqlSource, effFilters, pb, false);
    const cap = rowCap(d, ROW_CAP);
    const select = `SELECT DISTINCT ${cap.prefix}${group.map((c) => `${c.ref} AS ${quoteIdent(c.alias, d)}`).join(', ')}`;
    return {
      sql: assemble(select, from, where, [], [], quoteIdent(group[0].alias, d), cap.suffix || null),
      parameters: pb.parameters,
    };
  }

  // Aggregated query (card = no group; chart/matrix = grouped).
  const { where, having } = compileFilters(sqlSource, effFilters, pb, true);
  const selectCols = [
    ...group.map((c) => `${c.ref} AS ${quoteIdent(c.alias, d)}`),
    // Wave-8 what-if: a bound numeric value flows INTO the aggregate (× / +),
    // binding as a TDS parameter — so the picked value genuinely changes the
    // returned rows. No what-if ⇒ `whatIfExpr` returns the original expression
    // (byte-identical). `targetAlias` scopes a binding to one aggregate.
    ...aggs.map((a) => `${whatIfExpr(a, opts?.whatIf, pb)} AS ${quoteIdent(a.alias, d)}`),
  ];
  // Power BI "Top N" filter (op:'topN'): cap the grouped result at N rows and
  // rank by the chosen by-measure DESC. N is a validated integer (clamped to
  // ROW_CAP), so it is injection-safe to inline — exactly like ROW_CAP. With no
  // Top-N filter this falls back to ROW_CAP + first-aggregate ordering, leaving
  // the previously-shipped query shape byte-for-byte unchanged (for the default /
  // T-SQL dialect the cap is `TOP n`; LIMIT dialects move it to a trailing clause).
  const topN = group.length ? extractTopN(filters) : null;
  const capN = topN ? topN.n : ROW_CAP;
  const cap = group.length ? rowCap(d, capN) : { prefix: '', suffix: '' };
  const select = `SELECT ${cap.prefix}${selectCols.join(', ')}`;
  const groupBy = group.map((c) => c.ref);
  // Order grouped results so the TOP cap keeps the most significant rows: rank by
  // the authored Top-N rank target (by-measure / by-column), DESC for "top" and
  // ASC for "bottom" — the same ordering `applyFilters` uses client-side. A card
  // (no group) needs no ordering.
  const dir = topN?.dir === 'bottom' ? 'ASC' : 'DESC';
  const orderBy = group.length ? `${topNOrderExpr(sqlSource, topN, aggs)} ${dir}` : null;
  return {
    sql: assemble(select, from, where, groupBy, having, orderBy, cap.suffix || null),
    parameters: pb.parameters,
  };
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

/**
 * DAX mirror of the SQL `relativeDate` window, expressed with `TODAY()` /
 * `EDATE()` so no typed DAX is required (no-freeform-config). N is a validated
 * integer inlined as a numeric literal; the window matches the SQL side:
 *   days   → TODAY() ± N
 *   months → EDATE(TODAY(), ±N)
 *   years  → EDATE(TODAY(), ±12N)
 * `last`/`this` window backward from today (inclusive); `next` forward.
 */
function daxRelativeDate(ref: string, f: ReportFilterInput): string | null {
  const n = clampCount(relDateN(f), 10_000_000);
  if (n == null) return null;
  const unit = relDateUnit(f);
  // Sub-day windows (Wave-8): DAX datetimes are day-fractional, so minutes/hours
  // map to NOW() ± n/1440 (minutes) / n/24 (hours) — anchored on the live clock.
  if (SUB_DAY_UNITS.has(unit)) {
    const frac = unit === 'minutes' ? `${n} / 1440` : `${n} / 24`;
    if (relDateDir(f) === 'next') return `${ref} >= NOW() && ${ref} <= NOW() + ${frac}`;
    return `${ref} >= NOW() - ${frac} && ${ref} <= NOW()`;
  }
  const moved = (sign: 1 | -1): string => {
    if (unit === 'days') return `TODAY() ${sign < 0 ? '-' : '+'} ${n}`;
    const months = unit === 'years' ? 12 * n : n;
    return `EDATE(TODAY(), ${sign < 0 ? -months : months})`;
  };
  if (relDateDir(f) === 'next') {
    return `${ref} >= TODAY() && ${ref} <= ${moved(1)}`;
  }
  return `${ref} >= ${moved(-1)} && ${ref} <= TODAY()`;
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
    case 'relativeDate':
      return daxRelativeDate(ref, f);
    case 'topN':
      // Top-N is a table-expression shape (a `TOPN(<N>, <table>, <measure>, DESC)`
      // wrapper around the EVALUATE), not a CALCULATETABLE boolean predicate — so
      // it is applied where the DAX visual is assembled (the SQL mirror applies
      // it in buildSqlFromVisual). Emit no filter predicate here.
      return null;
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

// ════════════════════════════════════════════════════════════════════════════
// WAVE 2 — per-table storage modes + source-group cache-vs-live selection
// ════════════════════════════════════════════════════════════════════════════
//
// Power BI storage modes (DirectQuery / Import / Dual / Direct Lake) mapped 1:1
// to Azure-native execution (no-fabric-dependency.md): a model table is read
// either LIVE (DirectQuery — today's Synapse/connector SQL, byte-identical) or
// from a materialized Delta CACHE (Import / Dual-cache — a `materialized-lake-
// view-engine` managed Delta queried serverlessly via `OPENROWSET(FORMAT=
// 'DELTA')`), with Dual picking per-query and Direct Lake reading the table's
// OWN Delta. NONE of this requires Power BI / a Fabric workspace.
//
// This module owns the PURE selection helpers the route layer calls — the
// cache-vs-live decision and the source-group grouping. `buildSqlFromVisual`
// above is UNCHANGED: it still compiles exactly one already-resolved
// `SqlSource.from`, so every existing caller stays byte-identical. The new
// helpers only DECIDE which relation (live vs cache) and which Synapse target a
// `'source-groups'` visual compiles against; the route then hands the chosen
// `from`/`target` to `buildSqlFromVisual` unchanged. The module stays pure +
// credential-free (type-only `SynapseTarget` import; local `SqlSourceFrom`).

/**
 * Local string-validated MIRROR of the `StorageMode` union whose source of
 * truth is `lib/editors/report/storage-mode-pane.tsx` (the W2 shared contract).
 * Declared here — not imported — because that pane is a `'use client'` module
 * and a server module can't import it (exactly as W1 mirrors `ReportConnType`
 * across `report-data-source.ts` ↔ `report-model-resolver.ts`). The pane, the
 * resolver, and this module carry the same four literals; by contract they are
 * ONE shared union.
 *
 *  - `DirectQuery` — live Synapse / connector SQL (today's default; byte-identical).
 *  - `Import`      — materialized Delta cache (Spark batch via the MLV engine,
 *                    read by serverless `OPENROWSET(FORMAT='DELTA')`).
 *  - `Dual`        — both; per-query pick (cache for aggregations when ready,
 *                    live otherwise — always with a live fallback).
 *  - `DirectLake`  — serverless `OPENROWSET` over the table's own Delta (no
 *                    materialization).
 */
export type StorageMode = 'DirectQuery' | 'Import' | 'Dual' | 'DirectLake';

/**
 * One model table's per-table source-group binding: which storage mode it uses
 * and the concrete LIVE / CACHE relations the compiler can run it on. Emitted by
 * `report-model-resolver.ts` (the cache relation's `from`/`deltaUrl` come from
 * the SAME `reportTableMlvSpec` the refresh route materializes, so the Delta the
 * resolver reads == the Delta the Spark batch writes) and consumed by the route
 * `toSqlSource` `'source-groups'` branch via `pickRelation` below.
 */
export interface TableSourceBinding {
  /** Source-group id; `'primary'` for single-source / back-compat reports. */
  group: string;
  /** This table's storage mode (mirror of the owned union, string-validated). */
  storageMode: StorageMode;
  /**
   * LIVE relation (DirectQuery / Dual-live) + the Synapse pool it runs on.
   * `kind` selects dedicated-warehouse vs serverless-lakehouse execution.
   */
  live?: { from: SqlSourceFrom; target: SynapseTarget; kind: 'warehouse' | 'lakehouse' };
  /**
   * CACHE relation (Import / Dual-cache / Direct Lake): a serverless
   * `OPENROWSET(FORMAT='DELTA')` over the materialized (or own) Delta, run on
   * the serverless pool. `deltaUrl` is the ADLS path the MLV engine wrote.
   */
  cache?: { from: SqlSourceFrom; target: SynapseTarget; deltaUrl: string };
  /**
   * True once an Import/Dual cache exists (the report's `state.lastRefresh[table]`
   * is present, i.e. Refresh-now has materialized the Delta — or, for Direct
   * Lake, the table's own Delta is present). When false, a cache-preferring mode
   * falls back to the live relation with a "Run Refresh to materialize" badge —
   * never a blank / mock (no-vaporware.md).
   */
  cacheReady: boolean;
  /** Optional row estimate; drives smaller-side detection for cross-group joins. */
  rowEstimate?: number;
}

/**
 * Generalized SQL-source arm: each model table → its per-table source-group
 * binding. Emitted by the resolver ONLY when `state.tableStorage` has entries or
 * more than one source group exists; otherwise the resolver keeps emitting the
 * existing `TableMapSqlSource` (zero behavioural change — single-source reports
 * compile byte-identical SQL on the same Synapse target). `target`/`kind` are the
 * PRIMARY group's (the back-compat default relation). Mirrors the resolver's
 * `SourceGroupSqlSource` (which `extends` its unexported `SqlSourceCommon`); the
 * two fields are inlined here so this server module stays import-free of the
 * resolver and the route can pass either structurally-identical shape.
 */
export interface SourceGroupSqlSource {
  mode: 'source-groups';
  /** Synapse pool of the PRIMARY group (the live default relation). */
  target: SynapseTarget;
  /** PRIMARY group execution kind: dedicated warehouse vs serverless lakehouse. */
  kind: 'warehouse' | 'lakehouse';
  /** model-table name → its per-table source-group binding. */
  bindings: Record<string, TableSourceBinding>;
}

/**
 * True when a visual AGGREGATES its rows (card / chart / matrix) rather than
 * listing them (table / slicer). Mirrors `buildSqlFromVisual`'s branch split:
 * `table` projects raw rows and `slicer` lists DISTINCT category values (both
 * detail surfaces that want the LIVE relation), while everything else folds its
 * `values` wells into SQL aggregates (and so benefits from a pre-materialized
 * cache). An empty / unknown type defaults to aggregate, matching the compiler's
 * chart/matrix fall-through. Drives the `Dual` cache-vs-live pick below.
 */
export function isAggregateVisual(visual: DaxVisual): boolean {
  const type = (visual?.type || '').toLowerCase();
  return type !== 'table' && type !== 'slicer';
}

/**
 * The per-table relation pick — which of a binding's two relations a visual
 * compiles against:
 *
 *   - `Import` / `DirectLake` → `'cache'` when the cache is ready, else `'live'`
 *     (the honest "Run Refresh to materialize" fallback — never a blank/mock).
 *   - `Dual`                  → `'cache'` only when the cache is ready AND the
 *     visual aggregates (cache pays off for aggregations); otherwise `'live'`,
 *     so Dual ALWAYS has a live fallback.
 *   - `DirectQuery`           → always `'live'`.
 *
 * `cacheReady` is the single gate (the resolver guarantees `cacheReady ⟹ cache`
 * is populated), so the caller's `pick === 'cache' ? b.cache!.from : b.live!.from`
 * is safe. Pure: no I/O, no SQL synthesis — just the decision.
 */
export function pickRelation(b: TableSourceBinding, isAggregate: boolean): 'live' | 'cache' {
  switch (b.storageMode) {
    case 'Import':
    case 'DirectLake':
      return b.cacheReady ? 'cache' : 'live';
    case 'Dual':
      return b.cacheReady && isAggregate ? 'cache' : 'live';
    case 'DirectQuery':
    default:
      return 'live';
  }
}

/**
 * Group a visual's referenced model tables by their binding's source group, to
 * decide between a SINGLE-group compile (every referenced table runs on one
 * group's chosen relations) and a CROSS-group "limited relationship via the
 * materialized smaller side" (Power BI's source-group / island join rule):
 *
 *   - `{ single: <group> }` — all references resolve to one source group (the
 *     common case; single-source reports → `'primary'`). The route picks each
 *     table's relation via `pickRelation` and runs them on one target.
 *   - `{ groups, smaller }` — references span ≥2 groups. A limited relationship
 *     requires one side to be materialized; `smaller` is the referenced model
 *     table cheapest to materialize (lowest `rowEstimate`; tables with a known
 *     estimate are preferred over unknown ones, tie-broken by reference order).
 *     The route then REQUIRES that table's group cache to be ready, else returns
 *     the honest 'limited-gate' naming it (no silent partial result).
 *
 * Pure: only inspects `s.bindings`; unresolvable refs are ignored (defense in
 * depth — they can't widen the group set).
 */
export function groupVisualBindings(
  s: SourceGroupSqlSource,
  refs: string[],
): { single: string } | { groups: string[]; smaller: string } {
  const resolved: { table: string; binding: TableSourceBinding }[] = [];
  for (const ref of refs || []) {
    const b = s.bindings[ref];
    if (b) resolved.push({ table: ref, binding: b });
  }
  const groups = Array.from(new Set(resolved.map((r) => r.binding.group)));

  // Single group (or no resolvable refs) → one-group compile. Default to
  // 'primary' so an empty/legacy report maps to the back-compat single group.
  if (groups.length <= 1) {
    return { single: groups[0] ?? 'primary' };
  }

  // Cross-group → materialize the smaller side. Pick the referenced table with
  // the lowest row estimate (unknown estimates treated as +∞ so a known-small
  // table is preferred); deterministic tie-break by reference order. `resolved`
  // is guaranteed non-empty here (≥2 distinct groups ⇒ ≥2 resolved refs).
  let smaller = resolved[0].table;
  let best = Number.POSITIVE_INFINITY;
  for (const r of resolved) {
    const est = typeof r.binding.rowEstimate === 'number' ? r.binding.rowEstimate : Number.POSITIVE_INFINITY;
    if (est < best) {
      best = est;
      smaller = r.table;
    }
  }
  return { groups, smaller };
}
