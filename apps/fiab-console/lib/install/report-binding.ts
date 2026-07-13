/**
 * Install-time report binding — turn a bundle's semantic-model-authored report
 * into a report that RENDERS REAL VALUES against its sibling lakehouse the
 * moment the app is installed.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * A bundle `report` is authored at the SEMANTIC-MODEL level: its visuals carry
 * DAX-qualified refs (`FactSales[Total Sales]`, `DimDate[month_name]`) and the
 * legacy `config.{axis,values,legend}` shape — NOT the designer's
 * `config.wells`. On install the raw bundle content is stamped onto the report
 * item verbatim, so the report editor shows a "choose a data source" gate and,
 * once bound, "no fields yet" (the designer only rehydrates `config.wells` or a
 * scalar `field`). Meanwhile the Loom-native report executor CANNOT join across
 * tables, so binding to the semantic model (fact + dims) yields `multi-table`
 * gates for every chart.
 *
 * ── What this module does (pure, no I/O — unit-tested) ──────────────────────
 * Given a report's bundle content, its sibling semantic-model content, and its
 * sibling lakehouse's SEEDED tables (name + DDL-typed columns), it produces:
 *   1. a `direct-query` data source: ONE denormalized read-only SELECT that
 *      JOINs the seeded fact + dim CSVs (via the model's relationship keys),
 *      typed per the DDL so numeric wells aggregate — exposed to the resolver
 *      as the single derived table `Query` (see report-model-resolver.ts), so
 *      the single-FROM executor never has to join; and
 *   2. transformed designer content: each visual rewritten to `config.wells`
 *      with SINGLE-TABLE wells over `Query` (measures resolved to their base
 *      column + aggregation; dim axes resolved to their physical column).
 *
 * The caller (the app-install route) supplies the concrete OPENROWSET https URL
 * per seeded table, writes `state.dataSource` + `state.content` back onto the
 * report Cosmos item, and the report then renders REAL aggregated rows with no
 * Fabric / Power BI / AAS (no-fabric-dependency.md, no-vaporware.md).
 *
 * Nothing here reaches the network or Cosmos; every input is already-resolved
 * data, so the transform is deterministic and testable in isolation.
 */

import { escapeSqlLiteral } from '@/lib/sql/quoting';

/** The single derived table name the direct-query resolver exposes (see
 *  report-model-resolver.ts `resolveDirectQuery` → `tableName = 'Query'`). Every
 *  transformed well references THIS table so the wells resolve against the
 *  introspected derived source. */
export const DERIVED_TABLE = 'Query';

/** A column of a seeded lakehouse table, with its Synapse-serverless SQL type. */
export interface SeedColumn {
  name: string;
  /** Synapse serverless type for the OPENROWSET WITH clause (e.g. `DECIMAL(18,2)`). */
  sqlType: string;
  /** True when the type aggregates numerically (drives the default well agg). */
  numeric: boolean;
}

/** One seeded lakehouse table: its physical (CSV-leaf) name + typed columns. */
export interface SeedTable {
  /** Physical name as seeded under `Tables/<name>/<name>.csv` (e.g. `fact_sales`). */
  name: string;
  columns: SeedColumn[];
  /** True when a seed CSV was actually written for this table. */
  seeded: boolean;
  /** Honest seeded row count (bundle sampleRows length), when known. */
  rowCount?: number;
}

/** The sibling semantic-model facts the binder needs (tables/measures/rels). */
export interface ModelInfo {
  tables: Array<{ name: string; columns: string[] }>;
  measures: Array<{ name: string; expression: string; table?: string }>;
  relationships: Array<{ fromTable: string; fromColumn: string; toTable: string; toColumn: string }>;
}

/** A bundle report visual, in the raw persisted `ReportContent` shape. */
export interface BundleVisual {
  type: string;
  title?: string;
  field?: string;
  config?: any;
}
export interface BundlePage {
  name: string;
  visuals: BundleVisual[];
}

/** A designer well field (persist shape — no client `uid`). */
export interface WellField {
  table?: string;
  column?: string;
  measure?: string;
  aggregation?: 'Sum' | 'Avg' | 'Count' | 'Min' | 'Max';
}
/** A transformed designer visual (what the report editor rehydrates). */
export interface DesignerVisual {
  type: string;
  title: string;
  config: {
    wells: { category: WellField[]; values: WellField[]; legend: WellField[] };
    layout: { x: number; y: number; w: number; h: number; unit: 'px' };
  };
}
export interface DesignerPage {
  name: string;
  visuals: DesignerVisual[];
}

