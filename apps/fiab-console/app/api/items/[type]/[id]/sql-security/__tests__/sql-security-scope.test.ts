/**
 * GHSA-v8r7-c2p5-mjf2 — GET/POST /api/items/[type]/[id]/sql-security.
 *
 * BEFORE: `getSession()` was the whole authorization. `[id]` was destructured and
 * never used — it reached no ownership call on either verb — while the execution
 * coordinates came off the REQUEST (`?server=`/`?database=` on GET, the body on
 * POST) and went straight to `azureSqlExecute` as the Console UAMI. So any
 * authenticated session read another estate's full SQL security catalog
 * (principals, object grants, masked columns, RLS policies) and executed
 * generated DDL/DCL — GRANT / DENY / CREATE SECURITY POLICY / ADD MASKED — there.
 *
 * The route carried an ALLOWLIST reason in `check-route-guards.mjs` reading "SQL
 * security over a shared Azure backend resolved by item-type gate", which is true
 * of the two Synapse branches (workspace + pool are env-derived) and false of the
 * Azure SQL branch. These specs therefore assert PER BRANCH, so a fix that pinned
 * only one of them still goes red.
 *
 * Every spec asserts a DENIAL or a NON-CALL and names the mutation that turns it
 * red, plus a passing CONTROL. Session, item ownership and both TDS executors are
 * mocked — no cookies / Cosmos / TDS.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The Azure SQL branch resolves `[id]` across this whole family; the specs assert
// against the shared constant rather than re-listing the slugs (which is the
// defect that produced #3623 and then #3639).
import { SQL_EDITOR_ITEM_TYPES } from '@/app/api/items/_lib/sql-server-scope';

const OID = 'oid-owner';
const GOVERNED = '11111111-1111-1111-1111-111111111111';
const FOREIGN = '99999999-9999-9999-9999-999999999999';
const sqlArm = (sub: string, name = 'srv') =>
  `/subscriptions/${sub}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/${name}`;

const getSessionMock = vi.fn(() => ({ claims: { oid: OID, upn: 'owner@loom.test', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

/** The caller OWNS item1, bound to server 'srv' / database 'db'. */
const OWNED_ITEM = {
  id: 'item1', workspaceId: 'ws1', itemType: 'azure-sql-database',
  displayName: 'Mine', state: { connection: { family: 'azure-sql', server: 'srv', database: 'db' } },
} as any;
const loadOwnedItemMock = vi.fn(async () => OWNED_ITEM);
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a),
}));

// Route-toolkit's other imports — stubbed so the module loads without pulling in
// the gate registry / feature-gate / dlz.
vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn(), enforceCapability: vi.fn() }));
vi.mock('@/lib/auth/dlz-gate', () => ({ denyIfNoDlzAccess: vi.fn() }));
vi.mock('@/lib/gates/registry', () => ({ getGate: vi.fn(), gateStatus: vi.fn() }));

class AzureSqlError extends Error { status = 502; code = 'sql_error'; number = 1; }
const azureSqlExecuteMock = vi.fn(async () => ({ columns: ['n'], rows: [[1]], rowCount: 1 }));
vi.mock('@/lib/azure/azure-sql-client', () => ({
  executeQuery: (...a: any[]) => azureSqlExecuteMock(...a),
  AzureSqlError,
}));

const synapseExecuteMock = vi.fn(async () => ({ columns: ['n'], rows: [[1]], recordsAffected: 1, messages: [] }));
const dedicatedTargetMock = vi.fn(() => ({ server: 'ws.sql.azuresynapse.net', database: 'pool1', cacheKey: 'dedicated:ws:pool1' }));
const serverlessTargetMock = vi.fn((database = 'master') => ({
  server: 'ws-ondemand.sql.azuresynapse.net', database, cacheKey: `serverless:ws:${database}`,
}));
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  executeQuery: (...a: any[]) => synapseExecuteMock(...a),
  dedicatedTarget: (...a: any[]) => dedicatedTargetMock(...(a as [])),
  serverlessTarget: (...a: any[]) => serverlessTargetMock(...(a as [string?])),
}));

