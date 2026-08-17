/**
 * GHSA-v2g8-gp3r-rg4r — authorization suite for the MUTATING members of the
 * `databricks-sql-warehouse/[id]/*` family that this pass fixed:
 *
 *   POST   [id]/state   → stopWarehouse      (mutation: kills live compute)
 *   GET    [id]/state   → getWarehouse       (read)
 *   POST   [id]/start   → startWarehouse     (mutation: starts billed compute)
 *   POST   [id]/edit    → editWarehouse      (mutation: rescale + restart)
 *   POST   [id]/delete  → deleteWarehouse /  (DESTRUCTIVE, irreversible; the Gov
 *                         deleteDedicatedSqlPool   branch destroys the DATABASE)
 *   POST   [id]/clone   → CREATE … CLONE     (materialize-then-read; `replace`
 *                                             OVERWRITES a caller-named table)
 *
 * WHAT THIS FILE IS FOR, stated so it is not mistaken for a contract test: it
 * asserts the AUTHORIZATION contract — that authentication happens FIRST on
 * every verb and every short-circuit path, that an unowned item is refused, and
 * that the unsaved-item gate does not become a hole. The data-plane contracts
 * (which REST call, which SQL, which boundary) are covered by
 * `lib/azure/__tests__/warehouse-create-delete-route.test.ts` and
 * `app/api/items/__tests__/databricks-ctas-clone-routes.test.ts`.
 *
 * THE 401 CASES ARE THE POINT, not filler. Review of #3655 measured that moving
 * a type/`id === 'new'`/config short-circuit ABOVE the session read makes a
 * route answer an UNAUTHENTICATED request with HTTP 200 where it previously
 * returned 401 — and `apps/fiab-console` has no `middleware.ts`, so the handler
 * is the only enforcement point. Every verb here therefore has a no-session
 * assertion, INCLUDING at `id === 'new'`, which is the short-circuit path that
 * regressed there.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/workspace-guard', () => ({ authorizeItemWorkspace: vi.fn(async () => null) }));

/**
 * The Cosmos rows `guardSynapseItemRequest` resolves through
 * `loadSynapseItemRaw`. `sw-1` is the owned item; an id that matches nothing
 * models the "names no item" case the guard must FAIL CLOSED on.
 */
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
  getWarehouse: vi.fn(),
  startWarehouse: vi.fn(),
  stopWarehouse: vi.fn(),
  editWarehouse: vi.fn(),
  deleteWarehouse: vi.fn(),
  executeStatement: vi.fn(),
  databricksConfigGate: vi.fn(() => null),
}));
vi.mock('@/lib/azure/synapse-dev-client', () => ({ deleteDedicatedSqlPool: vi.fn() }));
// Spread the REAL module and override only `isGovCloud`. A narrow factory here
// silently drops `armScope` and every other export the client chain imports,
// which fails as a collection error rather than a test failure.
vi.mock('@/lib/azure/cloud-endpoints', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/azure/cloud-endpoints')>()),
  isGovCloud: vi.fn(() => false),
}));

import { GET as stateGET, POST as statePOST } from '../[id]/state/route';
import { POST as startPOST } from '../[id]/start/route';
import { POST as editPOST } from '../[id]/edit/route';
import { POST as deletePOST } from '../[id]/delete/route';
import { POST as clonePOST } from '../[id]/clone/route';
import { getSession } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import {
  getWarehouse, startWarehouse, stopWarehouse, editWarehouse, deleteWarehouse,
  executeStatement, databricksConfigGate,
} from '@/lib/azure/databricks-client';
import { deleteDedicatedSqlPool } from '@/lib/azure/synapse-dev-client';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';

const SESSION = { claims: { upn: 'u@contoso.com', oid: 'oid-1', tid: 'tid-1' }, exp: 9_999_999_999 };

