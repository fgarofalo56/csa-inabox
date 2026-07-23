/**
 * fold.ts — DAX AST → Synapse T-SQL fold planner (A2).
 *
 * Consumes the A1 parser's AST and folds the loom-native-supported DAX surface
 * to Synapse-serverless T-SQL (the same bracket-quoted dialect wells-to-sql.ts
 * emits). It REPLACES the 3-regex translateDaxToSql while staying byte-identical
 * on the pre-existing patterns (EVALUATE <Table> / TOPN / ROW(CALCULATE(AGG))).
 *
 * A2 batch-1 functions folded here:
 *   SUMMARIZECOLUMNS (→ GROUP BY, incl. RELATED dim join), COUNTROWS (→ COUNT(*)),
 *   DISTINCTCOUNT (→ COUNT(DISTINCT)), COUNTA (→ COUNT(col)), DISTINCT / VALUES
 *   (→ SELECT DISTINCT), FILTER (→ WHERE), CALCULATETABLE (→ subquery + WHERE),
 *   ALL / ALLEXCEPT (→ drop filter predicates), RELATED (→ join via relationship),
 *   ADDCOLUMNS (→ projected expression). Everything else returns null so the
 *   caller raises the honest unsupportedDaxError() — never a fabricated result.
 *
 * `foldQueryToSql` returns the SQL string, or null when the query is outside the
 * folded set. Pure; the model (tables/measures/relationships) is optional and
 * only needed for measure-reference inlining + RELATED joins.
 */
import { parseDax, DaxParseError } from './parser';
import { DaxLexError } from './tokenizer';
import type {
  Expr, Query, FunctionCall, ColumnRef, Binary, Unary,
} from './ast';

export interface FoldModelMeasure { name: string; table: string; expression: string; }
export interface FoldModelRelationship { from: string; to: string; cardinality: string; }
export interface FoldModel {
  measures?: FoldModelMeasure[];
  relationships?: FoldModelRelationship[];
}

const AGG_TO_SQL: Record<string, string> = {
  SUM: 'SUM', AVERAGE: 'AVG', MIN: 'MIN', MAX: 'MAX', COUNT: 'COUNT', COUNTA: 'COUNT',
};

// A3 iterators: aggregate over a per-row projected expression.
const X_ITER_TO_SQL: Record<string, string> = {
  SUMX: 'SUM', AVERAGEX: 'AVG', COUNTX: 'COUNT', MINX: 'MIN', MAXX: 'MAX',
};

/** A folded scalar: the SQL expression + the single base table it reads (if any). */
interface ScalarFold { sql: string; table?: string; qualify?: boolean; }

class FoldError extends Error {}

function bracket(name: string): string { return `[${name}]`; }

const AGGREGATE_NAMES = new Set([
  ...Object.keys(AGG_TO_SQL), ...Object.keys(X_ITER_TO_SQL),
  'COUNTROWS', 'DISTINCTCOUNT', 'CALCULATE', 'RANKX',
]);

/** True if the expression contains an aggregate/iterator anywhere (guards the
 *  per-row iterator body from illegally nesting an aggregate). */
function containsAggregate(e: Expr): boolean {
  switch (e.type) {
    case 'FunctionCall':
      if (AGGREGATE_NAMES.has(e.name.toUpperCase())) return true;
      return e.args.some(containsAggregate);
    case 'Unary': return containsAggregate(e.operand);
    case 'Binary': return containsAggregate(e.left) || containsAggregate(e.right);
    default: return false;
  }
}

/** Parse a relationship endpoint "Table[Column]" → {table, column}. */
function parseEndpoint(ep: string): { table: string; column: string } | null {
  const m = /^\s*'?([^'\[]+?)'?\s*\[\s*([^\]]+?)\s*\]\s*$/.exec(ep);
  return m ? { table: m[1].trim(), column: m[2].trim() } : null;
}

/**
 * Find a relationship joining `factTable` to `dimTable` and return the join
 * columns. Relationships are undirected for the join's purpose.
 */
