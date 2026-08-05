/**
 * GET /api/items/databricks-job/[id]/runs?jobId=123  → { ok, runs }
 *
 * #2997 — this ran on `getSession()` alone, and when `jobId` was OMITTED it
 * called `listJobRuns(undefined)`, which lists recent runs across the ENTIRE
 * shared Databricks workspace — every tenant's run history, their job names,
 * their failure messages. The jobId is now always bound to the item, so an
 * omitted parameter narrows to this item's own job instead of widening to the
 * whole workspace.
 *
 * READ-scoped: the body is a single `jobs/runs/list`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { listJobRuns } from '@/lib/azure/databricks-client';
import { authorizeDatabricksJobItem, resolveAuthorizedJobId } from '../../_lib/job-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { item, denied } = await authorizeDatabricksJobItem(id, {
    workspaceId: req.nextUrl.searchParams.get('workspaceId'),
    read: true,
  });
  if (denied) return denied;

  const bound = await resolveAuthorizedJobId(item, id, req.nextUrl.searchParams.get('jobId'));
  if (!bound.ok) return NextResponse.json({ ok: false, error: bound.error }, { status: bound.status });

  try {
    const runs = await listJobRuns(bound.jobId, 25);
    return NextResponse.json({ ok: true, runs });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
