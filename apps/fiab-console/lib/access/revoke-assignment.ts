/**
 * Shared server-side "revoke one ledger assignment" helper (access-governance
 * W4). The W3 expiry sweeper, the access-review decision route, the review
 * auto-revoke sweep, and the leaver revoke-all route all need the SAME real
 * backend revoke: tear down the ARM role assignment (if any) + the structured
 * data-plane grant (Synapse SQL / ADX / storage), then mark the ledger row
 * revoked. Centralized here so there is ONE revoke implementation (no-vaporware).
 *
 * Best-effort on the Azure side (a revoke hiccup is collected, never thrown) but
 * the ledger row is always transitioned so the who-has-access report stays honest.
 * NOT a new grant primitive — it composes revokeAccessGrant / revokeStructuredGrant.
 */
import {
  revokeAccessGrant, revokeStructuredGrant,
  type AccessScopeType, type AccessPermission,
} from '@/lib/azure/access-policy-client';
import { revokeAssignmentLedger } from '@/lib/access/assignment-ledger';
import type { AccessAssignment } from '@/lib/types/access-assignment';

export interface RevokeResult {
  id: string;
  revoked: boolean;
  /** Azure-side revoke warnings (grant torn down best-effort). */
  warnings: string[];
}

/**
 * Revoke one effective assignment. `active` rows have a live grant to tear down;
 * `eligible` rows have no RBAC yet, so only the ledger row is transitioned.
 */
export async function revokeAssignment(a: AccessAssignment, revokedBy?: string): Promise<RevokeResult> {
  const warnings: string[] = [];
  if (a.state === 'active') {
    if (a.roleAssignmentId) {
      try { await revokeAccessGrant(a.roleAssignmentId); }
      catch (e: any) { warnings.push(`${a.id}: ${e?.message || e}`); }
    }
    try {
      await revokeStructuredGrant({
        principalId: a.principalId,
        principalName: a.principalUpn,
        principalType: (a.principalType as any) || 'User',
        scopeType: a.resourceType as AccessScopeType,
        scopeRef: a.resourceRef,
        permission: (a.permission as AccessPermission) || 'read',
      });
    } catch (e: any) { warnings.push(`${a.id}: ${e?.message || e}`); }
  }
  // Transition the ledger row (matches on the deterministic tuple id).
  const revoked = await revokeAssignmentLedger(a.principalId, a.resourceType, a.resourceRef, a.source, revokedBy);
  return { id: a.id, revoked, warnings };
}
