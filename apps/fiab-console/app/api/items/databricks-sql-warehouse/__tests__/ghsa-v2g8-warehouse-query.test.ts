/**
 * GHSA-v2g8-gp3r-rg4r — authorization suite for `databricks-sql-warehouse/[id]/query`.
 *
 *   POST [id]/query → executeStatement(warehouseId, <caller SQL>)
 *
 * WHY THIS ROUTE GETS ITS OWN FILE. The advisory records it as unauthorized
 * TODAY, separately from the family sweep, because its shape defeated both the
 * guard checker and the published inventory: `withSession` was the entire
 * authorization, `warehouseId` came from the body, and `[id]` WAS read — in
 * `recordQueryRun`, the FinOps attribution receipt, and nowhere else. Two
 * owner-shaped tokens, zero authorization. It published `owner-scoped` on
 * `main` on the strength of exactly that.
 *
 * WHAT THIS FILE IS FOR: the AUTHORIZATION contract — authentication FIRST on
 * every short-circuit path, an unowned item refused, the unsaved-item gate not
 * becoming a hole, and the READ/WRITE SPLIT asserted rather than assumed. The
 * data-plane contract (parameter binding, the 409 state pre-check, the cancel
 * registration) is covered by `app/api/items/__tests__/sql-editor-parity.test.ts`
 * and the databricks client suites.
 *
 * THE 401 CASES ARE THE POINT, not filler. Review of #3655 MEASURED that moving
 * an `id === 'new'` / type / config short-circuit ABOVE the session read makes a
 * route answer an UNAUTHENTICATED request with HTTP 200 where it previously
 * returned 401 — and `apps/fiab-console` has no `middleware.ts`, so the handler
 * is the only enforcement point. The no-session assertion therefore covers the
 * real id AND `id === 'new'`, which is the path that regressed there.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  getSession: vi.fn(),
}));
vi.mock('@/lib/auth/workspace-guard', () => ({ authorizeItemWorkspace: vi.fn(async () => null) }));

/**
 * The Cosmos rows `guardSynapseItemRequest` resolves through
 * `loadSynapseItemRaw`. `sw-1` is the owned item; an id matching nothing models
 * the "names no item" case the guard must FAIL CLOSED on.
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
  executeStatement: vi.fn(),
  getWarehouse: vi.fn(),
  registerPendingStatement: vi.fn(),
  clearPendingStatement: vi.fn(),
}));
vi.mock('@/lib/azure/rate-limiter', () => ({ enforceRateLimit: vi.fn(async () => null) }));
vi.mock('@/lib/finops/query-run', () => ({ recordQueryRun: vi.fn(async () => undefined) }));

import { POST as queryPOST } from '../[id]/query/route';
import { getSession } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { executeStatement, getWarehouse } from '@/lib/azure/databricks-client';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { recordQueryRun } from '@/lib/finops/query-run';

const SESSION = { claims: { upn: 'u@contoso.com', oid: 'oid-1', tid: 'tid-1' }, exp: 9_999_999_999 };

function req(body: any = { sql: 'SELECT 1', warehouseId: 'wh-victim' }) {
  const url = new URL('http://x/');
  return { url: url.toString(), nextUrl: url, json: async () => body } as any;
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as any;

beforeEach(() => {
  vi.resetAllMocks();
  (authorizeItemWorkspace as any).mockResolvedValue(null);
  (enforceRateLimit as any).mockResolvedValue(null);
  (getWarehouse as any).mockResolvedValue({ state: 'RUNNING' });
  (executeStatement as any).mockResolvedValue({
    columns: ['c'], rows: [[1]], rowCount: 1, executionMs: 5, truncated: false,
  });
});

describe('LAYER 0 — authentication is FIRST, on every short-circuit', () => {
  it('401 with no session on a REAL id', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await queryPOST(req(), ctx('sw-1'));
    expect(res.status).toBe(401);
  });

  // The regression #3655 shipped and had to fix: the unsaved-item gate sitting
  // ABOVE the session read turns this into a 200.
  it("401 with no session at id === 'new'", async () => {
    (getSession as any).mockReturnValue(null);
    const res = await queryPOST(req(), ctx('new'));
    expect(res.status).toBe(401);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).not.toBe('unsaved_item');
  });

  it('an unauthenticated request reaches NO data-plane call and NO rate-limit read', async () => {
    (getSession as any).mockReturnValue(null);
    await queryPOST(req(), ctx('sw-1'));
    await queryPOST(req(), ctx('new'));
    expect(executeStatement).not.toHaveBeenCalled();
    expect(getWarehouse).not.toHaveBeenCalled();
    expect(enforceRateLimit).not.toHaveBeenCalled();
  });
});

describe('LAYER 1 — the route item must be owned', () => {
  beforeEach(() => { (getSession as any).mockReturnValue(SESSION); });

  it('404 when the workspace ladder DENIES', async () => {
    (authorizeItemWorkspace as any).mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'denied' }), { status: 404 }),
    );
    const res = await queryPOST(req(), ctx('sw-1'));
    expect(res.status).toBe(404);
    expect(executeStatement).not.toHaveBeenCalled();
  });

  // `authorizeItemWorkspace` returns null (= allow) for an id naming no item.
  // The guard closes that permissive case; without it the handler would run
  // UNBOUND against the caller-named warehouse.
  it('404 when the id names NO item (guard fails closed)', async () => {
    const res = await queryPOST(req(), ctx('does-not-exist'));
    expect(res.status).toBe(404);
    expect(executeStatement).not.toHaveBeenCalled();
  });

  /**
   * THE READ/WRITE SPLIT, ASSERTED — not inferred from the route's name.
   *
   * `query` sounds like a read and is scoped as a WRITE, because `sql` is
   * unrestricted: this handler carries no `^select` shape check (the sibling
   * `[id]/ctas` does), and `streaming-object-dialog.tsx:149` is a shipped
   * in-product caller that uses it to run CREATE DDL. Admitting a shared read
   * role would hand a Viewer arbitrary DDL on Unity Catalog.
   */
  it('is WRITE-scoped — it does NOT pass allowReadRoles', async () => {
    await queryPOST(req(), ctx('sw-1'));
    expect(authorizeItemWorkspace).toHaveBeenCalledTimes(1);
    const opts = (authorizeItemWorkspace as any).mock.calls[0][1];
    expect(opts.allowReadRoles).toBeFalsy();
  });

  it('a DENIED request writes NO FinOps attribution record', async () => {
    const res = await queryPOST(req(), ctx('does-not-exist'));
    expect(res.status).toBe(404);
    expect(recordQueryRun).not.toHaveBeenCalled();
  });
});

