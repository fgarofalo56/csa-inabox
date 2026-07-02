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
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { debugPipeline } from '@/lib/azure/adf-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const { id } = await ctx.params;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  try {
    const items = await itemsContainer();
    const { resource } = await items.item(id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'data-pipeline') return err('pipeline not found', 404);
    const adfName = (resource.state as any)?.adfPipelineName;
    if (!adfName) return err('Pipeline has no ADF backing — save first', 409);

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
    return err(e?.message || String(e), e?.status || 502);
  }
}
