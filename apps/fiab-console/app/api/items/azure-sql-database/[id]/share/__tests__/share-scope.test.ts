/**
 * GHSA-v8r7-c2p5-mjf2 — /api/items/azure-sql-database/[id]/share.
 *
 * BEFORE: all three handlers were session-only, with `server` + `database` taken
 * from the query string / body and `[id]` never read. Because the Console UAMI
 * holds RBAC-Administrator on the SQL resource group, that was a ROLE-GRANT
 * primitive on any database the UAMI could reach. DELETE was broader still —
 * `revokeDatabaseRoleAssignment` issues a raw ARM DELETE on whatever id the
 * query string carried, at ANY scope.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const OID = 'oid-owner';
const GOVERNED = '11111111-1111-1111-1111-111111111111';
const FOREIGN = '99999999-9999-9999-9999-999999999999';
const sqlArm = (sub: string, name = 'srv') =>
  `/subscriptions/${sub}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/${name}`;
const assignmentId = (server: string, db: string, sub = GOVERNED) =>
  `${sqlArm(sub, server)}/databases/${db}/providers/Microsoft.Authorization/roleAssignments/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;

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
const listMock = vi.fn(async () => [] as any[]);
const grantMock = vi.fn(async () => ({ id: 'ra-1', principalId: 'p1', principalType: 'User', roleDefinitionId: 'rd' }));
const revokeMock = vi.fn(async () => undefined);
vi.mock('@/lib/azure/azure-sql-client', () => ({
  listDatabaseRoleAssignments: (...a: any[]) => listMock(...(a as [])),
  grantDatabaseRole: (...a: any[]) => grantMock(...(a as [])),
  revokeDatabaseRoleAssignment: (...a: any[]) => revokeMock(...(a as [])),
  AzureSqlError,
}));

const PARAMS = { params: Promise.resolve({ id: 'item1' }) } as any;
const BASE = 'http://localhost/api/items/azure-sql-database/item1/share';
const getReq = (qs = '') => new NextRequest(`${BASE}${qs}`, { method: 'GET' });
const delReq = (qs = '') => new NextRequest(`${BASE}${qs}`, { method: 'DELETE' });
const postReq = (body: unknown) => new NextRequest(BASE, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const GRANT = { principalId: 'attacker-oid', roleNameOrGuid: 'SQL DB Contributor' };

let savedSub: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  savedSub = process.env.LOOM_SUBSCRIPTION_ID;
  process.env.LOOM_SUBSCRIPTION_ID = GOVERNED;
  getSessionMock.mockReturnValue({ claims: { oid: OID, upn: 'owner@loom.test', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 } as any);
  loadOwnedItemMock.mockResolvedValue(OWNED_ITEM);
  listMock.mockResolvedValue([]);
  grantMock.mockResolvedValue({ id: 'ra-1', principalId: 'p1', principalType: 'User', roleDefinitionId: 'rd' } as any);
  revokeMock.mockResolvedValue(undefined as any);
});
afterEach(() => {
  if (savedSub === undefined) delete process.env.LOOM_SUBSCRIPTION_ID;
  else process.env.LOOM_SUBSCRIPTION_ID = savedSub;
});

describe('POST /share — the role-grant half', () => {
  it('401s when unauthenticated and grants NOTHING', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlArm(FOREIGN), database: 'victim-db', ...GRANT }), PARAMS);
    expect(r.status).toBe(401);
    expect(grantMock).not.toHaveBeenCalled();
  });

  //   MUTATION: replace withBoundSqlServer with a bare `getSession()` prologue.
  it('404s a caller who does NOT own the item, granting NOTHING', async () => {
    loadOwnedItemMock.mockResolvedValueOnce(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlArm(FOREIGN), database: 'victim-db', ...GRANT }), PARAMS);
    expect(r.status).toBe(404);
    expect(grantMock).not.toHaveBeenCalled();
  });

  it('stays WRITE-scoped — a read-only viewer can never grant a role', async () => {
    const { POST } = await import('../route');
    await POST(postReq(GRANT), PARAMS);
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] as { allowReadRoles?: boolean } | undefined;
    expect(opts?.allowReadRoles).toBeFalsy();
  });

  //   MUTATION: `grantDatabaseRole(String(body.server), String(body.database), …)`.
  it('403s a body server/database that differ from the binding, granting NOTHING', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlArm(GOVERNED, 'other-srv'), database: 'db', ...GRANT }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_mismatch');
    expect(grantMock).not.toHaveBeenCalled();
  });

  it('403s a body ARM id in an ungoverned subscription, granting NOTHING', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlArm(FOREIGN), database: 'db', ...GRANT }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(grantMock).not.toHaveBeenCalled();
  });

  //   MUTATION: delete the `admitGovernedServer(submittedServer, …)` block.
  it('403s a body ARM id for a SAME-NAMED server in an ungoverned subscription', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlArm(FOREIGN, 'srv'), database: 'db', ...GRANT }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(grantMock).not.toHaveBeenCalled();
  });

  it('403s an item BOUND to an ungoverned server even when the body agrees', async () => {
    loadOwnedItemMock.mockResolvedValueOnce({
      ...OWNED_ITEM, state: { connection: { server: sqlArm(FOREIGN), database: 'db' } },
    } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlArm(FOREIGN), database: 'db', ...GRANT }), PARAMS);
    expect(r.status).toBe(403);
    expect(grantMock).not.toHaveBeenCalled();
  });

  it('409s an unbound item rather than granting on a body-chosen database', async () => {
    loadOwnedItemMock.mockResolvedValueOnce({ ...OWNED_ITEM, state: {} } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlArm(FOREIGN), database: 'victim-db', ...GRANT }), PARAMS);
    expect(r.status).toBe(409);
    expect(grantMock).not.toHaveBeenCalled();
  });

  it('CONTROL: the owner grants on their OWN bound database', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: 'srv', database: 'db', principalId: 'p1', roleNameOrGuid: 'Reader', principalType: 'Group' }), PARAMS);
    expect(r.status).toBe(200);
    expect(grantMock).toHaveBeenCalledWith('srv', 'db', 'p1', 'Reader', 'Group');
  });

  // THE REBINDING MUTATION CATCHER.
  //   MUTATION: `grantDatabaseRole(String(body?.server || server), …)`.
  it('grants on the BOUND server even when the body names it in another form', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlArm(GOVERNED, 'srv'), database: 'db', ...GRANT }), PARAMS);
    expect(r.status).toBe(200);
    expect(grantMock).toHaveBeenCalledWith('srv', 'db', 'attacker-oid', 'SQL DB Contributor', 'User');
  });

  it('still validates the principal fields it owns', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ principalId: 'p1' }), PARAMS);
    expect(r.status).toBe(400);
    expect(grantMock).not.toHaveBeenCalled();
  });
});

describe('GET /share — the listing half', () => {
  it('401s when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { GET } = await import('../route');
    expect((await GET(getReq('?server=victim&database=victim'), PARAMS)).status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
  });

  //   MUTATION: `listDatabaseRoleAssignments(qs.server, qs.database)`.
  it('403s a query-string server that differs from the binding, listing NOTHING', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(sqlArm(GOVERNED, 'other-srv'))}&database=db`), PARAMS);
    expect(r.status).toBe(403);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('403s an ungoverned query-string ARM id, listing NOTHING', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(sqlArm(FOREIGN))}&database=db`), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(listMock).not.toHaveBeenCalled();
  });

  // Listing is read-only, so a shared VIEWER may see it — asserted so the
  // read/write split is deliberate rather than incidental.
  it('CONTROL: admits read roles and lists the item’s OWN bound database', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq('?server=srv&database=db'), PARAMS);
    expect(r.status).toBe(200);
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] as { allowReadRoles?: boolean } | undefined;
    expect(opts?.allowReadRoles).toBe(true);
    expect(listMock).toHaveBeenCalledWith('srv', 'db');
  });

  it('lists the BOUND server even when the query names it in another form', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(sqlArm(GOVERNED, 'srv'))}&database=db`), PARAMS);
    expect(r.status).toBe(200);
    expect(listMock).toHaveBeenCalledWith('srv', 'db');
  });
});

describe('DELETE /share — the raw ARM-DELETE primitive', () => {
  it('401s when unauthenticated and revokes NOTHING', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { DELETE } = await import('../route');
    const r = await DELETE(delReq(`?assignmentId=${encodeURIComponent(assignmentId('victim', 'victim-db', FOREIGN))}`), PARAMS);
    expect(r.status).toBe(401);
    expect(revokeMock).not.toHaveBeenCalled();
  });

  //   MUTATION: `revokeDatabaseRoleAssignment(qs.assignmentId)` without admission.
  it('403s an assignment on another tenant’s database, revoking NOTHING', async () => {
    const { DELETE } = await import('../route');
    const r = await DELETE(delReq(`?assignmentId=${encodeURIComponent(assignmentId('victim-srv', 'victim-db'))}`), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('assignment_out_of_scope');
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it('403s an assignment on the right server but a DIFFERENT database', async () => {
    const { DELETE } = await import('../route');
    const r = await DELETE(delReq(`?assignmentId=${encodeURIComponent(assignmentId('srv', 'other-db'))}`), PARAMS);
    expect(r.status).toBe(403);
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it('403s an assignment in an ungoverned subscription', async () => {
    const { DELETE } = await import('../route');
    const r = await DELETE(delReq(`?assignmentId=${encodeURIComponent(assignmentId('srv', 'db', FOREIGN))}`), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(revokeMock).not.toHaveBeenCalled();
  });

  // The genuinely dangerous grants live at subscription / RG scope, not on a
  // database — so a non-database scope must be refused outright.
  it('403s a subscription-scoped assignment id', async () => {
    const subScoped = `/subscriptions/${GOVERNED}/providers/Microsoft.Authorization/roleAssignments/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
    const { DELETE } = await import('../route');
    const r = await DELETE(delReq(`?assignmentId=${encodeURIComponent(subScoped)}`), PARAMS);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it('CONTROL: the owner revokes an assignment on their OWN bound database', async () => {
    const id = assignmentId('srv', 'db');
    const { DELETE } = await import('../route');
    const r = await DELETE(delReq(`?assignmentId=${encodeURIComponent(id)}`), PARAMS);
    expect(r.status).toBe(200);
    expect(revokeMock).toHaveBeenCalledWith(id);
  });
});
