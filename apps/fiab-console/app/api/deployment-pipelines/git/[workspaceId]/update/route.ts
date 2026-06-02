/**
 * POST /api/deployment-pipelines/git/[workspaceId]/update — pull commits from
 * the connected branch into the workspace (Update from Git). workspaceHead +
 * remoteCommitHash come from Git status.
 *
 * Real Fabric REST: POST /v1/workspaces/{ws}/git/updateFromGit  (long-running)
 *   https://learn.microsoft.com/rest/api/fabric/core/git/update-from-git
 *
 * Body: { workspaceHead?, remoteCommitHash?, allowOverrideItems?, conflictResolutionPolicy? }
 * Shape: { ok:true, data: { accepted, location? } }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { updateWorkspaceFromGit, FabricError } from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ workspaceId: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { workspaceId } = await ctx.params;
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const policy = body?.conflictResolutionPolicy;
  const conflictResolutionPolicy =
    policy === 'PreferWorkspace' || policy === 'PreferRemote' ? policy : undefined;

  try {
    const res = await updateWorkspaceFromGit(workspaceId, {
      workspaceHead: typeof body?.workspaceHead === 'string' ? body.workspaceHead : undefined,
      remoteCommitHash: typeof body?.remoteCommitHash === 'string' ? body.remoteCommitHash : undefined,
      allowOverrideItems: body?.allowOverrideItems !== false,
      conflictResolutionPolicy,
    });
    const accepted = (res as any)?._accepted === true;
    return NextResponse.json({ ok: true, data: { accepted, location: (res as any)?.location } });
  } catch (e) {
    if (e instanceof FabricError && (e.status === 401 || e.status === 403)) {
      return NextResponse.json({
        ok: false,
        gate: { missing: ['Fabric Git authorization', 'Workspace contributor role'], message: e.hint || e.message },
      });
    }
    const status = e instanceof FabricError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
