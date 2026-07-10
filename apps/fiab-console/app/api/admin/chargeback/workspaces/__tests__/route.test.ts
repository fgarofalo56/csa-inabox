/**
 * BFF route tests for GET /api/admin/chargeback/workspaces (WS-CHGBK).
 *
 * Pins: tenant-admin gate, timeframe validation, the honest Cost Management
 * gate (MonitorError 401/403/404 → 503 with a remediation), and the happy-path
 * response shape. The allocation math itself is unit-tested separately
 * (workspace-chargeback.test.ts) — here getWorkspaceChargeback is mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { MonitorError } from '@/lib/azure/monitor-client';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'admin-oid', upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  tenantScopeId: (s: any) => s?.claims?.tid ?? s?.claims?.oid,
}));

vi.mock('@/lib/azure/query-result-cache', () => ({
  buildScopedCacheKey: (p: string, o: Record<string, unknown>) => `${p}:${JSON.stringify(o)}`,
  resolveBackendTtl: () => 1000,
  getOrComputeCached: async (_k: string, _t: string, fn: () => Promise<any>) => ({ value: await fn(), meta: {} }),
}));

vi.mock('@/lib/azure/domain-registry', () => ({
  loadOrSeedDomains: async () => ({ items: [{ id: 'finance', name: 'Finance' }] }),
}));

const getWorkspaceChargebackMock = vi.fn();
vi.mock('@/lib/azure/workspace-chargeback', () => ({
  getWorkspaceChargeback: (opts: any) => getWorkspaceChargebackMock(opts),
}));

function makeReq(query = '') {
  return new NextRequest(`https://loom.test/api/admin/chargeback/workspaces${query}`, { method: 'GET' });
}

describe('/api/admin/chargeback/workspaces', () => {
  const ORIG_ENV = { ...process.env };
  beforeEach(() => {
    getWorkspaceChargebackMock.mockReset();
    getSessionMock.mockReturnValue({ claims: { oid: 'admin-oid', upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 });
    process.env.LOOM_TENANT_ADMIN_OID = 'admin-oid';
  });
  afterEach(() => { process.env = { ...ORIG_ENV }; vi.restoreAllMocks(); });

  it('401s when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null);
    const { GET } = await import('../route');
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it('403s when the caller is not a tenant admin', async () => {
    delete process.env.LOOM_TENANT_ADMIN_OID;
    const { GET } = await import('../route');
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
    expect(getWorkspaceChargebackMock).not.toHaveBeenCalled();
  });

  it('returns the allocation model with the requested timeframe', async () => {
    getWorkspaceChargebackMock.mockResolvedValue({
      currency: 'USD', timeframe: 'Last7Days',
      rows: [{ workspaceId: 'w1', name: 'WS', domainId: 'finance', domainName: 'Finance', cost: 12.5, pctOfDomain: 100, basis: 'usage' }],
      totalCost: 12.5, unallocatedCost: 0, usageWindowDays: 30, generatedAt: '2026-07-10T00:00:00Z',
    });
    const { GET } = await import('../route');
    const res = await GET(makeReq('?timeframe=Last7Days'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.rows[0]).toMatchObject({ workspaceId: 'w1', basis: 'usage' });
    expect(j.totalCost).toBe(12.5);
    expect(getWorkspaceChargebackMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'admin-oid', timeframe: 'Last7Days' }));
  });

  it('falls back to MonthToDate for an invalid timeframe', async () => {
    getWorkspaceChargebackMock.mockResolvedValue({ currency: 'USD', timeframe: 'MonthToDate', rows: [], totalCost: 0, unallocatedCost: 0, usageWindowDays: 30, generatedAt: '' });
    const { GET } = await import('../route');
    await GET(makeReq('?timeframe=bogus'));
    expect(getWorkspaceChargebackMock).toHaveBeenCalledWith(expect.objectContaining({ timeframe: 'MonthToDate' }));
  });

  it('surfaces the honest Cost Management gate (503) on a MonitorError 403', async () => {
    getWorkspaceChargebackMock.mockRejectedValue(new MonitorError('Forbidden', 403));
    const { GET } = await import('../route');
    const res = await GET(makeReq());
    const j = await res.json();
    expect(res.status).toBe(503);
    expect(j.ok).toBe(false);
    expect(j.gate.missing).toContain('Cost Management Reader');
    expect(j.gate.message).toMatch(/Cost Management/);
  });

  it('propagates a non-auth MonitorError status', async () => {
    getWorkspaceChargebackMock.mockRejectedValue(new MonitorError('boom', 500));
    const { GET } = await import('../route');
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
  });
});
