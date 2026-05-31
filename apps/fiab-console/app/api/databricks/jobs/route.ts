/**
 * Jobs on the deployment-default Databricks workspace (the Workspace Resources
 * navigator → Jobs group). Lists/creates/deletes/runs jobs on the workspace via
 * the real Databricks Jobs REST (api 2.1) so the navigator can render counts,
 * ＋ New, run-now and delete.
 *
 *   GET    /api/databricks/jobs            → { ok, jobs: [{job_id, name, tasks}] }
 *   POST   /api/databricks/jobs            body { name } → create empty single-task job
 *          /api/databricks/jobs            body { jobId, action:'run' } → run-now
 *   DELETE /api/databricks/jobs?jobId=N    → delete
 *
 * Honest 503 gate when LOOM_DATABRICKS_HOSTNAME is unset. Real REST. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  databricksConfigGate, listJobs, createJob, deleteJob, runJob,
} from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = databricksConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Databricks workspace not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  try {
    const jobs = (await listJobs(100)).map((j) => ({
      job_id: j.job_id,
      name: j.settings?.name || `job-${j.job_id}`,
      tasks: Array.isArray(j.settings?.tasks) ? j.settings!.tasks!.length : 0,
      creator: j.creator_user_name,
    }));
    return NextResponse.json({ ok: true, jobs });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));

  // run-now path
  if (body?.action === 'run') {
    const jobId = Number(body?.jobId);
    if (!Number.isFinite(jobId)) return NextResponse.json({ ok: false, error: 'jobId is required' }, { status: 400 });
    try {
      const run = await runJob(jobId);
      return NextResponse.json({ ok: true, run });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  const name: string = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  try {
    // Create an empty single-task notebook job placeholder. The full task graph
    // is authored in the Databricks Job editor; this just registers the job so
    // it shows in the navigator and can be opened/edited.
    const created = await createJob({
      name,
      max_concurrent_runs: 1,
      tasks: [],
    });
    return NextResponse.json({ ok: true, job: { job_id: created.job_id, name } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const jobId = Number(req.nextUrl.searchParams.get('jobId'));
  if (!Number.isFinite(jobId)) return NextResponse.json({ ok: false, error: 'jobId query param is required' }, { status: 400 });
  try {
    await deleteJob(jobId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
