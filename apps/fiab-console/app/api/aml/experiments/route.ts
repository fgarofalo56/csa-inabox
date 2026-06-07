/**
 * GET /api/aml/experiments
 *
 * Top-level MLflow experiment browser for the ML Experiment editor. Unlike
 * /api/items/ml-experiment (which groups AML *jobs* by experimentName), this
 * route talks to the AML MLflow tracking server directly and returns the real
 * MLflow experiment registry — the entities that own runs, params, and metrics.
 *
 * Real backend:
 *   POST <mlflow-base>/api/2.0/mlflow/experiments/search
 * (see lib/azure/mlflow-client.ts for the AML tracking-URI + Learn refs).
 *
 * Optional query: ?filter=<MLflow experiment filter>  &maxResults=<n>
 *
 * Honest gate: returns 200 with { ok: true, configured: false, missing, hint }
 * when the AML workspace / region / LOOM_MLFLOW_TRACKING_URI env isn't set, so
 * the editor renders a Fluent MessageBar naming the variable (IL5 path) instead
 * of an error banner.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  searchExperiments,
  MlflowNotConfiguredError,
  MlflowError,
} from '@/lib/azure/mlflow-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const url = new URL(req.url);
  const filter = url.searchParams.get('filter') || undefined;
  const maxResultsRaw = url.searchParams.get('maxResults');
  const maxResults = maxResultsRaw
    ? Math.max(1, Math.min(1000, Number(maxResultsRaw) || 1000))
    : 1000;

  try {
    const experiments = await searchExperiments({ filter, maxResults });
    return NextResponse.json({ ok: true, configured: true, experiments });
  } catch (e: any) {
    if (e instanceof MlflowNotConfiguredError) {
      return NextResponse.json({
        ok: true,
        configured: false,
        experiments: [],
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
