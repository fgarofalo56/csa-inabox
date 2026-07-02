/**
 * wells-to-kql — compile the report designer's visual field-wells into a
 * parameter-free, injection-safe Kusto (KQL) query over an Azure Data Explorer
 * (ADX) table. This is the ADX-engine sibling of `wells-to-sql.buildSqlFromVisual`
 * (T-SQL over Synapse) and `aas-dax.buildDaxFromVisual` (DAX over AAS): it lets a
 * Loom report render REAL aggregated rows from an ADX cluster WITHOUT Azure
 * Analysis Services / Power BI / Fabric in the loop (no-fabric-dependency.md).
 *
 * Intended wiring (the ADX arm of the Get-Data pipeline): the resolver builds a
 * {@link KqlSource} from a bound `adx` LoomConnection (table + its real column
 * schema), calls {@link buildKqlFromVisual}, and runs the emitted text through
 * `kusto-client.executeQuery(db, kql, { clusterUri })` (+`kustoConfigGate`). The
 * same structured Filters pane that drives the SQL `WHERE`/`HAVING` and the DAX
 * `CALCULATETABLE` here drives the KQL `where` predicates — one Filters model,
 * three engines.
 *
 * ── STATUS: staged Wave-2 module (unused-but-real is intentional + disclosed) ──
 * This compiler is COMPLETE and unit-TESTED — `__tests__/wells-to-kql.test.ts`
 * regression-guards every emitted shape (table / slicer / card / grouped chart /
 * make-series / Top-N), the shared Filters-pane model, and the injection-safety
 * contract — but is NOT YET WIRED into the live Get-Data pipeline.
 * `report-model-resolver.ts → buildConnectionExecutor()` switches on the loaded
 * `LoomConnection.type`, and `adx` (like `mysql`) has no bindable LoomConnection
 * in Wave 1 — it is documented there as "honest-gate / forward-compat", so an ADX
 * report source falls to the resolver's default honest gate rather than executing
 * here. That is deliberate, not a stub: there is no mock data and no dead UI card
 * (no-vaporware) — only this pure string synthesizer, kept honest by the colocated
 * spec above, waiting on an upstream credential surface. ACTIVATION is a single
 * additive `case 'adx':` in `buildConnectionExecutor` once an `adx` ConnectionType
 * is bindable: build a {@link KqlSource} from the connection's table + introspected
 * columns, call {@link buildKqlFromVisual}, and run the `.kql` through
 * `kusto-client.executeQuery(db, kql, { clusterUri: conn.host })` behind
 * `kustoConfigGate()`. No change to THIS module is required to light it up — its
 * SHARED-CONTRACT exports ({@link KqlSource}, {@link CompiledKql},
 * {@link buildKqlFromVisual}) are stable, and the spec is its acceptance gate.
 * That activation is TRACKED as a real Get-Data Wave-1 follow-up (the resolver's
 * `adx` case + a bindable ADX ConnectionType) — not left indefinitely staged.
 * Until then it is staged, not shipped.
 *
 * Pure + credential-free (mirrors wells-to-sql / aas-dax): no Azure SDK, no
 * network — only deterministic string synthesis — so the compiler is unit-testable
 * in isolation and the report routes stay thin dispatchers.
 *
 * Rules compliance:
 *  - no-vaporware: every branch emits a real, runnable KQL statement against a
 *    real ADX relation — no mock arrays, no `return []`. (`return null` means the
 *    visual has no whitelisted fields, exactly like `buildSqlFromVisual`, so the
 *    caller skips the visual / returns 400.)
 *  - no-freeform-config: the user never types KQL here. Wells + filters are
 *    structured picker output; the ONLY free text is the (already sql/kql-guard'd)
 *    raw-KQL `mode:'kql'` source the resolver hands the executor directly — never
 *    this module.
 *  - injection-safe: identifiers are NEVER taken from the client. Every column /
 *    rank target is resolved against the resolver-supplied `KqlSource` column
 *    whitelist and bracket-quoted (`['…']`, escaping `\` and `'`); a field not in
 *    the whitelist is skipped, never emitted. All literal values are KQL-escaped
 *    (single-quoted, `\`/`'` doubled-out) — and dates wrapped in `todatetime(…)`
 *    — so a value can never break out of its literal. Numeric offsets for the
 *    relative-date window are validated integers; the `datetime_add` period and
 *    `make-series` step are whitelisted keywords.
 *  - no Fabric/AAS: pure ADX KQL.
 */

