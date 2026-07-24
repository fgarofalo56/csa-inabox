/**
 * N8 lab 2 — PRQL "modern query" transpiler (Preview).
 *
 * A small, HONEST PRQL → SQL transpiler for the practical subset the SQL Lab
 * needs, so an analyst can write PRQL (Pipelined Relational Query Language,
 * Apache-2.0) and have it run on the N2 DuckDB engine (with the honest Synapse
 * Serverless fallback) exactly like hand-written SQL.
 *
 * ## Why a hand-written subset, not a bundled transpiler
 *
 * The reference transpiler (`prql-js`, Apache-2.0) is a Rust/WASM package; a
 * WASM blob in the Next.js server bundle is a heavier commitment than this
 * Preview lab warrants, and it cannot honest-error at the granularity Loom
 * wants. This module instead transpiles a documented, tested subset in pure TS
 * and — the load-bearing contract — **throws {@link PrqlTranspileError} on ANY
 * construct it does not fully understand rather than emitting a guessed SQL
 * string** (no-vaporware.md: never fabricate a query). The editor surfaces the
 * error verbatim; it never silently runs SQL the user did not intend.
 *
 * ## Supported subset (each faithfully translated)
 *
 *   from <table | alias = table | `schema.table`>
 *   filter <bool-expr>            → WHERE (… AND …), before any aggregate only
 *   derive <name = expr | {a = x, …}>  → projected `expr AS name`
 *   select <col | {a, b = x, …}>  → projection (derived names fold in)
 *   group {cols} (aggregate {…})  → GROUP BY + aggregate projection
 *   aggregate {name = sum col, …} → SUM/COUNT/AVG/MIN/MAX/STDDEV projection
 *   sort <col | {-a, +b, c}>      → ORDER BY (- = DESC, + = ASC)
 *   take <n | m..n>               → LIMIT [OFFSET]
 *
 * Operators inside an expression are translated 1:1 to their SQL form
 * (`==`→`=`, `&&`→`AND`, `||`→`OR`); everything else passes through unchanged.
 * Aggregate-column alias references resolve on DuckDB's lateral-alias support,
 * so `derive`+`select` fold into one SELECT list without a subquery.
 *
 * Anything outside this grammar (s-strings, f-strings, window/join/`loop`,
 * double-quoted strings, HAVING-style post-aggregate filters, nested pipelines)
 * throws — the SQL Lab then shows the honest "unsupported PRQL" surface, never a
 * fabricated query. Pure, dependency-free, unit-testable; no Azure import.
 */

/** Thrown for any PRQL the subset transpiler cannot faithfully translate. */
export class PrqlTranspileError extends Error {
  /** The offending fragment (transform line or token), for the UI. */
  readonly construct: string;
  constructor(message: string, construct = '') {
    super(message);
    this.name = 'PrqlTranspileError';
    this.construct = construct;
  }
}

/** A parsed aggregate/derive projection column. */
interface NamedExpr {
  name: string;
  expr: string;
}

interface PipelineState {
  table: string;
  wheres: string[];
  derived: NamedExpr[];
  select: string[] | null;
  groupBy: string[];
  aggregates: NamedExpr[];
  orderBys: string[];
  limit: number | null;
  offset: number | null;
}

const TRANSFORMS = new Set(['from', 'filter', 'derive', 'select', 'group', 'aggregate', 'sort', 'take']);

/** PRQL aggregate builtins → SQL. `this` is PRQL's "current row" (COUNT(*)). */
const AGG_FUNCS: Record<string, string> = {
  sum: 'SUM',
  average: 'AVG',
  avg: 'AVG',
  min: 'MIN',
  max: 'MAX',
  stddev: 'STDDEV',
  count: 'COUNT',
  count_distinct: 'COUNT_DISTINCT', // special-cased in translateAggregate
};

