/**
 * Pure access-review campaign logic (access-governance Wave-4). No Cosmos/Graph —
 * fully unit-testable. The BFF routes fetch the ledger + campaigns and call these
 * to (a) select which grants a campaign scopes, (b) snapshot them into review
 * items, (c) apply attest/revoke decisions (bulk or single), (d) decide who may
 * review (reviewer / delegate / admin), (e) compute progress, and (f) select the
 * items to AUTO-REVOKE when a past-deadline campaign closes.
 */
import crypto from 'node:crypto';
import type { AccessEntry } from './access-report';
import type {
  AccessReview, AccessReviewItem, ReviewScope, ReviewDecision, ReviewStats,
} from '@/lib/types/access-review';
import type { ApproverBinding } from '@/lib/types/approval-policy';

/** Deterministic review-item id — stable for the same campaign + grant tuple. */
export function reviewItemId(campaignId: string, e: Pick<AccessEntry, 'principalId' | 'resourceType' | 'resourceRef' | 'source'>): string {
  return crypto
    .createHash('sha256')
    .update(`${campaignId}|${e.principalId}|${e.resourceType}|${e.resourceRef}|${e.source}`)
    .digest('hex')
    .slice(0, 32);
}

/** Does an effective-grant entry fall inside a campaign scope? */
export function matchesScope(e: AccessEntry, scope: ReviewScope): boolean {
  switch (scope.kind) {
    case 'all':
      return true;
    case 'package':
      // package-sourced ledger rows carry source === `package:<id>`.
      return !!scope.ref && e.source === `package:${scope.ref}`;
    case 'group':
      return !!scope.ref && (e.source === `group:${scope.ref}` || e.viaGroupId === scope.ref || (e.principalType === 'Group' && e.principalId === scope.ref));
    case 'principal':
      return !!scope.ref && e.principalId === scope.ref;
    case 'resource':
      return !!scope.ref && e.resourceRef === scope.ref && (!scope.resourceType || e.resourceType === scope.resourceType);
    default:
      return false;
  }
}

/**
 * Build the pending review items for a campaign from the effective-grant entries.
 * Only ACTIVE / ELIGIBLE grants are reviewable (revoked/expired are already gone).
 */
export function buildReviewItems(campaignId: string, entries: AccessEntry[], scope: ReviewScope): AccessReviewItem[] {
  const out: AccessReviewItem[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.state !== 'active' && e.state !== 'eligible') continue;
    if (!matchesScope(e, scope)) continue;
    const id = reviewItemId(campaignId, e);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      assignmentId: e.id,
      principalId: e.principalId,
      principalUpn: e.principalUpn,
      principalType: e.principalType,
      resourceType: e.resourceType,
      resourceRef: e.resourceRef,
      resourceName: e.resourceName,
      role: e.role,
      permission: e.permission,
      source: e.source,
      decision: 'pending',
    });
  }
  return out;
}

/** Rollup counts for the progress UI. */
export function computeStats(items: AccessReviewItem[]): ReviewStats {
  let attested = 0, revoked = 0, pending = 0;
  for (const it of items) {
    if (it.decision === 'attest') attested++;
    else if (it.decision === 'revoke') revoked++;
    else pending++;
  }
  return { total: items.length, attested, revoked, pending };
}

/**
 * Apply a decision to a set of item ids (bulk or single). Returns the updated
 * item list plus the items that FLIPPED to 'revoke' this call (so the route knows
 * exactly which real backend revokes to run — idempotent: re-revoking an
 * already-revoked item yields no new revokes). Never mutates the input array.
 */
export function applyDecision(
  items: AccessReviewItem[],
  itemIds: string[],
  decision: Exclude<ReviewDecision, 'pending'>,
  actor: { upn?: string; oid: string },
  now = new Date().toISOString(),
  note?: string,
): { items: AccessReviewItem[]; newlyRevoked: AccessReviewItem[] } {
  const target = new Set(itemIds);
  const newlyRevoked: AccessReviewItem[] = [];
  const next = items.map((it) => {
    if (!target.has(it.id)) return it;
    const wasRevoked = it.decision === 'revoke';
    const updated: AccessReviewItem = {
      ...it,
      decision,
      decidedBy: actor.upn || actor.oid,
      decidedAt: now,
      ...(note ? { note: note.slice(0, 500) } : {}),
    };
    if (decision === 'revoke' && !wasRevoked) newlyRevoked.push(updated);
    return updated;
  });
  return { items: next, newlyRevoked };
}

/**
 * Items to AUTO-REVOKE when a past-deadline campaign closes: every still-pending
 * item, but only when the campaign opted into auto-revoke. (A campaign without
 * auto-revoke simply closes, leaving undecided grants in place.)
 */
export function selectAutoRevoke(review: Pick<AccessReview, 'autoRevokeOnExpiry' | 'items'>): AccessReviewItem[] {
  if (!review.autoRevokeOnExpiry) return [];
  return review.items.filter((it) => it.decision === 'pending');
}

/** True when the campaign is active and past its deadline. */
export function isOverdue(review: Pick<AccessReview, 'status' | 'dueAt'>, now: Date): boolean {
  if (review.status !== 'active') return false;
  if (!review.dueAt) return false;
  const t = Date.parse(review.dueAt);
  return !Number.isNaN(t) && t <= now.getTime();
}

/** Next campaign date for a recurring review (null when non-recurring). */
export function nextDueDate(review: Pick<AccessReview, 'cadenceDays'>, from: Date): string | null {
  const d = review.cadenceDays;
  if (typeof d !== 'number' || d <= 0) return null;
  return new Date(from.getTime() + d * 24 * 3600_000).toISOString();
}

/** Match an approver binding against the actor (direct oid or group membership). */
function bindingMatches(b: ApproverBinding, actorOid: string, actorGroups: string[]): boolean {
  if (b.type === 'user') return b.id === actorOid;
  if (b.type === 'group') return actorGroups.includes(b.id);
  return false;
}

/**
 * May the actor act on this campaign? A tenant admin always may. Otherwise the
 * actor must be a named reviewer or delegate (directly, or via group membership).
 * A campaign with NO reviewers is admin-only.
 */
export function canReview(
  review: Pick<AccessReview, 'reviewers' | 'delegatedTo'>,
  actorOid: string,
  actorGroups: string[],
  isTenantAdmin: boolean,
): boolean {
  if (isTenantAdmin) return true;
  const all = [...(review.reviewers || []), ...(review.delegatedTo || [])];
  return all.some((b) => bindingMatches(b, actorOid, actorGroups));
}
