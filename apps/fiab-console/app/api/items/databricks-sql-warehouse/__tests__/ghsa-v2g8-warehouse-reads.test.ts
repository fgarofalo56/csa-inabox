/**
 * GHSA-v2g8-gp3r-rg4r — authorization suite for the NINE remaining members of
 * the `databricks-sql-warehouse/[id]/*` family (eighth pass). With these the
 * family is closed at Layer 1: 17 files, 17 guarded.
 *
 *   POST [id]/cancel         cancelStatement        MUTATION — aborts a running query
 *   POST [id]/create         createWarehouse /      MUTATION — provisions infrastructure
 *                            createDedicatedSqlPool            (both boundaries)
 *   GET  [id]/connection     odbc_params            read — hostname/JDBC reconnaissance
 *   POST [id]/iqy            (no backend call)      read — mints an Excel web-query
 *   GET  [id]/query-history  listQueryHistory       read — workspace-wide SQL text
 *   GET  [id]/query-profile  getQueryProfile        read — full SQL + plan by statement id
 *   GET  [id]/schema         SHOW …                 read — the enumeration primitive
 *   GET  [id]/script-out     SHOW CREATE …          read — full object source
 *   GET  [id]/warehouses     listWarehouses         read — discovery list, WITH A CARVE-OUT
 *
 * WHAT THIS FILE IS FOR: the AUTHORIZATION contract — authentication FIRST on
 * every verb and every short-circuit, an unowned item refused, the unsaved-item
 * gates not becoming holes, and THE READ/WRITE SPLIT ASSERTED RATHER THAN
 * ASSUMED. The advisory is explicit that these are not interchangeable —
 * `cancel` takes a `statementId`, `create` takes a creation spec,
 * `query-profile` takes a `queryId` — so each is pinned individually below.
 *
 * THE 401 CASES ARE THE POINT, not filler. Review of #3655 MEASURED that a
 * type / `id === 'new'` / config short-circuit placed ABOVE the session read
 * makes a route answer an UNAUTHENTICATED request with 200 where it returned
 * 401, and `apps/fiab-console` has no `middleware.ts`, so the handler is the
 * only enforcement point. Every verb here is asserted at a real id AND at
 * `id === 'new'` — including `warehouses`, whose `new` path deliberately skips
 * Layer 1 and therefore needs that assertion most.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  getSession: vi.fn(),
}));
vi.mock('@/lib/auth/workspace-guard', () => ({ authorizeItemWorkspace: vi.fn(async () => null) }));

/** `sw-1` is the owned item, in workspace `ws-1`. An id matching nothing models
 *  the "names no item" case the guard must FAIL CLOSED on. */
const ITEMS = [
  { id: 'sw-1', itemType: 'databricks-sql-warehouse', workspaceId: 'ws-1', state: {} },
];
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const id = spec?.parameters?.find((p: any) => p.name === '@id')?.value;
          const t = spec?.parameters?.find((p: any) => p.name === '@t')?.value;
          return { resources: ITEMS.filter((i) => (!id || i.id === id) && (!t || i.itemType === t)) };
        },
      }),
    },
  }),
}));
vi.mock('@/lib/azure/databricks-client', () => ({
  executeStatement: vi.fn(),
  getWarehouse: vi.fn(),
  listWarehouses: vi.fn(),
  listQueryHistory: vi.fn(),
  getQueryProfile: vi.fn(),
  cancelStatement: vi.fn(),
  cancelByClientId: vi.fn(),
  createWarehouse: vi.fn(),
  databricksConfigGate: vi.fn(() => null),
}));
vi.mock('@/lib/azure/synapse-dev-client', () => ({
  listDedicatedSqlPools: vi.fn(),
  createDedicatedSqlPool: vi.fn(),
}));
// Spread the REAL module and override only `isGovCloud`. A narrow factory drops
// `armScope` and every other export the client chain imports, which surfaces as
// a collection error rather than a test failure.
vi.mock('@/lib/azure/cloud-endpoints', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/azure/cloud-endpoints')>()),
  isGovCloud: vi.fn(() => false),
}));
vi.mock('@/lib/azure/topology', () => ({
  prepareItemCreate: vi.fn(),
  isDeployTargetGate: vi.fn(() => false),
}));
vi.mock('@/app/api/items/_lib/connection-handler', () => ({
  handleConnectionDetails: vi.fn(async () => new Response(JSON.stringify({ ok: true, hostname: 'h' }), { status: 200 })),
}));
vi.mock('@/lib/sql/quoting', () => ({ quoteIdent: (s: string) => s }));

