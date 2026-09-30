/**
 * `POST /api/items/synapse-serverless-sql-pool/[id]/query` — the caller is
 * authorized on the route item, and a caller who is not a tenant admin runs
 * only classifier-accepted text over the lakehouses of that item's workspace,
 * in `master`, on the editor's own pool, with a `USE [master];` prefix.
 *
 * Each test names the change that turns it red in its label or at the site:
 *   - non-member / tenancy denial: the guard removed, or a non-404 denial
 *     retried as another item type.
 *   - out-of-root: the confinement skipped, applied to the first location
 *     only, or fed a root the workspace does not own.
 *   - in-root: the database, pool key or prefix changed for a non-admin, or the
 *     request's `database` honoured for one.
 *   - USE / sys: the classifier skipped for non-admins.
 *   - admin: the classifier applied to tenant admins, or the admin's database
 *     replaced with `master`.
 *
 * The cosmos mock answers the guard's typed item lookup ONLY for the item's
 * own type, the way Cosmos does, and the lakehouse listing only for the
 * workspace partition it was asked for, so a route that listed another
 * workspace's lakehouses would find none and refuse the in-root query.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SESSION = { claims: { oid: 'oid-reader', tid: 'tid-1', upn: 'r@loom.test', groups: [] } } as any;
vi.mock('@/lib/auth/session', () => ({ getSession: () => SESSION, tenantScopeId: () => 'tid-1' }));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async (..._a: any[]) => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);
vi.mock('@/lib/azure/rate-limiter', () => ({ enforceRateLimit: vi.fn(async () => null) }));

const admin = vi.hoisted(() => ({ isTenantAdmin: vi.fn(() => false) }));
vi.mock('@/lib/auth/feature-gate', async () => ({
  ...(await vi.importActual<any>('@/lib/auth/feature-gate')),
  isTenantAdmin: admin.isTenantAdmin,
}));

const db = vi.hoisted(() => ({
  item: null as any,
  lakehouses: [] as Array<{ id: string }>,
  listThrows: false,
  listPartitions: [] as string[],
}));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (spec: any, opts?: any) => ({
        fetchAll: async () => {
          const params: Record<string, unknown> = Object.fromEntries(
            (spec.parameters ?? []).map((p: any) => [p.name, p.value]),
          );
          if (/c\.itemType = 'lakehouse'/.test(spec.query)) {
            if (db.listThrows) throw new Error('cosmos unavailable');
            db.listPartitions.push(opts?.partitionKey);
            const inWorkspace = opts?.partitionKey === 'ws-1' && params['@w'] === 'ws-1';
            return { resources: inWorkspace ? db.lakehouses : [] };
          }
          const hit = db.item && params['@id'] === db.item.id && params['@t'] === db.item.itemType;
          return { resources: hit ? [db.item] : [] };
        },
      }),
    },
  }),
}));

const storage = vi.hoisted(() => ({ resolveLakehouseStorage: vi.fn() }));
vi.mock('@/lib/azure/lakehouse-abfss', async () => ({
  ...(await vi.importActual<any>('@/lib/azure/lakehouse-abfss')),
  resolveLakehouseStorage: storage.resolveLakehouseStorage,
}));

const synapse = vi.hoisted(() => ({
  executeQuery: vi.fn(async (..._a: any[]) => ({
    columns: ['a'], rows: [[1]], rowCount: 1, executionMs: 4, truncated: false,
    messages: ["Changed database context to 'master'.", '(1 row affected)'],
  })),
  executeQueryAsUser: vi.fn(async (..._a: any[]) => ({
    columns: ['a'], rows: [[1]], rowCount: 1, executionMs: 4, truncated: false, messages: [],
  })),
  serverlessTarget: vi.fn((database = 'master') => ({ server: 's', database, cacheKey: `k:${database}` })),
  serverlessEndpoint: () => 's.sql.azuresynapse.net',
  getSynapseSqlSuffix: () => 'sql.azuresynapse.net',
}));
vi.mock('@/lib/azure/synapse-sql-client', () => synapse);

const access = vi.hoisted(() => ({ resolveAccessMode: vi.fn(async (..._a: any[]) => 'service') }));
vi.mock('@/lib/azure/sql-access-mode', () => access);
vi.mock('@/lib/azure/sql-user-token-store', () => ({ getUserSqlToken: vi.fn(async () => 'user-token') }));
vi.mock('@/lib/finops/query-run', () => ({ recordQueryRun: vi.fn(async () => undefined) }));

import { POST } from '../[id]/query/route';
// The SQL analytics endpoint's query route re-exports this POST; its editor posts there with its own id.
import { POST as ENDPOINT_POST } from '@/app/api/items/sql-analytics-endpoint/[id]/query/route';

const POOL: any = { id: 'pool-1', itemType: 'synapse-serverless-sql-pool', workspaceId: 'ws-1', displayName: 'P', state: {} };

const LH1 = { abfss: 'abfss://gold@acct1.dfs.core.windows.net/lakehouses/sales-1', container: 'gold', root: 'lakehouses/sales-1' };
const LH2 = { abfss: 'abfss://silver@acct1.dfs.core.windows.net/lakehouses/ops-2', container: 'silver', root: 'lakehouses/ops-2' };
const ROOTS: Record<string, any> = {
  'lh-1': { ok: true, bound: LH1 },
  'lh-2': { ok: true, bound: LH2 },
};

/** Under LH2, the SECOND listed lakehouse: a route that only checks the first root refuses it. */
const IN_SECOND = 'https://acct1.dfs.core.windows.net/silver/lakehouses/ops-2/Tables/orders';
/** Same account and container as LH1, a sibling root: inside no listed lakehouse. */
const OUT = 'https://acct1.dfs.core.windows.net/gold/lakehouses/other-9/Tables/orders';

