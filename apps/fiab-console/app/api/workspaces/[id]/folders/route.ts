/**
 * GET    /api/workspaces/[id]/folders          → list folders in workspace
 * POST   /api/workspaces/[id]/folders          → create folder {name, parent?}
 * PATCH  /api/workspaces/[id]/folders          → rename folder {id, name}
 * DELETE /api/workspaces/[id]/folders?id=...   → delete folder (children reparent to root)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import { foldersContainer, itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { readWorkspaceById } from '@/lib/auth/workspace-access';
import type { WorkspaceItem } from '@/lib/types/workspace';
import crypto from 'node:crypto';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * True when the caller may manage this workspace's folders: the owner (partition
 * point-read) OR — ADMIN-OPEN — a tenant admin for any workspace in the tenant,
 * so an admin opening a workspace from /admin/workspaces sees its folders too
 * rather than a 404 (the Items tab renders both the item list and this folder
 * tree).
 */
async function assertWorkspaceAccess(id: string, session: SessionPayload): Promise<boolean> {
  const oid = session.claims.oid;
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(id, oid).read<any>();
    if (resource && resource.tenantId === oid) return true;
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  if (isTenantAdmin(session)) {
    return !!(await readWorkspaceById(id));
  }
  return false;
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertWorkspaceAccess(params.id, s)))
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

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertWorkspaceAccess(params.id, s)))
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

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertWorkspaceAccess(params.id, s)))
    return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  if (!body?.id || typeof body.id !== 'string')
    return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  if (!body?.name || typeof body.name !== 'string' || !body.name.trim())
    return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  const c = await foldersContainer();
  try {
    const { resource } = await c.item(body.id, params.id).read<any>();
    if (!resource) return NextResponse.json({ ok: false, error: 'folder not found' }, { status: 404 });
    const next = { ...resource, name: body.name.trim() };
    const { resource: saved } = await c.item(body.id, params.id).replace(next);
    return NextResponse.json({ ok: true, folder: saved });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: false, error: 'folder not found' }, { status: 404 });
    return apiServerError(e, 'failed to rename folder');
  }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertWorkspaceAccess(params.id, s)))
    return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  // Move any items in this folder back to root before deleting it.
  try {
    const items = await itemsContainer();
    const { resources: members } = await items.items
      .query<WorkspaceItem>({
        query: 'SELECT * FROM c WHERE c.workspaceId = @w AND c.folderId = @f',
        parameters: [
          { name: '@w', value: params.id },
          { name: '@f', value: id },
        ],
      }, { partitionKey: params.id })
      .fetchAll();
    for (const m of members) {
      const next: WorkspaceItem = { ...m, folderId: null, updatedAt: new Date().toISOString() };
      await items.item(m.id, m.workspaceId).replace(next);
    }
  } catch { /* best-effort */ }
  // Reparent any child folders to root.
  const c = await foldersContainer();
  try {
    const { resources: childFolders } = await c.items
      .query({
        query: 'SELECT * FROM c WHERE c.workspaceId = @w AND c.parent = @p',
        parameters: [
          { name: '@w', value: params.id },
          { name: '@p', value: id },
        ],
      })
      .fetchAll();
    for (const cf of childFolders as any[]) {
      await c.item(cf.id, params.id).replace({ ...cf, parent: null });
    }
  } catch { /* best-effort */ }
  try {
    await c.item(id, params.id).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  return NextResponse.json({ ok: true });
}
