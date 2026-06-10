/**
 * BFF route test for POST /api/warehouse/query.
 *
 * Asserts the real Synapse Dedicated SQL pool path (synapse-sql-client.
 * executeQuery), not a stub: (1) unauthed → 401, (2) missing sql → 400,
 * (3) oversize sql → 413, (4) happy path → 200 { ok, columns, rows, rowCount,
 * engine } from executeQuery, (5) honest config gate → 503 when the dedicated
 * pool target can't resolve (Synapse env unset), (6) 409 when the pool is not
 * Online, (7) 502 when the TDS execution itself throws.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const dedicatedTargetMock = vi.fn();
const executeQueryMock = vi.fn();
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  dedicatedTarget: () => dedicatedTargetMock(),
  executeQuery: (...a: any[]) => executeQueryMock(...a),
}));

const getPoolStateMock = vi.fn();
vi.mock('@/lib/azure/synapse-pool-arm', () => ({ getPoolState: () => getPoolStateMock() }));

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
  dedicatedTargetMock.mockReturnValue({ server: 'syn.sql', database: 'loompool' });
  getPoolStateMock.mockResolvedValue({ state: 'Online', sku: 'DW100c' });
  executeQueryMock.mockResolvedValue({
    columns: ['region', 'total_revenue'],
    rows: [['West', 1200], ['East', 980]],
    rowCount: 2,
  });
});

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

const reqWith = (body: unknown) => ({ json: async () => body } as any);

describe('POST /api/warehouse/query', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('@/app/api/warehouse/query/route');
    const r = await POST(reqWith({ sql: 'SELECT 1' }));
    expect(r.status).toBe(401);
  });

  it('400 when sql missing', async () => {
    const { POST } = await import('@/app/api/warehouse/query/route');
    const r = await POST(reqWith({}));
    expect(r.status).toBe(400);
  });

  it('413 when sql exceeds 64KB', async () => {
    const { POST } = await import('@/app/api/warehouse/query/route');
    const big = 'SELECT 1; '.repeat(7000); // > 65_536 chars
    const r = await POST(reqWith({ sql: big }));
    expect(r.status).toBe(413);
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  it('200 + real result shape on the executeQuery path', async () => {
    const { POST } = await import('@/app/api/warehouse/query/route');
    const r = await POST(reqWith({ sql: 'SELECT region, SUM(revenue) FROM gold.sales GROUP BY region' }));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.columns).toEqual(['region', 'total_revenue']);
    expect(j.rowCount).toBe(2);
    expect(j.engine).toBe('synapse-dedicated');
    expect(j.executedBy).toBe('u@t.com');
    expect(executeQueryMock).toHaveBeenCalledWith(
      { server: 'syn.sql', database: 'loompool' },
      'SELECT region, SUM(revenue) FROM gold.sales GROUP BY region',
    );
  });

  it('503 honest config gate when the pool target cannot resolve', async () => {
    dedicatedTargetMock.mockImplementation(() => { throw new Error('LOOM_SYNAPSE_WORKSPACE unset'); });
    const { POST } = await import('@/app/api/warehouse/query/route');
    const r = await POST(reqWith({ sql: 'SELECT 1' }));
    const j = await r.json();
    expect(r.status).toBe(503);
    expect(j.ok).toBe(false);
    expect(j.gate.missing).toContain('LOOM_SYNAPSE_WORKSPACE');
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  it('409 when the pool is not Online', async () => {
    getPoolStateMock.mockResolvedValue({ state: 'Paused', sku: 'DW100c' });
    const { POST } = await import('@/app/api/warehouse/query/route');
    const r = await POST(reqWith({ sql: 'SELECT 1' }));
    const j = await r.json();
    expect(r.status).toBe(409);
    expect(j.ok).toBe(false);
    expect(j.state).toBe('Paused');
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  it('502 when TDS execution throws', async () => {
    executeQueryMock.mockRejectedValue(Object.assign(new Error('Invalid object name gold.sales'), { code: 'EREQUEST', number: 208 }));
    const { POST } = await import('@/app/api/warehouse/query/route');
    const r = await POST(reqWith({ sql: 'SELECT * FROM gold.sales' }));
    const j = await r.json();
    expect(r.status).toBe(502);
    expect(j.ok).toBe(false);
    expect(j.error).toContain('Invalid object name');
    expect(j.sqlNumber).toBe(208);
  });
});
