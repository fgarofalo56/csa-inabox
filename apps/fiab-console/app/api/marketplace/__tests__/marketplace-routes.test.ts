/**
 * BFF contract tests for the API Marketplace routes:
 *   - GET  /api/marketplace/catalog
 *   - GET  /api/marketplace/subscriptions
 *   - POST /api/marketplace/subscriptions          (subscribe)
 *   - POST /api/marketplace/subscriptions/[sid]/keys
 *
 * Verifies: auth gate (401), provisioning gate (503 gated when LOOM_APIM_NAME
 * / LOOM_SUBSCRIPTION_ID are unset), input validation (400), JSON content-type,
 * and that the happy path delegates to the real apim-client helpers with the
 * right args + URL/payload shape. The apim-client is stubbed; the live network
 * call is exercised by the client unit tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/apim-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/apim-client');
  return {
    ...actual,
    listProducts: vi.fn(),
    listProductApis: vi.fn(),
    listApis: vi.fn(),
    getServiceInfo: vi.fn(),
    listSubscriptions: vi.fn(),
    createSubscription: vi.fn(),
    getSubscriptionKeys: vi.fn(),
  };
});

import { GET as catalogGET } from '../catalog/route';
import { GET as subsGET, POST as subsPOST } from '../subscriptions/route';
import { POST as keysPOST } from '../subscriptions/[sid]/keys/route';
import { getSession } from '@/lib/auth/session';
import {
  listProducts, listProductApis, listApis, getServiceInfo,
  listSubscriptions, createSubscription, getSubscriptionKeys,
} from '@/lib/azure/apim-client';

function getReq(url = 'http://x/') {
  const u = new URL(url);
  return { nextUrl: u, url } as any;
}
function bodyReq(body: any, url = 'http://x/') {
  const u = new URL(url);
  return { nextUrl: u, url, json: async () => body } as any;
}
const ctx = (sid: string) => ({ params: Promise.resolve({ sid }) });

const ORIG = { name: process.env.LOOM_APIM_NAME, sub: process.env.LOOM_SUBSCRIPTION_ID };

function provisioned() {
  process.env.LOOM_APIM_NAME = 'apim-csa-loom-eastus2';
  process.env.LOOM_SUBSCRIPTION_ID = '00000000-0000-0000-0000-000000000000';
}
function notProvisioned() {
  delete process.env.LOOM_APIM_NAME;
  delete process.env.LOOM_SUBSCRIPTION_ID;
}

beforeEach(() => { vi.resetAllMocks(); provisioned(); });
afterEach(() => {
  if (ORIG.name) process.env.LOOM_APIM_NAME = ORIG.name; else delete process.env.LOOM_APIM_NAME;
  if (ORIG.sub) process.env.LOOM_SUBSCRIPTION_ID = ORIG.sub; else delete process.env.LOOM_SUBSCRIPTION_ID;
});

describe('GET /api/marketplace/catalog', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await catalogGET(getReq());
    expect(res.status).toBe(401);
  });

  it('503 gated (with hint + bicepModule) when APIM is not provisioned', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    notProvisioned();
    const res = await catalogGET(getReq());
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.gated).toBe(true);
    expect(j.hint).toMatch(/LOOM_APIM_NAME/);
    expect(j.bicepModule).toMatch(/apim/);
    expect(listProducts).not.toHaveBeenCalled();
  });

  it('returns products (each with their APIs), flat apis, and service on the happy path', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (listProducts as any).mockResolvedValue([
      { id: '/p/unlimited', name: 'unlimited', displayName: 'Unlimited', state: 'published' },
    ]);
    (listProductApis as any).mockResolvedValue([{ id: '/a/orders', name: 'orders', displayName: 'Orders' }]);
    (listApis as any).mockResolvedValue([{ id: '/a/orders', name: 'orders', displayName: 'Orders', path: 'orders' }]);
    (getServiceInfo as any).mockResolvedValue({ name: 'apim1', gatewayUrl: 'https://gw.example', state: 'Succeeded' });

    const res = await catalogGET(getReq());
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.products).toHaveLength(1);
    expect(j.products[0].apis[0].name).toBe('orders');
    expect(j.apis[0].name).toBe('orders');
    expect(j.service.gatewayUrl).toBe('https://gw.example');
    expect(listProductApis).toHaveBeenCalledWith('unlimited');
  });

  it('?published=1 filters out non-published products', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (listProducts as any).mockResolvedValue([
      { id: '/p/pub', name: 'pub', state: 'published' },
      { id: '/p/draft', name: 'draft', state: 'notPublished' },
    ]);
    (listProductApis as any).mockResolvedValue([]);
    (listApis as any).mockResolvedValue([]);
    (getServiceInfo as any).mockResolvedValue(null);

    const res = await catalogGET(getReq('http://x/?published=1'));
    const j = await res.json();
    expect(j.products).toHaveLength(1);
    expect(j.products[0].name).toBe('pub');
  });
});

describe('GET /api/marketplace/subscriptions', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await subsGET();
    expect(res.status).toBe(401);
  });

  it('503 gated when APIM is not provisioned', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    notProvisioned();
    const res = await subsGET();
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.gated).toBe(true);
  });

  it('lists subscriptions on the happy path', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (listSubscriptions as any).mockResolvedValue([{ id: '/s/sub1', name: 'sub1', state: 'active' }]);
    const res = await subsGET();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.subscriptions[0].name).toBe('sub1');
  });
});

describe('POST /api/marketplace/subscriptions (subscribe)', () => {
  beforeEach(() => (getSession as any).mockReturnValue({ claims: { oid: 'u' } }));

  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await subsPOST(bodyReq({ product: 'p' }));
    expect(res.status).toBe(401);
  });

  it('400 when no target is provided', async () => {
    const res = await subsPOST(bodyReq({}));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toMatch(/product, api, or allApis/);
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it('400 when more than one target is provided', async () => {
    const res = await subsPOST(bodyReq({ product: 'p', api: 'a' }));
    expect(res.status).toBe(400);
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it('delegates a product subscribe to createSubscription and returns 201', async () => {
    (createSubscription as any).mockResolvedValue({ id: '/s/sub-unlimited', name: 'sub-unlimited', state: 'submitted' });
    const res = await subsPOST(bodyReq({ product: 'unlimited', displayName: 'Unlimited' }));
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.subscription.state).toBe('submitted');
    expect(createSubscription).toHaveBeenCalledWith(expect.objectContaining({
      product: 'unlimited', api: undefined, allApis: false, displayName: 'Unlimited',
    }));
  });

  it('delegates an api subscribe to createSubscription', async () => {
    (createSubscription as any).mockResolvedValue({ id: '/s/sub-orders', name: 'sub-orders', state: 'active' });
    const res = await subsPOST(bodyReq({ api: 'orders' }));
    expect(res.status).toBe(201);
    expect(createSubscription).toHaveBeenCalledWith(expect.objectContaining({ api: 'orders', allApis: false }));
  });
});

describe('POST /api/marketplace/subscriptions/[sid]/keys', () => {
  beforeEach(() => (getSession as any).mockReturnValue({ claims: { oid: 'u' } }));

  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await keysPOST(getReq(), ctx('sub1'));
    expect(res.status).toBe(401);
  });

  it('503 gated when not provisioned', async () => {
    notProvisioned();
    const res = await keysPOST(getReq(), ctx('sub1'));
    expect(res.status).toBe(503);
  });

  it('returns the resolved keys on the happy path (server-side listSecrets)', async () => {
    (getSubscriptionKeys as any).mockResolvedValue({ primaryKey: 'PRIMARY', secondaryKey: 'SECONDARY' });
    const res = await keysPOST(getReq(), ctx('sub1'));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.primaryKey).toBe('PRIMARY');
    expect(getSubscriptionKeys).toHaveBeenCalledWith('sub1');
  });
});
