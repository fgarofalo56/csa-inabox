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
 *   1. `_shared.ts` — drop `if (!found) return { res: … 404 }`
 *        → "refuses an id that names no ADX-backed item" and the no-leak spec
 *          fail. ALSO `tsc` exit 2 (TS18047 `'found' is possibly 'null'`) —
 *          see mutation 8 for why that is not a substitute for this file.
 *   2. `_shared.ts` — drop `if (denied) return { res: denied };`
 *        → 6 specs fail, including both route-level refusals: with Layer 1
 *          discarded a foreign item reaches ADX on ITS OWN database.
 *   3. `_shared.ts` — pass `allowReadRoles: true` unconditionally
 *        → "mutating handlers stay WRITE-scoped" fails on the extra key.
 *   4. `_shared.ts` — refuse whenever `itemId` is set, dropping the
 *      `UNSAVED_ITEM_ID` short-circuit
 *        → "an UNSAVED item still opens on the default database" fails. That
 *          test is the dead-end guard (#3648): a 404 here paints a red banner
 *          on a freshly created item.
 *   7. `_shared.ts` — drop `kql-dashboard` from `ITEM_FAMILIES`, i.e. restore
 *      the REGRESSION independent review caught on the first cut of this fix
 *        → all three "kql-DASHBOARD family is reachable" specs and the
 *          route-level dashboard spec fail (`expected 404 to be 200`).
 *          tsc-clean (exit 0).
 *   8. `_shared.ts` — restore the fall-through in a form the TYPE CANNOT SEE
 *      (return a ctx on `!found` instead of destructuring it)
 *        → `tsc` exit 0, the same two specs as mutation 1 fail. RECORDED
 *          BECAUSE IT CORRECTS AN EARLIER CLAIM: on the first cut of this fix
 *          mutation 1 itself was tsc-clean, and the note here said so. The
 *          two-family rewrite made `found` a destructured binding, so tsc now
 *          catches the NAIVE deletion — but not this one. The advisory's
 *          recorded lesson holds in its precise form: the type bites only for
 *          code that goes on to CONSUME the binding, so it is not a substitute
 *          for the spec.
 *
 * MOCK FIDELITY IS PART OF THE PROOF. `loadKustoItemUnscoped` and
 * `authorizeItemWorkspace` are both ARGUMENT-AWARE here. An earlier cut mocked
 * the loader as `vi.fn(async () => kusto.item)` — ignoring both arguments — so
 * it modelled a loader with no itemType filter, and mutation 7 could not be
 * seen by it at all. The real predicate is `c.id = @id AND c.itemType = @t`;
 * a mock that drops the axis the defect turns on cannot control for it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const SESSION = { claims: { oid: 'oid-caller', tid: 'tid-1', upn: 'u@loom.test', groups: [] } } as any;
const session = vi.hoisted(() => ({ current: null as any }));
vi.mock('@/lib/auth/session', () => ({ getSession: () => session.current }));

/**
 * ARGUMENT-AWARE, deliberately. A mock that ignores its arguments models a
 * loader with NO itemType filter — and the itemType axis is the one the
 * dashboard regression turns on, so an argument-blind mock cannot see it. The
 * real predicate is `c.id = @id AND c.itemType = @t` (`kusto-client.ts:2053`),
 * and `authorizeItemWorkspace` resolves the workspace from the SAME
 * (id, itemType) pair, so both mocks below honour both arguments.
 */
const cosmos = vi.hoisted(() => ({ items: [] as any[] }));
const findItem = (id: string, itemType: string) =>
  cosmos.items.find((i) => i.id === id && i.itemType === itemType) ?? null;

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn() }));
vi.mock('@/lib/auth/workspace-guard', () => guard);

vi.mock('@/lib/api/gate-envelope', () => ({
  apiHonestGateError: (id: string, opts: any) =>
    new Response(JSON.stringify({ ok: false, gated: true, gate: { id }, ...opts }), { status: 503 }),
}));

