/**
 * Workspace permissions.
 *
 * GET    /api/workspaces/[id]/permissions         → list members + roles
 * POST   /api/workspaces/[id]/permissions          → add member {upn, role}
 * DELETE /api/workspaces/[id]/permissions?upn=…     → remove member
 *
 * Backed by Cosmos `workspace-permissions` (PK /workspaceId). Doc shape:
 *   { id: `${workspaceId}:${upn-lower}`, workspaceId, upn, name?, role, addedBy, addedAt }
 *
 * Roles: admin | contributor | viewer. The workspace owner (creator) is
 * implicit admin and always returned in the GET response even if there's
 * no row in the table.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer, workspacePermissionsContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROLES = ['admin', 'contributor', 'viewer'] as const;
type Role = (typeof ROLES)[number];

async function assertOwner(workspaceId: string, tenantId: string) {
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(workspaceId, tenantId).read<any>();
    if (!resource || resource.tenantId !== tenantId) return null;
    return resource;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const ws = await assertOwner(params.id, s.claims.oid);
  if (!ws) return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  const c = await workspacePermissionsContainer();
  const { resources } = await c.items
    .query({
      query: 'SELECT * FROM c WHERE c.workspaceId = @w ORDER BY c.addedAt',
      parameters: [{ name: '@w', value: params.id }],
    }, { partitionKey: params.id })
    .fetchAll();
  // Synthesize implicit owner row so the UI always shows the creator.
  const ownerUpn = ws.createdBy;
  const rows = resources.filter((r: any) => r.upn?.toLowerCase() !== ownerUpn?.toLowerCase());
  rows.unshift({
    id: `${params.id}:${(ownerUpn || '').toLowerCase()}`,
    workspaceId: params.id,
    upn: ownerUpn,
    name: ws.createdBy,
    role: 'admin',
    addedBy: ownerUpn,
    addedAt: ws.createdAt,
    implicit: true,
  });
  return NextResponse.json({ ok: true, permissions: rows });
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const ws = await assertOwner(params.id, s.claims.oid);
  if (!ws) return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const upn = (body?.upn || '').toString().trim().toLowerCase();
  const role = (body?.role || '').toString() as Role;
  if (!upn) return NextResponse.json({ ok: false, error: 'upn required' }, { status: 400 });
  if (!ROLES.includes(role)) return NextResponse.json({ ok: false, error: `role must be one of ${ROLES.join(', ')}` }, { status: 400 });
  if (upn === (ws.createdBy || '').toLowerCase()) {
    return NextResponse.json({ ok: false, error: 'owner is implicit admin; cannot override' }, { status: 409 });
  }
  const c = await workspacePermissionsContainer();
  const doc = {
    id: `${params.id}:${upn}`,
    workspaceId: params.id,
    upn,
    name: body?.name || upn,
    role,
    addedBy: s.claims.upn,
    addedAt: new Date().toISOString(),
  };
  const { resource } = await c.items.upsert(doc);
  return NextResponse.json({ ok: true, permission: resource }, { status: 201 });
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const ws = await assertOwner(params.id, s.claims.oid);
  if (!ws) return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  const upn = new URL(req.url).searchParams.get('upn')?.toLowerCase();
  if (!upn) return NextResponse.json({ ok: false, error: 'upn required' }, { status: 400 });
  if (upn === (ws.createdBy || '').toLowerCase()) {
    return NextResponse.json({ ok: false, error: 'cannot remove owner' }, { status: 409 });
  }
  const c = await workspacePermissionsContainer();
  try {
    await c.item(`${params.id}:${upn}`, params.id).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  return NextResponse.json({ ok: true });
}
