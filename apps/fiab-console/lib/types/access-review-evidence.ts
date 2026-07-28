/**
 * Signed evidence records for access-review campaigns (loom-apex B-N19c').
 *
 * When a recertification campaign CLOSES, Loom writes an IMMUTABLE evidence
 * record capturing what was reviewed, who decided what, and which grants were
 * actually torn down. Each record carries a SHA-256 `contentHash` over its own
 * canonical body, and that body includes the `prevHash` of the previous record
 * for the same tenant — a hash chain, so mutating any historical decision breaks
 * every record from that point forward (tamper evidence, the SOX/FedRAMP CA
 * audit-standard property N19c calls for).
 *
 * Stored in the `access-review-evidence` Cosmos container (PK /tenantId — the
 * same partition key the `access-reviews` campaigns use, so the chain head read
 * and the per-campaign pack read both hit a single physical partition). Records
 * are append-only: nothing in Loom ever replaces or deletes one.
 */
import type { ReviewDecision, ReviewScope, ReviewStats } from './access-review';

/** One reviewer decision, frozen into the evidence record. */
export interface EvidenceDecision {
  /** The review-item id (deterministic hash of campaign + grant tuple). */
  itemId: string;
  /** Entitlement-ledger assignment id, when the grant came from the ledger. */
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
  /** Set when the real backend revoke ran for this grant. */
  revokedAt?: string;
}

/** A grant that was actually torn down as a result of this campaign. */
export interface EvidenceRevocation {
  itemId: string;
  assignmentId?: string;
  principalId: string;
  principalUpn?: string;
  resourceType: string;
  resourceRef: string;
  role: string;
  revokedAt: string;
  revokedBy: string;
  /** 'reviewer' when a reviewer chose revoke; 'auto-close' for no-response. */
  reason: 'reviewer' | 'auto-close';
}

/** Campaign metadata, frozen at close. */
export interface EvidenceCampaign {
  id: string;
  name: string;
  description?: string;
  scope: ReviewScope;
  reviewers: { type: string; id: string; name?: string }[];
  delegatedTo: { type: string; id: string; name?: string }[];
  cadenceDays: number | null;
  dueAt: string | null;
  autoRevokeOnExpiry: boolean;
  createdBy?: string;
  createdAt: string;
  closedAt: string;
  closedBy: string;
}

/** Rollups recorded alongside the decisions. */
export interface EvidenceTotals extends ReviewStats {
  /** Grants revoked because nobody responded before close. */
  autoRevoked: number;
  /** Revokes that produced a real Azure backend teardown during close. */
  backendRevoked: number;
}

/** The genesis `prevHash` — the first record for a tenant links to all-zeroes. */
export const EVIDENCE_GENESIS_HASH = '0'.repeat(64);

/** Canonicalization + hash version. Bump only with a migration. */
export const EVIDENCE_VERSION = 1 as const;

/**
 * One immutable, hash-chained evidence record. `contentHash` is EXCLUDED from
 * its own hash input (everything else, including `prevHash`, is included).
 */
export interface AccessReviewEvidence {
  /** `${campaignId}:${sequence}` — deterministic, so a retry cannot double-write. */
  id: string;
  /** Partition key — the campaign's tenantId (the chain is per tenant). */
  tenantId: string;
  kind: 'access-review-evidence';
  version: typeof EVIDENCE_VERSION;
  algorithm: 'sha256';
  /** 1-based position in this tenant's chain. */
  sequence: number;
  /** `contentHash` of the previous record for this tenant (genesis for seq 1). */
  prevHash: string;
  /** SHA-256 over the canonical body (all fields except `contentHash`). */
  contentHash: string;
  campaignId: string;
  campaign: EvidenceCampaign;
  decisions: EvidenceDecision[];
  revocations: EvidenceRevocation[];
  totals: EvidenceTotals;
  /** Non-fatal revoke warnings surfaced at close (truncated). */
  warnings: string[];
  recordedAt: string;
  recordedBy: string;
}

/** A single problem found while verifying a chain. */
export interface EvidenceChainIssue {
  sequence: number;
  recordId: string;
  kind: 'content-hash-mismatch' | 'chain-break' | 'sequence-gap' | 'duplicate-sequence';
  detail: string;
}

/** Result of verifying a tenant's (or a campaign's) evidence chain. */
export interface EvidenceChainVerification {
  ok: boolean;
  records: number;
  issues: EvidenceChainIssue[];
  /** Lowest sequence at which the chain first fails (undefined when ok). */
  brokenAt?: number;
  /** `contentHash` of the last record — the chain head. */
  headHash?: string;
}
