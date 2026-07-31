/**
 * POST   /api/admin/directory-users/[id]/lifecycle  { action: 'pause' | 'resume' | 'delete' }
 *                                                                                    (#2758)
 *
 * The directory-user lifecycle the access-governance hub was missing — for both
 * guests and members, keyed on the Entra object id (`[id]`):
 *
 *   pause  — Graph PATCH /users/{id} accountEnabled:false; the user can no longer
 *            sign in but the object + its grants survive. Reversible.
 *   resume — accountEnabled:true.
 *   delete — TERMINAL. Tears down every entitlement first (revokeAssignment over
 *            the principal's active/eligible ledger rows) THEN Graph DELETE
 *            /users/{id}, so no grant ever outlives the object. Entra keeps a
 *            30-day soft-delete server-side.
 *
 * Also pauses/resumes the principal's ledger assignments so the access report
 * reflects the suspend. Admin-only. Honest 403 with the exact consent step when
 * User.ReadWrite.All is not granted (no-vaporware.md).
 */
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { accessAssignmentsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import type { AccessAssignment } from '@/lib/types/access-assignment';
import { selectRevocable } from '@/lib/access/leaver';
import { revokeAssignment } from '@/lib/access/revoke-assignment';
import { pauseAssignment, resumeAssignment } from '@/lib/access/assignment-ledger';
import {
  setUserAccountEnabled, deleteTenantUser,
  GraphIdentityError, LIFECYCLE_APP_ROLES,
} from '@/lib/azure/graph-identity-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Action = 'pause' | 'resume' | 'delete';

/** All ledger rows for a principal (single-partition read — PK is /principalId). */
async function assignmentsFor(principalId: string): Promise<AccessAssignment[]> {
  const c = await accessAssignmentsContainer();
  const { resources } = await c.items
    .query<AccessAssignment>({
      query: 'SELECT * FROM c WHERE c.principalId = @pid',
      parameters: [{ name: '@pid', value: principalId }],
    }, { partitionKey: principalId })
    .fetchAll();
  return resources || [];
}

function userWriteDenied(e: unknown): boolean {
  return e instanceof GraphIdentityError && e.status === 403;
}
function userWriteRoleHint(): string {
  const role = LIFECYCLE_APP_ROLES.find((r) => r.name === 'User.ReadWrite.All');
  return `the Console identity lacks the ${role?.name} Graph permission (appRole ${role?.appRoleId}) — grant it + admin-consent, then retry.`;
}

export const POST = withTenantAdmin<{ id: string }>(async (req, { session, params }) => {
  const { id: principalId } = params;
  if (!principalId) return apiError('id (user object id) required', 400);

  const body = await req.json().catch(() => ({} as any));
  const action = body?.action as Action;
  if (action !== 'pause' && action !== 'resume' && action !== 'delete') {
    return apiError('action must be "pause", "resume", or "delete"', 400);
  }
  const actor = session.claims.upn || session.claims.oid;
  const now = new Date().toISOString();

  try {
    if (action === 'pause' || action === 'resume') {
      const enable = action === 'resume';
      try {
        await setUserAccountEnabled(principalId, enable);
      } catch (e) {
        if (userWriteDenied(e)) return apiError(`Cannot ${action} the user: ${userWriteRoleHint()}`, 403);
        throw e;
      }
      // Reflect it in the ledger (best-effort, per assignment).
      const rows = await assignmentsFor(principalId);
      let updated = 0;
      for (const a of rows) {
        const ok = enable ? await resumeAssignment(a.id, principalId, actor) : await pauseAssignment(a.id, principalId, actor);
        if (ok) updated += 1;
      }
      const al = await auditLogContainer();
      await al.items.create({
        id: crypto.randomUUID(), itemId: principalId, itemType: 'directory-user',
        action: `directory-user-${action}`,
        summary: `${actor} ${action}d directory user ${principalId} (accountEnabled=${enable}); ${updated} ledger assignment(s) updated`,
        upn: actor, at: now,
      });
      return apiOk({ action, principalId, accountEnabled: enable, ledgerUpdated: updated });
    }

    // action === 'delete' — revoke every entitlement FIRST, then delete the object.
    const rows = await assignmentsFor(principalId);
    const revocable = selectRevocable(rows);
    const revokeWarnings: string[] = [];
    let revoked = 0;
    for (const a of revocable) {
      try {
        const res = await revokeAssignment(a, actor);
        revoked += 1;
        if (res.warnings?.length) revokeWarnings.push(...res.warnings);
      } catch (e) {
        revokeWarnings.push(`revoke of ${a.resourceType}/${a.resourceRef} failed: ${(e as any)?.message || String(e)}`);
      }
    }

    try {
      await deleteTenantUser(principalId);
    } catch (e) {
      if (userWriteDenied(e)) {
        return apiError(
          `Revoked ${revoked} entitlement(s) but could NOT delete the user object: ${userWriteRoleHint()}`,
          403,
        );
      }
      throw e;
    }

    const al = await auditLogContainer();
    await al.items.create({
      id: crypto.randomUUID(), itemId: principalId, itemType: 'directory-user',
      action: 'directory-user-delete',
      summary: `${actor} deleted directory user ${principalId} after revoking ${revoked} entitlement(s)`,
      upn: actor, at: now,
    });

    return apiOk({
      action: 'delete', principalId, revoked,
      ...(revokeWarnings.length ? { warnings: revokeWarnings } : {}),
    });
  } catch (e) {
    return apiServerError(e);
  }
});
