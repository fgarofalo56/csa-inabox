/**
 * GET    /api/workspaces/[id]/task-flows/[flowId]  → { ok, flow }
 * PUT    /api/workspaces/[id]/task-flows/[flowId]  → full save
 *        Body: { steps?, edges?, displayName?, description? } → { ok, flow }
 * DELETE /api/workspaces/[id]/task-flows/[flowId]  → { ok }
 *
 * Owner-scoped (tenantId == session.oid). Loom-native Cosmos store, no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer } from '@/lib/azure/cosmos-client';
import {
  dbGetTaskFlow, dbUpsertTaskFlow, dbDeleteTaskFlow,
} from '@/lib/clients/taskflow-client';
import { apiServerError } from '@/lib/api/respond';

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

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string; flowId: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertOwnedWorkspace(params.id, s.claims.oid)))
    return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  try {
    const flow = await dbGetTaskFlow(params.id, params.flowId);
    if (!flow) return NextResponse.json({ ok: false, error: 'task flow not found' }, { status: 404 });
    return NextResponse.json({ ok: true, flow });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string; flowId: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertOwnedWorkspace(params.id, s.claims.oid)))
    return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const patch: any = {};
  if (Array.isArray(body?.steps)) patch.steps = body.steps;
  if (Array.isArray(body?.edges)) patch.edges = body.edges;
  if (typeof body?.displayName === 'string') patch.displayName = body.displayName;
  if (typeof body?.description === 'string') patch.description = body.description;
  try {
    const flow = await dbUpsertTaskFlow(params.id, params.flowId, patch, new Date().toISOString());
    return NextResponse.json({ ok: true, flow });
  } catch (e: any) {
    const notFound = /not found/i.test(e?.message || '');
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: notFound ? 404 : 500 },
    );
  }
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string; flowId: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertOwnedWorkspace(params.id, s.claims.oid)))
    return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  try {
    await dbDeleteTaskFlow(params.id, params.flowId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return apiServerError(e);
  }
}
