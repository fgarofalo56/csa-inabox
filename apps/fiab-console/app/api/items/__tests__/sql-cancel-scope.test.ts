/**
 * `POST /api/items/{synapse-dedicated-sql-pool,warehouse}/[id]/cancel`: cancel
 * is scoped to the caller's own queries on the item, the same way as the
 * serverless SQL pool cancel route
 * (`synapse-serverless-sql-pool/__tests__/cancel-scope.test.ts`).
 *
 * Each family's query route registers a running query in the Synapse client's
 * cancel registry under (family, caller oid, item id, queryId); its cancel route
 * authorizes the caller on the item with the same guard, then looks up exactly
 * that key. The registry here is the REAL one (`executeQuery` and
 * `cancelActiveQuery` from the client); only `mssql` is stood in, with a request
 * whose `query()` stays pending until `cancel()` is called. Both routes are the
 * real handlers, so the key each one builds is read from the code.
 *
 * Cross-family keys are pinned at the registry in
 * `lib/azure/__tests__/synapse-sql-cancel-registry.test.ts`: through the routes
 * the item guard already refuses an id of another item type.
 *
 * What breaks each case is named in its label.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const who = vi.hoisted(() => ({ oid: 'oid-a' as string | null }));
vi.mock('@/lib/auth/session', () => ({
  getSession: () =>
    who.oid ? { claims: { oid: who.oid, tid: 'tid-1', upn: `${who.oid}@loom.test`, groups: [] } } : null,
  tenantScopeId: () => 'tid-1',
}));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async (..._a: any[]) => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);
vi.mock('@/lib/azure/rate-limiter', () => ({ enforceRateLimit: vi.fn(async () => null) }));
vi.mock('@/lib/azure/synapse-pool-arm', () => ({ getPoolState: vi.fn(async () => ({ state: 'Online' })) }));
vi.mock('@/lib/azure/sql-access-mode', () => ({ resolveAccessMode: vi.fn(async () => 'service') }));
vi.mock('@/lib/azure/sql-user-token-store', () => ({ getUserSqlToken: vi.fn(async () => null) }));
vi.mock('@/lib/finops/query-run', () => ({ recordQueryRun: vi.fn(async () => undefined) }));

const ITEMS: Record<string, any> = {
  'dp-1': { id: 'dp-1', itemType: 'synapse-dedicated-sql-pool', workspaceId: 'ws-1', state: { database: 'dwh01' } },
  'dp-2': { id: 'dp-2', itemType: 'synapse-dedicated-sql-pool', workspaceId: 'ws-1', state: { database: 'dwh01' } },
  'wh-1': { id: 'wh-1', itemType: 'warehouse', workspaceId: 'ws-1', state: { database: 'dwh01' } },
  'wh-2': { id: 'wh-2', itemType: 'warehouse', workspaceId: 'ws-1', state: { database: 'dwh01' } },
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

const fake = vi.hoisted(() => {
  const requests: Array<{ cancelled: boolean }> = [];
  class FakeRequest {
    cancelled = false;
    private rejectRun: ((e: Error) => void) | null = null;
    on() { return this; }
    input() { return this; }
    query() {
      return new Promise((_resolve, reject) => { this.rejectRun = reject; });
    }
    cancel() {
      this.cancelled = true;
      this.rejectRun?.(new Error('Canceled.'));
    }
  }
  class ConnectionPool {
    connected = true;
    async connect() { return this; }
    on() { return this; }
    request() {
      const r = new FakeRequest();
      requests.push(r);
      return r;
    }
  }
  return { requests, ConnectionPool };
});
vi.mock('mssql', () => ({ default: { ConnectionPool: fake.ConnectionPool, NVarChar: () => 'nvarchar', MAX: -1 } }));
vi.mock('@/lib/azure/workspace-credential-factory', () => ({
  workspaceScopedCredential: () => ({
    getToken: async () => ({ token: 't', expiresOnTimestamp: Date.now() + 3_600_000 }),
  }),
}));
vi.mock('@/lib/azure/synapse-sql-client', async () => ({
  ...(await vi.importActual<any>('@/lib/azure/synapse-sql-client')),
  dedicatedTarget: () => ({ server: 'd', database: 'dwh01', cacheKey: 'cancel-scope:dwh01' }),
}));

import { POST as DEDICATED_QUERY } from '../synapse-dedicated-sql-pool/[id]/query/route';
import { POST as DEDICATED_CANCEL } from '../synapse-dedicated-sql-pool/[id]/cancel/route';
import { POST as WAREHOUSE_QUERY } from '../warehouse/[id]/query/route';
import { POST as WAREHOUSE_CANCEL } from '../warehouse/[id]/cancel/route';

function ctx(id: string) {
  return { params: Promise.resolve({ id }) } as any;
}
function req(body: any) {
  const url = new URL('http://x/');
  return { url: url.toString(), nextUrl: url, json: async () => body } as any;
}

beforeEach(() => {
  fake.requests.length = 0;
  who.oid = 'oid-a';
  guard.authorizeItemWorkspace.mockReset();
  guard.authorizeItemWorkspace.mockResolvedValue(null as any);
});

describe.each([
  ['synapse-dedicated-sql-pool', DEDICATED_QUERY, DEDICATED_CANCEL, 'dp-1', 'dp-2'],
  ['warehouse', WAREHOUSE_QUERY, WAREHOUSE_CANCEL, 'wh-1', 'wh-2'],
] as const)('%s cancel', (_family, QUERY, CANCEL, ITEM, OTHER_ITEM) => {
  /** Start a query as `oid` on `itemId`; it stays in flight until cancelled. */
  async function startAs(oid: string, itemId: string, queryId: string) {
    who.oid = oid;
    const before = fake.requests.length;
    const run = QUERY(req({ sql: 'SELECT 1 AS a', queryId }), ctx(itemId));
    await vi.waitFor(() => expect(fake.requests.length).toBe(before + 1));
    return { run, request: fake.requests[before] };
  }

  it('the same caller on the same item cancels it (positive half: both routes build one key)', async () => {
    const { run, request } = await startAs('oid-a', ITEM, 'q-1');
    const res = await CANCEL(req({ queryId: 'q-1' }), ctx(ITEM));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, canceled: true, found: true });
    expect(request.cancelled).toBe(true);
    await run;
  });

  it('another caller\'s queryId on the same item is not cancelled: 404, still in flight (breaks if either route drops the oid)', async () => {
    const { request } = await startAs('oid-a', ITEM, 'q-1');
    who.oid = 'oid-b';
    const res = await CANCEL(req({ queryId: 'q-1' }), ctx(ITEM));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, canceled: false, found: false });
    expect(request.cancelled).toBe(false);
    // Positive half: the owner can still cancel it.
    who.oid = 'oid-a';
    expect((await CANCEL(req({ queryId: 'q-1' }), ctx(ITEM))).status).toBe(200);
  });

  it('the same caller\'s queryId on ANOTHER item is not cancelled (breaks if either route drops the item id)', async () => {
    const { request } = await startAs('oid-a', ITEM, 'q-1');
    const res = await CANCEL(req({ queryId: 'q-1' }), ctx(OTHER_ITEM));
    expect(res.status).toBe(404);
    expect(request.cancelled).toBe(false);
    expect((await CANCEL(req({ queryId: 'q-1' }), ctx(ITEM))).status).toBe(200);
  });

  it('a caller the item guard refuses gets its 404 and nothing is cancelled (breaks if cancel skips the guard)', async () => {
    const { request } = await startAs('oid-a', ITEM, 'q-1');
    guard.authorizeItemWorkspace.mockResolvedValue(
      Response.json({ ok: false, error: 'item not found' }, { status: 404 }) as any,
    );
    const res = await CANCEL(req({ queryId: 'q-1' }), ctx(ITEM));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('item not found');
    expect(request.cancelled).toBe(false);
    // The guard is consulted for the route item, write-scoped like the query route.
    const opts = guard.authorizeItemWorkspace.mock.calls.at(-1)![1];
    expect(opts).toMatchObject({ itemId: ITEM });
    expect(opts.allowReadRoles).toBeUndefined();
    guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    expect((await CANCEL(req({ queryId: 'q-1' }), ctx(ITEM))).status).toBe(200);
  });

  it('an id naming no item of this type is a 404 (breaks if the item id is taken on trust)', async () => {
    const res = await CANCEL(req({ queryId: 'q-1' }), ctx('missing'));
    expect(res.status).toBe(404);
  });

  it('no session is a 401, and a missing queryId is a 400', async () => {
    who.oid = null;
    expect((await CANCEL(req({ queryId: 'q-1' }), ctx(ITEM))).status).toBe(401);
    who.oid = 'oid-a';
    expect((await CANCEL(req({}), ctx(ITEM))).status).toBe(400);
  });
});
