/**
 * Approval-gated deployment-pipeline stage promotion (BR-APPROVAL).
 *
 * A stage can require N approvals from named users/groups before a promotion
 * INTO it executes. This module is the PURE state machine the approval routes
 * drive — no Cosmos, no Azure. It is governance-as-the-feature (admins CONFIGURE
 * the gate; that configuration IS the product), so the policy is admin-authored
 * and the request lifecycle is enforced here and unit-tested.
 *
 * Lifecycle of an approval request:
 *
 *   pending ──approve (count reached)──▶ approved ──promotion run──▶ promoted
 *      │                                    │                            │
 *      ├──any reject──▶ rejected            └──promotion throws──▶ promotion-failed
 *      └──requester cancel──▶ cancelled
 *
 * Eligibility: a principal may cast a decision when their oid, or any of their
 * group ids, matches an approver entry. The requester may cancel or reject their
 * own request but may NOT self-approve (separation of duties).
 */
import type {
  LoomApprover,
  LoomApprovalRequest,
  LoomApprovalDecision,
  LoomApprovalStatus,
} from '@/lib/types/loom-pipeline';

/** A principal casting an approval decision. */
export interface ApprovalPrincipal {
  oid: string;
  name?: string;
  /** Entra group ids from the session (`claims.groups`). */
  groups?: string[];
}

/** Does this principal match any approver entry (by oid or group id)? */
export function isEligibleApprover(approvers: LoomApprover[], principal: ApprovalPrincipal): boolean {
  if (!approvers?.length) return false;
  const ids = new Set<string>([principal.oid, ...(principal.groups || [])].filter(Boolean));
  return approvers.some((a) => ids.has(a.id));
}

/** Count of DISTINCT approvers who have cast an `approve` (rejections excluded). */
export function approveCount(request: Pick<LoomApprovalRequest, 'decisions'>): number {
  const approvers = new Set<string>();
  for (const d of request.decisions || []) {
    if (d.decision === 'approve') approvers.add(d.approverOid);
  }
  return approvers.size;
}

/** Has at least one eligible approver rejected? */
export function hasRejection(request: Pick<LoomApprovalRequest, 'decisions'>): boolean {
  return (request.decisions || []).some((d) => d.decision === 'reject');
}

/**
 * Derive the status a PENDING/APPROVED request should hold given its decisions +
 * required count. Terminal states (rejected/cancelled/promoted/promotion-failed)
 * are never re-derived here — the caller sets those explicitly.
 */
export function deriveStatus(
  request: Pick<LoomApprovalRequest, 'decisions' | 'requiredApprovals'>,
): Extract<LoomApprovalStatus, 'pending' | 'approved' | 'rejected'> {
  if (hasRejection(request)) return 'rejected';
  if (approveCount(request) >= Math.max(1, request.requiredApprovals || 1)) return 'approved';
  return 'pending';
}

/** True once the request is approved and a promotion may run. */
export function canPromote(request: Pick<LoomApprovalRequest, 'status'>): boolean {
  return request.status === 'approved';
}

/** Reasons a decision can be refused (before it is recorded). */
export type DecisionError =
  | 'not_pending'
  | 'not_eligible'
  | 'self_approval'
  | 'invalid_decision';

export interface ApplyDecisionInput {
  decision: 'approve' | 'reject';
  approverOid: string;
  approverName?: string;
  comment?: string;
  /** approver's group ids for eligibility. */
  approverGroups?: string[];
  /** clock injection for tests. */
  now?: string;
}

/**
 * Validate + apply a decision to a request, returning either the next request
 * state or a typed error. Pure: the input request is not mutated. A repeated
 * decision from the same approver OVERWRITES their prior one (approve↔reject).
 */
export function applyDecision(
  request: LoomApprovalRequest,
  input: ApplyDecisionInput,
): { ok: true; request: LoomApprovalRequest } | { ok: false; error: DecisionError } {
  if (input.decision !== 'approve' && input.decision !== 'reject') return { ok: false, error: 'invalid_decision' };
  if (request.status !== 'pending') return { ok: false, error: 'not_pending' };
  if (!isEligibleApprover(request.approvers, { oid: input.approverOid, groups: input.approverGroups })) {
    return { ok: false, error: 'not_eligible' };
  }
  // Separation of duties: the principal who requested the promotion cannot
  // approve it (they may still reject or cancel it).
  if (input.decision === 'approve' && request.requestedByOid === input.approverOid) {
    return { ok: false, error: 'self_approval' };
  }
  const at = input.now || new Date().toISOString();
  const decision: LoomApprovalDecision = {
    approverOid: input.approverOid,
    approverName: input.approverName || input.approverOid,
    decision: input.decision,
    comment: input.comment?.slice(0, 1024) || undefined,
    at,
  };
  // Replace any prior decision from this approver, then append the new one.
  const decisions = (request.decisions || []).filter((d) => d.approverOid !== input.approverOid).concat(decision);
  const next: LoomApprovalRequest = { ...request, decisions, updatedAt: at };
  next.status = deriveStatus(next);
  return { ok: true, request: next };
}

/** Human-readable one-liner of where a request stands (for audit detail / UI). */
export function summarizeApproval(request: LoomApprovalRequest): string {
  const n = approveCount(request);
  const req = Math.max(1, request.requiredApprovals || 1);
  switch (request.status) {
    case 'approved': return `Approved (${n}/${req})`;
    case 'rejected': return 'Rejected';
    case 'cancelled': return 'Cancelled by requester';
    case 'promoted': return `Promoted after ${n}/${req} approval(s)`;
    case 'promotion-failed': return 'Approved, but the promotion failed';
    default: return `Pending — ${n}/${req} approval(s)`;
  }
}
