/**
 * BFF cloud-matrix test for the SQL Warehouse CREATE / DELETE lifecycle routes.
 *
 * Proves the boundary routing required by .claude/rules/no-fabric-dependency.md:
 *   - Commercial / GCC  → Databricks REST (POST/DELETE /api/2.0/sql/warehouses)
 *   - GCC-High (LOOM_CLOUD=GCC-High) → Synapse Dedicated SQL pool ARM PUT/DELETE
 *
 * Also asserts the running-state guard on the Databricks delete path (409 +
 * code 'warehouse_running' unless force=true). fetch is stubbed so the real
 * client code runs end-to-end without touching Azure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => ({ claims: { oid: 'oid', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 })),
}));
vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_DLZ_RG = 'rg-dlz';
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-ws';
  process.env.LOOM_DATABRICKS_HOSTNAME = 'adb.azuredatabricks.net';
  process.env.LOOM_LOCATION = 'eastus2';
  delete process.env.LOOM_CLOUD;
  delete process.env.AZURE_CLOUD;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

function makeReq(body?: unknown) {
  return new NextRequest('https://loom.test/api/items/databricks-sql-warehouse/w1/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function stubFetch(impl: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : (url as any).toString();
    calls.push({ url: u, init });
    const r = impl(u, init);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

describe('create route — Commercial (Databricks)', () => {
  it('POSTs the Databricks warehouses endpoint and returns the new id', async () => {
    const calls = stubFetch(() => ({ body: { id: 'wh-new' } }));
    const { POST } = await import('@/app/api/items/databricks-sql-warehouse/[id]/create/route');
    const res = await POST(makeReq({ name: 'loom-test-wh', cluster_size: 'Small', warehouse_type: 'PRO', enable_photon: true }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.id).toBe('wh-new');
    expect(calls.some((c) => c.url.includes('/api/2.0/sql/warehouses') && c.init?.method === 'POST')).toBe(true);
    // Did NOT touch ARM sqlPools on the Commercial path.
    expect(calls.some((c) => c.url.includes('/sqlPools/'))).toBe(false);
  });

  it('rejects a missing name with 400', async () => {
    stubFetch(() => ({ body: {} }));
    const { POST } = await import('@/app/api/items/databricks-sql-warehouse/[id]/create/route');
    const res = await POST(makeReq({ cluster_size: 'Small' }));
    expect(res.status).toBe(400);
  });
});

describe('create route — Gov (Synapse Dedicated pool)', () => {
  it('PUTs an ARM dedicated SQL pool when LOOM_CLOUD=GCC-High', async () => {
    process.env.LOOM_CLOUD = 'GCC-High';
    const calls = stubFetch(() => ({ body: { name: 'loom-pool', sku: { name: 'DW100c' } } }));
    const { POST } = await import('@/app/api/items/databricks-sql-warehouse/[id]/create/route');
    const res = await POST(makeReq({ name: 'loom-pool', gov_sku: 'DW100c' }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.id).toBe('loom-pool');
    const armPut = calls.find((c) => c.url.includes('/sqlPools/loom-pool') && c.init?.method === 'PUT');
    expect(armPut).toBeTruthy();
    expect(armPut!.url).toMatch(/management\.usgovcloudapi\.net/);
    // Did NOT call the Databricks endpoint on the Gov path.
    expect(calls.some((c) => c.url.includes('/api/2.0/sql/warehouses'))).toBe(false);
  });

  it('rejects a bad gov_sku with 400', async () => {
    process.env.LOOM_CLOUD = 'GCC-High';
    stubFetch(() => ({ body: {} }));
    const { POST } = await import('@/app/api/items/databricks-sql-warehouse/[id]/create/route');
    const res = await POST(makeReq({ name: 'loom-pool', gov_sku: 'F100' }));
    expect(res.status).toBe(400);
  });
});

describe('delete route — running-state guard + boundary routing', () => {
  function makeDelReq(body?: unknown) {
    return new NextRequest('https://loom.test/api/items/databricks-sql-warehouse/w1/delete', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  it('returns 409 warehouse_running when deleting a RUNNING warehouse without force', async () => {
    stubFetch((url) => {
      if (url.includes('/api/2.0/sql/warehouses/wh1')) return { body: { id: 'wh1', name: 'wh', state: 'RUNNING' } };
      return { body: {} };
    });
    const { POST } = await import('@/app/api/items/databricks-sql-warehouse/[id]/delete/route');
    const res = await POST(makeDelReq({ warehouseId: 'wh1' }));
    const j = await res.json();
    expect(res.status).toBe(409);
    expect(j.code).toBe('warehouse_running');
  });

  it('DELETEs the Databricks warehouse when stopped', async () => {
    const calls = stubFetch((url) => {
      if (url.includes('/api/2.0/sql/warehouses/wh1') && !url.endsWith('wh1')) return { body: {} };
      if (url.endsWith('/api/2.0/sql/warehouses/wh1')) return { body: { id: 'wh1', name: 'wh', state: 'STOPPED' } };
      return { body: {} };
    });
    const { POST } = await import('@/app/api/items/databricks-sql-warehouse/[id]/delete/route');
    const res = await POST(makeDelReq({ warehouseId: 'wh1' }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/api/2.0/sql/warehouses/wh1') && c.init?.method === 'DELETE')).toBe(true);
  });

  it('DELETEs the ARM dedicated pool on Gov without a state guard', async () => {
    process.env.LOOM_CLOUD = 'GCC-High';
    const calls = stubFetch(() => ({ status: 202, body: {} }));
    const { POST } = await import('@/app/api/items/databricks-sql-warehouse/[id]/delete/route');
    const res = await POST(makeDelReq({ warehouseId: 'loom-pool' }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    const armDel = calls.find((c) => c.url.includes('/sqlPools/loom-pool') && c.init?.method === 'DELETE');
    expect(armDel).toBeTruthy();
    expect(armDel!.url).toMatch(/management\.usgovcloudapi\.net/);
  });
});