import { POST as cancelPOST } from '../[id]/cancel/route';
import { GET as connectionGET } from '../[id]/connection/route';
import { POST as createPOST } from '../[id]/create/route';
import { POST as iqyPOST } from '../[id]/iqy/route';
import { GET as historyGET } from '../[id]/query-history/route';
import { GET as profileGET } from '../[id]/query-profile/route';
import { GET as schemaGET } from '../[id]/schema/route';
import { GET as scriptOutGET } from '../[id]/script-out/route';
import { GET as warehousesGET } from '../[id]/warehouses/route';

import { getSession } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import {
  executeStatement, getWarehouse, listWarehouses, listQueryHistory, getQueryProfile,
  cancelStatement, cancelByClientId, createWarehouse, databricksConfigGate,
} from '@/lib/azure/databricks-client';
import { listDedicatedSqlPools, createDedicatedSqlPool } from '@/lib/azure/synapse-dev-client';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import { prepareItemCreate, isDeployTargetGate } from '@/lib/azure/topology';
import { handleConnectionDetails } from '@/app/api/items/_lib/connection-handler';

const SESSION = { claims: { upn: 'u@contoso.com', oid: 'oid-1', tid: 'tid-1' }, exp: 9_999_999_999 };

/** A request with a query string and an optional JSON body. */
function req(qs = '', body: any = {}) {
  const url = new URL(`http://x/${qs}`);
  return { url: url.toString(), nextUrl: url, json: async () => body } as any;
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as any;

/**
 * Every (name, handler, request, scope) tuple under test. `scope` is the
 * EXPECTED Layer-1 read/write decision — the split is data here, so the
 * assertion below is exhaustive over the surface rather than sampled.
 */
type Verb = [name: string, handler: (r: any, c: any) => Promise<Response>, request: any, scope: 'read' | 'write'];
const VERBS: Verb[] = [
  ['cancel POST', cancelPOST as any, req('', { statementId: 'st-victim' }), 'write'],
  ['create POST', createPOST as any, req('', { name: 'wh-new' }), 'write'],
  ['connection GET', connectionGET as any, req('?warehouseId=wh-victim'), 'read'],
  ['iqy POST', iqyPOST as any, req('', { sql: 'SELECT 1', warehouseId: 'wh-victim' }), 'read'],
  ['query-history GET', historyGET as any, req('?warehouseId=wh-victim'), 'read'],
  ['query-profile GET', profileGET as any, req('?queryId=st-victim'), 'read'],
  ['schema GET', schemaGET as any, req('?warehouseId=wh-victim'), 'read'],
  ['script-out GET', scriptOutGET as any, req('?warehouseId=wh-victim&catalog=c&schema=s&name=n&type=view&mode=drop'), 'read'],
  ['warehouses GET', warehousesGET as any, req(''), 'read'],
];

/** Asserts NO data-plane call of any kind was reached. */
function expectNoDataPlaneCall() {
  for (const spy of [
    executeStatement, getWarehouse, listWarehouses, listQueryHistory, getQueryProfile,
    cancelStatement, cancelByClientId, createWarehouse, listDedicatedSqlPools, createDedicatedSqlPool,
    handleConnectionDetails,
  ]) expect(spy).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  (authorizeItemWorkspace as any).mockResolvedValue(null);
  (databricksConfigGate as any).mockReturnValue(null);
  (isGovCloud as any).mockReturnValue(false);
  (isDeployTargetGate as any).mockReturnValue(false);
  (getWarehouse as any).mockResolvedValue({ state: 'RUNNING' });
  (listWarehouses as any).mockResolvedValue([{ id: 'wh-1', name: 'w', state: 'RUNNING' }]);
  (listQueryHistory as any).mockResolvedValue({ entries: [] });
  (getQueryProfile as any).mockResolvedValue({ query_id: 'st-1', metrics: {} });
  (executeStatement as any).mockResolvedValue({ rows: [['ddl']], columns: ['c'] });
  (createWarehouse as any).mockResolvedValue({ id: 'wh-new' });
  (prepareItemCreate as any).mockResolvedValue({ subscriptionId: 'sub', resourceGroup: 'rg', tier: 't', domainId: 'd' });
  (handleConnectionDetails as any).mockResolvedValue(
    new Response(JSON.stringify({ ok: true, hostname: 'h' }), { status: 200 }),
  );
});