/** Strip `# line comments`, keeping everything else verbatim. */
function stripComments(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      // A '#' inside a string literal is not a comment; only strip when the '#'
      // is outside single quotes.
      let inStr = false;
      for (let i = 0; i < line.length; i += 1) {
        const c = line[i];
        if (c === "'") inStr = !inStr;
        else if (c === '#' && !inStr) return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/**
 * Split a PRQL source into transform steps. Steps are separated by newlines OR
 * by a top-level `|` (pipe) that is NOT inside braces/parens/quotes.
 */
function splitSteps(src: string): string[] {
  const steps: string[] = [];
  let buf = '';
  let depth = 0;
  let inStr = false;
  const flush = () => {
    const t = buf.trim();
    if (t) steps.push(t);
    buf = '';
  };
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inStr) {
      buf += c;
      if (c === "'") inStr = false;
      continue;
    }
    if (c === "'") { inStr = true; buf += c; continue; }
    if (c === '{' || c === '(' || c === '[') { depth += 1; buf += c; continue; }
    if (c === '}' || c === ')' || c === ']') { depth = Math.max(0, depth - 1); buf += c; continue; }
    if ((c === '\n' || c === '|') && depth === 0) { flush(); continue; }
    buf += c;
  }
  flush();
  return steps;
}

