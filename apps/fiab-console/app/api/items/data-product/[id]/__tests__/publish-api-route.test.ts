/**
 * BFF route test for POST /api/items/data-product/[id]/publish-api (F21).
 *
 * Asserts: (1) unauthed → 401; (2) honest 503 gate when LOOM_SUBSCRIPTION_ID
 * is unset; (3) 400 when serviceUrl is missing; (4) happy path → 200 with a
 * real APIM API+product+subscription created (PUTs hit), the callable URL +
 * subscription key returned, and the API ref persisted to Cosmos via
 * updateOwnedItem.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

const loadOwnedItemMock = vi.fn();
const updateOwnedItemMock = vi.fn();
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a),
  updateOwnedItem: (...a: any[]) => updateOwnedItemMock(...a),
}));

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_APIM_NAME = 'apim-x';
  process.env.LOOM_APIM_RG = 'rg-apim';
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
  loadOwnedItemMock.mockReset();
  updateOwnedItemMock.mockReset();
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

function stubFetch(impl: (url: string, init?: any) => { status?: number; body?: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    const r = impl(String(url), init);
    return new Response(r.body == null ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }));
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const reqWith = (body: unknown) => ({ json: async () => body }) as any;

describe('POST /api/items/data-product/[id]/publish-api', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('@/app/api/items/data-product/[id]/publish-api/route');
    const r = await POST(reqWith({ serviceUrl: 'https://x' }), ctx('dp-123'));
    expect(r.status).toBe(401);
  });

  it('503 honest gate when LOOM_SUBSCRIPTION_ID is unset', async () => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    const { POST } = await import('@/app/api/items/data-product/[id]/publish-api/route');
    const r = await POST(reqWith({ serviceUrl: 'https://x' }), ctx('dp-123'));
    const j = await r.json();
    expect(r.status).toBe(503);
    expect(j.ok).toBe(false);
    expect(j.gated).toBe(true);
    expect(j.missing).toBe('LOOM_SUBSCRIPTION_ID');
    expect(j.bicepModule).toContain('apim.bicep');
  });

  it('400 when serviceUrl is missing', async () => {
    const { POST } = await import('@/app/api/items/data-product/[id]/publish-api/route');
    const r = await POST(reqWith({}), ctx('dp-123'));
    expect(r.status).toBe(400);
  });

  it('404 when the data-product item is not owned/found', async () => {
    loadOwnedItemMock.mockResolvedValue(null);
    const { POST } = await import('@/app/api/items/data-product/[id]/publish-api/route');
    const r = await POST(reqWith({ serviceUrl: 'https://dab.example.com/api/revenue' }), ctx('dp-123'));
    expect(r.status).toBe(404);
  });

  it('200 + creates real APIM API/product/subscription and persists the ref', async () => {
    loadOwnedItemMock.mockResolvedValue({
      id: 'dp-123', workspaceId: 'ws-1', itemType: 'data-product',
      displayName: 'Customer 360', state: { displayName: 'Customer 360', description: 'gold' },
    });
    updateOwnedItemMock.mockImplementation(async (_id: string, _t: string, _oid: string, patch: any) => ({
      id: 'dp-123', workspaceId: 'ws-1', itemType: 'data-product', displayName: 'Customer 360', state: patch.state,
    }));

    const hits: string[] = [];
    stubFetch((url, init) => {
      const method = (init?.method || 'GET').toUpperCase();
      hits.push(`${method} ${url}`);
      if (/\/listSecrets\?api-version=/.test(url)) return { body: { primaryKey: 'pk-123', secondaryKey: 'sk-123' } };
      if (/\/subscriptions\/sub-dp-dp-123\?/.test(url)) return { body: { id: '/x/subscriptions/sub-dp-dp-123', name: 'sub-dp-dp-123', properties: { state: 'active', displayName: 'Customer 360 — data product consumer' } } };
      if (/\/products\/dp-prod-dp-123\/apis\/dp-dp-123\?/.test(url)) return { status: 200, body: {} };
      if (/\/products\/dp-prod-dp-123\?/.test(url)) return { body: { id: '/x/products/dp-prod-dp-123', name: 'dp-prod-dp-123', properties: { state: 'published', displayName: 'Customer 360' } } };
      if (/\/apis\/dp-dp-123\?/.test(url)) return { body: { id: '/x/apis/dp-dp-123', name: 'dp-dp-123', properties: { displayName: 'Customer 360', path: 'dp/dp-123', protocols: ['https'], serviceUrl: 'https://dab.example.com/api/revenue' } } };
      // getServiceInfo — the bare service GET.
      if (/\/Microsoft\.ApiManagement\/service\/apim-x\?api-version=/.test(url)) return { body: { name: 'apim-x', properties: { provisioningState: 'Succeeded', gatewayUrl: 'https://apim-x.azure-api.net' } } };
      return { status: 404, body: { error: { message: `unexpected ${url}` } } };
    });

    const { POST } = await import('@/app/api/items/data-product/[id]/publish-api/route');
    const r = await POST(reqWith({ serviceUrl: 'https://dab.example.com/api/revenue' }), ctx('dp-123'));
    const j = await r.json();

    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.apiId).toBe('dp-dp-123');
    expect(j.productId).toBe('dp-prod-dp-123');
    expect(j.sid).toBe('sub-dp-dp-123');
    expect(j.gatewayUrl).toBe('https://apim-x.azure-api.net');
    expect(j.callableUrl).toBe('https://apim-x.azure-api.net/dp/dp-123');
    expect(j.primaryKey).toBe('pk-123');
    // The API was actually created (PUT) and the product published.
    expect(hits.some((h) => /^PUT .*\/apis\/dp-dp-123\?/.test(h))).toBe(true);
    expect(hits.some((h) => /^PUT .*\/products\/dp-prod-dp-123\?/.test(h))).toBe(true);
    expect(hits.some((h) => /^PUT .*\/subscriptions\/sub-dp-dp-123\?/.test(h))).toBe(true);
    // The API ref persisted to Cosmos; the key is NOT persisted.
    const persisted = updateOwnedItemMock.mock.calls[0][3].state;
    expect(persisted.apimApiId).toBe('dp-dp-123');
    expect(persisted.apimProductId).toBe('dp-prod-dp-123');
    expect(persisted.apimGatewayUrl).toBe('https://apim-x.azure-api.net');
    expect(persisted.apimServiceUrl).toBe('https://dab.example.com/api/revenue');
    expect('apimSubscriptionKey' in persisted).toBe(false);
  });
});
