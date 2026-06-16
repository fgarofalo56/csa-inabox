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
import { updateWorkspaceFromGit, FabricError, fabricHint } from '@/lib/azure/fabric-client';

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
    // Update-from-Git is a Fabric-only capability. The Console UAMI may be
    // unauthorized for Fabric in several non-401/403 ways: a raw 401/403, OR a
    // Fabric `UnknownError` / 5xx (SPN-unauthorized responses come back this way),
    // OR a "workspace not connected to Git" precondition. The audit (B2) flagged
    // every non-401/403 FabricError falling through to a raw 500. Map ALL of them
    // to the honest authorization/connection gate instead.
    if (e instanceof FabricError) {
      return NextResponse.json({
        ok: false,
        gate: {
          missing: ['Fabric Git authorization', 'Workspace contributor role', 'Workspace connected to Git'],
          message: e.hint || fabricHint(e.status) || e.message ||
            'Fabric returned an unexpected error. Update from Git requires the Console UAMI to be authorized for Fabric and the workspace to be Git-connected.',
        },
      });
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
