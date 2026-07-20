/**
 * Contract test for the access-review decision route (W4, AG-7/AG-14): bulk
 * attest/revoke + reviewer authorization. Cosmos + the real revoke path stubbed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/feature-gate', () => ({ isTenantAdmin: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  accessReviewsContainer: vi.fn(),
  accessAssignmentsContainer: vi.fn(),
  auditLogContainer: vi.fn(),
}));
vi.mock('@/lib/access/revoke-assignment', () => ({ revokeAssignment: vi.fn() }));

import { POST } from '../reviews/[id]/decision/route';
import { getSession } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { accessReviewsContainer, accessAssignmentsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import { revokeAssignment } from '@/lib/access/revoke-assignment';

function makeReview() {
  return {
    id: 'c1', tenantId: 'admin', name: 'Q3', scope: { kind: 'all' }, reviewers: [], status: 'active',
    items: [
      { id: 'i1', assignmentId: 'a1', principalId: 'p1', decision: 'pending', resourceType: 'workspace', resourceRef: 'ws-1', role: 'Viewer', source: 'direct' },
      { id: 'i2', assignmentId: 'a2', principalId: 'p2', decision: 'pending', resourceType: 'item', resourceRef: 'it-1', role: 'Reader', source: 'direct' },
    ],
  };
}
let saved: any;
function reviewsContainer(review: any) {
  return {
    items: { query: () => ({ fetchAll: async () => ({ resources: [review] }) }) },
    item: () => ({ replace: async (doc: any) => { saved = doc; return { resource: doc }; } }),
  };
}
function ledgerContainer(rows: Record<string, any>) {
  return { item: (id: string) => ({ read: async () => ({ resource: rows[id] }) }) };
}
function req(body: any) { return { json: async () => body } as any; }
const ctx = { params: Promise.resolve({ id: 'c1' }) };

beforeEach(() => {
  vi.resetAllMocks();
  saved = undefined;
  (getSession as any).mockReturnValue({ claims: { oid: 'admin', upn: 'admin@x', groups: [] } });
  (isTenantAdmin as any).mockReturnValue(true);
  (auditLogContainer as any).mockResolvedValue({ items: { create: async () => ({}) } });
  (revokeAssignment as any).mockResolvedValue({ id: 'a1', revoked: true, warnings: [] });
});

it('400 without a valid decision', async () => {
  (accessReviewsContainer as any).mockResolvedValue(reviewsContainer(makeReview()));
  const res = await POST(req({ decision: 'nope' }), ctx);
  expect(res.status).toBe(400);
});

it('403 for a non-reviewer', async () => {
  (isTenantAdmin as any).mockReturnValue(false);
  (accessReviewsContainer as any).mockResolvedValue(reviewsContainer({ ...makeReview(), reviewers: [{ type: 'user', id: 'else' }] }));
  const res = await POST(req({ decision: 'attest', itemIds: ['i1'] }), ctx);
  expect(res.status).toBe(403);
});

it('bulk attest records decisions without revoking', async () => {
  (accessReviewsContainer as any).mockResolvedValue(reviewsContainer(makeReview()));
  const res = await POST(req({ decision: 'attest', itemIds: ['i1', 'i2'] }), ctx);
  const j = await res.json();
  expect(j.ok).toBe(true);
  expect(j.decided).toBe(2);
  expect(j.stats.attested).toBe(2);
  expect(revokeAssignment).not.toHaveBeenCalled();
});

it('revoke runs the real backend revoke for each item', async () => {
  (accessReviewsContainer as any).mockResolvedValue(reviewsContainer(makeReview()));
  (accessAssignmentsContainer as any).mockResolvedValue(ledgerContainer({
    a1: { id: 'a1', principalId: 'p1', state: 'active', resourceType: 'workspace', resourceRef: 'ws-1', source: 'direct' },
    a2: { id: 'a2', principalId: 'p2', state: 'active', resourceType: 'item', resourceRef: 'it-1', source: 'direct' },
  }));
  const res = await POST(req({ decision: 'revoke', all: true }), ctx);
  const j = await res.json();
  expect(j.ok).toBe(true);
  expect(j.decided).toBe(2);
  expect(j.revoked).toBe(2);
  expect(revokeAssignment).toHaveBeenCalledTimes(2);
  expect(saved.items.every((i: any) => i.decision === 'revoke')).toBe(true);
});
