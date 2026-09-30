/**
 * `POST /api/items/synapse-serverless-sql-pool/[id]/cancel` — cancel is scoped
 * to the caller's own queries on the item.
 *
 * The query route registers a running query in the Synapse client's cancel
 * registry under (caller oid, item id, queryId); the cancel route authorizes the
 * caller on the item with the same guard, then looks up exactly that key. The
 * registry here is a stand-in with the real contract: `executeQuery` records its
 * `queryId` argument as in flight, and `cancelActiveQuery(key)` cancels and
 * returns true only for a key it holds. Both routes are the real handlers, so the
 * key each one builds is read from the code, not transcribed here.
 *
 * What breaks each case:
 *   - another caller's queryId: the oid dropped from the key (either side), so
 *     caller B's cancel finds caller A's query and returns 200.
 *   - another item's queryId: the item id dropped from the key.
 *   - guard denial: the guard removed or its answer discarded on cancel.
 *   - same caller + same item: the two routes building different keys, or the
 *     cancel not calling the registry at all (this is the positive half).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const who = vi.hoisted(() => ({ oid: 'oid-a' }));
vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({ claims: { oid: who.oid, tid: 'tid-1', upn: `${who.oid}@loom.test`, groups: [] } }),
  tenantScopeId: () => 'tid-1',
}));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async (..._a: any[]) => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);
vi.mock('@/lib/azure/rate-limiter', () => ({ enforceRateLimit: vi.fn(async () => null) }));
vi.mock('@/lib/auth/feature-gate', async () => ({
  ...(await vi.importActual<any>('@/lib/auth/feature-gate')),
  isTenantAdmin: () => false,
}));

const ITEMS: Record<string, any> = {
  'pool-1': { id: 'pool-1', itemType: 'synapse-serverless-sql-pool', workspaceId: 'ws-1', state: {} },
  'pool-2': { id: 'pool-2', itemType: 'synapse-serverless-sql-pool', workspaceId: 'ws-1', state: {} },
};
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const params: Record<string, unknown> = Object.fromEntries(
            (spec.parameters ?? []).map((p: any) => [p.name, p.value]),
          );
          const hit = ITEMS[String(params['@id'])];
          return { resources: hit && params['@t'] === hit.itemType ? [hit] : [] };
        },
      }),
    },
  }),
}));

/** The in-flight registry: the key each executeQuery was handed, serialized
 *  field by field so a key missing a field is a different entry. The real
 *  registry is driven directly in `lib/azure/__tests__/synapse-sql-cancel-registry.test.ts`. */
const inFlight = vi.hoisted(() => new Set<string>());
const ser = vi.hoisted(() => (k: any) => JSON.stringify([k?.family, k?.oid, k?.itemId, k?.queryId]));
const synapse = vi.hoisted(() => ({
  executeQuery: vi.fn(async (_t: any, _b: string, _ms?: number, _p?: any, key?: any) => {
    if (key) inFlight.add(ser(key)); // still running: the test cancels it
    return { columns: ['a'], rows: [[1]], rowCount: 1, executionMs: 1, truncated: false, messages: [] };
  }),
  executeQueryAsUser: vi.fn(),
  cancelActiveQuery: vi.fn((key: any) => inFlight.delete(ser(key))),
  serverlessTarget: vi.fn((database = 'master') => ({ server: 's', database, cacheKey: `k:${database}` })),
  serverlessEndpoint: () => 's.sql.azuresynapse.net',
  getSynapseSqlSuffix: () => 'sql.azuresynapse.net',
}));
vi.mock('@/lib/azure/synapse-sql-client', () => synapse);
vi.mock('@/lib/azure/sql-access-mode', () => ({ resolveAccessMode: vi.fn(async () => 'service') }));
vi.mock('@/lib/azure/sql-user-token-store', () => ({ getUserSqlToken: vi.fn(async () => null) }));
vi.mock('@/lib/finops/query-run', () => ({ recordQueryRun: vi.fn(async () => undefined) }));

import { POST as QUERY } from '../[id]/query/route';
import { POST as CANCEL } from '../[id]/cancel/route';

function ctx(id: string) {
  return { params: Promise.resolve({ id }) } as any;
}
function req(body: any) {
  const url = new URL('http://x/');
  return { url: url.toString(), nextUrl: url, json: async () => body } as any;
}
async function startAs(oid: string, itemId: string, queryId: string) {
  who.oid = oid;
  const res = await QUERY(req({ sql: 'SELECT 1 AS a', queryId }), ctx(itemId));
  expect(res.status).toBe(200);
}

beforeEach(() => {
  vi.clearAllMocks();
  inFlight.clear();
  who.oid = 'oid-a';
  guard.authorizeItemWorkspace.mockResolvedValue(null as any);
});

describe('serverless SQL pool cancel', () => {
  it('another caller\'s queryId on the same item is not cancelled: 404, and the query stays in flight', async () => {
    await startAs('oid-a', 'pool-1', 'q-1');
    expect(inFlight.size).toBe(1);
    who.oid = 'oid-b';
    const res = await CANCEL(req({ queryId: 'q-1' }), ctx('pool-1'));
    // 200 here means the key lost the caller's oid.
    expect(res.status).toBe(404);
    expect((await res.json())).toMatchObject({ ok: false, canceled: false, found: false });
    expect(inFlight.size).toBe(1);
  });

  it('the same caller\'s queryId on ANOTHER item is not cancelled (breaks if the key drops the item id)', async () => {
    await startAs('oid-a', 'pool-1', 'q-1');
    const res = await CANCEL(req({ queryId: 'q-1' }), ctx('pool-2'));
    expect(res.status).toBe(404);
    expect(inFlight.size).toBe(1);
  });

  it('the same caller on the same item cancels it (positive half: both routes build one key)', async () => {
    await startAs('oid-a', 'pool-1', 'q-1');
    const res = await CANCEL(req({ queryId: 'q-1' }), ctx('pool-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, canceled: true, found: true });
    expect(inFlight.size).toBe(0);
    // The key carries this family, the caller, the item and the queryId, not the bare queryId.
    const key = synapse.cancelActiveQuery.mock.calls[0][0];
    expect(key).toEqual({ family: 'serverless-sql-pool', oid: 'oid-a', itemId: 'pool-1', queryId: 'q-1' });
  });

  it('a caller the item guard refuses gets its 404 and the registry is not consulted (breaks if cancel skips the guard)', async () => {
    await startAs('oid-a', 'pool-1', 'q-1');
    guard.authorizeItemWorkspace.mockResolvedValue(
      Response.json({ ok: false, error: 'item not found' }, { status: 404 }) as any,
    );
    const res = await CANCEL(req({ queryId: 'q-1' }), ctx('pool-1'));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('item not found');
    expect(synapse.cancelActiveQuery).not.toHaveBeenCalled();
    expect(inFlight.size).toBe(1);
  });

  it('a missing queryId is a 400 after the guard, and nothing is cancelled', async () => {
    const res = await CANCEL(req({}), ctx('pool-1'));
    expect(res.status).toBe(400);
    expect(synapse.cancelActiveQuery).not.toHaveBeenCalled();
  });
});
