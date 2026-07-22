/**
 * GET /api/aml/runs/[runId]/artifacts?path=<dir>
 *
 * Lists the artifacts logged under an MLflow run (one directory level). Backs
 * the ML Experiment editor's run-detail "Artifacts" tree — expanding a folder
 * re-calls this route with ?path=<folder>.
 *
 * Real backend:
 *   GET <mlflow-base>/api/2.0/mlflow/artifacts/list
 * (see lib/azure/mlflow-client.ts).
 *
 * Honest gate: 200 with { ok: true, configured: false, missing, hint } when the
 * AML env / LOOM_MLFLOW_TRACKING_URI isn't set.
 */
import { NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import {
  listArtifacts,
  MlflowNotConfiguredError,
  MlflowError,
} from '@/lib/azure/mlflow-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession<{ runId: string }>(async (req, { params }) => {
  const runId = decodeURIComponent(params.runId);
  const path = new URL(req.url).searchParams.get('path') || undefined;

  try {
    const artifacts = await listArtifacts(runId, path);
    return NextResponse.json({ ok: true, configured: true, runId, path: path || '', artifacts });
  } catch (e: any) {
    if (e instanceof MlflowNotConfiguredError) {
      return NextResponse.json({
        ok: true,
        configured: false,
        runId,
        artifacts: [],
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
});
