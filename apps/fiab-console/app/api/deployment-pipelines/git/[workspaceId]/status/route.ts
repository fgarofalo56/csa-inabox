/**
 * GET /api/deployment-pipelines/git/[workspaceId]/status — per-item Git sync
 * status for a Fabric workspace (which items have uncommitted changes, which
 * have incoming remote changes, and which conflict), plus workspaceHead +
 * remoteCommitHash needed by commit/update.
 *
 * Real Fabric REST: GET /v1/workspaces/{ws}/git/status  (long-running)
 *   https://learn.microsoft.com/rest/api/fabric/core/git/get-status
 *
 * Shape: { ok:true, data: { status } } or { ok:true, data: { pending:true } }
 *   when Fabric returns 202 (still computing — the UI retries).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getWorkspaceGitStatus, FabricError } from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ workspaceId: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { workspaceId } = await ctx.params;
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  try {
    const res = await getWorkspaceGitStatus(workspaceId);
    if ((res as any)?._accepted) {
      return NextResponse.json({ ok: true, data: { pending: true, location: (res as any).location } });
    }
    return NextResponse.json({ ok: true, data: { status: res } });
  } catch (e) {
    if (e instanceof FabricError && (e.status === 401 || e.status === 403)) {
      return NextResponse.json({
        ok: false,
        gate: { missing: ['Fabric Git authorization', 'Workspace contributor role'], message: e.hint || e.message },
      });
    }
    // Workspace not connected to git surfaces as a 400 here — treat as a clean
    // "not connected" rather than an error so the UI can show the connect form.
    if (e instanceof FabricError && e.status === 400 && /notconnected|not connected/i.test(e.message)) {
      return NextResponse.json({ ok: true, data: { notConnected: true } });
    }
    const status = e instanceof FabricError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
