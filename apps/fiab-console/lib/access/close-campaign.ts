/**
 * Server-side "close a review campaign" helper (access-governance W4, AG-7).
 * Shared by the campaign manage route (PATCH action:'close') and the review sweep
 * (past-deadline auto-close). When the campaign opted into auto-revoke, every
 * still-undecided item is torn down through the shared real revoke path
 * (revokeAssignment → ARM + data-plane + ledger). Not pure (needs Cosmos + the
 * revoke path) — the pure selection lives in access-reviews.ts (selectAutoRevoke).
 */
import { accessAssignmentsContainer } from '@/lib/azure/cosmos-client';
import type { AccessReview } from '@/lib/types/access-review';
import type { AccessAssignment } from '@/lib/types/access-assignment';
import { selectAutoRevoke } from '@/lib/access/access-reviews';
import { revokeAssignment } from '@/lib/access/revoke-assignment';

export async function closeCampaign(
  review: AccessReview,
  by: string,
): Promise<{ review: AccessReview; revoked: number; warnings: string[] }> {
  const now = new Date().toISOString();
  const warnings: string[] = [];
  let revoked = 0;
  const toRevoke = selectAutoRevoke(review);
  if (toRevoke.length) {
    const ledger = await accessAssignmentsContainer();
    for (const it of toRevoke) {
      const idx = review.items.findIndex((x) => x.id === it.id);
      if (!it.assignmentId) {
        if (idx >= 0) review.items[idx] = { ...review.items[idx], decision: 'revoke', decidedBy: by, decidedAt: now, note: 'auto-revoked at campaign close (no response)' };
        continue;
      }
      try {
        const { resource: a } = await ledger.item(it.assignmentId, it.principalId).read<AccessAssignment>();
        if (a) {
          const r = await revokeAssignment(a, by);
          if (r.revoked) revoked++;
          warnings.push(...r.warnings);
        }
      } catch (e: any) { warnings.push(`${it.id}: ${e?.message || e}`); }
      if (idx >= 0) review.items[idx] = { ...review.items[idx], decision: 'revoke', decidedBy: by, decidedAt: now, revokedAt: now, note: 'auto-revoked at campaign close (no response)' };
    }
  }
  review.status = 'closed';
  review.closedAt = now;
  review.closedBy = by;
  review.updatedAt = now;
  return { review, revoked, warnings };
}