/** A request carrying `?warehouseId=` plus an optional JSON body. */
function req(warehouseId = 'wh-victim', body: any = {}) {
  const url = new URL(`http://x/?warehouseId=${encodeURIComponent(warehouseId)}`);
  return { url: url.toString(), nextUrl: url, json: async () => body } as any;
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as any;

/** Every (name, handler, request) triple under test, so the ordering assertions
 *  below are exhaustive over the surface rather than sampled. */
const VERBS: Array<[string, (r: any, c: any) => Promise<Response>, any]> = [
  ['state GET', stateGET as any, req()],
  ['state POST', statePOST as any, req('wh-victim', { action: 'stop' })],
  ['start POST', startPOST as any, req()],
  ['edit POST', editPOST as any, req('wh-victim', { cluster_size: '2X-Small' })],
  ['delete POST', deletePOST as any, req('wh-victim', { warehouseId: 'wh-victim' })],
  ['clone POST', clonePOST as any, req('wh-victim', { warehouseId: 'wh-victim', source: 'a.b.c', target: 'd.e.f' })],
];

/** Asserts NO data-plane call of any kind was reached. */
function expectNoDataPlaneCall() {
  expect(getWarehouse).not.toHaveBeenCalled();
  expect(startWarehouse).not.toHaveBeenCalled();
  expect(stopWarehouse).not.toHaveBeenCalled();
  expect(editWarehouse).not.toHaveBeenCalled();
  expect(deleteWarehouse).not.toHaveBeenCalled();
  expect(deleteDedicatedSqlPool).not.toHaveBeenCalled();
  expect(executeStatement).not.toHaveBeenCalled();
}

/** Asserts no MUTATING data-plane call was reached (reads may legitimately run). */
function expectNoMutation() {
  expect(startWarehouse).not.toHaveBeenCalled();
  expect(stopWarehouse).not.toHaveBeenCalled();
  expect(editWarehouse).not.toHaveBeenCalled();
  expect(deleteWarehouse).not.toHaveBeenCalled();
  expect(deleteDedicatedSqlPool).not.toHaveBeenCalled();
  expect(executeStatement).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  (authorizeItemWorkspace as any).mockResolvedValue(null);
  (databricksConfigGate as any).mockReturnValue(null);
  (isGovCloud as any).mockReturnValue(false);
  (getWarehouse as any).mockResolvedValue({ state: 'STOPPED', name: 'w', cluster_size: 'Small' });
});

describe('LAYER 0 — authentication is FIRST, on every verb and every short-circuit', () => {
  for (const [name, handler, request] of VERBS) {
    it(`${name}: 401 with no session on a REAL id`, async () => {
      (getSession as any).mockReturnValue(null);
      const res = await handler(request, ctx('sw-1'));
      expect(res.status).toBe(401);
    });

    // The regression #3655 shipped and had to fix: the unsaved-item gate sitting
    // ABOVE the session read turns this into a 200.
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
  for (const [name, handler, request] of VERBS) {
    it(`${name}: 404 when the workspace ladder DENIES`, async () => {
      (getSession as any).mockReturnValue(SESSION);
      (authorizeItemWorkspace as any).mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: 'denied' }), { status: 404 }),
      );
      const res = await handler(request, ctx('sw-1'));
      expect(res.status).toBe(404);
    });

    // `authorizeItemWorkspace` returns null (= allow) for an id naming no item.
    // The guard closes that permissive case; without it the handler would run
    // UNBOUND against the caller-named warehouse.
    it(`${name}: 404 when the id names NO item (guard fails closed)`, async () => {
      (getSession as any).mockReturnValue(SESSION);
      const res = await handler(request, ctx('does-not-exist'));
      expect(res.status).toBe(404);
    });

    it(`${name}: a DENIED request reaches no data-plane call`, async () => {
      (getSession as any).mockReturnValue(SESSION);
      await handler(request, ctx('does-not-exist'));
      expectNoDataPlaneCall();
    });
  }

  it('the READ verb admits a shared read role; every MUTATION does NOT', async () => {
    (getSession as any).mockReturnValue(SESSION);
    for (const [, handler, request] of VERBS) await handler(request, ctx('sw-1'));
    const scopes = (authorizeItemWorkspace as any).mock.calls.map((c: any[]) => !!c[1]?.allowReadRoles);
    // Order matches VERBS: state GET read-scoped; the five mutations write-scoped.
    expect(scopes).toEqual([true, false, false, false, false, false]);
  });

  // The delete route branches on cloud AFTER the guard, so ONE check covers both
  // boundaries. Asserted rather than inferred: `cloud-parity.md` — a
  // Commercial-only receipt proves nothing about Gov, and the Gov branch here is
  // the more destructive of the two (an ARM pool delete takes the DATABASE).
  it('delete: the guard runs ABOVE the cloud branch — Gov is refused too', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (isGovCloud as any).mockReturnValue(true);
    process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-ws';
    const res = await deletePOST(req('loom-pool', { warehouseId: 'loom-pool' }) as any, ctx('does-not-exist') as any);
    expect(res.status).toBe(404);
    expect(deleteDedicatedSqlPool).not.toHaveBeenCalled();
  });

  // The config gate must sit BELOW the guard, so a caller who cannot reach the
  // item does not learn the deployment's Databricks configuration state.
  it('clone: an unowned caller gets 404, NOT the 503 config gate', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (databricksConfigGate as any).mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' });
    const res = await clonePOST(
      req('wh', { warehouseId: 'wh', source: 'a.b.c', target: 'd.e.f' }) as any,
      ctx('does-not-exist') as any,
    );
    expect(res.status).toBe(404);
  });
});

