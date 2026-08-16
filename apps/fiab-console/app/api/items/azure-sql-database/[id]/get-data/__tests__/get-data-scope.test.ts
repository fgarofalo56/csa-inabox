/**
 * GHSA-v8r7-c2p5-mjf2 — POST /api/items/azure-sql-database/[id]/get-data.
 *
 * BEFORE `server`, `database` AND `serverFqdn` arrived in the body under a bare
 * `getSession()`. `serverFqdn` was the sharpest: `resolveFqdn` returned it
 * VERBATIM whenever it contained a dot, and it landed inside the ADF linked
 * service's connection string as `Data Source=tcp:<fqdn>,1433` with
 * `authenticationType: SystemAssignedManagedIdentity`. The factory is env-pinned,
 * so those artifacts were planted in the DEPLOYMENT'S OWN shared Data Factory,
 * pointed at a host of the caller's choosing.
 *
 * The `serverFqdn` field is now GONE and the FQDN is derived from the admitted
 * binding, so the specs below assert on the CONNECTION STRING, not just on the
 * route's status code — a fix that refused the body but still composed the
 * attacker's host would pass a status-only assertion.
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

const upsertLinkedServiceMock = vi.fn(async () => ({}));
const upsertDatasetMock = vi.fn(async () => ({}));
const upsertPipelineMock = vi.fn(async () => ({}));
const upsertDataFlowMock = vi.fn(async () => ({}));
vi.mock('@/lib/azure/adf-client', () => ({
  adfConfigGate: () => null,
  factoryResourceId: () => '/subscriptions/s/resourceGroups/rg/providers/Microsoft.DataFactory/factories/f',
  defaultFactoryName: () => 'loom-adf',
  getDefaultFactory: async () => ({ properties: { publicNetworkAccess: 'Disabled' } }),
  upsertLinkedService: (...a: any[]) => upsertLinkedServiceMock(...a),
  upsertDataset: (...a: any[]) => upsertDatasetMock(...a),
  upsertPipeline: (...a: any[]) => upsertPipelineMock(...a),
  upsertDataFlow: (...a: any[]) => upsertDataFlowMock(...a),
}));
vi.mock('@/lib/azure/cloud-endpoints', () => ({
  adfStudioBase: () => 'https://adf.azure.com',
  getSqlSuffix: () => 'database.windows.net',
}));

const PARAMS = { params: Promise.resolve({ id: 'item1' }) } as any;
function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/items/azure-sql-database/item1/get-data', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
/** The connection string the linked service was upserted with, or ''. */
function lastConnectionString(): string {
  const arg = upsertLinkedServiceMock.mock.calls.at(-1)?.[1] as any;
  return arg?.properties?.typeProperties?.connectionString ?? '';
}

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