/** A resolved direct-query binding + the rewritten designer content. */
export interface ReportBinding {
  dataSource: { kind: 'direct-query'; target: 'lakehouse'; sql: string };
  content: { kind: 'report'; pages: DesignerPage[]; [k: string]: unknown };
}

// ── DDL → typed columns ────────────────────────────────────────────────────

/** Bracket-quote a SQL identifier (double any `]`). */
function bq(ident: string): string {
  return `[${String(ident).replace(/\]/g, ']]')}]`;
}

/**
 * Map a bundle DDL type token (Spark/T-SQL flavored) to a Synapse-serverless
 * OPENROWSET WITH-clause type. Numeric types keep their precision so a value
 * well's `SUM`/`AVG` runs; strings/dates map to safe defaults. Anything unknown
 * falls back to `VARCHAR(4000)` — never a hard failure.
 */
export function synapseType(raw: string): { sqlType: string; numeric: boolean } {
  const t = raw.trim().toUpperCase();
  const decimal = /^(DECIMAL|NUMERIC)\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(t);
  if (decimal) return { sqlType: `DECIMAL(${decimal[2]},${decimal[3]})`, numeric: true };
  const varchar = /^(VARCHAR|NVARCHAR|CHAR|NCHAR)\s*\(\s*(\d+)\s*\)/.exec(t);
  if (varchar) return { sqlType: `VARCHAR(${varchar[2]})`, numeric: false };
  // Base (unparameterized) type: the FIRST token, dropping any trailing column
  // modifiers the DDL carries (`INT NOT NULL`, `DATE NOT NULL`, …).
  const base = t.split(/\s+/)[0].replace(/\(.*$/, '').trim();
  switch (base) {
    case 'BIGINT':
    case 'LONG':
      return { sqlType: 'BIGINT', numeric: true };
    case 'INT':
    case 'INTEGER':
    case 'SMALLINT':
    case 'TINYINT':
      return { sqlType: 'INT', numeric: true };
    case 'DOUBLE':
    case 'FLOAT':
    case 'REAL':
      return { sqlType: 'FLOAT', numeric: true };
    case 'MONEY':
    case 'SMALLMONEY':
      return { sqlType: 'DECIMAL(18,4)', numeric: true };
    case 'DECIMAL':
    case 'NUMERIC':
      return { sqlType: 'DECIMAL(18,2)', numeric: true };
    case 'DATE':
      return { sqlType: 'DATE', numeric: false };
    case 'TIMESTAMP':
    case 'DATETIME':
    case 'DATETIME2':
      return { sqlType: 'DATETIME2', numeric: false };
    case 'VARCHAR':
    case 'NVARCHAR':
    case 'STRING':
    case 'TEXT':
    case 'CHAR':
      return { sqlType: 'VARCHAR(4000)', numeric: false };
    default:
      return { sqlType: 'VARCHAR(4000)', numeric: false };
  }
}

/**
 * Parse a `CREATE TABLE name ( col TYPE, … )` DDL into typed columns, in
 * declaration order (== the seed CSV column order). Skips table-level
 * constraint clauses and comments. Mirrors the column-splitting logic the
 * lakehouse provisioner uses to write the seed CSV, so the parsed order aligns
 * with the CSV header.
 */
export function parseDdlTypedColumns(ddl: string): SeedColumn[] {
  if (!ddl) return [];
  // Strip line comments so a `-- …` note above the column list can't leak in.
  const clean = ddl.replace(/--[^\n]*/g, '');
  const open = clean.indexOf('(');
  const close = clean.lastIndexOf(')');
  if (open < 0 || close <= open) return [];
  const inner = clean.slice(open + 1, close);

  const segments: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      segments.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) segments.push(cur);

  const CONSTRAINTS = new Set(['CONSTRAINT', 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'KEY', 'USING', 'PARTITIONED']);
  const out: SeedColumn[] = [];
  for (const seg of segments) {
    const parts = seg.trim().split(/\s+/);
    const name = parts[0];
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || CONSTRAINTS.has(name.toUpperCase())) continue;
    const typeToken = parts.slice(1).join(' ');
    if (!typeToken) continue;
    const { sqlType, numeric } = synapseType(typeToken);
    out.push({ name, sqlType, numeric });
  }
  return out;
}

