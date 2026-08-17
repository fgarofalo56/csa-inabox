/**
 * GHSA-v2g8-gp3r-rg4r — authorization suite for the MUTATING members of the
 * `databricks-sql-warehouse/[id]/*` family that this pass fixed:
 *
 *   POST   [id]/state   → stopWarehouse      (mutation: kills live compute)
 *   GET    [id]/state   → getWarehouse       (read)
 *   POST   [id]/start   → startWarehouse     (mutation: starts billed compute)
 *   POST   [id]/edit    → editWarehouse      (mutation: rescale + restart)
 *
 * WHAT THIS FILE IS FOR, stated so it is not mistaken for a contract test: it
 * asserts the AUTHORIZATION contract — that authentication happens FIRST on
 * every verb and every short-circuit path, that an unowned item is refused, and
 * that the unsaved-item gate does not become a hole. The data-plane contracts
 * (which REST call, which body) are covered by the routes' own behaviour and by
 * `lib/azure/__tests__/warehouse-create-delete-route.test.ts`.
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
}));

import { GET as stateGET, POST as statePOST } from '../[id]/state/route';
import { POST as startPOST } from '../[id]/start/route';
import { POST as editPOST } from '../[id]/edit/route';
import { getSession } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { getWarehouse, startWarehouse, stopWarehouse, editWarehouse } from '@/lib/azure/databricks-client';

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
];

beforeEach(() => {
  vi.resetAllMocks();
  (authorizeItemWorkspace as any).mockResolvedValue(null);
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
      expect(getWarehouse).not.toHaveBeenCalled();
      expect(startWarehouse).not.toHaveBeenCalled();
      expect(stopWarehouse).not.toHaveBeenCalled();
      expect(editWarehouse).not.toHaveBeenCalled();
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
      expect(startWarehouse).not.toHaveBeenCalled();
      expect(stopWarehouse).not.toHaveBeenCalled();
      expect(editWarehouse).not.toHaveBeenCalled();
    });
  }

  it('state GET admits a shared READ role; the mutating verbs do NOT', async () => {
    (getSession as any).mockReturnValue(SESSION);
    await stateGET(req() as any, ctx('sw-1') as any);
    await statePOST(req('wh', { action: 'stop' }) as any, ctx('sw-1') as any);
    await startPOST(req() as any, ctx('sw-1') as any);
    await editPOST(req('wh', {}) as any, ctx('sw-1') as any);
    const scopes = (authorizeItemWorkspace as any).mock.calls.map((c: any[]) => !!c[1]?.allowReadRoles);
    // GET read-scoped; the three mutations write-scoped.
    expect(scopes).toEqual([true, false, false, false]);
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
      expect(getWarehouse).not.toHaveBeenCalled();
      expect(startWarehouse).not.toHaveBeenCalled();
      expect(stopWarehouse).not.toHaveBeenCalled();
      expect(editWarehouse).not.toHaveBeenCalled();
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

  it('every verb still 400s without a warehouseId, AFTER authorization', async () => {
    const noWh = { url: 'http://x/', nextUrl: new URL('http://x/'), json: async () => ({ action: 'stop' }) } as any;
    for (const [, handler] of VERBS) {
      const res = await handler(noWh, ctx('sw-1'));
      expect(res.status).toBe(400);
    }
  });
});
