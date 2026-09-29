/**
 * #3744 — synthetic-data generate writes through the PLATFORM warehouse when
 * the caller does not pick one, and a warehouse the Console could not produce
 * returns its classified cause instead of a "set LOOM_X" gate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  getSession: vi.fn(),
  loadOwnedItem: vi.fn(),
  updateOwnedItem: vi.fn(async () => ({})),
  createUcTableFromFile: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({ getSession: () => m.getSession() }));
vi.mock('../../../../_lib/item-crud', async () => {
  const actual = await vi.importActual<any>('../../../../_lib/item-crud');
  return { ...actual, loadOwnedItem: m.loadOwnedItem, updateOwnedItem: m.updateOwnedItem };
});
vi.mock('@/lib/azure/databricks-client', () => ({
  databricksConfigGate: () => (process.env.LOOM_DATABRICKS_HOSTNAME ? null : { missing: 'LOOM_DATABRICKS_HOSTNAME' }),
  createUcTableFromFile: m.createUcTableFromFile,
}));
vi.mock('@/lib/azure/databricks-sql-warehouse', async () => {
  const actual = await vi.importActual<typeof import('@/lib/azure/databricks-sql-warehouse')>('@/lib/azure/databricks-sql-warehouse');
  return { ...actual, resolveWarehouseIdOrThrow: m.resolve };
});

import { POST } from '../route';
import { WarehouseResolutionError } from '@/lib/azure/databricks-sql-warehouse';

const body = {
  specs: [{ name: 'id', strategy: 'sequence' }],
  rowCount: 3,
  catalog: 'main', schema: 'default', table: 'synth', volume: 'main.default.stage',
};
const req = (b: unknown = body) =>
  new NextRequest('http://localhost/api/items/synthetic-data/sd-1/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
  });
const ctx = { params: Promise.resolve({ id: 'sd-1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  m.getSession.mockReturnValue({ claims: { oid: 'oid-1', upn: 'u@x' } });
  m.loadOwnedItem.mockResolvedValue({ id: 'sd-1', state: {} });
  m.createUcTableFromFile.mockResolvedValue({ full_name: 'main.default.synth', row_count: 3, columns: ['id'] });
  m.resolve.mockResolvedValue('wh-platform');
  vi.stubEnv('LOOM_DATABRICKS_HOSTNAME', 'adb-1.azuredatabricks.net');
});
afterEach(() => vi.unstubAllEnvs());

describe('synthetic-data generate — platform warehouse (#3744)', () => {
  it('writes on the resolver-produced warehouse when none is picked', async () => {
    const res = await (POST as any)(req(), ctx);
    expect(res.status).toBe(200);
    // Breaks if the route reads process.env again (it would pass '' as warehouse_id).
    expect(m.createUcTableFromFile.mock.calls[0][0].warehouse_id).toBe('wh-platform');
    expect(m.resolve).toHaveBeenCalledWith(null);
  });

  it('a caller-picked warehouse is passed through to the resolver as the explicit id', async () => {
    m.resolve.mockImplementation(async (x: string | null) => x || 'wh-platform');
    await (POST as any)(req({ ...body, warehouseId: 'wh-picked' }), ctx);
    expect(m.createUcTableFromFile.mock.calls[0][0].warehouse_id).toBe('wh-picked');
  });

  it('a network failure producing the warehouse returns 503 with kind "network" — not "set LOOM_X"', async () => {
    m.resolve.mockRejectedValue(new WarehouseResolutionError({
      kind: 'network', step: 'list', message: 'The Console could not reach the Databricks workspace', remediation: 'check the private endpoint',
    }));
    const res = await (POST as any)(req(), ctx);
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j).toMatchObject({ ok: false, kind: 'network', code: 'warehouse_network', gateId: 'svc-databricks-sql' });
    expect(j.error).not.toMatch(/set LOOM_DATABRICKS_SQL_WAREHOUSE_ID/);
    expect(m.createUcTableFromFile).not.toHaveBeenCalled();
  });

  it('no workspace bound is the one not_configured gate', async () => {
    vi.stubEnv('LOOM_DATABRICKS_HOSTNAME', '');
    const res = await (POST as any)(req(), ctx);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('not_configured');
    expect(m.resolve).not.toHaveBeenCalled();
  });

  it('unauthenticated is 401 (withSession migration)', async () => {
    m.getSession.mockReturnValue(null);
    const res = await (POST as any)(req(), ctx);
    expect(res.status).toBe(401);
  });
});
