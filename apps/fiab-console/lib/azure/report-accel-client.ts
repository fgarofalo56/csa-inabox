/**
 * report-accel-client — the Databricks SQL (Photon) over-Delta fast path for the
 * Loom report / semantic layer, plus the accel→cache→Serverless orchestrator the
 * report query route dispatches through. Together with `query-result-cache.ts`
 * this is Loom's true Fabric "Direct Lake" analog: interactive-speed aggregations
 * straight off the lakehouse Delta files, first-party Azure-native (Azure
 * Databricks), NO Fabric capacity / workspace (no-fabric-dependency.md).
 *
 * ── The three-tier preference (what the route asks for) ─────────────────────
 *   1. CACHE      — `query-result-cache`. A repeat of the same logical query is
 *                   an in-process (or Cosmos) read. Always on, no infra.
 *   2. ACCEL      — this client. When a Databricks SQL warehouse is configured
 *                   (`LOOM_DATABRICKS_HOSTNAME` + `LOOM_DATABRICKS_SQL_WAREHOUSE_ID`)
 *                   AND the visual's source resolves to a Delta table, the
 *                   aggregation runs on the Photon-accelerated SQL warehouse
 *                   reading the SAME ADLS Delta files IN-PLACE
 *                   (`SELECT … FROM delta.` + backtick-quoted abfss URL) — ANSI +
 *                   Delta-native, vectorized, import-mode speed without
 *                   materializing into a warehouse.
 *   3. SERVERLESS — the existing Synapse Serverless / dedicated path. ALWAYS the
 *                   honest fallback: if no warehouse is configured, the statement
 *                   errors/times out, the result truncates, or the source isn't a
 *                   Delta table, the route runs the same real query it always did
 *                   (no-vaporware.md). Out of the box (no warehouse) Loom therefore
 *                   runs cache + Serverless; it simply lights up the accel tier once
 *                   a Databricks SQL warehouse is bound.
 *
 * ── Why the client sends a SEMANTIC query, not the T-SQL ────────────────────
 * The Synapse path compiles the visual wells to T-SQL (`wells-to-sql`, bracket
 * quoting, OPENROWSET). Rather than translate T-SQL → the Databricks dialect
 * (brittle), the client folds the visual's wells + filters into a small, explicit
 * `AccelSemanticQuery` (group-by + aggregates + a safe filter subset) and
 * `compileAccelSql` compiles that to Databricks SQL over `delta.` + the Delta
 * path. Databricks SQL is ANSI + Delta-native, so this needs far less dialect
 * work than the DuckDB backend it replaced (standard `LIMIT`, ANSI agg funcs,
 * backtick-quoted identifiers, and named parameter markers bound by the
 * Statement Execution API — injection-safe). This is a deliberately NARROW
 * compiler covering the common aggregating visual (card / chart / matrix over a
 * single Delta table) — exactly the shape Direct Lake accelerates. Anything it
 * can't express (measures with resolver-built SQL expressions, multi-table joins,
 * drill/what-if) simply isn't offered to accel and falls through to Serverless —
 * never wrong rows.
 *
 * Auth: the Databricks SQL warehouse is reached through `databricks-client.ts`
 * (`runWarehouseStatement`), which mints an AAD token for the Azure Databricks
 * resource via the Console UAMI. No separate service, ingress, or audience is
 * needed — the same workspace the SQL Warehouse editor drives.
 */

import type { DaxVisual, DaxWellField } from '@/lib/azure/aas-dax';
import type {
  ReportFilterInput,
  SqlSourceColumn,
  SqlSourceFrom,
} from '@/lib/azure/wells-to-sql';
import {
  runWarehouseStatement,
  warehouseConfigGate,
  databricksConfigGate,
  type DbxQueryParam,
} from '@/lib/azure/databricks-client';
import {
  buildQueryCacheKey,
  getCachedResult,
  setCachedResult,
  type CachedQueryResult,
} from '@/lib/azure/query-result-cache';

// ── Config / gate ────────────────────────────────────────────────────────────

/** True when a Databricks SQL warehouse (Photon) is configured for the accel path. */
export function reportAccelConfigured(): boolean {
  return !databricksConfigGate() && !warehouseConfigGate();
}

