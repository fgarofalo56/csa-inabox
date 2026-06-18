/**
 * Visual Query compiler — Power-Query-style canvas graph → SQL.
 *
 * Pure, side-effect-free TypeScript. No React, no fetch. The visual query
 * canvas (visual-query-canvas.tsx) feeds its { nodes, edges }-derived graph in
 * and gets a complete SQL string out, suitable for the existing per-engine
 * /query routes (Synapse Dedicated / Serverless TDS, Databricks Statement
 * Execution).
 *
 * Parity target: the Microsoft Fabric Warehouse "Visual query editor"
 * (learn.microsoft.com/fabric/data-warehouse/visual-query-editor), which is a
 * Power Query diagram view: drag tables onto a canvas, add Applied Steps
 * (Filter rows, Choose columns, Keep top rows, Group by) and Merge (JOIN) two
 * query chains. "View SQL" shows the generated T-SQL. Databricks has no no-code
 * query canvas, so the same surface compiles to Spark SQL there (per
 * ui-parity.md — match Fabric capabilities across all backends).
 *
 * Why this exists (no-freeform-config.md): operators build every transform
 * through guided controls (column checklists, group-by pickers, aggregate
 * function dropdowns, join-kind + key pickers). The ONLY freeform slot is the
 * Filter step's single WHERE expression box — the explicitly-allowed 1:1
 * builder exception, mirroring the ASA SAQL compiler's WHERE/HAVING/JOIN-ON
 * slots. The whole query is never hand-edited; it is always generated here so
 * the canvas graph stays the single source of truth.
 */

// ============================================================
// Canonical graph model (shared with the canvas, which builds it from React
// Flow nodes + edges). Kept here so the compiler has zero dependency on the
// React component file.
// ============================================================

export type SqlDialect = 'tsql' | 'sparksql';

export type VqJoinKind =
  | 'INNER'
  | 'LEFT OUTER'
  | 'RIGHT OUTER'
  | 'FULL OUTER'
  | 'LEFT ANTI'
  | 'RIGHT ANTI';

export type VqAggFunc = 'SUM' | 'AVG' | 'COUNT' | 'MIN' | 'MAX' | 'COUNT_DISTINCT';

export type VqStepKind =
  | 'source'
  | 'filter'
  | 'select-columns'
  | 'keep-top-rows'
  | 'group-by'
  | 'sort'
  | 'join'
  // Wave-3 Warp transform-builder steps. All compile to SQL via the same pure
  // engine; every input is a guided control (column pickers, type dropdowns)
  // except the one allowed 1:1 expression slot per derive column.
  | 'derive'
  | 'rename'
  | 'cast'
  | 'dedup'
  | 'union'
  | 'sink';

export type VqSortDir = 'ASC' | 'DESC';

/** A computed/derived column: name + a single SQL expression (the 1:1 builder slot). */
export interface VqDeriveColumn {
  /** Output column name — a controlled text field, not freeform SQL. */
  name: string;
  /** The expression, e.g. `[unit_price] * [quantity]`. The allowed freeform slot. */
  expression: string;
}

/** A column rename mapping (controlled pickers both sides). */
export interface VqRenameMap {
  /** Source column name (picker). */
  from: string;
  /** New column name (controlled text). */
  to: string;
}

/** Common SQL target types for a CAST step — a controlled dropdown, never freeform. */
export type VqCastType =
  | 'INT'
  | 'BIGINT'
  | 'FLOAT'
  | 'DECIMAL(18,2)'
  | 'VARCHAR(4000)'
  | 'STRING'
  | 'DATE'
  | 'DATETIME2'
  | 'TIMESTAMP'
  | 'BOOLEAN';

export interface VqCastSpec {
  /** Column to cast (picker). */
  field: string;
  /** Target type (dropdown). */
  to: VqCastType;
}

export const VQ_CAST_TYPES_TSQL: VqCastType[] = [
  'INT', 'BIGINT', 'FLOAT', 'DECIMAL(18,2)', 'VARCHAR(4000)', 'DATE', 'DATETIME2',
];
export const VQ_CAST_TYPES_SPARK: VqCastType[] = [
  'INT', 'BIGINT', 'FLOAT', 'DECIMAL(18,2)', 'STRING', 'DATE', 'TIMESTAMP', 'BOOLEAN',
];