function ctx(id = 'pool-1') {
  return { params: Promise.resolve({ id }) } as any;
}
function req(body: any = {}) {
  const url = new URL('http://x/');
  return { url: url.toString(), nextUrl: url, json: async () => body } as any;
}
function bulk(url: string) {
  return `SELECT TOP 10 * FROM OPENROWSET(BULK '${url}', FORMAT='DELTA') AS r`;
}
function ranAnything() {
  return synapse.executeQuery.mock.calls.length + synapse.executeQueryAsUser.mock.calls.length;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.item = { ...POOL };
  db.lakehouses = [{ id: 'lh-1' }, { id: 'lh-2' }];
  db.listThrows = false;
  db.listPartitions = [];
  admin.isTenantAdmin.mockReturnValue(false);
  guard.authorizeItemWorkspace.mockResolvedValue(null as any);
  access.resolveAccessMode.mockResolvedValue('service');
  storage.resolveLakehouseStorage.mockImplementation(async (id: string) => ROOTS[id] ?? { ok: false, reason: 'not-found' });
  process.env.LOOM_SYNAPSE_WORKSPACE = 'loomsyn';
});

describe('item authorization', () => {
  it('a caller the item guard denies gets its 404 and nothing runs (breaks if the guard is removed)', async () => {
    guard.authorizeItemWorkspace.mockResolvedValue(
      Response.json({ ok: false, error: 'item not found' }, { status: 404 }) as any,
    );
    const res = await POST(req({ sql: bulk(IN_SECOND) }), ctx());
    expect(res.status).toBe(404);
    expect(ranAnything()).toBe(0);
    expect(storage.resolveLakehouseStorage).not.toHaveBeenCalled();
    // The guard was asked about THIS id at read level; a changed role or id fails here.
    expect(guard.authorizeItemWorkspace.mock.calls[0][1]).toMatchObject({
      itemId: 'pool-1', itemType: 'synapse-serverless-sql-pool', allowReadRoles: true,
    });
  });

  it('a tenancy 403 is returned as it is, after ONE guard call (breaks if a non-404 is retried as another type)', async () => {
    guard.authorizeItemWorkspace.mockResolvedValue(
      Response.json({ ok: false, error: 'workspace belongs to another tenant' }, { status: 403 }) as any,
    );
    const res = await POST(req({ sql: 'SELECT 1', database: 'salesdb' }), ctx());
    expect(res.status).toBe(403);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledTimes(1);
    expect(ranAnything()).toBe(0);
  });

  it('an id naming no item is a 404 after every accepted type is tried, and nothing runs', async () => {
    db.item = null;
    const res = await POST(req({ sql: 'SELECT 1' }), ctx('missing'));
    expect(res.status).toBe(404);
    expect(guard.authorizeItemWorkspace.mock.calls.map((c: any[]) => c[1].itemType)).toEqual([
      'synapse-serverless-sql-pool', 'sql-analytics-endpoint', 'geo-dataset', 'geo-query',
    ]);
    expect(ranAnything()).toBe(0);
  });

  it('a SQL analytics endpoint id posted through its own route is accepted and confined (breaks if that type is not guarded: 404 for every caller)', async () => {
    db.item = { ...POOL, id: 'sae-1', itemType: 'sql-analytics-endpoint' };
    const sql = bulk(IN_SECOND);
    const res = await ENDPOINT_POST(req({ sql, database: 'salesdb' }), ctx('sae-1'));
    expect(res.status).toBe(200);
    expect(guard.authorizeItemWorkspace.mock.calls.map((c: any[]) => c[1].itemType)).toEqual([
      'synapse-serverless-sql-pool', 'sql-analytics-endpoint',
    ]);
    // The same non-admin rules apply: master, the editor pool, the prefix.
    const [target, batch] = synapse.executeQuery.mock.calls[0];
    expect(target.cacheKey).toBe('sql-pool-reader:k:master');
    expect(batch).toBe(`USE [master]; ${sql}`);
  });

  it('a SQL analytics endpoint id with an out-of-root location is refused and nothing runs', async () => {
    db.item = { ...POOL, id: 'sae-1', itemType: 'sql-analytics-endpoint' };
    const res = await ENDPOINT_POST(req({ sql: bulk(OUT) }), ctx('sae-1'));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('query_location_outside_root');
    expect(ranAnything()).toBe(0);
  });

  it('a geo-dataset id is accepted: the geo editors post here with their own id (breaks if only the pool type is guarded)', async () => {
    db.item = { ...POOL, id: 'geo-1', itemType: 'geo-dataset' };
    const res = await POST(req({ sql: 'SELECT 1 AS a' }), ctx('geo-1'));
    expect(res.status).toBe(200);
    expect(guard.authorizeItemWorkspace.mock.calls.map((c: any[]) => c[1].itemType)).toEqual([
      'synapse-serverless-sql-pool', 'sql-analytics-endpoint', 'geo-dataset',
    ]);
  });
});

