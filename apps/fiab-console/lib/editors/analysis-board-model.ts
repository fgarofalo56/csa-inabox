/**
 * Analysis Board (Foundry-parity row 3.1 — "Contour") — the transform-pipeline
 * core. A board is an ORDERED list of typed transform steps over a data source;
 * this module compiles that board into an executable KQL query (Azure Data
 * Explorer — the Loom Azure-native analytics backend; no Fabric).
 *
 * The compiler is a PURE function (no I/O) so it is fully unit-testable — the
 * editor runs the compiled KQL via the ADX kusto-client. All identifiers are
 * validated and all string literals KQL-escaped, so a board can never inject
 * KQL (same guard posture as buildKqlWithOptions in kusto-client).
 */

// ── Identifiers + literals ──────────────────────────────────────────────────

/** A safe KQL column/table identifier: letter/underscore start, word chars. */
export function isKqlIdent(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(v);
}

/** Escape a string for a double-quoted KQL literal. */
export function kqlString(v: string): string {
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

/** Render a step value as a KQL scalar: bare number, else a quoted string. */
function kqlScalar(v: string): string {
  const t = v.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  if (t === 'true' || t === 'false') return t;
  return kqlString(t);
}

// ── Source ──────────────────────────────────────────────────────────────────

export type BoardSourceKind = 'table' | 'query';
export interface BoardSource {
  kind: BoardSourceKind;
  /** For kind='table' — the table name (validated ident). */
  table?: string;
  /** For kind='query' — a base KQL expression the steps append onto. */
  query?: string;
}

// ── Steps (discriminated union) ─────────────────────────────────────────────

export type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'startswith' | 'in';
export const FILTER_OPS: readonly FilterOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'startswith', 'in'];
export const FILTER_OP_KQL: Record<FilterOp, string> = {
  eq: '==', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', contains: 'contains', startswith: 'startswith', in: 'in',
};

export type AggFn = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'dcount';
export const AGG_FNS: readonly AggFn[] = ['count', 'sum', 'avg', 'min', 'max', 'dcount'];

export interface FilterStep { type: 'filter'; column: string; op: FilterOp; value: string }
export interface SelectStep { type: 'select'; columns: string[] }
export interface DeriveStep { type: 'derive'; as: string; expr: string }
export interface AggregateStep { type: 'aggregate'; groupBy: string[]; aggregations: { fn: AggFn; column?: string; as: string }[] }
export interface SortStep { type: 'sort'; column: string; direction: 'asc' | 'desc' }
export interface LimitStep { type: 'limit'; count: number }
export interface DistinctStep { type: 'distinct'; columns: string[] }

export type BoardStep = FilterStep | SelectStep | DeriveStep | AggregateStep | SortStep | LimitStep | DistinctStep;
export const BOARD_STEP_TYPES: readonly BoardStep['type'][] = ['filter', 'select', 'derive', 'aggregate', 'sort', 'limit', 'distinct'];
export const BOARD_STEP_LABELS: Record<BoardStep['type'], string> = {
  filter: 'Filter rows', select: 'Select columns', derive: 'Derive column', aggregate: 'Aggregate', sort: 'Sort', limit: 'Limit', distinct: 'Distinct',
};

export interface AnalysisBoard { source: BoardSource; steps: BoardStep[] }

// ── Compile ─────────────────────────────────────────────────────────────────

export type CompileResult = { ok: true; kql: string } | { ok: false; error: string };

/**
 * Compile an analysis board into an executable KQL query. Each step maps to one
 * pipe operator; identifiers are validated and values escaped. The first failing
 * validation returns a precise error (never emits unsafe KQL).
 */
export function compileBoardToKql(board: AnalysisBoard): CompileResult {
  const src = board.source;
  let head: string;
  if (src.kind === 'table') {
    if (!isKqlIdent(src.table)) return { ok: false, error: 'Source table is not a valid identifier.' };
    head = src.table as string;
  } else {
    const q = (src.query || '').trim();
    if (!q) return { ok: false, error: 'Source query is empty.' };
    head = `(${q})`;
  }
  const lines = [head];
  for (const [i, step] of (board.steps || []).entries()) {
    const r = compileStep(step, i);
    if (!r.ok) return r;
    if (r.kql) lines.push(r.kql);
  }
  // head, then each step as a piped operator: "head\n| op1\n| op2".
  return { ok: true, kql: lines.join('\n| ') };
}

