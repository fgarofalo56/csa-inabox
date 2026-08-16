/**
 * #2723 — POST /api/items/azure-sql-database/[id]/query authority binding.
 *
 * The route USED TO gate on getSession() only, read `server`/`database`/`sql`
 * from the REQUEST BODY, and never consult the `[id]` item — so any Loom-session
 * holder could run arbitrary SQL as the Console managed identity against any
 * server/database it could reach (confused-deputy / js/user-controlled-bypass).
 *
 * Every spec here asserts a DENIAL or a NON-CALL and names the mutation that
 * turns it red, plus a passing CONTROL. Session, item ownership, the rate
 * limiter, and the TDS executor are mocked — no cookies / Cosmos / TDS.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const OID = 'oid-owner';

// withWorkspaceOwner runs getSession() then loadOwnedItem(); mock both.
const getSessionMock = vi.fn(() => ({ claims: { oid: OID, upn: 'owner@loom.test', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

// Default: the caller OWNS item1, which is bound to server 'srv' / database 'db'.
const OWNED_ITEM = {
  id: 'item1', workspaceId: 'ws1', itemType: 'azure-sql-database',
  displayName: 'Mine', state: { connection: { family: 'azure-sql', server: 'srv', database: 'db' } },
} as any;
const loadOwnedItemMock = vi.fn(async () => OWNED_ITEM);
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a),
}));

// The other route-toolkit imports (only used by sibling wrappers) — stubbed so
// the module loads without pulling in the gate registry / feature-gate / dlz.
vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn() }));
vi.mock('@/lib/auth/dlz-gate', () => ({ denyIfNoDlzAccess: vi.fn() }));
vi.mock('@/lib/gates/registry', () => ({ getGate: vi.fn(), gateStatus: vi.fn() }));

const enforceRateLimitMock = vi.fn(async () => null as any);
vi.mock('@/lib/azure/rate-limiter', () => ({ enforceRateLimit: (...a: any[]) => enforceRateLimitMock(...a) }));

class AzureSqlError extends Error { status = 502; code = 'sql_error'; number = 1; }
const executeQueryBatchMock = vi.fn(async () => ({
  recordsets: [{ columns: ['n'], rows: [[1]], rowCount: 1, truncated: false }],
  messages: [], rowsAffected: [1], executionMs: 3,
}));
vi.mock('@/lib/azure/azure-sql-client', () => ({
  executeQueryBatch: (...a: any[]) => executeQueryBatchMock(...a),
  AzureSqlError,
}));

const PARAMS = { params: Promise.resolve({ id: 'item1' }) } as any;
function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/items/azure-sql-database/item1/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockReturnValue({ claims: { oid: OID, upn: 'owner@loom.test', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 } as any);
  loadOwnedItemMock.mockResolvedValue(OWNED_ITEM);
  enforceRateLimitMock.mockResolvedValue(null);
  executeQueryBatchMock.mockResolvedValue({
    recordsets: [{ columns: ['n'], rows: [[1]], rowCount: 1, truncated: false }],
    messages: [], rowsAffected: [1], executionMs: 3,
  });
});

describe('POST /api/items/azure-sql-database/[id]/query — authority binding (#2723)', () => {
  // ---- control: unauthenticated ----
  it('401s when unauthenticated and never touches SQL', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(401);
    expect(loadOwnedItemMock).not.toHaveBeenCalled();
    expect(executeQueryBatchMock).not.toHaveBeenCalled();
  });

  // (a) A caller who does NOT own the item → 404, NO SQL executed.
  //   MUTATION: change `withWorkspaceOwner('azure-sql-database', …)` back to a
  //   session-only `getSession()` prologue (or `loadItemRaw`). → this 404 becomes
  //   a 200 and executeQueryBatch runs against the body-chosen DB.
  it('(a) 404s a caller who does NOT own the item, executing NO SQL', async () => {
    loadOwnedItemMock.mockResolvedValueOnce(null);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: 'victim-srv', database: 'victim-db', sql: 'SELECT * FROM secrets' }), PARAMS);
    expect(r.status).toBe(404);
    expect(executeQueryBatchMock).not.toHaveBeenCalled();
  });

  it('(a) loads the item OWNER-scoped: id + itemType + caller oid + session', async () => {
    const { POST } = await import('../route');
    await POST(postReq({ sql: 'SELECT 1' }), PARAMS);
    // write-scoped (no allowReadRoles), session threaded for the tid boundary.
    expect(loadOwnedItemMock).toHaveBeenCalledWith(
      'item1', 'azure-sql-database', OID,
      expect.objectContaining({ session: expect.objectContaining({ claims: expect.objectContaining({ oid: OID }) }) }),
    );
  });

  // Running T-SQL is a WRITE. `expect.objectContaining` above is permissive, so
  // it does NOT catch a handler that opts into `{ allowReadRoles: true }` — a
  // tsc-valid weakening that would let a read-only VIEWER of a shared workspace
  // execute arbitrary T-SQL (DROP/UPDATE included) as the Console UAMI. Assert
  // the write scope directly so that mutation goes red.
  //   MUTATION: withWorkspaceOwner('azure-sql-database', { allowReadRoles: true }, …)
  it('(a) stays WRITE-scoped — a read-only viewer can never execute T-SQL', async () => {
    const { POST } = await import('../route');
    await POST(postReq({ sql: 'SELECT 1' }), PARAMS);
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] as { allowReadRoles?: boolean } | undefined;
    expect(opts?.allowReadRoles).toBeFalsy();
  });

  // (b) A body whose server/database DIFFER from the owned item's binding → 403,
  //   NO execution against the attacker-chosen DB.
  //   MUTATION: pass the raw body server/database to executeQueryBatch instead of
  //   the resolveOwnedSqlTarget-derived pair. → these 403s become 200s and the
  //   attacker's DB is queried.
  it('(b) 403s a body server that differs from the item’s bound server, executing NO SQL', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: 'attacker-srv', database: 'db', sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_mismatch');
    expect(executeQueryBatchMock).not.toHaveBeenCalled();
  });

  it('(b) 403s a body database that differs from the item’s bound database, executing NO SQL', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: 'srv', database: 'attacker-db', sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('database_mismatch');
    expect(executeQueryBatchMock).not.toHaveBeenCalled();
  });

  it('(b) an unbound item refuses (409) rather than running against a body-chosen DB', async () => {
    loadOwnedItemMock.mockResolvedValueOnce({ ...OWNED_ITEM, state: {} });
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: 'anything', database: 'anything', sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('no_bound_connection');
    expect(executeQueryBatchMock).not.toHaveBeenCalled();
  });

  // (c) The owner happy path executes against the ITEM'S OWN bound DB — and the
  //   body can NEVER redirect the target.
  it('(c) owner happy path executes against the item’s bound server/database', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ sql: 'SELECT 1 AS n' }), PARAMS);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.rowCount).toBe(1);
    expect(executeQueryBatchMock).toHaveBeenCalledWith('srv', 'db', 'SELECT 1 AS n', undefined);
  });

  it('(c) ignores a matching body server/database and always uses the BOUND pair', async () => {
    // Body sends a FQDN form of the same server (first label matches) → allowed,
    // but the executed target is the bound bare-name pair, not the body's.
    loadOwnedItemMock.mockResolvedValueOnce({
      ...OWNED_ITEM, state: { connection: { server: 'bound-srv', database: 'bound-db' } },
    });
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: 'bound-srv.database.windows.net', database: 'bound-db', sql: 'SELECT 2', requestId: 'r1' }), PARAMS);
    expect(r.status).toBe(200);
    expect(executeQueryBatchMock).toHaveBeenCalledWith('bound-srv', 'bound-db', 'SELECT 2', { requestId: 'r1' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GHSA-v8r7-c2p5-mjf2, second pass — LAYER 3 on the query/copilot path.
//
// #2723 gave this route Layer 1 (it owns its item) and Layer 2 (the target is
// resolved from `state.connection`). Review established that Layer 2 is NOT a
// boundary: `PATCH /api/items/[type]/[id]` replaces `state` wholesale with body
// JSON, so the caller writes the value Layer 2 reads. This route was therefore
// cited as the precedent for the whole fix while being unfixed itself.
//
// Downstream it is WORSE than the ARM routes. `azure-sql-client.getPool`
// composes `server.includes('.') ? server : `${server}.${sqlHostSuffix()}`` and
// presents an Entra ACCESS TOKEN for the SQL scope to that host — so a bound
// external FQDN was arbitrary SQL *plus credential egress*.
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /query — subscription + host admission (GHSA-v8r7-c2p5-mjf2)', () => {
  const GOVERNED = '11111111-1111-1111-1111-111111111111';
  const FOREIGN = '99999999-9999-9999-9999-999999999999';
  const sqlArm = (sub: string, name = 'srv') =>
    `/subscriptions/${sub}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/${name}`;

  let savedSub: string | undefined;
  beforeEach(() => {
    savedSub = process.env.LOOM_SUBSCRIPTION_ID;
    process.env.LOOM_SUBSCRIPTION_ID = GOVERNED;
  });
  afterEach(() => {
    if (savedSub === undefined) delete process.env.LOOM_SUBSCRIPTION_ID;
    else process.env.LOOM_SUBSCRIPTION_ID = savedSub;
  });

  // THE CREDENTIAL-EGRESS RECEIPT. A caller PATCHes their own item's
  // state.connection.server to a host they control, then runs a query.
  //   MUTATION: return the raw bound string from resolveOwnedSqlTarget. → the
  //   attacker host reaches executeQueryBatch, and from there getPool presents a
  //   live SQL-scope token to it.
  it('never lets a bound EXTERNAL host reach the TDS client — no token egress', async () => {
    loadOwnedItemMock.mockResolvedValue({
      ...OWNED_ITEM, state: { connection: { server: 'attacker.example.com', database: 'db' } },
    } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(200);
    const target = executeQueryBatchMock.mock.calls.at(-1)?.[0] as string;
    // Reduced to the first DNS label, so getPool can only ever compose
    // `<label>.<sql-suffix>` — the attacker's host is unreachable from here.
    expect(target).toBe('attacker');
    expect(target).not.toContain('.');
  });

  //   MUTATION: as above.
  it('403s a binding whose ARM id is in an unauthorized subscription, running NO SQL', async () => {
    loadOwnedItemMock.mockResolvedValue({
      ...OWNED_ITEM, state: { connection: { server: sqlArm(FOREIGN), database: 'db' } },
    } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(executeQueryBatchMock).not.toHaveBeenCalled();
  });

  it('403s a body ARM id for a SAME-NAMED server in an unauthorized subscription', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: sqlArm(FOREIGN, 'srv'), database: 'db', sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(executeQueryBatchMock).not.toHaveBeenCalled();
  });

  it('CONTROL: an authorized ARM-id binding still executes, verbatim', async () => {
    loadOwnedItemMock.mockResolvedValue({
      ...OWNED_ITEM, state: { connection: { server: sqlArm(GOVERNED, 'srv'), database: 'db' } },
    } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(200);
    expect(executeQueryBatchMock).toHaveBeenCalledWith(sqlArm(GOVERNED, 'srv'), 'db', 'SELECT 1', undefined);
  });
});
