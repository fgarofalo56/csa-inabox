/**
 * Contract tests for PATCH /api/admin/access-requests/[id] — the admin decision
 * endpoint for the sign-in-boundary onboarding queue. Exercises the REAL
 * tenant-admin gate (requireTenantAdmin) via env, plus the decision state machine.
 *
 *   - 401 unauthenticated
 *   - 403 for a non-admin session
 *   - 400 on invalid decision / deny without a note
 *   - approve ⇒ status 'approved' + an onboarding instruction in the response
 *   - deny ⇒ status 'denied' + the note recorded
 *   - 409 when the request is already actioned
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  signinAccessRequestsContainer: vi.fn(),
  auditLogContainer: vi.fn(),
}));

import { PATCH } from '../route';
import { getSession } from '@/lib/auth/session';
import { signinAccessRequestsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';

const ADMIN_OID = 'admin-oid';

function makeReq(body: any) {
  return { json: async () => body } as any;
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function fakeContainer(doc: any) {
  const store = { doc };
  const container = {
    item: () => ({
      read: async () => ({ resource: store.doc }),
      replace: async (next: any) => { store.doc = next; return { resource: next }; },
    }),
  };
  return { container, store };
}

function baseDoc(overrides: Partial<any> = {}) {
  return {
    id: 'req-1',
    tenantId: 'bucket',
    displayName: 'Ada Lovelace',
    email: 'ada@contoso.com',
    reason: 'need access',
    status: 'pending',
    source: 'signin',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.LOOM_TENANT_ADMIN_OID = ADMIN_OID;
  (getSession as any).mockReturnValue({ claims: { oid: ADMIN_OID, upn: 'admin@contoso.com' } });
  (auditLogContainer as any).mockResolvedValue({ items: { create: vi.fn(async () => ({})) } });
});
afterEach(() => {
  delete process.env.LOOM_TENANT_ADMIN_OID;
});

describe('PATCH /api/admin/access-requests/[id]', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await PATCH(makeReq({ decision: 'approved' }), ctx('req-1'));
    expect(res.status).toBe(401);
  });

  it('403 for a non-admin session', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'random-user', upn: 'x@contoso.com' } });
    const res = await PATCH(makeReq({ decision: 'approved' }), ctx('req-1'));
    expect(res.status).toBe(403);
  });

  it('400 on an invalid decision', async () => {
    const { container } = fakeContainer(baseDoc());
    (signinAccessRequestsContainer as any).mockResolvedValue(container);
    const res = await PATCH(makeReq({ decision: 'maybe' }), ctx('req-1'));
    expect(res.status).toBe(400);
  });

  it('400 when denying without a note', async () => {
    const { container } = fakeContainer(baseDoc());
    (signinAccessRequestsContainer as any).mockResolvedValue(container);
    const res = await PATCH(makeReq({ decision: 'denied' }), ctx('req-1'));
    expect(res.status).toBe(400);
  });

  it('approves a request and returns an onboarding instruction', async () => {
    const { container, store } = fakeContainer(baseDoc());
    (signinAccessRequestsContainer as any).mockResolvedValue(container);
    const res = await PATCH(makeReq({ decision: 'approved' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(store.doc.status).toBe('approved');
    expect(store.doc.reviewedByOid).toBe(ADMIN_OID);
    expect(typeof j.onboarding).toBe('string');
    expect(j.onboarding).toContain('ada@contoso.com');
  });

  it('denies a request and records the note', async () => {
    const { container, store } = fakeContainer(baseDoc());
    (signinAccessRequestsContainer as any).mockResolvedValue(container);
    const res = await PATCH(makeReq({ decision: 'denied', note: 'not in our org' }), ctx('req-1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(store.doc.status).toBe('denied');
    expect(store.doc.decisionNote).toBe('not in our org');
  });

  it('409 when the request is already actioned', async () => {
    const { container } = fakeContainer(baseDoc({ status: 'approved' }));
    (signinAccessRequestsContainer as any).mockResolvedValue(container);
    const res = await PATCH(makeReq({ decision: 'approved' }), ctx('req-1'));
    expect(res.status).toBe(409);
  });
});
