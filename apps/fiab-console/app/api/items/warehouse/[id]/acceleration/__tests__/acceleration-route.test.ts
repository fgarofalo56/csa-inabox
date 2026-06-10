/**
 * BFF route test for GET /api/items/warehouse/[id]/acceleration.
 *
 * Asserts the HONEST query-acceleration disclosure:
 *  (1) unauthed → 401
 *  (2) default Synapse path → ok, backend=synapse-dedicated, accelerationModel=dwu-sku,
 *      live SKU from ARM, gpuAvailable ALWAYS false, userToggleable false
 *  (3) gpuAvailable is false even when ARM probe fails (no fabrication)
 *  (4) opt-in Fabric path → backend=fabric-warehouse, serverless-autoscale, gpu false
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const getPoolStateMock = vi.fn();
vi.mock('@/lib/azure/synapse-pool-arm', () => ({ getPoolState: () => getPoolStateMock() }));

const reqStub = {} as any;

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
  getPoolStateMock.mockResolvedValue({ state: 'Online', sku: 'DW400c', status: 'Online' });
  delete process.env.LOOM_WAREHOUSE_BACKEND;
  delete process.env.LOOM_DEFAULT_FABRIC_WORKSPACE;
  process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'dwhpool01';
});

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

describe('GET /api/items/warehouse/[id]/acceleration', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { GET } = await import('@/app/api/items/warehouse/[id]/acceleration/route');
    const r = await GET(reqStub);
    expect(r.status).toBe(401);
  });

  it('default Synapse path reports DWU model + live SKU, never GPU', async () => {
    const { GET } = await import('@/app/api/items/warehouse/[id]/acceleration/route');
    const r = await GET(reqStub);
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('synapse-dedicated');
    expect(j.accelerationModel).toBe('dwu-sku');
    expect(j.sku).toBe('DW400c');
    expect(j.state).toBe('Online');
    expect(j.gpuAvailable).toBe(false);
    expect(j.userToggleable).toBe(false);
    expect(j.pool).toBe('dwhpool01');
  });

  it('still reports gpuAvailable=false when the ARM SKU probe fails', async () => {
    getPoolStateMock.mockRejectedValue(new Error('no ARM role'));
    const { GET } = await import('@/app/api/items/warehouse/[id]/acceleration/route');
    const r = await GET(reqStub);
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.gpuAvailable).toBe(false);
    expect(j.sku).toBe('unknown');
    expect(j.probeError).toContain('no ARM role');
  });

  it('opt-in Fabric backend reports serverless-autoscale, still no GPU', async () => {
    process.env.LOOM_WAREHOUSE_BACKEND = 'fabric-warehouse';
    process.env.LOOM_DEFAULT_FABRIC_WORKSPACE = 'ws-123';
    const { GET } = await import('@/app/api/items/warehouse/[id]/acceleration/route');
    const r = await GET(reqStub);
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.backend).toBe('fabric-warehouse');
    expect(j.accelerationModel).toBe('serverless-autoscale');
    expect(j.gpuAvailable).toBe(false);
    expect(j.fabricWorkspaceBound).toBe(true);
    // ARM pool probe must NOT run on the Fabric path.
    expect(getPoolStateMock).not.toHaveBeenCalled();
  });
});
