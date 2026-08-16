/**
 * GHSA-v8r7-c2p5-mjf2 — POST /api/items/azure-sql-database/[id]/scale.
 *
 * BEFORE: `POST(req)` with NO `ctx` parameter at all — the route id was not
 * merely ignored, it was not accepted. `server` arrived from the body as a full
 * ARM id and `scaleDatabase` used it verbatim, so any signed-in caller could
 * change the SKU (cost + availability) of any database the Console UAMI could
 * reach, in any subscription.
 *
 * Every spec below asserts a DENIAL or a NON-CALL and names the mutation that
 * turns it red, plus a passing CONTROL in the other direction — a fix that
 * refuses real users is not a fix. Session, item ownership and the ARM client
 * are mocked; no cookies, no Cosmos, no ARM.
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

class AzureSqlError extends Error { status = 502; }
const scaleDatabaseMock = vi.fn(async () => ({ ok: true, beforeSku: { name: 'S0' }, afterSku: { name: 'S1' }, provisioningState: 'Succeeded' }));
vi.mock('@/lib/azure/azure-sql-client', () => ({
  scaleDatabase: (...a: any[]) => scaleDatabaseMock(...a),
  AzureSqlError,
}));

const PARAMS = { params: Promise.resolve({ id: 'item1' }) } as any;
function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/items/azure-sql-database/item1/scale', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const SKU = { skuName: 'S1', tier: 'Standard' };

let savedSub: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  savedSub = process.env.LOOM_SUBSCRIPTION_ID;
  process.env.LOOM_SUBSCRIPTION_ID = GOVERNED;
  getSessionMock.mockReturnValue({ claims: { oid: OID, upn: 'owner@loom.test', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 } as any);
  loadOwnedItemMock.mockResolvedValue(OWNED_ITEM);
  scaleDatabaseMock.mockResolvedValue({ ok: true, beforeSku: { name: 'S0' }, afterSku: { name: 'S1' }, provisioningState: 'Succeeded' } as any);
});
afterEach(() => {
  if (savedSub === undefined) delete process.env.LOOM_SUBSCRIPTION_ID;
  else process.env.LOOM_SUBSCRIPTION_ID = savedSub;
});

describe('POST /api/items/azure-sql-database/[id]/scale — server authorization', () => {
  it('401s when unauthenticated and never touches ARM', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, database: 'db', ...SKU }), PARAMS);
    expect(r.status).toBe(401);
    expect(scaleDatabaseMock).not.toHaveBeenCalled();
  });

  // LAYER 1 — the caller must own the [id] item.
  //   MUTATION: replace withBoundSqlServer with a bare `getSession()` prologue.
  it('404s a caller who does NOT own the item, scaling NOTHING', async () => {
    // mockResolvedValue, NOT ...Once: the wrapper tries EVERY type in
    // SQL_EDITOR_ITEM_TYPES, so a single null is satisfied by the next candidate
    // and this spec would silently stop testing not-owned.
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, database: 'victim-db', ...SKU }), PARAMS);
    expect(r.status).toBe(404);
    expect(scaleDatabaseMock).not.toHaveBeenCalled();
  });

  // Scaling is a WRITE — a read-only viewer of a shared workspace must never
  // reach it. `expect.objectContaining` elsewhere is permissive, so assert the
  // scope directly.
  //   MUTATION: `{ provider: 'sql', requireDatabase: true, allowReadRoles: true }`.
  it('stays WRITE-scoped — no allowReadRoles on the owner check', async () => {
    const { POST } = await import('../route');
    await POST(postReq(SKU), PARAMS);
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] as { allowReadRoles?: boolean } | undefined;
    expect(opts?.allowReadRoles).toBeFalsy();
  });

  // LAYER 2 — the body can never CHOOSE the target. This is the advisory's
  // headline shape: a full ARM id in `body.server`.
  //   MUTATION: `serverId: String(body.server)` in the scaleDatabase call.
  // A DIFFERENT server that IS inside the governed subscription — so this
  // isolates the Layer 2 mismatch refusal from the Layer 3 admission refusal
  // exercised by the next two specs.
  //   MUTATION: `serverId: String(body.server)` in the scaleDatabase call.
  it('403s a body server that differs from the item’s binding, scaling NOTHING', async () => {
    const otherGoverned = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/other-srv`;
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: otherGoverned, database: 'db', ...SKU }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_mismatch');
    expect(scaleDatabaseMock).not.toHaveBeenCalled();
  });

  it('403s a body ARM id in an ungoverned subscription, scaling NOTHING', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, database: 'db', ...SKU }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(scaleDatabaseMock).not.toHaveBeenCalled();
  });

  // SAME NAME, DIFFERENT SUBSCRIPTION. `serverRefsMatch` compares NAMES, and two
  // subscriptions can hold two servers called `srv` — so this body "matches" the
  // bound bare name. Measured while writing these specs: with only the name
  // comparison in the wrapper this was ADMITTED, and the route was safe purely
  // because the handler ignores `body.server`. The wrapper now admits the
  // SUBMITTED value against the governed scope before comparing it.
  //   MUTATION: delete the `admitGovernedServer(submittedServer, …)` block in
  //   withBoundSqlServer. → this becomes a 200.
  it('403s a body ARM id for a SAME-NAMED server in an ungoverned subscription', async () => {
    const sameName = `/subscriptions/${FOREIGN}/resourceGroups/rg-victim/providers/Microsoft.Sql/servers/srv`;
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sameName, database: 'db', ...SKU }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(scaleDatabaseMock).not.toHaveBeenCalled();
  });

  it('403s a body database that differs from the item’s binding', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: 'srv', database: 'victim-db', ...SKU }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('database_mismatch');
    expect(scaleDatabaseMock).not.toHaveBeenCalled();
  });

  // LAYER 3 — the load-bearing one. The binding itself is caller-writable
  // (POST /connect, POST /items, and PATCH /api/items/[type]/[id] which replaces
  // `state` wholesale), so an attacker's real move is to bind a foreign ARM id
  // and THEN call this route with a matching body — which passes Layer 2.
  //   MUTATION: delete the admitGovernedServer call in withBoundSqlServer.
  it('403s an item BOUND to a server in an ungoverned subscription, even when the body agrees', async () => {
    loadOwnedItemMock.mockResolvedValueOnce({
      ...OWNED_ITEM, state: { connection: { family: 'azure-sql', server: foreignId, database: 'db' } },
    } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, database: 'db', ...SKU }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(scaleDatabaseMock).not.toHaveBeenCalled();
  });

  it('409s an item with no bound connection rather than scaling a body-chosen database', async () => {
    loadOwnedItemMock.mockResolvedValueOnce({ ...OWNED_ITEM, state: {} } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, database: 'victim-db', ...SKU }), PARAMS);
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('no_bound_connection');
    expect(scaleDatabaseMock).not.toHaveBeenCalled();
  });

  it('409s an item bound to a server but no database', async () => {
    loadOwnedItemMock.mockResolvedValueOnce({
      ...OWNED_ITEM, state: { connection: { family: 'azure-sql', server: 'srv' } },
    } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ database: 'victim-db', ...SKU }), PARAMS);
    expect(r.status).toBe(409);
    expect(scaleDatabaseMock).not.toHaveBeenCalled();
  });

  // ---- the legitimate-owner direction ----
  it('CONTROL: the owner scales their OWN bound database', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: 'srv', database: 'db', ...SKU, capacity: 2 }), PARAMS);
    expect(r.status).toBe(200);
    expect(scaleDatabaseMock).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'srv', database: 'db', skuName: 'S1', tier: 'Standard', capacity: 2,
    }));
  });

  it('CONTROL: a governed ARM-id binding is admitted and used verbatim', async () => {
    const governedId = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/srv`;
    loadOwnedItemMock.mockResolvedValueOnce({
      ...OWNED_ITEM, state: { connection: { family: 'azure-sql', server: governedId, database: 'db' } },
    } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq(SKU), PARAMS);
    expect(r.status).toBe(200);
    expect(scaleDatabaseMock).toHaveBeenCalledWith(expect.objectContaining({ serverId: governedId }));
  });

  it('CONTROL: an omitted body server is fine — the target is the binding', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq(SKU), PARAMS);
    expect(r.status).toBe(200);
    expect(scaleDatabaseMock).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'srv', database: 'db' }));
  });

  // THE REBINDING MUTATION CATCHER. Every other spec here sends a body server
  // in the SAME FORM as the binding, so `serverId: body.server ?? server` and
  // `serverId: server` are indistinguishable and the mutation stays green —
  // measured, that is exactly what happened on the first pass of this file.
  // Sending a DIFFERENT FORM of the same server (governed ARM id vs bound bare
  // name) makes the two implementations produce different values.
  //   MUTATION: `serverId: String(body?.server || server)` → the ARM id reaches
  //   scaleDatabase and this assertion fails.
  it('passes the BOUND server to ARM even when the body names the same server in another form', async () => {
    const governedId = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/srv`;
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: governedId, database: 'db', ...SKU }), PARAMS);
    expect(r.status).toBe(200);
    expect(scaleDatabaseMock).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'srv' }));
  });

  it('still validates the SKU fields it owns', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ tier: 'Standard' }), PARAMS);
    expect(r.status).toBe(400);
    expect(scaleDatabaseMock).not.toHaveBeenCalled();
  });
});
