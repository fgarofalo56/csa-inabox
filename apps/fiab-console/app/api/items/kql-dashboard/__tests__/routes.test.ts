/**
 * Backend contract tests for the KQL Dashboard (Fabric Real-Time Dashboard
 * parity) routes:
 *
 *   GET  /api/items/kql-dashboard/[id]            read model (+ ?run=1 execute)
 *   PUT  /api/items/kql-dashboard/[id]            save model (tiles+sources+params)
 *   POST /api/items/kql-dashboard/[id]/run        run a transient builder model
 *   POST /api/items/kql-dashboard/[id]/param-values  query-based param values
 *
 * Real Kusto I/O is mocked at the kusto-client boundary; these tests pin the
 * route contract: auth gates, param/time substitution into the executed KQL,
 * tile→database binding, content-type behavior, and structured errors.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/kusto-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/kusto-client');
  return {
    ...actual,
    executeQuery: vi.fn(),
    loadKustoItem: vi.fn(),
    saveItemState: vi.fn(),
    resolveDatabase: vi.fn(() => 'loomdb-default'),
    defaultDatabase: vi.fn(() => 'loomdb-default'),
  };
});

import { getSession } from '@/lib/auth/session';
import { executeQuery, loadKustoItem, saveItemState } from '@/lib/azure/kusto-client';
import { GET, PUT } from '../[id]/route';
import { POST as RUN } from '../[id]/run/route';
import { POST as PARAM_VALUES } from '../[id]/param-values/route';

const ctx = { params: Promise.resolve({ id: 'dash-1' }) };
const ctxNew = { params: Promise.resolve({ id: 'new' }) };

function getReq(qs = '') {
  return { nextUrl: new URL(`https://x/api/items/kql-dashboard/dash-1${qs}`) } as any;
}
function jsonReq(body: any) {
  return { json: async () => body } as any;
}

const RESULT = { columns: ['c'], columnTypes: ['long'], rows: [[1]], rowCount: 1, executionMs: 3, truncated: false };

beforeEach(() => {
  vi.resetAllMocks();
  (executeQuery as any).mockResolvedValue(RESULT);
});

describe('GET /api/items/kql-dashboard/[id]', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET(getReq(), ctx);
    expect(res.status).toBe(401);
  });

  it('404 when the item is missing', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o', upn: 'u' } });
    (loadKustoItem as any).mockResolvedValue(null);
    const res = await GET(getReq(), ctx);
    expect(res.status).toBe(404);
  });

  it('returns the saved model without executing when run is absent', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o', upn: 'u' } });
    (loadKustoItem as any).mockResolvedValue({
      id: 'dash-1', workspaceId: 'w', itemType: 'kql-dashboard', displayName: 'D',
      state: { tiles: [{ title: 'T', kql: 'print 1', viz: 'stat' }], dataSources: [{ id: 's', name: 'S', database: 'db1' }], parameters: [] },
    });
    const res = await GET(getReq(), ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.tiles[0].title).toBe('T');
    expect(j.dataSources[0].database).toBe('db1');
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('?run=1 executes each tile with the time range substituted into the KQL', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o', upn: 'u' } });
    (loadKustoItem as any).mockResolvedValue({
      id: 'dash-1', workspaceId: 'w', itemType: 'kql-dashboard', displayName: 'D',
      state: { tiles: [{ title: 'T', kql: 'T | where ts > _startTime', viz: 'timechart' }] },
    });
    const res = await GET(getReq('?run=1&time=last-7d'), ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.tiles[0].result).toEqual(RESULT);
    const [, executedKql] = (executeQuery as any).mock.calls[0];
    expect(executedKql).toContain('ago(7d)');
  });

  it('?param.<var> override is substituted into the tile KQL', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o', upn: 'u' } });
    (loadKustoItem as any).mockResolvedValue({
      id: 'dash-1', workspaceId: 'w', itemType: 'kql-dashboard', displayName: 'D',
      state: { tiles: [{ title: 'T', kql: 'T | where State == _state', viz: 'table' }],
        parameters: [{ variableName: '_state', type: 'freetext', dataType: 'string', value: '' }] },
    });
    const res = await GET(getReq('?run=1&param._state=Texas'), ctx);
    await res.json();
    const [, executedKql] = (executeQuery as any).mock.calls[0];
    expect(executedKql).toContain('State == "Texas"');
  });

  it('binds a tile to its data source database', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o', upn: 'u' } });
    (loadKustoItem as any).mockResolvedValue({
      id: 'dash-1', workspaceId: 'w', itemType: 'kql-dashboard', displayName: 'D',
      state: {
        tiles: [{ title: 'T', kql: 'print 1', viz: 'table', dataSourceId: 'srcB' }],
        dataSources: [{ id: 'srcA', name: 'A', database: 'db_a' }, { id: 'srcB', name: 'B', database: 'db_b' }],
      },
    });
    await GET(getReq('?run=1'), ctx);
    const [db] = (executeQuery as any).mock.calls[0];
    expect(db).toBe('db_b');
  });
});

describe('PUT /api/items/kql-dashboard/[id]', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await PUT(jsonReq({ tiles: [] }), ctx);
    expect(res.status).toBe(401);
  });

  it('saves the full model (tiles + sources + params) to Cosmos', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o', upn: 'u' } });
    (loadKustoItem as any).mockResolvedValue({ id: 'dash-1', workspaceId: 'w', itemType: 'kql-dashboard', displayName: 'D', state: {} });
    (saveItemState as any).mockImplementation(async (_item: any, patch: any) => ({ state: patch }));
    const body = {
      tiles: [{ title: 'T', kql: 'print 1', viz: 'pie', w: 6, h: 3 }],
      dataSources: [{ id: 's', name: 'S', database: 'db1' }],
      parameters: [{ variableName: '_x', type: 'fixed', dataType: 'string', values: ['a', 'b'] }],
      baseQueries: [{ id: 'bq1', name: 'Filtered', kql: 'T | where x == 1' }],
      timeRange: 'last-1h',
    };
    const res = await PUT(jsonReq(body), ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(saveItemState).toHaveBeenCalledTimes(1);
    const patch = (saveItemState as any).mock.calls[0][1];
    expect(patch.tiles[0].viz).toBe('pie');
    expect(patch.dataSources[0].database).toBe('db1');
    expect(patch.parameters[0].variableName).toBe('_x');
    expect(patch.baseQueries[0]).toMatchObject({ id: 'bq1', name: 'Filtered', kql: 'T | where x == 1' });
    expect(patch.timeRange).toBe('last-1h');
    // The save response echoes the persisted base queries back to the client.
    expect(j.baseQueries[0].name).toBe('Filtered');
  });

  it('round-trips a tile drillthrough through PUT (persists and returns it)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o', upn: 'u' } });
    (loadKustoItem as any).mockResolvedValue({ id: 'dash-1', workspaceId: 'w', itemType: 'kql-dashboard', displayName: 'D', state: {} });
    (saveItemState as any).mockImplementation(async (_item: any, patch: any) => ({ state: patch }));
    const body = {
      tiles: [{ title: 'T', kql: 'print 1', viz: 'table', drillthrough: { column: 'State', paramName: '_state' } }],
    };
    const res = await PUT(jsonReq(body), ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    const patch = (saveItemState as any).mock.calls[0][1];
    expect(patch.tiles[0].drillthrough).toEqual({ column: 'State', paramName: '_state' });
    expect(j.tiles[0].drillthrough).toEqual({ column: 'State', paramName: '_state' });
  });

  it('strips a partial (column-only) drillthrough on PUT', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o', upn: 'u' } });
    (loadKustoItem as any).mockResolvedValue({ id: 'dash-1', workspaceId: 'w', itemType: 'kql-dashboard', displayName: 'D', state: {} });
    (saveItemState as any).mockImplementation(async (_item: any, patch: any) => ({ state: patch }));
    const body = {
      tiles: [{ title: 'T', kql: 'print 1', viz: 'table', drillthrough: { column: 'State', paramName: '' } }],
    };
    await PUT(jsonReq(body), ctx);
    const patch = (saveItemState as any).mock.calls[0][1];
    expect(patch.tiles[0].drillthrough).toBeUndefined();
  });
});

describe('POST /api/items/kql-dashboard/[id]/run', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await RUN(jsonReq({ tiles: [{ title: 'T', kql: 'print 1', viz: 'table' }] }), ctx);
    expect(res.status).toBe(401);
  });

  it('400 when there are no tiles', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o', upn: 'u' } });
    const res = await RUN(jsonReq({ tiles: [] }), ctx);
    expect(res.status).toBe(400);
  });

  it('runs a transient (unsaved /new) model without a Cosmos record', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o', upn: 'u' } });
    const body = {
      tiles: [{ title: 'T', kql: 'T | where ts > _startTime and State == _s', viz: 'column' }],
      parameters: [{ variableName: '_s', type: 'freetext', dataType: 'string', value: 'CA' }],
      timeRange: 'last-1h',
    };
    const res = await RUN(jsonReq(body), ctxNew);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.tiles[0].result).toEqual(RESULT);
    expect(loadKustoItem).not.toHaveBeenCalled(); // /new short-circuits the Cosmos read
    const [, executedKql] = (executeQuery as any).mock.calls[0];
    expect(executedKql).toContain('ago(1h)');
    expect(executedKql).toContain('State == "CA"');
  });

  it('returns a per-tile error instead of failing the whole run', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o', upn: 'u' } });
    (executeQuery as any).mockRejectedValueOnce(new Error('Semantic error: bad column'));
    const res = await RUN(jsonReq({ tiles: [{ title: 'Bad', kql: 'print x', viz: 'table' }] }), ctxNew);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.tiles[0].error).toContain('Semantic error');
    expect(j.tiles[0].result).toBeUndefined();
  });

  it('inlines a $baseQuery() reference into the executed tile KQL', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o', upn: 'u' } });
    const body = {
      tiles: [{ title: 'T', kql: `$baseQuery('Filtered') | where ts > _startTime | count`, viz: 'stat' }],
      baseQueries: [{ id: 'bq1', name: 'Filtered', kql: 'StormEvents | where State == "Texas"' }],
      timeRange: 'last-1h',
    };
    const res = await RUN(jsonReq(body), ctxNew);
    const j = await res.json();
    expect(j.ok).toBe(true);
    const [, executedKql] = (executeQuery as any).mock.calls[0];
    expect(executedKql).toContain('(StormEvents | where State == "Texas")');
    expect(executedKql).toContain('ago(1h)');
    expect(executedKql).not.toContain('$baseQuery');
  });
});

describe('POST /api/items/kql-dashboard/[id]/param-values', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await PARAM_VALUES(jsonReq({ query: 'T | distinct x' }), ctx);
    expect(res.status).toBe(401);
  });

  it('400 when query missing', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o', upn: 'u' } });
    const res = await PARAM_VALUES(jsonReq({}), ctx);
    expect(res.status).toBe(400);
  });

  it('returns distinct first-column values from the real query', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o', upn: 'u' } });
    (executeQuery as any).mockResolvedValue({ columns: ['State'], rows: [['CA'], ['TX'], ['CA']], rowCount: 3, executionMs: 2, truncated: false, columnTypes: ['string'] });
    const res = await PARAM_VALUES(jsonReq({ query: 'StormEvents | distinct State' }), ctxNew);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.values).toEqual(['CA', 'TX']);
  });

  it('502 with structured error when the param query throws', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o', upn: 'u' } });
    (executeQuery as any).mockRejectedValue(new Error('boom'));
    const res = await PARAM_VALUES(jsonReq({ query: 'bad' }), ctxNew);
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toContain('boom');
  });
});
