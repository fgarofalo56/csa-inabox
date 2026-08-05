/**
 * Schedule-as-a-job for the Databricks notebook (R4-DBX-1).
 *
 * Wires the editor's long-promised "schedule the notebook as a job" to the real
 * Databricks Jobs API (api/2.1/jobs). A job runs a single notebook_task on an
 * existing all-purpose cluster (or a job cluster the workspace already owns),
 * optionally on a Quartz cron schedule.
 *
 *   GET    ?path=/Workspace/foo         → jobs whose task targets this notebook
 *   POST   { path, clusterId?, cron?, timezoneId?, name?, params?, paused? }
 *                                        → create the job  → { ok, job_id }
 *   PATCH  { jobId, action: 'pause'|'unpause'|'run', params? }
 *                                        → pause/resume the schedule OR run-now
 *   DELETE ?jobId=123                    → delete the job
 *
 * Backend: jobs/create, jobs/list, jobs/get, jobs/reset, jobs/run-now,
 * jobs/delete — all real REST calls in databricks-client. Honest 503 when the
 * workspace hostname isn't configured (no-vaporware.md).
 *
 * SECURITY (#2988). This route is the canonical example of "authorizing the
 * caller is NOT sufficient". It already had LAYER 1 — every handler ran
 * `loadOwnedItem` — and was still exploitable, because NO handler bound the
 * coordinate it acted on:
 *
 *   * POST took a caller-chosen `notebook_path` AND `existing_cluster_id`, so an
 *     authorized caller could create a job that runs ANOTHER TENANT'S notebook,
 *     on a cluster of their choosing, on a cron — i.e. persistent, scheduled,
 *     cross-tenant code execution.
 *   * PATCH/DELETE took a bare `jobId`, so any job in the shared workspace could
 *     be run-now, paused, or deleted regardless of whose notebook it runs.
 *   * GET with no `path` listed EVERY notebook job in the shared workspace,
 *     leaking other tenants' job names, notebook paths, and creators.
 *
 * Layer 1 is also upgraded from `loadOwnedItem` to the canonical
 * `authorizeItemWorkspace` ladder (via {@link authorizeNotebookItem}). Per #2947
 * an owner-only check answers "did this caller CREATE it", not "may this caller
 * ACCESS it", so a tenant admin or shared-ACL member was wrongly refused — the
 * same defect that shipped two broken editors (#2941, #2942). The replacement is
 * WRITE-scoped, so it remains strictly stronger than a read guard on the
 * mutating handlers; the read-only GET is held to the same bar because listing a
 * notebook's schedules is not a surface a read-only Viewer needs.
 */
import { NextRequest, NextResponse } from 'next/server';
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
import { scopeDbxNotebookPath } from '../../_lib/notebook-path-scope';
import { authorizeNotebookItem, resolveAuthorizedClusterId } from '../../_lib/notebook-exec-scope';
import type { WorkspaceItem } from '@/lib/types/workspace';

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

/** Is this job one THIS notebook item is allowed to act on? True only when its
 *  notebook_task targets a path inside the item's own scope. A job with no
 *  notebook task has no path to bind, so it is never in scope. */
function jobInScope(job: Job, item: WorkspaceItem, itemId: string): boolean {
  const p = jobNotebookPath(job);
  if (!p) return false;
  return scopeDbxNotebookPath(item, itemId, p).ok;
}

/**
 * Resolve a caller-supplied `jobId` to a job THIS item may act on, or the
 * response to return. Fails closed on a lookup error — an unverifiable job is
 * not an authorized one — and returns the route's existing 404 wording for an
 * out-of-scope job so it does not leak which job ids exist.
 */
