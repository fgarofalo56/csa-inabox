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
  // Phase-2 (#2007): the attach route resolves the registry tenant and persists
  // best-effort integration results. Both mirror the real store's contract.
  attachedTenantId: (s: any) => s?.claims?.tid ?? s?.claims?.oid,
  applyIntegrationResults: async () => {},
  AttachedServiceInUseError: InUse,
}));

// Phase-2 auto-integration (#2007) — mocked so the attach happy path is hermetic.
// The UAMI principal resolves; runAttachIntegration returns no RBAC verdict so the
// route falls through to the honest "grant Contributor" manual action the spec pins.
vi.mock('@/lib/clients/azure-connections-client', () => ({
  resolveUamiPrincipalId: async () => 'uami-principal-id',
}));
vi.mock('@/lib/azure/attach-integration', () => ({
  runAttachIntegration: async () => ({}),
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

/**
 * The ARG query carries each armResourceId in a KQL string literal, which uses
 * backslash escapes (escapeKqlLiteral), not T-SQL quote doubling.
 */
describe('attach routes: ARG id literal follows the KQL rule', () => {
  // A quote and a trailing backslash: under doubling the query would read
  // `'…c''1\'`, where KQL takes `\'` as an escaped quote and never closes.
  const ODD_ID = "/subscriptions/s/resourceGroups/r/providers/Microsoft.Kusto/clusters/c'1\\";

  beforeEach(() => {
    getSessionMock.mockReturnValue({ claims: { oid: 'admin-oid', tid: 'tenant-1', upn: 'a@x.com' } });
    enforceMock.mockResolvedValue(null);
    createMock.mockClear();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function captureArg() {
    const fetchMock = vi.fn(async (..._a: any[]) => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return () => fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)).query as string);
  }

  it.each([
    ['preflight', '../[id]/attach/preflight/route'],
    ['attach', '../[id]/attach/route'],
  ])('%s: sends the id with the quote and the backslash escaped', async (_n, mod) => {
    const queries = captureArg();
    const { POST } = await import(mod);
    const req = new NextRequest('https://x/api/landing-zones/hub/attach', {
      method: 'POST', body: JSON.stringify({ services: [{ armResourceId: ODD_ID, kind: 'adx' }] }),
    });
    await POST(req, { params: { id: 'hub' } });
    const qs = queries();
    expect(qs.length).toBeGreaterThan(0);
    // Breaks if the route goes back to escapeSqlLiteral: `c''1\` is what it sends.
    expect(qs[0]).toContain("id in~ ('/subscriptions/s/resourceGroups/r/providers/Microsoft.Kusto/clusters/c\\'1\\\\')");
  });

  it.each([
    ['preflight', '../[id]/attach/preflight/route'],
    ['attach', '../[id]/attach/route'],
  ])('%s: an id with a control character is a 400 and no ARG call is made', async (_n, mod) => {
    const queries = captureArg();
    const { POST } = await import(mod);
    const req = new NextRequest('https://x/api/landing-zones/hub/attach', {
      method: 'POST', body: JSON.stringify({ services: [{ armResourceId: `${ADX_ID}\u0000`, kind: 'adx' }] }),
    });
    const res = await POST(req, { params: { id: 'hub' } });
    // Breaks if the up-front buildIdQuery check is removed: the literal error
    // would surface from inside the ARG helper instead of as a 400 here.
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toMatch(/^armResourceId: .*U\+0000/);
    expect(queries()).toHaveLength(0);
    expect(createMock).not.toHaveBeenCalled();
  });
});
