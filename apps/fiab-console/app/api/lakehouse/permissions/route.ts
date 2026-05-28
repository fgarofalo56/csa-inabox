/**
 * GET    /api/lakehouse/permissions?container=<c>
 *        — list Storage Blob Data role-assignments scoped to the container,
 *          plus the catalog of known role definitions for the grant dialog.
 * POST   /api/lakehouse/permissions
 *        body: { container, principalId, role, principalType? }
 *        — grant the role (Reader/Contributor/Owner) at the container scope.
 * DELETE /api/lakehouse/permissions?id=<roleAssignmentArmId>
 *        — revoke an existing role assignment by its ARM id.
 *
 * Backed by Microsoft.Authorization/roleAssignments at the container scope
 * (Microsoft.Storage/storageAccounts/.../blobServices/default/containers/<c>).
 * The console UAMI must hold Owner / User Access Administrator at that scope
 * to grant or revoke roles.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listContainerRoleAssignments,
  grantContainerRole,
  revokeContainerRoleAssignment,
  listKnownBlobDataRoles,
} from '@/lib/azure/adls-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const container = req.nextUrl.searchParams.get('container');
  if (!container) return NextResponse.json({ ok: false, error: 'container query param required' }, { status: 400 });
  try {
    const assignments = await listContainerRoleAssignments(container);
    const knownRoles = listKnownBlobDataRoles();
    return NextResponse.json({ ok: true, assignments, knownRoles });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e), status: e?.status || 502 }, { status: e?.status || 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const { container, principalId, role, principalType } = body || {};
  if (!container || !principalId || !role) {
    return NextResponse.json({ ok: false, error: 'container, principalId, role required' }, { status: 400 });
  }
  try {
    const assignment = await grantContainerRole(
      container,
      principalId,
      role,
      principalType && ['User', 'Group', 'ServicePrincipal'].includes(principalType) ? principalType : 'User',
    );
    return NextResponse.json({ ok: true, assignment });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e), status: e?.status || 502 }, { status: e?.status || 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id (full ARM role-assignment id) required' }, { status: 400 });
  try {
    await revokeContainerRoleAssignment(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e), status: e?.status || 502 }, { status: e?.status || 502 });
  }
}
