/**
 * BFF route tests for PATCH /api/governance/domains/[domainId].
 *
 * Focus: the move (reparent) branch's authorization + guard wiring added in the
 * Catalog-domains review:
 *   - A non-tenant-admin session cannot reparent a domain (403) — parity with
 *     PATCH /api/admin/domains, which also restricts `parentId` to tenant admins.
 *   - A tenant admin's move is delegated to the store (moveDomain) and a 400 from
 *     the shared hierarchy guard is surfaced verbatim.
 *   - A non-move update (name/description) still works for any authenticated user.
 *
 * The hierarchy invariants themselves are unit-tested in
 * lib/azure/__tests__/domains-client.test.ts (cosmosDomainStore.moveDomain) and
 * lib/azure/__tests__/domain-hierarchy.test.ts; here we only prove the route
 * gates + propagates them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

let sessionOid = 'user-1';
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => ({
    claims: { oid: sessionOid, upn: 'user@contoso.com' },
    exp: Date.now() / 1000 + 3600,
  })),
}));

const moveDomain = vi.fn(async (_t: string, id: string, parent: string | undefined) => ({
  id, tenantId: 'user-1', name: id, parentDomainId: parent, createdAt: '', createdBy: '',
}));
const updateDomain = vi.fn(async (_t: string, id: string, patch: any) => ({
  id, tenantId: 'user-1', name: patch.name || id, createdAt: '', createdBy: '',
}));

vi.mock('@/lib/azure/domains-client', () => ({
  DomainsBackendGateError: class extends Error {},
  getDomainsStore: () => ({ moveDomain, updateDomain }),
}));

vi.mock('@/lib/governance/domain-audit', () => ({ writeDomainAudit: vi.fn(async () => {}) }));

function makeReq(body: unknown) {
  return new NextRequest('https://loom.test/api/governance/domains/movable', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const ctx = { params: Promise.resolve({ domainId: 'movable' }) };

describe('PATCH /api/governance/domains/[domainId] — move authorization + guards', () => {
  const ORIG = { ...process.env };
  beforeEach(() => {
    moveDomain.mockClear();
    updateDomain.mockClear();
    sessionOid = 'user-1';
    delete process.env.LOOM_TENANT_ADMIN_OID;
    delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  });
  afterEach(() => { process.env = { ...ORIG }; vi.restoreAllMocks(); });

  it('rejects a reparent from a non-tenant-admin (403) and never calls moveDomain', async () => {
    // Configure a DIFFERENT oid as the tenant admin → the session is not admin.
    process.env.LOOM_TENANT_ADMIN_OID = 'someone-else';
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({ parentDomainId: 'finance' }), ctx);
    expect(res.status).toBe(403);
    expect(moveDomain).not.toHaveBeenCalled();
  });

  it('allows a tenant admin to reparent and delegates to the store', async () => {
    // No admin env configured → console-gated default treats the session as admin.
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({ parentDomainId: 'finance' }), ctx);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.moved).toBe(true);
    expect(moveDomain).toHaveBeenCalledWith('user-1', 'movable', 'finance', 'user@contoso.com');
  });

  it('surfaces a 400 hierarchy-guard error from the store verbatim', async () => {
    moveDomain.mockRejectedValueOnce(Object.assign(new Error('A domain cannot be its own parent.'), { status: 400 }));
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({ parentDomainId: 'movable' }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/own parent/i);
  });

  it('lets any authenticated user update name/description (non-move)', async () => {
    process.env.LOOM_TENANT_ADMIN_OID = 'someone-else'; // session is NOT admin
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({ name: 'Renamed' }), ctx);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(updateDomain).toHaveBeenCalled();
    expect(moveDomain).not.toHaveBeenCalled();
  });
});