describe('LAYER 0 — authentication is FIRST, on every verb and every short-circuit', () => {
  for (const [name, handler, request] of VERBS) {
    it(`${name}: 401 with no session on a REAL id`, async () => {
      (getSession as any).mockReturnValue(null);
      const res = await handler(request, ctx('sw-1'));
      expect(res.status).toBe(401);
    });

    // The regression #3655 shipped and had to fix. It matters most on
    // `warehouses`, whose `new` path deliberately skips Layer 1 — the carve-out
    // is INSIDE `withSession`, so it must not become an unauthenticated read.
    it(`${name}: 401 with no session at id === 'new'`, async () => {
      (getSession as any).mockReturnValue(null);
      const res = await handler(request, ctx('new'));
      expect(res.status).toBe(401);
      const j = await res.json();
      expect(j.ok).toBe(false);
      expect(j.code).not.toBe('unsaved_item');
    });

    it(`${name}: 401 with no session reaches NO data-plane call`, async () => {
      (getSession as any).mockReturnValue(null);
      await handler(request, ctx('sw-1'));
      await handler(request, ctx('new'));
      expectNoDataPlaneCall();
    });
  }
});

describe('LAYER 1 — the route item must be owned', () => {
  beforeEach(() => { (getSession as any).mockReturnValue(SESSION); });

  for (const [name, handler, request] of VERBS) {
    it(`${name}: 404 when the workspace ladder DENIES`, async () => {
      (authorizeItemWorkspace as any).mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: 'denied' }), { status: 404 }),
      );
      const res = await handler(request, ctx('sw-1'));
      expect(res.status).toBe(404);
    });

    // `authorizeItemWorkspace` returns null (= allow) for an id naming no item.
    // The guard closes that permissive case; without it the handler would run
    // UNBOUND against the caller-named resource.
    it(`${name}: 404 when the id names NO item (guard fails closed)`, async () => {
      const res = await handler(request, ctx('does-not-exist'));
      expect(res.status).toBe(404);
    });

    it(`${name}: a DENIED request reaches no data-plane call`, async () => {
      await handler(request, ctx('does-not-exist'));
      expectNoDataPlaneCall();
    });
  }

  /**
   * THE READ/WRITE SPLIT, ASSERTED PER ROUTE — exhaustive over VERBS, so adding
   * a route without deciding its scope fails here rather than inheriting one.
   *
   * `cancel` and `create` are WRITES on their own evidence, not by name:
   * `cancelStatement` aborts a running query, and `create` provisions billed
   * infrastructure (a whole DATABASE on the Gov branch). The seven reads make no
   * mutating call — note `script-out`'s `drop` branch only FORMATS a DROP string
   * and returns it without executing, which is why "it emits DROP" is the wrong
   * reason to call it a write.
   */
  it('each route carries the scope its effects justify — write for cancel/create, read for the rest', async () => {
    for (const [name, handler, request, scope] of VERBS) {
      (authorizeItemWorkspace as any).mockClear();
      await handler(request, ctx('sw-1'));
      const calls = (authorizeItemWorkspace as any).mock.calls;
      if (name === 'warehouses GET') expect(calls.length, name).toBe(1);
      expect(!!calls[0]?.[1]?.allowReadRoles, `${name} expected ${scope}-scoped`).toBe(scope === 'read');
    }
  });

  // The config gate must sit BELOW the guard, so a caller who cannot reach the
  // item does not learn the deployment's Databricks configuration state.
  for (const [name, handler, request] of [
    ['cancel POST', cancelPOST, req('', { statementId: 'st' })] as const,
    ['query-profile GET', profileGET, req('?queryId=st')] as const,
  ]) {
    it(`${name}: an unowned caller gets 404, NOT the 503 config gate`, async () => {
      (databricksConfigGate as any).mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' });
      const res = await (handler as any)(request, ctx('does-not-exist'));
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toMatch(/LOOM_DATABRICKS_HOSTNAME/);
    });
  }

  // `create` branches on cloud AFTER the guard, so ONE check covers both
  // boundaries. Asserted rather than inferred: `cloud-parity.md` — a
  // Commercial-only receipt proves nothing about Gov, and the Gov branch here
  // creates a DATABASE.
  it('create: the guard runs ABOVE the cloud branch — Gov is refused too', async () => {
    (isGovCloud as any).mockReturnValue(true);
    process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-ws';
    const res = await createPOST(req('', { name: 'p', gov_sku: 'DW100c' }) as any, ctx('does-not-exist') as any);
    expect(res.status).toBe(404);
    expect(createDedicatedSqlPool).not.toHaveBeenCalled();
  });
});