describe('a caller who is not a tenant admin', () => {
  it('a location outside every lakehouse root in the workspace is a 403 naming it, and nothing runs', async () => {
    const res = await POST(req({ sql: bulk(OUT) }), ctx());
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j).toMatchObject({ ok: false, code: 'query_location_outside_root', construct: OUT });
    // The remediation names the roots this workspace does own.
    expect(j.remediation).toContain(LH1.abfss);
    expect(j.remediation).toContain(LH2.abfss);
    expect(ranAnything()).toBe(0);
  });

  it('every location is confined, not only the first (breaks if the loop stops at locations[0])', async () => {
    const sql = `SELECT * FROM OPENROWSET(BULK ('${IN_SECOND}/a.parquet', '${OUT}/b.parquet'), FORMAT='PARQUET') AS r`;
    const res = await POST(req({ sql }), ctx());
    expect(res.status).toBe(403);
    expect((await res.json()).construct).toBe(`${OUT}/b.parquet`);
    expect(ranAnything()).toBe(0);
  });

  it('a location under the SECOND lakehouse runs in master on the editor pool with the prefix; the request database is ignored', async () => {
    const sql = bulk(IN_SECOND);
    const res = await POST(req({ sql, database: 'salesdb' }), ctx());
    expect(res.status).toBe(200);
    expect(synapse.executeQuery).toHaveBeenCalledTimes(1);
    const [target, batch, , params] = synapse.executeQuery.mock.calls[0];
    // 'salesdb' here means the body database was honoured.
    expect(target.database).toBe('master');
    // 'k:master' means the shared pool; 'lakehouse-reader:k:master' means the SQL tab's pool.
    expect(target.cacheKey).toBe('sql-pool-reader:k:master');
    // The bare text means the prefix was dropped.
    expect(batch).toBe(`USE [master]; ${sql}`);
    expect(params).toEqual([]);
    expect(synapse.serverlessTarget.mock.calls.map((c: any[]) => c[0])).toEqual(['master']);
    const j = await res.json();
    expect(j.database).toBe('master');
    // The route's own USE message is dropped; the caller's own message stays.
    expect(j.messages).toEqual(['(1 row affected)']);
  });

  it('roots are resolved for the lakehouses of the ITEM\'s workspace, listed in that partition', async () => {
    await POST(req({ sql: bulk(IN_SECOND) }), ctx());
    expect(db.listPartitions).toEqual(['ws-1']);
    expect(storage.resolveLakehouseStorage.mock.calls.map((c: any[]) => c.join('|')).sort()).toEqual([
      'lh-1|ws-1', 'lh-2|ws-1',
    ]);
  });

  it('USE is refused before anything runs (breaks if the classifier is skipped)', async () => {
    const res = await POST(req({ sql: 'USE [salesdb]; SELECT 1' }), ctx());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false, code: 'query_construct_not_accepted', construct: 'a statement starting with USE',
    });
    expect(ranAnything()).toBe(0);
  });

  it('a sys catalog reference is refused before anything runs', async () => {
    const res = await POST(req({ sql: 'SELECT name FROM sys.databases' }), ctx());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'query_construct_not_accepted', construct: 'the sys schema object sys.databases',
    });
    expect(ranAnything()).toBe(0);
  });

  it('the refusal speaks for this editor, not the lakehouse SQL tab', async () => {
    const res = await POST(req({ sql: 'SELECT name FROM sys.databases' }), ctx());
    const j = await res.json();
    // Four editors share this handler, so the lead names none of them.
    expect(j.error.startsWith('This editor runs read-only SELECT queries')).toBe(true);
    expect(j.error).not.toContain('SQL tab');
  });

  it('named parameters are not bound (breaks if body.parameters reaches a non-admin batch)', async () => {
    await POST(req({ sql: 'SELECT 1 AS a', parameters: [{ name: 'p', value: 'x' }] }), ctx());
    expect(synapse.executeQuery).toHaveBeenCalledTimes(1);
    expect(synapse.executeQuery.mock.calls[0][3]).toEqual([]);
  });

  it('a lakehouse whose root cannot be confirmed contributes no root, and the reason says so', async () => {
    storage.resolveLakehouseStorage.mockImplementation(async (id: string) =>
      id === 'lh-2' ? { ok: false, reason: 'root-shared' } : ROOTS[id]);
    const res = await POST(req({ sql: bulk(IN_SECOND) }), ctx());
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.error).toContain('1 lakehouse in this workspace could not be confirmed');
    expect(j.remediation).toContain(LH1.abfss);
    expect(j.remediation).not.toContain(LH2.abfss);
    expect(ranAnything()).toBe(0);
  });

  it('a resolve that throws contributes no root, and another lakehouse still confines', async () => {
    storage.resolveLakehouseStorage.mockImplementation(async (id: string) => {
      if (id === 'lh-1') throw new Error('storage unreachable');
      return ROOTS[id];
    });
    const res = await POST(req({ sql: bulk(IN_SECOND) }), ctx());
    expect(res.status).toBe(200);
  });

  it('no storage configured for any lakehouse is a 409 naming the deploy setting, and nothing runs', async () => {
    storage.resolveLakehouseStorage.mockResolvedValue({ ok: false, reason: 'no-storage' });
    const res = await POST(req({ sql: bulk(IN_SECOND) }), ctx());
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.code).toBe('lakehouse_storage_unbound');
    expect(j.remediation).toContain('LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL');
    expect(ranAnything()).toBe(0);
  });

  it('a lakehouse listing that fails is a 500 and nothing runs (breaks if a failed listing is read as a pass)', async () => {
    db.listThrows = true;
    const res = await POST(req({ sql: bulk(IN_SECOND) }), ctx());
    expect(res.status).toBe(500);
    expect(ranAnything()).toBe(0);
  });

  it('a metadata query resolves no roots and runs', async () => {
    const res = await POST(req({ sql: 'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES' }), ctx());
    expect(res.status).toBe(200);
    expect(storage.resolveLakehouseStorage).not.toHaveBeenCalled();
    expect(db.listPartitions).toEqual([]);
  });

  it('in user identity mode the same target and prefixed batch are used (breaks if that branch sends raw text)', async () => {
    access.resolveAccessMode.mockResolvedValue('user');
    const sql = bulk(IN_SECOND);
    const res = await POST(req({ sql, database: 'salesdb' }), ctx());
    expect(res.status).toBe(200);
    expect(synapse.executeQuery).not.toHaveBeenCalled();
    const [target, batch] = synapse.executeQueryAsUser.mock.calls[0];
    expect(target.cacheKey).toBe('sql-pool-reader:k:master');
    expect(batch).toBe(`USE [master]; ${sql}`);
  });

  it('in user identity mode a refused query still runs nothing', async () => {
    access.resolveAccessMode.mockResolvedValue('user');
    const res = await POST(req({ sql: 'USE [salesdb]; SELECT 1' }), ctx());
    expect(res.status).toBe(400);
    expect(ranAnything()).toBe(0);
  });
});

