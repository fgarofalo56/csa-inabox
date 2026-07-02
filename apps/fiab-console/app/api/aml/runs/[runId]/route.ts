/**
 * POST /api/aml/runs/[runId]   — run lifecycle actions (real MLflow REST):
 *   { action: 'delete' }   → runs/delete   (soft-delete, lifecycle DELETED)
 *   { action: 'restore' }  → runs/restore  (un-archive)
 *   { action: 'archive' }  → runs/set-tag  + runs/delete  (mark + soft-delete)
 *   { action: 'clone' }    → runs/create + log-batch (copy params/tags)
 *
 * Honest gate: 200 { ok:true, configured:false, hint } when MLflow tracking
 * isn't configured. Backs the ML Experiment editor's run row actions.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  deleteRun, restoreRun, setRunTag, cloneRun,
  MlflowNotConfiguredError, MlflowError,
} from '@/lib/azure/mlflow-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const runId = decodeURIComponent((await ctx.params).runId);
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || '');
  try {
    if (action === 'delete') { await deleteRun(runId); return NextResponse.json({ ok: true, message: `Run ${runId} deleted.` }); }
    if (action === 'restore') { await restoreRun(runId); return NextResponse.json({ ok: true, message: `Run ${runId} restored.` }); }
    if (action === 'archive') {
      await setRunTag(runId, 'loom.archived', new Date().toISOString());
      await deleteRun(runId);
      return NextResponse.json({ ok: true, message: `Run ${runId} archived.` });
    }
    if (action === 'clone') { const run = await cloneRun(runId); return NextResponse.json({ ok: true, run, message: `Cloned to run ${run.runId}.` }); }
    return NextResponse.json({ ok: false, error: `unknown action "${action}"` }, { status: 400 });
  } catch (e: any) {
    if (e instanceof MlflowNotConfiguredError) return NextResponse.json({ ok: true, configured: false, hint: e.hint, missing: e.missing });
    const status = e instanceof MlflowError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