/** A Warp sink target — where the transform output lands. */
export type VqSinkMode = 'view' | 'table';

export interface VqSinkConfig {
  /** Target schema (optional). */
  schema?: string;
  /** Target table/view name. */
  table?: string;
  /** Materialize as a table (CTAS) or a view. */
  mode?: VqSinkMode;
}

export interface VqSortKey {
  /** Column name — a controlled picker, not freeform SQL. */
  field: string;
  dir: VqSortDir;
}

export interface VqAggSpec {
  func: VqAggFunc;
  /** Column name. Ignored / treated as '*' for plain COUNT. */
  field: string;
  alias: string;
}

export interface VqNode {
  id: string;
  kind: VqStepKind;
  /** Ids of the upstream node(s). source = []; most steps = [one]; join = [left, right]. */
  inputs: string[];

  // source
  schema?: string;
  table?: string;

  // filter ── the one allowed 1:1 freeform slot (WHERE expression)
  whereExpression?: string;

  // select-columns
  columns?: string[];

  // keep-top-rows
  topN?: number;

  // group-by / aggregate
  groupBy?: string[];
  aggregates?: VqAggSpec[];

  // sort / order by — controlled column + direction pickers (no freeform SQL)
  sortKeys?: VqSortKey[];

  // join
  joinKind?: VqJoinKind;
  leftKey?: string; // controlled picker — a column name, not freeform SQL
  rightKey?: string; // controlled picker — a column name, not freeform SQL

  // derive — add computed columns (each is name + one SQL expression slot)
  derived?: VqDeriveColumn[];

  // rename — column rename mappings (controlled pickers)
  renames?: VqRenameMap[];

  // cast — change a column's type (controlled type dropdown)
  casts?: VqCastSpec[];

  // dedup — DISTINCT, optionally keyed (controlled column checklist)
  dedupKeys?: string[];

  // union — append two input chains (UNION ALL by default)
  unionAll?: boolean;

  // sink — the transform target (CTAS table or view)
  sink?: VqSinkConfig;
}

export interface VqGraph {
  nodes: VqNode[];
  /** Id of the output node. Defaults to the single leaf (a node no other node consumes). */
  outputId?: string;
}

export const VQ_HEADER =
  '-- Generated by CSA Loom Visual Query Editor — edit the steps on the canvas, not this text.';

export const VQ_JOIN_KINDS: VqJoinKind[] = [
  'INNER',
  'LEFT OUTER',
  'RIGHT OUTER',
  'FULL OUTER',
  'LEFT ANTI',
  'RIGHT ANTI',
];

export const VQ_AGG_FUNCS: VqAggFunc[] = ['SUM', 'AVG', 'COUNT', 'MIN', 'MAX', 'COUNT_DISTINCT'];

export const VQ_SORT_DIRS: VqSortDir[] = ['ASC', 'DESC'];

// ============================================================
// Quoting helpers (dialect-aware)
// ============================================================

/** Quote a single identifier for the dialect: [name] (T-SQL) or `name` (Spark SQL). */
function quoteId(name: string, dialect: SqlDialect): string {
  const clean = (name ?? '').toString().trim();
  if (!clean) return dialect === 'tsql' ? '[col]' : '`col`';
  if (dialect === 'tsql') return `[${clean.replace(/[[\]]/g, '')}]`;
  return `\`${clean.replace(/`/g, '')}\``;
}

/** Fully-qualified source reference: [schema].[table] or `schema`.`table` (bare table if no schema). */
function sourceRef(node: VqNode, dialect: SqlDialect): string {
  const t = quoteId(node.table || 'table', dialect);
  if (node.schema && node.schema.trim()) {
    return `${quoteId(node.schema, dialect)}.${t}`;
  }
  return t;
}