describe('a tenant admin', () => {
  it('runs unrestricted SQL, unchanged, in the requested database (breaks if the classifier or master applies)', async () => {
    admin.isTenantAdmin.mockReturnValue(true);
    const sql = 'USE [salesdb]; SELECT * FROM sys.tables';
    const res = await POST(req({ sql, database: 'salesdb' }), ctx());
    expect(res.status).toBe(200);
    const [target, batch] = synapse.executeQuery.mock.calls[0];
    expect(target.database).toBe('salesdb');
    expect(target.cacheKey).toBe('k:salesdb');
    expect(batch).toBe(sql);
    expect(storage.resolveLakehouseStorage).not.toHaveBeenCalled();
    const j = await res.json();
    expect(j.database).toBe('salesdb');
    // The admin's messages are passed through untouched.
    expect(j.messages).toEqual(["Changed database context to 'master'.", '(1 row affected)']);
  });

  it('binds named parameters', async () => {
    admin.isTenantAdmin.mockReturnValue(true);
    await POST(req({ sql: 'SELECT @p AS a', parameters: [{ name: 'p', value: 7 }] }), ctx());
    expect(synapse.executeQuery.mock.calls[0][3]).toEqual([{ name: 'p', value: '7' }]);
  });

  it('defaults to master when no database is named', async () => {
    admin.isTenantAdmin.mockReturnValue(true);
    await POST(req({ sql: 'SELECT 1' }), ctx());
    expect(synapse.executeQuery.mock.calls[0][0].cacheKey).toBe('k:master');
  });
});
