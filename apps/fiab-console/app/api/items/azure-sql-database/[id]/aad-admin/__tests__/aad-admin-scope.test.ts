/**
 * GHSA-v8r7-c2p5-mjf2 — /api/items/azure-sql-database/[id]/aad-admin.
 *
 * BEFORE: both handlers were session-only with `server` taken from the query
 * string / body and `[id]` never read. PUT is a PRIVILEGE GRANT — the Entra
 * admin of a logical server is sysadmin-equivalent on every database on it — so
 * any signed-in caller could make themselves administrator of any SQL server the
 * Console UAMI could reach, in any subscription. That ranks with `share`, above
 * the availability/cost routes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The wrapper resolves `[id]` across this whole family; the specs assert against
// it rather than re-listing the slugs (re-listing is the defect that made #3623
// wrong twice).
import { SQL_EDITOR_ITEM_TYPES } from '@/app/api/items/_lib/sql-server-scope';

const OID = 'oid-owner';
const GOVERNED = '11111111-1111-1111-1111-111111111111';
const FOREIGN = '99999999-9999-9999-9999-999999999999';
const sqlArm = (sub: string, name = 'srv') =>
  `/subscriptions/${sub}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/${name}`;

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
const getAadAdminMock = vi.fn(async () => ({ login: 'admins@loom.test', sid: 'sid-1' }));
const setAadAdminMock = vi.fn(async () => ({ login: 'attacker@evil.test', sid: 'sid-x' }));
vi.mock('@/lib/azure/azure-sql-client', () => ({
  getAadAdmin: (...a: any[]) => getAadAdminMock(...(a as [])),
  setAadAdmin: (...a: any[]) => setAadAdminMock(...(a as [])),
  AzureSqlError,
}));

const PARAMS = { params: Promise.resolve({ id: 'item1' }) } as any;
const BASE = 'http://localhost/api/items/azure-sql-database/item1/aad-admin';
const getReq = (qs = '') => new NextRequest(`${BASE}${qs}`, { method: 'GET' });
const putReq = (body: unknown) => new NextRequest(BASE, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const ADMIN = { login: 'attacker@evil.test', sid: 'attacker-object-id' };

let savedSub: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  savedSub = process.env.LOOM_SUBSCRIPTION_ID;
  process.env.LOOM_SUBSCRIPTION_ID = GOVERNED;
  getSessionMock.mockReturnValue({ claims: { oid: OID, upn: 'owner@loom.test', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 } as any);
  loadOwnedItemMock.mockResolvedValue(OWNED_ITEM);
  getAadAdminMock.mockResolvedValue({ login: 'admins@loom.test', sid: 'sid-1' } as any);
  setAadAdminMock.mockResolvedValue({ login: 'attacker@evil.test', sid: 'sid-x' } as any);
});
afterEach(() => {
  if (savedSub === undefined) delete process.env.LOOM_SUBSCRIPTION_ID;
  else process.env.LOOM_SUBSCRIPTION_ID = savedSub;
});

describe('PUT /aad-admin — the privilege grant', () => {
  it('401s when unauthenticated and sets NOTHING', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { PUT } = await import('../route');
    const r = await PUT(putReq({ server: sqlArm(FOREIGN), ...ADMIN }), PARAMS);
    expect(r.status).toBe(401);
    expect(setAadAdminMock).not.toHaveBeenCalled();
  });

  //   MUTATION: replace withBoundSqlServer with a bare `getSession()` prologue.
  it('404s a caller who does NOT own the item, setting NOTHING', async () => {
    // mockResolvedValue, NOT ...Once: the wrapper tries EVERY type in
    // SQL_EDITOR_ITEM_TYPES, so a single null is satisfied by the next candidate
    // and this spec would silently stop testing not-owned.
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { PUT } = await import('../route');
    const r = await PUT(putReq({ server: sqlArm(FOREIGN, 'victim-srv'), ...ADMIN }), PARAMS);
    expect(r.status).toBe(404);
    expect(setAadAdminMock).not.toHaveBeenCalled();
  });

  it('stays WRITE-scoped — a read-only viewer can never set the Entra admin', async () => {
    const { PUT } = await import('../route');
    await PUT(putReq(ADMIN), PARAMS);
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] as { allowReadRoles?: boolean } | undefined;
    expect(opts?.allowReadRoles).toBeFalsy();
  });

  //   MUTATION: `setAadAdmin(String(body.server), …)`.
  it('403s a body server that differs from the binding, setting NOTHING', async () => {
    const { PUT } = await import('../route');
    const r = await PUT(putReq({ server: sqlArm(GOVERNED, 'other-srv'), ...ADMIN }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_mismatch');
    expect(setAadAdminMock).not.toHaveBeenCalled();
  });

  it('403s a body ARM id in an ungoverned subscription, setting NOTHING', async () => {
    const { PUT } = await import('../route');
    const r = await PUT(putReq({ server: sqlArm(FOREIGN, 'victim-srv'), ...ADMIN }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(setAadAdminMock).not.toHaveBeenCalled();
  });

  //   MUTATION: delete the `admitGovernedServer(submittedServer, …)` block.
  it('403s a body ARM id for a SAME-NAMED server in an ungoverned subscription', async () => {
    const { PUT } = await import('../route');
    const r = await PUT(putReq({ server: sqlArm(FOREIGN, 'srv'), ...ADMIN }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(setAadAdminMock).not.toHaveBeenCalled();
  });

  it('403s an item BOUND to an ungoverned server even when the body agrees', async () => {
    loadOwnedItemMock.mockResolvedValueOnce({
      ...OWNED_ITEM, state: { connection: { server: sqlArm(FOREIGN), database: 'db' } },
    } as any);
    const { PUT } = await import('../route');
    const r = await PUT(putReq({ server: sqlArm(FOREIGN), ...ADMIN }), PARAMS);
    expect(r.status).toBe(403);
    expect(setAadAdminMock).not.toHaveBeenCalled();
  });

  it('409s an unbound item rather than setting the admin on a body-chosen server', async () => {
    loadOwnedItemMock.mockResolvedValueOnce({ ...OWNED_ITEM, state: {} } as any);
    const { PUT } = await import('../route');
    const r = await PUT(putReq({ server: sqlArm(FOREIGN), ...ADMIN }), PARAMS);
    expect(r.status).toBe(409);
    expect(setAadAdminMock).not.toHaveBeenCalled();
  });

  // The Entra admin sits at SERVER scope, so this route must NOT demand a bound
  // database — requiring one would refuse a legitimate server-only binding.
  it('CONTROL: works on a server-only binding (no database bound)', async () => {
    loadOwnedItemMock.mockResolvedValueOnce({
      ...OWNED_ITEM, state: { connection: { family: 'azure-sql', server: 'srv' } },
    } as any);
    const { PUT } = await import('../route');
    const r = await PUT(putReq(ADMIN), PARAMS);
    expect(r.status).toBe(200);
    expect(setAadAdminMock).toHaveBeenCalledWith('srv', expect.objectContaining({ login: ADMIN.login }));
  });

  // THE REBINDING MUTATION CATCHER.
  //   MUTATION: `setAadAdmin(String(body?.server || server), …)`.
  it('sets the admin on the BOUND server even when the body names it in another form', async () => {
    const { PUT } = await import('../route');
    const r = await PUT(putReq({ server: sqlArm(GOVERNED, 'srv'), ...ADMIN, tenantId: 'tid-9' }), PARAMS);
    expect(r.status).toBe(200);
    expect(setAadAdminMock).toHaveBeenCalledWith('srv', { login: ADMIN.login, sid: ADMIN.sid, tenantId: 'tid-9' });
  });

  it('still validates the login/sid fields it owns', async () => {
    const { PUT } = await import('../route');
    const r = await PUT(putReq({ login: 'x' }), PARAMS);
    expect(r.status).toBe(400);
    expect(setAadAdminMock).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE #3623 REGRESSION. `AzureSqlServerEditor` — registered for the
// `azure-sql-server` slug — calls THIS route with an `azure-sql-server` item id
// (its AAD admin dialog). #3623 shipped SQL_EDITOR_ITEM_TYPES as
// `['azure-sql-database']`, review widened it to three, and `azure-sql-server`
// was in neither: `loadOwnedSqlItem` matched no candidate, returned null, and a
// working button started 404ing.
//
// Nothing else caught it. `tsc` is clean either way, and
// `scripts/ci/check-route-guards.mjs` sees the route still consuming
// `session.claims.oid` through the wrapper. Only a spec that names the slug can.
// ═══════════════════════════════════════════════════════════════════════════
describe('resolves the [id] across the WHOLE editor family, not one slug', () => {
  /** The caller owns an item of EXACTLY `itemType` and nothing else. */
  const ownsOnly = (itemType: string) =>
    loadOwnedItemMock.mockImplementation(((_id: string, t: string) =>
      Promise.resolve(t === itemType ? { ...OWNED_ITEM, itemType } : null)) as any);

  //   MUTATION: drop 'azure-sql-server' from SQL_EDITOR_ITEM_TYPES.
  it('authorizes an owned azure-sql-server item — the slug #3623 dropped', async () => {
    ownsOnly('azure-sql-server');
    const { GET } = await import('../route');
    const r = await GET(getReq('?server=srv'), PARAMS);
    expect(r.status).toBe(200);
    expect(getAadAdminMock).toHaveBeenCalledWith('srv');
  });

  it('authorizes a PUT for an owned azure-sql-server item', async () => {
    ownsOnly('azure-sql-server');
    const { PUT } = await import('../route');
    const r = await PUT(putReq(ADMIN), PARAMS);
    expect(r.status).toBe(200);
    expect(setAadAdminMock).toHaveBeenCalledWith('srv', expect.objectContaining({ login: ADMIN.login }));
  });

  // The not-owned specs above only mean something if EVERY candidate was tried
  // and refused. Assert that directly — a resolution that quietly stopped after
  // one type would still 404 here and hide behind the same green.
  it('owner-checks every slug in the family before refusing', async () => {
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { PUT } = await import('../route');
    const r = await PUT(putReq(ADMIN), PARAMS);
    expect(r.status).toBe(404);
    const typesTried = loadOwnedItemMock.mock.calls.map((c: any[]) => c[1]);
    expect(new Set(typesTried)).toEqual(new Set(SQL_EDITOR_ITEM_TYPES));
  });

  // Widening the population must NOT widen access: a caller who owns nothing is
  // still refused for all six, and the privilege grant never runs.
  it('a caller who owns NONE of the six is still refused, granting NOTHING', async () => {
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { PUT } = await import('../route');
    const r = await PUT(putReq({ server: sqlArm(GOVERNED, 'srv'), ...ADMIN }), PARAMS);
    expect(r.status).toBe(404);
    expect(setAadAdminMock).not.toHaveBeenCalled();
  });
});