/** A single aggregate expression, e.g. SUM([amount]) AS [total_amount]. */
function aggExpr(a: VqAggSpec, dialect: SqlDialect): string {
  const alias = (a.alias || `${a.func.toLowerCase()}_${(a.field || 'all').replace(/[^A-Za-z0-9_]/g, '')}`).trim();
  const aliasSql = quoteId(alias, dialect);
  if (a.func === 'COUNT' && (!a.field || a.field === '*')) {
    return `COUNT(*) AS ${aliasSql}`;
  }
  if (a.func === 'COUNT_DISTINCT') {
    return `COUNT(DISTINCT ${quoteId(a.field || '*', dialect)}) AS ${aliasSql}`;
  }
  return `${a.func}(${quoteId(a.field || '*', dialect)}) AS ${aliasSql}`;
}

// ============================================================
// Compile one node into the body of its CTE (without the wrapping CTE name).
// `inputRef(id)` resolves an upstream node id to the SQL reference for it (a
// CTE name).
// ============================================================

function compileNodeBody(
  node: VqNode,
  inputRef: (id: string) => string,
  dialect: SqlDialect,
): string {
  switch (node.kind) {
    case 'source':
      return `SELECT * FROM ${sourceRef(node, dialect)}`;

    case 'filter': {
      const from = inputRef(node.inputs[0]);
      const where = (node.whereExpression || '').trim();
      return `SELECT * FROM ${from}${where ? `\nWHERE ${where}` : ''}`;
    }

    case 'select-columns': {
      const from = inputRef(node.inputs[0]);
      const cols = (node.columns || []).filter(Boolean);
      const list = cols.length ? cols.map((c) => quoteId(c, dialect)).join(', ') : '*';
      return `SELECT ${list} FROM ${from}`;
    }

    case 'keep-top-rows': {
      const from = inputRef(node.inputs[0]);
      const n = Math.max(0, Math.floor(node.topN ?? 100));
      if (dialect === 'tsql') return `SELECT TOP (${n}) * FROM ${from}`;
      return `SELECT * FROM ${from} LIMIT ${n}`;
    }

    case 'group-by': {
      const from = inputRef(node.inputs[0]);
      const groups = (node.groupBy || []).filter(Boolean);
      const aggs = (node.aggregates || []).filter((a) => a && a.func);
      const selectParts = [
        ...groups.map((g) => quoteId(g, dialect)),
        ...aggs.map((a) => aggExpr(a, dialect)),
      ];
      const select = selectParts.length ? selectParts.join(', ') : '*';
      const groupClause = groups.length
        ? `\nGROUP BY ${groups.map((g) => quoteId(g, dialect)).join(', ')}`
        : '';
      return `SELECT ${select} FROM ${from}${groupClause}`;
    }

    case 'sort': {
      const from = inputRef(node.inputs[0]);
      const keys = (node.sortKeys || []).filter((k) => k && k.field && k.field.trim());
      if (!keys.length) return `SELECT * FROM ${from}`;
      const orderBy = keys
        .map((k) => `${quoteId(k.field, dialect)} ${k.dir === 'DESC' ? 'DESC' : 'ASC'}`)
        .join(', ');
      return `SELECT * FROM ${from}\nORDER BY ${orderBy}`;
    }

    case 'join': {
      const left = inputRef(node.inputs[0]);
      const right = inputRef(node.inputs[1]);
      const kind = node.joinKind || 'INNER';
      const lk = quoteId(node.leftKey || 'id', dialect);
      const rk = quoteId(node.rightKey || 'id', dialect);
      // LEFT/RIGHT ANTI joins select only the surviving side's columns.
      const projection =
        kind === 'LEFT ANTI'
          ? 'L.*'
          : kind === 'RIGHT ANTI'
            ? 'R.*'
            : 'L.*, R.*';
      return (
        `SELECT ${projection}\n` +
        `FROM ${left} AS L\n` +
        `${kind} JOIN ${right} AS R ON L.${lk} = R.${rk}`
      );
    }

    case 'derive': {
      const from = inputRef(node.inputs[0]);
      const cols = (node.derived || []).filter((c) => c && c.name && c.name.trim());
      if (!cols.length) return `SELECT * FROM ${from}`;
      const exprs = cols
        .map((c) => `${(c.expression || 'NULL').trim() || 'NULL'} AS ${quoteId(c.name, dialect)}`)
        .join(', ');
      return `SELECT *, ${exprs} FROM ${from}`;
    }

    case 'rename': {
      const from = inputRef(node.inputs[0]);
      const maps = (node.renames || []).filter((m) => m && m.from && m.from.trim() && m.to && m.to.trim());
      if (!maps.length) return `SELECT * FROM ${from}`;
      // Project every renamed column explicitly; callers add un-renamed columns
      // by leaving them out of the map (they survive only if also selected
      // upstream). To keep behaviour intuitive we emit the renamed projections
      // plus a trailing * so untouched columns flow through.
      const projs = maps.map((m) => `${quoteId(m.from, dialect)} AS ${quoteId(m.to, dialect)}`).join(', ');
      return `SELECT ${projs}, * FROM ${from}`;
    }

    case 'cast': {
      const from = inputRef(node.inputs[0]);
      const casts = (node.casts || []).filter((c) => c && c.field && c.field.trim());
      if (!casts.length) return `SELECT * FROM ${from}`;
      const projs = casts
        .map((c) => `CAST(${quoteId(c.field, dialect)} AS ${c.to}) AS ${quoteId(c.field, dialect)}`)
        .join(', ');
      return `SELECT ${projs}, * FROM ${from}`;
    }

    case 'dedup': {
      const from = inputRef(node.inputs[0]);
      const keys = (node.dedupKeys || []).filter(Boolean);
      if (!keys.length) {
        // Whole-row de-duplicate.
        return `SELECT DISTINCT * FROM ${from}`;
      }
      // Keyed de-dup → one row per key combination (ROW_NUMBER window, dialect-agnostic SQL).
      const partition = keys.map((k) => quoteId(k, dialect)).join(', ');
      return (
        `SELECT * FROM (\n` +
        `  SELECT *, ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY ${quoteId(keys[0], dialect)}) AS __rn FROM ${from}\n` +
        `) __d WHERE __d.__rn = 1`
      );
    }

    case 'union': {
      const a = inputRef(node.inputs[0]);
      const b = inputRef(node.inputs[1]);
      const op = node.unionAll === false ? 'UNION' : 'UNION ALL';
      return `SELECT * FROM ${a}\n${op}\nSELECT * FROM ${b}`;
    }

    case 'sink':
      // A sink is a pass-through in CTE position; the CREATE wrapper is applied
      // by compileGraph when the sink is the output node (see below).
      return `SELECT * FROM ${inputRef(node.inputs[0])}`;

    default:
      return `SELECT * FROM ${inputRef(node.inputs[0])}`;
  }
}

