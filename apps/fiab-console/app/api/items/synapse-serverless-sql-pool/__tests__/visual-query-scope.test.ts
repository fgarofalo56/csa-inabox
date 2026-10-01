/**
 * `POST /api/items/[type]/[id]/visual-query` for `synapse-serverless-sql-pool`:
 * the generated SQL gets the same item scope as the serverless SQL pool query
 * route. The caller is authorized on the route item; a caller who is not a
 * tenant admin runs only classifier-accepted text, confined to the lakehouse
 * roots of the item's workspace, in `master` on the SQL pool editor's pool with
 * the `USE [master];` prefix. A tenant admin is unchanged.
 *
 * The expected SQL is compiled here with the route's own compiler rather than
 * transcribed, so a compiler change cannot make the probe disagree with the
 * route. What breaks each case is named in its label.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SESSION = { claims: { oid: 'oid-reader', tid: 'tid-1', upn: 'r@loom.test', groups: [] } } as any;
vi.mock('@/lib/auth/session', () => ({ getSession: () => SESSION, tenantScopeId: () => 'tid-1' }));
vi.mock('@/lib/auth/pdp/enforce', () => ({ pdpCheck: vi.fn(async () => null) }));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async (..._a: any[]) => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);

const admin = vi.hoisted(() => ({ isTenantAdmin: vi.fn(() => false) }));
vi.mock('@/lib/auth/feature-gate', async () => ({
  ...(await vi.importActual<any>('@/lib/auth/feature-gate')),
  isTenantAdmin: admin.isTenantAdmin,
}));

const POOL = { id: 'pool-1', itemType: 'synapse-serverless-sql-pool', workspaceId: 'ws-1', displayName: 'P', state: {} };
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (spec: any, opts?: any) => ({
        fetchAll: async () => {
          const params: Record<string, unknown> = Object.fromEntries(
            (spec.parameters ?? []).map((p: any) => [p.name, p.value]),
          );
          if (/c\.itemType = 'lakehouse'/.test(spec.query)) {
            const inWorkspace = opts?.partitionKey === 'ws-1' && params['@w'] === 'ws-1';
            return { resources: inWorkspace ? [{ id: 'lh-1' }] : [] };
          }
          const hit = params['@id'] === POOL.id && params['@t'] === POOL.itemType;
          return { resources: hit ? [POOL] : [] };
        },
      }),
    },
  }),
}));

const LH1 = { abfss: 'abfss://gold@acct1.dfs.core.windows.net/lakehouses/sales-1', container: 'gold', root: 'lakehouses/sales-1' };
const storage = vi.hoisted(() => ({ resolveLakehouseStorage: vi.fn() }));
vi.mock('@/lib/azure/lakehouse-abfss', async () => ({
  ...(await vi.importActual<any>('@/lib/azure/lakehouse-abfss')),
  resolveLakehouseStorage: storage.resolveLakehouseStorage,
}));

const synapse = vi.hoisted(() => ({
  executeQuery: vi.fn(async (..._a: any[]) => ({
    columns: ['a'], rows: [[1]], rowCount: 1, executionMs: 3, truncated: false, messages: [],
  })),
  executeQueryAsUser: vi.fn(async (..._a: any[]) => ({
    columns: ['a'], rows: [[1]], rowCount: 1, executionMs: 3, truncated: false, messages: [],
  })),
  serverlessTarget: vi.fn((database = 'master') => ({ server: 's', database, cacheKey: `k:${database}` })),
  dedicatedTarget: vi.fn(() => ({ server: 'd', database: 'pool', cacheKey: 'dedicated:pool' })),
  serverlessEndpoint: () => 's.sql.azuresynapse.net',
  getSynapseSqlSuffix: () => 'sql.azuresynapse.net',
}));
vi.mock('@/lib/azure/synapse-sql-client', () => synapse);
vi.mock('@/lib/azure/synapse-pool-arm', () => ({ getPoolState: vi.fn(async () => ({ state: 'Online' })) }));
const access = vi.hoisted(() => ({ resolveAccessMode: vi.fn(async (..._a: any[]) => 'service') }));
vi.mock('@/lib/azure/sql-access-mode', () => access);
vi.mock('@/lib/azure/sql-user-token-store', () => ({ getUserSqlToken: vi.fn(async () => 'user-token') }));
vi.mock('@/lib/azure/databricks-client', () => ({ executeStatement: vi.fn(), getWarehouse: vi.fn() }));

import { POST } from '@/app/api/items/[type]/[id]/visual-query/route';
import { compileGraph, type VqGraph } from '@/lib/editors/visual-query-compiler';
import { VISUAL_QUERY_SURFACE } from '@/app/api/items/synapse-serverless-sql-pool/_lib/visual-query-surface';
import { SQL_POOL_EDITOR } from '@/app/api/items/synapse-serverless-sql-pool/_lib/query-scope';
import { analyzeLakehouseQuery } from '@/app/api/items/lakehouse/_lib/query-scope';

const IN_ROOT = 'https://acct1.dfs.core.windows.net/gold/lakehouses/sales-1/Tables/orders';
const OUT = 'https://acct1.dfs.core.windows.net/gold/lakehouses/other-9/Tables/orders';

/** source → filter, the filter's WHERE reading a location through OPENROWSET. */
function graphReading(url: string): VqGraph {
  return {
    nodes: [
      { id: 's1', kind: 'source', inputs: [], schema: 'dbo', table: 'orders' },
      {
        id: 'f1', kind: 'filter', inputs: ['s1'],
        whereExpression: `EXISTS (SELECT 1 FROM OPENROWSET(BULK '${url}', FORMAT='DELTA') AS r)`,
      },
    ],
  } as VqGraph;
}

