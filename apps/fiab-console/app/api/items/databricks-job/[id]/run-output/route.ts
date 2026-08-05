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
 *
 * #2997 — THIS IS THE FAMILY'S SECOND PIVOT, and neither issue names it.
 * `runId` is a coordinate in its OWN right: this route never accepted a job
 * parameter at all, so binding `jobId` everywhere else would have left it fully
 * open. What it returns is another tenant's EXECUTION OUTPUT — the notebook
 * return value, the stdout logs, the error trace — which is frequently the data
 * itself. Same shape as the `contextId` pivot #2995 found on the notebook
 * family: live state reachable without ever naming the resource that produced
 * it. The run is now resolved to its parent job (`runs/get`) and that job must
 * be the one this item owns.
 *
 * READ-scoped: the body performs two GETs and writes nothing.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getJobRun, getRunOutput } from '@/lib/azure/databricks-client';
import { authorizeDatabricksJobItem, resolveAuthorizedRunId } from '../../_lib/job-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { item, denied } = await authorizeDatabricksJobItem(id, {
    workspaceId: req.nextUrl.searchParams.get('workspaceId'),
    read: true,
  });
  if (denied) return denied;

  const bound = await resolveAuthorizedRunId(item, id, req.nextUrl.searchParams.get('runId'));
  if (!bound.ok) return NextResponse.json({ ok: false, error: bound.error }, { status: bound.status });

  try {
    const run = await getJobRun(bound.runId);
    // get-output: best-effort. Multi-task parent runs 400 with a message that
    // output must be fetched per task run_id — surface that as a note, not a
    // hard failure, so the run metadata still renders.
    let output: unknown = null;
    let outputNote: string | null = null;
    try {
      output = await getRunOutput(bound.runId);
    } catch (oe: any) {
      outputNote = oe?.message || String(oe);
    }
    return NextResponse.json({ ok: true, run, output, outputNote });
  } catch (e: any) {
    const status = e?.status === 404 ? 404 : e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