/** Honest gate copy naming the exact env vars the Databricks-SQL accel needs. */
export function reportAccelGate(): string {
  return (
    'The Databricks SQL (Photon) query accelerator is not configured in this environment. ' +
    'Set LOOM_DATABRICKS_HOSTNAME (the Databricks workspace URL) and LOOM_DATABRICKS_SQL_WAREHOUSE_ID ' +
    '(a SQL warehouse id) on the Loom Console so aggregating report visuals run on the Photon ' +
    'warehouse over the lakehouse Delta in-place. Until then reports run on Synapse Serverless ' +
    '(cache + direct query) — no Fabric capacity required either way.'
  );
}

// ── Accel semantic query (the visual→Databricks-SQL contract) ────────────────

export type AccelAggFn = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'countDistinct';

export interface AccelAggregate {
  /** Source column; null for a bare row COUNT(*). */
  col: string | null;
  fn: AccelAggFn;
  /** Result column alias (matches the wells-to-sql alias so LoomChart reads it). */
  alias: string;
}

export type AccelFilterOp =
  | 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'in' | 'contains' | 'between';

export interface AccelFilter {
  col: string;
  op: AccelFilterOp;
  value?: string;
  value2?: string;
  values?: string[];
  /** Wrap the predicate in NOT (...) (Power BI "exclude"). */
  exclude?: boolean;
}

export interface AccelSemanticQuery {
  /** abfss:// or https:// URL of the Delta table to scan (via `delta.`<path>``). */
  deltaUrl: string;
  /** GROUP BY columns (category + legend wells). */
  groupBy: string[];
  /** Aggregates (value wells). Empty ⇒ a DISTINCT projection of `groupBy`. */
  aggregates: AccelAggregate[];
  /** Pre-aggregation WHERE predicates (safe subset). */
  filters: AccelFilter[];
  /** Optional ORDER BY (falls back to first aggregate desc when topN is set). */
  orderBy?: { col: string; dir: 'asc' | 'desc' }[];
  /** Row cap (Top N or a default guard). */
  limit?: number;
}

/** The accel query response (columnar), normalized from the warehouse result. */
export interface AccelQueryResponse {
  columns: string[];
  rows: unknown[][];
  /** The Databricks SQL that ran (surfaced in the SQL pane). */
  sql?: string;
  /** Delta table version the scan read — reserved; not populated on this path. */
  deltaVersion?: number | string;
  elapsedMs?: number;
}

export class ReportAccelError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ReportAccelError';
    this.status = status;
  }
}

// ── Delta-URL extraction ─────────────────────────────────────────────────────

/**
 * Resolve the Delta table URL backing a resolved FROM relation, IFF it is a
 * serverless `OPENROWSET(BULK '<url>', FORMAT='DELTA')` derived source (the exact
 * shape the resolver's lakehouse / source-group cache / connection-cache paths
 * emit). Returns null for a dedicated-pool table, a non-Delta OPENROWSET, or any
 * derived SELECT — those cannot be read in-place as a Delta path and stay on
 * Synapse.
 */
export function extractDeltaUrl(from: SqlSourceFrom): string | null {
  if (from.kind !== 'derived') return null;
  const m = /OPENROWSET\(\s*BULK\s*'((?:[^']|'')+)'\s*,\s*FORMAT\s*=\s*'DELTA'\s*\)/i.exec(from.sql);
  if (!m) return null;
  // Un-double any escaped single quotes the resolver doubled for the T-SQL literal.
  return m[1].replace(/''/g, "'");
}

// ── Visual wells → AccelSemanticQuery ────────────────────────────────────────

const ACCEL_AGG: Record<string, AccelAggFn> = {
  Sum: 'sum',
  Avg: 'avg',
  Min: 'min',
  Max: 'max',
  Count: 'count',
};

const FILTER_OP_MAP: Record<string, AccelFilterOp | undefined> = {
  eq: 'eq', ne: 'ne', gt: 'gt', ge: 'ge', lt: 'lt', le: 'le',
  in: 'in', contains: 'contains', between: 'between',
};

/** Row visuals (table/slicer) aggregate nothing → not an accel candidate. */
function isAggregatingVisual(visual: DaxVisual): boolean {
  const t = (visual.type || '').toLowerCase();
  return t !== 'table' && t !== 'slicer';
}

/** A well field resolvable to a whitelisted COLUMN (measures are not accel-able). */
function resolvableColumn(w: DaxWellField, allow: Set<string>): string | null {
  if (w.measure) return null; // resolver-built measure exprs live only on the SQL path
  const c = w.column;
  if (!c || !allow.has(c.toLowerCase())) return null;
  return c;
}

