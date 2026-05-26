/**
 * GET    /api/workspaces/[id]/folders          → list folders in workspace
 * POST   /api/workspaces/[id]/folders          → create folder {name, parent?}
 * DELETE /api/workspaces/[id]/folders?path=...  → delete folder
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { foldersContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function assertOwnedWorkspace(id: string, tenantId: string) {
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(id, tenantId).read<any>();
    return resource && resource.tenantId === tenantId;
  } catch (e: any) {
    if (e?.code === 404) return false;
    throw e;
  }
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertOwnedWorkspace(params.id, s.claims.oid)))
    return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  const c = await foldersContainer();
  const { resources } = await c.items
    .query({
      query: 'SELECT * FROM c WHERE c.workspaceId = @w ORDER BY c.name',
      parameters: [{ name: '@w', value: params.id }],
    })
    .fetchAll();
  return NextResponse.json({ ok: true, folders: resources });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertOwnedWorkspace(params.id, s.claims.oid)))
    return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  if (!body?.name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  const c = await foldersContainer();
  const doc = {
    id: crypto.randomUUID(),
    workspaceId: params.id,
    name: body.name,
    parent: body.parent || null,
    createdBy: s.claims.upn,
    createdAt: new Date().toISOString(),
  };
  const { resource } = await c.items.create(doc);
  return NextResponse.json({ ok: true, folder: resource }, { status: 201 });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertOwnedWorkspace(params.id, s.claims.oid)))
    return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  const c = await foldersContainer();
  try {
    await c.item(id, params.id).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  return NextResponse.json({ ok: true });
}
