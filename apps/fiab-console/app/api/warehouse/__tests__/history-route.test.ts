/**
 * BFF route test for GET /api/warehouse/history.
 *
 * Asserts the real sys.dm_pdw_exec_requests path (synapse-sql-client.
 * executeQuery over synapseRecentRequestsSql), not a stub: (1) unauthed → 401,
 * (2) happy path → 200 { ok, columns, rows } and the DMV SQL is what gets
 * executed, (3) ?windowSecs= is threaded into synapseRecentRequestsSql,
 * (4) honest config gate → 503 when the dedicated pool target can't resolve,
 * (5) 409 when the pool is not Online, (6) 502 when the TDS execution throws.
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

const synapseRecentRequestsSqlMock = vi.fn((secs: number) => `-- recent(${secs}) FROM sys.dm_pdw_exec_requests`);
vi.mock('@/lib/azure/warehouse-monitoring', () => ({
  synapseRecentRequestsSql: (secs: number) => synapseRecentRequestsSqlMock(secs),
}));

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
  dedicatedTargetMock.mockReturnValue({ server: 'syn.sql', database: 'loompool' });
  getPoolStateMock.mockResolvedValue({ state: 'Online', sku: 'DW100c' });
  executeQueryMock.mockResolvedValue({
    columns: ['request_id', 'status', 'command', 'total_elapsed_time', 'submit_time', 'login_name'],
    rows: [['QID1', 'Completed', 'SELECT 1', 42, '2026-06-10T00:00:00Z', 'u@t.com']],
    rowCount: 1,
  });
});

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

const reqWith = (url: string) => ({ url } as any);

describe('GET /api/warehouse/history', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { GET } = await import('@/app/api/warehouse/history/route');
    const r = await GET(reqWith('https://console/api/warehouse/history'));
    expect(r.status).toBe(401);
  });

  it('200 + DMV result, running synapseRecentRequestsSql with the default 1h window', async () => {
    const { GET } = await import('@/app/api/warehouse/history/route');
    const r = await GET(reqWith('https://console/api/warehouse/history'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.columns).toContain('request_id');
    expect(j.engine).toBe('synapse-dedicated');
    expect(synapseRecentRequestsSqlMock).toHaveBeenCalledWith(3600);
    expect(executeQueryMock).toHaveBeenCalledWith(
      { server: 'syn.sql', database: 'loompool' },
      '-- recent(3600) FROM sys.dm_pdw_exec_requests',
    );
  });

  it('threads ?windowSecs= into the DMV query', async () => {
    const { GET } = await import('@/app/api/warehouse/history/route');
    const r = await GET(reqWith('https://console/api/warehouse/history?windowSecs=86400'));
    expect(r.status).toBe(200);
    expect(synapseRecentRequestsSqlMock).toHaveBeenCalledWith(86400);
  });

  it('503 honest config gate when the pool target cannot resolve', async () => {
    dedicatedTargetMock.mockImplementation(() => { throw new Error('LOOM_SYNAPSE_WORKSPACE unset'); });
    const { GET } = await import('@/app/api/warehouse/history/route');
    const r = await GET(reqWith('https://console/api/warehouse/history'));
    const j = await r.json();
    expect(r.status).toBe(503);
    expect(j.ok).toBe(false);
    expect(j.gate.missing).toContain('LOOM_SYNAPSE_WORKSPACE');
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  it('409 when the pool is not Online', async () => {
    getPoolStateMock.mockResolvedValue({ state: 'Paused', sku: 'DW100c' });
    const { GET } = await import('@/app/api/warehouse/history/route');
    const r = await GET(reqWith('https://console/api/warehouse/history'));
    const j = await r.json();
    expect(r.status).toBe(409);
    expect(j.ok).toBe(false);
    expect(j.state).toBe('Paused');
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  it('502 when TDS execution throws', async () => {
    executeQueryMock.mockRejectedValue(Object.assign(new Error('DMV unavailable'), { code: 'EREQUEST', number: 110 }));
    const { GET } = await import('@/app/api/warehouse/history/route');
    const r = await GET(reqWith('https://console/api/warehouse/history'));
    const j = await r.json();
    expect(r.status).toBe(502);
    expect(j.ok).toBe(false);
    expect(j.error).toContain('DMV unavailable');
  });
});