function compileStep(step: BoardStep, idx: number): CompileResult {
  const at = `Step ${idx + 1} (${step?.type})`;
  switch (step.type) {
    case 'filter': {
      if (!isKqlIdent(step.column)) return { ok: false, error: `${at}: invalid column.` };
      if (!FILTER_OPS.includes(step.op)) return { ok: false, error: `${at}: invalid operator.` };
      if (step.op === 'in') {
        const items = String(step.value ?? '').split(',').map((x) => x.trim()).filter(Boolean).map(kqlScalar);
        if (!items.length) return { ok: false, error: `${at}: 'in' needs a comma-separated list.` };
        return { ok: true, kql: `where ${step.column} in (${items.join(', ')})` };
      }
      return { ok: true, kql: `where ${step.column} ${FILTER_OP_KQL[step.op]} ${kqlScalar(String(step.value ?? ''))}` };
    }
    case 'select': {
      const cols = (step.columns || []).filter(isKqlIdent);
      if (!cols.length) return { ok: false, error: `${at}: select at least one valid column.` };
      return { ok: true, kql: `project ${cols.join(', ')}` };
    }
    case 'distinct': {
      const cols = (step.columns || []).filter(isKqlIdent);
      if (!cols.length) return { ok: false, error: `${at}: distinct needs at least one valid column.` };
      return { ok: true, kql: `distinct ${cols.join(', ')}` };
    }
    case 'derive': {
      if (!isKqlIdent(step.as)) return { ok: false, error: `${at}: derived column name is invalid.` };
      const expr = (step.expr || '').trim();
      // Guard: allow only idents, numbers, arithmetic/paren, and quoted strings.
      if (!expr || !/^[A-Za-z0-9_+\-*/%.()\s"']+$/.test(expr)) return { ok: false, error: `${at}: expression has unsupported characters.` };
      return { ok: true, kql: `extend ${step.as} = ${expr}` };
    }
    case 'aggregate': {
      const groupBy = (step.groupBy || []).filter(isKqlIdent);
      const aggs: string[] = [];
      for (const a of step.aggregations || []) {
        if (!isKqlIdent(a.as)) return { ok: false, error: `${at}: aggregation output name is invalid.` };
        if (!AGG_FNS.includes(a.fn)) return { ok: false, error: `${at}: invalid aggregation function.` };
        if (a.fn === 'count') { aggs.push(`${a.as} = count()`); continue; }
        if (!isKqlIdent(a.column)) return { ok: false, error: `${at}: ${a.fn} needs a valid column.` };
        aggs.push(`${a.as} = ${a.fn}(${a.column})`);
      }
      if (!aggs.length) return { ok: false, error: `${at}: add at least one aggregation.` };
      const by = groupBy.length ? ` by ${groupBy.join(', ')}` : '';
      return { ok: true, kql: `summarize ${aggs.join(', ')}${by}` };
    }
    case 'sort': {
      if (!isKqlIdent(step.column)) return { ok: false, error: `${at}: invalid sort column.` };
      return { ok: true, kql: `order by ${step.column} ${step.direction === 'asc' ? 'asc' : 'desc'}` };
    }
    case 'limit': {
      const n = Math.floor(Number(step.count));
      if (!Number.isFinite(n) || n < 1) return { ok: false, error: `${at}: limit must be a positive integer.` };
      return { ok: true, kql: `take ${Math.min(n, 100000)}` };
    }
    default:
      return { ok: false, error: `${at}: unknown step type.` };
  }
}

/** Normalize a persisted board (drop malformed steps, coerce source). */
export function normalizeBoard(raw: unknown): AnalysisBoard {
  const r = (raw || {}) as Record<string, unknown>;
  const s = (r.source || {}) as Record<string, unknown>;
  const source: BoardSource = s.kind === 'query'
    ? { kind: 'query', query: typeof s.query === 'string' ? s.query : '' }
    : { kind: 'table', table: typeof s.table === 'string' ? s.table : '' };
  const steps = Array.isArray(r.steps) ? (r.steps.filter((x) => x && typeof x === 'object' && BOARD_STEP_TYPES.includes((x as BoardStep).type)) as BoardStep[]) : [];
  return { source, steps };
}
