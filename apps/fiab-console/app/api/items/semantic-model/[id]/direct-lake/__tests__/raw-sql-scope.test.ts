/**
 * `POST /api/items/semantic-model/[id]/direct-lake`, raw-SQL branch (#4619): the
 * caller is authorized on the semantic-model ITEM (write-scoped `loadOwnedItem`),
 * and a caller who is not a tenant admin runs only classifier-accepted text over
 * the lakehouses of the model's own workspace, in `master`, on this path's own
 * pool (`direct-lake-reader:`), with a `USE [master];` prefix. A tenant admin's
 * SQL runs unchanged. The TABLE branch is not touched.
 *
 * Each test names the change that turns it red in its label or at the site:
 *   - non-owner / invented id: the `loadOwnedItem` check removed (200, one run).
 *   - out-of-root: the confinement skipped for non-admins (200), applied to the
 *     first location only, or worded for another surface.
 *   - in-root: the shared `k:master` pool, a different pool prefix, or the bare
 *     text (prefix dropped) sent for a non-admin; the USE message not filtered.
 *   - USE / sys / DDL: the classifier skipped for non-admins.
 *   - admin: the classifier, the prefix or the reader pool applied to admins.
 *   - table branch: the item lookup or the reader target leaking into it.
 *
 * The cosmos mock answers the lakehouse listing only for the partition of the
 * model's own workspace (`ws-1`), so a route that listed another workspace (for
 * example the body's Power BI `workspaceId`) would find no lakehouse and refuse
 * the in-root query.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SESSION = { claims: { oid: 'oid-owner', tid: 'tid-1', upn: 'o@loom.test', groups: [] } } as any;
vi.mock('@/lib/auth/session', async () => ({
  ...(await vi.importActual<any>('@/lib/auth/session')),
  getSession: () => SESSION,
}));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async (..._a: any[]) => null as any) }));
vi.mock('@/lib/auth/workspace-guard', async () => ({
  ...(await vi.importActual<any>('@/lib/auth/workspace-guard')),
  authorizeItemWorkspace: guard.authorizeItemWorkspace,
}));

const crud = vi.hoisted(() => ({ loadOwnedItem: vi.fn(async (..._a: any[]) => null as any) }));
vi.mock('@/app/api/items/_lib/item-crud', () => ({ loadOwnedItem: crud.loadOwnedItem }));

const admin = vi.hoisted(() => ({ isTenantAdmin: vi.fn(() => false) }));
vi.mock('@/lib/auth/feature-gate', async () => ({
  ...(await vi.importActual<any>('@/lib/auth/feature-gate')),
  isTenantAdmin: admin.isTenantAdmin,
}));

const db = vi.hoisted(() => ({
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
          return { resources: [] };
        },
      }),
    },
  }),
  workspacesContainer: async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } }),
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
  serverlessTarget: vi.fn((database = 'master') => ({ server: 's', database, cacheKey: `k:${database}` })),
  getSynapseSqlSuffix: () => 'sql.azuresynapse.net',
  buildDeltaOpenRowsetSql: vi.fn(() => 'SELECT-DELTA-TABLE'),
  goldDeltaBulkUrl: vi.fn(() => 'https://acct1.dfs.core.windows.net/gold/T'),
}));
vi.mock('@/lib/azure/synapse-sql-client', () => synapse);

vi.mock('@/lib/azure/powerbi-client', () => ({
  listRefreshHistory: vi.fn(async () => []),
  executeDatasetQueries: vi.fn(async () => ({ results: [] })),
}));
vi.mock('@/lib/azure/aas-client', () => ({
  listShimRefreshHistory: vi.fn(async () => []),
  shimEnabled: () => true,
  SHIM_DISABLED_HINT: 'hint',
  AasError: class AasError extends Error {},
}));
vi.mock('@/lib/azure/direct-lake-config-store', () => ({
  getShimConfig: vi.fn(async () => null),
  upsertShimConfig: vi.fn(async (c: any) => c),
  SHIM_REFRESH_POLICIES: ['Partition', 'Full'],
}));
vi.mock('@/lib/azure/eventgrid-client', () => ({
  ensureShimSubscription: vi.fn(async () => ({ ok: true })),
  getShimSubscriptionStatus: vi.fn(async () => null),
  parseDeltaSource: () => ({ account: 'acct', container: 'c', path: 'p' }),
  toAbfss: () => 'abfss://c@acct.dfs.core.windows.net/p',
  EventGridError: class EventGridError extends Error {},
}));
vi.mock('@/lib/azure/columnar-cache-query', () => ({
  columnarCacheBackendSelected: () => false,
  columnarCacheQuery: vi.fn(),
  resolveFrame: vi.fn(),
}));

import { POST } from '../route';
// Lifted, not transcribed: the refusal must carry THIS surface's lead and place.
import { DIRECT_LAKE_SQL_SURFACE } from '../../../_lib/direct-lake-scope';

const MODEL: any = { id: 'sm-1', itemType: 'semantic-model', workspaceId: 'ws-1', displayName: 'M', state: {} };

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

function ctx(id = 'sm-1') {
  return { params: Promise.resolve({ id }) } as any;
}
function req(body: any = {}) {
  const url = new URL('http://x/api/items/semantic-model/sm-1/direct-lake');
  return { url: url.toString(), nextUrl: url, json: async () => body } as any;
}
function bulk(url: string) {
  return `SELECT TOP 10 * FROM OPENROWSET(BULK '${url}', FORMAT='DELTA') AS r`;
}
function ranAnything() {
  return synapse.executeQuery.mock.calls.length;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.lakehouses = [{ id: 'lh-1' }, { id: 'lh-2' }];
  db.listThrows = false;
  db.listPartitions = [];
  admin.isTenantAdmin.mockReturnValue(false);
  guard.authorizeItemWorkspace.mockResolvedValue(null as any);
  crud.loadOwnedItem.mockResolvedValue({ ...MODEL });
  storage.resolveLakehouseStorage.mockImplementation(async (id: string) => ROOTS[id] ?? { ok: false, reason: 'not-found' });
  vi.stubEnv('LOOM_SYNAPSE_WORKSPACE', 'loomsyn');
});

describe('item authorization for a model\'s own SQL', () => {
  it('a caller the write-scoped lookup refuses gets 404 and nothing runs (breaks if the loadOwnedItem check is skipped)', async () => {
    crud.loadOwnedItem.mockResolvedValue(null);
    const res = await POST(req({ sql: bulk(IN_SECOND) }), ctx());
    expect(res.status).toBe(404);
    expect(ranAnything()).toBe(0);
    expect(storage.resolveLakehouseStorage).not.toHaveBeenCalled();
    // The lookup names THIS id and type, without read roles.
    expect(crud.loadOwnedItem.mock.calls[0].slice(0, 3)).toEqual(['sm-1', 'semantic-model', 'oid-owner']);
    expect(crud.loadOwnedItem.mock.calls[0][3]).not.toHaveProperty('allowReadRoles');
  });

  it('a caller the item guard denies gets its status and nothing runs, before any item lookup', async () => {
    guard.authorizeItemWorkspace.mockResolvedValue(
      Response.json({ ok: false, error: 'semantic model not found' }, { status: 404 }) as any,
    );
    const res = await POST(req({ sql: 'SELECT 1 AS a' }), ctx());
    expect(res.status).toBe(404);
    expect(ranAnything()).toBe(0);
    expect(crud.loadOwnedItem).not.toHaveBeenCalled();
    expect(guard.authorizeItemWorkspace.mock.calls[0][1]).toMatchObject({ itemId: 'sm-1', itemType: 'semantic-model' });
  });
});

describe('a caller who is not a tenant admin', () => {
  it('a location outside every lakehouse root of the model\'s workspace is a 403 in Direct Lake wording, and nothing runs', async () => {
    const res = await POST(req({ sql: bulk(OUT) }), ctx());
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j).toMatchObject({ ok: false, code: 'query_location_outside_root', construct: OUT });
    // Breaks if the route passes the SQL pool editor's surface (its lead is "This editor …").
    expect(j.error.startsWith(DIRECT_LAKE_SQL_SURFACE.lead)).toBe(true);
    // Breaks if the shared reason words the place as a literal instead of `surface.place`.
    expect(j.error).toContain(`that ${DIRECT_LAKE_SQL_SURFACE.place} could confirm`);
    expect(j.remediation).toContain(LH1.abfss);
    expect(j.remediation).toContain(LH2.abfss);
    expect(ranAnything()).toBe(0);
  });

  it('every location is confined, not only the first', async () => {
    const sql = `SELECT * FROM OPENROWSET(BULK ('${IN_SECOND}/a.parquet', '${OUT}/b.parquet'), FORMAT='PARQUET') AS r`;
    const res = await POST(req({ sql }), ctx());
    expect(res.status).toBe(403);
    expect((await res.json()).construct).toBe(`${OUT}/b.parquet`);
    expect(ranAnything()).toBe(0);
  });

  it('a location under the SECOND lakehouse runs in master on the Direct Lake reader pool with the prefix', async () => {
    const sql = bulk(IN_SECOND);
    const res = await POST(req({ sql, workspaceId: 'pbi-ws' }), ctx());
    expect(res.status).toBe(200);
    expect(synapse.executeQuery).toHaveBeenCalledTimes(1);
    const [target, batch] = synapse.executeQuery.mock.calls[0];
    expect(target.database).toBe('master');
    // 'k:master' is the shared admin/table pool; 'lakehouse-reader:k:master' the SQL tab's.
    expect(target.cacheKey).toBe('direct-lake-reader:k:master');
    // The bare text means the prefix was dropped.
    expect(batch).toBe(`USE [master]; ${sql}`);
    const j = await res.json();
    expect(j.ok).toBe(true);
    // The route's own USE message is dropped; the caller's own message stays.
    expect(j.messages).toEqual(['(1 row affected)']);
  });

  it('roots come from the MODEL\'s workspace, not the body\'s Power BI workspaceId', async () => {
    await POST(req({ sql: bulk(IN_SECOND), workspaceId: 'pbi-ws' }), ctx());
    expect(db.listPartitions).toEqual(['ws-1']);
    expect(storage.resolveLakehouseStorage.mock.calls.map((c: any[]) => c.join('|')).sort()).toEqual([
      'lh-1|ws-1', 'lh-2|ws-1',
    ]);
  });

  it('USE is refused before anything runs', async () => {
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
    const j = await res.json();
    expect(j).toMatchObject({ code: 'query_construct_not_accepted', construct: 'the sys schema object sys.databases' });
    expect(j.error.startsWith(DIRECT_LAKE_SQL_SURFACE.lead)).toBe(true);
    expect(ranAnything()).toBe(0);
  });

  it('DDL is refused before anything runs', async () => {
    const res = await POST(req({ sql: 'CREATE VIEW v AS SELECT 1 AS a' }), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('query_construct_not_accepted');
    expect(ranAnything()).toBe(0);
  });

  it('an INFORMATION_SCHEMA query resolves no roots and runs on the reader pool', async () => {
    const res = await POST(req({ sql: 'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES' }), ctx());
    expect(res.status).toBe(200);
    expect(storage.resolveLakehouseStorage).not.toHaveBeenCalled();
    expect(synapse.executeQuery.mock.calls[0][0].cacheKey).toBe('direct-lake-reader:k:master');
  });

  it('no storage configured for any lakehouse is a 409, and nothing runs', async () => {
    storage.resolveLakehouseStorage.mockResolvedValue({ ok: false, reason: 'no-storage' });
    const res = await POST(req({ sql: bulk(IN_SECOND) }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('lakehouse_storage_unbound');
    expect(ranAnything()).toBe(0);
  });

  it('a lakehouse listing that fails is a 500 and nothing runs', async () => {
    db.listThrows = true;
    const res = await POST(req({ sql: bulk(IN_SECOND) }), ctx());
    expect(res.status).toBe(500);
    expect(ranAnything()).toBe(0);
  });
});

describe('a tenant admin', () => {
  it('runs SQL unchanged on the shared master target, DDL included (breaks if the classifier, prefix or reader pool applies)', async () => {
    admin.isTenantAdmin.mockReturnValue(true);
    const sql = 'CREATE VIEW v AS SELECT * FROM sys.tables';
    const res = await POST(req({ sql }), ctx());
    expect(res.status).toBe(200);
    const [target, batch] = synapse.executeQuery.mock.calls[0];
    expect(target.cacheKey).toBe('k:master');
    expect(batch).toBe(sql);
    expect(storage.resolveLakehouseStorage).not.toHaveBeenCalled();
    // The admin's messages are passed through untouched.
    expect((await res.json()).messages).toEqual(["Changed database context to 'master'.", '(1 row affected)']);
  });
});

describe('the TABLE branch', () => {
  it('is unchanged for a caller who is not a tenant admin: no item lookup, the shared target, the built SQL', async () => {
    const res = await POST(req({ table: 'FactSales' }), ctx());
    expect(res.status).toBe(200);
    expect(crud.loadOwnedItem).not.toHaveBeenCalled();
    const [target, batch] = synapse.executeQuery.mock.calls[0];
    // 'direct-lake-reader:k:master' here means the raw branch's target leaked into this one.
    expect(target.cacheKey).toBe('k:master');
    expect(batch).toBe('SELECT-DELTA-TABLE');
  });
});