/**
 * Wrap a final SELECT in a CTAS / CREATE VIEW statement for a sink node.
 *
 * The `withClause` (a `WITH …\n` string, or empty) is kept separate from the
 * `finalSelect` so the statement is valid in BOTH dialects:
 *   - T-SQL has no `CREATE TABLE … AS`; it materializes with `SELECT … INTO`,
 *     and a leading `WITH` is legal *before* the SELECT. So we emit
 *     `WITH … SELECT * INTO target FROM (…)` — i.e. inject `INTO target` into
 *     the final SELECT. Views: `CREATE OR ALTER VIEW … AS WITH … SELECT …`,
 *     which T-SQL permits inside a view body.
 *   - Spark SQL supports `CREATE TABLE … AS WITH … SELECT …` and
 *     `CREATE OR REPLACE VIEW … AS WITH … SELECT …` directly.
 */
function wrapSink(sink: VqSinkConfig, withClause: string, finalSelect: string, dialect: SqlDialect): string {
  const target =
    sink.schema && sink.schema.trim()
      ? `${quoteId(sink.schema, dialect)}.${quoteId(sink.table || 'transform_output', dialect)}`
      : quoteId(sink.table || 'transform_output', dialect);
  const mode: VqSinkMode = sink.mode === 'view' ? 'view' : 'table';

  if (mode === 'view') {
    const verb = dialect === 'tsql' ? 'CREATE OR ALTER VIEW' : 'CREATE OR REPLACE VIEW';
    return `${verb} ${target} AS\n${withClause}${finalSelect}`;
  }

  // table (materialize)
  if (dialect === 'tsql') {
    // SELECT … INTO target FROM … — splice `INTO target` after the SELECT list.
    // finalSelect is always `SELECT * FROM <cte>`, so inject after `SELECT *`.
    const intoSelect = finalSelect.replace(/^SELECT \*/, `SELECT *\nINTO ${target}`);
    return `${withClause}${intoSelect}`;
  }
  // Spark SQL CTAS.
  return `CREATE TABLE ${target} AS\n${withClause}${finalSelect}`;
}

