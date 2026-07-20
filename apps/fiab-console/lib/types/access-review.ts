/**
 * Access reviews / recertification (access-governance Wave-4).
 *
 * A review CAMPAIGN asks named reviewers to attest or revoke a set of effective
 * grants (snapshotted from the W1 entitlement ledger at campaign-create time),
 * with bulk decisions, reviewer delegation, and — when the campaign passes its
 * deadline — AUTO-REVOKE of anything still undecided. Every revoke funnels
 * through the same `revokeStructuredGrant` / ledger-revoke path the sweeper uses,
 * so a review decision produces a real Azure revoke, never a cosmetic flag.
 *
 * Stored in the `access-reviews` Cosmos container (PK /tenantId). No raw-JSON
 * editing — campaigns are built through the wizard/picker (loom-no-freeform-config).
 */
import type { ApproverBinding } from './approval-policy';

/** What population of grants a campaign reviews. */
export type ReviewScopeKind = 'all' | 'package' | 'resource' | 'principal' | 'group';

export interface ReviewScope {
  kind: ReviewScopeKind;
  /** package id / resourceRef / principal oid / group oid — absent for 'all'. */
  ref?: string;
  /** For a 'resource' scope, optionally narrow to one resourceType. */
  resourceType?: string;
}

/** Per-assignment decision inside a campaign. */
export type ReviewDecision = 'pending' | 'attest' | 'revoke';

/** One reviewable grant, snapshotted from the ledger at campaign create. */
export interface AccessReviewItem {
  /** Deterministic id — hash of campaignId + the assignment tuple. */
  id: string;
  /** The ledger assignment id (present when sourced from the ledger; enables revoke). */
  assignmentId?: string;
  principalId: string;
  principalUpn?: string;
  principalType: string;
  resourceType: string;
  resourceRef: string;
  resourceName?: string;
  role: string;
  permission?: string;
  source: string;
  decision: ReviewDecision;
  decidedBy?: string;
  decidedAt?: string;
  note?: string;
  /** Set when the revoke actually ran (real backend revoke succeeded). */
  revokedAt?: string;
}

export type ReviewStatus = 'active' | 'completed' | 'closed';

/** Cosmos doc for a review campaign (container `access-reviews`, PK /tenantId). */
export interface AccessReview {
  id: string;
  tenantId: string;            // partition key — creator's s.claims.oid
  kind: 'access-review';
  name: string;
  description?: string;
  scope: ReviewScope;
  /** Named reviewers (user/group) who may act on this campaign. */
  reviewers: ApproverBinding[];
  /** Reviewers this campaign was delegated to (additive to `reviewers`). */
  delegatedTo?: ApproverBinding[];
  /** Recurrence cadence in days (informational + drives the next campaign date). */
  cadenceDays?: number | null;
  /** ISO deadline; past it, the sweeper auto-revokes undecided items (if enabled). */
  dueAt?: string | null;
  /** When true, undecided items are REVOKED when the campaign closes at deadline. */
  autoRevokeOnExpiry: boolean;
  status: ReviewStatus;
  items: AccessReviewItem[];
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  closedBy?: string;
}

/** Rollup counts for the inbox/progress UI. */
export interface ReviewStats {
  total: number;
  attested: number;
  revoked: number;
  pending: number;
}
