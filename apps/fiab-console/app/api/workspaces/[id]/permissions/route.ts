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
import { workspacePermissionsContainer } from '@/lib/azure/cosmos-client';
import { resolveAdminWorkspace } from '@/lib/auth/workspace-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROLES = ['admin', 'contributor', 'viewer'] as const;
type Role = (typeof ROLES)[number];

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  // #2947 — was a local owner-only `assertOwner` point-read ("did you CREATE
  // this workspace"), so a tenant admin could not see or manage membership on a
  // workspace they did not personally create. `resolveAdminWorkspace` is the
  // canonical owner-first / tenant-admin-fallback resolver AND returns the doc
  // this handler needs (createdBy / createdAt for the implicit-owner row).
  //
  // DELIBERATELY NOT `authorizeWorkspace`: granting/removing workspace membership
  // is a privilege-management surface, so shared-ACL members (even Admin-role
  // ones from the separate `workspace-roles` ACL) must NOT be admitted here —
  // only the owner or a tenant admin. This widens the guard exactly one rung.
  const { ws, resp } = await resolveAdminWorkspace(params.id);
  if (resp) return resp;
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
  // #2947 — was a local owner-only `assertOwner` point-read ("did you CREATE
  // this workspace"), so a tenant admin could not see or manage membership on a
  // workspace they did not personally create. `resolveAdminWorkspace` is the
  // canonical owner-first / tenant-admin-fallback resolver AND returns the doc
  // this handler needs (createdBy / createdAt for the implicit-owner row).
  //
  // DELIBERATELY NOT `authorizeWorkspace`: granting/removing workspace membership
  // is a privilege-management surface, so shared-ACL members (even Admin-role
  // ones from the separate `workspace-roles` ACL) must NOT be admitted here —
  // only the owner or a tenant admin. This widens the guard exactly one rung.
  const { session: s, ws, resp } = await resolveAdminWorkspace(params.id);
  if (resp) return resp;
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
  // #2947 — was a local owner-only `assertOwner` point-read ("did you CREATE
  // this workspace"), so a tenant admin could not see or manage membership on a
  // workspace they did not personally create. `resolveAdminWorkspace` is the
  // canonical owner-first / tenant-admin-fallback resolver AND returns the doc
  // this handler needs (createdBy / createdAt for the implicit-owner row).
  //
  // DELIBERATELY NOT `authorizeWorkspace`: granting/removing workspace membership
  // is a privilege-management surface, so shared-ACL members (even Admin-role
  // ones from the separate `workspace-roles` ACL) must NOT be admitted here —
  // only the owner or a tenant admin. This widens the guard exactly one rung.
  const { ws, resp } = await resolveAdminWorkspace(params.id);
  if (resp) return resp;
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
