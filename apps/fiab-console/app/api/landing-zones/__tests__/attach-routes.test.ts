/**
 * BFF route specs for the brownfield attach surface. Pins:
 *   - authz: every route enforces `admin.attach-service` (a 403 from the gate
 *     short-circuits before any backend work),
 *   - preflight happy path: ARG-by-id → honest per-resource verdict,
 *   - attach happy path: registers via the store + returns a receipt,
 *   - detach: 409 when an item still binds the service (referential integrity).
 *
 * enforceCapability / pdpCheck / the store / ARM creds + fetch are mocked so the
 * specs exercise the route wiring, not live Azure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'admin-oid', tid: 'tenant-1', upn: 'a@x.com' } }) as any);
const enforceMock = vi.fn(async () => null as any);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  tenantScopeId: (s: any) => s?.claims?.tid ?? s?.claims?.oid,
}));
vi.mock('@/lib/auth/feature-gate', () => ({ enforceCapability: (...a: any[]) => enforceMock(...a) }));
vi.mock('@/lib/auth/pdp/enforce', () => ({ pdpCheck: async () => null }));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: () => {} }));

// ARM creds + user token — return a token so the ARG path runs; fetch is mocked.
vi.mock('@/lib/azure/arm-credential', () => ({ uamiArmCredential: () => ({ getToken: async () => ({ token: 'uami-tok' }) }) }));
vi.mock('@/lib/azure/user-token-store', () => ({ getUserArmToken: async () => null }));

// Store — mocked so attach/detach don't touch Cosmos.
const createMock = vi.fn(async (_s: any, input: any) => ({ id: 'svc-1', ...input, hasSecret: false }));
const detachMock = vi.fn(async () => {});
class InUse extends Error { status = 409; dependents = [{ id: 'i1', itemType: 'notebook', displayName: 'NB' }]; }
vi.mock('@/lib/azure/attached-services-store', () => ({
  createAttachedService: (...a: any[]) => createMock(...a),
  detachService: (...a: any[]) => detachMock(...a),
  listAttachedServices: async () => [],
  reconcileDay0Byo: async () => ({ seeded: 0, kinds: [], skippedExisting: 0 }),
  AttachedServiceInUseError: InUse,
}));

const ADX_ID = '/subscriptions/s/resourceGroups/r/providers/Microsoft.Kusto/clusters/c1';

/** Mock global fetch → ARG returns the ADX resource with a public posture. */
function mockArgFetch(rows: any[]) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: rows }), { status: 200 })));
}

describe('brownfield attach routes', () => {
  beforeEach(() => {
    getSessionMock.mockReturnValue({ claims: { oid: 'admin-oid', tid: 'tenant-1', upn: 'a@x.com' } });
    enforceMock.mockResolvedValue(null);
    createMock.mockClear(); detachMock.mockClear();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('preflight: 403 when the capability gate denies', async () => {
    enforceMock.mockResolvedValueOnce(NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 }));
    const { POST } = await import('../[id]/attach/preflight/route');
    const req = new NextRequest('https://x/api/landing-zones/hub/attach/preflight', {
      method: 'POST', body: JSON.stringify({ services: [{ armResourceId: ADX_ID, kind: 'adx' }] }),
    });
    const res = await POST(req, { params: { id: 'hub' } });
    expect(res.status).toBe(403);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('preflight: returns an honest verdict for a reachable public resource', async () => {
    mockArgFetch([{ id: ADX_ID, type: 'microsoft.kusto/clusters', properties: { publicNetworkAccess: 'Enabled' } }]);
    const { POST } = await import('../[id]/attach/preflight/route');
    const req = new NextRequest('https://x/api/landing-zones/hub/attach/preflight', {
      method: 'POST', body: JSON.stringify({ services: [{ armResourceId: ADX_ID, kind: 'adx' }] }),
    });
    const res = await POST(req, { params: { id: 'hub' } });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.results[0].reachability).toBe('reachable');
    expect(j.results[0].rbacRoleName).toBe('Contributor');
  });

  it('attach: registers the service and returns a receipt', async () => {
    mockArgFetch([{ id: ADX_ID, name: 'c1', type: 'microsoft.kusto/clusters', properties: { publicNetworkAccess: 'Enabled' } }]);
    const { POST } = await import('../[id]/attach/route');
    const req = new NextRequest('https://x/api/landing-zones/hub/attach', {
      method: 'POST', body: JSON.stringify({ services: [{ armResourceId: ADX_ID, kind: 'adx', displayName: 'c1' }] }),
    });
    const res = await POST(req, { params: { id: 'hub' } });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.receipt.attached).toBe(1);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(j.registered[0].kind).toBe('adx');
    // Every attach records the RBAC manual action.
    expect(j.manualActions.some((m: any) => /Contributor/.test(m.action))).toBe(true);
  });

  it('detach: 409 when an item still binds the service', async () => {
    detachMock.mockRejectedValueOnce(new InUse('in use'));
    const { DELETE } = await import('../[id]/services/[serviceId]/route');
    const res = await DELETE(new Request('https://x'), { params: { id: 'hub', serviceId: 'svc-1' } });
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.code).toBe('in_use');
    expect(j.dependents).toHaveLength(1);
  });

  it('services GET: 401 when unauthenticated (gate returns 401)', async () => {
    enforceMock.mockResolvedValueOnce(NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }));
    const { GET } = await import('../[id]/services/route');
    const res = await GET(new Request('https://x'), { params: { id: 'hub' } });
    expect(res.status).toBe(401);
  });
});