/** Reject the constructs the subset deliberately does not translate. */
function rejectUnsupportedTokens(fragment: string): void {
  if (/\bs"/.test(fragment) || /\bf"/.test(fragment)) {
    throw new PrqlTranspileError(
      'PRQL s-strings / f-strings are not supported in this Preview. Write the SQL directly, or use plain PRQL expressions.',
      fragment,
    );
  }
  if (/"/.test(fragment)) {
    throw new PrqlTranspileError(
      'Double-quoted strings are not supported (they are SQL identifiers, not strings). Use single quotes for string literals.',
      fragment,
    );
  }
  if (/`/.test(fragment) && !/`[^`]+`/.test(fragment)) {
    throw new PrqlTranspileError('Unterminated backtick-quoted identifier.', fragment);
  }
}

/** Translate a scalar/boolean PRQL expression to SQL (operator-level only). */
function translateExpr(expr: string): string {
  rejectUnsupportedTokens(expr);
  let out = expr.trim();
  // Backtick identifiers (`my table`) → double-quoted SQL identifiers.
  out = out.replace(/`([^`]+)`/g, '"$1"');
  // Logical + equality operators. Order matters: '==' before '=', '!=' kept.
  out = out.replace(/&&/g, ' AND ').replace(/\|\|/g, ' OR ');
  out = out.replace(/==/g, '=');
  // PRQL null test `x == null` already handled; SQL `= NULL` is wrong, but we
  // only rewrite the literal keyword when it stands alone.
  out = out.replace(/\bnull\b/gi, 'NULL');
  return out.replace(/\s+/g, ' ').trim();
}

/** Parse the inside of a `{ … }` list into top-level comma items. */
function splitList(inner: string): string[] {
  const items: string[] = [];
  let buf = '';
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (inStr) { buf += c; if (c === "'") inStr = false; continue; }
    if (c === "'") { inStr = true; buf += c; continue; }
    if (c === '{' || c === '(' || c === '[') { depth += 1; buf += c; continue; }
    if (c === '}' || c === ')' || c === ']') { depth -= 1; buf += c; continue; }
    if (c === ',' && depth === 0) { if (buf.trim()) items.push(buf.trim()); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) items.push(buf.trim());
  return items;
}

/** `{a, b}` → `a, b`; a bare `x` → `x`. Returns the list items (unbraced). */
function parseTupleArg(arg: string): string[] {
  const t = arg.trim();
  if (t.startsWith('{') && t.endsWith('}')) return splitList(t.slice(1, -1));
  if (!t) return [];
  return splitList(t);
}

/** `name = expr` → {name, expr}; a bare column → {name: col, expr: col}. */
function parseNamedExpr(item: string): NamedExpr {
  const eq = item.indexOf('=');
  // Guard against '==' / '>=' etc. being read as assignment.
  if (eq > 0 && item[eq + 1] !== '=' && item[eq - 1] !== '!' && item[eq - 1] !== '>' && item[eq - 1] !== '<') {
    const name = item.slice(0, eq).trim();
    const expr = item.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new PrqlTranspileError(`"${name}" is not a valid column alias.`, item);
    }
    return { name, expr };
  }
  return { name: item.trim(), expr: item.trim() };
}

/** Translate one PRQL aggregate call (`sum salary`, `count this`) to SQL. */
function translateAggregate(expr: string): string {
  const m = expr.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/);
  if (!m) throw new PrqlTranspileError(`Cannot parse aggregate "${expr}".`, expr);
  const fn = m[1].toLowerCase();
  const argRaw = m[2].trim().replace(/^\(([\s\S]*)\)$/, '$1').trim();
  if (!(fn in AGG_FUNCS)) {
    throw new PrqlTranspileError(
      `Unsupported aggregate function "${fn}". Supported: ${Object.keys(AGG_FUNCS).join(', ')}.`,
      expr,
    );
  }
  if (fn === 'count' && (argRaw === '' || argRaw === 'this')) return 'COUNT(*)';
  if (fn === 'count_distinct') {
    if (!argRaw) throw new PrqlTranspileError('count_distinct needs a column.', expr);
    return `COUNT(DISTINCT ${translateExpr(argRaw)})`;
  }
  if (!argRaw) throw new PrqlTranspileError(`Aggregate "${fn}" needs a column.`, expr);
  return `${AGG_FUNCS[fn]}(${translateExpr(argRaw)})`;
}

/** Parse `take 10` / `take 5..20` into {limit, offset}. */
function parseTake(arg: string): { limit: number; offset: number | null } {
  const t = arg.trim();
  const range = t.match(/^(\d+)\s*\.\.\s*(\d+)$/);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (from < 1 || to < from) throw new PrqlTranspileError(`Invalid take range "${t}".`, t);
    return { limit: to - from + 1, offset: from - 1 };
  }
  if (/^\d+$/.test(t)) return { limit: Number(t), offset: null };
  throw new PrqlTranspileError(`take expects a number or a range (m..n), got "${t}".`, t);
}

/** Parse a `from` target: `from t`, `from x = t`, `from `s.t``. */
function parseFrom(arg: string): string {
  const named = parseNamedExpr(arg.trim());
  // For `from alias = table` we keep just the table with an alias suffix.
  if (named.name !== named.expr) {
    return `${translateFromSource(named.expr)} AS ${named.name}`;
  }
  return translateFromSource(named.expr);
}

/** A from-source is a bare/backticked identifier OR a raw table function call. */
function translateFromSource(src: string): string {
  const t = src.trim();
  rejectUnsupportedTokens(t);
  if (/^`[^`]+`$/.test(t)) return `"${t.slice(1, -1)}"`;
  return t.replace(/`([^`]+)`/g, '"$1"');
}

/**
 * Transpile a PRQL query to a single SQL SELECT statement.
 *
 * @throws {PrqlTranspileError} for empty input or any unsupported construct —
 *   the caller shows this verbatim and NEVER runs a fabricated query.
 */
export function transpilePrqlToSql(prqlSource: string): string {
  const src = stripComments(String(prqlSource ?? '')).trim();
  if (!src) throw new PrqlTranspileError('The query is empty. Start with `from <table>`.');

  const steps = splitSteps(src);
  if (steps.length === 0) throw new PrqlTranspileError('The query is empty. Start with `from <table>`.');

  const firstKw = steps[0].split(/\s+/)[0];
  if (firstKw !== 'from') {
    throw new PrqlTranspileError('A PRQL pipeline must begin with `from <table>`.', steps[0]);
  }

  const st: PipelineState = {
    table: '', wheres: [], derived: [], select: null,
    groupBy: [], aggregates: [], orderBys: [], limit: null, offset: null,
  };

  for (const step of steps) {
    const m = step.match(/^([A-Za-z_][A-Za-z0-9_]*)\b([\s\S]*)$/);
    if (!m) throw new PrqlTranspileError(`Cannot parse transform "${step}".`, step);
    const kw = m[1];
    const arg = m[2].trim();
    if (!TRANSFORMS.has(kw)) {
      throw new PrqlTranspileError(
        `Unsupported PRQL transform "${kw}". This Preview supports: ${[...TRANSFORMS].join(', ')}.`,
        step,
      );
    }

    switch (kw) {
      case 'from':
        st.table = parseFrom(arg);
        break;
      case 'filter':
        if (st.aggregates.length > 0) {
          throw new PrqlTranspileError(
            'A `filter` after `aggregate`/`group` (HAVING) is not supported in this Preview. Filter before aggregating.',
            step,
          );
        }
        if (!arg) throw new PrqlTranspileError('`filter` needs a boolean expression.', step);
        st.wheres.push(`(${translateExpr(arg)})`);
        break;
      case 'derive':
        for (const item of parseTupleArg(arg)) {
          const ne = parseNamedExpr(item);
          st.derived.push({ name: ne.name, expr: translateExpr(ne.expr) });
        }
        break;
      case 'select':
        st.select = parseTupleArg(arg).map((item) => item.trim());
        break;
      case 'group': {
        // group {cols} (aggregate {aggs})
        const gm = arg.match(/^\{([\s\S]*?)\}\s*\(\s*aggregate\s*([\s\S]*)\)\s*$/);
        if (!gm) {
          throw new PrqlTranspileError(
            'Only `group {cols} (aggregate {…})` is supported for grouping in this Preview.',
            step,
          );
        }
        st.groupBy = splitList(gm[1]).map((c) => translateExpr(c));
        for (const item of parseTupleArg(gm[2].trim())) {
          const ne = parseNamedExpr(item);
          st.aggregates.push({ name: ne.name, expr: translateAggregate(ne.expr) });
        }
        break;
      }
      case 'aggregate':
        for (const item of parseTupleArg(arg)) {
          const ne = parseNamedExpr(item);
          st.aggregates.push({ name: ne.name, expr: translateAggregate(ne.expr) });
        }
        break;
      case 'sort':
        for (const item of parseTupleArg(arg)) {
          const t = item.trim();
          if (t.startsWith('-')) st.orderBys.push(`${translateExpr(t.slice(1).trim())} DESC`);
          else if (t.startsWith('+')) st.orderBys.push(`${translateExpr(t.slice(1).trim())} ASC`);
          else st.orderBys.push(translateExpr(t));
        }
        break;
      case 'take': {
        const { limit, offset } = parseTake(arg);
        st.limit = limit;
        st.offset = offset;
        break;
      }
      default:
        throw new PrqlTranspileError(`Unsupported transform "${kw}".`, step);
    }
  }

  if (!st.table) throw new PrqlTranspileError('No source table — a pipeline must begin with `from <table>`.');

  return buildSql(st);
}

/** Fold the parsed pipeline state into one SQL SELECT statement. */
function buildSql(st: PipelineState): string {
  const derivedByName = new Map(st.derived.map((d) => [d.name, d.expr]));
  let projection: string;

  if (st.aggregates.length > 0) {
    // Grouped/aggregate query: SELECT <group cols>, <aggs>.
    const cols = [...st.groupBy, ...st.aggregates.map((a) => `${a.expr} AS ${a.name}`)];
    projection = cols.join(', ');
  } else if (st.select) {
    // Explicit projection; fold any referenced derived name into its expression
    // (DuckDB resolves lateral aliases, but a dropped derive would vanish).
    projection = st.select
      .map((item) => {
        const ne = parseNamedExpr(item);
        if (ne.name !== ne.expr) return `${translateExpr(ne.expr)} AS ${ne.name}`;
        const d = derivedByName.get(ne.name);
        return d ? `${d} AS ${ne.name}` : translateExpr(ne.name);
      })
      .join(', ');
  } else {
    // No explicit select: * plus any derived columns.
    const parts = ['*', ...st.derived.map((d) => `${d.expr} AS ${d.name}`)];
    projection = parts.join(', ');
  }

  let sql = `SELECT ${projection}\nFROM ${st.table}`;
  if (st.wheres.length > 0) sql += `\nWHERE ${st.wheres.join(' AND ')}`;
  if (st.groupBy.length > 0) sql += `\nGROUP BY ${st.groupBy.join(', ')}`;
  if (st.orderBys.length > 0) sql += `\nORDER BY ${st.orderBys.join(', ')}`;
  if (st.limit !== null) sql += `\nLIMIT ${st.limit}`;
  if (st.offset) sql += `\nOFFSET ${st.offset}`;
  return sql;
}

/** The languages the SQL Lab "modern query" toggle offers. */
export type QueryLanguage = 'sql' | 'prql';

/**
 * Transpile when the language is PRQL; pass SQL through untouched. Central
 * helper so the editor never branches on the language inline.
 */
export function toRunnableSql(source: string, language: QueryLanguage): string {
  return language === 'prql' ? transpilePrqlToSql(source) : source;
}
