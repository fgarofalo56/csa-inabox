/**
 * GHSA-v8r7-c2p5-mjf2 — GET + POST /api/items/azure-sql-database/[id]/search-management.
 *
 * BEFORE both verbs took `server` + `database` from the request under a bare
 * `getSession()` and handed them to `executeQuery`, which opens a real TDS
 * connection as the Console UAMI.
 *
 * The GET half is the broader one and is asserted first-class here: seven
 * catalog queries over sys.tables / sys.columns / sys.indexes / sys.fulltext_*
 * returned the FULL SCHEMA of any reachable database to any signed-in caller.
 * The POST half ran real DDL on that same caller-named database.
 *
 * Each spec names the mutation that turns it red; CONTROLs prove the owner path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const OID = 'oid-owner';
const GOVERNED = '11111111-1111-1111-1111-111111111111';
const FOREIGN = '99999999-9999-9999-9999-999999999999';
const foreignId = `/subscriptions/${FOREIGN}/resourceGroups/rg-victim/providers/Microsoft.Sql/servers/victim-srv`;

const getSessionMock = vi.fn(() => ({ claims: { oid: OID, upn: 'owner@loom.test', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const OWNED_ITEM = {
  id: 'item1', workspaceId: 'ws1', itemType: 'azure-sql-database',
  displayName: 'Mine', state: { connection: { family: 'azure-sql', server: 'srv', database: 'db' } },
} as any;
const loadOwnedItemMock = vi.fn(async () => OWNED_ITEM);
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a),
}));

vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn(), enforceCapability: vi.fn() }));
vi.mock('@/lib/auth/dlz-gate', () => ({ denyIfNoDlzAccess: vi.fn() }));
vi.mock('@/lib/gates/registry', () => ({ getGate: vi.fn(), gateStatus: vi.fn() }));

class AzureSqlError extends Error { status = 502; }
const executeQueryMock = vi.fn(async () => ({ columns: ['name'], rows: [['t1']], rowCount: 1, executionMs: 3, truncated: false }));
vi.mock('@/lib/azure/azure-sql-client', () => ({
  executeQuery: (...a: any[]) => executeQueryMock(...a),
  AzureSqlError,
}));

const PARAMS = { params: Promise.resolve({ id: 'item1' }) } as any;
function getReq(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/items/azure-sql-database/item1/search-management${qs}`);
}
function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/items/azure-sql-database/item1/search-management', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const CREATE_CATALOG = { action: 'create-catalog', name: 'cat1' };

let savedSub: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  savedSub = process.env.LOOM_SUBSCRIPTION_ID;
  process.env.LOOM_SUBSCRIPTION_ID = GOVERNED;
  getSessionMock.mockReturnValue({ claims: { oid: OID, upn: 'owner@loom.test', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 } as any);
  loadOwnedItemMock.mockResolvedValue(OWNED_ITEM);
  executeQueryMock.mockResolvedValue({ columns: ['name'], rows: [['t1']], rowCount: 1, executionMs: 3, truncated: false } as any);
});
afterEach(() => {
  if (savedSub === undefined) delete process.env.LOOM_SUBSCRIPTION_ID; else process.env.LOOM_SUBSCRIPTION_ID = savedSub;
});

describe('GET /api/items/azure-sql-database/[id]/search-management — schema read authorization', () => {
  it('401s when unauthenticated and reads NO catalog', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(foreignId)}&database=victim-db`), PARAMS);
    expect(r.status).toBe(401);
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  //   MUTATION: restore the `getSession()` + `readState(req)` prologue.
  it('404s a caller who does NOT own the item, reading NO schema', async () => {
    // mockResolvedValue, NOT ...Once — the wrapper tries every SQL_EDITOR_ITEM_TYPE.
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(foreignId)}&database=victim-db`), PARAMS);
    expect(r.status).toBe(404);
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  it('403s a ?database naming another database on the bound server — reads NOTHING', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq('?server=srv&database=victim-db'), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('database_mismatch');
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  it('403s a ?server ARM id in an ungoverned subscription', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(foreignId)}&database=db`), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  //   MUTATION: delete the admitGovernedServer(bound.server, …) call.
  it('403s an item BOUND to an ungoverned subscription', async () => {
    loadOwnedItemMock.mockResolvedValue({
      ...OWNED_ITEM, state: { connection: { family: 'azure-sql', server: foreignId, database: 'db' } },
    } as any);
    const { GET } = await import('../route');
    const r = await GET(getReq('?kind=inventory'), PARAMS);
    expect(r.status).toBe(403);
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  it('CONTROL: the owner reads their OWN bound database’s inventory', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq('?kind=inventory'), PARAMS);
    expect(r.status).toBe(200);
    expect(executeQueryMock).toHaveBeenCalled();
    for (const call of executeQueryMock.mock.calls) {
      expect(call[0]).toBe('srv');
      expect(call[1]).toBe('db');
    }
  });

  // A workspace READER may inspect the search inventory — this is a read.
  //   MUTATION: drop `allowReadRoles: true` from the GET options.
  it('CONTROL: the GET is read-role scoped', async () => {
    const { GET } = await import('../route');
    await GET(getReq('?kind=inventory'), PARAMS);
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] as { allowReadRoles?: boolean } | undefined;
    expect(opts?.allowReadRoles).toBe(true);
  });

  // THE REBINDING MUTATION CATCHER — a DIFFERENT FORM of the same server, so
  // `?server ?? bound` and `bound` produce different values.
  //   MUTATION: `runRows(url.searchParams.get('server') || server, …)`.
  it('reads the BOUND server even when ?server names it in another form', async () => {
    const governedId = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/srv`;
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(governedId)}&database=db&kind=columns&objectName=dbo.t`), PARAMS);
    expect(r.status).toBe(200);
    expect(executeQueryMock.mock.calls[0][0]).toBe('srv');
  });
});

describe('POST /api/items/azure-sql-database/[id]/search-management — DDL authorization', () => {
  it('401s when unauthenticated and runs NO DDL', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, database: 'victim-db', ...CREATE_CATALOG }), PARAMS);
    expect(r.status).toBe(401);
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  it('404s a caller who does NOT own the item, running NO DDL', async () => {
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, database: 'victim-db', ...CREATE_CATALOG }), PARAMS);
    expect(r.status).toBe(404);
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  // DDL mutates the schema — a read-only viewer must never reach it.
  //   MUTATION: add `allowReadRoles: true` to the POST options.
  it('stays WRITE-scoped — no allowReadRoles on the DDL half', async () => {
    const { POST } = await import('../route');
    await POST(postReq(CREATE_CATALOG), PARAMS);
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] as { allowReadRoles?: boolean } | undefined;
    expect(opts?.allowReadRoles).toBeFalsy();
  });

  it('403s a body database that differs from the binding, running NO DDL', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: 'srv', database: 'victim-db', ...CREATE_CATALOG }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('database_mismatch');
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  it('403s a body ARM id for a SAME-NAMED server in an ungoverned subscription', async () => {
    const sameName = `/subscriptions/${FOREIGN}/resourceGroups/rg-victim/providers/Microsoft.Sql/servers/srv`;
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sameName, database: 'db', ...CREATE_CATALOG }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  it('409s an item with no bound connection rather than running DDL on a body-chosen database', async () => {
    loadOwnedItemMock.mockResolvedValue({ ...OWNED_ITEM, state: {} } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, database: 'victim-db', ...CREATE_CATALOG }), PARAMS);
    expect(r.status).toBe(409);
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  it('CONTROL: the owner runs DDL on their OWN bound database', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq(CREATE_CATALOG), PARAMS);
    expect(r.status).toBe(200);
    expect(executeQueryMock).toHaveBeenCalledWith('srv', 'db', expect.stringContaining('CREATE FULLTEXT CATALOG'));
  });

  //   MUTATION: `executeQuery(String(body.server || server), …)`.
  it('runs DDL against the BOUND server even when the body names it in another form', async () => {
    const governedId = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/srv`;
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: governedId, database: 'db', ...CREATE_CATALOG }), PARAMS);
    expect(r.status).toBe(200);
    expect(executeQueryMock.mock.calls[0][0]).toBe('srv');
  });

  it('still validates the action it owns', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'not-a-real-action' }), PARAMS);
    expect(r.status).toBe(400);
    expect(executeQueryMock).not.toHaveBeenCalled();
  });
});
