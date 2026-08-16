/**
 * GHSA-v8r7-c2p5-mjf2 — POST /api/items/azure-sql-database/[id]/mirroring.
 *
 * BEFORE this was the worst of the thirteen routes the first pass left, and it
 * is an EXFILTRATION primitive rather than a DDL one:
 *
 *   - `enableMirroring(body.server, body.database)` ran at line 41 under a bare
 *     `withSession` — real DDL on a caller-named database before any ownership
 *     check existed.
 *   - `loadOwnedItem` was not called until line 56, only inside the
 *     `LOOM_BRONZE_URL` branch, and FAILING it returned `ok: true` with a note.
 *   - Lines 70-80 then built `MirrorSource` from `body.server`/`body.database`
 *     and called `runMirrorSnapshot(id, owned.workspaceId, src, …)` — a full TDS
 *     READ of the caller-named database landed into the CALLER'S OWN workspace
 *     Bronze folder.
 *
 * So there are TWO halves to prove, and the DDL half alone is not the finding.
 * Every snapshot spec below therefore asserts on `runMirrorSnapshotMock`
 * separately from `enableMirroringMock`, and the file runs with LOOM_BRONZE_URL
 * SET so the snapshot branch is actually reached — with it unset the whole
 * exfiltration path is dead code and every spec would pass vacuously.
 *
 * Each spec names the mutation that turns it red, and there are passing CONTROLs
 * in the other direction: a fix that refuses real users is not a fix.
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

const enableMirroringMock = vi.fn(async () => ({ enabled: true, backend: 'azure-native-cdc', state: 'Initializing' }));
vi.mock('@/lib/azure/azure-sql-client', () => ({
  enableMirroring: (...a: any[]) => enableMirroringMock(...a),
}));

const runMirrorSnapshotMock = vi.fn(async () => ({
  ok: true, status: 'Succeeded', backend: 'azure-native-cdc', basePath: 'mirrors/ws1/item1/', tables: [],
}));
vi.mock('@/lib/azure/mirror-engine', () => ({
  runMirrorSnapshot: (...a: any[]) => runMirrorSnapshotMock(...a),
}));

const replaceMock = vi.fn(async () => ({}));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({ item: () => ({ replace: (...a: any[]) => replaceMock(...a) }) }),
}));

const PARAMS = { params: Promise.resolve({ id: 'item1' }) } as any;
function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/items/azure-sql-database/item1/mirroring', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let savedSub: string | undefined;
let savedBronze: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  savedSub = process.env.LOOM_SUBSCRIPTION_ID;
  savedBronze = process.env.LOOM_BRONZE_URL;
  process.env.LOOM_SUBSCRIPTION_ID = GOVERNED;
  // SET DELIBERATELY: the snapshot branch — the exfiltration half — only runs
  // when Bronze is configured. Unset, every snapshot assertion below would pass
  // for the wrong reason.
  process.env.LOOM_BRONZE_URL = 'https://lake.dfs.core.windows.net/bronze';
  getSessionMock.mockReturnValue({ claims: { oid: OID, upn: 'owner@loom.test', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 } as any);
  loadOwnedItemMock.mockResolvedValue(OWNED_ITEM);
});
afterEach(() => {
  if (savedSub === undefined) delete process.env.LOOM_SUBSCRIPTION_ID; else process.env.LOOM_SUBSCRIPTION_ID = savedSub;
  if (savedBronze === undefined) delete process.env.LOOM_BRONZE_URL; else process.env.LOOM_BRONZE_URL = savedBronze;
});

describe('POST /api/items/azure-sql-database/[id]/mirroring — server authorization', () => {
  it('401s when unauthenticated, running NO DDL and NO snapshot', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, database: 'victim-db' }), PARAMS);
    expect(r.status).toBe(401);
    expect(enableMirroringMock).not.toHaveBeenCalled();
    expect(runMirrorSnapshotMock).not.toHaveBeenCalled();
  });

  // LAYER 1 — the caller must own the [id] item. BEFORE, ownership was checked
  // AFTER the DDL and only in the Bronze branch, where failing it returned 200.
  //   MUTATION: restore the bare `withSession` prologue.
  it('404s a caller who does NOT own the item — no DDL, no snapshot, and NOT ok:true', async () => {
    // mockResolvedValue, NOT ...Once: the wrapper tries EVERY type in
    // SQL_EDITOR_ITEM_TYPES, so a single null is satisfied by the next candidate
    // and this spec would silently stop testing not-owned.
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, database: 'victim-db' }), PARAMS);
    expect(r.status).toBe(404);
    expect(enableMirroringMock).not.toHaveBeenCalled();
    expect(runMirrorSnapshotMock).not.toHaveBeenCalled();
    // The specific old shape: a failed ownership check that answered ok:true.
    expect((await r.json()).ok).not.toBe(true);
  });

  // Mirroring runs DDL and moves data — a read-only viewer must never reach it.
  //   MUTATION: add `allowReadRoles: true` to the wrapper options.
  it('stays WRITE-scoped — no allowReadRoles on the owner check', async () => {
    const { POST } = await import('../route');
    await POST(postReq({}), PARAMS);
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] as { allowReadRoles?: boolean } | undefined;
    expect(opts?.allowReadRoles).toBeFalsy();
  });

  // LAYER 2 — the body can never CHOOSE the target. A different server that IS
  // inside the governed subscription, to isolate the mismatch refusal from the
  // Layer 3 admission refusal exercised below.
  //   MUTATION: `enableMirroring(String(body.server), …)`.
  it('403s a body server that differs from the binding — no DDL, no snapshot', async () => {
    const otherGoverned = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/other-srv`;
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: otherGoverned, database: 'db' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_mismatch');
    expect(enableMirroringMock).not.toHaveBeenCalled();
    expect(runMirrorSnapshotMock).not.toHaveBeenCalled();
  });

  it('403s a body ARM id in an ungoverned subscription — no DDL, no snapshot', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, database: 'db' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(enableMirroringMock).not.toHaveBeenCalled();
    expect(runMirrorSnapshotMock).not.toHaveBeenCalled();
  });

  // SAME NAME, DIFFERENT SUBSCRIPTION. `serverRefsMatch` compares NAMES, so this
  // body "matches" the bound bare name `srv`; only admitting the SUBMITTED value
  // against the governed scope first refuses it.
  //   MUTATION: delete the `admitGovernedServer(submittedServer, …)` block in
  //   withBoundSqlServer → this becomes a 200.
  it('403s a body ARM id for a SAME-NAMED server in an ungoverned subscription', async () => {
    const sameName = `/subscriptions/${FOREIGN}/resourceGroups/rg-victim/providers/Microsoft.Sql/servers/srv`;
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sameName, database: 'db' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(runMirrorSnapshotMock).not.toHaveBeenCalled();
  });

  // THE EXFILTRATION SPEC. A body naming a foreign DATABASE on the item's OWN
  // bound server passes every server-side check — this is the shape that read a
  // victim database into the caller's Bronze folder.
  //   MUTATION: `database: String(body.database)` in the MirrorSource literal.
  it('403s a body database that differs from the binding — reads NOTHING', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: 'srv', database: 'victim-db' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('database_mismatch');
    expect(runMirrorSnapshotMock).not.toHaveBeenCalled();
  });

  // LAYER 3 — the load-bearing one. The binding is caller-writable (POST
  // /connect, createOwnedItem's arbitrary state, PATCH /api/items/[type]/[id]),
  // so the real move is to BIND a foreign server and then agree with it.
  //   MUTATION: delete the admitGovernedServer call in withBoundSqlServer.
  it('403s an item BOUND to an ungoverned subscription even when the body agrees', async () => {
    loadOwnedItemMock.mockResolvedValueOnce({
      ...OWNED_ITEM, state: { connection: { family: 'azure-sql', server: foreignId, database: 'db' } },
    } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, database: 'db' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(enableMirroringMock).not.toHaveBeenCalled();
    expect(runMirrorSnapshotMock).not.toHaveBeenCalled();
  });

  // CREDENTIAL EGRESS. `azure-sql-client.getPool` composes
  // `server.includes('.') ? server : <name>.<suffix>` and presents an Entra
  // ACCESS TOKEN to the result, so a bound external FQDN sent a live credential
  // to an attacker host. `admitGovernedServer` reduces an FQDN to its first DNS
  // label, so no reachable value can name a host outside the SQL suffix.
  //   MUTATION: return `scoped(raw)` instead of `scoped(label)` in
  //   admitGovernedServer's bare-name branch.
  it('never lets a bound external FQDN reach TDS whole — the host label only', async () => {
    loadOwnedItemMock.mockResolvedValueOnce({
      ...OWNED_ITEM, state: { connection: { family: 'azure-sql', server: 'attacker.example.com', database: 'db' } },
    } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({}), PARAMS);
    expect(r.status).toBe(200);
    expect(enableMirroringMock).toHaveBeenCalledWith('attacker', 'db');
    expect(enableMirroringMock).not.toHaveBeenCalledWith('attacker.example.com', 'db');
    expect(runMirrorSnapshotMock.mock.calls[0][2]).toMatchObject({ server: 'attacker' });
  });

  it('409s an item with no bound connection rather than mirroring a body-chosen database', async () => {
    loadOwnedItemMock.mockResolvedValueOnce({ ...OWNED_ITEM, state: {} } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: foreignId, database: 'victim-db' }), PARAMS);
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('no_bound_connection');
    expect(enableMirroringMock).not.toHaveBeenCalled();
    expect(runMirrorSnapshotMock).not.toHaveBeenCalled();
  });

  it('409s an item bound to a server but no database', async () => {
    loadOwnedItemMock.mockResolvedValueOnce({
      ...OWNED_ITEM, state: { connection: { family: 'azure-sql', server: 'srv' } },
    } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ database: 'victim-db' }), PARAMS);
    expect(r.status).toBe(409);
    expect(runMirrorSnapshotMock).not.toHaveBeenCalled();
  });

  // ---- the legitimate-owner direction ----
  it('CONTROL: the owner mirrors their OWN bound database, DDL + snapshot both run', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: 'srv', database: 'db' }), PARAMS);
    expect(r.status).toBe(200);
    expect(enableMirroringMock).toHaveBeenCalledWith('srv', 'db');
    expect(runMirrorSnapshotMock).toHaveBeenCalledWith(
      'item1', 'ws1', expect.objectContaining({ sourceType: 'AzureSqlDatabase', server: 'srv', database: 'db' }),
      expect.anything(), { tenantId: OID },
    );
  });

  it('CONTROL: an omitted body server/database is fine — the target is the binding', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({}), PARAMS);
    expect(r.status).toBe(200);
    expect(enableMirroringMock).toHaveBeenCalledWith('srv', 'db');
  });

  it('CONTROL: caller-chosen `tables` still narrows the mirror — WHICH tables is the feature', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ tables: [{ schema: 'dbo', table: 't1' }] }), PARAMS);
    expect(r.status).toBe(200);
    expect(runMirrorSnapshotMock.mock.calls[0][2]).toMatchObject({ tables: [{ schema: 'dbo', table: 't1' }] });
  });

  it('CONTROL: Bronze unconfigured still enables the change feed and skips the snapshot', async () => {
    delete process.env.LOOM_BRONZE_URL;
    const { POST } = await import('../route');
    const r = await POST(postReq({}), PARAMS);
    expect(r.status).toBe(200);
    expect(enableMirroringMock).toHaveBeenCalledWith('srv', 'db');
    expect(runMirrorSnapshotMock).not.toHaveBeenCalled();
    expect((await r.json()).bronzeNote).toContain('LOOM_BRONZE_URL');
  });

  // THE REBINDING MUTATION CATCHERS. Every spec above sends the body server in
  // the SAME FORM as the binding, so `body.server ?? server` and `server` are
  // indistinguishable and a rebinding mutation stays green. Sending a DIFFERENT
  // FORM of the same server makes the two implementations produce different
  // values. Asserted for BOTH sinks, because they are separate lines.
  //   MUTATION A: `enableMirroring(String(body?.server || server), …)`.
  it('passes the BOUND server to the DDL even when the body names it in another form', async () => {
    const governedId = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/srv`;
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: governedId, database: 'db' }), PARAMS);
    expect(r.status).toBe(200);
    expect(enableMirroringMock).toHaveBeenCalledWith('srv', 'db');
  });

  //   MUTATION B: `server: String(body?.server || server)` in the MirrorSource.
  it('passes the BOUND server to the SNAPSHOT even when the body names it in another form', async () => {
    const governedId = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/srv`;
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: governedId, database: 'db' }), PARAMS);
    expect(r.status).toBe(200);
    expect(runMirrorSnapshotMock.mock.calls[0][2]).toMatchObject({ server: 'srv' });
  });

  // The snapshot's WORKSPACE is the authorized item's, not a body value — it is
  // what scopes `mirrors/<workspaceId>/<id>/`, i.e. where the read data lands.
  //   MUTATION: `runMirrorSnapshot(id, body.workspaceId ?? item.workspaceId, …)`.
  it('lands the snapshot in the AUTHORIZED item’s workspace folder, not a body-named one', async () => {
    const { POST } = await import('../route');
    await POST(postReq({ workspaceId: 'ws-victim', id: 'item-victim' }), PARAMS);
    expect(runMirrorSnapshotMock.mock.calls[0][0]).toBe('item1');
    expect(runMirrorSnapshotMock.mock.calls[0][1]).toBe('ws1');
  });
});
