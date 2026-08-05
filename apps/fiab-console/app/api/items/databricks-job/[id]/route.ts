/**
 * GET    /api/items/databricks-job/[id]?jobId=123   → { ok, job }
 * PUT    /api/items/databricks-job/[id]?jobId=123   body { spec } → { ok }
 * DELETE /api/items/databricks-job/[id]?jobId=123   → { ok }
 *
 * [id] is the Loom item id; the underlying Databricks numeric job id
 * is passed via the `jobId` query parameter so we don't conflate the
 * two id spaces.
 *
 * #2997 — all three handlers used to run on nothing but `getSession()`, with the
 * caller-supplied `jobId` reaching `jobs/get` / `jobs/reset` / `jobs/delete`
 * directly: any signed-in user could read, rewrite, or DELETE another tenant's
 * job in the shared Databricks workspace. Each is now authorized against the job
 * ITEM with its jobId bound to that item (`_lib/job-scope.ts`). Read vs write
 * scope is decided from each HANDLER BODY, not from its verb (#2973).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getJob, updateJob, deleteJob } from '@/lib/azure/databricks-client';
import { loadContentBackedItem, databricksJobFromContent } from '../../_lib/ai-content-fallback';
import { authorizeDatabricksJobItem, resolveAuthorizedJobId, withOwnerTag } from '../_lib/job-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Build the editor's job shape from the installed bundle's DatabricksJobContent
 * (tasks + shared cluster), so a bundle-installed job opens FULLY BUILT-OUT
 * (every chained task + the job cluster) before a live Databricks job exists.
 * Create/Run/Save still target the real workspace.
 */
async function jobContentFallback(id: string, tenantId: string) {
  const item = await loadContentBackedItem(id, 'databricks-job', tenantId);
  if (!item) return null;
  const built = databricksJobFromContent(item);
  return built ? { job: built.job, source: 'bundle' } : null;
}

/**
 * READ-scoped: the body performs a single `jobs/get` (or reads the installed
 * bundle content). Nothing in Databricks is written.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { item, session, denied } = await authorizeDatabricksJobItem(id, {
    workspaceId: req.nextUrl.searchParams.get('workspaceId'),
    read: true,
  });
  if (denied) return denied;

  const jobIdParam = req.nextUrl.searchParams.get('jobId');
  // No live Databricks job id named — surface the bundle definition for this
  // item so the editor seeds its form from the stamped tasks + cluster. The
  // fallback is additionally owner-scoped by `loadContentBackedItem`.
  if (!jobIdParam) {
    const fb = await jobContentFallback(id, session.claims.oid);
    if (fb) return NextResponse.json({ ok: true, ...fb });
  }

  const bound = await resolveAuthorizedJobId(item, id, jobIdParam);
  if (!bound.ok) return NextResponse.json({ ok: false, error: bound.error }, { status: bound.status });

  try {
    const job = await getJob(bound.jobId);
    return NextResponse.json({ ok: true, job });
  } catch (e: any) {
    const status = e?.status === 404 ? 404 : e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

/** WRITE-scoped: `jobs/reset` replaces the job's settings wholesale. */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { item, denied } = await authorizeDatabricksJobItem(id, {
    workspaceId: req.nextUrl.searchParams.get('workspaceId'),
  });
  if (denied) return denied;

  const bound = await resolveAuthorizedJobId(item, id, req.nextUrl.searchParams.get('jobId'));
  if (!bound.ok) return NextResponse.json({ ok: false, error: bound.error }, { status: bound.status });

  const body = await req.json().catch(() => ({}));
  const spec = body?.spec ?? body;
  if (!spec || typeof spec !== 'object')
    return NextResponse.json({ ok: false, error: 'spec is required' }, { status: 400 });
  try {
    // `jobs/reset` REPLACES settings, so a caller-supplied spec that omits tags
    // would silently strip Loom's ownership marker and re-open legacy adoption
    // on this job. Re-stamp on every save — this is already a write path, so no
    // read handler is made to mutate (#2973).
    await updateJob(bound.jobId, withOwnerTag(spec, id));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

/** WRITE-scoped: destroys the job. */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { item, denied } = await authorizeDatabricksJobItem(id, {
    workspaceId: req.nextUrl.searchParams.get('workspaceId'),
  });
  if (denied) return denied;

  const bound = await resolveAuthorizedJobId(item, id, req.nextUrl.searchParams.get('jobId'));
  if (!bound.ok) return NextResponse.json({ ok: false, error: bound.error }, { status: bound.status });

  try {
    await deleteJob(bound.jobId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
