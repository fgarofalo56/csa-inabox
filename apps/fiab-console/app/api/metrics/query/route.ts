/**
 * POST /api/metrics/query — the headless metrics layer's ONE query endpoint (N15).
 *
 * Body: { metric, dimensions?, filters?, grain?, engine? }
 *   • metric      — the governed metric name/id (from the imported MetricFlow spec)
 *   • dimensions  — group-by dimensions (each whitelisted against the model)
 *   • filters     — structured predicates [{ dimension, op, value }] (bound/escaped)
 *   • grain       — time-grain override for the first time dimension
 *   • engine      — 'synapse' (default) | 'lakehouse' | 'adx'
 *
 * The heavy lifting (resolve governed spec → compile NATIVELY → execute on the
 * REAL backend → cache → audit) lives in {@link runGovernedMetricQuery}, the ONE
 * server-side execute path the report designer's metric visuals ALSO call — so a
 * metric returns the identical number here, in a report, and in a Copilot answer
 * (the Copilot NL2SQL path grounds on the SAME compiled SQL). NO runtime
 * MetricFlow engine — Loom's own compiler emits the SQL.
 *
 * IL5 / MOAT: the compiled query runs entirely in-boundary (Synapse / ADX Gov-GA)
 * — a metric compiles + serves with zero external egress.
 *
 * Auth: withSession (no generic — the route-guard ratchet matches `withSession(`).
 * Owner-scoped: the spec + metric registry are the caller's own (session oid).
 */

import type { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { METRIC_ENGINES, type MetricEngine, type MetricFilter } from '@/lib/metrics/metric-compiler';
import { runGovernedMetricQuery } from '@/lib/metrics/run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The N15 FLAG0 kill-switch id (also registered in lib/admin/runtime-flags.ts). */
const METRICS_FLAG_ID = 'n15-metrics-layer';

interface MetricsQueryBody {
  metric?: unknown;
  dimensions?: unknown;
  filters?: unknown;
  grain?: unknown;
  engine?: unknown;
}

function parseEngine(v: unknown): MetricEngine {
  return typeof v === 'string' && (METRIC_ENGINES as readonly string[]).includes(v)
    ? (v as MetricEngine)
    : 'synapse';
}

/** Coerce request `filters` into typed predicates (the compiler re-validates names). */
function parseFilters(v: unknown): MetricFilter[] {
  if (!Array.isArray(v)) return [];
  const out: MetricFilter[] = [];
  const ops = new Set(['=', '!=', '>', '>=', '<', '<=', 'in']);
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const dimension = typeof r.dimension === 'string' ? r.dimension.trim() : '';
    const op = typeof r.op === 'string' && ops.has(r.op) ? (r.op as MetricFilter['op']) : '=';
    if (!dimension) continue;
    const value = r.value as MetricFilter['value'];
    if (value === undefined || value === null) continue;
    out.push({ dimension, op, value });
  }
  return out;
}

function parseDimensions(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
}

export const POST = withSession(async (req: NextRequest, { session }) => {
  // FLAG0 kill-switch (default-ON). OFF → guided "turned off" gate; the report +
  // NL paths fall back to their pre-N15 direct compile.
  if (!(await runtimeFlag(METRICS_FLAG_ID, { default: true }))) {
    return apiError('The headless metrics layer is turned off (admin → runtime flags).', 503, {
      code: 'metrics_layer_off',
    });
  }

  const body = (await req.json().catch(() => ({}))) as MetricsQueryBody;
  const metric = typeof body.metric === 'string' ? body.metric.trim() : '';
  if (!metric) return apiError('metric is required', 400);

  try {
    const outcome = await runGovernedMetricQuery(
      {
        oid: session.claims.oid,
        who: session.claims.upn || session.claims.oid,
        tenantId: session.claims.tid || session.claims.oid,
      },
      {
        metric,
        dimensions: parseDimensions(body.dimensions),
        filters: parseFilters(body.filters),
        grain: typeof body.grain === 'string' ? body.grain.trim() : undefined,
        engine: parseEngine(body.engine),
      },
    );
    if (!outcome.ok) {
      return apiError(outcome.error, outcome.status, {
        ...(outcome.code ? { code: outcome.code } : {}),
        ...(outcome.missing ? { missing: outcome.missing } : {}),
      });
    }
    return apiOk({ ...outcome.result });
  } catch (e) {
    return apiServerError(e);
  }
});