/**
 * Fold a visual's wells + the structured Filters pane into an `AccelSemanticQuery`
 * — or return null when the visual is NOT a safe accel candidate (a measure-backed
 * value, a non-column filter, a `topN`/`relativeDate` op the narrow compiler
 * doesn't express, or nothing to aggregate). A null result means "let Serverless
 * answer it" — never a wrong or partial accel result (no-vaporware.md).
 */
export function buildAccelQuery(
  deltaUrl: string,
  visual: DaxVisual,
  filters: ReportFilterInput[] | undefined,
  columns: SqlSourceColumn[],
): AccelSemanticQuery | null {
  if (!isAggregatingVisual(visual)) return null;
  const wells = visual.wells || {};
  const allow = new Set(columns.map((c) => c.name.toLowerCase()));

  const groupSet: string[] = [];
  for (const w of [...(wells.category || []), ...(wells.legend || [])]) {
    const col = resolvableColumn(w, allow);
    if (w.measure) return null; // a measure in a group well → SQL path
    if (!col) {
      if (w.column) return null; // referenced a non-whitelisted column → SQL path
      continue;
    }
    if (!groupSet.includes(col)) groupSet.push(col);
  }

  const aggregates: AccelAggregate[] = [];
  for (const w of wells.values || []) {
    if (w.measure) return null; // resolver-built measure expr → SQL path only
    const col = w.column;
    if (!col || !allow.has(col.toLowerCase())) return null;
    const useAgg = w.aggregation && w.aggregation !== 'None';
    const fn = useAgg ? ACCEL_AGG[w.aggregation as string] || 'sum' : 'sum';
    const alias = useAgg ? `${w.aggregation} of ${col}` : `Sum of ${col}`;
    aggregates.push({ col, fn, alias });
  }

  // Nothing to aggregate AND nothing to group ⇒ no runnable accel query.
  if (!aggregates.length && !groupSet.length) return null;

  const accelFilters: AccelFilter[] = [];
  for (const f of filters || []) {
    // A measure-scoped filter (HAVING) or a topN/relativeDate op is out of the
    // narrow compiler's scope → hand the WHOLE visual to Serverless (correctness).
    if (f.measure) return null;
    if (f.op === 'topN' || f.op === 'relativeDate') return null;
    const op = FILTER_OP_MAP[f.op];
    const col = f.column;
    if (!op || !col || !allow.has(col.toLowerCase())) return null;
    accelFilters.push({
      col,
      op,
      value: f.value,
      value2: f.value2,
      values: f.values,
      exclude: f.exclude,
    });
  }

  return {
    deltaUrl,
    groupBy: groupSet,
    aggregates,
    filters: accelFilters,
    limit: 100_000,
  };
}

// ── AccelSemanticQuery → Databricks SQL (Photon over Delta, in-place) ────────