const params = (type: string, id = 'item1') => ({ params: Promise.resolve({ type, id }) }) as any;

function getReq(type: string, qs = '', id = 'item1'): NextRequest {
  return new NextRequest(`http://localhost/api/items/${type}/${id}/sql-security${qs}`);
}
function postReq(type: string, body: unknown, id = 'item1'): NextRequest {
  return new NextRequest(`http://localhost/api/items/${type}/${id}/sql-security`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
/** No TDS of ANY kind ran — both executors, because the route has two. */
function noSqlRan() {
  expect(azureSqlExecuteMock).not.toHaveBeenCalled();
  expect(synapseExecuteMock).not.toHaveBeenCalled();
}

const GRANT_BODY = {
  wizard: 'object-grant',
  params: { principal: 'analyst', schema: 'dbo', objectName: 't', permissions: ['SELECT'], action: 'GRANT' },
};

let savedSub: string | undefined;
let savedWs: string | undefined;
let savedPool: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockReturnValue({ claims: { oid: OID, upn: 'owner@loom.test', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 } as any);
  loadOwnedItemMock.mockResolvedValue(OWNED_ITEM);
  azureSqlExecuteMock.mockResolvedValue({ columns: ['n'], rows: [[1]], rowCount: 1 });
  synapseExecuteMock.mockResolvedValue({ columns: ['n'], rows: [[1]], recordsAffected: 1, messages: [] });
  savedSub = process.env.LOOM_SUBSCRIPTION_ID;
  savedWs = process.env.LOOM_SYNAPSE_WORKSPACE;
  savedPool = process.env.LOOM_SYNAPSE_DEDICATED_POOL;
  process.env.LOOM_SUBSCRIPTION_ID = GOVERNED;
  process.env.LOOM_SYNAPSE_WORKSPACE = 'ws';
  process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'pool1';
});
afterEach(() => {
  for (const [k, v] of [
    ['LOOM_SUBSCRIPTION_ID', savedSub], ['LOOM_SYNAPSE_WORKSPACE', savedWs], ['LOOM_SYNAPSE_DEDICATED_POOL', savedPool],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 1 — the route id must convey authority. On BOTH verbs, EVERY branch.
// ═══════════════════════════════════════════════════════════════════════════
describe('sql-security — LAYER 1: ownership of the route [id]', () => {
  it('401s an unauthenticated GET and never touches Cosmos or SQL', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { GET } = await import('../route');
    const r = await GET(getReq('azure-sql-database', '?server=victim&database=secrets'), params('azure-sql-database'));
    expect(r.status).toBe(401);
    expect(loadOwnedItemMock).not.toHaveBeenCalled();
    noSqlRan();
  });

  it('401s an unauthenticated POST and never touches Cosmos or SQL', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq('azure-sql-database', { server: 'victim', database: 'secrets', ...GRANT_BODY }), params('azure-sql-database'));
    expect(r.status).toBe(401);
    expect(loadOwnedItemMock).not.toHaveBeenCalled();
    noSqlRan();
  });

  // THE ADVISORY'S CORE FINDING, on the GET.
  //   MUTATION: drop the `loadOwnedSqlItem` call from `authorizeAndResolve` (or
  //   restore the old bare `getSession()` prologue). → this 404 becomes a 200 and
  //   the victim database's whole security catalog is returned.
  //
  //   `mockResolvedValue`, NOT `...Once`: resolution walks every candidate slug,
  //   so a single-shot null is satisfied by the SECOND candidate and this spec
  //   would go green while testing nothing.
  it('404s a GET from a caller who does not own [id], reading NO catalog', async () => {
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { GET } = await import('../route');
    const r = await GET(getReq('azure-sql-database', '?server=victim-srv&database=victim-db'), params('azure-sql-database'));
    expect(r.status).toBe(404);
    noSqlRan();
  });

  //   MUTATION: as above. → this 404 becomes a 200 and GRANT/DENY DDL executes
  //   on the caller-named database.
  it('404s a POST from a caller who does not own [id], executing NO DDL', async () => {
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq('azure-sql-database', { server: 'victim-srv', database: 'victim-db', ...GRANT_BODY }), params('azure-sql-database'));
    expect(r.status).toBe(404);
    noSqlRan();
  });

  // The Synapse branches took no caller coordinate, so ONLY Layer 1 protects
  // them — a fix applied to the Azure SQL branch alone would leave both wide
  // open, which is exactly the shape the false allowlist reason described.
  //   MUTATION: run the ownership check only on the azure-sql branch.
  it('404s an unowned SYNAPSE-DEDICATED request — the branch with no caller coordinate', async () => {
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq('synapse-dedicated-sql-pool', GRANT_BODY), params('synapse-dedicated-sql-pool'));
    expect(r.status).toBe(404);
    noSqlRan();
  });

  it('404s an unowned WAREHOUSE request (the second slug on the dedicated branch)', async () => {
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq('warehouse', GRANT_BODY), params('warehouse'));
    expect(r.status).toBe(404);
    noSqlRan();
  });

  it('404s an unowned SYNAPSE-SERVERLESS request', async () => {
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { GET } = await import('../route');
    const r = await GET(getReq('synapse-serverless-sql-pool', '?database=other'), params('synapse-serverless-sql-pool'));
    expect(r.status).toBe(404);
    noSqlRan();
  });

  it('owner-scopes the load: id + itemType + caller oid + session', async () => {
    const { GET } = await import('../route');
    await GET(getReq('azure-sql-database', '?server=srv&database=db'), params('azure-sql-database'));
    expect(loadOwnedItemMock).toHaveBeenCalledWith(
      'item1', 'azure-sql-database', OID,
      expect.objectContaining({ session: expect.objectContaining({ claims: expect.objectContaining({ oid: OID }) }) }),
    );
  });

  // `expect.objectContaining` above is permissive and would NOT catch a handler
  // that opted into `{ allowReadRoles: true }` — a tsc-valid weakening letting a
  // read-only VIEWER of a shared workspace reach the same TDS executor and read
  // the database's security posture. Assert the write scope on BOTH verbs.
  //   MUTATION: pass `{ allowReadRoles: true }` into loadOwnedSqlItem.
  it('stays WRITE-scoped on the GET — a read-only viewer never reaches the executor', async () => {
    const { GET } = await import('../route');
    await GET(getReq('azure-sql-database', '?server=srv&database=db'), params('azure-sql-database'));
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] as { allowReadRoles?: boolean } | undefined;
    expect(opts?.allowReadRoles).toBeFalsy();
  });

  it('stays WRITE-scoped on the POST', async () => {
    const { POST } = await import('../route');
    await POST(postReq('azure-sql-database', GRANT_BODY), params('azure-sql-database'));
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] as { allowReadRoles?: boolean } | undefined;
    expect(opts?.allowReadRoles).toBeFalsy();
  });

  // The 404 specs only mean something if EVERY candidate was tried and refused.
  //   MUTATION: narrow the Azure SQL candidate list to one type.
  it('refuses across the WHOLE SQL editor family — every slug is owner-checked', async () => {
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { POST } = await import('../route');
    await POST(postReq('azure-sql-database', GRANT_BODY), params('azure-sql-database'));
    const tried = new Set(loadOwnedItemMock.mock.calls.map((c: any[]) => c[1]));
    for (const t of SQL_EDITOR_ITEM_TYPES) expect(tried).toContain(t);
  });

  // The #3639 regression class: `unified-sql-database-editor` mounts the panel
  // with a HARD-CODED itemType="azure-sql-database" while the editor itself is
  // registered for several slugs, so the item's real type need not match the URL.
  //   MUTATION: resolve only the URL's `[type]`.
  it('runs for an owned item of a NON-azure-sql-database slug on that URL', async () => {
    loadOwnedItemMock.mockImplementation(((_id: string, itemType: string) =>
      Promise.resolve(itemType === 'sql-server-2025-vector-index'
        ? { ...OWNED_ITEM, itemType: 'sql-server-2025-vector-index' }
        : null)) as any);
    const { GET } = await import('../route');
    const r = await GET(getReq('azure-sql-database', '?server=srv&database=db'), params('azure-sql-database'));
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });

  // The Synapse branches must NOT quietly widen to the SQL editor family — the
  // URL type is the only thing that should resolve there.
  //   MUTATION: use SQL_EDITOR_ITEM_TYPES for every branch.
  it('resolves a SYNAPSE request against the URL type ONLY', async () => {
    const { POST } = await import('../route');
    await POST(postReq('synapse-dedicated-sql-pool', GRANT_BODY), params('synapse-dedicated-sql-pool'));
    const tried = loadOwnedItemMock.mock.calls.map((c: any[]) => c[1]);
    expect(tried).toEqual(['synapse-dedicated-sql-pool']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 2 + 3 — Azure SQL: the target is the item's binding, admitted against
// the authorized subscription set. The request can only cause a REFUSAL.
// ═══════════════════════════════════════════════════════════════════════════
describe('sql-security — LAYER 2/3: the Azure SQL target comes from the item', () => {
  //   MUTATION: pass the request's server/database into azureSqlReader instead of
  //   the resolveOwnedSqlTarget-derived pair. → these 403s become 200s.
  it('403s a GET whose ?server= differs from the item’s binding, reading NO catalog', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq('azure-sql-database', '?server=attacker-srv&database=db'), params('azure-sql-database'));
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_mismatch');
    noSqlRan();
  });

  it('403s a POST whose body server differs from the item’s binding, executing NO DDL', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq('azure-sql-database', { server: 'attacker-srv', database: 'db', ...GRANT_BODY }), params('azure-sql-database'));
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_mismatch');
    noSqlRan();
  });

  it('403s a body database that differs from the item’s binding', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq('azure-sql-database', { server: 'srv', database: 'attacker-db', ...GRANT_BODY }), params('azure-sql-database'));
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('database_mismatch');
    noSqlRan();
  });

  // Layer 3 proper: a same-NAMED server in a subscription this deployment does
  // not govern. `serverRefsMatch` compares names only, so without the admission
  // of the SUBMITTED value this would have "matched" the bound bare name.
  it('403s a body ARM id for a same-named server in an ungoverned subscription', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq('azure-sql-database', { server: sqlArm(FOREIGN, 'srv'), database: 'db', ...GRANT_BODY }), params('azure-sql-database'));
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    noSqlRan();
  });

  it('403s an item BOUND to an ungoverned subscription', async () => {
    loadOwnedItemMock.mockResolvedValue({
      ...OWNED_ITEM, state: { connection: { server: sqlArm(FOREIGN), database: 'db' } },
    } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq('azure-sql-database', GRANT_BODY), params('azure-sql-database'));
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    noSqlRan();
  });

  // CREDENTIAL EGRESS. `azure-sql-client.getPool` composes
  // `server.includes('.') ? server : `${server}.${sqlHostSuffix()}`` and presents
  // a live Entra SQL-scope token to whatever host that yields, so a bound
  // external FQDN was catalog-read + DDL *plus* token egress. Admission reduces
  // an FQDN to its first DNS label, so no bound value can leave the SQL suffix.
  //   MUTATION: use the raw bound string instead of the admitted one.
  it('never lets a bound EXTERNAL host reach the TDS client — no token egress', async () => {
    loadOwnedItemMock.mockResolvedValue({
      ...OWNED_ITEM, state: { connection: { server: 'attacker.example.com', database: 'db' } },
    } as any);
    const { GET } = await import('../route');
    const r = await GET(getReq('azure-sql-database', ''), params('azure-sql-database'));
    expect(r.status).toBe(200);
    const host = azureSqlExecuteMock.mock.calls.at(-1)?.[0] as string;
    expect(host).toBe('attacker');
    expect(host).not.toContain('.');
  });

  it('CONTROL: the owner’s happy path executes against the item’s OWN bound pair', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq('azure-sql-database', { server: 'srv', database: 'db', ...GRANT_BODY }), params('azure-sql-database'));
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
    const [host, db] = azureSqlExecuteMock.mock.calls.at(-1) as unknown as [string, string, string];
    expect(host).toBe('srv');
    expect(db).toBe('db');
  });

  it('CONTROL: a GET reads the catalog against the bound pair, ignoring the query string', async () => {
    loadOwnedItemMock.mockResolvedValue({
      ...OWNED_ITEM, state: { connection: { server: 'bound-srv', database: 'bound-db' } },
    } as any);
    const { GET } = await import('../route');
    // FQDN form of the SAME server → admitted, but the executed pair is the bound one.
    const r = await GET(getReq('azure-sql-database', '?server=bound-srv.database.windows.net&database=bound-db'), params('azure-sql-database'));
    expect(r.status).toBe(200);
    for (const call of azureSqlExecuteMock.mock.calls as unknown as [string, string, string][]) {
      expect(call[0]).toBe('bound-srv');
      expect(call[1]).toBe('bound-db');
    }
  });

  // An unbound item is "you have not picked a server yet", not a hostile request,
  // so it keeps the route's EXISTING honest gate (200 + gated:true) rather than
  // becoming a red error banner on a freshly created item (ux-baseline.md).
  // What matters for THIS advisory is that NO SQL runs against the body's pair.
  it('an unbound item GATES (no red banner) and runs NO SQL against the body’s pair', async () => {
    loadOwnedItemMock.mockResolvedValue({ ...OWNED_ITEM, state: {} } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq('azure-sql-database', { server: 'anything', database: 'anything', ...GRANT_BODY }), params('azure-sql-database'));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.gated).toBe(true);
    noSqlRan();
  });

  // The gate is ONLY for the unbound case. A mismatch or an ungoverned
  // subscription must keep its real status — laundering those into a 200 would
  // turn an authorization refusal into a soft warning.
  //   MUTATION: return `gate(...)` for every refusal code.
  it('does NOT launder a mismatch into the 200 gate', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq('azure-sql-database', { server: 'attacker-srv', ...GRANT_BODY }), params('azure-sql-database'));
    expect(r.status).toBe(403);
    expect((await r.json()).gated).toBeUndefined();
  });

  // The preview pane returns SQL without touching the database — but it must
  // still be behind Layer 1, or it becomes a free T-SQL generator on an id the
  // caller does not own. (It generates from `params`, so this is about the
  // ownership prologue running BEFORE the preview short-circuit.)
  it('404s a PREVIEW on an unowned item', async () => {
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq('azure-sql-database', { preview: true, ...GRANT_BODY }), params('azure-sql-database'));
    expect(r.status).toBe(404);
    noSqlRan();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// UNSAVED ITEM — the gate, not a 404. Found in review of the first version of
// this fix, which 404'd `id='new'` and so put a RED "Could not load security
// state — not found" banner four clicks from a create page.
//
// THREE of the four editors that mount SqlSecurityPanel reach this: the unified
// SQL editor (:1449 / :1992-1995, no `id !== 'new'`), the Synapse SERVERLESS
// editor (:392, trigger is unconditional) and the Synapse DEDICATED editor
// (:932, gated on `isOnline`, which comes from a `GET()` with no ctx and is
// therefore id-blind). Only phase3/warehouse-editor.tsx:459 is safe
// (`canRun` <- `ready`, whose query carries `enabled: !isNew`).
//
// So the specs cover EVERY branch — a fix applied only to the azure-sql path
// would leave two live dead ends.
// ═══════════════════════════════════════════════════════════════════════════
describe('sql-security — an UNSAVED item gates, it does not dead-end', () => {
  //   MUTATION: delete the `id === UNSAVED_ITEM_ID` short-circuit. → the
  //   ownership check 404s and the panel paints a red error banner.
  it.each([
    ['azure-sql-database', '?server=srv&database=db'],
    ['synapse-serverless-sql-pool', ''],
    ['synapse-dedicated-sql-pool', ''],
    ['warehouse', ''],
  ])('GET on a new %s returns the GATE shape, never a 404', async (type, qs) => {
    const { GET } = await import('../route');
    const r = await GET(getReq(type, qs, 'new'), params(type, 'new'));
    expect(r.status).not.toBe(404);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.gated).toBe(true);
    expect(j.ok).toBe(false);
    // Actionable: it names the one action that resolves the state.
    expect(String(j.error)).toMatch(/save this item first/i);
    noSqlRan();
  });

  it('POST on a new item gates too, executing NO DDL', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq('azure-sql-database', GRANT_BODY, 'new'), params('azure-sql-database', 'new'));
    expect(r.status).toBe(200);
    expect((await r.json()).gated).toBe(true);
    noSqlRan();
  });

  // The gate must be a SHORT-CIRCUIT, not a 404 that happens to be relabelled:
  // an unsaved item has no Cosmos row, so Cosmos must not be consulted at all.
  it('does not even attempt a Cosmos read for an unsaved item', async () => {
    const { GET } = await import('../route');
    await GET(getReq('azure-sql-database', '', 'new'), params('azure-sql-database', 'new'));
    expect(loadOwnedItemMock).not.toHaveBeenCalled();
  });

  // `'new'` is special-cased ONLY as an exact match. A real Cosmos id is a
  // `crypto.randomUUID()` (item-crud.ts:467), so nothing that merely contains or
  // resembles the word may skip the ownership check.
  //   MUTATION: change the comparison to `id.includes('new')` or a regex.
  it.each(['newton', 'new-item', 'NEW', 'anew'])(
    'does NOT skip ownership for an id that merely resembles new — %s',
    async (id) => {
      loadOwnedItemMock.mockResolvedValue(null as any);
      const { GET } = await import('../route');
      const r = await GET(getReq('azure-sql-database', '', id), params('azure-sql-database', id));
      expect(r.status).toBe(404);
      expect(loadOwnedItemMock).toHaveBeenCalled();
      noSqlRan();
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// The 404 body — names both causes, asserts neither (deploy-integrity.md R7).
// ═══════════════════════════════════════════════════════════════════════════
describe('sql-security — the unreachable-item message is actionable and honest', () => {
  //   MUTATION: revert to a bare `apiNotFound()`. → the body is "not found",
  //   which tells a read-role member of a shared workspace nothing.
  it('explains BOTH causes without asserting either', async () => {
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { GET } = await import('../route');
    const r = await GET(getReq('azure-sql-database', ''), params('azure-sql-database'));
    expect(r.status).toBe(404);
    const err = String((await r.json()).error);
    expect(err).toMatch(/does not exist/i);
    expect(err).toMatch(/read-only/i);
    expect(err).toMatch(/write access/i);
    // It must NOT claim to know which one it is — that would be a fact the route
    // did not establish (loadOwnedItem returns null for both).
    expect(err).toMatch(/either/i);
  });

  // 404-not-403 is retained deliberately: distinguishing the two causes needs a
  // second read, which IS the cross-tenant existence probe the convention exists
  // to prevent.
  //   MUTATION: return 403 when the item exists but the caller lacks write. →
  //   this goes red, and an id becomes probeable across tenants.
  it('stays 404, never 403 — an id must not be probeable', async () => {
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq('azure-sql-database', GRANT_BODY), params('azure-sql-database'));
    expect(r.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SYNAPSE — env-derived targets, and the one caller coordinate that remains.
// ═══════════════════════════════════════════════════════════════════════════
describe('sql-security — Synapse branches', () => {
  it('DEDICATED takes NO caller coordinate: the body’s server/database are inert', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq('synapse-dedicated-sql-pool', { server: 'attacker', database: 'victim', ...GRANT_BODY }), params('synapse-dedicated-sql-pool'));
    expect(r.status).toBe(200);
    // The target is whatever dedicatedTarget() returned from env — never the body.
    expect(dedicatedTargetMock).toHaveBeenCalled();
    const target = synapseExecuteMock.mock.calls.at(-1)?.[0] as any;
    expect(target.server).toBe('ws.sql.azuresynapse.net');
    expect(target.database).toBe('pool1');
    expect(azureSqlExecuteMock).not.toHaveBeenCalled();
  });

  it('SERVERLESS defaults to master when no database is named', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq('synapse-serverless-sql-pool', ''), params('synapse-serverless-sql-pool'));
    expect(r.status).toBe(200);
    expect(serverlessTargetMock).toHaveBeenCalledWith('master');
  });

  // The serverless database stays caller-CHOSEN (the residual recorded in the
  // route header) but is bounded by SHAPE, so a value that could never name a
  // real database is refused before it reaches the connection-pool cache key.
  //   MUTATION: delete the SERVERLESS_DATABASE_RE check. → these 400s become
  //   200s and the raw string reaches serverlessTarget().
  it.each([
    ['a path separator', 'db/../other'],
    ['a backslash', 'db\\other'],
    ['a semicolon', 'db;Encrypt=false'],
    ['a quote', "db'"],
    ['a double quote', 'db"x'],
    ['a bracket', 'db]-[other'],
    ['whitespace padding beyond trim', 'db\tname'],
    ['an over-long name', 'd'.repeat(200)],
  ])('SERVERLESS 400s a malformed database name — %s', async (_label, database) => {
    const { GET } = await import('../route');
    const r = await GET(
      getReq('synapse-serverless-sql-pool', `?database=${encodeURIComponent(database)}`),
      params('synapse-serverless-sql-pool'),
    );
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('malformed_database_name');
    expect(serverlessTargetMock).not.toHaveBeenCalled();
    noSqlRan();
  });

  it('CONTROL: SERVERLESS accepts an ordinary database name', async () => {
    const { GET } = await import('../route');
    const r = await GET(getReq('synapse-serverless-sql-pool', '?database=lake_db'), params('synapse-serverless-sql-pool'));
    expect(r.status).toBe(200);
    expect(serverlessTargetMock).toHaveBeenCalledWith('lake_db');
  });

  // THE SHAPE BOUND MUST NOT REFUSE A REAL DATABASE. The first version of
  // SERVERLESS_DATABASE_RE was an allowlist that argued for Unicode-awareness and
  // then omitted `@`, `$` and `#` — which SQL Server permits in an identifier —
  // so `sales#2024` and `db$archive` 400'd. Raised in review; these are the
  // regression specs for it.
  //   MUTATION: narrow SERVERLESS_DATABASE_RE back to an allowlist such as
  //   [\p{L}\p{N}_ .-]. → every case below 400s.
  it.each([
    ['Unicode letters', 'ventas_año'],
    ['a hash', 'sales#2024'],
    ['a dollar sign', 'db$archive'],
    ['an at sign', 'db@corp'],
    ['a leading hash (no leading-char restriction, by design)', '#staging'],
    ['a space and a dot', 'sales db.v2'],
  ])('CONTROL: SERVERLESS accepts a legal database name — %s', async (_label, database) => {
    const { GET } = await import('../route');
    const r = await GET(
      getReq('synapse-serverless-sql-pool', `?database=${encodeURIComponent(database)}`),
      params('synapse-serverless-sql-pool'),
    );
    expect(r.status).toBe(200);
    expect(serverlessTargetMock).toHaveBeenCalledWith(database);
  });

  // The env gates are honest infra gates, NOT authorization — so they must come
  // AFTER ownership. Otherwise an unconfigured deployment tells an unauthorized
  // caller which item ids exist.
  //   MUTATION: hoist the env checks above loadOwnedSqlItem.
  it('checks ownership BEFORE the Synapse env gate', async () => {
    delete process.env.LOOM_SYNAPSE_WORKSPACE;
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { GET } = await import('../route');
    const r = await GET(getReq('synapse-serverless-sql-pool', ''), params('synapse-serverless-sql-pool'));
    expect(r.status).toBe(404);
    const j = await r.json();
    expect(j.gated).toBeUndefined();
  });

  it('CONTROL: an owner of an unconfigured deployment still gets the honest gate', async () => {
    delete process.env.LOOM_SYNAPSE_WORKSPACE;
    const { GET } = await import('../route');
    const r = await GET(getReq('synapse-serverless-sql-pool', ''), params('synapse-serverless-sql-pool'));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.gated).toBe(true);
    expect(j.error).toContain('LOOM_SYNAPSE_WORKSPACE');
    noSqlRan();
  });
});
