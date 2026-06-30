/**
 * BFF route test for POST /api/items/workshop-app/[id]/run-action (Atelier).
 *
 * Asserts real CRUD over the Azure-native warehouse (Synapse Dedicated SQL
 * pool) — list/get reads + create/update/delete writes — with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset, plus every honest gate (no ontology /
 * no binding / Synapse not configured / bad op / missing key / disallowed col).
 * All values are bound as TDS params (never concatenated).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const loadOwnedItemMock = vi.fn();
// The route imports loadOwnedItem via the relative path '../../../_lib/item-crud'
// which resolves to the same module as the '@/' alias below; mock both spellings
// so the mock applies regardless of which specifier Vitest keys on.
vi.mock('@/app/api/items/_lib/item-crud', () => ({ loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a) }));

const executeQueryMock = vi.fn();
const dedicatedTargetMock = vi.fn(() => ({ server: 'syn.sql', database: 'loompool', cacheKey: 'k' }));
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  dedicatedTarget: () => dedicatedTargetMock(),
  executeQuery: (...a: any[]) => executeQueryMock(...a),
}));

const recordThreadEdgeMock = vi.fn(async () => undefined);
vi.mock('@/lib/thread/thread-edges', () => ({ recordThreadEdge: (...a: any[]) => recordThreadEdgeMock(...a) }));

const reqWith = (body: unknown) => ({ json: async () => body } as any);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const APP = { id: 'app1', state: { boundOntologyId: 'onto1' }, displayName: 'My App' };
const ONTO = {
  id: 'onto1', displayName: 'My Ontology',
  state: { entityBindings: [{ sourceKind: 'warehouse', sourceItemId: 'wh1', sourceDisplayName: 'WH', entityTypes: ['Order'], keyColumns: { Order: 'Id' }, writableColumns: { Order: ['Status', 'Amount'] } }] },
};

function wireOwned() {
  loadOwnedItemMock.mockImplementation(async (id: string, type: string) => {
    if (type === 'workshop-app') return APP;
    if (type === 'ontology') return ONTO;
    return null;
  });
}

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'o', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
  dedicatedTargetMock.mockReturnValue({ server: 'syn.sql', database: 'loompool', cacheKey: 'k' } as any);
  executeQueryMock.mockResolvedValue({ rows: [[1, 'open']], columns: ['Id', 'Status'], rowCount: 1, executionMs: 1, truncated: false, messages: [], recordsAffected: 1 });
  recordThreadEdgeMock.mockResolvedValue(undefined);
  wireOwned();
  process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'loompool';
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-ws';
  delete process.env.LOOM_DEFAULT_FABRIC_WORKSPACE;
});

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

async function post(body: unknown, id = 'app1') {
  const { POST } = await import('@/app/api/items/workshop-app/[id]/run-action/route');
  return POST(reqWith(body), ctx(id));
}

describe('POST /run-action — auth + request gates', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const r = await post({ entityType: 'Order' });
    expect(r.status).toBe(401);
  });
  it('400 when entityType missing', async () => {
    const r = await post({});
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('bad_request');
  });
  it('400 on unsupported op', async () => {
    const r = await post({ entityType: 'Order', op: 'drop' });
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('bad_op');
  });
});

describe('POST /run-action — ontology / binding gates', () => {
  it('409 no_ontology when no ontology bound', async () => {
    loadOwnedItemMock.mockImplementation(async (_: string, t: string) => (t === 'workshop-app' ? { id: 'app1', state: {} } : null));
    const r = await post({ entityType: 'Order' });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('no_ontology');
  });
  it('409 no_binding when entity type not bound to a warehouse', async () => {
    const r = await post({ entityType: 'Customer' });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('no_binding');
  });
  it('503 synapse_not_configured when env unset', async () => {
    dedicatedTargetMock.mockImplementation(() => { throw new Error('Missing env var: LOOM_SYNAPSE_WORKSPACE'); });
    const r = await post({ entityType: 'Order' });
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe('synapse_not_configured');
  });
});

describe('POST /run-action — READ ops (Azure-native default)', () => {
  it('list runs a SELECT and returns rows/columns', async () => {
    const r = await post({ entityType: 'Order', op: 'list', top: 10 });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true); expect(j.op).toBe('list'); expect(j.columns).toEqual(['Id', 'Status']);
    expect(executeQueryMock.mock.calls[0][1]).toContain('SELECT TOP (10) * FROM [Order]');
  });
  it('list applies object-set-filter predicates as a parameterised WHERE', async () => {
    const r = await post({ entityType: 'Order', op: 'list', top: 10, filters: [{ column: 'Status', op: 'eq', value: 'open' }] });
    expect(r.status).toBe(200);
    const sql = executeQueryMock.mock.calls[0][1];
    const params = executeQueryMock.mock.calls[0][3];
    expect(sql).toContain('SELECT TOP (10) * FROM [Order] WHERE [Status] = @f0');
    expect(params).toEqual([{ name: 'f0', value: 'open' }]);
  });
  it('get keys on the binding keyColumn with a bound param', async () => {
    const r = await post({ entityType: 'Order', op: 'get', key: '42' });
    expect(r.status).toBe(200);
    const sql = executeQueryMock.mock.calls[0][1];
    const params = executeQueryMock.mock.calls[0][3];
    expect(sql).toContain('WHERE [Id] = @k');
    expect(params).toEqual([{ name: 'k', value: '42' }]);
  });
  it('get 400 when no key value', async () => {
    const r = await post({ entityType: 'Order', op: 'get' });
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('no_key');
  });
});

describe('POST /run-action — aggregate op (chart / KPI)', () => {
  it('count with a groupBy emits GROUP BY + COUNT(*) and orders by the measure', async () => {
    executeQueryMock.mockResolvedValueOnce({ rows: [['open', 3]], columns: ['Status', 'value'], rowCount: 1, recordsAffected: 0 });
    const r = await post({ entityType: 'Order', op: 'aggregate', groupBy: 'Status', aggFn: 'count', top: 50 });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true); expect(j.op).toBe('aggregate'); expect(j.columns).toEqual(['Status', 'value']);
    const sql = executeQueryMock.mock.calls[0][1];
    expect(sql).toContain('SELECT TOP (50) [Status] AS [Status], COUNT(*) AS [value] FROM [Order]');
    expect(sql).toContain('GROUP BY [Status] ORDER BY COUNT(*) DESC');
  });
  it('sum/avg require a measure column (400 when missing)', async () => {
    const r = await post({ entityType: 'Order', op: 'aggregate', aggFn: 'sum' });
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('no_agg_column');
  });
  it('scalar aggregate (no groupBy) emits a single bound, filtered value', async () => {
    executeQueryMock.mockResolvedValueOnce({ rows: [[1234]], columns: ['value'], rowCount: 1, recordsAffected: 0 });
    const r = await post({ entityType: 'Order', op: 'aggregate', aggFn: 'sum', aggColumn: 'Amount', filters: [{ column: 'Status', op: 'eq', value: 'open' }] });
    expect(r.status).toBe(200);
    const sql = executeQueryMock.mock.calls[0][1];
    const params = executeQueryMock.mock.calls[0][3];
    expect(sql).toBe('SELECT SUM([Amount]) AS [value] FROM [Order] WHERE [Status] = @f0');
    expect(params).toEqual([{ name: 'f0', value: 'open' }]);
  });
  it('rejects an unsupported aggFn', async () => {
    const r = await post({ entityType: 'Order', op: 'aggregate', aggFn: 'median' });
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('bad_agg_fn');
  });
});

describe('POST /run-action — distinct op (filter value list)', () => {
  it('returns distinct non-null values for a column, ordered', async () => {
    executeQueryMock.mockResolvedValueOnce({ rows: [['closed'], ['open']], columns: ['value'], rowCount: 2, recordsAffected: 0 });
    const r = await post({ entityType: 'Order', op: 'distinct', column: 'Status', top: 200 });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true); expect(j.op).toBe('distinct'); expect(j.column).toBe('Status');
    const sql = executeQueryMock.mock.calls[0][1];
    expect(sql).toContain('SELECT DISTINCT TOP (200) [Status] AS [value] FROM [Order] WHERE [Status] IS NOT NULL ORDER BY [Status]');
  });
  it('400 when no column', async () => {
    const r = await post({ entityType: 'Order', op: 'distinct' });
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('no_column');
  });
});

describe('POST /run-action — WRITE ops (real CRUD)', () => {
  it('create issues a parameterised INSERT and records lineage', async () => {
    const r = await post({ entityType: 'Order', op: 'create', values: { Status: 'open', Amount: '99' } });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true); expect(j.op).toBe('create'); expect(j.recordsAffected).toBe(1);
    const sql = executeQueryMock.mock.calls[0][1];
    const params = executeQueryMock.mock.calls[0][3];
    expect(sql).toContain('INSERT INTO [Order]');
    expect(sql).toContain('VALUES (@p0, @p1)');
    expect(params.map((p: any) => p.value)).toEqual(['open', '99']);
    expect(recordThreadEdgeMock).toHaveBeenCalled();
  });
  it('update issues a parameterised UPDATE keyed on the binding PK', async () => {
    const r = await post({ entityType: 'Order', op: 'update', key: '7', values: { Status: 'closed' } });
    expect(r.status).toBe(200);
    const sql = executeQueryMock.mock.calls[0][1];
    const params = executeQueryMock.mock.calls[0][3];
    expect(sql).toContain('UPDATE [Order] SET [Status] = @p0 WHERE [Id] = @k');
    expect(params).toEqual([{ name: 'p0', value: 'closed' }, { name: 'k', value: '7' }]);
  });
  it('delete issues a parameterised DELETE keyed on the binding PK', async () => {
    const r = await post({ entityType: 'Order', op: 'delete', key: '7' });
    expect(r.status).toBe(200);
    const sql = executeQueryMock.mock.calls[0][1];
    expect(sql).toContain('DELETE FROM [Order] WHERE [Id] = @k');
    expect((await r.json()).op).toBe('delete');
  });
  it('create 400 when no values', async () => {
    const r = await post({ entityType: 'Order', op: 'create', values: {} });
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('no_values');
  });
  it('create 400 when a column is not in writableColumns', async () => {
    const r = await post({ entityType: 'Order', op: 'create', values: { Secret: 'x' } });
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('column_not_allowed');
  });
  it('update 400 when no key provided', async () => {
    const r = await post({ entityType: 'Order', op: 'update', values: { Status: 'closed' } });
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('no_key');
  });
  it('rejects a column that is not a safe SQL identifier', async () => {
    const r = await post({ entityType: 'Order', op: 'create', values: { 'Status; DROP TABLE x': 'v' } });
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('bad_column');
  });
});
