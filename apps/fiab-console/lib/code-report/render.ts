/**
 * render.ts — the SERVER-ONLY renderer for a `code-report` (N16).
 *
 * Parses a report source (via the pure {@link parseCodeReport}) and EXECUTES
 * every query block against the REAL backend (no-vaporware — no mock arrays):
 *   • a `sql loom <name>` block (a governed metric) resolves through N15's
 *     {@link runGovernedMetricQuery} — the SAME one-metric-one-number execute
 *     path the report designer and the metrics endpoint use; there is NO second
 *     query path for metrics.
 *   • a raw `sql <name>` block runs on the report's BOUND engine — Synapse
 *     serverless (T-SQL) for `synapse`/`lakehouse`, Azure Data Explorer (KQL)
 *     for `adx` — after passing the {@link assertReadOnlyQuery} guard.
 *
 * INJECTION / SAFETY: a raw block is author-controlled SQL (the Evidence.dev
 * model), executed in the AUTHOR's own boundary. The guard restricts it to a
 * SINGLE read-only statement (SELECT / WITH / KQL tabular) — a data-modifying
 * or multi-statement body is REJECTED, never executed — so a report can neither
 * mutate data nor stack a second statement. Metric blocks are injection-safe by
 * construction (N15 whitelists names + binds/escapes values).
 *
 * MOAT / IL5: every query runs ENTIRELY in-boundary (Synapse serverless / ADX —
 * both Gov-GA), so a code-report renders with zero external egress even in an
 * air-gapped IL5 enclave.
 *
 * Server-only (imports the Synapse/ADX clients + N15's run path); never import
 * into a client component. The pure AST types come from ./parse, which the
 * client editor imports directly.
 */

import {
  parseCodeReport,
  assertReadOnlyQuery,
  engineDialect,
  RawQueryUnsafeError,
  type CodeReportAst,
  type CodeReportEngine,
  type CodeReportNode,
} from './parse';
import { runGovernedMetricQuery, type MetricActor } from '@/lib/metrics/run';
import { serverlessTarget, executeQuery as synapseExecuteQuery } from '@/lib/azure/synapse-sql-client';
import {
  executeQuery as kustoExecuteQuery,
  defaultDatabase as kustoDefaultDatabase,
  kustoConfigGate,
  KustoError,
} from '@/lib/azure/kusto-client';

/** The default engine when a report has no explicit binding. */
export const DEFAULT_CODE_REPORT_ENGINE: CodeReportEngine = 'synapse';

/** A successfully executed query block's tabular result. */
export interface QueryResultOk {
  ok: true;
  name: string;
  kind: 'raw' | 'metric';
  engine: CodeReportEngine;
  dialect: 'synapse' | 'kql';
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionMs: number;
  cached: boolean;
  /** The compiled/executed query text (for the "show SQL" affordance). */
  sql: string;
}

/** A query block that could not run — an honest gate or a query error. */
export interface QueryResultErr {
  ok: false;
  name: string;
  kind: 'raw' | 'metric';
  status: number;
  code?: string;
  missing?: string;
  error: string;
}

export type QueryResult = QueryResultOk | QueryResultErr;

/** The fully-rendered report: the AST + a per-query outcome map. */
export interface RenderedCodeReport {
  nodes: CodeReportNode[];
  /** Outcome per query name (a gate on one block never fails the whole render). */
  results: Record<string, QueryResult>;
  /** The report's bound engine (raw blocks target this unless overridden). */
  engine: CodeReportEngine;
  renderedAt: string;
  /** Query-block counts, for the render audit row. */
  counts: { total: number; metric: number; raw: number; ok: number; failed: number };
}

/** A raw-engine execution outcome (discriminated so gates degrade gracefully). */
export type RawExecOutcome =
  | { ok: true; dialect: 'synapse' | 'kql'; columns: string[]; rows: Record<string, unknown>[]; rowCount: number; executionMs: number }
  | { ok: false; status: number; code?: string; missing?: string; error: string };

/** Injectable execution seams so the renderer is unit-testable without Azure. */
export interface RenderDeps {
  runMetric: typeof runGovernedMetricQuery;
  runRaw: (engine: CodeReportEngine, sql: string) => Promise<RawExecOutcome>;
}

// ── Default (real Azure) raw executor ────────────────────────────────────────

/** Reshape columns + a row-matrix into row objects (report-grid parity). */
function toRecords(columns: string[], rows: unknown[][]): Record<string, unknown>[] {
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      o[c] = r[i];
    });
    return o;
  });
}

