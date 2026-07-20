/**
 * Pure leaver / bulk-decision helpers (access-governance Wave-4, AG-14). No
 * Cosmos/ARM — unit-testable. The revoke-all route selects a principal's live
 * grants to tear down; the bulk-decision route partitions a set of request ids
 * into the decision to apply. Real backend revoke/decision runs in the routes.
 */
import type { AccessAssignment } from '@/lib/types/access-assignment';

/**
 * The ledger rows a leaver "revoke-all" should tear down for a principal: every
 * ACTIVE or ELIGIBLE assignment (expired/revoked rows are already gone). Eligible
 * rows have no live RBAC, so the route only marks them revoked in the ledger.
 */
export function selectRevocable<T extends Pick<AccessAssignment, 'state'>>(assignments: T[]): T[] {
  return assignments.filter((a) => a.state === 'active' || a.state === 'eligible');
}

/** Whether an assignment has a live backend grant to revoke (vs ledger-only). */
export function hasLiveGrant(a: Pick<AccessAssignment, 'state'>): boolean {
  return a.state === 'active';
}

/** Sanitize a bulk id list — de-dupe, drop blanks, cap the batch size. */
export function normalizeIds(ids: unknown, max = 500): string[] {
  if (!Array.isArray(ids)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const s = String(raw || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}