describe("the unsaved-item gate (id === 'new')", () => {
  beforeEach(() => { (getSession as any).mockReturnValue(SESSION); });

  for (const [name, handler, request] of VERBS) {
    it(`${name}: returns the honest gate, NOT a 404 dead end`, async () => {
      const res = await handler(request, ctx('new'));
      expect(res.status).toBe(200);
      const j = await res.json();
      expect(j.ok).toBe(false);
      expect(j.code).toBe('unsaved_item');
      // The message must be the actionable next step, not a refusal — `saveEdit`
      // renders it verbatim as the Edit dialog's error text.
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
});

describe('the admitted path still works', () => {
  beforeEach(() => { (getSession as any).mockReturnValue(SESSION); });

  it('state GET returns the live warehouse state', async () => {
    (getWarehouse as any).mockResolvedValue({ state: 'RUNNING', name: 'w1', cluster_size: 'Small' });
    const res = await stateGET(req('wh-1') as any, ctx('sw-1') as any);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j).toMatchObject({ ok: true, state: 'RUNNING', name: 'w1' });
    expect(getWarehouse).toHaveBeenCalledWith('wh-1');
  });

  it('state POST stops the warehouse', async () => {
    const res = await statePOST(req('wh-1', { action: 'stop' }) as any, ctx('sw-1') as any);
    expect(res.status).toBe(200);
    expect(stopWarehouse).toHaveBeenCalledWith('wh-1');
  });

  it('state POST still rejects an unsupported action with 400', async () => {
    const res = await statePOST(req('wh-1', { action: 'melt' }) as any, ctx('sw-1') as any);
    expect(res.status).toBe(400);
    expect(stopWarehouse).not.toHaveBeenCalled();
  });

  it('start POST starts a stopped warehouse and returns 202', async () => {
    const res = await startPOST(req('wh-1') as any, ctx('sw-1') as any);
    expect(res.status).toBe(202);
    expect(startWarehouse).toHaveBeenCalledWith('wh-1');
  });

  it('start POST short-circuits an already-RUNNING warehouse', async () => {
    (getWarehouse as any).mockResolvedValue({ state: 'RUNNING' });
    const res = await startPOST(req('wh-1') as any, ctx('sw-1') as any);
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, state: 'RUNNING', alreadyRunning: true });
    expect(startWarehouse).not.toHaveBeenCalled();
  });

  it('edit POST forwards the scale spec', async () => {
    const res = await editPOST(
      req('wh-1', { cluster_size: 'Large', max_num_clusters: 4, warehouse_type: 'PRO' }) as any,
      ctx('sw-1') as any,
    );
    expect(res.status).toBe(200);
    expect(editWarehouse).toHaveBeenCalledWith('wh-1', {
      cluster_size: 'Large', max_num_clusters: 4, warehouse_type: 'PRO',
    });
  });

  it('delete POST deletes the Databricks warehouse when stopped', async () => {
    const res = await deletePOST(req('wh-1', { warehouseId: 'wh-1' }) as any, ctx('sw-1') as any);
    expect(res.status).toBe(200);
    expect(deleteWarehouse).toHaveBeenCalledWith('wh-1');
  });

  it('delete POST still 409s a RUNNING warehouse without force', async () => {
    (getWarehouse as any).mockResolvedValue({ state: 'RUNNING' });
    const res = await deletePOST(req('wh-1', { warehouseId: 'wh-1' }) as any, ctx('sw-1') as any);
    const j = await res.json();
    expect(res.status).toBe(409);
    expect(j.code).toBe('warehouse_running');
    expect(deleteWarehouse).not.toHaveBeenCalled();
  });

  it('delete POST takes the Gov branch to the ARM pool delete', async () => {
    (isGovCloud as any).mockReturnValue(true);
    process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-ws';
    const res = await deletePOST(req('loom-pool', { warehouseId: 'loom-pool' }) as any, ctx('sw-1') as any);
    expect(res.status).toBe(200);
    expect(deleteDedicatedSqlPool).toHaveBeenCalledWith('loom-pool');
    expect(deleteWarehouse).not.toHaveBeenCalled();
  });

  it('clone POST emits SHALLOW CLONE and reports zero copied files', async () => {
    (getWarehouse as any).mockResolvedValue({ state: 'RUNNING' });
    (executeStatement as any).mockResolvedValue({
      columns: ['source_table_size', 'source_num_of_files', 'num_copied_files'],
      rows: [[1024, 7, 0]], rowCount: 1, executionMs: 30, truncated: false,
    });
    const res = await clonePOST(
      req('wh-1', { warehouseId: 'wh-1', source: 'main.s.o', target: 'main.d.o', cloneType: 'SHALLOW' }) as any,
      ctx('sw-1') as any,
    );
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.numCopiedFiles).toBe(0);
    expect((executeStatement as any).mock.calls[0][1])
      .toBe('CREATE TABLE IF NOT EXISTS main.d.o SHALLOW CLONE main.s.o');
  });

  it('every verb still 400s on a missing warehouseId, AFTER authorization', async () => {
    // `delete` and `clone` read warehouseId from the BODY, the others from the
    // query — so the empty request must carry neither.
    const noWh = { url: 'http://x/', nextUrl: new URL('http://x/'), json: async () => ({ action: 'stop', source: 'a', target: 'b' }) } as any;
    for (const [name, handler] of VERBS) {
      const res = await handler(noWh, ctx('sw-1'));
      expect(res.status, name).toBe(400);
    }
    expectNoMutation();
  });
});
