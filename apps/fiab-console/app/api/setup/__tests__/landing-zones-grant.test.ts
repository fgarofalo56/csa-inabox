/**
 * BFF contract tests for POST /api/setup/landing-zones/grant (Wave 1).
 *
 * Pins the attach-time RBAC auto-grant behaviour:
 *   - 401 unauthenticated
 *   - 400 on a non-Loom-DLZ resource group (route is not a generic grant surface)
 *   - 400 on a bad subscription id
 *   - 200 on a successful grant (resolves principal from env)
 *   - 403 honest gate (with RG-scoped commands) when the Console UAMI itself
 *     cannot write role assignments (grant route reports forbidden)
 *   - 403 honest gate when no Console principal id is known
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

// Admin gate — tenant-admin bypass via LOOM_TENANT_ADMIN_OID, mirrored from the
// existing deploy tests. The capability check queries a Cosmos container.
let featureGrants: any[] = [];
vi.mock('@/lib/azure/cosmos-client', () => ({
  featurePermissionsContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: featureGrants }) }) },
  }),
}));

let topologyResult: any = { exists: true, topology: { boundary: 'Commercial' } };
vi.mock('@/lib/setup/tenant-topology', () => ({
  getTenantTopologySafe: async () => topologyResult,
}));

const grantMock = vi.fn();
vi.mock('@/lib/setup/lz-rbac', async (orig) => {
  const actual = (await orig()) as any;
  return { ...actual, grantRgScopedRoles: (...a: any[]) => grantMock(...a) };
});

const SUB = '11111111-2222-3333-4444-555555555555';
const RG = 'rg-csa-loom-dlz-finance-centralus';
const PRINCIPAL = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function bodyReq(body: any) {
  return { url: 'http://x/api/setup/landing-zones/grant', json: async () => body } as any;
}

beforeEach(() => {
  featureGrants = [];
  topologyResult = { exists: true, topology: { boundary: 'Commercial' } };
  process.env.LOOM_TENANT_ADMIN_OID = 'oid-test';
  process.env.LOOM_CONSOLE_PRINCIPAL_ID = PRINCIPAL;
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
  grantMock.mockReset();
});
afterEach(() => {
  delete process.env.LOOM_TENANT_ADMIN_OID;
  delete process.env.LOOM_CONSOLE_PRINCIPAL_ID;
  vi.resetModules();
});

describe('POST /api/setup/landing-zones/grant', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('@/app/api/setup/landing-zones/grant/route');
    const r = await POST(bodyReq({ subscriptionId: SUB, resourceGroup: RG }));
    expect(r.status).toBe(401);
  });

  it('400 when the resource group is not a Loom DLZ RG', async () => {
    const { POST } = await import('@/app/api/setup/landing-zones/grant/route');
    const r = await POST(bodyReq({ subscriptionId: SUB, resourceGroup: 'rg-some-other' }));
    expect(r.status).toBe(400);
    expect(grantMock).not.toHaveBeenCalled();
  });

  it('400 when subscription id is not a GUID', async () => {
    const { POST } = await import('@/app/api/setup/landing-zones/grant/route');
    const r = await POST(bodyReq({ subscriptionId: 'nope', resourceGroup: RG }));
    expect(r.status).toBe(400);
  });

  it('200 on a successful grant, scoped to the DLZ RG', async () => {
    grantMock.mockResolvedValue({
      ok: true, allGranted: true, forbidden: false,
      scope: `/subscriptions/${SUB}/resourceGroups/${RG}`,
      outcomes: [{ role: 'Contributor', status: 'granted' }],
    });
    const { POST } = await import('@/app/api/setup/landing-zones/grant/route');
    const r = await POST(bodyReq({ subscriptionId: SUB, resourceGroup: RG }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.scope).toContain(`/resourceGroups/${RG}`);
    // Principal resolved from env, RG-scoped.
    expect(grantMock).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: SUB, resourceGroup: RG, principalObjectId: PRINCIPAL }),
    );
  });

  it('403 honest gate with RG-scoped commands when the Console cannot grant', async () => {
    grantMock.mockResolvedValue({
      ok: false, allGranted: false, forbidden: true,
      scope: `/subscriptions/${SUB}/resourceGroups/${RG}`,
      outcomes: [{ role: 'Contributor', status: 'failed', httpStatus: 403 }],
    });
    const { POST } = await import('@/app/api/setup/landing-zones/grant/route');
    const r = await POST(bodyReq({ subscriptionId: SUB, resourceGroup: RG }));
    expect(r.status).toBe(403);
    const j = await r.json();
    expect(j.error).toBe('forbidden');
    expect(Array.isArray(j.commands)).toBe(true);
    expect(j.commands.join('\n')).toContain(`/resourceGroups/${RG}`);
  });

  it('403 honest gate when no Console principal id is known', async () => {
    delete process.env.LOOM_CONSOLE_PRINCIPAL_ID;
    topologyResult = { exists: true, topology: { boundary: 'Commercial' } }; // no hubConsolePrincipalId
    const { POST } = await import('@/app/api/setup/landing-zones/grant/route');
    const r = await POST(bodyReq({ subscriptionId: SUB, resourceGroup: RG }));
    expect(r.status).toBe(403);
    const j = await r.json();
    expect(j.reason).toBe('no-console-principal');
    expect(grantMock).not.toHaveBeenCalled();
  });
});
