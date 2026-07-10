/**
 * Schedule-as-a-job for the Databricks notebook (R4-DBX-1).
 *
 * Wires the editor's long-promised "schedule the notebook as a job" to the real
 * Databricks Jobs API (api/2.1/jobs). A job runs a single notebook_task on an
 * existing all-purpose cluster (or a job cluster the workspace already owns),
 * optionally on a Quartz cron schedule.
 *
 *   GET    ?path=/Workspace/foo         → jobs whose task targets this notebook
 *   POST   { path, clusterId, cron?, timezoneId?, name?, params?, paused? }
 *                                        → create the job  → { ok, job_id }
 *   PATCH  { jobId, action: 'pause'|'unpause'|'run', params? }
 *                                        → pause/resume the schedule OR run-now
 *   DELETE ?jobId=123                    → delete the job
 *
 * Backend: jobs/create, jobs/list, jobs/get, jobs/reset, jobs/run-now,
 * jobs/delete — all real REST calls in databricks-client. Honest 503 when the
 * workspace hostname isn't configured (no-vaporware.md).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  databricksConfigGate,
  listJobs,
  getJob,
  createJob,
  updateJob,
  deleteJob,
  runJob,
  listJobRuns,
  type Job,
  type JobSpec,
} from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The notebook_path this job's first task targets, if it's a notebook job. */
function jobNotebookPath(job: Job): string | undefined {
  const tasks = (job.settings?.tasks as any[]) || [];
  for (const t of tasks) {
    const p = t?.notebook_task?.notebook_path;
    if (typeof p === 'string') return p;
  }
  return undefined;
}

function notConfigured() {
  const gate = databricksConfigGate();
  if (!gate) return null;
  return NextResponse.json(
    { ok: false, code: 'not_configured', error: `Databricks workspace not configured: set ${gate.missing}.`, missing: gate.missing },
    { status: 503 },
  );
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const gate = notConfigured();
  if (gate) return gate;
  const path = (req.nextUrl.searchParams.get('path') || '').trim();
  try {
    const jobs = await listJobs(100);
    const matched = path ? jobs.filter((j) => jobNotebookPath(j) === path) : jobs.filter((j) => !!jobNotebookPath(j));
    // Enrich each matched job with its most-recent run + schedule summary.
    const out = await Promise.all(
      matched.map(async (j) => {
        let lastRun: any = null;
        try {
          const runs = await listJobRuns(j.job_id, 1);
          lastRun = runs[0] || null;
        } catch { /* run list is best-effort */ }
        const sched = j.settings?.schedule;
        return {
          job_id: j.job_id,
          name: j.settings?.name,
          notebook_path: jobNotebookPath(j),
          cron: sched?.quartz_cron_expression,
          timezone_id: sched?.timezone_id,
          pause_status: sched?.pause_status,
          creator_user_name: j.creator_user_name,
          created_time: j.created_time,
          last_run: lastRun
            ? { run_id: lastRun.run_id, life_cycle_state: lastRun.state?.life_cycle_state, result_state: lastRun.state?.result_state, start_time: lastRun.start_time }
            : null,
        };
      }),
    );
    return NextResponse.json({ ok: true, jobs: out });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status === 403 ? 403 : 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const gate = notConfigured();
  if (gate) return gate;
  const body = await req.json().catch(() => ({}));
  const path = (body?.path || '').toString().trim();
  const clusterId = (body?.clusterId || '').toString().trim();
  const cron = (body?.cron || '').toString().trim();
  const timezoneId = (body?.timezoneId || 'UTC').toString().trim();
  const name = (body?.name || '').toString().trim() || `loom-${path.split('/').pop() || 'notebook'}`;
  const params = (body?.params && typeof body.params === 'object') ? body.params as Record<string, string> : {};
  const paused = !!body?.paused;
  if (!path) return NextResponse.json({ ok: false, error: 'path is required' }, { status: 400 });
  if (!clusterId) return NextResponse.json({ ok: false, error: 'clusterId is required' }, { status: 400 });

  const spec: JobSpec = {
    name,
    tasks: [
      {
        task_key: 'notebook',
        existing_cluster_id: clusterId,
        notebook_task: { notebook_path: path, base_parameters: params },
      },
    ],
    max_concurrent_runs: 1,
  };
  if (cron) {
    spec.schedule = {
      quartz_cron_expression: cron,
      timezone_id: timezoneId,
      pause_status: paused ? 'PAUSED' : 'UNPAUSED',
    };
  }
  try {
    const { job_id } = await createJob(spec);
    return NextResponse.json({ ok: true, job_id });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status === 403 ? 403 : 502 });
  }
}

export async function PATCH(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const gate = notConfigured();
  if (gate) return gate;
  const body = await req.json().catch(() => ({}));
  const jobId = Number(body?.jobId);
  const action = (body?.action || '').toString();
  if (!Number.isFinite(jobId)) return NextResponse.json({ ok: false, error: 'jobId is required' }, { status: 400 });
  try {
    if (action === 'run') {
      const params = (body?.params && typeof body.params === 'object') ? body.params as Record<string, string> : undefined;
      const r = await runJob(jobId, params ? { notebook_params: params } : undefined);
      return NextResponse.json({ ok: true, run_id: r.run_id });
    }
    if (action === 'pause' || action === 'unpause') {
      const job = await getJob(jobId);
      const settings = { ...(job.settings || {}) } as JobSpec;
      if (!settings.schedule?.quartz_cron_expression) {
        return NextResponse.json({ ok: false, error: 'This job has no schedule to pause/resume. Add a cron schedule first.' }, { status: 400 });
      }
      settings.schedule = { ...settings.schedule, pause_status: action === 'pause' ? 'PAUSED' : 'UNPAUSED' };
      await updateJob(jobId, settings);
      return NextResponse.json({ ok: true, pause_status: settings.schedule.pause_status });
    }
    return NextResponse.json({ ok: false, error: `unknown action: ${action}` }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status === 403 ? 403 : 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const gate = notConfigured();
  if (gate) return gate;
  const jobId = Number(req.nextUrl.searchParams.get('jobId'));
  if (!Number.isFinite(jobId)) return NextResponse.json({ ok: false, error: 'jobId is required' }, { status: 400 });
  try {
    await deleteJob(jobId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status === 403 ? 403 : 502 });
  }
}
