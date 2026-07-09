/**
 * BFF tests for the UC Metric Views route (DBX-6, Databricks opt-in path).
 * Auth gate (401), config gate, Gov gate, validation (400), and happy-path
 * delegation to the real client helpers (stubbed here; their SQL is covered by
 * the metric-view-builders unit tests).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/databricks-client', () => ({
  databricksConfigGate: vi.fn(),
  listWarehouses: vi.fn(),
}));
vi.mock('@/lib/azure/cloud-endpoints', () => ({
  isGovCloud: vi.fn(() => false),
  cloudBoundaryLabel: vi.fn(() => 'GCC-High'),
}));
vi.mock('@/lib/azure/unity-catalog-client', () => ({
  listUcViews: vi.fn(),
  createUcMetricView: vi.fn(),
  queryUcMetricView: vi.fn(),
  dropUcMetricView: vi.fn(),
}));

import { GET, POST } from '../route';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate, listWarehouses } from '@/lib/azure/databricks-client';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import { listUcViews, createUcMetricView, queryUcMetricView } from '@/lib/azure/unity-catalog-client';

const SESSION = { claims: { upn: 'u@contoso.com', oid: 'oid-1' }, exp: 9_999_999_999 };
function getReq(qs = '') { return { nextUrl: new URL(`http://x/api/databricks/unity-catalog/metric-views${qs}`) } as any; }
function postReq(body: any) { return { json: async () => body } as any; }

beforeEach(() => {
  vi.resetAllMocks();
  (databricksConfigGate as any).mockReturnValue(null);
  (isGovCloud as any).mockReturnValue(false);
  (listWarehouses as any).mockResolvedValue([{ id: 'wh-1', state: 'RUNNING' }]);
});

describe('GET /metric-views', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET(getReq('?catalog=main&schema=sales'));
    expect(res.status).toBe(401);
  });

  it('gated (200 ok:false) when Databricks not configured', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (databricksConfigGate as any).mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' });
    const res = await GET(getReq('?catalog=main&schema=sales'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(false);
    expect(j.gated).toBe(true);
  });

  it('gated at the Gov boundary', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (isGovCloud as any).mockReturnValue(true);
    const res = await GET(getReq('?catalog=main&schema=sales'));
    const j = await res.json();
    expect(j.gated).toBe(true);
  });

  it('400 without catalog/schema', async () => {
    (getSession as any).mockReturnValue(SESSION);
    const res = await GET(getReq('?catalog=main'));
    expect(res.status).toBe(400);
  });

  it('lists views on the happy path', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (listUcViews as any).mockResolvedValue([{ viewName: 'orders_mv' }]);
    const res = await GET(getReq('?catalog=main&schema=sales'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.views).toHaveLength(1);
    expect(listUcViews).toHaveBeenCalledWith('wh-1', 'main', 'sales');
  });
});

describe('POST /metric-views', () => {
  it('creates a metric view via the client (happy path)', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (createUcMetricView as any).mockResolvedValue({ sql: 'CREATE OR REPLACE VIEW …', executionMs: 12 });
    const res = await POST(postReq({
      action: 'create',
      params: { catalog: 'main', schema: 'sales', name: 'orders_mv', orReplace: true, spec: { source: 'sales.public.orders', dimensions: [{ name: 'status', expr: 'o_orderstatus' }], measures: [{ name: 'n', aggregation: 'COUNT' }] } },
    }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.sql).toContain('CREATE OR REPLACE VIEW');
    expect(createUcMetricView).toHaveBeenCalled();
  });

  it('400 when create params are missing', async () => {
    (getSession as any).mockReturnValue(SESSION);
    const res = await POST(postReq({ action: 'create', params: { catalog: 'main' } }));
    expect(res.status).toBe(400);
  });

  it('queries a metric view (MEASURE form) and returns rows', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (queryUcMetricView as any).mockResolvedValue({ sql: 'SELECT …', columns: ['status', 'n'], rows: [['O', 5]], rowCount: 1, executionMs: 8 });
    const res = await POST(postReq({ action: 'query', catalog: 'main', schema: 'sales', name: 'orders_mv', dimensions: ['status'], measures: ['n'] }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.rows).toEqual([['O', 5]]);
  });
});