import type { DaxVisual, DaxWellField } from './aas-dax';
import type { ReportFilterInput, RelativeDateUnit, RelativeDateDirection } from './wells-to-sql';

// ── KQL source (resolver-supplied; the table + identifier whitelist) ───────────

/** A column the ADX table exposes (the only legal identifiers + a type hint). */
export interface KqlSourceColumn {
  /** Column name as exposed by the table (used verbatim, bracket-quoted). */
  name: string;
  /** Optional KQL type hint ('datetime'|'string'|'long'|'real'|…); drives date
   *  literal coercion (`todatetime`) and the make-series time-axis detection. */
  dataType?: string;
}

/** Everything the compiler needs to turn wells into a real, runnable KQL query. */
export interface KqlSource {
  /** The source table the pipeline reads from (`<table> | …`). */
  table: string;
  /** Whitelist of selectable columns (the only legal identifiers). */
  columns: KqlSourceColumn[];
}

// ── Compiled output ────────────────────────────────────────────────────────────

/** The runnable artifact: a KQL text passed straight to `kusto-client.executeQuery`. */
export interface CompiledKql {
  kql: string;
}

// ── Maps ───────────────────────────────────────────────────────────────────────

/**
 * Loom aggregation choice → KQL aggregation function. Mirrors `wells-to-sql`'s
 * `SQL_AGG_FN`. `Count` maps to `count()` (counts rows in the group; KQL's
 * `count()` takes no column — `dcount(col)` would be a distinct count, but the
 * field-well model exposes no distinct-count choice in Wave 1).
 */
const KQL_AGG_FN: Record<string, string> = {
  Sum: 'sum',
  Avg: 'avg',
  Count: 'count',
  Min: 'min',
  Max: 'max',
};

/** Scalar comparison operators (in/contains/between/relativeDate handled separately). */
const KQL_SCALAR_OP: Partial<Record<string, string>> = {
  eq: '==',
  ne: '!=',
  gt: '>',
  ge: '>=',
  lt: '<',
  le: '<=',
};

/** Row cap for projection / distinct / grouped queries. */
const ROW_CAP = 1000;

/** `relativeDate` granularity → KQL `datetime_add` period keyword. Whitelisted
 *  (never client text), so it is safe to inline while the numeric offset is a
 *  validated integer. (`days` uses the `ago(Nd)` / `now()+Nd` timespan form.) */
const KQL_DATE_PERIOD: Record<Exclude<RelativeDateUnit, 'days'>, string> = {
  hours: 'hour',
  minutes: 'minute',
  months: 'month',
  years: 'year',
};

/** Chart types that render as a time series over a datetime axis (→ make-series). */
const TIME_SERIES_TYPES = new Set([
  'line', 'linechart', 'line-chart', 'area', 'areachart', 'area-chart',
]);

/**
 * Clamp a client-supplied count to a positive integer in `[1, max]`. Returns null
 * when it is not a finite number ≥ 1. The result is a validated integer, so it is
 * injection-safe to inline (the same contract under which `ROW_CAP` is inlined).
 */
function clampCount(n: number | undefined, max: number): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < 1) return null;
  return Math.min(i, max);
}

// ── relative-date field accessors (field-name alignment with the Filters pane) ─
//
// `wireFilters` / the /definition route emit `relN` / `relUnit` / `relDir`; the
// verbose `relativeN` / `relativeUnit` / `relativeDirection` are accepted as
// aliases for older callers. These mirror `wells-to-sql`'s accessors so the SAME
// Filters-pane window compiles identically across the SQL, DAX, and KQL backends.

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

// ── Identifier + literal helpers (injection-safe) ──────────────────────────────

/**
 * Quote a KQL identifier. A simple name (`[A-Za-z_][A-Za-z0-9_]*`) is emitted
 * bare; anything else is bracket-quoted `['…']` with `\` and `'` escaped — the
 * KQL analogue of `wells-to-sql.bracket`. Identifiers only ever come from the
 * resolver whitelist, but quoting keeps names with spaces/punctuation legal.
 */
