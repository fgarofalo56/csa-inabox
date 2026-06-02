/**
 * GET /api/items/ml-experiment/[id]/runs/[runId]/metrics
 *
 * Per-run metric data from the AML MLflow tracking server:
 *   - the run's last-value metric set (so the UI knows which metric keys exist), and
 *   - the full step/value/timestamp history for a chosen metric key.
 *
 * Query:
 *   ?metricKey=<key>   → return that metric's full history (for the chart)
 *   (omitted)          → return the run + its available metric keys only
 *
 * Real backend:
 *   GET <mlflow-base>/api/2.0/mlflow/runs/get
 *   GET <mlflow-base>/api/2.0/mlflow/metrics/get-history
 *
 * Honest gate: returns { ok: true, configured: false, hint } when the AML
 * workspace/region env isn't set, so the editor renders a MessageBar.
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

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; runId: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { runId: runIdRaw } = await ctx.params;
  const runId = decodeURIComponent(runIdRaw);
  const metricKey = new URL(req.url).searchParams.get('metricKey') || undefined;

  try {
    const run = await getRun(runId);
    if (!run) {
      return NextResponse.json({ ok: false, error: `Run "${runId}" not found`, status: 404 }, { status: 404 });
    }
    const metricKeys = Array.from(new Set(run.metrics.map((m) => m.key))).sort();

    if (metricKey) {
      const history = await getMetricHistory(runId, metricKey);
      return NextResponse.json({ ok: true, configured: true, runId, run, metricKeys, metricKey, history });
    }
    return NextResponse.json({ ok: true, configured: true, runId, run, metricKeys });
  } catch (e: any) {
    if (e instanceof MlflowNotConfiguredError) {
      return NextResponse.json({
        ok: true,
        configured: false,
        runId,
        run: null,
        metricKeys: [],
        missing: e.missing,
        hint: e.hint,
      });
    }
    const status = e instanceof MlflowError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
