/**
 * Gate-shape contract tests for the APIM item routes the admin panes fetch:
 *   GET /api/items/apim-api
 *   GET /api/items/apim-product
 *   GET /api/items/apim-policy
 *
 * Each must return 503 { ok:false, code:'not_configured', missing } when APIM is
 * unconfigured — the exact shape apimFetchJson recognizes to render a readable
 * env-var hint instead of crashing on a non-JSON body. The apim-client REST
 * helpers are stubbed; live network is covered by the client tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/apim-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/apim-client');
  return { ...actual, listApis: vi.fn(), listProducts: vi.fn(), getPolicy: vi.fn() };
});

import { GET as apisGET } from '../apim-api/route';
import { GET as productsGET } from '../apim-product/route';
import { GET as policyGET } from '../apim-policy/route';
import { getSession } from '@/lib/auth/session';
import { listApis, listProducts, getPolicy } from '@/lib/azure/apim-client';

function req(url = 'http://x/api/items/apim-policy?scope=service') {
  return { nextUrl: new URL(url), url } as any;
}

const ORIG = { name: process.env.LOOM_APIM_NAME, sub: process.env.LOOM_SUBSCRIPTION_ID, apimSub: process.env.LOOM_APIM_SUB };
function provisioned() {
  process.env.LOOM_APIM_NAME = 'apim-csa-loom-eastus2';
  process.env.LOOM_SUBSCRIPTION_ID = '00000000-0000-0000-0000-000000000000';
}
function notProvisioned() {
  delete process.env.LOOM_APIM_NAME;
  delete process.env.LOOM_SUBSCRIPTION_ID;
  delete process.env.LOOM_APIM_SUB;
}

beforeEach(() => { vi.resetAllMocks(); provisioned(); });
afterEach(() => {
  if (ORIG.name) process.env.LOOM_APIM_NAME = ORIG.name; else delete process.env.LOOM_APIM_NAME;
  if (ORIG.sub) process.env.LOOM_SUBSCRIPTION_ID = ORIG.sub; else delete process.env.LOOM_SUBSCRIPTION_ID;
  if (ORIG.apimSub) process.env.LOOM_APIM_SUB = ORIG.apimSub; else delete process.env.LOOM_APIM_SUB;
});

describe('GET /api/items/apim-api', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await apisGET()).status).toBe(401);
  });
  it('503 not_configured (naming the missing env var) when APIM is unset', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    notProvisioned();
    const res = await apisGET();
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('not_configured');
    expect(j.missing).toBe('LOOM_SUBSCRIPTION_ID');
    expect(listApis).not.toHaveBeenCalled();
  });
  it('200 with apis on the happy path', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (listApis as any).mockResolvedValue([{ id: 'a', displayName: 'A' }]);
    const j = await (await apisGET()).json();
    expect(j.ok).toBe(true);
    expect(j.apis).toHaveLength(1);
  });
});

describe('GET /api/items/apim-product', () => {
  it('503 not_configured when APIM is unset', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    notProvisioned();
    const res = await productsGET();
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.code).toBe('not_configured');
    expect(j.missing).toBe('LOOM_SUBSCRIPTION_ID');
    expect(listProducts).not.toHaveBeenCalled();
  });
});

describe('GET /api/items/apim-policy', () => {
  it('503 not_configured when APIM is unset', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    notProvisioned();
    const res = await policyGET(req());
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.code).toBe('not_configured');
    expect(j.missing).toBe('LOOM_SUBSCRIPTION_ID');
    expect(getPolicy).not.toHaveBeenCalled();
  });
});
