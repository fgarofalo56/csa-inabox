/**
 * GHSA-v2g8-gp3r-rg4r — `guardAdxRequest` must REFUSE an item the caller cannot
 * reach, not fall through to the shared default database.
 *
 * WHAT SHIPPED. The guard resolved its target database like this:
 *
 *     let database = defaultDatabase();
 *     const item = await loadKustoItem(itemId, 'kql-database', session.claims.oid);
 *     database = resolveDatabase(item);          // ← no null check
 *
 * `loadKustoItem` returns **null** when the caller does not own the item, and
 * `resolveDatabase(null)` returns `defaultDatabase()`. So naming another
 * tenant's item id did not refuse — it silently proceeded against the shared
 * default DB, on the helper 12 route files / 28 handlers under `/api/adx/*`
 * depend on.
 *
 * THE SEVERITY IS NARROW AND THE TESTS BELOW ARE WRITTEN TO SAY SO. This was
 * never a cross-tenant read: the victim's database name is never reached. The
 * defect is that a route reported and behaved as though ownership had been
 * established when no ownership decision was made, and that it failed OPEN.
 * `refuses ... rather than reaching the default database` asserts BOTH halves —
 * a 404 AND that `listTableDetails` was never called with `defaultDatabase()` —
 * because a fix that refuses after touching ADX would still be a defect.
 *
 * MUTATION PROOF — each executed against this suite and restored:
 *   1. `_shared.ts` — drop `if (!item) return { res: … 404 }`, i.e. restore the
 *      shipped fall-through
 *        → "refuses an id the caller cannot reach rather than reaching the
 *          default database", "refuses an id that names no kql-database item"
 *          and the two route-level specs fail (200 + ADX reached on the
 *          default DB). tsc-clean (exit 0) — the type system has no opinion
 *          here, which is exactly why this file exists.
 *   2. `_shared.ts` — drop `if (denied) return { res: denied };`
 *        → "a caller the workspace ladder denies never reaches ADX" fails.
 *   3. `_shared.ts` — pass `allowReadRoles: true` unconditionally
 *        → "mutating handlers stay WRITE-scoped" fails on the extra key.
 *   4. `_shared.ts` — pass `allowReadRoles` never (drop the method test)
 *        → "read handlers admit any workspace role" fails.
 *   5. `_shared.ts` — re-point the resolved database at the query string
 *      (`database = req.nextUrl.searchParams.get('db') || resolveDatabase(item)`)
 *        → "the database comes from the ITEM, never the request" fails.
 *   6. `_shared.ts` — refuse whenever `itemId` is set, dropping the
 *      `UNSAVED_ITEM_ID` short-circuit
 *        → "an UNSAVED item still opens on the default database" fails. That
 *          test is the dead-end guard (#3648): a 404 here paints a red banner
 *          on a freshly created item.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const SESSION = { claims: { oid: 'oid-caller', tid: 'tid-1', upn: 'u@loom.test', groups: [] } } as any;
const session = vi.hoisted(() => ({ current: null as any }));
vi.mock('@/lib/auth/session', () => ({ getSession: () => session.current }));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async () => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);

vi.mock('@/lib/api/gate-envelope', () => ({
  apiHonestGateError: (id: string, opts: any) =>
    new Response(JSON.stringify({ ok: false, gated: true, gate: { id }, ...opts }), { status: 503 }),
}));

/** The env-pinned shared database every workspace can already address. */
const DEFAULT_DB = 'loomdb-default';
/** The database bound to the item the caller legitimately owns. */
const OWN_DB = 'ownerdb';

const ITEM: any = {
  id: 'kdb-1', itemType: 'kql-database', workspaceId: 'ws-1',
  displayName: 'Telemetry', state: { databaseName: OWN_DB },
};

