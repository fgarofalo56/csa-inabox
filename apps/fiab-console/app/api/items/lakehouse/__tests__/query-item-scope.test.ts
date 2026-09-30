/**
 * `POST /api/items/lakehouse/[id]/query` — the SQL text is confined to the
 * item's storage root for a caller who is not a tenant admin.
 *
 * Each test names the change that turns it red:
 *   - reader runs the diagram query: the classifier refusing
 *     INFORMATION_SCHEMA or the route refusing every reader query.
 *   - reader EXEC is refused: the route skipping the classifier.
 *   - admin EXEC runs: the classifier also running for tenant admins.
 *   - in-root location runs / reads the ITEM's binding: the storage resolved
 *     for another id, or the confinement refusing a valid location.
 *   - out-of-root location (first or second): the confinement skipped, or
 *     applied to the first location only.
 *   - binding unavailable / unreadable: a failed resolve treated as a pass.
 *   - a metadata query does not read the binding: storage resolved eagerly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LAKEHOUSE_COLUMNS_SQL } from '@/lib/components/shared/entity-diagram-sources';

const SESSION = { claims: { oid: 'oid-reader', tid: 'tid-1', upn: 'r@loom.test', groups: [] } } as any;
vi.mock('@/lib/auth/session', () => ({ getSession: () => SESSION }));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async () => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);
vi.mock('@/lib/azure/rate-limiter', () => ({ enforceRateLimit: vi.fn(async () => null) }));

const admin = vi.hoisted(() => ({ isTenantAdmin: vi.fn(() => false) }));
vi.mock('@/lib/auth/feature-gate', async () => ({
  ...(await vi.importActual<any>('@/lib/auth/feature-gate')),
  isTenantAdmin: admin.isTenantAdmin,
}));

const ITEM: any = { id: 'lh-1', itemType: 'lakehouse', workspaceId: 'ws-1', displayName: 'Sales', state: {} };
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [ITEM] }) }) },
  }),
}));
vi.mock('@/lib/azure/kusto-client', () => ({
  defaultDatabase: () => 'loomdb-default',
  KustoError: class extends Error { status = 502; },
}));

const BOUND = {
  abfss: 'abfss://gold@acct1.dfs.core.windows.net/lakehouses/sales-1',
  container: 'gold',
  root: 'lakehouses/sales-1',
};
const storage = vi.hoisted(() => ({ resolveLakehouseStorage: vi.fn() }));
vi.mock('@/lib/azure/lakehouse-abfss', async () => ({
  ...(await vi.importActual<any>('@/lib/azure/lakehouse-abfss')),
  resolveLakehouseStorage: storage.resolveLakehouseStorage,
}));

const synapse = vi.hoisted(() => ({
  executeQuery: vi.fn(async () => ({ columns: ['a'], rows: [[1]], rowCount: 1, executionMs: 4, truncated: false })),
  serverlessTarget: vi.fn((database = 'master') => ({ server: 's', database, cacheKey: `k:${database}` })),
  getSynapseSqlSuffix: () => 'sql.azuresynapse.net',
}));
vi.mock('@/lib/azure/synapse-sql-client', () => synapse);

import { POST } from '../[id]/query/route';

const ctx = { params: Promise.resolve({ id: 'lh-1' }) } as any;
function req(body: any = {}) {
  const url = new URL('http://x/');
  return { url: url.toString(), nextUrl: url, json: async () => body } as any;
}

const IN = 'https://acct1.dfs.core.windows.net/gold/lakehouses/sales-1/Tables/orders';
const OUT = 'https://acct1.dfs.core.windows.net/silver/lakehouses/sales-1/Tables/orders';

beforeEach(() => {
  vi.clearAllMocks();
  ITEM.state = {};
  admin.isTenantAdmin.mockReturnValue(false);
  guard.authorizeItemWorkspace.mockResolvedValue(null as any);
  storage.resolveLakehouseStorage.mockResolvedValue({ ok: true, bound: BOUND });
  process.env.LOOM_SYNAPSE_WORKSPACE = 'loomsyn';
});

describe('POST /api/items/lakehouse/[id]/query — confined to the item root', () => {
  it('a reader runs the entity-diagram column query unchanged after the USE [master] prefix', async () => {
    const res = await POST(req({ sql: LAKEHOUSE_COLUMNS_SQL }), ctx);
    expect(res.status).toBe(200);
    expect(synapse.executeQuery).toHaveBeenCalledWith(expect.anything(), `USE [master]; ${LAKEHOUSE_COLUMNS_SQL}`);
  });

  it('a metadata query does not read the storage binding', async () => {
    await POST(req({ sql: 'SELECT 1' }), ctx);
    expect(storage.resolveLakehouseStorage).not.toHaveBeenCalled();
    expect(synapse.executeQuery).toHaveBeenCalledTimes(1);
  });

  it('a reader\'s EXEC is refused with the construct named, before Synapse', async () => {
    const res = await POST(req({ sql: "SELECT 1 EXEC('SELECT 2')" }), ctx);
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j).toMatchObject({ ok: false, code: 'query_construct_not_accepted', construct: 'EXEC' });
    expect(j.error).toContain('EXEC is not accepted');
    expect(typeof j.remediation).toBe('string');
    expect(synapse.executeQuery).not.toHaveBeenCalled();
  });

  it('a tenant admin runs the same text unchanged', async () => {
    admin.isTenantAdmin.mockReturnValue(true);
    const sql = "SELECT 1 EXEC('SELECT 2')";
    const res = await POST(req({ sql }), ctx);
    expect(res.status).toBe(200);
    expect(synapse.executeQuery).toHaveBeenCalledWith(expect.anything(), sql);
  });

  it('a location inside the item root runs, confined against the ITEM\'s own binding', async () => {
    const sql = `SELECT TOP 10 * FROM OPENROWSET(BULK '${IN}', FORMAT='DELTA') AS r`;
    const res = await POST(req({ sql }), ctx);
    expect(res.status).toBe(200);
    expect(storage.resolveLakehouseStorage).toHaveBeenCalledWith('lh-1', 'ws-1');
    expect(synapse.executeQuery).toHaveBeenCalledWith(expect.anything(), `USE [master]; ${sql}`);
  });

  it('a location outside the item root is a 403, before Synapse', async () => {
    const res = await POST(req({ sql: `SELECT * FROM OPENROWSET(BULK '${OUT}', FORMAT='DELTA') AS r` }), ctx);
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j).toMatchObject({ ok: false, code: 'query_location_outside_root', construct: OUT });
    expect(synapse.executeQuery).not.toHaveBeenCalled();
  });

  it('every location is confined, not only the first', async () => {
    const sql = `SELECT * FROM OPENROWSET(BULK ('${IN}/a.parquet', '${OUT}/b.parquet'), FORMAT='PARQUET') AS r`;
    const res = await POST(req({ sql }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).construct).toBe(`${OUT}/b.parquet`);
    expect(synapse.executeQuery).not.toHaveBeenCalled();
  });

  it('an unavailable binding refuses a query that names a location', async () => {
    storage.resolveLakehouseStorage.mockResolvedValue({ ok: false, reason: 'no-storage' });
    const res = await POST(req({ sql: `SELECT * FROM OPENROWSET(BULK '${IN}', FORMAT='DELTA') AS r` }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('lakehouse_storage_unbound');
    expect(synapse.executeQuery).not.toHaveBeenCalled();
  });

  it('a withheld binding answers the resolver\'s own refusal', async () => {
    storage.resolveLakehouseStorage.mockResolvedValue({ ok: false, reason: 'root-shared' });
    const res = await POST(req({ sql: `SELECT * FROM OPENROWSET(BULK '${IN}', FORMAT='DELTA') AS r` }), ctx);
    expect(res.status).toBe(409);
    expect(synapse.executeQuery).not.toHaveBeenCalled();
  });

  it('a binding that cannot be read refuses with a structured 500', async () => {
    storage.resolveLakehouseStorage.mockRejectedValue(new Error('cosmos unavailable'));
    const res = await POST(req({ sql: `SELECT * FROM OPENROWSET(BULK '${IN}', FORMAT='DELTA') AS r` }), ctx);
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
    expect(synapse.executeQuery).not.toHaveBeenCalled();
  });

  it('the unconfigured-storage 409 carries a remediation naming the deploy settings', async () => {
    // Breaks if the 409 drops `remediation` or goes back to asking for a per-item step.
    storage.resolveLakehouseStorage.mockResolvedValue({ ok: false, reason: 'no-storage' });
    const res = await POST(req({ sql: `SELECT * FROM OPENROWSET(BULK '${IN}', FORMAT='DELTA') AS r` }), ctx);
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.remediation).toContain('LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL');
    expect(j.error).not.toContain('Re-run the item provision');
  });
});

describe('POST /api/items/lakehouse/[id]/query — the SQL tab runs in a server-chosen database', () => {
  it('a caller who is not a tenant admin runs in master even when the item records a database', async () => {
    // Breaks if the reader's database is read from item state again: the
    // executor would get 'lakedb' (state.sqlDatabase) instead of 'master'.
    ITEM.state = { sqlDatabase: 'lakedb', sqlEndpointDatabase: 'lakedb2' };
    const res = await POST(req({ sql: 'SELECT 1' }), ctx);
    expect(res.status).toBe(200);
    expect(synapse.serverlessTarget).toHaveBeenCalledTimes(1);
    expect(synapse.serverlessTarget).toHaveBeenCalledWith('master');
    const target = (synapse.executeQuery.mock.calls[0] as unknown[])[0] as { database: string };
    expect(target.database).toBe('master');
    expect((await res.json()).database).toBe('master');
  });

  it('a caller who is not a tenant admin cannot reach the recorded database by a three-part name', async () => {
    // Breaks if the classifier is given the recorded database instead of master.
    ITEM.state = { sqlDatabase: 'lakedb' };
    const res = await POST(req({ sql: 'SELECT * FROM lakedb.dbo.orders' }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).construct).toBe('the three-part name lakedb.dbo.orders');
    expect(synapse.executeQuery).not.toHaveBeenCalled();
  });

  it('a tenant admin runs in the database the item records', async () => {
    // Breaks if the admin path is also pinned to master.
    admin.isTenantAdmin.mockReturnValue(true);
    ITEM.state = { sqlDatabase: 'lakedb' };
    const res = await POST(req({ sql: 'SELECT 1' }), ctx);
    expect(res.status).toBe(200);
    expect(synapse.serverlessTarget).toHaveBeenCalledWith('lakedb');
  });
});

describe('POST /api/items/lakehouse/[id]/query — the reader path has its own pool and frames its batch', () => {
  // The mocked serverlessTarget keys a pool as `k:<database>`; the reader path
  // must prefix that key, so its pool is never the one serverlessTarget('master')
  // returns to every other route.
  function sent(): { target: { cacheKey: string; database: string }; sql: string } {
    const call = synapse.executeQuery.mock.calls[0] as unknown[];
    return { target: call[0] as { cacheKey: string; database: string }, sql: call[1] as string };
  }

  it('a caller who is not a tenant admin runs on the lakehouse-reader pool, not the shared master pool', async () => {
    // Breaks if the reader path uses serverlessTarget(database) directly: the
    // key would be 'k:master', the pool every route targeting master shares.
    const res = await POST(req({ sql: 'SELECT 1' }), ctx);
    expect(res.status).toBe(200);
    expect(sent().target.cacheKey).toBe('lakehouse-reader:k:master');
    expect(sent().target.database).toBe('master');
  });

  it('a caller who is not a tenant admin sends a batch that starts with USE [master];', async () => {
    // Breaks if the prefix is dropped (the batch would be exactly 'SELECT 1')
    // or names another database.
    await POST(req({ sql: 'SELECT 1' }), ctx);
    expect(sent().sql).toBe('USE [master]; SELECT 1');
  });

  it('the USE prefix sits on the caller\'s first line, so error line numbers still match', async () => {
    // Breaks if the prefix ends in a line break: the batch would have one more line than the text.
    await POST(req({ sql: 'SELECT 1\nFROM t' }), ctx);
    expect(sent().sql.split('\n')).toHaveLength(2);
  });

  it('a tenant admin keeps the shared pool and the text exactly as written', async () => {
    // Breaks if the admin path is routed through the reader pool or given the prefix.
    admin.isTenantAdmin.mockReturnValue(true);
    await POST(req({ sql: 'SELECT 1' }), ctx);
    expect(sent().target.cacheKey).toBe('k:master');
    expect(sent().sql).toBe('SELECT 1');
  });

  it('the server\'s message for the added USE is not shown to a reader; the caller\'s own messages are', async () => {
    // Breaks if the filter is removed (both messages returned) or drops every message (none returned).
    synapse.executeQuery.mockResolvedValueOnce({
      columns: [], rows: [], rowCount: 0, executionMs: 1, truncated: false,
      messages: ["Changed database context to 'master'.", 'note from the query'],
    } as any);
    const res = await POST(req({ sql: 'SELECT 1' }), ctx);
    expect((await res.json()).messages).toEqual(['note from the query']);
  });

  it('a tenant admin sees every message the server returned', async () => {
    // Breaks if the filter also runs for tenant admins, whose own USE produces this message.
    admin.isTenantAdmin.mockReturnValue(true);
    synapse.executeQuery.mockResolvedValueOnce({
      columns: [], rows: [], rowCount: 0, executionMs: 1, truncated: false,
      messages: ["Changed database context to 'master'."],
    } as any);
    const res = await POST(req({ sql: 'SELECT 1' }), ctx);
    expect((await res.json()).messages).toEqual(["Changed database context to 'master'."]);
  });
});
