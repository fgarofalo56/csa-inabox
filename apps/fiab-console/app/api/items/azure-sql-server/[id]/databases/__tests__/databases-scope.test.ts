/**
 * GHSA-v8r7-c2p5-mjf2 — GET /api/items/azure-sql-server/[id]/databases.
 *
 * NOT IN THE ADVISORY'S 19. It sat in `SHARED_BACKEND_ITEM_ROUTES` beside
 * `create-db` and `azure-sql-database/[id]/firewall` and is the exact twin of
 * `postgres-flexible-server/[id]/databases`; it was found by enumerating that
 * allowlist block mechanically rather than working the handed-over triage list.
 * The advisory's own lesson generalises: a list assembled by hand under-reports
 * for the same reason a control that cannot see a shape reports zero for it.
 *
 * BEFORE this was `GET(req)` + `getSession()` with `[id]` never read and
 * `server` from the query string. `azure-sql-client.listDatabases` branches
 * `serverIdOrName.startsWith('/')`, so a full ARM resource id skipped the
 * subscription pin and enumerated database names on any SQL server the Console
 * UAMI held a role on, in ANY subscription.
 *
 * ITS CALLER WAS PART OF THE DEFECT. `azure-sql-editors.useSqlDatabases` sent
 * the literal id `current`, with a comment stating the route reads only
 * `?server=` and not `[id]` — true, and precisely the property being removed.
 * The `resolves the real item id` spec below is the regression guard for that.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const OID = 'oid-owner';
const GOVERNED = '11111111-1111-1111-1111-111111111111';
const FOREIGN = '99999999-9999-9999-9999-999999999999';
const foreignId = `/subscriptions/${FOREIGN}/resourceGroups/rg-victim/providers/Microsoft.Sql/servers/victim-sql`;
const governedId = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/other-sql`;

const getSessionMock = vi.fn(() => ({ claims: { oid: OID, upn: 'owner@loom.test', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const OWNED_ITEM = {
  id: 'item1', workspaceId: 'ws1', itemType: 'azure-sql-server',
  displayName: 'Mine', state: { connection: { family: 'azure-sql', server: 'sql1' } },
} as any;
const loadOwnedItemMock = vi.fn(async () => OWNED_ITEM);
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a),
}));

vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn(), enforceCapability: vi.fn() }));
vi.mock('@/lib/auth/dlz-gate', () => ({ denyIfNoDlzAccess: vi.fn() }));
vi.mock('@/lib/gates/registry', () => ({ getGate: vi.fn(), gateStatus: vi.fn() }));

class AzureSqlError extends Error { status = 502; }
const listDatabasesMock = vi.fn(async () => [{ name: 'appdb' }]);
vi.mock('@/lib/azure/azure-sql-client', () => ({
  listDatabases: (...a: any[]) => listDatabasesMock(...a),
  AzureSqlError,
}));

const PARAMS = { params: Promise.resolve({ id: 'item1' }) } as any;
const BASE = 'http://localhost/api/items/azure-sql-server/item1/databases';
const getReq = (qs = '') => new NextRequest(`${BASE}${qs}`);

let savedSub: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  savedSub = process.env.LOOM_SUBSCRIPTION_ID;
  process.env.LOOM_SUBSCRIPTION_ID = GOVERNED;
  getSessionMock.mockReturnValue({ claims: { oid: OID, upn: 'owner@loom.test', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 } as any);
  loadOwnedItemMock.mockResolvedValue(OWNED_ITEM);
});
afterEach(() => {
  if (savedSub === undefined) delete process.env.LOOM_SUBSCRIPTION_ID; else process.env.LOOM_SUBSCRIPTION_ID = savedSub;
});

describe('GET .../azure-sql-server/[id]/databases — discovery authorization', () => {
  it('401s when unauthenticated and enumerates NOTHING', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(foreignId)}`), PARAMS);
    expect(r.status).toBe(401);
    expect(listDatabasesMock).not.toHaveBeenCalled();
  });

  //   MUTATION: restore the `getSession()` prologue reading ?server.
  it('404s a caller who does NOT own the item — enumerates NO foreign server', async () => {
    // mockResolvedValue, NOT ...Once — the wrapper tries every
    // SQL_EDITOR_ITEM_TYPE, so a single-shot null is satisfied by candidate 2.
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(foreignId)}`), PARAMS);
    expect(r.status).toBe(404);
    expect(listDatabasesMock).not.toHaveBeenCalled();
  });

  // THE `current` REGRESSION GUARD. The old caller sent a literal placeholder id
  // because the route ignored `[id]`. It no longer does, so a placeholder must
  // 404 — and the editor must send the real id, which it now does.
  it('404s the old `current` placeholder id the editor used to send', async () => {
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { GET } = await import('../route');
    const r = await GET(
      new NextRequest('http://localhost/api/items/azure-sql-server/current/databases?server=sql1'),
      { params: Promise.resolve({ id: 'current' }) } as any,
    );
    expect(r.status).toBe(404);
    expect(listDatabasesMock).not.toHaveBeenCalled();
  });

  //   MUTATION: drop the `admitPickedServer` call and pass the raw param.
  it('403s a ?server ARM id in an ungoverned subscription, enumerating NOTHING', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(foreignId)}`), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(listDatabasesMock).not.toHaveBeenCalled();
  });

  // PROVIDER PINNING.
  //   MUTATION: `admitPickedServer(…, 'postgres', …)`.
  it('403s a governed ARM id of the WRONG resource type', async () => {
    const pgId = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.DBforPostgreSQL/flexibleServers/sql1`;
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(pgId)}`), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_type_mismatch');
    expect(listDatabasesMock).not.toHaveBeenCalled();
  });

  it('400s a missing ?server, with a message about the param and not about a binding', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq(), PARAMS);
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.code).toBe('server_required');
    expect(String(j.error)).not.toMatch(/bound/i);
    expect(listDatabasesMock).not.toHaveBeenCalled();
  });

  //   MUTATION: drop `allowReadRoles: true`.
  it('CONTROL: read-role scoped, and the owner lists their own server', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq('?server=sql1'), PARAMS);
    expect(r.status).toBe(200);
    expect(listDatabasesMock).toHaveBeenCalledWith('sql1');
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] as { allowReadRoles?: boolean } | undefined;
    expect(opts?.allowReadRoles).toBe(true);
  });

  // THE LAYER-2-WOULD-BREAK-THIS CONTROL. `AzureSqlServerEditor` lists databases
  // on whichever server was clicked in the tree, which is routinely not the one
  // the item is bound to — that call IS how the user chooses.
  //   MUTATION: swap the wrapper for `withBoundSqlServer`.
  it('CONTROL: lists a GOVERNED server that differs from the item binding', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(governedId)}`), PARAMS);
    expect(r.status).toBe(200);
    expect(listDatabasesMock.mock.calls[0][0]).toBe(governedId);
  });

  //   MUTATION: `listDatabases(url.searchParams.get('server'))`.
  it('reduces an FQDN to its first DNS label before calling the client', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq('?server=sql1.database.windows.net'), PARAMS);
    expect(r.status).toBe(200);
    expect(listDatabasesMock.mock.calls[0][0]).toBe('sql1');
  });
});
