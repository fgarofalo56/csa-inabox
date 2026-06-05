/**
 * GET    /api/items/databricks-job/[id]?jobId=123   → { ok, job }
 * PUT    /api/items/databricks-job/[id]?jobId=123   body { spec } → { ok }
 * DELETE /api/items/databricks-job/[id]?jobId=123   → { ok }
 *
 * [id] is the Loom item id; the underlying Databricks numeric job id
 * is passed via the `jobId` query parameter so we don't conflate the
 * two id spaces.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getJob, updateJob, deleteJob } from '@/lib/azure/databricks-client';
import { loadContentBackedItem, databricksJobFromContent } from '../../_lib/ai-content-fallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function jobIdFrom(req: NextRequest): number | null {
  const v = req.nextUrl.searchParams.get('jobId');
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

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

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const jobId = jobIdFrom(req);
  // No live Databricks job id — surface the bundle definition for this item so
  // the editor seeds its form from the stamped tasks + cluster.
  if (jobId === null) {
    const fb = await jobContentFallback(id, session.claims.oid);
    if (fb) return NextResponse.json({ ok: true, ...fb });
    return NextResponse.json({ ok: false, error: 'jobId is required' }, { status: 400 });
  }
  try {
    const job = await getJob(jobId);
    return NextResponse.json({ ok: true, job });
  } catch (e: any) {
    const status = e?.status === 404 ? 404 : e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function PUT(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const jobId = jobIdFrom(req);
  if (jobId === null)
    return NextResponse.json({ ok: false, error: 'jobId is required' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const spec = body?.spec ?? body;
  if (!spec || typeof spec !== 'object')
    return NextResponse.json({ ok: false, error: 'spec is required' }, { status: 400 });
  try {
    await updateJob(jobId, spec);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const jobId = jobIdFrom(req);
  if (jobId === null)
    return NextResponse.json({ ok: false, error: 'jobId is required' }, { status: 400 });
  try {
    await deleteJob(jobId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