/** Backtick-quote a Databricks identifier / Delta path (double embedded backticks). */
function quoteIdent(name: string): string {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

/** `delta.`<path>`` — path-based, in-place Delta read (no table registration). */
function deltaRelation(url: string): string {
  return `delta.${quoteIdent(url)}`;
}

/** One ANSI aggregate expression. `count` with a null col ⇒ `COUNT(*)`. */
function aggExpr(a: AccelAggregate): string {
  const col = a.col ? quoteIdent(a.col) : '*';
  switch (a.fn) {
    case 'sum': return `SUM(${col})`;
    case 'avg': return `AVG(${col})`;
    case 'min': return `MIN(${col})`;
    case 'max': return `MAX(${col})`;
    case 'countDistinct': return `COUNT(DISTINCT ${a.col ? quoteIdent(a.col) : '*'})`;
    case 'count':
    default: return a.col ? `COUNT(${col})` : 'COUNT(*)';
  }
}

/**
 * Compile an `AccelSemanticQuery` to a parameterized Databricks SQL statement.
 * Filter VALUES bind as named parameter markers (`:pN`) — the Statement Execution
 * API binds them separately, never spliced into the SQL, so this is
 * injection-safe regardless of what the user typed. Identifiers come only from the
 * resolver whitelist (via `buildAccelQuery`) and are backtick-quoted.
 */
export function compileAccelSql(q: AccelSemanticQuery): { sql: string; parameters: DbxQueryParam[] } {
  const parameters: DbxQueryParam[] = [];
  let pIdx = 0;
  const bind = (value: string): string => {
    const name = `p${pIdx++}`;
    parameters.push({ name, value: value ?? null });
    return `:${name}`;
  };

  const selectParts: string[] = [];
  for (const g of q.groupBy) selectParts.push(quoteIdent(g));
  for (const a of q.aggregates) selectParts.push(`${aggExpr(a)} AS ${quoteIdent(a.alias)}`);
  // No aggregates + no group ⇒ guarded upstream; fall back to a row projection.
  const projection = selectParts.length ? selectParts.join(', ') : '*';

  const where: string[] = [];
  for (const f of q.filters) {
    const col = quoteIdent(f.col);
    let clause = '';
    switch (f.op) {
      case 'eq': clause = `${col} = ${bind(f.value ?? '')}`; break;
      case 'ne': clause = `${col} <> ${bind(f.value ?? '')}`; break;
      case 'gt': clause = `${col} > ${bind(f.value ?? '')}`; break;
      case 'ge': clause = `${col} >= ${bind(f.value ?? '')}`; break;
      case 'lt': clause = `${col} < ${bind(f.value ?? '')}`; break;
      case 'le': clause = `${col} <= ${bind(f.value ?? '')}`; break;
      case 'contains': clause = `${col} LIKE ${bind(`%${f.value ?? ''}%`)}`; break;
      case 'between':
        clause = `${col} BETWEEN ${bind(f.value ?? '')} AND ${bind(f.value2 ?? '')}`;
        break;
      case 'in': {
        const vals = f.values && f.values.length ? f.values : f.value != null ? [f.value] : [];
        if (!vals.length) continue;
        clause = `${col} IN (${vals.map((v) => bind(v)).join(', ')})`;
        break;
      }
      default:
        continue;
    }
    if (!clause) continue;
    where.push(f.exclude ? `NOT (${clause})` : clause);
  }

  let sql = `SELECT ${projection} FROM ${deltaRelation(q.deltaUrl)}`;
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  if (q.groupBy.length) sql += ` GROUP BY ${q.groupBy.map(quoteIdent).join(', ')}`;
  if (q.orderBy && q.orderBy.length) {
    const ob = q.orderBy
      .map((o) => `${quoteIdent(o.col)} ${o.dir === 'asc' ? 'ASC' : 'DESC'}`)
      .join(', ');
    sql += ` ORDER BY ${ob}`;
  }
  if (typeof q.limit === 'number' && q.limit > 0) sql += ` LIMIT ${Math.floor(q.limit)}`;

  return { sql, parameters };
}

// ── Execution against the Databricks SQL warehouse (Photon) ──────────────────

/**
 * Compile + execute an `AccelSemanticQuery` on the configured Databricks SQL
 * warehouse. Throws `ReportAccelError` on ANY failure (statement error, timeout,
 * not-configured, or a TRUNCATED result — which would cache partial rows) so the
 * orchestrator falls through to the honest Serverless path — never a wrong or
 * partial accel result (no-vaporware.md).
 */
export async function queryAccel(q: AccelSemanticQuery): Promise<AccelQueryResponse> {
  const { sql, parameters } = compileAccelSql(q);
  try {
    const res = await runWarehouseStatement(sql, { parameters });
    // A truncated warehouse result (Statement Execution row cap) would cache a
    // partial answer for an aggregating visual — refuse it and fall back.
    if (res.truncated) {
      throw new ReportAccelError('report-accel result truncated by the warehouse row cap', 502);
    }
    return {
      columns: res.columns,
      rows: res.rows,
      sql,
      elapsedMs: res.executionMs,
    };
  } catch (e) {
    if (e instanceof ReportAccelError) throw e;
    const err = e as Error & { code?: string; status?: number };
    throw new ReportAccelError(err?.message || String(e), err?.status ?? 502);
  }
}

// ── Orchestrator: cache → accel → serverless ─────────────────────────────────

/** Zip a columnar accel/serverless result into object rows (shared row shape). */
export function objectRowsFrom(columns: string[], rows: unknown[][]): Record<string, unknown>[] {
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      o[c] = r[i];
    });
    return o;
  });
}

/** Which tier answered — surfaced to the client for the "Accelerated ⚡" badge. */
export type AcceleratedSource = 'cache' | 'accel' | 'serverless';