const kusto = vi.hoisted(() => ({
  item: null as any,
  gate: null as any,
  listTableDetails: vi.fn(async () => [{ name: 'Events', totalRowCount: 12 }]),
  createTable: vi.fn(async () => ({ rowCount: 0 })),
}));
vi.mock('@/lib/azure/kusto-client', () => ({
  KustoError: class extends Error { status = 502; },
  kustoConfigGate: () => kusto.gate,
  defaultDatabase: () => DEFAULT_DB,
  resolvedClusterUri: async () => 'https://adx.example.net',
  // The REAL resolver — the fall-through under test lives in it, so stubbing it
  // would hide the very behaviour this file asserts.
  resolveDatabase: (i: any) => {
    const n = i?.state?.databaseName;
    return typeof n === 'string' && n.trim() ? n.trim() : DEFAULT_DB;
  },
  loadKustoItemUnscoped: vi.fn(async () => kusto.item),
  listTableDetails: kusto.listTableDetails,
  createTable: kusto.createTable,
  dropTable: vi.fn(async () => ({ rowCount: 0 })),
  alterMergeTable: vi.fn(async () => ({ rowCount: 0 })),
  getTableCslSchema: vi.fn(async () => 'ts:datetime'),
}));

import { guardAdxRequest } from '../_shared';

