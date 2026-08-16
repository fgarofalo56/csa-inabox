/**
 * GHSA-v8r7-c2p5-mjf2 — /api/items/azure-sql-database/[id]/restore.
 *
 * BEFORE: session-only, `server` from the query string / body, `[id]` never
 * read — and the route's own header asserted there was "no per-tenant Cosmos
 * item to owner-check", a premise its sibling `[id]/connect` had already
 * falsified. A restore MOVES DATA: it materialises a readable copy of a source
 * database, so this let any signed-in caller copy another tenant's database, in
 * any subscription the UAMI could reach, into one they could then query.
 *
 * THREE coordinates are asserted: `server`, `sourceDatabase`, and the full ARM
 * `restorableDroppedDatabaseId` that ARM copies verbatim into
 * `properties.sourceDatabaseId`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const OID = 'oid-owner';
const GOVERNED = '11111111-1111-1111-1111-111111111111';
const FOREIGN = '99999999-9999-9999-9999-999999999999';
const sqlArm = (sub: string, name = 'srv') =>
  `/subscriptions/${sub}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/${name}`;
const droppedId = (server: string, sub = GOVERNED) =>
  `${sqlArm(sub, server)}/restorableDroppedDatabases/victim,1700000000000`;

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
const windowMock = vi.fn(async () => ({ earliest: '2026-08-01T00:00:00Z', latest: '2026-08-16T00:00:00Z' }));
const droppedListMock = vi.fn(async () => [] as any[]);
const startRestoreMock = vi.fn(async () => ({ ok: true, targetDatabaseId: 'db-new', asyncOperationUrl: 'https://arm/op', status: 'InProgress' }));
const statusMock = vi.fn(async () => ({ status: 'InProgress', raw: 'Creating' }));
vi.mock('@/lib/azure/azure-sql-client', () => ({
  getRestorableWindow: (...a: any[]) => windowMock(...(a as [])),
  listRestorableDroppedDatabases: (...a: any[]) => droppedListMock(...(a as [])),
  startPointInTimeRestore: (...a: any[]) => startRestoreMock(...(a as [])),
  getRestoreOperationStatus: (...a: any[]) => statusMock(...(a as [])),
  AzureSqlError,
}));
vi.mock('@/lib/azure/sql-restore-model', () => ({ validateRestoreRequest: () => ({ ok: true }) }));

const PARAMS = { params: Promise.resolve({ id: 'item1' }) } as any;
const BASE = 'http://localhost/api/items/azure-sql-database/item1/restore';
const getReq = (qs = '') => new NextRequest(`${BASE}${qs}`, { method: 'GET' });
const postReq = (body: unknown) => new NextRequest(BASE, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const PIT = { targetDatabase: 'db-copy', restorePointInTime: '2026-08-15T00:00:00Z' };

let savedSub: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  savedSub = process.env.LOOM_SUBSCRIPTION_ID;
  process.env.LOOM_SUBSCRIPTION_ID = GOVERNED;
  getSessionMock.mockReturnValue({ claims: { oid: OID, upn: 'owner@loom.test', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 } as any);
  loadOwnedItemMock.mockResolvedValue(OWNED_ITEM);
  windowMock.mockResolvedValue({ earliest: '2026-08-01T00:00:00Z', latest: '2026-08-16T00:00:00Z' } as any);
  droppedListMock.mockResolvedValue([]);
  startRestoreMock.mockResolvedValue({ ok: true, targetDatabaseId: 'db-new', asyncOperationUrl: 'https://arm/op', status: 'InProgress' } as any);
  statusMock.mockResolvedValue({ status: 'InProgress', raw: 'Creating' } as any);
});
afterEach(() => {
  if (savedSub === undefined) delete process.env.LOOM_SUBSCRIPTION_ID;
  else process.env.LOOM_SUBSCRIPTION_ID = savedSub;
});

describe('POST /restore — the data-movement half', () => {
  it('401s when unauthenticated and restores NOTHING', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlArm(FOREIGN), sourceDatabase: 'victim-db', ...PIT }), PARAMS);
    expect(r.status).toBe(401);
    expect(startRestoreMock).not.toHaveBeenCalled();
  });

  //   MUTATION: replace withBoundSqlServer with a bare `getSession()` prologue.
  it('404s a caller who does NOT own the item, restoring NOTHING', async () => {
    loadOwnedItemMock.mockResolvedValueOnce(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlArm(FOREIGN), sourceDatabase: 'victim-db', ...PIT }), PARAMS);
    expect(r.status).toBe(404);
    expect(startRestoreMock).not.toHaveBeenCalled();
  });

  it('stays WRITE-scoped', async () => {
    const { POST } = await import('../route');
    await POST(postReq({ sourceDatabase: 'db', ...PIT }), PARAMS);
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] as { allowReadRoles?: boolean } | undefined;
    expect(opts?.allowReadRoles).toBeFalsy();
  });

  //   MUTATION: `startPointInTimeRestore({ server: String(body.server), … })`.
  it('403s a body server that differs from the binding, restoring NOTHING', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlArm(GOVERNED, 'victim-srv'), sourceDatabase: 'db', ...PIT }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_mismatch');
    expect(startRestoreMock).not.toHaveBeenCalled();
  });

  it('403s a body ARM id in an ungoverned subscription, restoring NOTHING', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlArm(FOREIGN), sourceDatabase: 'db', ...PIT }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(startRestoreMock).not.toHaveBeenCalled();
  });

  // Pinning the SERVER alone still leaves every other database ON it readable:
  // restore it into a new database the caller owns and query that.
  //   MUTATION: `sourceDatabase = submittedSource ?? database`.
  it('403s a sourceDatabase that differs from the binding — the server pin alone is not enough', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ sourceDatabase: 'other-tenant-db', ...PIT }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('database_mismatch');
    expect(startRestoreMock).not.toHaveBeenCalled();
  });

  // The dropped-database id is copied verbatim into properties.sourceDatabaseId.
  //   MUTATION: pass `body.restorableDroppedDatabaseId` straight through.
  it('403s a restorableDroppedDatabaseId on a DIFFERENT server, restoring NOTHING', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ restorableDroppedDatabaseId: droppedId('victim-srv'), ...PIT }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('child_out_of_scope');
    expect(startRestoreMock).not.toHaveBeenCalled();
  });

  it('403s a restorableDroppedDatabaseId in an ungoverned subscription', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ restorableDroppedDatabaseId: droppedId('srv', FOREIGN), ...PIT }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(startRestoreMock).not.toHaveBeenCalled();
  });

  it('409s an unbound item rather than restoring a body-chosen database', async () => {
    loadOwnedItemMock.mockResolvedValueOnce({ ...OWNED_ITEM, state: {} } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlArm(FOREIGN), sourceDatabase: 'victim-db', ...PIT }), PARAMS);
    expect(r.status).toBe(409);
    expect(startRestoreMock).not.toHaveBeenCalled();
  });

  // ---- the legitimate-owner direction ----
  it('CONTROL: the owner restores their OWN bound database into a new one', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: 'srv', sourceDatabase: 'db', ...PIT }), PARAMS);
    expect(r.status).toBe(200);
    expect(startRestoreMock).toHaveBeenCalledWith(expect.objectContaining({
      server: 'srv', sourceDatabase: 'db', targetDatabase: 'db-copy',
    }));
  });

  it('CONTROL: an owner restores a dropped database on their OWN bound server', async () => {
    const id = droppedId('srv');
    const { POST } = await import('../route');
    const r = await POST(postReq({ restorableDroppedDatabaseId: id, ...PIT }), PARAMS);
    expect(r.status).toBe(200);
    expect(startRestoreMock).toHaveBeenCalledWith(expect.objectContaining({
      server: 'srv', restorableDroppedDatabaseId: id,
    }));
  });

  // THE REBINDING MUTATION CATCHER.
  //   MUTATION: `server: String(body?.server || server)`.
  it('restores on the BOUND server even when the body names it in another form', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlArm(GOVERNED, 'srv'), sourceDatabase: 'db', ...PIT }), PARAMS);
    expect(r.status).toBe(200);
    expect(startRestoreMock).toHaveBeenCalledWith(expect.objectContaining({ server: 'srv' }));
  });
});

describe('GET /restore — the restorable-window read', () => {
  it('401s when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { GET } = await import('../route');
    expect((await GET(getReq('?server=victim&database=victim'), PARAMS)).status).toBe(401);
    expect(windowMock).not.toHaveBeenCalled();
  });

  //   MUTATION: `getRestorableWindow(qs.server, qs.database)`.
  it('403s a query-string server that differs from the binding, reading NOTHING', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(sqlArm(GOVERNED, 'victim-srv'))}&database=db`), PARAMS);
    expect(r.status).toBe(403);
    expect(windowMock).not.toHaveBeenCalled();
  });

  it('403s an ungoverned query-string ARM id, reading NOTHING', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(sqlArm(FOREIGN))}&database=db`), PARAMS);
    expect(r.status).toBe(403);
    expect(windowMock).not.toHaveBeenCalled();
  });

  it('403s a query-string database that differs from the binding', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq('?server=srv&database=victim-db'), PARAMS);
    expect(r.status).toBe(403);
    expect(windowMock).not.toHaveBeenCalled();
  });

  it('CONTROL: reads the window for the item’s OWN bound database', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq('?server=srv&database=db'), PARAMS);
    expect(r.status).toBe(200);
    expect(windowMock).toHaveBeenCalledWith('srv', 'db');
    expect(droppedListMock).toHaveBeenCalledWith('srv');
  });

  it('CONTROL: polls restore status against the BOUND server', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq('?mode=status&target=db-copy'), PARAMS);
    expect(r.status).toBe(200);
    expect(statusMock).toHaveBeenCalledWith(expect.objectContaining({ server: 'srv', targetDatabase: 'db-copy' }));
  });

  it('reads the BOUND server even when the query names it in another form', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(sqlArm(GOVERNED, 'srv'))}&database=db`), PARAMS);
    expect(r.status).toBe(200);
    expect(windowMock).toHaveBeenCalledWith('srv', 'db');
  });
});