describe('GET /aad-admin — the read half', () => {
  it('401s when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { GET } = await import('../route');
    expect((await GET(getReq('?server=victim'), PARAMS)).status).toBe(401);
    expect(getAadAdminMock).not.toHaveBeenCalled();
  });

  //   MUTATION: `getAadAdmin(qs.server)`.
  it('403s a query-string server that differs from the binding, reading NOTHING', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(sqlArm(GOVERNED, 'other-srv'))}`), PARAMS);
    expect(r.status).toBe(403);
    expect(getAadAdminMock).not.toHaveBeenCalled();
  });

  it('403s an ungoverned query-string ARM id, reading NOTHING', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(sqlArm(FOREIGN))}`), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(getAadAdminMock).not.toHaveBeenCalled();
  });

  it('CONTROL: admits read roles and reads the item’s OWN bound server', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq('?server=srv'), PARAMS);
    expect(r.status).toBe(200);
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] as { allowReadRoles?: boolean } | undefined;
    expect(opts?.allowReadRoles).toBe(true);
    expect(getAadAdminMock).toHaveBeenCalledWith('srv');
  });

  it('reads the BOUND server even when the query names it in another form', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(sqlArm(GOVERNED, 'srv'))}`), PARAMS);
    expect(r.status).toBe(200);
    expect(getAadAdminMock).toHaveBeenCalledWith('srv');
  });
});
