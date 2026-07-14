/**
 * BFF route test for POST /api/thread/materialize-to-kql — the Weave
 * "Materialize to KQL (ADX)" edge. Mocks the session, item loads, lakehouse
 * abfss resolver, and the kusto-client external-table commands.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1' } } as any));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const loadOwnedItemMock = vi.fn();
vi.mock('@/app/api/items/_lib/item-crud', () => ({ loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a) }));

const recordThreadEdgeMock = vi.fn(async () => {});
vi.mock('@/lib/thread/thread-edges', () => ({ recordThreadEdge: (...a: any[]) => recordThreadEdgeMock(...a) }));

const resolveLakehouseAbfssMock = vi.fn(async () => ({
  abfss: 'abfss://bronze@acct.dfs.core.windows.net/lakehouses/sales', container: 'bronze', root: 'lakehouses/sales',
}));
vi.mock('@/lib/azure/lakehouse-abfss', () => ({ resolveLakehouseAbfss: (...a: any[]) => resolveLakehouseAbfssMock(...a) }));

const createExternalDeltaTableMock = vi.fn(async () => ({ columns: [], rows: [] }));
const setQueryAccelerationPolicyMock = vi.fn(async () => ({ columns: [], rows: [] }));
const kustoConfigGateMock = vi.fn(() => null);
vi.mock('@/lib/azure/kusto-client', () => {
  class KustoError extends Error {
    status?: number;
    constructor(m: string, status?: number) { super(m); this.name = 'KustoError'; this.status = status; }
  }
  return {
    createExternalDeltaTable: (...a: any[]) => createExternalDeltaTableMock(...a),
    setQueryAccelerationPolicy: (...a: any[]) => setQueryAccelerationPolicyMock(...a),
    kustoConfigGate: () => kustoConfigGateMock(),
    defaultDatabase: () => 'loomdb',
    KustoError,
  };
});
import { KustoError } from '@/lib/azure/kusto-client';
import { POST } from '../route';

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/thread/materialize-to-kql', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
const FROM = { id: 'lh-1', type: 'lakehouse', name: 'Sales LH' };
const VALUES = { table: 'orders|bronze/Tables/orders', kqlDatabaseId: 'kql-1', accelerate: true };

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-1' } } as any);
  kustoConfigGateMock.mockReturnValue(null);
  resolveLakehouseAbfssMock.mockResolvedValue({ abfss: 'abfss://bronze@acct.dfs.core.windows.net/lakehouses/sales', container: 'bronze', root: 'lakehouses/sales' } as any);
  createExternalDeltaTableMock.mockResolvedValue({ columns: [], rows: [] } as any);
  setQueryAccelerationPolicyMock.mockResolvedValue({ columns: [], rows: [] } as any);
  loadOwnedItemMock.mockImplementation(async (id: string, type: string) => {
    if (type === 'lakehouse') return { id: 'lh-1', displayName: 'Sales LH', workspaceId: 'ws-1' };
    if (type === 'kql-database') return { id: 'kql-1', itemType: 'kql-database', displayName: 'Telemetry', workspaceId: 'ws-1', state: {} };
    return null;
  });
  [createExternalDeltaTableMock, setQueryAccelerationPolicyMock, recordThreadEdgeMock].forEach((m) => m.mockClear());
});

describe('materialize-to-kql route', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await POST(post({ from: FROM, values: VALUES }));
    expect(res.status).toBe(401);
  });

  it('503 honest gate when ADX is not configured', async () => {
    kustoConfigGateMock.mockReturnValueOnce({ missing: 'LOOM_KUSTO_CLUSTER_URI' });
    const res = await POST(post({ from: FROM, values: VALUES }));
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.gate.missing).toBe('LOOM_KUSTO_CLUSTER_URI');
  });

  it('creates the ADX external table + acceleration, records lineage', async () => {
    const res = await POST(post({ from: FROM, values: VALUES }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.database).toBe('Telemetry');
    expect(j.accelerated).toBe(true);
    // Delta external table bound to the resolved abfss Tables/<name> path.
    expect(createExternalDeltaTableMock).toHaveBeenCalledWith(
      'Telemetry', expect.any(String), 'abfss://bronze@acct.dfs.core.windows.net/lakehouses/sales/Tables/orders', expect.any(Object),
    );
    expect(setQueryAccelerationPolicyMock).toHaveBeenCalled();
    expect(recordThreadEdgeMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'materialize-to-kql', toType: 'kql-database' }));
  });

  it('skips acceleration when accelerate:false', async () => {
    const res = await POST(post({ from: FROM, values: { ...VALUES, accelerate: false } }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.accelerated).toBe(false);
    expect(setQueryAccelerationPolicyMock).not.toHaveBeenCalled();
  });

  it('surfaces a KustoError status (401/403 → AllDatabasesAdmin hint)', async () => {
    createExternalDeltaTableMock.mockRejectedValueOnce(new KustoError('Forbidden', 403));
    const res = await POST(post({ from: FROM, values: VALUES }));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.error).toMatch(/AllDatabasesAdmin/);
  });

  it('non-fatal acceleration failure still succeeds with a note', async () => {
    setQueryAccelerationPolicyMock.mockRejectedValueOnce(new Error('policy denied'));
    const res = await POST(post({ from: FROM, values: VALUES }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.accelerated).toBe(false);
    expect(j.message).toMatch(/query acceleration could not be enabled/);
  });
});