export interface AcceleratedRunResult {
  rows: Record<string, unknown>[];
  columns?: string[];
  sql?: string;
  rowCount?: number;
  elapsedMs?: number;
  source: AcceleratedSource;
}

export interface AcceleratedRunOptions {
  /** Report / semantic-model item id (cache scope). */
  modelId: string;
  /** Freshness/invalidation token (Delta version when known, else item-state proxy). */
  freshness: string;
  /** Execution-surface label for the cache key (`serverless` | `dedicated` | storage mode). */
  storageMode: string;
  /** The compiled SQL — the query IDENTITY used for the cache key (not necessarily run). */
  compiledSql: string;
  /** Bound parameters folded into the cache key. */
  parameters?: ReadonlyArray<{ name?: string; value?: unknown } | unknown>;
  /**
   * Accel candidate inputs. Present ⇒ eligible to try the Databricks-SQL fast path
   * (only actually attempted when `reportAccelConfigured()` and `buildAccelQuery`
   * folds).
   */
  accel?: {
    deltaUrl: string;
    visual: DaxVisual;
    filters?: ReportFilterInput[];
    columns: SqlSourceColumn[];
  };
  /**
   * Run the REAL Synapse query (the always-available honest fallback). Returns the
   * columnar result; the orchestrator zips + caches it.
   */
  runDirect: () => Promise<{
    columns: string[];
    rows: unknown[][];
    rowCount?: number;
    executionMs?: number;
  }>;
}

/**
 * The accel→cache→Serverless orchestrator the report query route dispatches
 * through. Order:
 *   1. CACHE   — return immediately on a hit (`source:'cache'`).
 *   2. ACCEL   — when configured + the visual folds to a Delta semantic query,
 *                run Databricks SQL (Photon) over the Delta path; cache + return
 *                (`source:'accel'`). Any accel failure (not-configured/timeout/
 *                error/truncated) is swallowed → step 3.
 *   3. DIRECT  — run the real Synapse query; cache + return (`source:'serverless'`).
 * The result is stored under the SAME compiled-SQL-derived key regardless of which
 * tier produced it, so a later repeat hits the cache no matter who answered first.
 */
export async function runAcceleratedQuery(opts: AcceleratedRunOptions): Promise<AcceleratedRunResult> {
  const key = buildQueryCacheKey({
    modelId: opts.modelId,
    sql: opts.compiledSql,
    parameters: opts.parameters,
    storageMode: opts.storageMode,
    freshness: opts.freshness,
  });

  // 1 — cache.
  const cached = await getCachedResult(key, opts.modelId);
  if (cached) {
    return {
      rows: cached.rows,
      columns: cached.columns,
      sql: cached.sql,
      rowCount: cached.rowCount,
      source: 'cache',
    };
  }

  // 2 — accel (opt-in, best-effort). Never let an accel failure fail the request.
  if (opts.accel && reportAccelConfigured()) {
    const aq = buildAccelQuery(opts.accel.deltaUrl, opts.accel.visual, opts.accel.filters, opts.accel.columns);
    if (aq) {
      try {
        const resp = await queryAccel(aq);
        const rows = objectRowsFrom(resp.columns, resp.rows);
        const value: CachedQueryResult = {
          rows,
          columns: resp.columns,
          sql: resp.sql,
          rowCount: rows.length,
          producedBy: 'accel',
        };
        await setCachedResult(key, opts.modelId, value);
        return {
          rows,
          columns: resp.columns,
          sql: resp.sql,
          rowCount: rows.length,
          elapsedMs: resp.elapsedMs,
          source: 'accel',
        };
      } catch {
        /* fall through to the honest Serverless path */
      }
    }
  }

  // 3 — direct Synapse (always-available honest fallback).
  const direct = await opts.runDirect();
  const rows = objectRowsFrom(direct.columns, direct.rows);
  const value: CachedQueryResult = {
    rows,
    columns: direct.columns,
    sql: opts.compiledSql,
    rowCount: direct.rowCount ?? rows.length,
    producedBy: opts.storageMode,
  };
  await setCachedResult(key, opts.modelId, value);
  return {
    rows,
    columns: direct.columns,
    sql: opts.compiledSql,
    rowCount: direct.rowCount ?? rows.length,
    elapsedMs: direct.executionMs,
    source: 'serverless',
  };
}
