/**
 * GHSA-v8r7-c2p5-mjf2 — POST /api/items/azure-sql-database/[id]/create-db.
 *
 * BEFORE this was `POST(req)` + `getSession()` with `[id]` never read and
 * `server` taken from the body. `azure-sql-client.createDatabase` branches
 * `spec.server.startsWith('/') ? spec.server : defaultServerScope(...)`, so a
 * full ARM resource id skipped the subscription pin and provisioned a database
 * — billable, and a foothold on that server — into ANY subscription the Console
 * UAMI held Contributor / SQL DB Contributor in, including a brownfield-adopted
 * customer server (`deploy-integrity.md` R5).
 *
 * LAYER 1 + LAYER 3, NOT LAYER 2, and the specs assert BOTH halves of that
 * choice. The server here is a genuine PICK — the database does not exist yet,
 * so there is nothing bound to resolve, and provisioning onto a server the item
 * is not bound to is the feature. So a governed server that differs from the
 * item's binding must SUCCEED (the Layer-2-would-break-this control), while an
 * ungoverned one must be refused.
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
  id: 'item1', workspaceId: 'ws1', itemType: 'azure-sql-database',
  displayName: 'Mine', state: { connection: { family: 'azure-sql', server: 'sql1', database: 'db1' } },
} as any;
const loadOwnedItemMock = vi.fn(async () => OWNED_ITEM);
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a),
}));

vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn(), enforceCapability: vi.fn() }));
vi.mock('@/lib/auth/dlz-gate', () => ({ denyIfNoDlzAccess: vi.fn() }));
vi.mock('@/lib/gates/registry', () => ({ getGate: vi.fn(), gateStatus: vi.fn() }));

const createDatabaseMock = vi.fn(async () => ({ ok: true, id: '/subscriptions/x/db', status: 'Creating' }) as any);
vi.mock('@/lib/azure/azure-sql-client', () => ({
  createDatabase: (...a: any[]) => createDatabaseMock(...a),
}));

const PARAMS = { params: Promise.resolve({ id: 'item1' }) } as any;
const BASE = 'http://localhost/api/items/azure-sql-database/item1/create-db';
const postReq = (body: unknown) => new NextRequest(BASE, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

let savedSub: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  savedSub = process.env.LOOM_SUBSCRIPTION_ID;
  process.env.LOOM_SUBSCRIPTION_ID = GOVERNED;
  getSessionMock.mockReturnValue({ claims: { oid: OID, upn: 'owner@loom.test', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 } as any);
  loadOwnedItemMock.mockResolvedValue(OWNED_ITEM);
  createDatabaseMock.mockResolvedValue({ ok: true, id: '/subscriptions/x/db', status: 'Creating' } as any);
});
afterEach(() => {
  if (savedSub === undefined) delete process.env.LOOM_SUBSCRIPTION_ID; else process.env.LOOM_SUBSCRIPTION_ID = savedSub;
});

describe('POST .../azure-sql-database/[id]/create-db — provisioning authorization', () => {
  it('401s when unauthenticated and provisions NOTHING', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, name: 'pwned' }), PARAMS);
    expect(r.status).toBe(401);
    expect(createDatabaseMock).not.toHaveBeenCalled();
  });

  //   MUTATION: restore the `getSession()` prologue reading body.server.
  it('404s a caller who does NOT own the item — provisions NOTHING on a foreign server', async () => {
    // mockResolvedValue, NOT ...Once — `withOwnedSqlItem` tries every
    // SQL_EDITOR_ITEM_TYPE (six since #3639), so a single-shot null is satisfied
    // by the second candidate and this spec would pass while testing nothing.
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, name: 'pwned' }), PARAMS);
    expect(r.status).toBe(404);
    expect(createDatabaseMock).not.toHaveBeenCalled();
  });

  //   MUTATION: add `allowReadRoles: true` to the wrapper options.
  it('stays WRITE-scoped — a workspace reader cannot provision', async () => {
    const { POST } = await import('../route');
    await POST(postReq({ server: 'sql1', name: 'db2' }), PARAMS);
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] as { allowReadRoles?: boolean } | undefined;
    expect(opts?.allowReadRoles).toBeFalsy();
  });

  //   MUTATION: drop the `admitPickedServer` call and pass `body.server` through.
  it('403s a server ARM id in an ungoverned subscription, provisioning NOTHING', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, name: 'pwned' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(createDatabaseMock).not.toHaveBeenCalled();
  });

  // PROVIDER PINNING — a PostgreSQL flexible-server id must not reach the Azure
  // SQL ARM client even inside a governed subscription.
  //   MUTATION: `admitPickedServer(body?.server, 'postgres', …)`.
  it('403s a governed ARM id of the WRONG resource type', async () => {
    const pgId = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.DBforPostgreSQL/flexibleServers/sql1`;
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: pgId, name: 'db2' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_type_mismatch');
    expect(createDatabaseMock).not.toHaveBeenCalled();
  });

  it('400s a missing server with a message about the PICK, not about a binding', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ name: 'db2' }), PARAMS);
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.code).toBe('server_required');
    // `admitGovernedServer`'s own empty-value refusal says "This item has no
    // bound server", which would be a FALSE statement on a route that resolves
    // no binding. `admitPickedServer`'s `missing` override is what prevents it.
    expect(String(j.error)).not.toMatch(/bound/i);
    expect(createDatabaseMock).not.toHaveBeenCalled();
  });

  // THE LAYER-2-WOULD-BREAK-THIS CONTROL. Provisioning onto a server the item is
  // NOT bound to is the whole point of this route: the item is bound to `sql1`,
  // and creating on `other-sql` must succeed because it is governed.
  //   MUTATION: swap `withOwnedSqlItem` + `admitPickedServer` for
  //   `withBoundSqlServer` — this spec turns 403 `server_mismatch`.
  it('CONTROL: provisions onto a GOVERNED server that differs from the item binding', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: governedId, name: 'db2', skuName: 'S0' }), PARAMS);
    expect(r.status).toBe(201);
    expect(createDatabaseMock.mock.calls[0][0]).toMatchObject({ server: governedId, name: 'db2', skuName: 'S0' });
  });

  it('CONTROL: a bare governed server name provisions, and the receipt names the caller', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: 'sql1', name: 'db2' }), PARAMS);
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.provisionedBy).toBe('owner@loom.test');
    expect(createDatabaseMock.mock.calls[0][0].server).toBe('sql1');
  });

  // An FQDN is reduced to its first DNS label before it reaches the ARM client,
  // so a bound/picked value can only ever name a host in this cloud's SQL suffix.
  it('reduces an FQDN pick to its first DNS label', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: 'sql1.database.windows.net', name: 'db2' }), PARAMS);
    expect(r.status).toBe(201);
    expect(createDatabaseMock.mock.calls[0][0].server).toBe('sql1');
  });

  it('still validates the fields it owns — name, collation, backup redundancy', async () => {
    const { POST } = await import('../route');
    const noName = await POST(postReq({ server: 'sql1' }), PARAMS);
    expect(noName.status).toBe(400);
    const badCollation = await POST(postReq({ server: 'sql1', name: 'db2', collation: "x'; DROP" }), PARAMS);
    expect(badCollation.status).toBe(400);
    expect(createDatabaseMock).not.toHaveBeenCalled();

    const bogusRedundancy = await POST(postReq({ server: 'sql1', name: 'db2', requestedBackupStorageRedundancy: 'Nope' }), PARAMS);
    expect(bogusRedundancy.status).toBe(201);
    expect(createDatabaseMock.mock.calls[0][0].requestedBackupStorageRedundancy).toBeUndefined();
  });
});

describe('maintenanceConfigurationId shape check', () => {
  // The value is copied verbatim into the ARM PUT body. It cannot redirect the
  // PUT (the scope is already admitted), so this is defence-in-depth against an
  // arbitrary caller string reaching an ARM body — asserted as such, not as a
  // subscription pin.
  it('rejects an arbitrary resource id smuggled into the ARM body', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({
      server: 'sql1', name: 'db2',
      maintenanceConfigurationId: `/subscriptions/${FOREIGN}/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/victim`,
    }), PARAMS);
    expect(r.status).toBe(400);
    expect(createDatabaseMock).not.toHaveBeenCalled();
  });

  // BOTH ARM FORMS. Public maintenance configurations are subscription-scoped
  // with NO resource group, which is the shape the repo's own create-db payload
  // fixtures use — a first draft of the regex required an RG and would have
  // rejected every real value. Both are accepted, and both are asserted, so a
  // future tightening cannot silently break the create flow.
  it('accepts the real subscription-scoped form (no resource group)', async () => {
    const { POST } = await import('../route');
    const id = `/subscriptions/${GOVERNED}/providers/Microsoft.Maintenance/publicMaintenanceConfigurations/SQL_EastUS2_DB_1`;
    const r = await POST(postReq({ server: 'sql1', name: 'db2', maintenanceConfigurationId: id }), PARAMS);
    expect(r.status).toBe(201);
    expect(createDatabaseMock.mock.calls[0][0].maintenanceConfigurationId).toBe(id);
  });

  it('accepts the resource-group-qualified form too', async () => {
    const { POST } = await import('../route');
    const id = `/subscriptions/${GOVERNED}/resourceGroups/rg-maint/providers/Microsoft.Maintenance/publicMaintenanceConfigurations/SQL_EastUS2_DB_2`;
    const r = await POST(postReq({ server: 'sql1', name: 'db2', maintenanceConfigurationId: id }), PARAMS);
    expect(r.status).toBe(201);
    expect(createDatabaseMock.mock.calls[0][0].maintenanceConfigurationId).toBe(id);
  });
});
