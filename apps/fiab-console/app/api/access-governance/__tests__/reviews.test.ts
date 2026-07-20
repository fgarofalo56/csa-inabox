/**
 * Contract tests for the access-review campaign routes (W4): sanitizer + list/
 * create. Cosmos + the admin gate are stubbed; the pure review logic runs real.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn(), isTenantAdmin: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  accessReviewsContainer: vi.fn(),
  accessAssignmentsContainer: vi.fn(),
  workspaceRolesContainer: vi.fn(),
}));

import { GET, POST, sanitizeReview } from '../reviews/route';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin, isTenantAdmin } from '@/lib/auth/feature-gate';
import { accessReviewsContainer, accessAssignmentsContainer, workspaceRolesContainer } from '@/lib/azure/cosmos-client';

function queryContainer(resources: any[], sink?: { doc?: any }) {
  return {
    items: {
      query: () => ({ fetchAll: async () => ({ resources }) }),
      create: async (doc: any) => { if (sink) sink.doc = doc; return { resource: doc }; },
    },
  };
}
function req(qs = '', body?: any) {
  return { nextUrl: new URL(`http://x/api/access-governance/reviews${qs}`), json: async () => body } as any;
}

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'admin', upn: 'admin@x', groups: [] } });
  (requireTenantAdmin as any).mockReturnValue(null);
  (isTenantAdmin as any).mockReturnValue(true);
});

describe('sanitizeReview', () => {
  it('requires a name', () => {
    expect(sanitizeReview({}).error).toMatch(/name/);
  });
  it('requires a ref for non-all scopes', () => {
    expect(sanitizeReview({ name: 'X', scope: { kind: 'package' } }).error).toMatch(/reference/);
  });
  it('defaults + normalizes', () => {
    const { review } = sanitizeReview({ name: 'Q3', scope: { kind: 'all' }, reviewers: [{ type: 'user', id: 'u1' }, { id: '' }], dueInDays: 30, cadenceDays: 90, autoRevokeOnExpiry: true });
    expect(review?.scope.kind).toBe('all');
    expect(review?.reviewers).toHaveLength(1);
    expect(review?.autoRevokeOnExpiry).toBe(true);
    expect(review?.cadenceDays).toBe(90);
    expect(review?.dueAt).toBeTruthy();
  });
});

describe('POST /reviews', () => {
  it('403 for a non-admin', async () => {
    (requireTenantAdmin as any).mockReturnValue(NextResponse.json({ ok: false }, { status: 403 }));
    const res = await POST(req('', { name: 'X' }));
    expect(res.status).toBe(403);
  });
  it('400 without a name', async () => {
    const res = await POST(req('', {}));
    expect(res.status).toBe(400);
  });
  it('snapshots in-scope ledger grants into review items', async () => {
    const sink: { doc?: any } = {};
    (accessAssignmentsContainer as any).mockResolvedValue(queryContainer([
      { id: 'a1', principalId: 'p1', principalType: 'User', resourceType: 'workspace', resourceRef: 'ws-1', role: 'Viewer', source: 'direct', state: 'active' },
      { id: 'a2', principalId: 'p2', principalType: 'User', resourceType: 'item', resourceRef: 'it-1', role: 'Reader', source: 'direct', state: 'revoked' },
    ]));
    (workspaceRolesContainer as any).mockResolvedValue(queryContainer([]));
    (accessReviewsContainer as any).mockResolvedValue(queryContainer([], sink));
    const res = await POST(req('', { name: 'Q3', scope: { kind: 'all' }, autoRevokeOnExpiry: true }));
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.itemCount).toBe(1); // revoked grant excluded
    expect(sink.doc.kind).toBe('access-review');
    expect(sink.doc.status).toBe('active');
    expect(sink.doc.items[0].decision).toBe('pending');
  });
});

describe('GET /reviews', () => {
  it('admin sees all campaigns with stats', async () => {
    (accessReviewsContainer as any).mockResolvedValue(queryContainer([
      { id: 'c1', name: 'A', scope: { kind: 'all' }, reviewers: [], status: 'active', items: [{ id: 'i1', decision: 'pending' }, { id: 'i2', decision: 'attest' }] },
    ]));
    const res = await GET(req());
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.reviews[0].stats).toEqual({ total: 2, attested: 1, revoked: 0, pending: 1 });
  });
  it('non-reviewer sees nothing', async () => {
    (isTenantAdmin as any).mockReturnValue(false);
    (accessReviewsContainer as any).mockResolvedValue(queryContainer([
      { id: 'c1', name: 'A', scope: { kind: 'all' }, reviewers: [{ type: 'user', id: 'someone-else' }], status: 'active', items: [] },
    ]));
    const res = await GET(req());
    const j = await res.json();
    expect(j.reviews).toHaveLength(0);
  });
});
