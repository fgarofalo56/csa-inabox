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
import { resolveWorkspaceRole } from '@/lib/auth/workspace-role';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { removeWorkspaceRole } from '@/lib/azure/workspace-roles-client';
import { apiServerError } from '@/lib/api/respond';
import { revokeAssignmentLedger } from '@/lib/access/assignment-ledger';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const DELETE = withSession<{ id: string; principalId: string }>(async (_req: NextRequest, { session: s, params }) => {
  const { id, principalId } = params;
  try {
    const { workspace, role } = await resolveWorkspaceRole(id, s);
    if (!workspace) return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
    // #3826 — THE DESTRUCTIVE HALF OF THE SAME LADDER, and why this file is
    // fixed in the same commit as its sibling: this handler REMOVES a member and
    // revokes their mirrored Azure RBAC assignment, so the blast radius is a real
    // de-provisioning rather than a Cosmos row. `isTenantAdmin(s)` is a
    // claims-only check that never looks at the workspace; before #3840 that let
    // it fire on a record whose tenancy Loom had never established.
    //
    // The fix is UPSTREAM, at the one chokepoint: `resolveWorkspaceRole`
    // delegates to `resolveWorkspaceAccessByOid`, whose step 4 now requires a
    // POSITIVE tenant match. A non-null `workspace` above therefore means the
    // caller owns it or its tenancy was CONFIRMED. Deliberately NOT re-derived
    // here — see the long note in `../route.ts`, which records the local helper
    // this draft first added and the guard failure that correctly rejected it as
    // a fifth private copy of the tenant decision.
    if (role !== 'admin' && !isTenantAdmin(s)) {
      return NextResponse.json(
        { ok: false, error: 'Only the workspace owner, an Admin, or a tenant admin can remove members.', role },
        { status: 403 },
      );
    }
    const pid = decodeURIComponent(principalId).trim();
    if (!pid) return NextResponse.json({ ok: false, error: 'principalId required' }, { status: 400 });
    const result = await removeWorkspaceRole(id, pid, (workspace as any).fabricWorkspaceId ?? null);
    // Entitlement ledger (access-governance W1): mark the grant revoked so the
    // who-has-access report reflects the removal. Best-effort (never throws).
    await revokeAssignmentLedger(pid, 'workspace', id, 'workspace-acl', s.claims.upn || s.claims.email || s.claims.oid);
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return apiServerError(e);
  }
});
