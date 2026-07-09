/**
 * BFF tests for the Azure-native DEFAULT metric-view route (DBX-6): compile
 * (pure) + run (Synapse Dedicated). Auth gate, compile contract, honest gate
 * when Synapse is unset, and happy-path delegation to executeQuery.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  executeQuery: vi.fn(),
  dedicatedTarget: vi.fn(() => ({ server: 'ws.sql.azuresynapse.net', database: 'pool', cacheKey: 'k' })),
}));

import { POST } from '../route';
import { getSession } from '@/lib/auth/session';
import { executeQuery } from '@/lib/azure/synapse-sql-client';

const SESSION = { claims: { upn: 'u@contoso.com', oid: 'oid-1' }, exp: 9_999_999_999 };
function postReq(body: any) { return { json: async () => body } as any; }

const SPEC = {
  source: 'sales.public.orders',
  dimensions: [{ name: 'status', expr: 'o_orderstatus' }],
  measures: [{ name: 'total', aggregation: 'SUM', expr: 'o_totalprice' }],
};

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.LOOM_SYNAPSE_WORKSPACE;
  delete process.env.LOOM_SYNAPSE_DEDICATED_POOL;
});

it('401 without session', async () => {
  (getSession as any).mockReturnValue(null);
  const res = await POST(postReq({ action: 'compile', spec: SPEC }));
  expect(res.status).toBe(401);
});

it('compile returns select + dax + yaml (pure, no execution)', async () => {
  (getSession as any).mockReturnValue(SESSION);
  const res = await POST(postReq({ action: 'compile', spec: SPEC, tableRef: 'Orders' }));
  const j = await res.json();
  expect(j.ok).toBe(true);
  expect(j.select).toContain('SUM(o_totalprice) AS [total]');
  expect(j.selectDatabricks).toContain('AS `total`');
  expect(j.dax).toEqual([{ name: 'total', expr: "SUM ( 'Orders'[o_totalprice] )" }]);
  expect(j.yaml).toContain('version: 0.1');
  expect(executeQuery).not.toHaveBeenCalled();
});

it('compile includes DDL when catalog/schema/name are provided', async () => {
  (getSession as any).mockReturnValue(SESSION);
  const res = await POST(postReq({ action: 'compile', spec: SPEC, catalog: 'main', schema: 'sales', name: 'orders_mv' }));
  const j = await res.json();
  expect(j.ddl).toContain('CREATE OR REPLACE VIEW `main`.`sales`.`orders_mv`');
});

it('run honest-gates when Synapse is not configured', async () => {
  (getSession as any).mockReturnValue(SESSION);
  const res = await POST(postReq({ action: 'run', spec: SPEC }));
  const j = await res.json();
  expect(res.status).toBe(200);
  expect(j.ok).toBe(false);
  expect(j.gated).toBe(true);
  expect(executeQuery).not.toHaveBeenCalled();
});

it('run executes the compiled SELECT against Synapse when configured', async () => {
  (getSession as any).mockReturnValue(SESSION);
  process.env.LOOM_SYNAPSE_WORKSPACE = 'ws';
  process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'pool';
  (executeQuery as any).mockResolvedValue({ columns: ['status', 'total'], rows: [['O', 100]], rowCount: 1, executionMs: 5 });
  const res = await POST(postReq({ action: 'run', spec: SPEC }));
  const j = await res.json();
  expect(j.ok).toBe(true);
  expect(j.rows).toEqual([['O', 100]]);
  expect(executeQuery).toHaveBeenCalledOnce();
  const [, sql] = (executeQuery as any).mock.calls[0];
  expect(sql).toContain('SELECT TOP 200');
});

it('400 on a bad spec (injection in expression)', async () => {
  (getSession as any).mockReturnValue(SESSION);
  const res = await POST(postReq({ action: 'compile', spec: { source: 'orders', dimensions: [], measures: [{ name: 'x', aggregation: 'SUM', expr: 'a); DROP TABLE t--' }] } }));
  expect(res.status).toBe(400);
});
