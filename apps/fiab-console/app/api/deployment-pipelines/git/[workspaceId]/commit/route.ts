/**
 * POST /api/deployment-pipelines/git/[workspaceId]/commit — commit workspace
 * changes to the connected remote branch. mode 'All' commits everything;
 * 'Selective' commits the supplied item identifiers (from Git status).
 *
 * Real Fabric REST: POST /v1/workspaces/{ws}/git/commitToGit  (long-running)
 *   https://learn.microsoft.com/rest/api/fabric/core/git/commit-to-git
 *
 * Body: { mode, workspaceHead?, comment?, items?: [{ objectId?, logicalId? }] }
 * Shape: { ok:true, data: { accepted, location? } }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { commitWorkspaceToGit, FabricError } from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ workspaceId: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { workspaceId } = await ctx.params;
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const mode = body?.mode === 'Selective' ? 'Selective' : 'All';
  const items = Array.isArray(body?.items)
    ? body.items
        .map((i: any) => ({
          objectId: i?.objectId ? String(i.objectId) : undefined,
          logicalId: i?.logicalId ? String(i.logicalId) : undefined,
        }))
        .filter((i: { objectId?: string; logicalId?: string }) => i.objectId || i.logicalId)
    : undefined;

  if (mode === 'Selective' && (!items || items.length === 0)) {
    return NextResponse.json({ ok: false, error: 'Selective commit requires at least one item' }, { status: 400 });
  }

  try {
    const res = await commitWorkspaceToGit(workspaceId, {
      mode,
      workspaceHead: typeof body?.workspaceHead === 'string' ? body.workspaceHead : undefined,
      comment: typeof body?.comment === 'string' ? body.comment : undefined,
      items,
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
