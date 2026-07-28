/**
 * Contract test for GET /api/access-governance/reviews/[id]/evidence
 * (loom-apex B-N19c'): admin gate, inline view (records + chain verification +
 * readable summary), and both downloadable pack formats.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { buildEvidenceRecord } from '@/lib/access/evidence-record';
import type { AccessReview } from '@/lib/types/access-review';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn(), isTenantAdmin: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  accessReviewsContainer: vi.fn(),
  accessReviewEvidenceContainer: vi.fn(),
}));

import { GET } from '../reviews/[id]/evidence/route';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { accessReviewsContainer, accessReviewEvidenceContainer } from '@/lib/azure/cosmos-client';

const REVIEW: AccessReview = {
  id: 'c1', tenantId: 'tenant-a', kind: 'access-review', name: 'Q3 recert',
  scope: { kind: 'all' }, reviewers: [], cadenceDays: 90,
  dueAt: '2026-07-25T00:00:00.000Z', autoRevokeOnExpiry: true, status: 'closed',
  items: [
    { id: 'i1', principalId: 'p1', principalUpn: 'p1@x', principalType: 'User', resourceType: 'workspace', resourceRef: 'ws-1', role: 'Viewer', source: 'direct', decision: 'attest', decidedBy: 'r@x', decidedAt: '2026-07-20T00:00:00.000Z' },
  ],
  createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z',
  closedAt: '2026-07-25T00:00:00.000Z', closedBy: 'admin@x',
};

const RECORD = buildEvidenceRecord(REVIEW, { recordedBy: 'admin@x', now: '2026-07-25T00:00:00.000Z' });

function req(qs = '') {
  return { nextUrl: new URL(`http://x/api/access-governance/reviews/c1/evidence${qs}`) } as any;
}
const ctx = { params: Promise.resolve({ id: 'c1' }) } as any;

function queryContainer(resources: any[]) {
  return { items: { query: () => ({ fetchAll: async () => ({ resources }) }) } };
}

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'admin', upn: 'admin@x', tid: 'tid-1' } });
  (requireTenantAdmin as any).mockReturnValue(null);
  (accessReviewsContainer as any).mockResolvedValue(queryContainer([REVIEW]));
  (accessReviewEvidenceContainer as any).mockResolvedValue(queryContainer([RECORD]));
});

describe('GET /api/access-governance/reviews/[id]/evidence', () => {
  it('403 for a non-admin', async () => {
    (requireTenantAdmin as any).mockReturnValue(NextResponse.json({ ok: false }, { status: 403 }));
    expect((await GET(req(), ctx)).status).toBe(403);
  });

  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await GET(req(), ctx)).status).toBe(401);
  });

  it('404 for an unknown campaign', async () => {
    (accessReviewsContainer as any).mockResolvedValue(queryContainer([]));
    expect((await GET(req(), ctx)).status).toBe(404);
  });

  it('returns records, the chain verdict, and the readable summary', async () => {
    const res = await GET(req(), ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.scope).toBe('campaign');
    expect(j.records).toHaveLength(1);
    expect(j.records[0].contentHash).toBe(RECORD.contentHash);
    expect(j.verification.ok).toBe(true);
    expect(j.summary).toContain('ACCESS REVIEW EVIDENCE PACK');
    expect(j.summary).toContain(RECORD.contentHash);
  });

  it('reports a tampered record instead of silently serving it', async () => {
    const tampered = JSON.parse(JSON.stringify(RECORD));
    tampered.decisions[0].decision = 'revoke';
    (accessReviewEvidenceContainer as any).mockResolvedValue(queryContainer([tampered]));
    const j = await (await GET(req(), ctx)).json();
    expect(j.ok).toBe(true);
    expect(j.verification.ok).toBe(false);
    expect(j.verification.issues[0].kind).toBe('content-hash-mismatch');
    expect(j.summary).toContain('FAILED');
  });

  it('downloads the JSON pack as an attachment', async () => {
    const res = await GET(req('?download=json'), ctx);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('content-disposition')).toContain('attachment; filename="access-review-evidence-q3-recert.json"');
    const pack = JSON.parse(await res.text());
    expect(pack.artifact).toBe('access-review-evidence-pack');
    expect(pack.records[0].contentHash).toBe(RECORD.contentHash);
  });

  it('downloads the readable summary as a .txt attachment', async () => {
    const res = await GET(req('?download=txt'), ctx);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('content-disposition')).toContain('.txt"');
    expect(await res.text()).toContain('CSA LOOM — ACCESS REVIEW EVIDENCE PACK');
  });

  it('verifies the whole tenant chain with ?scope=tenant', async () => {
    const j = await (await GET(req('?scope=tenant'), ctx)).json();
    expect(j.scope).toBe('tenant');
    expect(j.verification.ok).toBe(true);
  });
});