function ctx(type: string, id = 'pool-1') {
  return { params: Promise.resolve({ type, id }) } as any;
}
function req(body: any) {
  const url = new URL('http://x/');
  return { url: url.toString(), nextUrl: url, json: async () => body } as any;
}
function ranAnything() {
  return synapse.executeQuery.mock.calls.length + synapse.executeQueryAsUser.mock.calls.length;
}

beforeEach(() => {
  vi.clearAllMocks();
  admin.isTenantAdmin.mockReturnValue(false);
  guard.authorizeItemWorkspace.mockResolvedValue(null as any);
  access.resolveAccessMode.mockResolvedValue('service');
  storage.resolveLakehouseStorage.mockImplementation(async (id: string) =>
    id === 'lh-1' ? { ok: true, bound: LH1 } : { ok: false, reason: 'not-found' });
});

describe('visual query on the serverless SQL pool item', () => {
  it('a caller the item guard refuses gets its 404 and nothing runs (breaks if the route skips the guard)', async () => {
    guard.authorizeItemWorkspace.mockResolvedValue(
      Response.json({ ok: false, error: 'item not found' }, { status: 404 }) as any,
    );
    const res = await POST(req({ describe: { schema: 'dbo', table: 'orders' }, database: 'salesdb' }), ctx('synapse-serverless-sql-pool'));
    expect(res.status).toBe(404);
    expect(ranAnything()).toBe(0);
    expect(guard.authorizeItemWorkspace.mock.calls[0][1]).toMatchObject({
      itemId: 'pool-1', itemType: 'synapse-serverless-sql-pool', allowReadRoles: true,
    });
  });

  it('an id naming no item is a 404 and nothing runs', async () => {
    const res = await POST(req({ describe: { table: 'orders' } }), ctx('synapse-serverless-sql-pool', 'missing'));
    expect(res.status).toBe(404);
    expect(ranAnything()).toBe(0);
  });

  it('a tenant admin posting a non-item id (Warp\'s former ambient `synapse-serverless`) is a 404 and nothing runs (breaks if admins or that id skip the item guard)', async () => {
    admin.isTenantAdmin.mockReturnValue(true);
    const res = await POST(req({ describe: { table: 'orders' } }), ctx('synapse-serverless-sql-pool', 'synapse-serverless'));
    expect(res.status).toBe(404);
    expect(ranAnything()).toBe(0);
  });

  it('a non-admin describe runs in master on the SQL pool editor pool with the prefix; the request database is ignored', async () => {
    const res = await POST(req({ describe: { schema: 'dbo', table: 'orders' }, database: 'salesdb' }), ctx('synapse-serverless-sql-pool'));
    expect(res.status).toBe(200);
    const [target, batch] = synapse.executeQuery.mock.calls[0];
    // 'salesdb' means the body database was honoured for a non-admin.
    expect(target.database).toBe('master');
    // 'k:master' means the shared serverless pool.
    expect(target.cacheKey).toBe('sql-pool-reader:k:master');
    // The bare text means the prefix was dropped.
    expect(batch).toBe('USE [master]; SELECT TOP 0 * FROM [dbo].[orders]');
    // The preview shows the text as compiled, without the route's prefix.
    expect((await res.json()).generatedSql).toBe('SELECT TOP 0 * FROM [dbo].[orders]');
  });

  it('a non-admin describe of a sys object is refused before anything runs (breaks if the classifier is skipped)', async () => {
    const res = await POST(req({ describe: { schema: 'sys', table: 'databases' } }), ctx('synapse-serverless-sql-pool'));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('query_construct_not_accepted');
    expect(ranAnything()).toBe(0);
  });

  it('a non-admin graph reading outside every lakehouse root is a 403 naming it, and nothing runs', async () => {
    const res = await POST(req({ graph: graphReading(OUT) }), ctx('synapse-serverless-sql-pool'));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'query_location_outside_root', construct: OUT });
    expect(ranAnything()).toBe(0);
  });

  it('a non-admin graph reading inside a lakehouse root of the item\'s workspace runs, prefixed (positive half)', async () => {
    const graph = graphReading(IN_ROOT);
    const res = await POST(req({ graph }), ctx('synapse-serverless-sql-pool'));
    expect(res.status).toBe(200);
    const [target, batch] = synapse.executeQuery.mock.calls[0];
    expect(target.cacheKey).toBe('sql-pool-reader:k:master');
    expect(batch).toBe(`USE [master]; ${compileGraph(graph, 'tsql')}`);
  });

  it('in user identity mode a non-admin gets the same target and prefixed batch', async () => {
    access.resolveAccessMode.mockResolvedValue('user');
    const res = await POST(req({ describe: { table: 'orders' }, database: 'salesdb' }), ctx('synapse-serverless-sql-pool'));
    expect(res.status).toBe(200);
    const [target, batch] = synapse.executeQueryAsUser.mock.calls[0];
    expect(target.cacheKey).toBe('sql-pool-reader:k:master');
    expect(batch).toBe('USE [master]; SELECT TOP 0 * FROM [orders]');
  });

  it('a tenant admin runs the generated SQL unchanged in the requested database (breaks if admins are confined)', async () => {
    admin.isTenantAdmin.mockReturnValue(true);
    const res = await POST(req({ describe: { schema: 'sys', table: 'databases' }, database: 'salesdb' }), ctx('synapse-serverless-sql-pool'));
    expect(res.status).toBe(200);
    const [target, batch] = synapse.executeQuery.mock.calls[0];
    expect(target.cacheKey).toBe('k:salesdb');
    expect(batch).toBe('SELECT TOP 0 * FROM [sys].[databases]');
    expect(storage.resolveLakehouseStorage).not.toHaveBeenCalled();
  });

  it('the dedicated engine types are unchanged: no item guard and no classifier', async () => {
    const res = await POST(req({ describe: { schema: 'sys', table: 'tables' } }), ctx('synapse-dedicated-sql-pool', 'dp-1'));
    expect(res.status).toBe(200);
    expect(guard.authorizeItemWorkspace).not.toHaveBeenCalled();
    expect(synapse.executeQuery.mock.calls[0][1]).toBe('SELECT TOP 0 * FROM [sys].[tables]');
  });
});

