/**
 * GET  /api/items/databricks-job                        → { ok, jobs }
 * POST /api/items/databricks-job  body { itemId, spec } → { ok, job_id }
 *
 * #2997 — THE CREATE PATH IS WHERE OWNERSHIP IS ESTABLISHED. Every per-item
 * route in this family authorizes a jobId against the job's own
 * `settings.tags['loom_item_id']` marker (see `_lib/job-scope.ts`), and a job
 * created WITHOUT that marker is adoptable by whichever Loom item claims it
 * first. Leaving this route unowned would therefore have re-opened, for every
 * NEWLY created job, exactly the window the legacy-adoption path exists only to
 * tolerate for jobs that predate the fix.
 *
 * So `itemId` is REQUIRED on POST: the caller is authorized against that item
 * (write-scoped — this creates a job) and the created job is stamped with it.
 * Per `auto-bind-by-default.md` this is the platform doing the binding, not the
 * user: the editor already knows its own item id and now sends it.
 *
 * Both handlers adopt the WS-D1 route-toolkit (`withSession`) rather than
 * hand-rolling the 401, per the route-toolkit boy-scout ratchet. Note that
 * `withSession` is NOT authorization — the POST's authorization is
 * `authorizeDatabricksJobItem` below, and the GET's residual is stated on it.
 */
import { NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { listJobs, createJob } from '@/lib/azure/databricks-client';
import { authorizeDatabricksJobItem, withOwnerTag } from './_lib/job-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The job picker's source list.
 *
 * RESIDUAL, stated plainly: this still returns every job in the shared
 * Databricks workspace, so any signed-in user can see other tenants' job NAMES
 * and schedules. That is metadata disclosure, not access — every route that
 * READS OR ACTS ON a job (`[id]`, `[id]/run`, `[id]/runs`, `[id]/run-output`)
 * binds the id to the caller's item, so a name learned here cannot be driven.
 * Filtering per row is possible (`jobs/list` DOES return `settings.tags`) but
 * needs the caller's full accessible-item set resolved first; tracked as a
 * follow-up rather than half-done here.
 */
export const GET = withSession(async () => {
  try {
    const jobs = await listJobs(100);
    return NextResponse.json({ ok: true, jobs });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: e?.status === 403 ? 403 : 502 },
    );
  }
});

export const POST = withSession(async (req) => {
  const body = await req.json().catch(() => ({}));
  const itemId = typeof body?.itemId === 'string' ? body.itemId.trim() : '';
  if (!itemId) {
    return NextResponse.json(
      { ok: false, error: 'itemId is required — a Databricks job must be created against a Loom job item.' },
      { status: 400 },
    );
  }
  const { denied } = await authorizeDatabricksJobItem(itemId, {
    workspaceId: typeof body?.workspaceId === 'string' ? body.workspaceId : null,
  });
  if (denied) return denied;

  const spec = body?.spec;
  if (!spec || typeof spec !== 'object')
    return NextResponse.json({ ok: false, error: 'spec is required' }, { status: 400 });
  try {
    // Stamped at birth, so this job is never in the adoptable-unmarked state.
    const r = await createJob(withOwnerTag(spec, itemId));
    return NextResponse.json({ ok: true, ...r });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: e?.status === 403 ? 403 : 502 },
    );
  }
});
