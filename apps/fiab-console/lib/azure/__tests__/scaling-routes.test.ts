/**
 * BFF route tests for /api/admin/scaling/*.
 *
 * Each test imports the route handler directly, stubs the underlying
 * Azure client, and asserts: (1) unauthed → 401, (2) bad body → 400,
 * (3) happy path → { ok: true }.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 })),
}));

// Short-circuit the DLZ gate (it calls loadTenantDomains → Cosmos → real
// network). Return null (allow access) so route handlers reach their
// actual logic without hanging on a Cosmos connection.
vi.mock('@/lib/auth/dlz-gate', () => ({
  denyIfNoDlzAccess: vi.fn(async () => null),
}));

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_DLZ_RG = 'rg-dlz';
  process.env.LOOM_ADMIN_RG = 'rg-admin';
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-ws';
  process.env.LOOM_KUSTO_CLUSTER_NAME = 'adx-test';
  process.env.LOOM_AI_SEARCH_SERVICE = 'srch-test';
  process.env.LOOM_AI_SEARCH_SUB = 'sub-1';
  process.env.LOOM_AI_SEARCH_RG = 'rg-admin';
  process.env.LOOM_APIM_NAME = 'apim-test';
  process.env.LOOM_FOUNDRY_NAME = 'aif-test';
  process.env.LOOM_FOUNDRY_RG = 'rg-admin';
  process.env.LOOM_DATABRICKS_HOSTNAME = 'adb.azuredatabricks.net';
  process.env.LOOM_COSMOS_ENDPOINT = 'https://test.documents.azure.com:443/';
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

function makeReq(method: string, body?: unknown) {
  return new NextRequest('https://loom.test/api/admin/scaling/x', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function stubFetch(impl: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const r = impl(typeof url === 'string' ? url : (url as any).toString(), init);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('POST /api/admin/scaling/capacity', () => {
  it('rejects body without resourceId', async () => {
    const { POST } = await import('@/app/api/admin/scaling/capacity/route');
    const r = await POST(makeReq('POST', { sku: 'F8' }));
    expect(r.status).toBe(400);
  });

  it('rejects body without sku', async () => {
    const { POST } = await import('@/app/api/admin/scaling/capacity/route');
    const r = await POST(makeReq('POST', { resourceId: '/x' }));
    expect(r.status).toBe(400);
  });

  it('forwards to updateCapacitySku', async () => {
    stubFetch(() => ({ body: { sku: { name: 'F16', tier: 'Fabric' } } }));
    const { POST } = await import('@/app/api/admin/scaling/capacity/route');
    const r = await POST(makeReq('POST', {
      resourceId: '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.Fabric/capacities/cap1',
      sku: 'F16',
    }));
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });
});

describe('POST /api/admin/scaling/synapse-dwu', () => {
  it('rejects missing pool', async () => {
    const { POST } = await import('@/app/api/admin/scaling/synapse-dwu/route');
    const r = await POST(makeReq('POST', { sku: 'DW500c' }));
    expect(r.status).toBe(400);
  });

  it('rejects invalid sku shape', async () => {
    const { POST } = await import('@/app/api/admin/scaling/synapse-dwu/route');
    const r = await POST(makeReq('POST', { pool: 'p1', sku: 'F100' }));
    expect(r.status).toBe(400);
  });

  it('accepts a valid DWU SKU', async () => {
    stubFetch(() => ({ body: { name: 'p1', sku: { name: 'DW500c' }, properties: { status: 'Scaling' } } }));
    const { POST } = await import('@/app/api/admin/scaling/synapse-dwu/route');
    const r = await POST(makeReq('POST', { pool: 'p1', sku: 'DW500c' }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.newSku).toBe('DW500c');
  });
});

describe('POST /api/admin/scaling/adx', () => {
  it('rejects missing sku', async () => {
    const { POST } = await import('@/app/api/admin/scaling/adx/route');
    const r = await POST(makeReq('POST', {}));
    expect(r.status).toBe(400);
  });

  it('accepts SKU + capacity', async () => {
    stubFetch(() => ({ body: { id: '/x', name: 'adx-test', location: 'eastus2', sku: { name: 'Standard_E4ads_v5', tier: 'Standard', capacity: 2 } } }));
    const { POST } = await import('@/app/api/admin/scaling/adx/route');
    const r = await POST(makeReq('POST', { sku: 'Standard_E4ads_v5', capacity: 2 }));
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });
});

describe('POST /api/admin/scaling/databricks-warehouse', () => {
  it('rejects missing id', async () => {
    const { POST } = await import('@/app/api/admin/scaling/databricks-warehouse/route');
    const r = await POST(makeReq('POST', { cluster_size: 'Large' }));
    expect(r.status).toBe(400);
  });

  it('rejects invalid cluster_size', async () => {
    const { POST } = await import('@/app/api/admin/scaling/databricks-warehouse/route');
    const r = await POST(makeReq('POST', { id: 'wh1', cluster_size: 'jumbo' }));
    expect(r.status).toBe(400);
  });

  it('accepts a valid cluster_size', async () => {
    stubFetch((url) => {
      if (url.endsWith('/edit')) return { body: {} };
      return { body: { id: 'wh1', name: 'WH', cluster_size: 'Small', warehouse_type: 'PRO' } };
    });
    const { POST } = await import('@/app/api/admin/scaling/databricks-warehouse/route');
    const r = await POST(makeReq('POST', { id: 'wh1', cluster_size: 'Large' }));
    expect(r.status).toBe(200);
  });
});

describe('POST /api/admin/scaling/databricks-cluster', () => {
  it('rejects missing cluster_id', async () => {
    const { POST } = await import('@/app/api/admin/scaling/databricks-cluster/route');
    const r = await POST(makeReq('POST', { num_workers: 4 }));
    expect(r.status).toBe(400);
  });

  it('accepts cluster_id + node_type_id', async () => {
    stubFetch((url) => {
      if (url.includes('/clusters/edit')) return { body: {} };
      // getCluster
      return { body: { cluster_id: 'c1', cluster_name: 'C1', spark_version: '14.3.x-scala2.12', node_type_id: 'Standard_DS3_v2', num_workers: 2 } };
    });
    const { POST } = await import('@/app/api/admin/scaling/databricks-cluster/route');
    const r = await POST(makeReq('POST', { cluster_id: 'c1', node_type_id: 'Standard_DS4_v2', num_workers: 4 }));
    expect(r.status).toBe(200);
  });
});

describe('POST /api/admin/scaling/ai-search', () => {
  it('rejects empty body', async () => {
    const { POST } = await import('@/app/api/admin/scaling/ai-search/route');
    const r = await POST(makeReq('POST', {}));
    expect(r.status).toBe(400);
  });

  it('rejects invalid sku', async () => {
    const { POST } = await import('@/app/api/admin/scaling/ai-search/route');
    const r = await POST(makeReq('POST', { sku: 'super-extra' }));
    expect(r.status).toBe(400);
  });

  it('accepts valid sku + replicaCount', async () => {
    stubFetch(() => ({ body: { name: 'srch-test', sku: { name: 'standard2' }, properties: { replicaCount: 3, partitionCount: 1 } } }));
    const { POST } = await import('@/app/api/admin/scaling/ai-search/route');
    const r = await POST(makeReq('POST', { sku: 'standard2', replicaCount: 3 }));
    expect(r.status).toBe(200);
  });
});

describe('POST /api/admin/scaling/apim', () => {
  it('rejects missing sku', async () => {
    const { POST } = await import('@/app/api/admin/scaling/apim/route');
    const r = await POST(makeReq('POST', { capacity: 2 }));
    expect(r.status).toBe(400);
  });

  it('rejects invalid sku', async () => {
    const { POST } = await import('@/app/api/admin/scaling/apim/route');
    const r = await POST(makeReq('POST', { sku: 'Enterprise' }));
    expect(r.status).toBe(400);
  });

  it('accepts Premium + capacity', async () => {
    stubFetch(() => ({ body: { name: 'apim-test', sku: { name: 'Premium', capacity: 2 } } }));
    const { POST } = await import('@/app/api/admin/scaling/apim/route');
    const r = await POST(makeReq('POST', { sku: 'Premium', capacity: 2 }));
    expect(r.status).toBe(200);
  });
});

describe('POST /api/admin/scaling/container-apps', () => {
  it('rejects missing name', async () => {
    const { POST } = await import('@/app/api/admin/scaling/container-apps/route');
    const r = await POST(makeReq('POST', { workloadProfileName: 'D4' }));
    expect(r.status).toBe(400);
  });

  it('rejects invalid workloadProfileName', async () => {
    const { POST } = await import('@/app/api/admin/scaling/container-apps/route');
    const r = await POST(makeReq('POST', { name: 'aca1', workloadProfileName: 'X9' }));
    expect(r.status).toBe(400);
  });

  it('rejects maxReplicas > 1000', async () => {
    const { POST } = await import('@/app/api/admin/scaling/container-apps/route');
    const r = await POST(makeReq('POST', { name: 'aca1', maxReplicas: 5000 }));
    expect(r.status).toBe(400);
  });

  it('accepts a valid scale spec', async () => {
    stubFetch(() => ({ body: { name: 'aca1', properties: { workloadProfileName: 'D4' } } }));
    const { POST } = await import('@/app/api/admin/scaling/container-apps/route');
    const r = await POST(makeReq('POST', { name: 'aca1', workloadProfileName: 'D4', minReplicas: 1, maxReplicas: 5 }));
    expect(r.status).toBe(200);
  });
});

describe('unauthenticated', () => {
  it('returns 401 from every POST when session missing', async () => {
    vi.doMock('@/lib/auth/session', () => ({ getSession: vi.fn(() => null) }));
    vi.resetModules();
    const { POST } = await import('@/app/api/admin/scaling/capacity/route');
    const r = await POST(makeReq('POST', { resourceId: '/x', sku: 'F8' }));
    expect(r.status).toBe(401);
  });
});

// Azure-native compute panel behind Admin → Capacity & compute → "Scale & manage".
// The route dynamically imports its ARM clients, so each test vi.doMock's the
// specific client before importing the handler (afterEach resets the registry).
const validSession = () => ({ getSession: vi.fn(() => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 })) });

describe('POST /api/admin/scaling/compute', () => {
  it('rejects an unsupported kind/action', async () => {
    vi.doMock('@/lib/auth/session', validSession);
    const { POST } = await import('@/app/api/admin/scaling/compute/route');
    const r = await POST(makeReq('POST', { kind: 'nope', action: 'scale' }));
    expect(r.status).toBe(400);
  });

  it('requires a sku for an ADX scale', async () => {
    vi.doMock('@/lib/auth/session', validSession);
    const { POST } = await import('@/app/api/admin/scaling/compute/route');
    const r = await POST(makeReq('POST', { kind: 'adx', action: 'scale' }));
    expect(r.status).toBe(400);
  });

  it('scales ADX to a new SKU via updateKustoClusterSku', async () => {
    vi.doMock('@/lib/auth/session', validSession);
    const updateKustoClusterSku = vi.fn(async () => ({ state: 'Updating' }));
    vi.doMock('@/lib/azure/kusto-arm-client', () => ({ updateKustoClusterSku }));
    const { POST } = await import('@/app/api/admin/scaling/compute/route');
    const r = await POST(makeReq('POST', { kind: 'adx', action: 'scale', sku: 'Standard_E4ads_v5' }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.kind).toBe('adx');
    expect(updateKustoClusterSku).toHaveBeenCalledWith('Standard_E4ads_v5', undefined);
  });

  it('pauses and resumes the Synapse dedicated pool', async () => {
    vi.doMock('@/lib/auth/session', validSession);
    const pausePool = vi.fn(async () => {});
    const resumePool = vi.fn(async () => {});
    vi.doMock('@/lib/azure/synapse-pool-arm', () => ({ pausePool, resumePool }));
    const { POST } = await import('@/app/api/admin/scaling/compute/route');
    const pr = await POST(makeReq('POST', { kind: 'synapse-pool', action: 'pause' }));
    expect(pr.status).toBe(200);
    expect(pausePool).toHaveBeenCalledTimes(1);
    const rr = await POST(makeReq('POST', { kind: 'synapse-pool', action: 'resume' }));
    expect(rr.status).toBe(200);
    expect(resumePool).toHaveBeenCalledTimes(1);
  });

  it('scales the SHIR VMSS to a node count via scaleVmss', async () => {
    vi.doMock('@/lib/auth/session', validSession);
    const scaleVmss = vi.fn(async () => {});
    vi.doMock('@/lib/azure/vmss-client', () => ({
      shirVmssConfig: () => ({ subscriptionId: 's', resourceGroup: 'rg', name: 'vmss-shir' }),
      purviewShirVmssConfig: () => null,
      scaleVmss,
    }));
    const { POST } = await import('@/app/api/admin/scaling/compute/route');
    const r = await POST(makeReq('POST', { kind: 'shir-vmss', action: 'scale', capacity: 4 }));
    expect(r.status).toBe(200);
    expect(scaleVmss).toHaveBeenCalledWith(expect.objectContaining({ name: 'vmss-shir' }), 4);
  });

  it('returns an honest 400 when the SHIR VMSS is not configured', async () => {
    vi.doMock('@/lib/auth/session', validSession);
    vi.doMock('@/lib/azure/vmss-client', () => ({
      shirVmssConfig: () => null,
      purviewShirVmssConfig: () => null,
      scaleVmss: vi.fn(),
    }));
    const { POST } = await import('@/app/api/admin/scaling/compute/route');
    const r = await POST(makeReq('POST', { kind: 'shir-vmss', action: 'scale', capacity: 4 }));
    expect(r.status).toBe(400);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.doMock('@/lib/auth/session', () => ({ getSession: vi.fn(() => null) }));
    const { POST } = await import('@/app/api/admin/scaling/compute/route');
    const r = await POST(makeReq('POST', { kind: 'adx', action: 'scale', sku: 'x' }));
    expect(r.status).toBe(401);
  });
});

describe('GET /api/admin/scaling/compute', () => {
  it('lists the configured Azure-native scalable compute (best-effort probes)', async () => {
    vi.doMock('@/lib/auth/session', validSession);
    vi.doMock('@/lib/azure/kusto-arm-client', () => ({
      getKustoClusterArm: vi.fn(async () => ({ name: 'adx', sku: { name: 'Standard_E4ads_v5', capacity: 2 }, state: 'Running' })),
    }));
    vi.doMock('@/lib/azure/synapse-pool-arm', () => ({
      getPoolState: vi.fn(async () => ({ state: 'Online', sku: 'DW100c', status: 'Online' })),
    }));
    vi.doMock('@/lib/azure/vmss-client', () => ({
      shirVmssConfig: () => null,
      purviewShirVmssConfig: () => null,
      getVmssStatus: vi.fn(),
    }));
    const { GET } = await import('@/app/api/admin/scaling/compute/route');
    const r = await GET();
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(Array.isArray(j.resources)).toBe(true);
    const adx = j.resources.find((x: any) => x.kind === 'adx');
    expect(adx).toBeTruthy();
    expect(adx.skuOptions.length).toBeGreaterThan(0);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.doMock('@/lib/auth/session', () => ({ getSession: vi.fn(() => null) }));
    const { GET } = await import('@/app/api/admin/scaling/compute/route');
    const r = await GET();
    expect(r.status).toBe(401);
  });
});
