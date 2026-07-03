/**
 * POST /api/items/data-pipeline/[id]/debug?workspaceId=...
 *   body: { parameters?, referencePipelineRunId?, startActivityName? }
 *
 * Wraps adf-client.debugPipeline. ADF's createRun with isRecovery=false is
 * the closest first-party equivalent to Fabric's "Debug" button — it
 * dispatches the pipeline using the saved definition and returns runId.
 *
 * Re-runs (Fabric "Re-run from failed activity") use referencePipelineRunId.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { debugPipeline } from '@/lib/azure/adf-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const { id } = await ctx.params;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return apiError('pipeline not found', 404);
  const body = await req.json().catch(() => ({}));
  try {
    const items = await itemsContainer();
    const { resource } = await items.item(id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'data-pipeline') return apiError('pipeline not found', 404);
    const adfName = (resource.state as any)?.adfPipelineName;
    if (!adfName) return apiError('Pipeline has no ADF backing — save first', 409);

    const result = await debugPipeline(adfName, body?.parameters || {}, {
      referencePipelineRunId: body?.referencePipelineRunId,
      startActivityName: body?.startActivityName,
    });
    return NextResponse.json({
      ok: true,
      runId: result.runId,
      adfPipelineName: adfName,
      mode: 'debug',
      status: 'Queued',
    });
  } catch (e: any) {
    return apiError(e?.message || String(e), e?.status || 502);
  }
}
