/**
 * BFF route test for GET/POST /api/items/warehouse/[id]/query-acceleration.
 *
 * Asserts the Azure-native warehouse (Synapse Dedicated SQL pool) is fully
 * functional with no Fabric dependency, GPU is an honest always-unavailable
 * disclosure (Loom's answer = Databricks Photon / SQL warehouse), and
 * result-set caching issues a real ALTER DATABASE.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const executeQueryMock = vi.fn();
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  dedicatedTarget: () => ({ server: 'syn.sql', database: 'loompool' }),
  executeQuery: (...a: any[]) => executeQueryMock(...a),
}));

const getPoolStateMock = vi.fn();
vi.mock('@/lib/azure/synapse-pool-arm', () => ({ getPoolState: () => getPoolStateMock() }));

const reqWith = (body: unknown) => ({ json: async () => body } as any);

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'o', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
  getPoolStateMock.mockResolvedValue({ state: 'Online', sku: 'DW100c' });
  executeQueryMock.mockResolvedValue({ rows: [[true]], columns: ['x'], rowCount: 1, executionMs: 1, truncated: false, messages: [], recordsAffected: 0 });
  process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'loompool';
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-ws';
  delete process.env.LOOM_WAREHOUSE_BACKEND;
  delete process.env.LOOM_DEFAULT_FABRIC_WORKSPACE;
});

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

describe('GET /api/items/warehouse/[id]/query-acceleration', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { GET } = await import('@/app/api/items/warehouse/[id]/query-acceleration/route');
    const r = await GET();
    expect(r.status).toBe(401);
  });

  it('Azure-native: backend synapse, GPU unavailable + honest disclosure, RSC live state', async () => {
    const { GET } = await import('@/app/api/items/warehouse/[id]/query-acceleration/route');
    const r = await GET();
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('synapse-dedicated');
    expect(j.gpu.available).toBe(false);
    expect(j.gpu.detail).toContain('Databricks Photon');
    expect(j.resultSetCaching.enabled).toBe(true);
    expect(j.resultSetCaching.supported).toBe(true);
  });

  it('GPU stays unavailable even if a Fabric workspace is bound (no Fabric backend)', async () => {
    process.env.LOOM_WAREHOUSE_BACKEND = 'fabric-warehouse';
    process.env.LOOM_DEFAULT_FABRIC_WORKSPACE = 'ws-123';
    const { GET } = await import('@/app/api/items/warehouse/[id]/query-acceleration/route');
    const r = await GET();
    const j = await r.json();
    expect(j.backend).toBe('synapse-dedicated');
    expect(j.gpu.available).toBe(false);
    expect(j.gpu.engine).toBe('synapse-dedicated');
  });
});

describe('POST /api/items/warehouse/[id]/query-acceleration', () => {
  it('result-set caching ON issues a real ALTER DATABASE', async () => {
    const { POST } = await import('@/app/api/items/warehouse/[id]/query-acceleration/route');
    const r = await POST(reqWith({ tier: 'result-set-caching', accelerate: true }));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.enabled).toBe(true);
    const altered = executeQueryMock.mock.calls.some(
      (c) => typeof c[1] === 'string' && /ALTER DATABASE \[loompool\] SET RESULT_SET_CACHING ON/.test(c[1]),
    );
    expect(altered).toBe(true);
  });

  it('GPU request → honest 409 disclosure gate', async () => {
    const { POST } = await import('@/app/api/items/warehouse/[id]/query-acceleration/route');
    const r = await POST(reqWith({ tier: 'gpu', accelerate: true }));
    const j = await r.json();
    expect(r.status).toBe(409);
    expect(j.ok).toBe(false);
    expect(j.code).toBe('gpu_unavailable');
  });

  it('409 when pool offline', async () => {
    getPoolStateMock.mockResolvedValue({ state: 'Paused', sku: 'DW100c' });
    const { POST } = await import('@/app/api/items/warehouse/[id]/query-acceleration/route');
    const r = await POST(reqWith({ tier: 'result-set-caching', accelerate: true }));
    const j = await r.json();
    expect(r.status).toBe(409);
    expect(j.code).toBe('pool_offline');
  });
});