/** Execute a raw block on the bound engine (Synapse serverless T-SQL / ADX KQL). */
async function defaultRunRaw(engine: CodeReportEngine, sql: string): Promise<RawExecOutcome> {
  const dialect = engineDialect(engine);
  try {
    assertReadOnlyQuery(sql, dialect);
  } catch (e) {
    if (e instanceof RawQueryUnsafeError) {
      return { ok: false, status: 400, code: 'not_read_only', error: e.message };
    }
    throw e;
  }

  if (engine === 'adx') {
    const gate = kustoConfigGate();
    if (gate) {
      return {
        ok: false,
        status: 503,
        code: 'not_configured',
        missing: gate.missing,
        error: `Azure Data Explorer is not configured for this report's ADX engine — set ${gate.missing}.`,
      };
    }
    try {
      const r = await kustoExecuteQuery(kustoDefaultDatabase(), sql);
      return { ok: true, dialect, columns: r.columns, rows: toRecords(r.columns, r.rows), rowCount: r.rowCount, executionMs: r.executionMs };
    } catch (e) {
      if (e instanceof KustoError) {
        const status = e.status >= 400 && e.status < 600 ? e.status : 502;
        return { ok: false, status, code: 'adx_error', error: `ADX query failed: ${e.message}` };
      }
      throw e;
    }
  }

  // synapse | lakehouse → Synapse serverless T-SQL.
  try {
    const target = serverlessTarget();
    const r = await synapseExecuteQuery(target, sql, 60_000);
    return { ok: true, dialect, columns: r.columns, rows: toRecords(r.columns, r.rows), rowCount: r.rowCount, executionMs: r.executionMs };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const missing = /Missing env var:\s*(LOOM_\w+)/.exec(msg)?.[1];
    if (missing) {
      return {
        ok: false,
        status: 503,
        code: 'not_configured',
        missing,
        error: `The Synapse serverless endpoint for this report is not configured — set ${missing}.`,
      };
    }
    return { ok: false, status: 502, code: 'sql_error', error: `Query failed: ${msg}` };
  }
}

const DEFAULT_DEPS: RenderDeps = { runMetric: runGovernedMetricQuery, runRaw: defaultRunRaw };

// ── Render ───────────────────────────────────────────────────────────────────

/**
 * Parse + execute a code-report. Parsing errors propagate (a
 * {@link import('./parse').CodeReportParseError}) so the route can surface a 400;
 * per-query execution failures become {@link QueryResultErr} entries so a single
 * unconfigured backend degrades to an honest gate instead of failing the page.
 */
export async function renderCodeReport(
  input: { actor: MetricActor; source: string; engine?: CodeReportEngine },
  deps: RenderDeps = DEFAULT_DEPS,
): Promise<RenderedCodeReport> {
  const engine: CodeReportEngine = input.engine ?? DEFAULT_CODE_REPORT_ENGINE;
  const ast: CodeReportAst = parseCodeReport(input.source);
  const results: Record<string, QueryResult> = {};
  let metric = 0;
  let raw = 0;
  let ok = 0;
  let failed = 0;

  for (const q of ast.queries) {
    if (q.kind === 'metric') {
      metric++;
      const outcome = await deps.runMetric(input.actor, {
        metric: q.metric,
        dimensions: q.dimensions,
        filters: q.filters,
        grain: q.grain,
        engine: q.engine ?? engine,
      });
      if (outcome.ok) {
        ok++;
        results[q.name] = {
          ok: true,
          name: q.name,
          kind: 'metric',
          engine: (q.engine ?? engine),
          dialect: outcome.result.dialect,
          columns: outcome.result.columns,
          rows: outcome.result.rows,
          rowCount: outcome.result.rowCount,
          executionMs: outcome.result.executionMs,
          cached: outcome.result.cached,
          sql: outcome.result.sql,
        };
      } else {
        failed++;
        results[q.name] = {
          ok: false,
          name: q.name,
          kind: 'metric',
          status: outcome.status,
          code: outcome.code,
          missing: outcome.missing,
          error: outcome.error,
        };
      }
      continue;
    }

    // Raw block on the bound engine.
    raw++;
    const targetEngine = engine;
    const outcome = await deps.runRaw(targetEngine, q.sql);
    if (outcome.ok) {
      ok++;
      results[q.name] = {
        ok: true,
        name: q.name,
        kind: 'raw',
        engine: targetEngine,
        dialect: outcome.dialect,
        columns: outcome.columns,
        rows: outcome.rows,
        rowCount: outcome.rowCount,
        executionMs: outcome.executionMs,
        cached: false,
        sql: q.sql,
      };
    } else {
      failed++;
      results[q.name] = {
        ok: false,
        name: q.name,
        kind: 'raw',
        status: outcome.status,
        code: outcome.code,
        missing: outcome.missing,
        error: outcome.error,
      };
    }
  }

  return {
    nodes: ast.nodes,
    results,
    engine,
    renderedAt: new Date().toISOString(),
    counts: { total: ast.queries.length, metric, raw, ok, failed },
  };
}
