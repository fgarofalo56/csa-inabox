/**
 * POST /api/items/data-pipeline/[id]/run?workspaceId=...
 *   body: { parameters?: Record<string, unknown> }
 *
 * v3.25: dispatches to the underlying ADF pipeline.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { runPipeline } from '@/lib/azure/adf-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) { return NextResponse.json({ ok: false, error }, { status }); }

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'data-pipeline') return err('pipeline not found', 404);
    const adfName = (resource.state as any)?.adfPipelineName;
    if (!adfName) {
      // Honest gate: bundle-installed pipeline whose activity graph opens
      // fully built-out from state.content, but which has not been deployed
      // to a live ADF factory yet (e.g. app install gated on "No bound
      // Fabric workspace"). Surface a structured, actionable gate instead of
      // a raw 500 so the editor can prompt the user to deploy/publish first.
      return NextResponse.json({
        ok: false,
        gate: {
          reason: 'This pipeline is not yet backed by a live Azure Data Factory pipeline.',
          remediation:
            'Open the pipeline in the editor and click Save/Publish to deploy its activities to ADF, then Run. ' +
            'If ADF is not configured in this deployment, set LOOM_ADF_FACTORY / LOOM_ADF_RESOURCE_GROUP and grant the console UAMI the Data Factory Contributor role.',
        },
        error: 'Pipeline has no ADF backing yet — publish it to ADF before running.',
      }, { status: 409 });
    }
    const runRes = await runPipeline(adfName, body?.parameters || {});
    return NextResponse.json({
      ok: true,
      runId: runRes.runId,
      adfPipelineName: adfName,
      status: 'Queued',
    });
  } catch (e: any) {
    return err(e?.message || String(e), e?.status || 502);
  }
}
