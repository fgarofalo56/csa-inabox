/**
 * GHSA-v8r7-c2p5-mjf2 — POST /api/items/azure-sql-database/[id]/sql2025-features.
 *
 * BEFORE `body.server` + `body.database` went to `enableSqlServer2025Features`
 * under a bare `getSession()`. The probe returns a version string, so the
 * interesting primitive is not the response — it is the CONNECTION. The call
 * reaches TDS through `azure-sql-client.getPool`, which composes
 * `server.includes('.') ? server : <name>.<suffix>` and then presents an Entra
 * ACCESS TOKEN for the SQL scope to whatever host that yields. A body carrying
 * an external FQDN therefore egressed a live credential, and the version string
 * came back as the oracle telling the caller it had connected.
 *
 * So the load-bearing spec here is the FQDN one, not the ownership one.
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

const enableSqlServer2025FeaturesMock = vi.fn(async () => ({ ok: true, major: 17, version: 'Microsoft SQL Azure 17.0' }));
vi.mock('@/lib/azure/azure-sql-client', () => ({
  enableSqlServer2025Features: (...a: any[]) => enableSqlServer2025FeaturesMock(...a),
}));

const PARAMS = { params: Promise.resolve({ id: 'item1' }) } as any;
function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/items/azure-sql-database/item1/sql2025-features', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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

describe('POST /api/items/azure-sql-database/[id]/sql2025-features — probe target authorization', () => {
  it('401s when unauthenticated and opens NO connection', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: 'attacker.example.com', database: 'db' }), PARAMS);
    expect(r.status).toBe(401);
    expect(enableSqlServer2025FeaturesMock).not.toHaveBeenCalled();
  });

  //   MUTATION: restore the `getSession()` prologue reading body.server/body.database.
  it('404s a caller who does NOT own the item, opening NO connection', async () => {
    // mockResolvedValue, NOT ...Once — the wrapper tries every SQL_EDITOR_ITEM_TYPE.
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, database: 'victim-db' }), PARAMS);
    expect(r.status).toBe(404);
    expect(enableSqlServer2025FeaturesMock).not.toHaveBeenCalled();
  });

  // THE CREDENTIAL-EGRESS SPEC. A body FQDN is what `getPool` would have used
  // verbatim as the TDS host and presented an Entra token to.
  //   MUTATION: `enableSqlServer2025Features(String(body.server || server), …)`.
  it('never sends a body-supplied external FQDN to the TDS client', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: 'attacker.example.com', database: 'db' }), PARAMS);
    // 'attacker' !== 'srv', so this is refused outright as a mismatch.
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_mismatch');
    expect(enableSqlServer2025FeaturesMock).not.toHaveBeenCalled();
  });

  // And when the FQDN is in the BINDING (which the item's owner can write), it
  // is reduced to its first DNS label, so the composed host is always inside the
  // cloud's SQL suffix.
  //   MUTATION: return `scoped(raw)` in admitGovernedServer's bare-name branch.
  it('reduces a bound external FQDN to its first label before it reaches TDS', async () => {
    loadOwnedItemMock.mockResolvedValue({
      ...OWNED_ITEM, state: { connection: { family: 'azure-sql', server: 'attacker.example.com', database: 'db' } },
    } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({}), PARAMS);
    expect(r.status).toBe(200);
    expect(enableSqlServer2025FeaturesMock).toHaveBeenCalledWith('attacker', 'db');
    expect(enableSqlServer2025FeaturesMock).not.toHaveBeenCalledWith('attacker.example.com', 'db');
  });

  it('403s a body ARM id in an ungoverned subscription', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, database: 'db' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(enableSqlServer2025FeaturesMock).not.toHaveBeenCalled();
  });

  it('403s an item BOUND to an ungoverned subscription even when the body agrees', async () => {
    loadOwnedItemMock.mockResolvedValue({
      ...OWNED_ITEM, state: { connection: { family: 'azure-sql', server: foreignId, database: 'db' } },
    } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, database: 'db' }), PARAMS);
    expect(r.status).toBe(403);
    expect(enableSqlServer2025FeaturesMock).not.toHaveBeenCalled();
  });

  it('403s a body database that differs from the binding', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: 'srv', database: 'victim-db' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('database_mismatch');
    expect(enableSqlServer2025FeaturesMock).not.toHaveBeenCalled();
  });

  it('409s an item with no bound connection', async () => {
    loadOwnedItemMock.mockResolvedValue({ ...OWNED_ITEM, state: {} } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: 'srv', database: 'db' }), PARAMS);
    expect(r.status).toBe(409);
    expect(enableSqlServer2025FeaturesMock).not.toHaveBeenCalled();
  });

  it('CONTROL: the owner probes their OWN bound database', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: 'srv', database: 'db' }), PARAMS);
    expect(r.status).toBe(200);
    expect(enableSqlServer2025FeaturesMock).toHaveBeenCalledWith('srv', 'db');
  });

  // THE REBINDING MUTATION CATCHER — a DIFFERENT FORM of the same server.
  it('probes the BOUND server even when the body names it in another form', async () => {
    const governedId = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/srv`;
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: governedId, database: 'db' }), PARAMS);
    expect(r.status).toBe(200);
    expect(enableSqlServer2025FeaturesMock).toHaveBeenCalledWith('srv', 'db');
  });
});