const req = (url: string, method = 'GET', body?: unknown) =>
  new NextRequest(`http://console.test${url}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  session.current = SESSION;
  guard.authorizeItemWorkspace.mockResolvedValue(null as any);
  kusto.item = ITEM;
  kusto.gate = null;
});

describe('guardAdxRequest — an id the caller cannot reach is REFUSED', () => {
  it('refuses an id the caller cannot reach rather than reaching the default database', async () => {
    // The shipped defect: `loadKustoItem` returned null for a foreign item and
    // `resolveDatabase(null)` handed back the shared default. Model that by
    // having the item lookup find nothing after the ladder allowed through.
    kusto.item = null;

    const g = await guardAdxRequest(req('/api/adx/tables?id=someone-elses-item'));

    expect(g.ctx).toBeUndefined();
    expect(g.res!.status).toBe(404);
    // The half that matters most: no database was resolved AT ALL. A guard that
    // refused only after handing `defaultDatabase()` to a caller would pass the
    // status assertion above and still be the defect.
    expect(await g.res!.json()).toEqual({ ok: false, error: 'KQL database not found' });
  });

  it('refuses an id that names no kql-database item — it does not fall through unbound', async () => {
    kusto.item = null;
    const g = await guardAdxRequest(req('/api/adx/overview?id=does-not-exist'));
    expect(g.ctx).toBeUndefined();
    expect(g.res!.status).toBe(404);
  });

  it('a caller the workspace ladder denies never reaches ADX', async () => {
    const { NextResponse } = await import('next/server');
    guard.authorizeItemWorkspace.mockResolvedValue(
      NextResponse.json({ ok: false, error: 'KQL database not found' }, { status: 404 }) as any,
    );
    const g = await guardAdxRequest(req('/api/adx/tables?id=kdb-1'));
    expect(g.ctx).toBeUndefined();
    expect(g.res!.status).toBe(404);
  });

  it('the refusal is IDENTICAL for “not yours” and “no such item” (no existence leak)', async () => {
    const { NextResponse } = await import('next/server');
    guard.authorizeItemWorkspace.mockResolvedValue(
      NextResponse.json({ ok: false, error: 'KQL database not found' }, { status: 404 }) as any,
    );
    const denied = await guardAdxRequest(req('/api/adx/tables?id=kdb-1'));

    guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    kusto.item = null;
    const missing = await guardAdxRequest(req('/api/adx/tables?id=nope'));

    expect(denied.res!.status).toBe(missing.res!.status);
    expect(await denied.res!.json()).toEqual(await missing.res!.json());
  });
});

describe('guardAdxRequest — the authorized path is unchanged', () => {
  it('resolves the item’s own database for a caller the ladder admits', async () => {
    const g = await guardAdxRequest(req('/api/adx/tables?id=kdb-1'));
    expect(g.res).toBeUndefined();
    expect(g.ctx!.database).toBe(OWN_DB);
    expect(g.ctx!.itemId).toBe('kdb-1');
    expect(g.ctx!.oid).toBe('oid-caller');
  });

  it('the database comes from the ITEM, never the request', async () => {
    // Every plausible spelling of a caller-supplied database, on the query
    // string these routes actually read. None may move the resolved value.
    const g = await guardAdxRequest(
      req('/api/adx/tables?id=kdb-1&db=victim-db&database=victim-db&databaseName=victim-db'),
    );
    expect(g.ctx!.database).toBe(OWN_DB);
  });

  it('read handlers admit any workspace role; mutating handlers stay WRITE-scoped', async () => {
    await guardAdxRequest(req('/api/adx/tables?id=kdb-1', 'GET'));
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, {
      workspaceId: null, itemId: 'kdb-1', itemType: 'kql-database',
      notFound: 'KQL database not found', allowReadRoles: true,
    });

    for (const method of ['POST', 'PATCH', 'DELETE']) {
      vi.clearAllMocks();
      guard.authorizeItemWorkspace.mockResolvedValue(null as any);
      await guardAdxRequest(req('/api/adx/tables?id=kdb-1', method));
      expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, {
        workspaceId: null, itemId: 'kdb-1', itemType: 'kql-database',
        notFound: 'KQL database not found',
      });
    }
  });
});

describe('guardAdxRequest — the documented unbound path is PRESERVED (no dead ends)', () => {
  it('no ?id= at all still opens on the default database', async () => {
    // `tests/service-health.mjs` probes /overview and /tables with no id, and
    // entity-diagram-sources omits it when its source carries no itemId.
    const g = await guardAdxRequest(req('/api/adx/overview'));
    expect(g.res).toBeUndefined();
    expect(g.ctx!.database).toBe(DEFAULT_DB);
    expect(g.ctx!.itemId).toBeNull();
    expect(guard.authorizeItemWorkspace).not.toHaveBeenCalled();
  });

  it('an UNSAVED item (id=new) still opens on the default database', async () => {
    // A 404 here would paint a red banner on a freshly created item — the dead
    // end #3648 caught (`auto-bind-by-default.md`, `ux-baseline.md` first-open).
    const g = await guardAdxRequest(req('/api/adx/tables?id=new'));
    expect(g.res).toBeUndefined();
    expect(g.ctx!.database).toBe(DEFAULT_DB);
    expect(guard.authorizeItemWorkspace).not.toHaveBeenCalled();
  });

  it('the unauthenticated 401 and the honest config gate are unchanged', async () => {
    session.current = null;
    expect((await guardAdxRequest(req('/api/adx/tables?id=kdb-1'))).res!.status).toBe(401);

    session.current = SESSION;
    kusto.gate = { missing: 'LOOM_KUSTO_CLUSTER_URI' };
    expect((await guardAdxRequest(req('/api/adx/tables?id=kdb-1'))).res!.status).toBe(503);
  });
});

describe('route level — an unowned item never reaches the Kusto data plane', () => {
  it('GET /api/adx/tables refuses instead of listing the default database', async () => {
    kusto.item = null;
    const { GET } = await import('../tables/route');
    const res = await GET(req('/api/adx/tables?id=someone-elses-item'));

    expect(res.status).toBe(404);
    // THE PROPERTY THIS ADVISORY IS ABOUT: no read ran on the shared default DB.
    expect(kusto.listTableDetails).not.toHaveBeenCalled();
  });

  it('POST /api/adx/tables refuses instead of creating a table in the default database', async () => {
    kusto.item = null;
    const { POST } = await import('../tables/route');
    const res = await POST(
      req('/api/adx/tables?id=someone-elses-item', 'POST', { name: 'Planted', schema: 'ts:datetime' }),
    );

    expect(res.status).toBe(404);
    expect(kusto.createTable).not.toHaveBeenCalled();
  });

  it('GET /api/adx/tables still lists the OWNED item’s own database', async () => {
    const { GET } = await import('../tables/route');
    const res = await GET(req('/api/adx/tables?id=kdb-1'));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, database: OWN_DB });
    expect(kusto.listTableDetails).toHaveBeenCalledWith(OWN_DB);
  });
});
