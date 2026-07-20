/**
 * POST /api/access-governance/assignments/[id]/activate — activate an ELIGIBLE
 * assignment (access-governance W3, PIM-style JIT).
 *
 * The caller activates their own eligible assignment: this provisions the REAL
 * Azure RBAC grant (enforceAccessGrant) and flips the ledger row to 'active' with
 * a bounded expiresAt (the assignment's activationWindowHours, default 8h). The
 * expiry sweeper later revokes it. Honest gate: if the grant returns pending/
 * error the row stays eligible and the reason is surfaced.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { accessAssignmentsContainer } from '@/lib/azure/cosmos-client';
import type { AccessAssignment } from '@/lib/types/access-assignment';
import { enforceAccessGrant, type AccessScopeType, type AccessPermission } from '@/lib/azure/access-policy-client';
import { activateAssignment } from '@/lib/access/assignment-ledger';
import { computeExpiry } from '@/lib/access/expiry';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_WINDOW_HOURS = 8;

export async function POST(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const oid = s.claims.oid;

  try {
    const c = await accessAssignmentsContainer();
    // Point-read within the caller's partition — a user activates only their own.
    let row: AccessAssignment | undefined;
    try {
      const { resource } = await c.item(id, oid).read<AccessAssignment>();
      row = resource;
    } catch (e: any) {
      if (e?.code !== 404) throw e;
    }
    if (!row) return NextResponse.json({ ok: false, error: 'assignment not found' }, { status: 404 });
    if (row.state !== 'eligible') {
      return NextResponse.json({ ok: false, error: `assignment is '${row.state}', not eligible for activation` }, { status: 409 });
    }

    // Provision the REAL grant now (the window starts at activation).
    const grant = await enforceAccessGrant({
      principalId: row.principalId,
      principalName: row.principalUpn,
      principalType: (row.principalType as any) || 'User',
      scopeType: row.resourceType as AccessScopeType,
      scopeRef: row.resourceRef,
      permission: (row.permission as AccessPermission) || 'read',
    });
    if (grant.status !== 'active') {
      return NextResponse.json({
        ok: grant.status !== 'error', activated: false, status: grant.status,
        detail: grant.detail || 'The grant could not be provisioned; the assignment remains eligible.',
      }, { status: grant.status === 'error' ? 502 : 200 });
    }

    const windowHours = row.activationWindowHours && row.activationWindowHours > 0 ? row.activationWindowHours : DEFAULT_WINDOW_HOURS;
    const expiresAt = computeExpiry(new Date(), { windowHours });
    const updated = await activateAssignment(id, oid, {
      roleAssignmentId: grant.roleAssignmentId,
      role: grant.roleName || row.role,
      expiresAt,
      activatedBy: s.claims.upn || oid,
    });

    return NextResponse.json({
      ok: true, activated: true, assignment: updated, expiresAt, windowHours,
      message: `Activated — access is granted for ${windowHours}h (until ${expiresAt}).`,
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}
