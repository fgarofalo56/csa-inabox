/**
 * BFF tests for the Model-view routes:
 *   - GET/POST/DELETE /api/items/warehouse/[id]/model               (Synapse handler)
 *   - GET/POST        /api/items/databricks-sql-warehouse/[id]/model (UC handler)
 *
 * Asserts auth (401), not-found (404), that a relationship POST persists to the
 * Cosmos item state (re-GET reads it back), that a Synapse measure POST issues
 * a real CREATE OR ALTER FUNCTION, and that a Databricks relationship POST
 * issues a real ALTER TABLE ADD CONSTRAINT. The Cosmos + SQL clients are
 * stubbed; this covers the route contract + persistence wiring.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  dedicatedTarget: vi.fn(() => ({ server: 's', database: 'd', cacheKey: 'k' })),
  executeQuery: vi.fn(),
}));
vi.mock('@/lib/azure/synapse-pool-arm', () => ({ getPoolState: vi.fn() }));
vi.mock('@/lib/azure/databricks-client', () => ({
  executeStatement: vi.fn(),
  getWarehouse: vi.fn(),
}));
// Mock the Cosmos-backed item store with an in-memory item.
vi.mock('../_lib/item-crud', () => ({
  loadOwnedItem: vi.fn(),
  updateOwnedItem: vi.fn(),
}));

import { GET as whGET, POST as whPOST, DELETE as whDELETE } from '../warehouse/[id]/model/route';
import { GET as dbxGET, POST as dbxPOST } from '../databricks-sql-warehouse/[id]/model/route';
import { getSession } from '@/lib/auth/session';
import { executeQuery } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';
import { executeStatement, getWarehouse } from '@/lib/azure/databricks-client';
import { loadOwnedItem, updateOwnedItem } from '../_lib/item-crud';

function getReq(url: string) { return { nextUrl: new URL(url), url } as any; }
function bodyReq(url: string, body: any) { return { nextUrl: new URL(url), url, json: async () => body } as any; }
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

// Shared in-memory item the store mocks read/write.
let item: any;
beforeEach(() => {
  vi.resetAllMocks();
  item = { id: 'wh-1', workspaceId: 'ws-1', itemType: 'warehouse', state: {} };
  (loadOwnedItem as any).mockImplementation(async () => item);
  (updateOwnedItem as any).mockImplementation(async (_id: string, _t: string, _tenant: string, patch: any) => {
    item = { ...item, state: patch.state };
    return item;
  });
});

describe('warehouse/[id]/model (Synapse)', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await whGET(getReq('http://x/'), ctx('wh-1'));
    expect(res.status).toBe(401);
  });

  it('404 when the item is not owned', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 't1' } });
    (loadOwnedItem as any).mockResolvedValueOnce(null);
    const res = await whGET(getReq('http://x/'), ctx('wh-1'));
    expect(res.status).toBe(404);
  });

  it('GET returns tables + measures from the live pool when Online', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 't1' } });
    (getPoolState as any).mockResolvedValue({ state: 'Online', sku: 'DW100c', status: 'Online' });
    (executeQuery as any)
      // tables + columns
      .mockResolvedValueOnce({ rows: [
        ['dbo', 'Sales', 'CustId', 'int', 1, 0],
        ['dbo', 'Customer', 'Id', 'int', 1, 1],
      ], columns: [], rowCount: 2, executionMs: 1, truncated: false, messages: [], recordsAffected: 0 })
      // functions
      .mockResolvedValueOnce({ rows: [], columns: [], rowCount: 0, executionMs: 1, truncated: false, messages: [], recordsAffected: 0 });
    const res = await whGET(getReq('http://x/'), ctx('wh-1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.computeReady).toBe(true);
    expect(j.tables).toHaveLength(2);
    expect(j.tables.find((t: any) => t.id === 'dbo.Customer').columns[0].isPk).toBe(true);
  });

  it('GET still renders (computeReady=false) with a notice when the pool is Paused', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 't1' } });
    (getPoolState as any).mockResolvedValue({ state: 'Paused', sku: 'DW100c', status: 'Paused' });
    const res = await whGET(getReq('http://x/'), ctx('wh-1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.computeReady).toBe(false);
    expect(j.notice).toMatch(/Paused/i);
  });

  it('POST relationship persists to Cosmos and re-GET reads it back', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 't1' } });
    const body = { relationship: { fromTable: 'dbo.Sales', fromColumn: 'CustId', toTable: 'dbo.Customer', toColumn: 'Id', cardinality: 'many-to-one', crossFilter: 'single', active: true } };
    const res = await whPOST(bodyReq('http://x/', body), ctx('wh-1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.relationship.fromColumn).toBe('CustId');
    expect(updateOwnedItem).toHaveBeenCalled();
    // The item state now holds the relationship.
    expect(item.state.model.relationships).toHaveLength(1);

    // Re-GET (pool Paused so it returns Cosmos relationships directly).
    (getPoolState as any).mockResolvedValue({ state: 'Paused', sku: 'DW100c', status: 'Paused' });
    const res2 = await whGET(getReq('http://x/'), ctx('wh-1'));
    const j2 = await res2.json();
    expect(j2.relationships).toHaveLength(1);
    expect(j2.relationships[0].toTable).toBe('dbo.Customer');
  });

  it('POST measure issues CREATE OR ALTER FUNCTION and persists', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 't1' } });
    (getPoolState as any).mockResolvedValue({ state: 'Online', sku: 'DW100c', status: 'Online' });
    (executeQuery as any).mockResolvedValue({ rows: [], columns: [], rowCount: 0, executionMs: 1, truncated: false, messages: [], recordsAffected: 0 });
    const res = await whPOST(bodyReq('http://x/?kind=measure', { measure: { name: 'fn_Total', schema: 'dbo', expression: 'SELECT SUM(Amount) AS T FROM dbo.Sales' } }), ctx('wh-1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    const ddl = (executeQuery as any).mock.calls.at(-1)[1] as string;
    expect(ddl).toMatch(/CREATE OR ALTER FUNCTION \[dbo\]\.\[fn_Total\]/);
    expect(item.state.model.measures).toHaveLength(1);
  });

  it('POST measure 409s when the pool is Paused', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 't1' } });
    (getPoolState as any).mockResolvedValue({ state: 'Paused', sku: 'DW100c', status: 'Paused' });
    const res = await whPOST(bodyReq('http://x/?kind=measure', { measure: { name: 'fn_Total', expression: 'SELECT 1' } }), ctx('wh-1'));
    expect(res.status).toBe(409);
  });

  it('DELETE removes a persisted relationship', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 't1' } });
    // seed one relationship
    await whPOST(bodyReq('http://x/', { relationship: { fromTable: 'dbo.A', fromColumn: 'x', toTable: 'dbo.B', toColumn: 'y' } }), ctx('wh-1'));
    const relId = item.state.model.relationships[0].id;
    const res = await whDELETE(getReq(`http://x/?relId=${relId}`), ctx('wh-1'));
    expect(res.status).toBe(200);
    expect(item.state.model.relationships).toHaveLength(0);
  });
});

describe('databricks-sql-warehouse/[id]/model (Unity Catalog)', () => {
  beforeEach(() => {
    item = { id: 'dbx-1', workspaceId: 'ws-1', itemType: 'databricks-sql-warehouse', state: {} };
    (loadOwnedItem as any).mockImplementation(async () => item);
  });

  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await dbxGET(getReq('http://x/'), ctx('dbx-1'));
    expect(res.status).toBe(401);
  });

  it('POST relationship issues ALTER TABLE ADD CONSTRAINT and persists', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 't1' } });
    (getWarehouse as any).mockResolvedValue({ id: 'w1', state: 'RUNNING' });
    (executeStatement as any).mockResolvedValue({ rows: [], columns: [], rowCount: 0, executionMs: 1, truncated: false });
    const url = 'http://x/?warehouseId=w1&catalog=main&schema=sales';
    const body = { relationship: { fromTable: 'main.sales.orders', fromColumn: 'cust_id', toTable: 'main.sales.customer', toColumn: 'id' } };
    const res = await dbxPOST(bodyReq(url, body), ctx('dbx-1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    const ddl = (executeStatement as any).mock.calls.at(-1)[1] as string;
    expect(ddl).toMatch(/ALTER TABLE `main`\.`sales`\.`orders` ADD CONSTRAINT/);
    expect(ddl).toMatch(/FOREIGN KEY \(`cust_id`\) REFERENCES `main`\.`sales`\.`customer` \(`id`\)/);
    expect(item.state.model.relationships).toHaveLength(1);
  });

  it('POST relationship 409s when the warehouse is not RUNNING', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 't1' } });
    (getWarehouse as any).mockResolvedValue({ id: 'w1', state: 'STOPPED' });
    const res = await dbxPOST(bodyReq('http://x/?warehouseId=w1&catalog=main&schema=sales', { relationship: { fromTable: 'main.sales.a', fromColumn: 'x', toTable: 'main.sales.b', toColumn: 'y' } }), ctx('dbx-1'));
    expect(res.status).toBe(409);
  });

  it('POST measure stores Loom metadata without issuing DDL', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 't1' } });
    const res = await dbxPOST(bodyReq('http://x/?kind=measure&warehouseId=w1', { measure: { name: 'total_sales', expression: 'SELECT sum(amount) FROM sales' } }), ctx('dbx-1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.measure.kind).toBe('cosmos');
    expect(executeStatement).not.toHaveBeenCalled();
    expect(item.state.model.measures).toHaveLength(1);
  });
});