// ── Name / ref parsing ─────────────────────────────────────────────────────

/** Normalize a table name for cross-naming matches (`FactSales`≈`fact_sales`). */
function norm(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Map a semantic-model table name to its seeded physical table (or null). */
export function mapModelTableToSeed(modelTable: string, seeds: SeedTable[]): SeedTable | null {
  const want = norm(modelTable);
  return seeds.find((s) => norm(s.name) === want) || null;
}

/**
 * Parse a bundle field reference into `{ table?, field }`. Accepts the DAX-style
 * `Table[Field]` / `'Table'[Field]`, the dotted `Table.Field`, the bare
 * `[Measure]`, and a bare `Field` / measure name. Returns null for empties.
 */
export function parseRef(ref: unknown): { table?: string; field: string } | null {
  if (typeof ref !== 'string') return null;
  const s = ref.trim();
  if (!s) return null;
  let m = /^'?([^'[]+?)'?\s*\[([^\]]+)\]$/.exec(s); // Table[Field] / 'Table'[Field]
  if (m) return { table: m[1].trim(), field: m[2].trim() };
  m = /^\[([^\]]+)\]$/.exec(s); // [Measure]
  if (m) return { field: m[1].trim() };
  m = /^([^.[\]]+)\.([^.[\]]+)$/.exec(s); // Table.Field
  if (m) return { table: m[1].trim(), field: m[2].trim() };
  return { field: s };
}

/**
 * Parse a simple DAX measure expression into a base column + aggregation.
 * Handles `SUM/AVERAGE/MIN/MAX/COUNT/DISTINCTCOUNT(Table[col])` and
 * `COUNTROWS(Table)`. Composite expressions (DIVIDE, VAR, CALCULATE, …) return
 * null — the caller drops that value well rather than emit an unrunnable one.
 */