describe("the unsaved-item gates (id === 'new')", () => {
  beforeEach(() => { (getSession as any).mockReturnValue(SESSION); });

  // Everything except `warehouses`, which deliberately serves the list at `new`.
  const GATED = VERBS.filter(([n]) => n !== 'warehouses GET');

  for (const [name, handler, request] of GATED) {
    it(`${name}: returns the honest gate, NOT a 404 dead end`, async () => {
      const res = await handler(request, ctx('new'));
      const j = await res.json();
      expect(j.ok).toBe(false);
      expect(j.code).toBe('unsaved_item');
      expect(j.error).toMatch(/save this sql warehouse item first/i);
    });

    it(`${name}: the gate reaches NO data-plane call`, async () => {
      await handler(request, ctx('new'));
      expectNoDataPlaneCall();
    });

    // The gate matches the literal id EXACTLY. Real ids are crypto.randomUUID(),
    // so a substring/prefix test would let a real id skip the ownership check.
    it(`${name}: an id merely CONTAINING 'new' is NOT gated — it is authorized`, async () => {
      const res = await handler(request, ctx('new-warehouse-7'));
      expect(res.status).toBe(404);
      const j = await res.json();
      expect(j.code).not.toBe('unsaved_item');
    });
  }

  /**
   * THE STATUS CODES ARE NOT UNIFORM, AND THAT IS THE POINT — each was chosen
   * against its own caller rather than copied from the pattern.
   *
   * 200 for the routes whose caller reads the JSON body and branches on `ok`.
   * 409 for `iqy`, because `openInExcel` (`sql-warehouse-editor.tsx:649`)
   * branches on `r.ok` — the HTTP status — and on the success path calls
   * `r.blob()` and triggers a download. A 200 gate would be SAVED TO DISK as a
   * corrupt `.iqy` that fails silently in Excel later.
   */
  it('iqy gates with 409 (its caller branches on r.ok); the others gate with 200', async () => {
    for (const [name, handler, request] of GATED) {
      const res = await handler(request, ctx('new'));
      expect(res.status, name).toBe(name === 'iqy POST' ? 409 : 200);
    }
  });

  /**
   * THE `warehouses` CARVE-OUT — asserted so it can never become accidental.
   *
   * The editor's mount effect calls this route FIRST and unconditionally, and
   * `sql-warehouse-editor.tsx` has no `isNew` (measured, `grep -c` = 0). Gating
   * it would set `warehousesError` — a red banner on a freshly created item
   * (`ux-baseline.md`) — and leave every other control, all of which gate on
   * `warehouseId`, dead (`auto-bind-by-default.md`).
   */
  it("warehouses: at id === 'new' it SERVES THE LIST rather than gating", async () => {
    const res = await warehousesGET(req('') as any, ctx('new') as any);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.warehouses).toHaveLength(1);
    expect(j.code).not.toBe('unsaved_item');
    expect(listWarehouses).toHaveBeenCalled();
  });

  it("warehouses: the 'new' carve-out skips Layer 1 but NOT authentication", async () => {
    await warehousesGET(req('') as any, ctx('new') as any);
    expect(authorizeItemWorkspace).not.toHaveBeenCalled();
    // ...and the no-session case is covered in LAYER 0 above, for this verb too.
  });

  /**
   * THE CARVE-OUT MATCHES THE LITERAL ID EXACTLY — and this case exists because
   * a mutation caught its absence, not because it was foreseen.
   *
   * Mutation M18 widened the carve-out to `itemId.includes(UNSAVED_ITEM_ID)` and
   * BOTH controls stayed green: `check-route-guards` cannot see it (the guard
   * call is still present, so the route still carries its signal), and this
   * suite had the exact-match assertion for every OTHER route but had excluded
   * `warehouses` from that loop, because `warehouses` is excluded from `GATED`.
   * The exclusion was correct for the gate-body assertions and WRONG for this
   * one — the carve-out is precisely where a substring test is most dangerous,
   * since it skips Layer 1 outright rather than returning a refusal.
   *
   * Real ids are `crypto.randomUUID()` (`_lib/item-crud.ts:467`), so an id
   * merely CONTAINING `new` must take the guarded path.
   */
  it("warehouses: an id merely CONTAINING 'new' does NOT get the carve-out — it is authorized", async () => {
    const res = await warehousesGET(req('') as any, ctx('new-warehouse-7') as any);
    expect(authorizeItemWorkspace).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(404);
    expect(listWarehouses).not.toHaveBeenCalled();
  });
});