/** The env-pinned shared database every workspace can already address. */
const DEFAULT_DB = 'loomdb-default';
/** The database bound to the kql-database item the caller owns. */
const OWN_DB = 'ownerdb';
/** The database a kql-dashboard's tiles actually query (via its sibling). */
const DASH_DB = 'dashboarddb';

const ITEM: any = {
  id: 'kdb-1', itemType: 'kql-database', workspaceId: 'ws-1',
  displayName: 'Telemetry', state: { databaseName: OWN_DB },
};
/**
 * A Real-Time Dashboard the caller owns. `adx/anomaly` is reached with THIS
 * id from `kql-dashboard-editor.tsx:2120` → `anomaly-forecast.tsx:162`.
 */
const DASHBOARD: any = {
  id: 'dash-1', itemType: 'kql-dashboard', workspaceId: 'ws-1',
  displayName: 'Change Feed Health', state: { databaseName: DASH_DB },
};

const kusto = vi.hoisted(() => ({
  gate: null as any,
  listTableDetails: vi.fn(async () => [{ name: 'Events', totalRowCount: 12 }]),
  createTable: vi.fn(async () => ({ rowCount: 0 })),
}));
vi.mock('@/lib/azure/kusto-client', () => ({
  KustoError: class extends Error { status = 502; },
  kustoConfigGate: () => kusto.gate,
  defaultDatabase: () => DEFAULT_DB,
  resolvedClusterUri: async () => 'https://adx.example.net',
  // The REAL resolvers — the fall-through under test lives in them, so stubbing
  // them would hide the very behaviour this file asserts.
  resolveDatabase: (i: any) => {
    const n = i?.state?.databaseName;
    return typeof n === 'string' && n.trim() ? n.trim() : DEFAULT_DB;
  },
  resolveDashboardDatabase: async (i: any) => {
    const n = i?.state?.databaseName;
    return typeof n === 'string' && n.trim() ? n.trim() : DEFAULT_DB;
  },
  loadKustoItemUnscoped: vi.fn(async (id: string, itemType: string) => findItem(id, itemType)),
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
  cosmos.items = [ITEM, DASHBOARD];
  kusto.gate = null;
  // Faithful to the real ladder: it allows (returns null) when the caller may
  // reach the workspace, AND — the load-bearing case here — when the id names
  // no item of that type at all (`workspace-guard.ts:142`). Denial is opted
  // into per-test by pointing this at a foreign workspace.
  guard.authorizeItemWorkspace.mockImplementation(async (_s: any, opts: any) => {
    const item = findItem(opts.itemId, opts.itemType);
    if (!item) return null;                       // no such item → nothing to gate
    if (item.workspaceId === 'ws-1') return null; // the caller's own workspace
    const { NextResponse } = await import('next/server');
    return NextResponse.json({ ok: false, error: opts.notFound }, { status: 404 });
  });
});

describe('guardAdxRequest — an id the caller cannot reach is REFUSED', () => {
  it('refuses an id the caller cannot reach rather than reaching the default database', async () => {
    // The shipped defect: `loadKustoItem` returned null for a foreign item and
    // `resolveDatabase(null)` handed back the shared default. Model that with a
    // real item that lives in ANOTHER tenant's workspace — it is still FOUND
    // (the lookup is cross-partition), and refused by the ladder.
    cosmos.items = [{ ...ITEM, id: 'someone-elses-item', workspaceId: 'ws-victim' }];

    const g = await guardAdxRequest(req('/api/adx/tables?id=someone-elses-item'));

    expect(g.ctx).toBeUndefined();
    expect(g.res!.status).toBe(404);
    // The half that matters most: no database was resolved AT ALL. A guard that
    // refused only after handing `defaultDatabase()` to a caller would pass the
    // status assertion above and still be the defect.
    expect(await g.res!.json()).toEqual({ ok: false, error: 'KQL database not found' });
  });

  it('refuses an id that names no ADX-backed item — it does not fall through unbound', async () => {
    cosmos.items = [];
    const g = await guardAdxRequest(req('/api/adx/overview?id=does-not-exist'));
    expect(g.ctx).toBeUndefined();
    expect(g.res!.status).toBe(404);
  });

  it('a caller the workspace ladder denies never reaches ADX', async () => {
    cosmos.items = [{ ...ITEM, workspaceId: 'ws-victim' }];
    const g = await guardAdxRequest(req('/api/adx/tables?id=kdb-1'));
    expect(g.ctx).toBeUndefined();
    expect(g.res!.status).toBe(404);
  });

  it('the refusal is IDENTICAL for “not yours” and “no such item” (no existence leak)', async () => {
    cosmos.items = [{ ...ITEM, workspaceId: 'ws-victim' }];
    const denied = await guardAdxRequest(req('/api/adx/tables?id=kdb-1'));

    cosmos.items = [];
    const missing = await guardAdxRequest(req('/api/adx/tables?id=nope'));

    expect(denied.res!.status).toBe(missing.res!.status);
    expect(await denied.res!.json()).toEqual(await missing.res!.json());
  });
});

/**
 * FINDING 1 from independent review of the first cut of this fix. The guard
 * hard-coded `itemType: 'kql-database'`, but `adx/anomaly` is reached with a
 * kql-DASHBOARD id from the dashboard editor — so the guard 404'd the
 * dashboard's own creator before the handler's dashboard-aware resolution ran.
 *
 * This is the cheap in-suite stand-in for the browser walk that would have
 * caught it in thirty seconds. It is NOT a substitute for one.
 */
describe('guardAdxRequest — the kql-DASHBOARD family is reachable (regression #1)', () => {
  it('a kql-dashboard id the caller may reach returns a ctx with the DASHBOARD’s database', async () => {
    const g = await guardAdxRequest(req('/api/adx/anomaly?id=dash-1', 'POST'));

    expect(g.res).toBeUndefined();
    expect(g.ctx!.database).toBe(DASH_DB);
    expect(g.ctx!.itemId).toBe('dash-1');
  });

  it('authorizes the dashboard against ITS OWN itemType, not kql-database', async () => {
    await guardAdxRequest(req('/api/adx/anomaly?id=dash-1', 'POST'));
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, {
      workspaceId: null, itemId: 'dash-1', itemType: 'kql-dashboard',
      notFound: 'KQL database not found',
    });
  });

  it('still refuses a dashboard in another tenant’s workspace', async () => {
    cosmos.items = [{ ...DASHBOARD, workspaceId: 'ws-victim' }];
    const g = await guardAdxRequest(req('/api/adx/anomaly?id=dash-1', 'POST'));
    expect(g.ctx).toBeUndefined();
    expect(g.res!.status).toBe(404);
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
    cosmos.items = [{ ...ITEM, id: 'someone-elses-item', workspaceId: 'ws-victim' }];
    const { GET } = await import('../tables/route');
    const res = await GET(req('/api/adx/tables?id=someone-elses-item'));

    expect(res.status).toBe(404);
    // THE PROPERTY THIS ADVISORY IS ABOUT: no read ran on the shared default DB.
    expect(kusto.listTableDetails).not.toHaveBeenCalled();
  });

  it('POST /api/adx/tables refuses instead of creating a table in the default database', async () => {
    cosmos.items = [{ ...ITEM, id: 'someone-elses-item', workspaceId: 'ws-victim' }];
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

  it('GET /api/adx/tables works for a kql-DASHBOARD id too (regression #1, route level)', async () => {
    // Before this fix the guard only knew `kql-database`, so a dashboard id
    // 404'd its own creator. There was no test on `adx/anomaly` at all — which
    // is how the regression shipped past a full green gate battery.
    const { GET } = await import('../tables/route');
    const res = await GET(req('/api/adx/tables?id=dash-1'));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, database: DASH_DB });
    expect(kusto.listTableDetails).toHaveBeenCalledWith(DASH_DB);
  });
});
