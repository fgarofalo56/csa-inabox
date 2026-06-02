/**
 * Stage ↔ workspace assignment for a Fabric deployment pipeline stage.
 *
 *   POST   /api/deployment-pipelines/[id]/stages/[stageId]/workspace
 *            body { workspaceId }  → assign a (vacant) workspace to the stage
 *   DELETE /api/deployment-pipelines/[id]/stages/[stageId]/workspace
 *            → unassign the workspace (loses that stage's history + rules)
 *
 * Real Fabric REST:
 *   POST /v1/deploymentPipelines/{id}/stages/{sid}/assignWorkspace
 *     https://learn.microsoft.com/rest/api/fabric/core/deployment-pipelines/assign-workspace-to-stage
 *   POST /v1/deploymentPipelines/{id}/stages/{sid}/unassignWorkspace
 *     https://learn.microsoft.com/rest/api/fabric/core/deployment-pipelines/unassign-workspace-from-stage
 *
 * Shape: { ok:true, data: { assigned|unassigned: true } }
 * Gate: Fabric 401/403 → 200 { ok:false, gate }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assignWorkspaceToStage, unassignWorkspaceFromStage, FabricError } from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gateOrError(e: unknown) {
  if (e instanceof FabricError && (e.status === 401 || e.status === 403)) {
    return NextResponse.json({
      ok: false,
      gate: { missing: ['Fabric API authorization', 'Pipeline admin + workspace admin role'], message: e.hint || (e as Error).message },
    });
  }
  const status = e instanceof FabricError ? e.status : 500;
  return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; stageId: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id, stageId } = await ctx.params;
  if (!id || !stageId) return NextResponse.json({ ok: false, error: 'pipeline id and stageId required' }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const workspaceId = String(body?.workspaceId || '').trim();
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  try {
    await assignWorkspaceToStage(id, stageId, workspaceId);
    return NextResponse.json({ ok: true, data: { assigned: true } });
  } catch (e) {
    return gateOrError(e);
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string; stageId: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id, stageId } = await ctx.params;
  if (!id || !stageId) return NextResponse.json({ ok: false, error: 'pipeline id and stageId required' }, { status: 400 });

  try {
    await unassignWorkspaceFromStage(id, stageId);
    return NextResponse.json({ ok: true, data: { unassigned: true } });
  } catch (e) {
    return gateOrError(e);
  }
}
