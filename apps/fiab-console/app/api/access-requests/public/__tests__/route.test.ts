/**
 * Contract tests for POST /api/access-requests/public — the unauthenticated
 * sign-in-boundary onboarding endpoint.
 *
 *   - happy path persists a pending request and returns 200 { status: 'received' }
 *   - honeypot ⇒ benign 200, NOTHING persisted (bots get no signal)
 *   - validation failure ⇒ 400
 *   - per-IP rate limit ⇒ the limiter's 429 is returned, nothing persisted
 *   - dedupe: an existing pending request for the same email ⇒ 200 'already-pending'
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/azure/cosmos-client', () => ({ signinAccessRequestsContainer: vi.fn() }));
vi.mock('@/lib/azure/rate-limiter', () => ({
  enforceRateLimitForKey: vi.fn(async () => null),
  clientIp: vi.fn(() => '203.0.113.9'),
}));

import { POST } from '../route';
import { signinAccessRequestsContainer } from '@/lib/azure/cosmos-client';
import { enforceRateLimitForKey } from '@/lib/azure/rate-limiter';

function makeReq(body: any) {
  return {
    json: async () => body,
    headers: { get: () => null },
    nextUrl: { origin: 'https://loom.example' },
  } as any;
}

function fakeContainer({ existing = [] as any[] } = {}) {
  const created: any[] = [];
  const container = {
    items: {
      query: () => ({ fetchAll: async () => ({ resources: existing }) }),
      create: async (d: any) => { created.push(d); return { resource: d }; },
    },
  };
  return { container, created };
}

const validBody = {
  displayName: 'Ada Lovelace',
  email: 'ada@contoso.com',
  organization: 'Contoso',
  reason: 'I need to build reports in Loom.',
};

beforeEach(() => {
  vi.resetAllMocks();
  (enforceRateLimitForKey as any).mockResolvedValue(null);
});

describe('POST /api/access-requests/public', () => {
  it('persists a pending request on the happy path', async () => {
    const { container, created } = fakeContainer();
    (signinAccessRequestsContainer as any).mockResolvedValue(container);
    const res = await POST(makeReq({ ...validBody }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.status).toBe('received');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ status: 'pending', source: 'signin', email: 'ada@contoso.com' });
    // Never store the raw IP — only a hash.
    expect(created[0].clientIpHash).toBeTruthy();
    expect(JSON.stringify(created[0])).not.toContain('203.0.113.9');
  });

  it('drops a honeypot submission without persisting', async () => {
    const { container, created } = fakeContainer();
    (signinAccessRequestsContainer as any).mockResolvedValue(container);
    const res = await POST(makeReq({ ...validBody, company_website: 'http://spam.example' }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(created).toHaveLength(0);
  });

  it('rejects an invalid submission with 400', async () => {
    const { container } = fakeContainer();
    (signinAccessRequestsContainer as any).mockResolvedValue(container);
    const res = await POST(makeReq({ ...validBody, email: 'nope' }));
    expect(res.status).toBe(400);
  });

  it('returns the rate limiter 429 and persists nothing', async () => {
    const { container, created } = fakeContainer();
    (signinAccessRequestsContainer as any).mockResolvedValue(container);
    (enforceRateLimitForKey as any).mockResolvedValueOnce(
      NextResponse.json({ ok: false, error: 'rate_limited' }, { status: 429 }),
    );
    const res = await POST(makeReq({ ...validBody }));
    expect(res.status).toBe(429);
    expect(created).toHaveLength(0);
  });

  it('is idempotent when a pending request for the same email already exists', async () => {
    const { container, created } = fakeContainer({ existing: [{ id: 'existing-1' }] });
    (signinAccessRequestsContainer as any).mockResolvedValue(container);
    const res = await POST(makeReq({ ...validBody }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.status).toBe('already-pending');
    expect(j.id).toBe('existing-1');
    expect(created).toHaveLength(0);
  });
});