export function kqlIdent(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name;
  return `['${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;
}

/** A KQL single-quoted string literal (escaping `\` then `'`). */
function kqlString(v: string): string {
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Emit a KQL scalar literal for a filter value, honoring the target column type:
 *   • datetime column → `todatetime('…')` so the value compares as a datetime;
 *   • numeric-looking value → bare number;
 *   • otherwise → an escaped string literal.
 * Always injection-safe (the only free text is wrapped in an escaped string).
 */
function kqlLiteral(v: string, dataType?: string): string {
  const t = v.trim();
  if (dataType && /datetime|date|time|timestamp/i.test(dataType)) {
    return `todatetime(${kqlString(t)})`;
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  return kqlString(t);
}

// ── Whitelist resolution ───────────────────────────────────────────────────────

/**
 * Resolve a well/filter column against the whitelist (case-insensitive by name —
 * an ADX table has no schema/table dimension). Returns the canonical whitelisted
 * column definition (so the EMITTED identifier comes from the resolver, never the
 * client), or null when not whitelisted.
 */
function resolveColumn(src: KqlSource, column: string | undefined): KqlSourceColumn | null {
  if (!column) return null;
  const want = column.trim().toLowerCase();
  return src.columns.find((c) => c.name.toLowerCase() === want) || null;
}

/** A bracket-quoted reference to a whitelisted column. */
function colRef(name: string): string {
  return kqlIdent(name);
}

/** True when a column's type hint marks it as a datetime axis. */
function isDateType(dataType?: string): boolean {
  return !!dataType && /datetime|date|time|timestamp/i.test(dataType);
}

// ── Value-well → aggregate projection ──────────────────────────────────────────

interface KqlAgg {
  /** The KQL aggregation expression, e.g. `sum(['Amount'])` / `count()`. */
  expr: string;
  /** Result column name (matches the SQL/DAX alias so the client renders identically). */
  alias: string;
  /** Source column name (lets a Top-N rank target be matched back to its aggregate). */
  column: string;
}

/**
 * Build the aggregation expression + result alias for a value-well field. An ADX
 * `KqlSource` carries no semantic measures, so value wells resolve to COLUMN
 * aggregates only (a measure-only well field is skipped). The alias mirrors
 * `wells-to-sql.aggProjection` / `aas-dax.daxValueExpr` (`<Agg> of <Column>` /
 * `Sum of <Column>`) so SQL, DAX, and KQL results carry the same column names and
 * the client renders/filters them identically.
 */
function aggProjection(src: KqlSource, w: DaxWellField): KqlAgg | null {
  const col = resolveColumn(src, w.column);
  if (!col || !w.column) return null;
  const useAgg = w.aggregation && w.aggregation !== 'None';
  const fn = useAgg ? KQL_AGG_FN[w.aggregation as string] || 'sum' : 'sum';
  const alias = useAgg ? `${w.aggregation} of ${w.column}` : `Sum of ${w.column}`;
  // `count()` is row-count (no column argument); every other function takes the col.
  const expr = fn === 'count' ? 'count()' : `${fn}(${colRef(col.name)})`;
  return { expr, alias, column: col.name };
}

/** Resolve a group/category well field to a `{ ref, alias }` (raw column). */
function groupColumn(src: KqlSource, w: DaxWellField): { ref: string; alias: string } | null {
  const col = resolveColumn(src, w.column);
  if (!col) return null;
  return { ref: colRef(col.name), alias: col.name };
}

/** Dedupe `{ ref, alias }` group columns by alias, preserving order. */
function dedupeGroups(groups: { ref: string; alias: string }[]): { ref: string; alias: string }[] {
  const seen = new Set<string>();
  return groups.filter((g) => (seen.has(g.alias) ? false : (seen.add(g.alias), true)));
}

// ── where predicates from structured filters ───────────────────────────────────

/** Build a single KQL predicate for `ref <op> value(s)` (null → skip). */
function kqlPredicate(ref: string, f: ReportFilterInput, dataType?: string): string | null {
  switch (f.op) {
    case 'eq':
    case 'ne':
    case 'gt':
    case 'ge':
    case 'lt':
    case 'le': {
      if (f.value == null || f.value === '') return null;
      return `${ref} ${KQL_SCALAR_OP[f.op]} ${kqlLiteral(f.value, dataType)}`;
    }
    case 'contains': {
      // KQL `contains` is a case-insensitive substring match — the closest
      // analogue of the SQL `LIKE '%v%'` (default case-insensitive collation).
      if (f.value == null || f.value === '') return null;
      return `${ref} contains ${kqlString(f.value.trim())}`;
    }
    case 'between': {
      if (!f.value || !f.value2) return null;
      return `${ref} >= ${kqlLiteral(f.value, dataType)} and ${ref} <= ${kqlLiteral(f.value2, dataType)}`;
    }
    case 'in': {
      const set = (f.values && f.values.length ? f.values : (f.value || '').split(','))
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
      if (!set.length) return null;
      return `${ref} in (${set.map((v) => kqlLiteral(v, dataType)).join(', ')})`;
    }
    case 'relativeDate':
      return kqlRelativeDate(ref, f);
    case 'topN':
      // Top-N is a query-shape directive (the `top N by …` operator), consumed in
      // buildKqlFromVisual via extractTopN — it emits no row predicate here.
      return null;
    default:
      return null;
  }
}

/**
 * KQL mirror of the SQL `relativeDate` window: a rolling window vs the cluster
 * clock (`now()`). The numeric offset is a validated integer; the `datetime_add`
 * period is a whitelisted keyword, so this stays injection-safe.
 *   last/this N → ref >= <back bound>  and ref <= now()
 *   next N      → ref >= now()         and ref <= <forward bound>
 * where the bound is `ago(Nd)` / `now()+Nd` for days and
 * `datetime_add('month'|'year', ±N, now())` for months/years.
 */
function kqlRelativeDate(ref: string, f: ReportFilterInput): string | null {
  const n = clampCount(relDateN(f), 100_000);
  if (n == null) return null;
  const unit = relDateUnit(f);
  const bound = (sign: 1 | -1): string => {
    if (unit === 'days') return sign < 0 ? `ago(${n}d)` : `(now() + ${n}d)`;
    const period = KQL_DATE_PERIOD[unit];
    return `datetime_add('${period}', ${sign < 0 ? -n : n}, now())`;
  };
  if (relDateDir(f) === 'next') {
    return `${ref} >= now() and ${ref} <= ${bound(1)}`;
  }
  return `${ref} >= ${bound(-1)} and ${ref} <= now()`;
}

/**
 * Compile COLUMN filters into pre-summarize `where` predicates. Measure filters
 * are skipped here (they apply post-summarize — see {@link measurePredicates}); a
 * filter whose column isn't whitelisted, or whose value(s) are incomplete, is
 * silently dropped (the client also applies filters post-hoc, so a skipped
 * predicate never blanks the visual).
 */
function columnPredicates(src: KqlSource, filters: ReportFilterInput[] | undefined): string[] {
  const out: string[] = [];
  for (const f of filters || []) {
    if (f.measure) continue;
    const col = resolveColumn(src, f.column);
    if (!col) continue;
    const pred = kqlPredicate(colRef(col.name), f, col.dataType);
    if (pred) out.push(pred);
  }
  return out;
}

/**
 * Compile MEASURE filters into post-summarize `where` predicates (the KQL
 * analogue of SQL `HAVING`). With no semantic-measure whitelist on an ADX source,
 * a measure filter resolves only when its name matches an emitted aggregate's
 * alias; otherwise it is dropped (the client applies it post-hoc).
 */
function measurePredicates(filters: ReportFilterInput[] | undefined, aggs: KqlAgg[]): string[] {
  const out: string[] = [];
  for (const f of filters || []) {
    if (!f.measure) continue;
    const want = f.measure.trim().toLowerCase();
    const a = aggs.find((x) => x.alias.toLowerCase() === want);
    if (!a) continue;
    const pred = kqlPredicate(kqlIdent(a.alias), f, undefined);
    if (pred) out.push(pred);
  }
  return out;
}

// ── Top-N (query-shape directive, not a predicate) ─────────────────────────────

/**
 * Pull the active Power BI "Top N" directive (the first `op:'topN'` filter) out of
 * the Filters pane — mirrors `wells-to-sql.extractTopN`. The RANK TARGET is
 * authored SEPARATELY from the filter's own field, in `byMeasure` / `byColumn`
 * (+`byTable`), with the legacy `measure` accepted as a fallback. Returns null
 * when there is no Top-N filter or N is not a positive integer.
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
 * Rank expression for the `top N by …` operator: the Top-N rank target when it
 * resolves to a value-well aggregate (matched by the aggregate's alias, or by its
 * source column). An ADX source has no semantic measures, so a `byMeasure` is
 * matched against the emitted aggregate aliases. Falls back to the first
 * aggregate's alias when the rank target doesn't resolve — so a Top-N with an
 * unresolved by-field keeps a deterministic ordering. Caller guarantees `aggs`
 * is non-empty.
 */
function topNRankExpr(
  src: KqlSource,
  topN: { byMeasure?: string; byColumn?: string; byTable?: string } | null,
  aggs: KqlAgg[],
): string {
  if (topN?.byMeasure) {
    const want = topN.byMeasure.trim().toLowerCase();
    const a = aggs.find((x) => x.alias.toLowerCase() === want);
    if (a) return kqlIdent(a.alias);
  }
  if (topN?.byColumn) {
    const col = resolveColumn(src, topN.byColumn);
    if (col) {
      const lc = col.name.toLowerCase();
      const a = aggs.find((x) => x.column.toLowerCase() === lc);
      if (a) return kqlIdent(a.alias);
    }
  }
  return kqlIdent(aggs[0].alias);
}

// ── Pipeline assembly ──────────────────────────────────────────────────────────

/** Join the source table + pipe operators into a single KQL statement. */
function pipeline(table: string, segments: string[]): string {
  const head = kqlIdent(table);
  return segments.length ? `${head}\n| ${segments.join('\n| ')}` : head;
}

/** Unique strings, preserving first-seen order. */
function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

// ── Public: visual wells → KQL ─────────────────────────────────────────────────

/**
 * Compile a designer visual + structured filters into an injection-safe KQL query
 * over `src` (an ADX table + its column whitelist). Returns null when the visual
 * has no whitelisted fields (caller skips the visual / returns 400, exactly like
 * `buildSqlFromVisual`).
 *
 *   table                       → <table> | where … | project <cols> | top N
 *   slicer / category-only      → <table> | where … | distinct <category> | take N
 *   card                        → <table> | where … | summarize <agg…>          (one row)
 *   line/area over a datetime   → <table> | where … | make-series <agg…> on <t> step 1d [by …]
 *   chart / matrix (grp+vals)   → <table> | where … | summarize <agg…> by <grp> | top N by <rank>
 *
 * Column filters become a pre-summarize `where`; measure filters a post-summarize
 * `where` (the HAVING analogue). Every identifier is whitelisted via `src`; every
 * literal is KQL-escaped (dates wrapped in `todatetime`). No Fabric/AAS.
 *
 * @remarks STAGED WAVE-2: real + unit-testable, but not yet wired into the live
 * Get-Data pipeline — `report-model-resolver.ts → buildConnectionExecutor()` has
 * no `adx` case yet (no bindable `adx` LoomConnection in Wave 1), so an ADX source
 * honest-gates instead of calling this. See the module header for the single
 * additive `case 'adx':` that lights it up via `kusto-client.executeQuery`.
 */
export function buildKqlFromVisual(
  visual: DaxVisual,
  filters: ReportFilterInput[] | undefined,
  src: KqlSource,
): CompiledKql | null {
  const wells = visual.wells || {};
  const category = wells.category || [];
  const values = wells.values || [];
  const legend = wells.legend || [];
  const type = (visual.type || '').toLowerCase();

  // ── table → raw projection (no aggregation, no grouping) ────────────────────
  if (type === 'table') {
    const cols = uniqueStrings(
      [...category, ...values]
        .map((w) => resolveColumn(src, w.column)?.name)
        .filter((n): n is string => !!n),
    );
    if (!cols.length) return null;
    const where = columnPredicates(src, filters);
    const segs: string[] = [];
    if (where.length) segs.push(`where ${where.join(' and ')}`);
    segs.push(`project ${cols.map(kqlIdent).join(', ')}`);
    // Deterministic, capped projection (ADX `top … by` keeps the first N ordered).
    segs.push(`top ${ROW_CAP} by ${kqlIdent(cols[0])} asc`);
    return { kql: pipeline(src.table, segs) };
  }

  // ── slicer → distinct category values ───────────────────────────────────────
  if (type === 'slicer') {
    const g = dedupeGroups(
      category.map((w) => groupColumn(src, w)).filter((x): x is { ref: string; alias: string } => !!x),
    );
    if (!g.length) return null;
    const where = columnPredicates(src, filters);
    const segs: string[] = [];
    if (where.length) segs.push(`where ${where.join(' and ')}`);
    segs.push(`distinct ${g.map((c) => c.ref).join(', ')}`);
    segs.push(`take ${ROW_CAP}`);
    return { kql: pipeline(src.table, segs) };
  }

  // ── card / chart / matrix → aggregate (optionally grouped) ──────────────────
  // Cards never group; charts/matrices group by category + legend.
  const group = dedupeGroups(
    (type === 'card' ? [] : [...category, ...legend])
      .map((w) => groupColumn(src, w))
      .filter((x): x is { ref: string; alias: string } => !!x),
  );

  // Wave-1 multi-value contract: extra measure-like inputs fold into `wells.values`
  // (combo/gauge/KPI/treemap/scatter/tooltips) and small-multiples fold into
  // `category`/`legend`, so each becomes one more aggregate / group automatically —
  // no per-visual branching (identical to wells-to-sql / aas-dax).
  const aggs = values
    .map((w) => aggProjection(src, w))
    .filter((x): x is KqlAgg => !!x);

  if (group.length === 0 && aggs.length === 0) return null;

  const where = columnPredicates(src, filters);

  // No values → distinct grouping (acts like a slicer / category table).
  if (aggs.length === 0) {
    const segs: string[] = [];
    if (where.length) segs.push(`where ${where.join(' and ')}`);
    segs.push(`distinct ${group.map((c) => c.ref).join(', ')}`);
    segs.push(`take ${ROW_CAP}`);
    return { kql: pipeline(src.table, segs) };
  }

  // ── time series → make-series over a binned datetime axis ───────────────────
  // A line/area chart whose ONLY category is a single datetime column compiles to
  // `make-series` (the ADX-native time-series shape), with the date column as the
  // axis and any legend fields as the series split. The grain defaults to daily —
  // the field-well model carries no explicit time grain in Wave 1. Every other
  // chart (including a datetime category on a bar/matrix) takes the standard
  // `summarize by` path below.
  if (TIME_SERIES_TYPES.has(type) && type !== 'card') {
    const catDefs = category
      .map((w) => resolveColumn(src, w.column))
      .filter((c): c is KqlSourceColumn => !!c);
    if (catDefs.length === 1 && isDateType(catDefs[0].dataType)) {
      const byCols = dedupeGroups(
        legend.map((w) => groupColumn(src, w)).filter((x): x is { ref: string; alias: string } => !!x),
      );
      const segs: string[] = [];
      if (where.length) segs.push(`where ${where.join(' and ')}`);
      const seriesAggs = aggs.map((a) => `${kqlIdent(a.alias)} = ${a.expr} default=0`);
      let ms = `make-series ${seriesAggs.join(', ')} on ${colRef(catDefs[0].name)} step 1d`;
      if (byCols.length) ms += ` by ${byCols.map((c) => c.ref).join(', ')}`;
      segs.push(ms);
      return { kql: pipeline(src.table, segs) };
    }
  }

  // ── aggregated summarize (card = no group; chart/matrix = grouped) ──────────
  const segs: string[] = [];
  if (where.length) segs.push(`where ${where.join(' and ')}`);
  const aggExprs = aggs.map((a) => `${kqlIdent(a.alias)} = ${a.expr}`);
  segs.push(
    group.length
      ? `summarize ${aggExprs.join(', ')} by ${group.map((c) => c.ref).join(', ')}`
      : `summarize ${aggExprs.join(', ')}`,
  );

  // Measure filters → post-summarize `where` (HAVING analogue; aggregated only).
  const measureWhere = measurePredicates(filters, aggs);
  if (measureWhere.length) segs.push(`where ${measureWhere.join(' and ')}`);

  // Power BI "Top N": cap the grouped result at N rows ranked by the chosen
  // by-measure (DESC for top, ASC for bottom) — the same ordering `applyFilters`
  // uses client-side. With no Top-N filter, fall back to ROW_CAP ranked by the
  // first aggregate. A card (no group) needs no ordering.
  if (group.length) {
    const topN = extractTopN(filters);
    const dir = topN?.dir === 'bottom' ? 'asc' : 'desc';
    const n = topN ? topN.n : ROW_CAP;
    segs.push(`top ${n} by ${topNRankExpr(src, topN, aggs)} ${dir}`);
  }

  return { kql: pipeline(src.table, segs) };
}
