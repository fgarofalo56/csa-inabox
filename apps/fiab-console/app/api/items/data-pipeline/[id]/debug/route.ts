/**
 * POST /api/items/data-pipeline/[id]/debug?workspaceId=...
 *   body: { parameters?, referencePipelineRunId?, startActivityName?, startFromFailure? }
 *
 * Wraps adf-client.debugPipeline. ADF's createRun with isRecovery=false is
 * the closest first-party equivalent to Fabric's "Debug" button — it
 * dispatches the pipeline using the saved definition and returns runId.
 *
 * Re-runs (Fabric "Re-run from failed activity") use referencePipelineRunId
 * (+ startFromFailure / startActivityName for the U13 in-canvas rerun actions).
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { debugPipeline } from '@/lib/azure/adf-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const { id } = params;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, session.claims.oid))) return apiError('pipeline not found', 404);
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
      // Recovery-only: rerun just the failed activities of the referenced run.
      startFromFailure: body?.startFromFailure === true,
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
});
