/**
 * Workspace role assignment — single principal (F5 Manage Access).
 *
 *   DELETE /api/workspaces/[id]/role-assignments/[principalId]
 *     → 200 { ok, removed, rbac, fabric? }
 *
 * Removes the Cosmos `workspace-roles` row AND revokes the mirrored Azure RBAC
 * role assignment on the DLZ RG (and the Fabric workspace role when opted-in).
 * Authz: workspace owner / Admin only. See no-vaporware.md / no-fabric-dependency.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { resolveWorkspaceRole } from '@/lib/auth/workspace-role';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { removeWorkspaceRole } from '@/lib/azure/workspace-roles-client';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  _req: NextRequest,
  props: { params: Promise<{ id: string; principalId: string }> },
) {
  const { id, principalId } = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const { workspace, role } = await resolveWorkspaceRole(id, s.claims.oid, s.claims.upn || s.claims.email);
    if (!workspace) return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
    if (role !== 'admin' && !isTenantAdmin(s)) {
      return NextResponse.json(
        { ok: false, error: 'Only the workspace owner, an Admin, or a tenant admin can remove members.', role },
        { status: 403 },
      );
    }
    const pid = decodeURIComponent(principalId).trim();
    if (!pid) return NextResponse.json({ ok: false, error: 'principalId required' }, { status: 400 });
    const result = await removeWorkspaceRole(id, pid, (workspace as any).fabricWorkspaceId ?? null);
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return apiServerError(e);
  }
}
