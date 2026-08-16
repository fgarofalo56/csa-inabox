/**
 * GHSA-v8r7-c2p5-mjf2 — GET/POST/DELETE
 * /api/items/postgres-flexible-server/[id]/firewall.
 *
 * BEFORE all three verbs took `server` from the request under a bare
 * `getSession()` and passed it to the ARM client verbatim (`postgres-flex-client`
 * branches `startsWith('/')`, so a full resource id skipped the subscription pin
 * entirely).
 *
 * A firewall route is a NETWORK EXPOSURE primitive, which is why the POST spec
 * below sends the 0.0.0.0-255.255.255.255 range explicitly: that exact body,
 * against any PostgreSQL flexible server the Console UAMI held a role on in ANY
 * subscription — including a brownfield-adopted customer server — opened it to
 * the internet. DELETE is the other half: removing the rules an operator relies
 * on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const OID = 'oid-owner';
const GOVERNED = '11111111-1111-1111-1111-111111111111';
const FOREIGN = '99999999-9999-9999-9999-999999999999';
const foreignId = `/subscriptions/${FOREIGN}/resourceGroups/rg-victim/providers/Microsoft.DBforPostgreSQL/flexibleServers/victim-pg`;
const OPEN_TO_WORLD = { name: 'AllowAll', startIpAddress: '0.0.0.0', endIpAddress: '255.255.255.255' };

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
const listFirewallRulesMock = vi.fn(async () => [{ name: 'r1', startIpAddress: '10.0.0.1', endIpAddress: '10.0.0.1' }]);
const upsertFirewallRuleMock = vi.fn(async () => ({ name: 'AllowAll' }));
const deleteFirewallRuleMock = vi.fn(async () => undefined);
vi.mock('@/lib/azure/postgres-flex-client', () => ({
  listFirewallRules: (...a: any[]) => listFirewallRulesMock(...a),
  upsertFirewallRule: (...a: any[]) => upsertFirewallRuleMock(...a),
  deleteFirewallRule: (...a: any[]) => deleteFirewallRuleMock(...a),
  PostgresError,
}));

const PARAMS = { params: Promise.resolve({ id: 'item1' }) } as any;
const BASE = 'http://localhost/api/items/postgres-flexible-server/item1/firewall';
const getReq = (qs = '') => new NextRequest(`${BASE}${qs}`);
const delReq = (qs = '') => new NextRequest(`${BASE}${qs}`, { method: 'DELETE' });
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
});
afterEach(() => {
  if (savedSub === undefined) delete process.env.LOOM_SUBSCRIPTION_ID; else process.env.LOOM_SUBSCRIPTION_ID = savedSub;
});

describe('POST .../postgres-flexible-server/[id]/firewall — network exposure authorization', () => {
  it('401s when unauthenticated and writes NO rule', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, ...OPEN_TO_WORLD }), PARAMS);
    expect(r.status).toBe(401);
    expect(upsertFirewallRuleMock).not.toHaveBeenCalled();
  });

  //   MUTATION: restore the `getSession()` prologue reading body.server.
  it('404s a caller who does NOT own the item — does NOT open a foreign server to the world', async () => {
    // mockResolvedValue, NOT ...Once — the wrapper tries every SQL_EDITOR_ITEM_TYPE.
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, ...OPEN_TO_WORLD }), PARAMS);
    expect(r.status).toBe(404);
    expect(upsertFirewallRuleMock).not.toHaveBeenCalled();
  });

  //   MUTATION: add `allowReadRoles: true` to the POST options.
  it('stays WRITE-scoped — a workspace reader cannot change the network posture', async () => {
    const { POST } = await import('../route');
    await POST(postReq(OPEN_TO_WORLD), PARAMS);
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] as { allowReadRoles?: boolean } | undefined;
    expect(opts?.allowReadRoles).toBeFalsy();
  });

  it('403s a body server ARM id in an ungoverned subscription, writing NO rule', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, ...OPEN_TO_WORLD }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(upsertFirewallRuleMock).not.toHaveBeenCalled();
  });

  it('403s a body server that differs from the binding', async () => {
    const otherGoverned = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.DBforPostgreSQL/flexibleServers/other-pg`;
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: otherGoverned, ...OPEN_TO_WORLD }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_mismatch');
    expect(upsertFirewallRuleMock).not.toHaveBeenCalled();
  });

  // PROVIDER PINNING. A `Microsoft.Sql/servers` id must not drive the PostgreSQL
  // ARM client, even inside a governed subscription.
  //   MUTATION: `{ provider: 'sql' }` on the POST wrapper options.
  it('403s a governed ARM id of the WRONG resource type', async () => {
    const sqlId = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/pg1`;
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlId, ...OPEN_TO_WORLD }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_type_mismatch');
    expect(upsertFirewallRuleMock).not.toHaveBeenCalled();
  });

  it('403s an item BOUND to an ungoverned subscription even when the body agrees', async () => {
    loadOwnedItemMock.mockResolvedValue({
      ...OWNED_ITEM, state: { connection: { family: 'postgres', server: foreignId } },
    } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, ...OPEN_TO_WORLD }), PARAMS);
    expect(r.status).toBe(403);
    expect(upsertFirewallRuleMock).not.toHaveBeenCalled();
  });

  it('409s an item with no bound server rather than opening a body-chosen one', async () => {
    loadOwnedItemMock.mockResolvedValue({ ...OWNED_ITEM, state: {} } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, ...OPEN_TO_WORLD }), PARAMS);
    expect(r.status).toBe(409);
    expect(upsertFirewallRuleMock).not.toHaveBeenCalled();
  });

  it('CONTROL: the owner adds a rule to their OWN bound server, IP range preserved', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: 'pg1', name: 'office', startIpAddress: '10.1.2.3', endIpAddress: '10.1.2.9' }), PARAMS);
    expect(r.status).toBe(200);
    expect(upsertFirewallRuleMock).toHaveBeenCalledWith('pg1', {
      name: 'office', startIpAddress: '10.1.2.3', endIpAddress: '10.1.2.9',
    });
  });

  it('still validates the rule fields it owns', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ name: 'x' }), PARAMS);
    expect(r.status).toBe(400);
    expect(upsertFirewallRuleMock).not.toHaveBeenCalled();
  });

  // THE REBINDING MUTATION CATCHER — a DIFFERENT FORM of the same server.
  //   MUTATION: `upsertFirewallRule(String(body?.server || server), …)`.
  it('writes to the BOUND server even when the body names it in another form', async () => {
    const governedId = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.DBforPostgreSQL/flexibleServers/pg1`;
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: governedId, ...OPEN_TO_WORLD }), PARAMS);
    expect(r.status).toBe(200);
    expect(upsertFirewallRuleMock.mock.calls[0][0]).toBe('pg1');
  });
});

describe('GET .../postgres-flexible-server/[id]/firewall', () => {
  it('404s a caller who does NOT own the item, listing NOTHING', async () => {
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(foreignId)}`), PARAMS);
    expect(r.status).toBe(404);
    expect(listFirewallRulesMock).not.toHaveBeenCalled();
  });

  it('403s a ?server in an ungoverned subscription', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(foreignId)}`), PARAMS);
    expect(r.status).toBe(403);
    expect(listFirewallRulesMock).not.toHaveBeenCalled();
  });

  // Reading your own server's network posture is a read.
  //   MUTATION: drop `allowReadRoles: true` from the GET options.
  it('CONTROL: the GET is read-role scoped and lists the BOUND server', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq(), PARAMS);
    expect(r.status).toBe(200);
    expect(listFirewallRulesMock).toHaveBeenCalledWith('pg1');
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] as { allowReadRoles?: boolean } | undefined;
    expect(opts?.allowReadRoles).toBe(true);
  });

  //   MUTATION: `listFirewallRules(url.searchParams.get('server') || server)`.
  it('lists the BOUND server even when ?server names it in another form', async () => {
    const governedId = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.DBforPostgreSQL/flexibleServers/pg1`;
    const { GET } = await import('../route');
    const r = await GET(getReq(`?server=${encodeURIComponent(governedId)}`), PARAMS);
    expect(r.status).toBe(200);
    expect(listFirewallRulesMock.mock.calls[0][0]).toBe('pg1');
  });
});

describe('DELETE .../postgres-flexible-server/[id]/firewall', () => {
  it('404s a caller who does NOT own the item, deleting NO rule', async () => {
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { DELETE } = await import('../route');
    const r = await DELETE(delReq(`?server=${encodeURIComponent(foreignId)}&rule=r1`), PARAMS);
    expect(r.status).toBe(404);
    expect(deleteFirewallRuleMock).not.toHaveBeenCalled();
  });

  it('403s a ?server in an ungoverned subscription, deleting NO rule', async () => {
    const { DELETE } = await import('../route');
    const r = await DELETE(delReq(`?server=${encodeURIComponent(foreignId)}&rule=r1`), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(deleteFirewallRuleMock).not.toHaveBeenCalled();
  });

  //   MUTATION: add `allowReadRoles: true` to the DELETE options.
  it('stays WRITE-scoped', async () => {
    const { DELETE } = await import('../route');
    await DELETE(delReq('?rule=r1'), PARAMS);
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] as { allowReadRoles?: boolean } | undefined;
    expect(opts?.allowReadRoles).toBeFalsy();
  });

  it('CONTROL: the owner deletes a rule on their OWN bound server', async () => {
    const { DELETE } = await import('../route');
    const r = await DELETE(delReq('?server=pg1&rule=r1'), PARAMS);
    expect(r.status).toBe(200);
    expect(deleteFirewallRuleMock).toHaveBeenCalledWith('pg1', 'r1');
  });

  it('still requires the rule name it owns', async () => {
    const { DELETE } = await import('../route');
    const r = await DELETE(delReq('?server=pg1'), PARAMS);
    expect(r.status).toBe(400);
    expect(deleteFirewallRuleMock).not.toHaveBeenCalled();
  });

  //   MUTATION: `deleteFirewallRule(url.searchParams.get('server') || server, rule)`.
  it('deletes on the BOUND server even when ?server names it in another form', async () => {
    const governedId = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.DBforPostgreSQL/flexibleServers/pg1`;
    const { DELETE } = await import('../route');
    const r = await DELETE(delReq(`?server=${encodeURIComponent(governedId)}&rule=r1`), PARAMS);
    expect(r.status).toBe(200);
    expect(deleteFirewallRuleMock.mock.calls[0][0]).toBe('pg1');
  });
});
