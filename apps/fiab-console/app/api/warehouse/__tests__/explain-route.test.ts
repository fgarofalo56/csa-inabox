/**
 * BFF route test for POST /api/warehouse/explain.
 *
 * Asserts: (1) unauthed → 401, (2) missing sql → 400, (3) happy path → 200
 * { ok, planXml } from the real explainQuery path, (4) honest config gate → 503
 * when the dedicated pool target can't be resolved (Synapse env unset),
 * (5) 409 when the pool is not Online.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const dedicatedTargetMock = vi.fn();
const explainQueryMock = vi.fn();
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  dedicatedTarget: () => dedicatedTargetMock(),
  explainQuery: (...a: any[]) => explainQueryMock(...a),
}));

const getPoolStateMock = vi.fn();
vi.mock('@/lib/azure/synapse-pool-arm', () => ({ getPoolState: () => getPoolStateMock() }));

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
  dedicatedTargetMock.mockReturnValue({ server: 'syn.sql', database: 'loompool' });
  getPoolStateMock.mockResolvedValue({ state: 'Online', sku: 'DW100c' });
  explainQueryMock.mockResolvedValue('<ShowPlanXML>cost=12</ShowPlanXML>');
});

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

const reqWith = (body: unknown) => ({ json: async () => body } as any);

describe('POST /api/warehouse/explain', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('@/app/api/warehouse/explain/route');
    const r = await POST(reqWith({ sql: 'SELECT 1' }));
    expect(r.status).toBe(401);
  });

  it('400 when sql missing', async () => {
    const { POST } = await import('@/app/api/warehouse/explain/route');
    const r = await POST(reqWith({}));
    expect(r.status).toBe(400);
  });

  it('200 + planXml on the real explain path', async () => {
    const { POST } = await import('@/app/api/warehouse/explain/route');
    const r = await POST(reqWith({ sql: 'SELECT * FROM gold.sales' }));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.planXml).toContain('ShowPlanXML');
    expect(j.engine).toBe('synapse-dedicated');
    expect(explainQueryMock).toHaveBeenCalledWith({ server: 'syn.sql', database: 'loompool' }, 'SELECT * FROM gold.sales', true);
  });

  it('503 honest config gate when the pool target cannot resolve', async () => {
    dedicatedTargetMock.mockImplementation(() => { throw new Error('LOOM_SYNAPSE_WORKSPACE unset'); });
    const { POST } = await import('@/app/api/warehouse/explain/route');
    const r = await POST(reqWith({ sql: 'SELECT 1' }));
    const j = await r.json();
    expect(r.status).toBe(503);
    expect(j.ok).toBe(false);
    expect(j.gate.missing).toContain('LOOM_SYNAPSE_WORKSPACE');
  });

  it('409 when the pool is not Online', async () => {
    getPoolStateMock.mockResolvedValue({ state: 'Paused', sku: 'DW100c' });
    const { POST } = await import('@/app/api/warehouse/explain/route');
    const r = await POST(reqWith({ sql: 'SELECT 1' }));
    const j = await r.json();
    expect(r.status).toBe(409);
    expect(j.ok).toBe(false);
    expect(j.state).toBe('Paused');
  });
});
