/**
 * GHSA-v8r7-c2p5-mjf2 — POST /api/items/postgres-flexible-server/[id]/query.
 *
 * BEFORE: `POST(req)` + `getSession()` with `server`, `database` AND the
 * statement all read from the body, and `[id]` never read. `server` accepted a
 * bare name or a full ARM id, so any signed-in caller could run arbitrary SQL as
 * the Console managed identity against any flexible server the UAMI could reach
 * in any subscription — the worst route in the advisory.
 *
 * The unified SQL editor addresses BOTH families through one
 * `azure-sql-database` item, so `[id]` names that item and the binding lives in
 * its `state.connection`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const OID = 'oid-owner';
const GOVERNED = '11111111-1111-1111-1111-111111111111';
const FOREIGN = '99999999-9999-9999-9999-999999999999';
const pgArm = (sub: string, name = 'pgsrv') =>
  `/subscriptions/${sub}/resourceGroups/rg-loom/providers/Microsoft.DBforPostgreSQL/flexibleServers/${name}`;

const getSessionMock = vi.fn(() => ({ claims: { oid: OID, upn: 'owner@loom.test', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const OWNED_ITEM = {
  id: 'item1', workspaceId: 'ws1', itemType: 'azure-sql-database',
  displayName: 'Mine', state: { connection: { family: 'postgres', server: 'pgsrv', database: 'appdb' } },
} as any;
const loadOwnedItemMock = vi.fn(async () => OWNED_ITEM);
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a),
}));

vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn(), enforceCapability: vi.fn() }));
vi.mock('@/lib/auth/dlz-gate', () => ({ denyIfNoDlzAccess: vi.fn() }));
vi.mock('@/lib/gates/registry', () => ({ getGate: vi.fn(), gateStatus: vi.fn() }));

const enforceRateLimitMock = vi.fn(async () => null as any);
vi.mock('@/lib/azure/rate-limiter', () => ({ enforceRateLimit: (...a: any[]) => enforceRateLimitMock(...a) }));

class PostgresError extends Error { status = 502; }
const getServerMock = vi.fn(async (ref: string) => ({ id: pgArm(GOVERNED), name: 'pgsrv', fqdn: 'pgsrv.postgres.database.azure.com', location: 'eastus2', __ref: ref }));
const executePostgresQueryMock = vi.fn(async () => ({ columns: ['n'], rows: [[1]], rowCount: 1, truncated: false, executionMs: 2 }));
const postgresQueryGateMock = vi.fn(() => null as any);
vi.mock('@/lib/azure/postgres-flex-client', () => ({
  getServer: (...a: any[]) => getServerMock(...(a as [string])),
  executePostgresQuery: (...a: any[]) => executePostgresQueryMock(...(a as [])),
  postgresQueryGate: () => postgresQueryGateMock(),
  PostgresError,
}));

const PARAMS = { params: Promise.resolve({ id: 'item1' }) } as any;
function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/items/postgres-flexible-server/item1/query', {
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
  enforceRateLimitMock.mockResolvedValue(null);
  postgresQueryGateMock.mockReturnValue(null);
  getServerMock.mockResolvedValue({ id: pgArm(GOVERNED), name: 'pgsrv', fqdn: 'pgsrv.postgres.database.azure.com', location: 'eastus2' } as any);
  executePostgresQueryMock.mockResolvedValue({ columns: ['n'], rows: [[1]], rowCount: 1, truncated: false, executionMs: 2 } as any);
});
afterEach(() => {
  if (savedSub === undefined) delete process.env.LOOM_SUBSCRIPTION_ID;
  else process.env.LOOM_SUBSCRIPTION_ID = savedSub;
});

describe('POST /api/items/postgres-flexible-server/[id]/query — server authorization', () => {
  it('401s when unauthenticated and runs NO SQL', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: pgArm(FOREIGN), database: 'victim', sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(401);
    expect(getServerMock).not.toHaveBeenCalled();
    expect(executePostgresQueryMock).not.toHaveBeenCalled();
  });

  //   MUTATION: replace withBoundSqlServer with a bare `getSession()` prologue.
  it('404s a caller who does NOT own the item, running NO SQL', async () => {
    // mockResolvedValue, NOT ...Once: the wrapper tries EVERY type in
    // SQL_EDITOR_ITEM_TYPES, so a single null is satisfied by the next candidate
    // and this spec would silently stop testing not-owned.
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: pgArm(FOREIGN), database: 'victim', sql: 'SELECT * FROM secrets' }), PARAMS);
    expect(r.status).toBe(404);
    expect(executePostgresQueryMock).not.toHaveBeenCalled();
  });

  // Executing SQL is a WRITE. A read-only viewer must never reach it.
  //   MUTATION: add `allowReadRoles: true` to the wrapper options.
  it('stays WRITE-scoped — a read-only viewer can never execute SQL', async () => {
    const { POST } = await import('../route');
    await POST(postReq({ sql: 'SELECT 1' }), PARAMS);
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] as { allowReadRoles?: boolean } | undefined;
    expect(opts?.allowReadRoles).toBeFalsy();
  });

  //   MUTATION: pass `body.server` to getServer().
  it('403s a body server that differs from the binding, running NO SQL', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: pgArm(GOVERNED, 'other-pg'), sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_mismatch');
    expect(executePostgresQueryMock).not.toHaveBeenCalled();
  });

  it('403s a body ARM id in an ungoverned subscription, running NO SQL', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: pgArm(FOREIGN), sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(executePostgresQueryMock).not.toHaveBeenCalled();
  });

  // Same name, different subscription — a NAME comparison alone admits this.
  //   MUTATION: delete the `admitGovernedServer(submittedServer, …)` block.
  it('403s a body ARM id for a SAME-NAMED server in an ungoverned subscription', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: pgArm(FOREIGN, 'pgsrv'), sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(executePostgresQueryMock).not.toHaveBeenCalled();
  });

  it('403s a body database that differs from the bound database', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ database: 'victim-db', sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('database_mismatch');
    expect(executePostgresQueryMock).not.toHaveBeenCalled();
  });

  //   MUTATION: delete the admitGovernedServer(bound.server, …) call in the wrapper.
  it('403s an item BOUND to an ungoverned server even when the body agrees', async () => {
    loadOwnedItemMock.mockResolvedValueOnce({
      ...OWNED_ITEM, state: { connection: { family: 'postgres', server: pgArm(FOREIGN), database: 'appdb' } },
    } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: pgArm(FOREIGN), database: 'appdb', sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    expect(executePostgresQueryMock).not.toHaveBeenCalled();
  });

  // A route that speaks Microsoft.DBforPostgreSQL must refuse a SQL server id.
  it('403s an item bound to a Microsoft.Sql server (wrong provider for this route)', async () => {
    loadOwnedItemMock.mockResolvedValueOnce({
      ...OWNED_ITEM,
      state: { connection: { family: 'azure-sql', server: `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/srv`, database: 'db' } },
    } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_type_mismatch');
    expect(executePostgresQueryMock).not.toHaveBeenCalled();
  });

  it('409s an unbound item rather than querying a body-chosen server', async () => {
    loadOwnedItemMock.mockResolvedValueOnce({ ...OWNED_ITEM, state: {} } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: pgArm(FOREIGN), database: 'victim', sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('no_bound_connection');
    expect(getServerMock).not.toHaveBeenCalled();
  });

  // ---- the legitimate-owner direction ----
  it('CONTROL: the owner queries their OWN bound server + database', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: 'pgsrv', database: 'appdb', sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(200);
    expect(getServerMock).toHaveBeenCalledWith('pgsrv');
    expect(executePostgresQueryMock).toHaveBeenCalledWith('pgsrv.postgres.database.azure.com', 'appdb', 'SELECT 1');
  });

  // THE REBINDING MUTATION CATCHER — a DIFFERENT FORM of the same server, so
  // `getServer(body.server)` and `getServer(server)` produce different values.
  //   MUTATION: `getServer(String(body?.server || server))`.
  it('resolves the BOUND server even when the body names it in another form', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ server: pgArm(GOVERNED, 'pgsrv'), database: 'appdb', sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(200);
    expect(getServerMock).toHaveBeenCalledWith('pgsrv');
  });

  // The documented residual: with no bound database the body picks one, scoped
  // to the bound SERVER. Asserted so the behaviour is deliberate, not accidental.
  it('uses a body database only when the item binds none — on the bound server', async () => {
    loadOwnedItemMock.mockResolvedValueOnce({
      ...OWNED_ITEM, state: { connection: { family: 'postgres', server: 'pgsrv' } },
    } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ database: 'other', sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(200);
    expect(getServerMock).toHaveBeenCalledWith('pgsrv');
    expect(executePostgresQueryMock).toHaveBeenCalledWith('pgsrv.postgres.database.azure.com', 'other', 'SELECT 1');
  });

  it('still returns the honest 503 config gate, without executing', async () => {
    postgresQueryGateMock.mockReturnValue({ detail: 'register the UAMI', missing: 'LOOM_POSTGRES_AAD_USER' } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe('PG_QUERY_GATED');
    expect(executePostgresQueryMock).not.toHaveBeenCalled();
  });

  it('still requires a statement', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({}), PARAMS);
    expect(r.status).toBe(400);
    expect(executePostgresQueryMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/items/postgres-flexible-server/[id]/query — item TYPE resolution', () => {
  // REGRESSION FOUND IN REVIEW. `postgres-flexible-server` is a REAL creatable
  // slug: `searchOnly:true` hides it from browse, but the search branch of
  // `new-item-dialog.tsx` deliberately does NOT filter searchOnly, and
  // `createItem` persists the picked slug verbatim. `sql-database` items also
  // exist (hiddenFromGallery, but pre-existing ones still resolve). All three
  // are registered to `UnifiedSqlDatabaseEditor`.
  //
  // Defaulting the owner check to `azure-sql-database` alone 404'd every one of
  // them — and PRE-FIX this route was session-only and WORKED for them, so that
  // is a regression this PR would have introduced. No test covered it, and there
  // was no browser receipt, which is exactly how it survived the first pass.
  //   MUTATION: `{ provider: 'postgres', itemTypes: ['azure-sql-database'] }`.
  it.each([
    ['postgres-flexible-server'],
    ['sql-database'],
  ])('a %s item reaches the handler and queries its bound server', async (itemType) => {
    // loadOwnedItem resolves ONLY for this item's real type — the azure-sql
    // attempt returns null, exactly as it would in Cosmos.
    loadOwnedItemMock.mockImplementation(async (...a: any[]) =>
      (a[1] === itemType
        ? { ...OWNED_ITEM, itemType }
        : null) as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(200);
    expect(getServerMock).toHaveBeenCalledWith('pgsrv');
    expect(executePostgresQueryMock).toHaveBeenCalledWith(
      'pgsrv.postgres.database.azure.com', 'appdb', 'SELECT 1',
    );
  });

  it('every candidate type is resolved OWNER-scoped — trying several cannot widen access', async () => {
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(404);
    // Each attempt passed the caller's own oid + the session (the #2703 tid
    // boundary), so a foreign item resolves for NONE of them.
    for (const call of loadOwnedItemMock.mock.calls) {
      expect(call[2]).toBe(OID);
      expect((call[3] as any)?.session?.claims?.oid).toBe(OID);
    }
    expect(executePostgresQueryMock).not.toHaveBeenCalled();
  });
});
