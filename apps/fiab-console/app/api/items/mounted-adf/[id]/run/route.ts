/**
 * POST /api/items/mounted-adf/[id]/run?workspaceId=...
 *   body: { pipelineName: string, parameters?: Record<string, unknown> }
 *
 * Triggers a pipeline run on the referenced ADF (cross-factory createRun).
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { runMountedFactoryPipeline, type MountedFactoryRef } from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return apiError('mounted data factory not found', 404);
  const body = await req.json().catch(() => ({}));
  const pipelineName = String(body?.pipelineName || '').trim();
  if (!pipelineName) return apiError('pipelineName required', 400);
  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'mounted-adf') return apiError('mounted data factory not found', 404);
    const state = (resource.state || {}) as Record<string, string>;
    const ref: MountedFactoryRef = {
      subscriptionId: state.subscriptionId,
      resourceGroup: state.resourceGroup,
      factoryName: state.factoryName,
    };
    if (!ref.subscriptionId || !ref.resourceGroup || !ref.factoryName) {
      return apiError('factory reference incomplete', 400);
    }
    const out = await runMountedFactoryPipeline(ref, pipelineName, body?.parameters);
    return NextResponse.json({ ok: true, runId: out.runId });
  } catch (e: any) {
    return apiError(e?.message || String(e), 500);
  }
}