describe('the admitted path still works', () => {
  beforeEach(() => { (getSession as any).mockReturnValue(SESSION); });

  it('cancel cancels the named statement', async () => {
    (cancelStatement as any).mockResolvedValue(undefined);
    const res = await cancelPOST(req('', { statementId: 'st-1' }) as any, ctx('sw-1') as any);
    expect(res.status).toBe(200);
    expect(cancelStatement).toHaveBeenCalledWith('st-1');
  });

  it('cancel still 400s with neither statementId nor clientQueryId, AFTER authorization', async () => {
    const res = await cancelPOST(req('', {}) as any, ctx('sw-1') as any);
    expect(res.status).toBe(400);
    expect(cancelStatement).not.toHaveBeenCalled();
  });

  it('create forwards the Databricks spec on Commercial', async () => {
    const res = await createPOST(req('', { name: 'wh-new', cluster_size: 'Small' }) as any, ctx('sw-1') as any);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j).toMatchObject({ ok: true, id: 'wh-new' });
    expect(createWarehouse).toHaveBeenCalledWith({ name: 'wh-new', cluster_size: 'Small' });
  });

  /**
   * LAYER 2 — the deploy target comes from the AUTHORIZED ITEM, not the request.
   * `workspaceId` decides which DLZ subscription + resource group the Gov pool
   * lands in; a caller-supplied deploy target is the same class of defect as a
   * caller-supplied database name. `sw-1` lives in `ws-1`, and the request below
   * tries to point it at `ws-attacker`.
   */
  it('create resolves the deploy target from the ITEM, ignoring a caller-supplied workspaceId', async () => {
    (isGovCloud as any).mockReturnValue(true);
    process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-ws';
    (createDedicatedSqlPool as any).mockResolvedValue({ name: 'p' });
    await createPOST(
      req('?workspaceId=ws-attacker', { name: 'p', gov_sku: 'DW100c', workspace_id: 'ws-attacker' }) as any,
      ctx('sw-1') as any,
    );
    expect(prepareItemCreate).toHaveBeenCalledWith('ws-1', 'databricks-sql-warehouse');
  });

  it('connection returns the details for the pinned warehouse', async () => {
    const res = await connectionGET(req('?warehouseId=wh-1') as any, ctx('sw-1') as any);
    expect(res.status).toBe(200);
    expect(handleConnectionDetails).toHaveBeenCalledWith('databricks-sql-warehouse', 'wh-1');
  });

  it('iqy emits the WEB web-query pointed at this item\'s query route', async () => {
    const res = await iqyPOST(req('', { sql: 'SELECT 1', warehouseId: 'wh-1' }) as any, ctx('sw-1') as any);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/x-ms-iqy/);
    const text = await res.text();
    expect(text.split('\r\n')[0]).toBe('WEB');
    expect(text).toContain('/api/items/databricks-sql-warehouse/sw-1/query');
  });

  it('query-history lists, and query-profile reads a profile', async () => {
    (listQueryHistory as any).mockResolvedValue({ entries: [{ query_id: 'q' }] });
    const h = await historyGET(req('?warehouseId=wh-1') as any, ctx('sw-1') as any);
    expect(h.status).toBe(200);
    expect((await h.json()).entries).toHaveLength(1);

    const p = await profileGET(req('?queryId=st-1') as any, ctx('sw-1') as any);
    expect(p.status).toBe(200);
    expect(getQueryProfile).toHaveBeenCalledWith('st-1');
  });

  it('query-profile still 400s on a missing queryId, AFTER authorization', async () => {
    const res = await profileGET(req('') as any, ctx('sw-1') as any);
    expect(res.status).toBe(400);
    expect(getQueryProfile).not.toHaveBeenCalled();
  });

  it('schema enumerates catalogs on a RUNNING warehouse', async () => {
    (executeStatement as any).mockResolvedValue({ rows: [['main'], ['system']] });
    const res = await schemaGET(req('?warehouseId=wh-1') as any, ctx('sw-1') as any);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.catalogs).toEqual(['main', 'system']);
  });

  it('schema still 409s when the warehouse is not RUNNING', async () => {
    (getWarehouse as any).mockResolvedValue({ state: 'STOPPED' });
    const res = await schemaGET(req('?warehouseId=wh-1') as any, ctx('sw-1') as any);
    expect(res.status).toBe(409);
  });

  it('script-out formats DROP without executing anything', async () => {
    const res = await scriptOutGET(
      req('?warehouseId=wh-1&catalog=c&schema=s&name=v&type=view&mode=drop') as any, ctx('sw-1') as any,
    );
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.script).toBe('DROP VIEW IF EXISTS `c`.`s`.`v`;');
    // The read/write split's justification, asserted: the DROP branch reaches no
    // backend at all.
    expect(executeStatement).not.toHaveBeenCalled();
  });

  it('script-out runs SHOW CREATE on the create branch', async () => {
    (executeStatement as any).mockResolvedValue({ rows: [['CREATE VIEW v AS SELECT 1']] });
    const res = await scriptOutGET(
      req('?warehouseId=wh-1&catalog=c&schema=s&name=v&type=view&mode=create') as any, ctx('sw-1') as any,
    );
    expect(res.status).toBe(200);
    expect((executeStatement as any).mock.calls[0][1]).toBe('SHOW CREATE TABLE `c`.`s`.`v`');
  });

  it('warehouses lists on a real, owned id', async () => {
    const res = await warehousesGET(req('') as any, ctx('sw-1') as any);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j).toMatchObject({ ok: true, gov: false });
    expect(j.warehouses).toHaveLength(1);
  });

  it('warehouses takes the Gov branch to the dedicated-pool list', async () => {
    (isGovCloud as any).mockReturnValue(true);
    (listDedicatedSqlPools as any).mockResolvedValue([{ name: 'p1', status: 'Online', sku: { name: 'DW100c' } }]);
    const res = await warehousesGET(req('') as any, ctx('sw-1') as any);
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, gov: true });
    expect(j.warehouses[0]).toMatchObject({ id: 'p1', state: 'RUNNING', cluster_size: 'DW100c' });
    expect(listWarehouses).not.toHaveBeenCalled();
  });
});
