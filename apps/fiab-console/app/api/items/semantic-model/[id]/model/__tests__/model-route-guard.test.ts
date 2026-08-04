/**
 * #2941 — route-wiring tests for /api/items/semantic-model/[id]/model.
 *
 * The guard's own behaviour is proven in
 * `lib/auth/__tests__/authorize-item-workspace.test.ts`. THIS file proves the
 * four handlers ADOPT it correctly — which is the half of the fix that a future
 * edit is most likely to get wrong:
 *
 *   - all four call `authorizeItemWorkspace` (not `assertOwner`) and pass the
 *     route id + 'semantic-model' so the guard can resolve the workspace when
 *     `?workspaceId=` is absent;
 *   - GET (a read) passes `allowReadRoles: true`;
 *   - POST / PUT / DELETE (mutations) do NOT — a read-only Viewer who may open
 *     the model must not be able to author relationships, toggle them, or delete
 *     them. Making the read work by loosening the write guard would be a
 *     regression, not a fix;
 *   - a denial short-circuits the handler: no model context is loaded and no
 *     state is written.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/workspace-guard', () => ({
  authorizeItemWorkspace: vi.fn(async () => null),
}));
vi.mock('@/lib/azure/powerbi-client', () => ({
  getDataset: vi.fn(async () => null),
  listDatasetTables: vi.fn(async () => []),
  listDatasetRelationships: vi.fn(async () => []),
  executeDatasetQueries: vi.fn(),
  PowerBiError: class PowerBiError extends Error { status = 502; },
}));
vi.mock('@/lib/semantic-model/model-context', () => ({
  loadModelContext: vi.fn(async () => ({ modelName: 'M', tables: [], baseRels: [], liveDataset: false })),
  columnIndexOf: () => new Set<string>(),
  mergeRelationships: () => [],
  buildPreview: () => '',
  storedToCanvas: (r: any) => r,
  backendAvailability: () => ({}),
  writeBackendRelationship: vi.fn(async () => null),
  writeBackendHierarchy: vi.fn(async () => null),
}));
vi.mock('../../../../_lib/semantic-model-store', () => ({
  readSmModelState: vi.fn(async () => ({ relationships: [], hierarchies: [] })),
  writeSmModelState: vi.fn(async () => undefined),
  normalizeSmRelationship: (r: any) => ({ id: 'r1', name: 'r1', ...r }),
  normalizeSmHierarchy: (h: any) => ({ id: 'h1', name: 'h1', table: 't', levels: [], ...h }),
  upsertSmRelationship: (s: any) => s,
  removeSmRelationship: (s: any) => s,
  upsertSmHierarchy: (s: any) => s,
  removeSmHierarchy: (s: any) => s,
}));
vi.mock('@/lib/semantic-model/calc-objects', () => ({
  backendName: () => 'loom',
  loadCalcObjects: vi.fn(async () => ({ calculationGroups: [], fieldParameters: [], backend: 'loom' })),
  handleCalcPost: vi.fn(),
}));
vi.mock('@/lib/semantic-model/aggregations', () => ({ handleAggregationPost: vi.fn() }));
vi.mock('@/lib/semantic-model/plan-metrics', () => ({ handlePlanMetricsPost: vi.fn() }));
vi.mock('@/lib/semantic-model/modeling-objects', () => ({
  readLoomModelState: vi.fn(async () => ({ state: {} })),
  handleWhatIfPost: vi.fn(), handleCalculatedTablePost: vi.fn(),
  handleDateTableMarkPost: vi.fn(), handleMeasurePost: vi.fn(),
}));
vi.mock('@/lib/semantic-model/xmla-writes', () => ({ handleMeasurePut: vi.fn(), handleColumnPatch: vi.fn() }));
vi.mock('@/lib/azure/query-cache', () => ({ withQueryCache: async (_t: any, _k: any, _ms: any, fn: any) => fn() }));

import { GET, POST, PUT, DELETE } from '../route';
import { getSession } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { loadModelContext } from '@/lib/semantic-model/model-context';
import { writeSmModelState } from '../../../../_lib/semantic-model-store';

const ID = 'sm-1';
const ctx = { params: Promise.resolve({ id: ID }) };
const req = (qs = '', body: any = {}) =>
  ({ nextUrl: new URL(`http://x/api/items/semantic-model/${ID}/model${qs}`), json: async () => body }) as any;

const guard = authorizeItemWorkspace as any;
const lastGuardOpts = () => guard.mock.calls.at(-1)[1];

beforeEach(() => {
  vi.clearAllMocks();
  guard.mockResolvedValue(null);
  (getSession as any).mockReturnValue({ claims: { oid: 'oid-1', tid: 'tid-1' } });
  (loadModelContext as any).mockResolvedValue({ modelName: 'M', tables: [], baseRels: [], liveDataset: false });
});

describe('#2941 every handler adopts authorizeItemWorkspace with the item identity', () => {
  const cases: Array<[string, () => Promise<any>]> = [
    ['GET', () => GET(req('?workspaceId=ws-1'), ctx)],
    ['POST', () => POST(req('?workspaceId=ws-1', { relationship: { fromTable: 'a', fromColumn: 'b', toTable: 'c', toColumn: 'd' } }), ctx)],
    ['PUT', () => PUT(req('?workspaceId=ws-1', { relId: 'r1' }), ctx)],
    ['DELETE', () => DELETE(req('?workspaceId=ws-1&relId=r1'), ctx)],
  ];

  for (const [name, call] of cases) {
    it(`${name} passes the route id + itemType so the guard can resolve the workspace itself`, async () => {
      await call();
      expect(guard).toHaveBeenCalledTimes(1);
      const opts = lastGuardOpts();
      expect(opts.itemId).toBe(ID);
      expect(opts.itemType).toBe('semantic-model');
      expect(opts.notFound).toBe('semantic model not found');
      expect(opts.workspaceId).toBe('ws-1');
    });

    it(`${name} still invokes the guard when ?workspaceId= is ABSENT (unskippable)`, async () => {
      guard.mockClear();
      await (name === 'DELETE'
        ? DELETE(req('?relId=r1'), ctx)
        : name === 'PUT'
          ? PUT(req('', { relId: 'r1' }), ctx)
          : name === 'POST'
            ? POST(req('', { relationship: { fromTable: 'a', fromColumn: 'b', toTable: 'c', toColumn: 'd' } }), ctx)
            : GET(req(''), ctx));
      expect(guard).toHaveBeenCalledTimes(1);
      expect(lastGuardOpts().itemId).toBe(ID);
    });
  }
});

describe('#2941 the READ/WRITE split — a Viewer who may GET must not be able to mutate', () => {
  it('GET opts into read roles', async () => {
    await GET(req('?workspaceId=ws-1'), ctx);
    expect(lastGuardOpts().allowReadRoles).toBe(true);
  });

  it('POST does NOT opt into read roles', async () => {
    await POST(req('?workspaceId=ws-1', { relationship: { fromTable: 'a', fromColumn: 'b', toTable: 'c', toColumn: 'd' } }), ctx);
    expect(lastGuardOpts().allowReadRoles).toBeFalsy();
  });

  it('PUT does NOT opt into read roles', async () => {
    await PUT(req('?workspaceId=ws-1', { relId: 'r1' }), ctx);
    expect(lastGuardOpts().allowReadRoles).toBeFalsy();
  });

  it('DELETE does NOT opt into read roles', async () => {
    await DELETE(req('?workspaceId=ws-1&relId=r1'), ctx);
    expect(lastGuardOpts().allowReadRoles).toBeFalsy();
  });
});

describe('#2941 a denial short-circuits the handler', () => {
  const denial = () =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: false, error: 'semantic model not found' }), { status: 404 }) as any,
    );

  it('GET returns the guard 404 and loads no model context', async () => {
    guard.mockImplementation(denial);
    const res = await GET(req('?workspaceId=ws-1'), ctx);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'semantic model not found' });
    expect(loadModelContext).not.toHaveBeenCalled();
  });

  it('POST returns the guard 404 and writes no state', async () => {
    guard.mockImplementation(denial);
    const res = await POST(req('?workspaceId=ws-1', { relationship: { fromTable: 'a', fromColumn: 'b', toTable: 'c', toColumn: 'd' } }), ctx);
    expect(res.status).toBe(404);
    expect(writeSmModelState).not.toHaveBeenCalled();
  });

  it('DELETE returns the guard 404 and writes no state', async () => {
    guard.mockImplementation(denial);
    const res = await DELETE(req('?workspaceId=ws-1&relId=r1'), ctx);
    expect(res.status).toBe(404);
    expect(writeSmModelState).not.toHaveBeenCalled();
  });
});

describe('#2941 the pre-existing 401 / new-item paths are unchanged', () => {
  it('401 without a session, before the guard runs', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET(req('?workspaceId=ws-1'), ctx);
    expect(res.status).toBe(401);
    expect(guard).not.toHaveBeenCalled();
  });

  it("GET id='new' still returns the empty scaffold without touching the guard", async () => {
    const res = await GET(req('?workspaceId=ws-1'), { params: Promise.resolve({ id: 'new' }) });
    expect(res.status).toBe(200);
    expect(guard).not.toHaveBeenCalled();
  });
});