async function loadScopedJob(
  jobId: number,
  item: WorkspaceItem,
  itemId: string,
): Promise<{ job: Job; denied?: undefined } | { job?: undefined; denied: NextResponse }> {
  let job: Job;
  try {
    job = await getJob(jobId);
  } catch (e: any) {
    const status = e?.status === 404 ? 404 : e?.status === 403 ? 403 : 502;
    return { denied: NextResponse.json({ ok: false, error: e?.message || String(e) }, { status }) };
  }
  if (!jobInScope(job, item, itemId)) {
    return { denied: NextResponse.json({ ok: false, error: 'not found' }, { status: 404 }) };
  }
  return { job };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { item, denied } = await authorizeNotebookItem(id, req.nextUrl.searchParams.get('workspaceId'));
  if (denied) return denied;
  const gate = notConfigured();
  if (gate) return gate;
  const path = (req.nextUrl.searchParams.get('path') || '').trim();
  try {
    const jobs = await listJobs(100);
    // Bind the listing to this item's own scope FIRST, so the no-`path` branch
    // can no longer enumerate every notebook job in the shared workspace. A
    // caller-supplied `path` then narrows further, but only within that scope.
    const inScope = jobs.filter((j) => jobInScope(j, item, id));
    const matched = path ? inScope.filter((j) => jobNotebookPath(j) === path) : inScope;
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

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const { item, denied } = await authorizeNotebookItem(
    id,
    body?.workspaceId ?? req.nextUrl.searchParams.get('workspaceId'),
  );
  if (denied) return denied;
  const gate = notConfigured();
  if (gate) return gate;
  const cron = (body?.cron || '').toString().trim();
  const timezoneId = (body?.timezoneId || 'UTC').toString().trim();
  const params = (body?.params && typeof body.params === 'object') ? body.params as Record<string, string> : {};
  const paused = !!body?.paused;

  // LAYER 2 — the scheduled notebook must be THIS item's own, and the cluster
  // must be one this workspace is entitled to run. Without both, an authorized
  // caller schedules another tenant's notebook (the defect #2988 names).
  const scoped = scopeDbxNotebookPath(item, id, body?.path);
  if (!scoped.ok) {
    return NextResponse.json({ ok: false, error: scoped.error }, { status: scoped.status });
  }
  const cluster = await resolveAuthorizedClusterId(body?.clusterId, { autoStart: false });
  if (!cluster.ok) {
    return NextResponse.json(
      { ok: false, error: cluster.error, ...(cluster.remediation ? { remediation: cluster.remediation } : {}) },
      { status: cluster.status },
    );
  }
  const name = (body?.name || '').toString().trim() || `loom-${scoped.path.split('/').pop() || 'notebook'}`;

  const spec: JobSpec = {
    name,
    tasks: [
      {
        task_key: 'notebook',
        existing_cluster_id: cluster.clusterId,
        notebook_task: { notebook_path: scoped.path, base_parameters: params },
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
    return NextResponse.json({ ok: true, job_id, notebook_path: scoped.path, clusterId: cluster.clusterId });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status === 403 ? 403 : 502 });
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const { item, denied } = await authorizeNotebookItem(
    id,
    body?.workspaceId ?? req.nextUrl.searchParams.get('workspaceId'),
  );
  if (denied) return denied;
  const gate = notConfigured();
  if (gate) return gate;
  const jobId = Number(body?.jobId);
  const action = (body?.action || '').toString();
  if (!Number.isFinite(jobId)) return NextResponse.json({ ok: false, error: 'jobId is required' }, { status: 400 });

  // LAYER 2 — `jobId` is a caller-chosen coordinate. Bind it to this item before
  // running, pausing, or resuming it.
  const { job, denied: outOfScope } = await loadScopedJob(jobId, item, id);
  if (outOfScope) return outOfScope;

  try {
    if (action === 'run') {
      const params = (body?.params && typeof body.params === 'object') ? body.params as Record<string, string> : undefined;
      const r = await runJob(jobId, params ? { notebook_params: params } : undefined);
      return NextResponse.json({ ok: true, run_id: r.run_id });
    }
    if (action === 'pause' || action === 'unpause') {
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

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { item, denied } = await authorizeNotebookItem(id, req.nextUrl.searchParams.get('workspaceId'));
  if (denied) return denied;
  const gate = notConfigured();
  if (gate) return gate;
  const jobId = Number(req.nextUrl.searchParams.get('jobId'));
  if (!Number.isFinite(jobId)) return NextResponse.json({ ok: false, error: 'jobId is required' }, { status: 400 });

  // LAYER 2 — deleting a job is destructive; bind it to this item first.
  const { denied: outOfScope } = await loadScopedJob(jobId, item, id);
  if (outOfScope) return outOfScope;

  try {
    await deleteJob(jobId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status === 403 ? 403 : 502 });
  }
}
