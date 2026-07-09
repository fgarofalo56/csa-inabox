/**
 * BR-APPROVAL — required-reviewer promotion gate: pure state-machine logic.
 */
import { describe, it, expect } from 'vitest';
import {
  isEligibleApprover, approveCount, hasRejection, deriveStatus, canPromote, applyDecision, summarizeApproval,
} from '@/lib/install/pipeline-approvals';
import type { LoomApprovalRequest, LoomApprover } from '@/lib/types/loom-pipeline';

const approvers: LoomApprover[] = [
  { id: 'user-a', type: 'user', displayName: 'A' },
  { id: 'user-b', type: 'user', displayName: 'B' },
  { id: 'group-x', type: 'group', displayName: 'X team' },
];

function baseRequest(over: Partial<LoomApprovalRequest> = {}): LoomApprovalRequest {
  return {
    id: 'approval-request:1', docType: 'approval-request', pipelineId: 'p1', tenantId: 't1',
    sourceStageId: 'dev', targetStageId: 'prod', requiredApprovals: 2, approvers,
    diffSummary: '1 changed', status: 'pending', decisions: [],
    requestedBy: 'req@t.com', requestedByOid: 'user-req', createdAt: 'now', updatedAt: 'now',
    ...over,
  };
}

describe('isEligibleApprover', () => {
  it('matches by user oid', () => {
    expect(isEligibleApprover(approvers, { oid: 'user-a' })).toBe(true);
    expect(isEligibleApprover(approvers, { oid: 'stranger' })).toBe(false);
  });
  it('matches by group membership', () => {
    expect(isEligibleApprover(approvers, { oid: 'stranger', groups: ['group-x'] })).toBe(true);
  });
  it('false for an empty approver list', () => {
    expect(isEligibleApprover([], { oid: 'user-a' })).toBe(false);
  });
});

describe('counting + status derivation', () => {
  it('counts distinct approvers only', () => {
    const r = baseRequest({ decisions: [
      { approverOid: 'user-a', approverName: 'A', decision: 'approve', at: 'n' },
      { approverOid: 'user-a', approverName: 'A', decision: 'approve', at: 'n' },
    ] });
    expect(approveCount(r)).toBe(1);
  });
  it('deriveStatus → pending / approved / rejected', () => {
    expect(deriveStatus(baseRequest())).toBe('pending');
    expect(deriveStatus(baseRequest({ decisions: [
      { approverOid: 'user-a', approverName: 'A', decision: 'approve', at: 'n' },
      { approverOid: 'user-b', approverName: 'B', decision: 'approve', at: 'n' },
    ] }))).toBe('approved');
    expect(deriveStatus(baseRequest({ decisions: [
      { approverOid: 'user-a', approverName: 'A', decision: 'reject', at: 'n' },
    ] }))).toBe('rejected');
    expect(hasRejection(baseRequest({ decisions: [{ approverOid: 'user-a', approverName: 'A', decision: 'reject', at: 'n' }] }))).toBe(true);
  });
});

describe('applyDecision', () => {
  it('rejects a non-eligible principal', () => {
    const out = applyDecision(baseRequest(), { decision: 'approve', approverOid: 'stranger' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('not_eligible');
  });

  it('blocks the requester from self-approving', () => {
    const req = baseRequest({ approvers: [...approvers, { id: 'user-req', type: 'user', displayName: 'Req' }] });
    const out = applyDecision(req, { decision: 'approve', approverOid: 'user-req' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('self_approval');
  });

  it('lets the requester reject their own request', () => {
    const req = baseRequest({ requiredApprovals: 1, approvers: [...approvers, { id: 'user-req', type: 'user', displayName: 'Req' }] });
    const out = applyDecision(req, { decision: 'reject', approverOid: 'user-req' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.request.status).toBe('rejected');
  });

  it('reaches approved only when the required count is met', () => {
    let req = baseRequest();
    const a = applyDecision(req, { decision: 'approve', approverOid: 'user-a', now: 'n1' });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.request.status).toBe('pending');
    const b = applyDecision(a.request, { decision: 'approve', approverOid: 'stranger', approverGroups: ['group-x'], now: 'n2' });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.request.status).toBe('approved');
    expect(canPromote(b.request)).toBe(true);
  });

  it('a single reject flips the request to rejected', () => {
    const out = applyDecision(baseRequest(), { decision: 'reject', approverOid: 'user-a' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.request.status).toBe('rejected');
  });

  it('overwrites an approver’s prior decision (reject after approve)', () => {
    const a = applyDecision(baseRequest(), { decision: 'approve', approverOid: 'user-a', now: 'n1' });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = applyDecision(a.request, { decision: 'reject', approverOid: 'user-a', now: 'n2' });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.request.decisions).toHaveLength(1);
    expect(b.request.status).toBe('rejected');
  });

  it('refuses a decision on a non-pending request', () => {
    const out = applyDecision(baseRequest({ status: 'approved' }), { decision: 'approve', approverOid: 'user-a' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('not_pending');
  });

  it('does not mutate the input request', () => {
    const req = baseRequest();
    applyDecision(req, { decision: 'approve', approverOid: 'user-a' });
    expect(req.decisions).toHaveLength(0);
  });
});

describe('summarizeApproval', () => {
  it('describes each terminal + pending state', () => {
    expect(summarizeApproval(baseRequest())).toMatch(/Pending — 0\/2/);
    expect(summarizeApproval(baseRequest({ status: 'promoted', decisions: [
      { approverOid: 'user-a', approverName: 'A', decision: 'approve', at: 'n' },
      { approverOid: 'user-b', approverName: 'B', decision: 'approve', at: 'n' },
    ] }))).toMatch(/Promoted after 2\/2/);
  });
});