describe("the unsaved-item gate (id === 'new')", () => {
  beforeEach(() => { (getSession as any).mockReturnValue(SESSION); });

  it('returns the honest gate, NOT a 404 dead end', async () => {
    const res = await queryPOST(req(), ctx('new'));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('unsaved_item');
    expect(j.error).toMatch(/save this sql warehouse item first/i);
  });

  it('the gate reaches NO data-plane call', async () => {
    await queryPOST(req(), ctx('new'));
    expect(executeStatement).not.toHaveBeenCalled();
    expect(getWarehouse).not.toHaveBeenCalled();
  });

  // The gate matches the literal id EXACTLY. Real ids are crypto.randomUUID(),
  // so a substring/prefix test would let a real id skip the ownership check.
  it("an id merely CONTAINING 'new' is NOT gated — it is authorized", async () => {
    const res = await queryPOST(req(), ctx('new-warehouse-7'));
    expect(res.status).toBe(404);
    const j = await res.json();
    expect(j.code).not.toBe('unsaved_item');
  });
});

describe('the admitted path still works', () => {
  beforeEach(() => { (getSession as any).mockReturnValue(SESSION); });

  it('executes the statement on the caller-named warehouse and returns rows', async () => {
    const res = await queryPOST(req({ sql: 'SELECT 1', warehouseId: 'wh-1' }), ctx('sw-1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.rowCount).toBe(1);
    expect((executeStatement as any).mock.calls[0][0]).toBe('wh-1');
    expect((executeStatement as any).mock.calls[0][1]).toBe('SELECT 1');
  });

  it('still records the FinOps run against the AUTHORIZED item id', async () => {
    await queryPOST(req({ sql: 'SELECT 1', warehouseId: 'wh-1' }), ctx('sw-1'));
    expect(recordQueryRun).toHaveBeenCalledTimes(1);
    expect((recordQueryRun as any).mock.calls[0][0]).toMatchObject({
      itemId: 'sw-1', itemType: 'databricks-sql-warehouse', resourceId: 'wh-1',
    });
  });

  it('still 400s on a missing sql / warehouseId, AFTER authorization', async () => {
    const noSql = await queryPOST(req({ warehouseId: 'wh-1' }), ctx('sw-1'));
    expect(noSql.status).toBe(400);
    const noWh = await queryPOST(req({ sql: 'SELECT 1' }), ctx('sw-1'));
    expect(noWh.status).toBe(400);
    expect(executeStatement).not.toHaveBeenCalled();
  });

  it('still 409s when the warehouse is not RUNNING', async () => {
    (getWarehouse as any).mockResolvedValue({ state: 'STOPPED' });
    const res = await queryPOST(req({ sql: 'SELECT 1', warehouseId: 'wh-1' }), ctx('sw-1'));
    expect(res.status).toBe(409);
    expect(executeStatement).not.toHaveBeenCalled();
  });

  // The rate limiter sits ABOVE Layer 1 deliberately — it is keyed to the
  // caller's own session and bounds the cost of hammering the guard's Cosmos
  // read. Asserted so a later reorder is a visible decision, not a silent one.
  it('a rate-limited caller is refused BEFORE the ownership guard runs', async () => {
    (enforceRateLimit as any).mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'rate limited' }), { status: 429 }),
    );
    const res = await queryPOST(req(), ctx('sw-1'));
    expect(res.status).toBe(429);
    expect(authorizeItemWorkspace).not.toHaveBeenCalled();
  });
});
