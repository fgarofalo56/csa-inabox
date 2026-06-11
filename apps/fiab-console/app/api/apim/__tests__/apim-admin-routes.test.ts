/**
 * BFF contract tests for the APIM admin "Service & SKU" + subscription
 * lifecycle routes — the fix for the admin pane crashing with
 * "Unexpected token '<' … is not valid JSON" (the panes fetched non-existent
 * `/api/items/apim-*` routes; these are the real `/api/apim/*` endpoints).
 *
 *   GET   /api/apim/service
 *   PATCH /api/apim/service
 *   PATCH /api/apim/subscriptions/[sid]
 *   GET   /api/apim/subscriptions/[sid]/keys
 *
 * Verifies: auth gate (401), provisioning gate (503 with `missing`), input
 * validation (400), JSON content-type, and happy-path delegation to the real
 * apim-client helpers. The apim-client is stubbed; live network is covered by
 * the client unit tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/apim-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/apim-client');
  return {
    ...actual,
    getApimService: vi.fn(),
    updateApimSku: vi.fn(),
    updateSubscription: vi.fn(),
    getSubscriptionKeys: vi.fn(),
  };
});

import { GET as serviceGET, PATCH as servicePATCH } from '../service/route';
import { PATCH as subPATCH } from '../subscriptions/[sid]/route';
import { GET as keysGET } from '../subscriptions/[sid]/keys/route';
import { getSession } from '@/lib/auth/session';
import {
  getApimService, updateApimSku, updateSubscription, getSubscriptionKeys,
} from '@/lib/azure/apim-client';

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

describe('GET /api/apim/service', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await serviceGET();
    expect(res.status).toBe(401);
  });

  it('503 not_configured (naming the missing env var) when APIM is unset', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    notProvisioned();
    const res = await serviceGET();
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('not_configured');
    expect(j.missing).toBe('LOOM_SUBSCRIPTION_ID');
    expect(getApimService).not.toHaveBeenCalled();
  });

  it('404 when the service is not found at the configured scope', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (getApimService as any).mockResolvedValue(null);
    const res = await serviceGET();
    expect(res.status).toBe(404);
    const j = await res.json();
    expect(j.ok).toBe(false);
  });

  it('returns the shaped service on the happy path', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (getApimService as any).mockResolvedValue({
      name: 'apim1', location: 'eastus2', sku: { name: 'Developer', capacity: 1 }, provisioningState: 'Succeeded',
    });
    const res = await serviceGET();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.service.sku.name).toBe('Developer');
  });
});

describe('PATCH /api/apim/service', () => {
  it('400 when sku is missing', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    const res = await servicePATCH(bodyReq({ capacity: 2 }));
    expect(res.status).toBe(400);
    expect(updateApimSku).not.toHaveBeenCalled();
  });

  it('400 when sku is not in the allowed set', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    const res = await servicePATCH(bodyReq({ sku: 'PremiumV2', capacity: 1 }));
    expect(res.status).toBe(400);
    expect(updateApimSku).not.toHaveBeenCalled();
  });

  it('scales the SKU + clamps capacity to 1..10 on the happy path', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (updateApimSku as any).mockResolvedValue({ sku: { name: 'Standard', capacity: 10 }, provisioningState: 'Updating' });
    const res = await servicePATCH(bodyReq({ sku: 'Standard', capacity: 99 }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(updateApimSku).toHaveBeenCalledWith('Standard', 10);
  });
});

describe('PATCH /api/apim/subscriptions/[sid]', () => {
  it('400 on an invalid state', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    const res = await subPATCH(bodyReq({ state: 'bogus' }), ctx('sub-1'));
    expect(res.status).toBe(400);
    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it('approves (active) on the happy path', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (updateSubscription as any).mockResolvedValue({ name: 'sub-1', state: 'active' });
    const res = await subPATCH(bodyReq({ state: 'active' }), ctx('sub-1'));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(updateSubscription).toHaveBeenCalledWith('sub-1', { state: 'active', displayName: undefined });
  });
});

describe('GET /api/apim/subscriptions/[sid]/keys', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await keysGET({} as any, ctx('sub-1'));
    expect(res.status).toBe(401);
  });

  it('returns primary + secondary keys on the happy path', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (getSubscriptionKeys as any).mockResolvedValue({ primaryKey: 'pk', secondaryKey: 'sk' });
    const res = await keysGET({} as any, ctx('sub-1'));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.primaryKey).toBe('pk');
    expect(j.secondaryKey).toBe('sk');
    expect(getSubscriptionKeys).toHaveBeenCalledWith('sub-1');
  });
});