export function parseMeasure(expression: string): { column: string; aggregation: WellField['aggregation'] } | null {
  const e = String(expression || '').trim();
  const agg = /^(SUM|AVERAGE|AVG|MIN|MAX|COUNT|DISTINCTCOUNT|COUNTA)\s*\(\s*'?[^'[]*'?\s*\[([^\]]+)\]\s*\)\s*$/i.exec(e);
  if (agg) {
    const fn = agg[1].toUpperCase();
    const column = agg[2].trim();
    const aggregation: WellField['aggregation'] =
      fn === 'AVERAGE' || fn === 'AVG' ? 'Avg'
        : fn === 'MIN' ? 'Min'
          : fn === 'MAX' ? 'Max'
            : fn === 'COUNT' || fn === 'DISTINCTCOUNT' || fn === 'COUNTA' ? 'Count'
              : 'Sum';
    return { column, aggregation };
  }
  return null;
}

// ── Visual-type mapping ────────────────────────────────────────────────────

/** Designer visual types the report renderer / definition sanitizer accept. */
const KNOWN_VISUAL_TYPES = new Set([
  'table', 'matrix', 'card', 'bar', 'column', 'line', 'area', 'pie', 'donut',
  'scatter', 'slicer', 'combo', 'ribbon', 'waterfall', 'funnel', 'gauge', 'kpi',
  'treemap', 'multiRowCard', 'map', 'bubble',
]);

/** Map a bundle visual type (`lineChart`, `columnChart`, …) to a designer type. */
export function mapVisualType(t: string): string {
  const raw = String(t || '').trim();
  const direct: Record<string, string> = {
    linechart: 'line', columnchart: 'column', barchart: 'bar',
    donutchart: 'donut', piechart: 'pie', areachart: 'area',
    scatterchart: 'scatter', bubblechart: 'bubble', combochart: 'combo',
    ribbonchart: 'ribbon', waterfallchart: 'waterfall', funnelchart: 'funnel',
    stackedbar: 'bar', stackedcolumn: 'column', clusteredbar: 'bar', clusteredcolumn: 'column',
    multirowcard: 'multiRowCard', kpicard: 'kpi',
  };
  const lc = raw.toLowerCase();
  if (direct[lc]) return direct[lc];
  if (KNOWN_VISUAL_TYPES.has(raw)) return raw;
  // strip a trailing "Chart" and retry (e.g. "SomethingChart" → "something").
  const stripped = lc.replace(/chart$/, '');
  if (KNOWN_VISUAL_TYPES.has(stripped)) return stripped;
  // Charts default to a column; anything else to a table (both always render).
  return /chart|bar|line|column|area|pie|donut/.test(lc) ? 'column' : 'table';
}

// ── Denormalized direct-query SQL ──────────────────────────────────────────

/** One resolved fact→dim join on the model's relationship key. */
export interface JoinSpec {
  dim: SeedTable;
  factColumn: string;
  dimColumn: string;
}

/** Result of building the denormalized SELECT. */
export interface DenormResult {
  sql: string;
  /** Output column name → its numeric flag (drives default aggregation). */
  columns: Map<string, boolean>;
}

/**
 * Build ONE typed, denormalized read-only SELECT over the seeded CSVs: the fact
 * table LEFT JOINed to each seeded dim on its relationship key. Every relation is
 * a Synapse-serverless `OPENROWSET(FORMAT='CSV', HEADER_ROW=TRUE) WITH (<typed
 * columns>)` so numeric columns come back typed (SUM/AVG work). Columns are
 * projected with their physical names; a dim column whose name collides with an
 * already-projected column is prefixed with the dim name so it stays selectable.
 * Join-key dim columns are not re-projected (they equal the fact key).
 *
 * `httpsUrlFor(table)` yields the OPENROWSET BULK url for a seeded table's CSV.
 */
export function buildDenormalizedSelect(
  fact: SeedTable,
  joins: JoinSpec[],
  httpsUrlFor: (physicalTable: string) => string,
): DenormResult {
  const columns = new Map<string, boolean>();
  const selects: string[] = [];

  const relation = (t: SeedTable, alias: string): string => {
    const withCols = t.columns.map((c) => `${bq(c.name)} ${c.sqlType}`).join(', ');
    const url = escapeSqlLiteral(httpsUrlFor(t.name));
    return `OPENROWSET(BULK '${url}', FORMAT = 'CSV', PARSER_VERSION = '2.0', HEADER_ROW = TRUE) WITH (${withCols}) AS ${alias}`;
  };

  // Fact columns first — projected under their own names.
  for (const c of fact.columns) {
    columns.set(c.name, c.numeric);
    selects.push(`f.${bq(c.name)} AS ${bq(c.name)}`);
  }

  const fromParts: string[] = [`FROM ${relation(fact, 'f')}`];
  joins.forEach((j, i) => {
    const alias = `d${i}`;
    for (const c of j.dim.columns) {
      if (c.name.toLowerCase() === j.dimColumn.toLowerCase()) continue; // key == fact key
      const outName = columns.has(c.name) ? `${j.dim.name}_${c.name}` : c.name;
      columns.set(outName, c.numeric);
      selects.push(`${alias}.${bq(c.name)} AS ${bq(outName)}`);
    }
    fromParts.push(
      `LEFT JOIN ${relation(j.dim, alias)} ON f.${bq(j.factColumn)} = ${alias}.${bq(j.dimColumn)}`,
    );
  });

  const sql = `SELECT ${selects.join(', ')}\n${fromParts.join('\n')}`;
  return { sql, columns };
}

// ── Orchestration ──────────────────────────────────────────────────────────

/**
 * Choose the fact model table: the table most measures aggregate over, else the
 * `fromTable` (many-side) of the most relationships, restricted to tables that
 * actually map to a SEEDED physical table. Returns the model name + its seed.
 */
function chooseFact(
  model: ModelInfo,
  seeds: SeedTable[],
): { modelTable: string; seed: SeedTable } | null {
  const seededModelTables = model.tables
    .map((t) => ({ modelTable: t.name, seed: mapModelTableToSeed(t.name, seeds) }))
    .filter((x): x is { modelTable: string; seed: SeedTable } => !!x.seed && x.seed.seeded);
  if (!seededModelTables.length) return null;

  const score = new Map<string, number>();
  for (const m of model.measures) {
    const ref = parseRef(m.table ? `${m.table}[x]` : undefined) || (m.table ? { table: m.table, field: 'x' } : null);
    const owner = m.table || ref?.table;
    if (owner) score.set(owner, (score.get(owner) || 0) + 2);
  }
  for (const r of model.relationships) {
    score.set(r.fromTable, (score.get(r.fromTable) || 0) + 1);
  }
  let best = seededModelTables[0];
  let bestScore = -1;
  for (const cand of seededModelTables) {
    const sc = score.get(cand.modelTable) ?? 0;
    if (sc > bestScore) {
      bestScore = sc;
      best = cand;
    }
  }
  return best;
}

/**
 * Build the fact→dim joins for the chosen fact from the model relationships,
 * keeping only those whose dim maps to a seeded table AND whose key columns
 * exist on both physical relations.
 */
function buildJoins(factModelTable: string, fact: SeedTable, model: ModelInfo, seeds: SeedTable[]): JoinSpec[] {
  const joins: JoinSpec[] = [];
  const seenDim = new Set<string>();
  const factCols = new Set(fact.columns.map((c) => c.name.toLowerCase()));
  for (const r of model.relationships) {
    // Orient the relationship so the fact side is the chosen fact table.
    let factColumn: string | undefined;
    let dimModelTable: string | undefined;
    let dimColumn: string | undefined;
    if (norm(r.fromTable) === norm(factModelTable)) {
      factColumn = r.fromColumn;
      dimModelTable = r.toTable;
      dimColumn = r.toColumn;
    } else if (norm(r.toTable) === norm(factModelTable)) {
      factColumn = r.toColumn;
      dimModelTable = r.fromTable;
      dimColumn = r.fromColumn;
    }
    if (!factColumn || !dimModelTable || !dimColumn) continue;
    if (seenDim.has(norm(dimModelTable))) continue;
    const dim = mapModelTableToSeed(dimModelTable, seeds);
    if (!dim || !dim.seeded) continue;
    if (!factCols.has(factColumn.toLowerCase())) continue;
    if (!dim.columns.some((c) => c.name.toLowerCase() === dimColumn!.toLowerCase())) continue;
    seenDim.add(norm(dimModelTable));
    joins.push({ dim, factColumn, dimColumn });
  }
  return joins;
}

/** Resolve a field ref to a `Query` column that actually exists (case-insensitive). */
function resolveColumn(field: string, columns: Map<string, boolean>): { name: string; numeric: boolean } | null {
  const want = field.trim().toLowerCase();
  for (const [name, numeric] of columns) {
    if (name.toLowerCase() === want) return { name, numeric };
  }
  return null;
}

/** Build a value well from a ref — resolving a measure to its base column+agg,
 *  or a raw column (numeric ⇒ Sum, else Count so it never errors). Null if
 *  nothing resolves against the derived `Query` columns. */
function valueWell(
  ref: string,
  columns: Map<string, boolean>,
  measureByName: Map<string, { column: string; aggregation: WellField['aggregation'] }>,
): WellField | null {
  const parsed = parseRef(ref);
  if (!parsed) return null;
  // Measure? (bundle refs are `Table[Measure Name]` or `[Measure]`).
  const meas = measureByName.get(parsed.field.trim().toLowerCase());
  if (meas) {
    const col = resolveColumn(meas.column, columns);
    if (col) return { table: DERIVED_TABLE, column: col.name, aggregation: meas.aggregation };
  }
  const col = resolveColumn(parsed.field, columns);
  if (!col) return null;
  return { table: DERIVED_TABLE, column: col.name, aggregation: col.numeric ? 'Sum' : 'Count' };
}

/** Build a category/legend well from a ref (raw column, no aggregation). */
function groupWell(ref: string, columns: Map<string, boolean>): WellField | null {
  const parsed = parseRef(ref);
  if (!parsed) return null;
  const col = resolveColumn(parsed.field, columns);
  return col ? { table: DERIVED_TABLE, column: col.name } : null;
}

/** Transform one bundle visual into a designer visual over the `Query` table. */
export function transformVisual(
  visual: BundleVisual,
  index: number,
  columns: Map<string, boolean>,
  measureByName: Map<string, { column: string; aggregation: WellField['aggregation'] }>,
): DesignerVisual {
  const type = mapVisualType(visual.type);
  const cfg = visual.config || {};
  const category: WellField[] = [];
  const values: WellField[] = [];
  const legend: WellField[] = [];

  const pushGroup = (arr: WellField[], ref: unknown) => {
    if (typeof ref === 'string') {
      const w = groupWell(ref, columns);
      if (w) arr.push(w);
    }
  };
  const pushValue = (ref: unknown) => {
    if (typeof ref === 'string') {
      const w = valueWell(ref, columns, measureByName);
      if (w) values.push(w);
    }
  };

  // Axis / group → category; legend / subgroup → legend.
  pushGroup(category, cfg.axis);
  pushGroup(category, cfg.group);
  pushGroup(legend, cfg.legend);
  pushGroup(legend, cfg.subgroup);

  // Value list (charts) → value wells.
  if (Array.isArray(cfg.values)) for (const v of cfg.values) pushValue(v);

  // Table visual columns: project each field as a raw category column.
  if (Array.isArray(cfg.columns)) {
    for (const c of cfg.columns) {
      const ref = c && typeof c === 'object' ? (c.field ?? c.column) : c;
      if (typeof ref !== 'string') continue;
      // A measure column in a table still projects a value; a plain column a category.
      const parsed = parseRef(ref);
      const isMeasure = parsed && measureByName.has(parsed.field.trim().toLowerCase());
      if (isMeasure) pushValue(ref);
      else pushGroup(category, ref);
    }
  }

  // Scalar `field` — a card/kpi/gauge value, or a chart's single measure when it
  // carried no explicit values list.
  if (visual.field && values.length === 0) {
    pushValue(visual.field);
  }
  // A chart that resolved a value but no category yet: nothing to add — the
  // executor renders the aggregate as a single-row card-like result.

  // Grid layout (absolute px so the designer treats it as authoritative).
  const perRow = 3;
  const w = type === 'card' || type === 'kpi' ? 300 : 460;
  const h = type === 'card' || type === 'kpi' ? 150 : 300;
  const col = index % perRow;
  const row = Math.floor(index / perRow);
  const layout = { x: col * 480 + 16, y: row * 320 + 16, w, h, unit: 'px' as const };

  return {
    type,
    title: visual.title || '',
    config: { wells: { category, values, legend }, layout },
  };
}

/**
 * Build the full report binding (direct-query data source + rewritten designer
 * content) for a report whose sibling lakehouse has SEEDED tables and whose
 * sibling semantic model supplies the measures + join keys.
 *
 * Returns null when there is no seeded fact table to render over — the caller
 * then leaves the report unbound (the editor keeps its honest "pick a data
 * source" state; no fabricated binding).
 */
export function buildReportBinding(params: {
  report: { pages: BundlePage[]; [k: string]: unknown };
  model: ModelInfo | null;
  seeds: SeedTable[];
  httpsUrlFor: (physicalTable: string) => string;
}): ReportBinding | null {
  const { report, seeds, httpsUrlFor } = params;
  const seeded = seeds.filter((s) => s.seeded && s.columns.length > 0);
  if (!seeded.length) return null;

  // A model is strongly preferred (gives measures + join keys). Without one we
  // fall back to a single-table bind over the largest seeded table.
  const model: ModelInfo = params.model || { tables: [], measures: [], relationships: [] };

  let factModelTable: string;
  let fact: SeedTable;
  let joins: JoinSpec[];
  const chosen = model.tables.length ? chooseFact(model, seeded) : null;
  if (chosen) {
    factModelTable = chosen.modelTable;
    fact = chosen.seed;
    joins = buildJoins(factModelTable, fact, model, seeded);
  } else {
    // No model mapping — bind the seeded table with the most columns (usually
    // the fact), no joins. Still renders single-table visuals with real values.
    fact = [...seeded].sort((a, b) => b.columns.length - a.columns.length)[0];
    joins = [];
  }

  const denorm = buildDenormalizedSelect(fact, joins, httpsUrlFor);

  // Index measures by lowercased name for fast ref resolution.
  const measureByName = new Map<string, { column: string; aggregation: WellField['aggregation'] }>();
  for (const m of model.measures) {
    const parsed = parseMeasure(m.expression);
    if (parsed) measureByName.set(m.name.trim().toLowerCase(), parsed);
  }

  const pages: DesignerPage[] = (report.pages || []).map((p) => ({
    name: p.name,
    visuals: (p.visuals || []).map((v, i) => transformVisual(v, i, denorm.columns, measureByName)),
  }));

  return {
    dataSource: { kind: 'direct-query', target: 'lakehouse', sql: denorm.sql },
    content: { ...report, kind: 'report', pages },
  };
}
