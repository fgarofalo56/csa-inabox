/**
 * GET /api/aml/runs/[runId]/metrics?metricKey=<key>
 *
 * Per-run metric data from the AML MLflow tracking server. Backs the ML
 * Experiment editor's run-detail metric step charts and the compare-runs
 * overlaid chart (each run's full step/value series).
 *
 * Query:
 *   ?metricKey=<key>   → full step/value/timestamp history for that metric
 *   (omitted)          → the run + its available metric keys only
 *
 * Real backend:
 *   GET <mlflow-base>/api/2.0/mlflow/runs/get
 *   GET <mlflow-base>/api/2.0/mlflow/metrics/get-history
 * (see lib/azure/mlflow-client.ts).
 *
 * Honest gate: 200 with { ok: true, configured: false, missing, hint } when the
 * AML env / LOOM_MLFLOW_TRACKING_URI isn't set.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getRun,
  getMetricHistory,
  MlflowNotConfiguredError,
  MlflowError,
} from '@/lib/azure/mlflow-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { runId: runIdRaw } = await ctx.params;
  const runId = decodeURIComponent(runIdRaw);
  const metricKey = new URL(req.url).searchParams.get('metricKey') || undefined;

  try {
    if (metricKey) {
      const history = await getMetricHistory(runId, metricKey);
      return NextResponse.json({ ok: true, configured: true, runId, metricKey, history });
    }
    const run = await getRun(runId);
    if (!run) {
      return NextResponse.json({ ok: false, error: `Run "${runId}" not found` }, { status: 404 });
    }
    const metricKeys = Array.from(new Set(run.metrics.map((m) => m.key))).sort();
    return NextResponse.json({ ok: true, configured: true, runId, run, metricKeys });
  } catch (e: any) {
    if (e instanceof MlflowNotConfiguredError) {
      return NextResponse.json({
        ok: true,
        configured: false,
        runId,
        run: null,
        metricKeys: [],
        history: [],
        missing: e.missing,
        hint: e.hint,
      });
    }
    const status = e instanceof MlflowError ? e.status : 502;
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), body: e?.body },
      { status },
    );
  }
}
