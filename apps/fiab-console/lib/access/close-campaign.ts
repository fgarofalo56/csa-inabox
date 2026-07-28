/**
 * Server-side "close a review campaign" helper (access-governance W4, AG-7;
 * evidence sealing added by loom-apex B-N19c').
 *
 * Shared by the campaign manage route (PATCH action:'close') and the review sweep
 * (past-deadline auto-close). When the campaign opted into auto-revoke, every
 * still-undecided item is torn down through the shared real revoke path
 * (revokeAssignment → ARM + data-plane + ledger). The closed campaign is then
 * PERSISTED here (single choke point, so both callers store an identical doc),
 * and finally sealed into the tenant's append-only, hash-chained evidence record
 * (evidence-store → `access-review-evidence`) — campaign metadata, every
 * decision, the resulting revocations, and a SHA-256 content hash linked to the
 * prior record. Evidence is sealed AFTER the campaign persists, so an evidence
 * record can never claim a close that did not happen; a failed seal is returned
 * as a warning and never fails the close.
 *
 * Not pure (needs Cosmos + the revoke path) — the pure selection lives in
 * access-reviews.ts (selectAutoRevoke) and the pure hash chain in
 * evidence-record.ts.
 */
import { accessAssignmentsContainer, accessReviewsContainer } from '@/lib/azure/cosmos-client';
import type { AccessReview } from '@/lib/types/access-review';
import type { AccessAssignment } from '@/lib/types/access-assignment';
import type { AccessReviewEvidence } from '@/lib/types/access-review-evidence';
import { selectAutoRevoke } from '@/lib/access/access-reviews';
import { revokeAssignment } from '@/lib/access/revoke-assignment';
import { sealCampaignEvidence, type EvidenceActor } from '@/lib/access/evidence-store';

export async function closeCampaign(
  review: AccessReview,
  by: string,
  actor?: EvidenceActor,
): Promise<{ review: AccessReview; revoked: number; warnings: string[]; evidence: AccessReviewEvidence | null }> {
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

  // Persist the closed campaign BEFORE sealing evidence — evidence must only
  // ever describe a close that is durable.
  const campaigns = await accessReviewsContainer();
  await campaigns.item(review.id, review.tenantId).replace(review);

  const { evidence, error } = await sealCampaignEvidence(review, by, {
    backendRevoked: revoked,
    warnings,
    actor,
    now,
  });
  if (error) warnings.push(`evidence record could not be sealed: ${error}`);

  return { review, revoked, warnings, evidence };
}
