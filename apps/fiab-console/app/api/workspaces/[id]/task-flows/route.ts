/**
 * GET  /api/workspaces/[id]/task-flows   → { ok, flows: TaskFlow[] }
 * POST /api/workspaces/[id]/task-flows   → { ok, flow: TaskFlow }  (201)
 *
 * Owner-scoped: the caller must own the workspace (tenantId == session.oid).
 * Task flows are Loom-native (Cosmos task-flows container, PK /workspaceId) —
 * no Fabric dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer } from '@/lib/azure/cosmos-client';
import { dbListTaskFlows, dbCreateTaskFlow } from '@/lib/clients/taskflow-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function assertOwnedWorkspace(id: string, tenantId: string): Promise<boolean> {
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(id, tenantId).read<any>();
    return !!resource && resource.tenantId === tenantId;
  } catch (e: any) {
    if (e?.code === 404) return false;
    throw e;
  }
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertOwnedWorkspace(params.id, s.claims.oid)))
    return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  try {
    const flows = await dbListTaskFlows(params.id);
    return NextResponse.json({ ok: true, flows });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertOwnedWorkspace(params.id, s.claims.oid)))
    return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  if (!body?.displayName || typeof body.displayName !== 'string' || !body.displayName.trim())
    return NextResponse.json({ ok: false, error: 'displayName required' }, { status: 400 });
  try {
    const flow = await dbCreateTaskFlow(
      params.id,
      { displayName: body.displayName, description: body.description },
      s.claims.upn || s.claims.oid,
    );
    return NextResponse.json({ ok: true, flow }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
