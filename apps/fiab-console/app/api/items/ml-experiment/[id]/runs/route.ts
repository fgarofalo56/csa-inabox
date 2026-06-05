/**
 * GET /api/items/ml-experiment/[id]/runs
 *
 * Lists the MLflow runs for this experiment (with their last-value metrics,
 * params, and status) via the AML MLflow tracking REST server.
 *
 * `id` is the experiment NAME (the editor opens experiments by name) OR a job
 * name. We resolve the experiment by name; if it isn't found we still return a
 * structured (empty) result so the editor renders without crashing.
 *
 * Optional query: ?filter=<MLflow filter string>  &maxResults=<n>
 *
 * Real backend:
 *   GET  <mlflow-base>/api/2.0/mlflow/experiments/get-by-name
 *   POST <mlflow-base>/api/2.0/mlflow/runs/search
 * (see lib/azure/mlflow-client.ts for the AML tracking-URI + Learn refs).
 *
 * Honest gate: when the AML workspace/region env isn't configured we return
 * 200 with { ok: true, configured: false, hint } so the editor shows a
 * Fluent MessageBar instead of an error banner.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  searchRunsByExperimentName,
  MlflowNotConfiguredError,
  MlflowError,
} from '@/lib/azure/mlflow-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const experimentName = decodeURIComponent((await ctx.params).id);
  const url = new URL(req.url);
  const filter = url.searchParams.get('filter') || undefined;
  const maxResultsRaw = url.searchParams.get('maxResults');
  const maxResults = maxResultsRaw ? Math.max(1, Math.min(1000, Number(maxResultsRaw) || 200)) : 200;

  try {
    const { experiment, runs } = await searchRunsByExperimentName(experimentName, { filter, maxResults });
    return NextResponse.json({
      ok: true,
      configured: true,
      experimentName,
      experiment,
      runs,
    });
  } catch (e: any) {
    if (e instanceof MlflowNotConfiguredError) {
      return NextResponse.json({
        ok: true,
        configured: false,
        experimentName,
        experiment: null,
        runs: [],
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
