/**
 * POST /api/deployment-pipelines/git/[workspaceId]/initialize — initialize the
 * Git connection after Connect (the first-time sync handshake). Fabric returns
 * the required action (CommitToGit | UpdateFromGit | None) the operator must
 * take next.
 *
 * Real Fabric REST: POST /v1/workspaces/{ws}/git/initializeConnection (LRO)
 *   https://learn.microsoft.com/rest/api/fabric/core/git/initialize-connection
 *
 * Shape: { ok:true, data: { accepted, location? } | { requiredAction, ... } }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { initializeWorkspaceGitConnection, FabricError } from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ workspaceId: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { workspaceId } = await ctx.params;
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  try {
    const res = await initializeWorkspaceGitConnection(workspaceId);
    if ((res as any)?._accepted) {
      return NextResponse.json({ ok: true, data: { accepted: true, location: (res as any).location } });
    }
    return NextResponse.json({ ok: true, data: res });
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
