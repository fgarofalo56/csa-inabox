/**
 * /api/health/tenants/[id] - authorization and gate contract.
 *
 * What would break each test is named inline. The provisioning logic itself is
 * covered in lib/install/provisioners/__tests__/health-tenant-provisioner.test.ts.
 * The REAL health.tenant-admin gate runs here; only the grants store is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const grants = vi.hoisted(() => ({ rows: [] as any[] }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(),
  featurePermissionsContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: grants.rows }) }) },
  }),
}));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {},
  ManagedIdentityCredential: class {},
  ChainedTokenCredential: class {},
}));
vi.mock('@/lib/azure/aca-managed-identity', () => ({ AcaManagedIdentityCredential: class {} }));
vi.mock('@/lib/auth/session', async (orig) => ({ ...(await orig<typeof import('@/lib/auth/session')>()), getSession: vi.fn() }));

const loadOwnedItem = vi.hoisted(() => vi.fn(async (..._a: any[]) => null as any));
vi.mock('@/app/api/items/_lib/item-crud', () => ({ loadOwnedItem: (...a: any[]) => loadOwnedItem(...a) }));

import { getSession } from '@/lib/auth/session';
import { POST, PATCH } from '../[id]/route';

const SESSION = { claims: { oid: 'oid-1', tid: 'tid-1', upn: 'a@b.c', groups: [] } };
const req = (body?: unknown) =>
  ({ nextUrl: { pathname: '/api/health/tenants/item-1' }, json: async () => body ?? {} }) as any;
const ctx = { params: Promise.resolve({ id: 'item-1' }) } as any;
const grant = (role: string) => [{ capabilityId: 'health.tenant-admin', principalId: 'oid-1', role, tenantId: 'tid-1' }];

beforeEach(() => {
  vi.mocked(getSession).mockReturnValue(SESSION as any);
  grants.rows = grant('Contributor');
  loadOwnedItem.mockResolvedValue({ id: 'item-1', workspaceId: 'ws-1', itemType: 'health-tenant', displayName: 'Mercy General', state: {} });
  vi.stubEnv('LOOM_HEALTH_CP_URL', '');
  vi.stubEnv('LOOM_HEALTH_CP_AUDIENCE', '');
  vi.stubEnv('LOOM_TENANT_ADMIN_OID', '');
  vi.stubEnv('LOOM_TENANT_ADMIN_GROUP_ID', '');
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('POST /api/health/tenants/[id]', () => {
  it('is gated on an explicit health.tenant-admin grant: no grant gets the 403 and the item is never loaded', async () => {
    grants.rows = [];
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).capability).toBe('health.tenant-admin');
    // Removing the gate would let a plain item owner provision a clinical-data tenant.
    expect(loadOwnedItem).not.toHaveBeenCalled();
  });

  it('a Loom tenant admin with NO health grant is refused (D12: not inherited)', async () => {
    vi.stubEnv('LOOM_TENANT_ADMIN_OID', 'oid-1');
    grants.rows = [];
    const res = await POST(req(), ctx);
    // Breaks if the shared tenant-admin bypass is reintroduced: the status becomes 503 and loadOwnedItem runs.
    expect(res.status).toBe(403);
    expect(loadOwnedItem).not.toHaveBeenCalled();
  });

  it('with the control plane unconfigured returns the 503 health-control-plane gate envelope, not an empty success', async () => {
    const res = await POST(req(), ctx);
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.gated).toBe(true);
    expect(j.gate.id).toBe('health-control-plane');
    expect(j.gate.fixItHref).toBe('/admin/gates?gate=health-control-plane');
    expect(j.missing).toEqual(['LOOM_HEALTH_CP_URL', 'LOOM_HEALTH_CP_AUDIENCE']);
  });

  it('404s an item the caller cannot load (id probing across tenants)', async () => {
    loadOwnedItem.mockResolvedValue(null);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/health/tenants/[id] (quota edit)', () => {
  const bound = { healthTenant: { tenantId: 'mercy-general', stampId: 's1', sourceName: 'Mercy General', tenantIdSanitized: true, status: 'bound', resources: [] } };
  const okQuotas = { maxRequestsPerMinute: 10, maxStorageGiB: 10 };
  const withBinding = () => loadOwnedItem.mockResolvedValue({ id: 'item-1', workspaceId: 'ws-1', itemType: 'health-tenant', displayName: 'Mercy General', state: bound });

  it('refuses a caller with no health grant before loading the item', async () => {
    grants.rows = [];
    const res = await PATCH(req({ quotas: okQuotas }), ctx);
    expect(res.status).toBe(403);
    expect(loadOwnedItem).not.toHaveBeenCalled();
  });

  it('a Reader grant is not enough to edit (Contributor required)', async () => {
    grants.rows = grant('Reader');
    // Lowering the required role to Reader makes this 409/503 instead of 403.
    expect((await PATCH(req({ quotas: okQuotas }), ctx)).status).toBe(403);
  });

  it('409s an item that has no tenant yet', async () => {
    expect((await PATCH(req({ quotas: okQuotas }), ctx)).status).toBe(409);
  });

  it.each([
    ['zero requests per minute (min is 1)', { maxRequestsPerMinute: 0, maxStorageGiB: 10 }],
    ['a fractional storage value', { maxRequestsPerMinute: 10, maxStorageGiB: 1.5 }],
    ['storage above 10,000,000 GiB', { maxRequestsPerMinute: 10, maxStorageGiB: 10_000_001 }],
    ['a string for requests per minute', { maxRequestsPerMinute: '10', maxStorageGiB: 10 }],
  ])('400s %s', async (_n, quotas) => {
    withBinding();
    expect((await PATCH(req({ quotas }), ctx)).status).toBe(400);
  });

  it('a valid edit passes validation and reaches the control-plane client (gate 503 when it is unconfigured)', async () => {
    withBinding();
    const res = await PATCH(req({ quotas: okQuotas }), ctx);
    // 400 here would mean validation rejected a legal value; 200 would mean it skipped the control plane.
    expect(res.status).toBe(503);
    expect((await res.json()).gate.id).toBe('health-control-plane');
  });
});
