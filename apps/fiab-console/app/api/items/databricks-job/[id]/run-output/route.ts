/**
 * GET /api/items/databricks-job/[id]/run-output?runId=456
 *   → { ok, run, output }
 *
 * Real backend:
 *   - GET /api/2.1/jobs/runs/get?run_id=...        (run metadata + task states)
 *   - GET /api/2.1/jobs/runs/get-output?run_id=... (notebook output / logs / error)
 *
 * Surfaces the result of a single run so the editor can show live status and
 * the actual task output (notebook return value, stdout logs, error trace).
 * `get-output` only works for single-task runs; for a multi-task run we still
 * return the run metadata and a precise note so the UI can explain why output
 * is per-task (Databricks requires a task run_id, not the parent run_id).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getJobRun, getRunOutput } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const runIdStr = req.nextUrl.searchParams.get('runId');
  const runId = runIdStr ? Number(runIdStr) : NaN;
  if (!Number.isFinite(runId))
    return NextResponse.json({ ok: false, error: 'runId is required' }, { status: 400 });
  try {
    const run = await getJobRun(runId);
    // get-output: best-effort. Multi-task parent runs 400 with a message that
    // output must be fetched per task run_id — surface that as a note, not a
    // hard failure, so the run metadata still renders.
    let output: unknown = null;
    let outputNote: string | null = null;
    try {
      output = await getRunOutput(runId);
    } catch (oe: any) {
      outputNote = oe?.message || String(oe);
    }
    return NextResponse.json({ ok: true, run, output, outputNote });
  } catch (e: any) {
    const status = e?.status === 404 ? 404 : e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