describe('POST /api/items/azure-sql-database/[id]/get-data — ADF artifact target authorization', () => {
  it('401s when unauthenticated and creates NO ADF artifact', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'new-pipeline', server: foreignId, database: 'victim-db' }), PARAMS);
    expect(r.status).toBe(401);
    expect(upsertLinkedServiceMock).not.toHaveBeenCalled();
    expect(upsertPipelineMock).not.toHaveBeenCalled();
  });

  //   MUTATION: restore the `getSession()` prologue and read server/database from the body.
  it('404s a caller who does NOT own the item, creating NO ADF artifact', async () => {
    // mockResolvedValue, NOT ...Once — the wrapper tries every SQL_EDITOR_ITEM_TYPE.
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'new-pipeline', server: foreignId, database: 'victim-db' }), PARAMS);
    expect(r.status).toBe(404);
    expect(upsertLinkedServiceMock).not.toHaveBeenCalled();
  });

  // Planting a linked service + pipeline in the shared factory is a WRITE.
  //   MUTATION: add `allowReadRoles: true`.
  it('stays WRITE-scoped — no allowReadRoles on the owner check', async () => {
    const { POST } = await import('../route');
    await POST(postReq({ action: 'copy-data' }), PARAMS);
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] as { allowReadRoles?: boolean } | undefined;
    expect(opts?.allowReadRoles).toBeFalsy();
  });

  it('403s a body server that differs from the binding, creating NO artifact', async () => {
    const otherGoverned = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/other-srv`;
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'new-pipeline', server: otherGoverned, database: 'db' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_mismatch');
    expect(upsertLinkedServiceMock).not.toHaveBeenCalled();
  });

  it('403s a body ARM id in an ungoverned subscription', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'new-pipeline', server: foreignId, database: 'db' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(upsertLinkedServiceMock).not.toHaveBeenCalled();
  });

  // THE `serverFqdn` SPEC. This body agrees with the binding on `server` and
  // `database`, so it passes every wrapper check — the ONLY thing that stops the
  // attacker host reaching the connection string is that `serverFqdn` is no
  // longer read at all.
  //   MUTATION: restore `resolveFqdn(server, String(body?.serverFqdn || ''))`.
  it('IGNORES a body serverFqdn — the connection string is derived from the binding', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({
      action: 'new-pipeline', server: 'srv', database: 'db', serverFqdn: 'attacker.example.com',
    }), PARAMS);
    expect(r.status).toBe(200);
    expect(lastConnectionString()).toContain('Data Source=tcp:srv.database.windows.net,1433');
    expect(lastConnectionString()).not.toContain('attacker.example.com');
  });

  // Same, for a bound FQDN: admitGovernedServer reduces it to its first label,
  // so even a poisoned BINDING cannot name an external host.
  //   MUTATION: return `scoped(raw)` in admitGovernedServer's bare-name branch.
  it('reduces a bound external FQDN to its first label before composing the host', async () => {
    loadOwnedItemMock.mockResolvedValue({
      ...OWNED_ITEM, state: { connection: { family: 'azure-sql', server: 'attacker.example.com', database: 'db' } },
    } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'new-pipeline' }), PARAMS);
    expect(r.status).toBe(200);
    expect(lastConnectionString()).toContain('Data Source=tcp:attacker.database.windows.net,1433');
    expect(lastConnectionString()).not.toContain('attacker.example.com');
  });

  it('403s an item BOUND to an ungoverned subscription even when the body agrees', async () => {
    loadOwnedItemMock.mockResolvedValue({
      ...OWNED_ITEM, state: { connection: { family: 'azure-sql', server: foreignId, database: 'db' } },
    } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'new-pipeline', server: foreignId, database: 'db' }), PARAMS);
    expect(r.status).toBe(403);
    expect(upsertLinkedServiceMock).not.toHaveBeenCalled();
  });

  it('409s an item with no bound connection rather than wiring a body-chosen sink', async () => {
    loadOwnedItemMock.mockResolvedValue({ ...OWNED_ITEM, state: {} } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'new-pipeline', server: foreignId, database: 'victim-db' }), PARAMS);
    expect(r.status).toBe(409);
    expect(upsertLinkedServiceMock).not.toHaveBeenCalled();
  });

  // ---- the legitimate-owner direction ----
  it('CONTROL: the owner wires a pipeline sink at their OWN bound database', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'new-pipeline', server: 'srv', database: 'db' }), PARAMS);
    expect(r.status).toBe(200);
    expect(lastConnectionString()).toContain('Initial Catalog=db');
    expect(upsertPipelineMock).toHaveBeenCalled();
  });

  it('CONTROL: copy-data returns the deep link with no artifact created', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'copy-data' }), PARAMS);
    expect(r.status).toBe(200);
    expect((await r.json()).url).toContain('copyDataTool');
    expect(upsertLinkedServiceMock).not.toHaveBeenCalled();
  });

  it('CONTROL: new-dataflow wires the same bound sink', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'new-dataflow' }), PARAMS);
    expect(r.status).toBe(200);
    expect(upsertDataFlowMock).toHaveBeenCalled();
    expect(lastConnectionString()).toContain('srv.database.windows.net');
  });

  // THE REBINDING MUTATION CATCHER — a DIFFERENT FORM of the same server.
  //   MUTATION: `resolveFqdn(String(body?.server || server))`.
  it('composes the host from the BOUND server even when the body names it in another form', async () => {
    const governedId = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/srv`;
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'new-pipeline', server: governedId, database: 'db' }), PARAMS);
    expect(r.status).toBe(200);
    // A governed ARM-id BINDING must also compose to the server's own host, not
    // to a slash-laden resource id — the reason resolveFqdn takes the last segment.
    expect(lastConnectionString()).toContain('Data Source=tcp:srv.database.windows.net,1433');
  });

  it('still validates the action it owns', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'not-an-action' }), PARAMS);
    expect(r.status).toBe(400);
    expect(upsertLinkedServiceMock).not.toHaveBeenCalled();
  });
});
