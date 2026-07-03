/**
 * GET /api/items/data-pipeline/[id]/jobs?workspaceId=...
 *   Returns recent ADF pipeline runs for this Loom pipeline.
 *
 * v3.25: queries ADF pipeline runs filtered to the pipeline name.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { listPipelineRuns } from '@/lib/azure/adf-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return apiError('pipeline not found', 404);
  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'data-pipeline') return apiError('pipeline not found', 404);
    const adfName = (resource.state as any)?.adfPipelineName;
    if (!adfName) return NextResponse.json({ ok: true, jobs: [] });
    const runs = await listPipelineRuns(adfName);
    return NextResponse.json({
      ok: true,
      jobs: ((runs as any).value || runs || []).map((r: any) => ({
        id: r.runId,
        status: r.status,
        runStart: r.runStart,
        runEnd: r.runEnd,
        durationMs: r.durationInMs,
        message: r.message,
      })),
    });
  } catch (e: any) {
    return apiError(e?.message || String(e), e?.status || 502);
  }
}
