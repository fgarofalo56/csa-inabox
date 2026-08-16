/**
 * GHSA-v8r7-c2p5-mjf2 — POST /api/items/azure-sql-database/[id]/replication.
 *
 * BEFORE: `POST(req)` + `getSession()` with `server`, `database` AND
 * `replicaServer` all read from the body and `[id]` never read. Geo-replication
 * MOVES DATA, so with the primary caller-chosen it seeded a readable copy of any
 * database the Console UAMI could reach onto a server of the caller's choosing.
 *
 * TWO coordinates are asserted here, because `enableReplication` resolves BOTH
 * through the same `startsWith('/')` branch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

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

const enableReplicationMock = vi.fn(async () => ({ ok: true }));
vi.mock('@/lib/azure/azure-sql-client', () => ({
  enableReplication: (...a: any[]) => enableReplicationMock(...(a as [])),
}));

const PARAMS = { params: Promise.resolve({ id: 'item1' }) } as any;
const postReq = (body: unknown) => new NextRequest(
  'http://localhost/api/items/azure-sql-database/item1/replication',
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
);
const GEO = { replicaServer: 'sql-loom-dr', location: 'westus2' };

let savedSub: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  savedSub = process.env.LOOM_SUBSCRIPTION_ID;
  process.env.LOOM_SUBSCRIPTION_ID = GOVERNED;
  getSessionMock.mockReturnValue({ claims: { oid: OID, upn: 'owner@loom.test', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 } as any);
  loadOwnedItemMock.mockResolvedValue(OWNED_ITEM);
  enableReplicationMock.mockResolvedValue({ ok: true } as any);
});
afterEach(() => {
  if (savedSub === undefined) delete process.env.LOOM_SUBSCRIPTION_ID;
  else process.env.LOOM_SUBSCRIPTION_ID = savedSub;
});

describe('POST /replication — the PRIMARY coordinate', () => {
  it('401s when unauthenticated and replicates NOTHING', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlArm(FOREIGN), database: 'victim-db', ...GEO }), PARAMS);
    expect(r.status).toBe(401);
    expect(enableReplicationMock).not.toHaveBeenCalled();
  });

  //   MUTATION: replace withBoundSqlServer with a bare `getSession()` prologue.
  it('404s a caller who does NOT own the item, replicating NOTHING', async () => {
    // mockResolvedValue, NOT ...Once: the wrapper tries EVERY type in
    // SQL_EDITOR_ITEM_TYPES, so a single null is satisfied by the next candidate
    // and this spec would silently stop testing not-owned.
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlArm(FOREIGN), database: 'victim-db', ...GEO }), PARAMS);
    expect(r.status).toBe(404);
    expect(enableReplicationMock).not.toHaveBeenCalled();
  });

  it('stays WRITE-scoped', async () => {
    const { POST } = await import('../route');
    await POST(postReq(GEO), PARAMS);
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] as { allowReadRoles?: boolean } | undefined;
    expect(opts?.allowReadRoles).toBeFalsy();
  });

  //   MUTATION: `enableReplication(String(body.server), String(body.database), …)`.
  it('403s a body primary that differs from the binding — no copy of a foreign database', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlArm(GOVERNED, 'victim-srv'), database: 'db', ...GEO }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_mismatch');
    expect(enableReplicationMock).not.toHaveBeenCalled();
  });

  it('403s a body database that differs from the binding', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ database: 'victim-db', ...GEO }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('database_mismatch');
    expect(enableReplicationMock).not.toHaveBeenCalled();
  });

  // COVERAGE GAP FOUND IN REVIEW. Deleting the wrapper's submitted-value
  // admission turned 12 specs red across aad-admin / restore / scale / share /
  // query — and ZERO here, because this file's ungoverned specs all target
  // `replicaServer` and its mismatch spec uses a GOVERNED, differently-named
  // server. The wrapper did enforce it; the receipt just claimed coverage this
  // file did not have. This is that spec.
  //   MUTATION: delete the `admitGovernedServer(submittedServer, …)` block in
  //   withBoundSqlServer. → this 403 becomes a 200.
  it('403s a body PRIMARY ARM id for a SAME-NAMED server in an ungoverned subscription', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlArm(FOREIGN, 'srv'), database: 'db', ...GEO }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(enableReplicationMock).not.toHaveBeenCalled();
  });

  it('403s a body PRIMARY ARM id in an ungoverned subscription', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlArm(FOREIGN, 'other'), database: 'db', ...GEO }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(enableReplicationMock).not.toHaveBeenCalled();
  });

  it('403s an item BOUND to an ungoverned server even when the body agrees', async () => {
    loadOwnedItemMock.mockResolvedValue({
      ...OWNED_ITEM, state: { connection: { server: sqlArm(FOREIGN), database: 'db' } },
    } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlArm(FOREIGN), database: 'db', ...GEO }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(enableReplicationMock).not.toHaveBeenCalled();
  });

  it('409s an unbound item rather than replicating a body-chosen database', async () => {
    loadOwnedItemMock.mockResolvedValueOnce({ ...OWNED_ITEM, state: {} } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlArm(FOREIGN), database: 'victim-db', ...GEO }), PARAMS);
    expect(r.status).toBe(409);
    expect(enableReplicationMock).not.toHaveBeenCalled();
  });
});

describe('POST /replication — the REPLICA destination (the second ARM coordinate)', () => {
  // Pinning the primary alone leaves the DESTINATION unpinned: an ARM PUT lands
  // in whatever subscription `replicaServer` names.
  //   MUTATION: pass `replicaServer` straight through instead of admitting it.
  it('403s a replica server in an ungoverned subscription, replicating NOTHING', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ ...GEO, replicaServer: sqlArm(FOREIGN, 'attacker-dr') }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(enableReplicationMock).not.toHaveBeenCalled();
  });

  it('403s a replica id of the wrong provider type', async () => {
    const pg = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.DBforPostgreSQL/flexibleServers/pg`;
    const { POST } = await import('../route');
    const r = await POST(postReq({ ...GEO, replicaServer: pg }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_type_mismatch');
    expect(enableReplicationMock).not.toHaveBeenCalled();
  });

  it('400s a malformed replica name rather than interpolating it into an ARM path', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ ...GEO, replicaServer: 'dr/databases/master' }), PARAMS);
    expect(r.status).toBe(400);
    expect(enableReplicationMock).not.toHaveBeenCalled();
  });

  it('CONTROL: the owner replicates their OWN bound database to a governed replica', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: 'srv', database: 'db', ...GEO, replicaDatabaseName: 'db-dr', skuName: 'S1' }), PARAMS);
    expect(r.status).toBe(200);
    expect(enableReplicationMock).toHaveBeenCalledWith('srv', 'db', {
      replicaServer: 'sql-loom-dr', replicaDatabaseName: 'db-dr', location: 'westus2', skuName: 'S1',
    });
  });

  it('CONTROL: a governed ARM-id replica is admitted', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ ...GEO, replicaServer: sqlArm(GOVERNED, 'sql-loom-dr') }), PARAMS);
    expect(r.status).toBe(200);
    expect(enableReplicationMock).toHaveBeenCalledWith('srv', 'db', expect.objectContaining({
      replicaServer: sqlArm(GOVERNED, 'sql-loom-dr'),
    }));
  });

  // THE REBINDING MUTATION CATCHER for the PRIMARY.
  //   MUTATION: `enableReplication(String(body?.server || server), …)`.
  it('replicates FROM the BOUND server even when the body names it in another form', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlArm(GOVERNED, 'srv'), database: 'db', ...GEO }), PARAMS);
    expect(r.status).toBe(200);
    expect(enableReplicationMock).toHaveBeenCalledWith('srv', 'db', expect.anything());
  });

  it('still requires replicaServer + location', async () => {
    const { POST } = await import('../route');
    expect((await POST(postReq({ location: 'westus2' }), PARAMS)).status).toBe(400);
    expect((await POST(postReq({ replicaServer: 'dr' }), PARAMS)).status).toBe(400);
    expect(enableReplicationMock).not.toHaveBeenCalled();
  });
});