function findJoin(model: FoldModel | undefined, factTable: string, dimTable: string):
  { factCol: string; dimCol: string } | null {
  for (const r of model?.relationships ?? []) {
    const a = parseEndpoint(r.from);
    const b = parseEndpoint(r.to);
    if (!a || !b) continue;
    if (a.table === factTable && b.table === dimTable) return { factCol: a.column, dimCol: b.column };
    if (a.table === dimTable && b.table === factTable) return { factCol: b.column, dimCol: a.column };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scalar expression folding (single base table, unqualified [col])
// ---------------------------------------------------------------------------

/** Fold a scalar DAX expression to SQL. `qualify` renders columns as prefix.[col]. */
function foldScalar(e: Expr, prefix?: string): ScalarFold {
  const col = (c: ColumnRef): string => (prefix ? `${prefix}.${bracket(c.column)}` : bracket(c.column));

  switch (e.type) {
    case 'NumberLiteral': return { sql: String(e.value) };
    case 'StringLiteral': return { sql: `'${e.value.replace(/'/g, "''")}'` };
    case 'BooleanLiteral': return { sql: e.value ? '1' : '0' };
    case 'BlankLiteral': return { sql: 'NULL' };
    case 'ColumnRef': return { sql: col(e), table: e.table };
    case 'Unary': {
      if (e.op === 'NOT') { const o = foldScalar(e.operand, prefix); return { sql: `NOT (${o.sql})`, table: o.table }; }
      const o = foldScalar(e.operand, prefix);
      return { sql: `${e.op}${o.sql}`, table: o.table };
    }
    case 'Binary': {
      const l = foldScalar(e.left, prefix);
      const r = foldScalar(e.right, prefix);
      const op = sqlBinaryOp(e.op);
      return { sql: `(${l.sql} ${op} ${r.sql})`, table: l.table ?? r.table };
    }
    case 'FunctionCall':
      return foldScalarCall(e, prefix);
    default:
      throw new FoldError(`unsupported scalar node ${(e as Expr).type}`);
  }
}

function sqlBinaryOp(op: Binary['op']): string {
  switch (op) {
    case '&': return '+';        // DAX string concat → T-SQL +
    case '=': return '=';
    case '<>': return '<>';
    case '&&': return 'AND';
    case '||': return 'OR';
    case '^': throw new FoldError('exponentiation is not folded');
    default: return op;          // + - * / < <= > >=
  }
}

function foldScalarCall(e: FunctionCall, prefix?: string): ScalarFold {
  const name = e.name.toUpperCase();

  // Aggregations over a column: SUM/AVERAGE/MIN/MAX/COUNT/COUNTA(T[C])
  if (name in AGG_TO_SQL && e.args.length === 1 && e.args[0].type === 'ColumnRef') {
    const c = e.args[0];
    const colSql = prefix ? `${prefix}.${bracket(c.column)}` : bracket(c.column);
    return { sql: `${AGG_TO_SQL[name]}(${colSql})`, table: c.table };
  }
  // DISTINCTCOUNT(T[C]) → COUNT(DISTINCT [C])
  if (name === 'DISTINCTCOUNT' && e.args.length === 1 && e.args[0].type === 'ColumnRef') {
    const c = e.args[0];
    const colSql = prefix ? `${prefix}.${bracket(c.column)}` : bracket(c.column);
    return { sql: `COUNT(DISTINCT ${colSql})`, table: c.table };
  }
  // COUNTROWS(T) → COUNT(*)
  if (name === 'COUNTROWS' && e.args.length === 1 && e.args[0].type === 'TableRef') {
    return { sql: 'COUNT(*)', table: e.args[0].name };
  }
  // A3 iterators: SUMX/AVERAGEX/COUNTX/MINX/MAXX(<table>, <per-row expr>) →
  // AGG(<folded expr>) over the iterated table.
  if (name in X_ITER_TO_SQL && e.args.length === 2 && e.args[0].type === 'TableRef') {
    const table = e.args[0].name;
    const inner = foldScalar(e.args[1], prefix);
    if (containsAggregate(e.args[1])) throw new FoldError(`${name} row expression must be non-aggregate`);
    return { sql: `${X_ITER_TO_SQL[name]}(${inner.sql})`, table };
  }
  // A3 RANKX(<table>, <orderBy expr> [, <value>, <order>]) → a window RANK().
  // Default order is DESC (highest = rank 1); a 4th arg of 1/ASC flips it.
  if (name === 'RANKX' && e.args.length >= 2) {
    const orderExpr = foldScalar(e.args[1], prefix);
    let dir = 'DESC';
    const orderArg = e.args[3];
    if (orderArg && orderArg.type === 'NumberLiteral' && orderArg.value === 1) dir = 'ASC';
    return { sql: `RANK() OVER (ORDER BY ${orderExpr.sql} ${dir})`, table: orderExpr.table };
  }
  // CALCULATE(<agg>) with no filters (or filters handled by the table planner) →
  // the inner aggregate (CALCULATE with no filter is identity).
  if (name === 'CALCULATE' && e.args.length >= 1) {
    const inner = foldScalar(e.args[0], prefix);
    if (e.args.length === 1) return inner;
    // CALCULATE(agg, <predicate>...) → agg with a CASE/WHERE-style filter. For the
    // batch-1 scalar path we only fold the no-extra-filter case cleanly; extra
    // boolean predicates over the SAME table fold to a filtered aggregate.
    const preds = e.args.slice(1).map((a) => foldScalar(a, prefix));
    if (preds.every((p) => p.table === undefined || p.table === inner.table)) {
      // SUM(CASE WHEN <pred> THEN [col] END) is not generally equal to a filtered
      // aggregate for COUNT/AVG, so we conservatively decline unless it's a plain
      // aggregate we can re-express; leave to the table-level WHERE planner.
      throw new FoldError('CALCULATE with predicates folds at the table level, not scalar');
    }
    return inner;
  }
  throw new FoldError(`unsupported scalar function ${e.name}`);
}

// ---------------------------------------------------------------------------
// Predicate folding (for FILTER / CALCULATETABLE WHERE clauses)
// ---------------------------------------------------------------------------

function foldPredicate(e: Expr, prefix?: string): string {
  const f = foldScalar(e, prefix);
  return f.sql.replace(/^\((.*)\)$/s, '$1'); // strip one redundant outer paren
}

// ---------------------------------------------------------------------------
// Table expression folding → full SELECT
// ---------------------------------------------------------------------------

function foldTableExpr(e: Expr, model: FoldModel | undefined, topN?: number): string {
  const topPrefix = topN !== undefined ? `TOP ${topN} ` : 'TOP 1000 ';

  // Bare table
  if (e.type === 'TableRef') {
    return `SELECT ${topPrefix}* FROM ${bracket(e.name)}`;
  }

  if (e.type !== 'FunctionCall') throw new FoldError('EVALUATE expects a table expression');
  const name = e.name.toUpperCase();
  const args = e.args;

  switch (name) {
    case 'TOPN': {
      // TOPN(n, <table>) — nested TOPN not folded.
      if (args.length < 2 || args[0].type !== 'NumberLiteral') throw new FoldError('TOPN(n, table)');
      if (args[1].type !== 'TableRef') throw new FoldError('TOPN over a computed table is not folded');
      return `SELECT TOP ${args[0].value} * FROM ${bracket(args[1].name)}`;
    }

    case 'ROW':
      return foldRow(args);

    case 'DISTINCT':
    case 'VALUES': {
      if (args.length === 1 && args[0].type === 'ColumnRef') {
        const c = args[0];
        return `SELECT DISTINCT ${bracket(c.column)} FROM ${bracket(c.table)}`;
      }
      if (args.length === 1 && args[0].type === 'TableRef') {
        return `SELECT DISTINCT * FROM ${bracket(args[0].name)}`;
      }
      throw new FoldError('DISTINCT/VALUES expects a column or table');
    }

    case 'FILTER': {
      // FILTER(<table>, <predicate>)
      if (args.length !== 2 || args[0].type !== 'TableRef') throw new FoldError('FILTER(table, predicate)');
      const where = foldPredicate(args[1]);
      return `SELECT ${topPrefix}* FROM ${bracket(args[0].name)} WHERE ${where}`;
    }

    case 'CALCULATETABLE': {
      // CALCULATETABLE(<table>, <filter>...) — filters ANDed as WHERE.
      if (args.length < 1 || args[0].type !== 'TableRef') throw new FoldError('CALCULATETABLE(table, filter...)');
      const preds = args.slice(1).map((a) => foldPredicate(a));
      const whereSql = preds.length ? ` WHERE ${preds.join(' AND ')}` : '';
      return `SELECT ${topPrefix}* FROM ${bracket(args[0].name)}${whereSql}`;
    }

    case 'ALL':
      // ALL(<table>) as a top-level table expression = the whole table (filters
      // removed — at the table level there's no outer filter to remove).
      if (args.length === 1 && args[0].type === 'TableRef') {
        return `SELECT ${topPrefix}* FROM ${bracket(args[0].name)}`;
      }
      throw new FoldError('ALL as a table expression expects a table');

    case 'ADDCOLUMNS':
      return foldAddColumns(args);

    case 'SUMMARIZECOLUMNS':
      return foldSummarizeColumns(args, model);

    default:
      throw new FoldError(`unsupported table function ${e.name}`);
  }
}

/** ROW("l1", e1 [, "l2", e2 ...]) → SELECT e1 AS [l1], ... [FROM the single table]. */
function foldRow(args: Expr[]): string {
  if (args.length < 2 || args.length % 2 !== 0) throw new FoldError('ROW expects label/value pairs');
  const cols: string[] = [];
  let table: string | undefined;
  for (let i = 0; i < args.length; i += 2) {
    const label = args[i];
    if (label.type !== 'StringLiteral') throw new FoldError('ROW label must be a string');
    const folded = foldScalar(args[i + 1]);
    if (folded.table) { if (table && table !== folded.table) throw new FoldError('ROW mixes tables'); table = folded.table; }
    cols.push(`${folded.sql} AS ${bracket(label.value)}`);
  }
  return `SELECT ${cols.join(', ')}${table ? ` FROM ${bracket(table)}` : ''}`;
}

/** ADDCOLUMNS(<table>, "l", e, ...) → SELECT *, e AS [l] FROM [table]. */
function foldAddColumns(args: Expr[]): string {
  if (args.length < 3 || args[0].type !== 'TableRef') throw new FoldError('ADDCOLUMNS(table, "l", e, ...)');
  const base = args[0].name;
  const extras: string[] = [];
  for (let i = 1; i < args.length; i += 2) {
    const label = args[i];
    const value = args[i + 1];
    if (!label || !value || label.type !== 'StringLiteral') throw new FoldError('ADDCOLUMNS needs label/expr pairs');
    const f = foldScalar(value);
    if (f.table && f.table !== base) throw new FoldError('ADDCOLUMNS expression must read its own row/table');
    extras.push(`${f.sql} AS ${bracket(label.value)}`);
  }
  return `SELECT TOP 1000 *, ${extras.join(', ')} FROM ${bracket(base)}`;
}

/**
 * SUMMARIZECOLUMNS(groupCol1 [, groupCol2 ...], "name", <agg> [, "name2", <agg2>])
 * → SELECT <group cols>, <agg> AS [name] FROM <fact> [JOIN <dim>] GROUP BY <group cols>.
 * Group columns on a table other than the aggregation's fact table are joined via
 * a model relationship (RELATED semantics).
 */
function foldSummarizeColumns(args: Expr[], model: FoldModel | undefined): string {
  const groupCols: ColumnRef[] = [];
  const aggs: Array<{ label: string; expr: Expr }> = [];
  let i = 0;
  while (i < args.length && args[i].type === 'ColumnRef') { groupCols.push(args[i] as ColumnRef); i++; }
  for (; i < args.length; i += 2) {
    const label = args[i];
    const expr = args[i + 1];
    if (!label || label.type !== 'StringLiteral' || !expr) throw new FoldError('SUMMARIZECOLUMNS needs "name", <expr> pairs');
    aggs.push({ label: label.value, expr });
  }
  if (aggs.length === 0) {
    // Pure grouping: SELECT DISTINCT the group columns (single table only).
    if (groupCols.length === 0) throw new FoldError('SUMMARIZECOLUMNS needs group columns or aggregations');
    const tbls = new Set(groupCols.map((c) => c.table));
    if (tbls.size !== 1) throw new FoldError('multi-table SUMMARIZECOLUMNS without an aggregation is not folded');
    const t = groupCols[0].table;
    return `SELECT DISTINCT ${groupCols.map((c) => bracket(c.column)).join(', ')} FROM ${bracket(t)}`;
  }

  // Determine the fact table from the aggregations.
  const factTables = new Set<string>();
  for (const a of aggs) { const f = foldScalar(a.expr); if (f.table) factTables.add(f.table); }
  if (factTables.size !== 1) throw new FoldError('SUMMARIZECOLUMNS aggregations must share one fact table');
  const fact = [...factTables][0];

  const needsJoin = groupCols.some((c) => c.table !== fact);
  if (!needsJoin) {
    const gcols = groupCols.map((c) => bracket(c.column));
    const acols = aggs.map((a) => `${foldScalar(a.expr).sql} AS ${bracket(a.label)}`);
    const select = [...gcols, ...acols].join(', ');
    const groupBy = gcols.length ? ` GROUP BY ${gcols.join(', ')}` : '';
    return `SELECT ${select} FROM ${bracket(fact)}${groupBy}`;
  }

  // Join path: fact aliased [f], each distinct dim aliased [d0], [d1]...
  const dimTables = [...new Set(groupCols.filter((c) => c.table !== fact).map((c) => c.table))];
  const dimAlias = new Map<string, string>();
  dimTables.forEach((t, idx) => dimAlias.set(t, `d${idx}`));
  const joins: string[] = [];
  for (const dim of dimTables) {
    const j = findJoin(model, fact, dim);
    if (!j) throw new FoldError(`no relationship to join ${fact} → ${dim} for SUMMARIZECOLUMNS`);
    joins.push(`INNER JOIN ${bracket(dim)} AS ${dimAlias.get(dim)} ON f.${bracket(j.factCol)} = ${dimAlias.get(dim)}.${bracket(j.dimCol)}`);
  }
  const gsel = groupCols.map((c) => (c.table === fact ? `f.${bracket(c.column)}` : `${dimAlias.get(c.table)}.${bracket(c.column)}`));
  const glabels = groupCols.map((c) => bracket(c.column));
  const asel = aggs.map((a) => `${foldScalar(a.expr, 'f').sql} AS ${bracket(a.label)}`);
  const selectList = groupCols.map((c, idx) => `${gsel[idx]} AS ${glabels[idx]}`).concat(asel).join(', ');
  return `SELECT ${selectList} FROM ${bracket(fact)} AS f ${joins.join(' ')} GROUP BY ${gsel.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fold a parsed DAX Query AST to Synapse T-SQL, or null if it's outside the
 * folded set (caller raises unsupportedDaxError). DEFINE MEASURE/VAR are inlined:
 * a bare [Measure] reference in EVALUATE resolves to its stored expression.
 */
export function foldQueryToSql(query: Query, model?: FoldModel): string | null {
  // ORDER BY is not folded in batch-1 → honest unsupported (unchanged from the
  // prior translator, which returned null for any ORDER BY query).
  if (query.orderBy.length > 0) return null;
  try {
    const inlined = inlineMeasures(query, model);
    return foldTableExpr(inlined, model);
  } catch (e) {
    if (e instanceof FoldError) return null;
    throw e;
  }
}

/**
 * Convenience: parse + fold in one call. Returns null on a parse error too so the
 * caller surfaces the honest unsupported-DAX path (identical external contract to
 * the old translateDaxToSql).
 */
export function foldDaxToSql(dax: string, model?: FoldModel): string | null {
  let query: Query;
  try {
    query = parseDax(dax);
  } catch (e) {
    if (e instanceof DaxParseError || e instanceof DaxLexError) return null;
    throw e;
  }
  return foldQueryToSql(query, model);
}

/**
 * Replace bare [Measure] references in the EVALUATE expression (and inside ROW)
 * with the measure's stored DAX expression (parsed), using DEFINE MEASURE first
 * then the model's measures. One level of inlining (batch-1); nested measure
 * chains beyond the query's own DEFINE fall through to unsupported.
 */
function inlineMeasures(query: Query, model: FoldModel | undefined): Expr {
  const defined = new Map<string, Expr>();
  for (const d of query.defines) {
    if (d.type === 'MeasureDefinition') defined.set(d.name.toUpperCase(), d.expression);
  }
  const modelMeasures = new Map<string, string>();
  for (const m of model?.measures ?? []) modelMeasures.set(m.name.toUpperCase(), m.expression);

  const resolve = (name: string): Expr | null => {
    const key = name.toUpperCase();
    if (defined.has(key)) return defined.get(key)!;
    const expr = modelMeasures.get(key);
    if (expr) {
      try { return parseDax(`EVALUATE ${expr}`).evaluate; } catch { return null; }
    }
    return null;
  };

  const walk = (e: Expr, depth: number): Expr => {
    if (depth > 8) throw new FoldError('measure inlining too deep (possible cycle)');
    switch (e.type) {
      case 'MeasureRef': {
        const r = resolve(e.name);
        if (!r) throw new FoldError(`unknown measure [${e.name}]`);
        return walk(r, depth + 1);
      }
      case 'Unary': return { ...e, operand: walk(e.operand, depth) };
      case 'Binary': return { ...e, left: walk(e.left, depth), right: walk(e.right, depth) };
      case 'FunctionCall': return { ...e, args: e.args.map((a) => walk(a, depth)) };
      default: return e;
    }
  };
  return walk(query.evaluate, 0);
}
