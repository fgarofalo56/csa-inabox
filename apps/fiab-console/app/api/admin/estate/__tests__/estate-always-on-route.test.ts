/**
 * BFF contract for GET /api/admin/estate/always-on (#5099 phase C).
 *
 * Uses the REAL `withTenantAdmin` (only the session and the admin verdict are mocked),
 * so the authorization cases measure the code that ships. The ONLY network edge,
 * `discoverAlwaysOn` (Resource Graph + Cost Management), is mocked: unmocked it reaches
 * a real credential chain and hangs in CI (the #5100 failure shape).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getSession = vi.fn();
const requireTenantAdmin = vi.fn(() => null as unknown);
vi.mock('@/lib/auth/session', async () => ({
  ...(await vi.importActual<typeof import('@/lib/auth/session')>('@/lib/auth/session')),
  getSession: () => getSession(),
}));
vi.mock('@/lib/auth/feature-gate', () => ({
  requireTenantAdmin: (...a: unknown[]) => requireTenantAdmin(...(a as [])),
  enforceCapability: vi.fn(async () => null),
}));

const discoverAlwaysOn = vi.fn();
vi.mock('@/lib/estate/estate-always-on', () => ({
  discoverAlwaysOn: (...a: unknown[]) => discoverAlwaysOn(...a),
}));

const ADMIN = { claims: { oid: 'admin-oid', upn: 'admin@contoso.com', tid: 'tenant-1' }, exp: 9_999_999_999 };
const get = () => ({ nextUrl: new URL('http://x/api/admin/estate/always-on') }) as never;
const ctx = { params: Promise.resolve({}) };

const RESULT = {
  estateId: 'loom:e',
  cloud: 'Commercial',
  rows: [{ resourceId: '/subscriptions/s/x', name: 'fw-hub', resourceType: 'microsoft.network/azurefirewalls' }],
  incomplete: false,
  totals: { actualMtd: { amount: 0, rows: 0 }, estimateMonthly: { amount: 0, currency: 'USD', rows: 0 }, unknownRows: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockReturnValue(ADMIN);
  requireTenantAdmin.mockReturnValue(null);
  discoverAlwaysOn.mockResolvedValue(RESULT);
  process.env.LOOM_ESTATE_ID = 'loom:e';
});

// The first import of the route pulls the real route toolkit (cold, ~9 s locally): give it room.
vi.setConfig({ testTimeout: 60_000 });

describe('GET /api/admin/estate/always-on', () => {
  // Breaks if: the route returns anything but the discovery result under the {ok:true,...} envelope.
  it('an admin gets ok:true with the rows, and discovery ran for THIS estate id', async () => {
    const { GET } = await import('../always-on/route');
    const res = await GET(get(), ctx);
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(j.ok).toBe(true);
    expect(j.rows.map((r: any) => r.name)).toEqual(['fw-hub']);
    expect(discoverAlwaysOn).toHaveBeenCalledTimes(1);
    expect(discoverAlwaysOn.mock.calls[0][0]).toMatchObject({ estateId: 'loom:e', cloud: 'Commercial' });
  });

  // Breaks if: an incomplete inventory is flattened to an empty list on the wire.
  it('an incomplete inventory is passed through as incomplete:true with its note (never as an empty complete list)', async () => {
    discoverAlwaysOn.mockResolvedValue({ ...RESULT, rows: [], incomplete: true, note: 'inventory incomplete: Resource Graph failed. Raw: 403-xyz' });
    const { GET } = await import('../always-on/route');
    const j = (await (await GET(get(), ctx)).json()) as any;
    expect(j.incomplete).toBe(true);
    expect(j.note).toContain('403-xyz');
    expect(j.rows).toEqual([]);
  });

  // Breaks if: `if (gate) return gate;` is removed from withTenantAdmin: discovery would run for a refused caller.
  it('a NON-admin gets the gate 403 and discovery (Azure) is NEVER called', async () => {
    requireTenantAdmin.mockReturnValue(new Response(JSON.stringify({ ok: false, error: 'admin_only' }), { status: 403 }));
    const { GET } = await import('../always-on/route');
    const res = await GET(get(), ctx);
    expect(res.status).toBe(403);
    expect(discoverAlwaysOn).not.toHaveBeenCalled();
  });

  // Breaks if: the session check is bypassed.
  it('an UNAUTHENTICATED caller gets 401 before the admin check', async () => {
    getSession.mockReturnValue(null);
    const { GET } = await import('../always-on/route');
    const res = await GET(get(), ctx);
    expect(res.status).toBe(401);
    expect(requireTenantAdmin).not.toHaveBeenCalled();
    expect(discoverAlwaysOn).not.toHaveBeenCalled();
  });
});
