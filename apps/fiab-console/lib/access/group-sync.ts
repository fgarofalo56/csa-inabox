/**
 * Pure Entra group-sync reconcile logic (access-governance Wave-4, AG-8/AG-9). No
 * Graph/Cosmos — unit-testable. Given the LIVE transitive members of a group and
 * the existing group-sourced ledger rows for a (group, resource) target, computes
 * the membership DELTA: which members need a grant (joined) and which ledger rows
 * need revoke (left). The sweeper/route reads members via Graph and drives the
 * real `enforceStructuredGrant` / `revokeStructuredGrant` from this delta — so
 * membership changes in Entra flow through to real Loom grants on a cadence.
 *
 * Read-only against Entra: we NEVER mutate tenant group membership (PRP non-goal).
 */
import type { AccessAssignment } from '@/lib/types/access-assignment';

/** A resolved group member (from Graph transitive members). */
export interface GroupMember {
  id: string;
  upn?: string;
  type: 'User' | 'Group' | 'ServicePrincipal';
}

export interface GroupSyncDelta {
  /** Members present in the group but with no active group-sourced grant yet. */
  toGrant: GroupMember[];
  /** Active group-sourced ledger rows whose principal is no longer a member. */
  toRevoke: AccessAssignment[];
}

/**
 * Diff a group's current membership against the group-sourced assignments already
 * recorded for one resource target.
 *
 * @param members   live transitive members of the group (Graph read)
 * @param existing  ledger rows with source === `group:<groupId>` for THIS resource
 *                  (any state; only 'active' rows are considered for revoke, and
 *                  an active row suppresses a re-grant)
 */
export function diffGroupMembership(members: GroupMember[], existing: AccessAssignment[]): GroupSyncDelta {
  const memberIds = new Set(members.filter((m) => m.type === 'User' || m.type === 'ServicePrincipal').map((m) => m.id));
  const activeByPrincipal = new Map<string, AccessAssignment>();
  for (const a of existing) {
    if (a.state === 'active') activeByPrincipal.set(a.principalId, a);
  }
  const toGrant = members.filter(
    (m) => (m.type === 'User' || m.type === 'ServicePrincipal') && !activeByPrincipal.has(m.id),
  );
  const toRevoke = [...activeByPrincipal.values()].filter((a) => !memberIds.has(a.principalId));
  return { toGrant, toRevoke };
}
