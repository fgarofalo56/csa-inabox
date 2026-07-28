/**
 * Close-path contract (loom-apex B-N19c'): closing a review campaign must
 * (a) persist the closed campaign, and (b) seal a signed evidence record whose
 * hash chain verifies — in that ORDER, so an evidence record can never claim a
 * close that was not durable.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AccessReview } from '@/lib/types/access-review';
import { verifyEvidenceChain } from '../evidence-record';

const h = vi.hoisted(() => ({
  order: [] as string[],
  replaced: [] as any[],
  evidence: [] as any[],
  audit: [] as any[],
  emitted: [] as any[],
  head: null as any,
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  accessReviewsContainer: async () => ({
    item: () => ({ replace: async (doc: any) => { h.order.push('campaign-replace'); h.replaced.push(doc); return { resource: doc }; } }),
  }),
  accessReviewEvidenceContainer: async () => ({
    items: {
      query: () => ({ fetchAll: async () => ({ resources: h.head ? [h.head] : [] }) }),
      create: async (doc: any) => { h.order.push('evidence-create'); h.evidence.push(doc); return { resource: doc }; },
    },
  }),
  accessAssignmentsContainer: async () => ({
    item: () => ({ read: async () => ({ resource: { id: 'as-1', principalId: 'p2', resourceType: 'workspace', resourceRef: 'ws-1', role: 'Contributor', state: 'active' } }) }),
  }),
  auditLogContainer: async () => ({ items: { create: async (doc: any) => { h.audit.push(doc); return { resource: doc }; } } }),
}));

vi.mock('@/lib/access/revoke-assignment', () => ({
  revokeAssignment: async () => ({ revoked: true, warnings: [] }),
}));

vi.mock('@/lib/admin/audit-stream', () => ({
  emitAuditEvent: (ev: any) => { h.emitted.push(ev); },
}));

const { closeCampaign } = await import('../close-campaign');

function review(over: Partial<AccessReview> = {}): AccessReview {
  return {
    id: 'camp-1',
    tenantId: 'tenant-a',
    kind: 'access-review',
    name: 'Q3 recertification',
    scope: { kind: 'all' },
    reviewers: [],
    cadenceDays: 90,
    dueAt: '2026-07-25T00:00:00.000Z',
    autoRevokeOnExpiry: true,
    status: 'active',
    items: [
      { id: 'i1', assignmentId: 'as-0', principalId: 'p1', principalType: 'User', resourceType: 'workspace', resourceRef: 'ws-1', role: 'Viewer', source: 'direct', decision: 'attest', decidedBy: 'r@x', decidedAt: '2026-07-20T00:00:00.000Z' },
      { id: 'i2', assignmentId: 'as-1', principalId: 'p2', principalType: 'User', resourceType: 'workspace', resourceRef: 'ws-1', role: 'Contributor', source: 'direct', decision: 'pending' },
    ],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  } as AccessReview;
}

beforeEach(() => {
  h.order.length = 0; h.replaced.length = 0; h.evidence.length = 0;
  h.audit.length = 0; h.emitted.length = 0; h.head = null;
});

describe('closeCampaign — evidence emission', () => {
  it('persists the campaign, THEN seals a verifiable evidence record', async () => {
    const res = await closeCampaign(review(), 'admin@contoso.com', { oid: 'oid-1', upn: 'admin@contoso.com', tid: 'tid-1' });

    expect(res.review.status).toBe('closed');
    expect(res.revoked).toBe(1);
    // Ordering: durable close first, evidence second.
    expect(h.order).toEqual(['campaign-replace', 'evidence-create']);
    expect(h.replaced).toHaveLength(1);
    expect(h.replaced[0].status).toBe('closed');

    expect(res.evidence).not.toBeNull();
    const ev = res.evidence!;
    expect(ev.campaignId).toBe('camp-1');
    expect(ev.sequence).toBe(1);
    expect(ev.totals).toMatchObject({ total: 2, attested: 1, revoked: 1, pending: 0, autoRevoked: 1, backendRevoked: 1 });
    expect(ev.revocations).toHaveLength(1);
    expect(ev.revocations[0].reason).toBe('auto-close');
    expect(verifyEvidenceChain([ev]).ok).toBe(true);

    // Fanned out to the SIEM stream / webhooks + the Cosmos audit trail.
    expect(h.emitted.map((e) => e.action)).toContain('access-review.evidence-sealed');
    expect(h.audit.map((a) => a.action)).toContain('review-evidence-sealed');
  });

  it('chains onto the tenant head when earlier evidence exists', async () => {
    const first = await closeCampaign(review(), 'admin@contoso.com');
    h.head = first.evidence;
    h.order.length = 0;
    const second = await closeCampaign(review({ id: 'camp-2', name: 'Q4' }), 'admin@contoso.com');
    expect(second.evidence!.sequence).toBe(2);
    expect(second.evidence!.prevHash).toBe(first.evidence!.contentHash);
    expect(verifyEvidenceChain([first.evidence!, second.evidence!]).ok).toBe(true);
  });

  it('records a non-auto-revoke campaign with its undecided grants intact', async () => {
    const res = await closeCampaign(review({ autoRevokeOnExpiry: false }), 'admin@contoso.com');
    expect(res.revoked).toBe(0);
    expect(res.evidence!.totals).toMatchObject({ total: 2, attested: 1, revoked: 0, pending: 1, autoRevoked: 0 });
    expect(res.evidence!.revocations).toEqual([]);
    expect(verifyEvidenceChain([res.evidence!]).ok).toBe(true);
  });
});
