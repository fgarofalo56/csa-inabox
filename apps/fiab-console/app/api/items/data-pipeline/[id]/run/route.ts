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

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  try {
    const items = await itemsContainer();
    const { resource } = await items.item(ctx.params.id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'data-pipeline') return err('pipeline not found', 404);
    const adfName = (resource.state as any)?.adfPipelineName;
    if (!adfName) return err('Pipeline has no ADF backing — re-create from the editor', 500);
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