// ============================================================
// Topology helpers
// ============================================================

/** The output node: explicit outputId, else the single leaf (consumed by nobody), else the last node. */
function resolveOutput(graph: VqGraph): VqNode | null {
  const { nodes } = graph;
  if (!nodes.length) return null;
  if (graph.outputId) {
    const n = nodes.find((x) => x.id === graph.outputId);
    if (n) return n;
  }
  const consumed = new Set<string>();
  for (const n of nodes) for (const i of n.inputs) consumed.add(i);
  const leaves = nodes.filter((n) => !consumed.has(n.id));
  return leaves[leaves.length - 1] || nodes[nodes.length - 1];
}

/** Stable, SQL-safe CTE name per node id. */
function cteNameFor(id: string, index: number): string {
  const safe = id.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+/, '');
  return `q${index}_${safe || 'step'}`;
}

// ============================================================
// Public API
// ============================================================

/**
 * Compile the canvas graph to a SQL string for the given dialect.
 *
 * - Empty graph → a friendly placeholder comment.
 * - A single source with no downstream steps → a direct `SELECT * FROM table`
 *   (no CTE wrapper).
 * - Otherwise → a `WITH <cte>, … SELECT * FROM <outputCte>` chain where each
 *   step reads the CTE(s) of its upstream input(s). Only the CTEs that the
 *   output transitively depends on are emitted (dead branches are pruned).
 */
export function compileGraph(graph: VqGraph, dialect: SqlDialect): string {
  const output = resolveOutput(graph);
  if (!output) {
    return `${VQ_HEADER}\n-- Add a table to the canvas to start building a query.\n`;
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  // Depth-first collect the nodes the output depends on, in dependency order
  // (inputs before the node), de-duplicated.
  const order: VqNode[] = [];
  const seen = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id) || visiting.has(id)) return; // de-dup + simple cycle guard
    const n = byId.get(id);
    if (!n) return;
    visiting.add(id);
    for (const inp of n.inputs) visit(inp);
    visiting.delete(id);
    seen.add(id);
    order.push(n);
  };
  visit(output.id);

  // Single bare source → no CTE wrapper.
  if (order.length === 1 && order[0].kind === 'source') {
    return `${VQ_HEADER}\nSELECT * FROM ${sourceRef(order[0], dialect)}\n`;
  }

  // A trailing sink is the materialization wrapper, not a CTE — peel it off and
  // wrap the SELECT over its single upstream input.
  const isSinkOutput = output.kind === 'sink' && output.inputs.length > 0;
  const sinkNode = isSinkOutput ? output : null;
  const selectFromId = isSinkOutput ? output.inputs[0] : output.id;
  const cteNodes = isSinkOutput ? order.filter((n) => n.id !== output.id) : order;

  // Assign CTE names (skip the sink node — it never becomes a CTE).
  const names = new Map<string, string>();
  cteNodes.forEach((n, i) => names.set(n.id, cteNameFor(n.id, i + 1)));
  const inputRef = (id: string) => names.get(id) || quoteId('missing', dialect);

  const ctes = cteNodes.map((n) => {
    const body = compileNodeBody(n, inputRef, dialect).replace(/\n/g, '\n    ');
    return `${names.get(n.id)} AS (\n    ${body}\n)`;
  });

  const finalSelect = `SELECT * FROM ${names.get(selectFromId) || quoteId('missing', dialect)}`;
  const withClause = ctes.length ? `WITH ${ctes.join(',\n')}\n` : '';

  if (sinkNode && sinkNode.sink && (sinkNode.sink.table || '').trim()) {
    return `${VQ_HEADER}\n${wrapSink(sinkNode.sink, withClause, finalSelect, dialect)}\n`;
  }

  return `${VQ_HEADER}\n${withClause}${finalSelect}\n`;
}
