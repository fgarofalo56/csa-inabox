/**
 * GHSA-v8r7-c2p5-mjf2 — GET /api/items/postgres-flexible-server/[id]/databases.
 *
 * BEFORE this was `GET(req)` + `getSession()` with `[id]` never read and
 * `server` from the query string. `postgres-flex-client.resolveScope` branches
 * `serverName.startsWith('/')`, so a full ARM resource id skipped the
 * subscription pin and enumerated the database names on any flexible server the
 * Console UAMI held a role on, in ANY subscription — including a
 * brownfield-adopted customer server (`deploy-integrity.md` R5).
 *
 * LAYER 1 + LAYER 3, NOT LAYER 2, and both halves of that choice are asserted.
 * This is the DISCOVERY call that populates the database picker: it runs so the
 * user can decide what to bind, and `unified-sql-database-editor.pickServer`
 * calls it in the same tick it sets the selection, racing that editor's own
 * bind-on-selection effect. So a governed server that DIFFERS from the item's
 * current binding must still list — that is the spec Layer 2 would break.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const OID = 'oid-owner';
const GOVERNED = '11111111-1111-1111-1111-111111111111';
const FOREIGN = '99999999-9999-9999-9999-999999999999';
const foreignId = `/subscriptions/${FOREIGN}/resourceGroups/rg-victim/providers/Microsoft.DBforPostgreSQL/flexibleServers/victim-pg`;
const governedId = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.DBforPostgreSQL/flexibleServers/other-pg`;

const getSessionMock = vi.fn(() => ({ claims: { oid: OID, upn: 'owner@loom.test', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const OWNED_ITEM = {
  id: 'item1', workspaceId: 'ws1', itemType: 'postgres-flexible-server',
  displayName: 'Mine', state: { connection: { family: 'postgres', server: 'pg1' } },
} as any;
const loadOwnedItemMock = vi.fn(async () => OWNED_ITEM);
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a),
}));

vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn(), enforceCapability: vi.fn() }));
vi.mock('@/lib/auth/dlz-gate', () => ({ denyIfNoDlzAccess: vi.fn() }));
vi.mock('@/lib/gates/registry', () => ({ getGate: vi.fn(), gateStatus: vi.fn() }));

class PostgresError extends Error { status = 502; }
const listDatabasesMock = vi.fn(async () => [{ name: 'appdb' }]);
vi.mock('@/lib/azure/postgres-flex-client', () => ({
  listDatabases: (...a: any[]) => listDatabasesMock(...a),
  PostgresError,
}));

const PARAMS = { params: Promise.resolve({ id: 'item1' }) } as any;
const BASE = 'http://localhost/api/items/postgres-flexible-server/item1/databases';
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

describe('GET .../postgres-flexible-server/[id]/databases — discovery authorization', () => {
  it('401s when unauthenticated and enumerates NOTHING', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(foreignId)}`), PARAMS);
    expect(r.status).toBe(401);
    expect(listDatabasesMock).not.toHaveBeenCalled();
  });

  //   MUTATION: restore the `getSession()` prologue reading ?server.
  it('404s a caller who does NOT own the item — enumerates NO foreign server', async () => {
    // mockResolvedValue, NOT ...Once — `withOwnedSqlItem` tries every
    // SQL_EDITOR_ITEM_TYPE, so a single-shot null is satisfied by candidate 2.
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(foreignId)}`), PARAMS);
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

  // PROVIDER PINNING — an Azure SQL server id must not drive the PostgreSQL
  // client even inside a governed subscription.
  //   MUTATION: `admitPickedServer(…, 'sql', …)`.
  it('403s a governed ARM id of the WRONG resource type', async () => {
    const sqlId = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/pg1`;
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(sqlId)}`), PARAMS);
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

  // Listing is a read.
  //   MUTATION: drop `allowReadRoles: true`.
  it('CONTROL: read-role scoped, and the owner lists their own server', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq('?server=pg1'), PARAMS);
    expect(r.status).toBe(200);
    expect(listDatabasesMock).toHaveBeenCalledWith('pg1');
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] as { allowReadRoles?: boolean } | undefined;
    expect(opts?.allowReadRoles).toBe(true);
  });

  // THE LAYER-2-WOULD-BREAK-THIS CONTROL. The item is bound to `pg1`; picking
  // `other-pg` in the UI must still list, because this call is what lets the user
  // choose. Under `withBoundSqlServer` this returns 403 `server_mismatch`.
  //   MUTATION: swap the wrapper for `withBoundSqlServer`.
  it('CONTROL: lists a GOVERNED server that differs from the item binding', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(governedId)}`), PARAMS);
    expect(r.status).toBe(200);
    expect(listDatabasesMock.mock.calls[0][0]).toBe(governedId);
  });

  // A different FORM of the same server, so the admitted value and the raw param
  // are distinguishable: the FQDN is reduced to its first DNS label before the
  // client sees it, which is what stops a bound host outside the SQL suffix.
  //   MUTATION: `listDatabases(url.searchParams.get('server'))`.
  it('reduces an FQDN to its first DNS label before calling the client', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq('?server=pg1.postgres.database.azure.com'), PARAMS);
    expect(r.status).toBe(200);
    expect(listDatabasesMock.mock.calls[0][0]).toBe('pg1');
  });
});
