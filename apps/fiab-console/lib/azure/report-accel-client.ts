/**
 * report-accel-client — the OPT-IN DuckDB-over-Delta fast path for the Loom
 * report / semantic layer, plus the accel→cache→Serverless orchestrator the
 * report query route dispatches through. Together with `query-result-cache.ts`
 * this is Loom's pragmatic 80% of Fabric "Direct Lake": interactive-speed
 * aggregations straight off the lakehouse Delta files, Azure-native, NO Fabric
 * capacity / workspace (no-fabric-dependency.md).
 *
 * ── The three-tier preference (what the route asks for) ─────────────────────
 *   1. CACHE      — `query-result-cache`. A repeat of the same logical query is
 *                   an in-process (or Cosmos) read. Always on, no infra.
 *   2. ACCEL      — this client. When `LOOM_REPORT_ACCEL_URL` points at the
 *                   deployed DuckDB accel ACA service AND the visual's source
 *                   resolves to a Delta table, the service runs the aggregation
 *                   over the Delta files directly (columnar, vectorized) —
 *                   import-mode speed without materializing into a warehouse.
 *   3. SERVERLESS — the existing Synapse Serverless / dedicated path. ALWAYS the
 *                   honest fallback: if accel is unset, unreachable, returns 503,
 *                   or the source isn't a Delta table, the route runs the same
 *                   real query it always did (no-vaporware.md). Out of the box
 *                   (accel unset) Loom therefore runs cache + Serverless; it
 *                   simply lights up the accel tier once the host is deployed.
 *
 * ── Why the client sends a SEMANTIC query, not the T-SQL ────────────────────
 * The Synapse path compiles the visual wells to T-SQL (`wells-to-sql`, bracket
 * quoting, OPENROWSET). Rather than translate T-SQL → DuckDB dialect (brittle),
 * the accel service owns its own dialect: the client folds the visual's wells +
 * filters into a small, explicit `AccelSemanticQuery` (group-by + aggregates +
 * a safe filter subset) and the service compiles that to DuckDB SQL over
 * `delta_scan('<url>')`. This is a deliberately NARROW compiler covering the
 * common aggregating visual (card / chart / matrix over a single Delta table) —
 * exactly the shape Direct Lake accelerates. Anything it can't express (measures
 * with resolver-built SQL expressions, multi-table joins, drill/what-if) simply
 * isn't offered to accel and falls through to Serverless — never wrong rows.
 *
 * Auth: internal ingress on the CAE VNet. When `LOOM_REPORT_ACCEL_AUDIENCE` is
 * set the console attaches a Bearer token (Console UAMI via `loomServerCredential`)
 * so the service can validate the caller; otherwise the VNet boundary is the
 * control (same posture as the internal MCP servers).
 */

import { loomServerCredential } from '@/lib/azure/aca-managed-identity';
import type { DaxVisual, DaxWellField } from '@/lib/azure/aas-dax';
import type {
  ReportFilterInput,
  SqlSourceColumn,
  SqlSourceFrom,
} from '@/lib/azure/wells-to-sql';
import {
  buildQueryCacheKey,
  getCachedResult,
  setCachedResult,
  type CachedQueryResult,
} from '@/lib/azure/query-result-cache';

// ── Config / gate ────────────────────────────────────────────────────────────

/** True when the DuckDB-over-Delta accel host is deployed + wired. */
export function reportAccelConfigured(): boolean {
  return !!process.env.LOOM_REPORT_ACCEL_URL;
}

/** Honest gate copy naming the exact env var + bicep module to deploy the host. */
export function reportAccelGate(): string {
  return (
    'The DuckDB-over-Delta query accelerator is not deployed in this environment. ' +
    'Set LOOM_REPORT_ACCEL_URL to the internal FQDN of the report-accel Container App ' +
    '(platform/fiab/bicep/modules/admin-plane/report-accel.bicep) and grant its identity ' +
    '"Storage Blob Data Reader" on the lakehouse. Until then reports run on Synapse ' +
    'Serverless (cache + direct query) — no Fabric capacity required either way.'
  );
}

// ── Accel semantic query (the client→service contract) ───────────────────────

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
  /** abfss:// or https:// URL of the Delta table to scan. */
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

/** The accel service response. */
export interface AccelQueryResponse {
  columns: string[];
  rows: unknown[][];
  /** The DuckDB SQL the service ran (surfaced in the SQL pane). */
  sql?: string;
  /** Delta table version the scan read — a true freshness token when present. */
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
 * derived SELECT — those cannot be accelerated by delta_scan and stay on Synapse.
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

// ── HTTP call ────────────────────────────────────────────────────────────────

/** Timeout (ms) for the accel HTTP call before falling back to Serverless. */
function accelTimeoutMs(): number {
  const n = Number(process.env.LOOM_REPORT_ACCEL_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 20_000;
}

async function accelAuthHeader(): Promise<Record<string, string>> {
  const audience = process.env.LOOM_REPORT_ACCEL_AUDIENCE;
  if (!audience) return {};
  try {
    const scope = audience.endsWith('/.default') ? audience : `${audience}/.default`;
    const token = await loomServerCredential.getToken(scope);
    if (token?.token) return { authorization: `Bearer ${token.token}` };
  } catch {
    /* internal ingress on the VNet — proceed unauthenticated if token mint fails */
  }
  return {};
}

/**
 * Execute an `AccelSemanticQuery` against the deployed DuckDB accel service.
 * Throws `ReportAccelError` on a non-2xx / timeout / network failure so the
 * orchestrator can fall through to Serverless.
 */
export async function queryAccel(q: AccelSemanticQuery): Promise<AccelQueryResponse> {
  const base = process.env.LOOM_REPORT_ACCEL_URL;
  if (!base) throw new ReportAccelError('LOOM_REPORT_ACCEL_URL unset', 503);
  const url = `${base.replace(/\/+$/, '')}/query`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), accelTimeoutMs());
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await accelAuthHeader()) },
      body: JSON.stringify(q),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ReportAccelError(
        `report-accel returned ${res.status}: ${text.slice(0, 300)}`,
        res.status,
      );
    }
    const body = (await res.json()) as AccelQueryResponse;
    if (!Array.isArray(body?.columns) || !Array.isArray(body?.rows)) {
      throw new ReportAccelError('report-accel returned a malformed body', 502);
    }
    return body;
  } catch (e) {
    if (e instanceof ReportAccelError) throw e;
    const msg = (e as Error)?.name === 'AbortError' ? 'report-accel timed out' : String((e as Error)?.message || e);
    throw new ReportAccelError(msg, 504);
  } finally {
    clearTimeout(timer);
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
   * Accel candidate inputs. Present ⇒ eligible to try the DuckDB fast path (only
   * actually attempted when `reportAccelConfigured()` and `buildAccelQuery` folds).
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
 *                run DuckDB-over-Delta; cache + return (`source:'accel'`). Any
 *                accel failure (503/timeout/malformed) is swallowed → step 3.
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
        // Prefer the Delta version the service reported as the freshness token for
        // this stored slot (a true commit version beats the item-state proxy).
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