/** source → Sink; the compiler wraps it in `SELECT … INTO` (table) or `CREATE OR ALTER VIEW` (view). */
function sinkGraph(mode: 'table' | 'view'): VqGraph {
  return {
    nodes: [
      { id: 's1', kind: 'source', inputs: [], schema: 'INFORMATION_SCHEMA', table: 'TABLES' },
      { id: 'k1', kind: 'sink', inputs: ['s1'], sink: { mode, table: 'out_t' } },
    ],
    outputId: 'k1',
  } as VqGraph;
}

describe('visual query Sink on the serverless SQL pool item, caller who is not a tenant admin', () => {
  it('a table Sink is refused in the visual query\'s own words, with no bracket hint, and nothing runs', async () => {
    const graph = sinkGraph('table');
    // The fixture reaches the rule: the compiled text carries the compiler's INTO.
    expect(compileGraph(graph, 'tsql')).toContain('INTO [out_t]');
    const res = await POST(req({ graph }), ctx('synapse-serverless-sql-pool'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('query_construct_not_accepted');
    expect(body.construct).toBe('INTO');
    // Breaks if the route words it for the SQL editor (`This editor runs …`).
    expect(body.error).toBe(
      `${VISUAL_QUERY_SURFACE.lead}INTO is not accepted: statements that change data are not run from `
      + `${VISUAL_QUERY_SURFACE.place}.`,
    );
    // Breaks if the bracket hint comes back (`If INTO is a column or table name, write it in brackets …`).
    expect(body.remediation).toBe(VISUAL_QUERY_SURFACE.selectRemediation);
    expect(body.remediation).toContain('remove the Sink');
    expect(ranAnything()).toBe(0);
  });

  it('a view Sink is refused by the statement-start rule in the visual query\'s words, and nothing runs', async () => {
    const res = await POST(req({ graph: sinkGraph('view') }), ctx('synapse-serverless-sql-pool'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.construct).toBe('a statement starting with CREATE');
    expect(body.error).toBe(
      `${VISUAL_QUERY_SURFACE.lead}A statement starting with CREATE is not accepted: only SELECT statements are run `
      + `from ${VISUAL_QUERY_SURFACE.place}.`,
    );
    expect(body.remediation).toBe(VISUAL_QUERY_SURFACE.selectRemediation);
    expect(ranAnything()).toBe(0);
  });

  it('the same Sink with no table compiles to a plain SELECT and runs (positive half)', async () => {
    const graph = sinkGraph('table');
    (graph.nodes[1] as any).sink.table = '';
    const res = await POST(req({ graph }), ctx('synapse-serverless-sql-pool'));
    expect(res.status).toBe(200);
    expect(synapse.executeQuery.mock.calls[0][1]).toBe(`USE [master]; ${compileGraph(graph, 'tsql')}`);
  });

  it('the surfaces where SQL is typed keep the bracket hint for the same text (the lakehouse SQL tab and the SQL editor)', () => {
    const sql = compileGraph(sinkGraph('table'), 'tsql');
    // Breaks if `generated` is honoured on every surface rather than only the visual query's.
    for (const surface of [undefined, SQL_POOL_EDITOR]) {
      const r = analyzeLakehouseQuery(sql, { database: 'master', surface });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.remediation).toContain('write it in brackets, as [INTO]');
    }
  });
});
