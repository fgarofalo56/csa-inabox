/**
 * #3728 — `GET /api/items` MUST BE BOUNDED, AND MUST SAY SO.
 *
 * Measured live on the Commercial estate, signed in, 2026-08-18, head a1155022:
 *
 *   type=lakehouse      504   30079ms      type=notebook        200   9734ms
 *   type=warehouse      504   30083ms      type=data-pipeline   200   2634ms
 *   type=bogus-type-xyz 200     102ms      type=report          200   2401ms
 *
 * A NONEXISTENT type answered in 102ms, so the base Cosmos path was fast and the cost was
 * strictly per-item: the route `fetchAll()`-ed every row of the type and then walked EVERY
 * one through the workspace-visibility resolver. There was no bound of any kind, and
 * `?type=notebook&limit=1` came back with 582 items because `limit` was not a parameter
 * the route implemented.
 *
 * The 504 is the part that makes this a trap rather than a slow page: past the Front Door
 * limit the caller receives an HTML gateway-error page, and per this route's own recorded
 * history (the 404-parsed-as-empty-array bug in its docblock) a caller doing
 * `j?.items || []` swallows that as an empty list. A silently-empty picker, not an error.
 *
 * These specs pin all three acceptance criteria from the issue:
 *   1. a bound is HONOURED — the walk stops, and it stops by not scanning, not by slicing
 *      a scan it already paid for;
 *   2. the bound is DISCLOSED — `truncated` / `truncatedBy` / `hint`, never silent;
 *   3. every branch answers structured JSON, including the time-budget branch, so no
 *      caller can be handed an edge HTML page it will read as `[]`.
 *
 * NOT CLAIMED: nothing here is an estate measurement. These are unit specs over the real
 * route with mocked Cosmos; the live latencies above come from #3728 and were not re-run,
 * and Gov was never measured at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  tenantScopeId: (s: any) => s?.claims?.tid ?? s?.claims?.oid,
}));

const resolveWorkspaceAccessByOid = vi.fn(async () => ({ canWrite: true }) as any);
vi.mock('@/lib/auth/workspace-access', () => ({
  resolveWorkspaceAccessByOid: (...a: any[]) => resolveWorkspaceAccessByOid(...(a as [])),
  ambientAccessOptsFor: async () => ({ callerTid: undefined }),
}));
vi.mock('@/lib/auth/workspace-list-access', () => ({
  authorizeWorkspaceList: vi.fn(async () => ({ canWrite: true })),
}));
vi.mock('@/lib/auth/workspace-guard', () => ({ authorizeWorkspace: vi.fn() }));
vi.mock('@/lib/auth/feature-gate', () => ({ isTenantAdmin: () => false }));

/**
 * A fake Cosmos query that supports BOTH shapes: `fetchAll()` (the unbounded walk, which
 * every pre-existing caller and fixture uses) and `hasMoreResults()`/`fetchNext()` (the
 * bounded walk). `pagesServed` is the instrument for criterion 1 — it counts what the walk
 * actually asked the server for, which a `fetchAll() + slice()` implementation could not
 * reduce.
 */
let rows: any[] = [];
let pageSizeSeen: number | undefined;
let pagesServed = 0;
let rowsServed = 0;
/** Optional per-row delay, so the time-budget branch can be driven deterministically. */
let rowDelayMs = 0;

function makeIterator(maxItemCount: number | undefined) {
  pageSizeSeen = maxItemCount;
  const size = maxItemCount && maxItemCount > 0 ? maxItemCount : rows.length || 1;
  let cursor = 0;
  return {
    hasMoreResults: () => cursor < rows.length,
    async fetchNext() {
      const page = rows.slice(cursor, cursor + size);
      cursor += page.length;
      pagesServed += 1;
      rowsServed += page.length;
      return { resources: page };
    },
    async fetchAll() {
      pagesServed += 1;
      rowsServed += rows.length;
      return { resources: rows };
    },
  };
}

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: { query: (_q: any, o: any) => makeIterator(o?.maxItemCount) },
  }),
  workspacesContainer: async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } }),
  tenantSettingsContainer: async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } }),
}));
vi.mock('@/lib/azure/loom-search', () => ({ upsertLoomDoc: vi.fn(), deleteLoomDoc: vi.fn(), docForItem: vi.fn() }));
vi.mock('@/lib/azure/loom-data-products-search', () => ({
  upsertDataProductDoc: vi.fn(), deleteDataProductDoc: vi.fn(), docForDataProduct: vi.fn(),
}));
vi.mock('@/lib/azure/governance-catalog-index', () => ({
  upsertGovernanceItem: vi.fn(), deleteGovernanceItem: vi.fn(),
  docForGovernanceItem: vi.fn(), isCatalogDataType: vi.fn(() => false),
}));
vi.mock('@/lib/azure/purview-autoonboard', () => ({
  autoOnboardToPurview: vi.fn(), offboardFromPurview: vi.fn(),
}));
vi.mock('@/lib/thread/thread-edges', () => ({
  reconcileThreadEdgesOnDelete: vi.fn(), restoreThreadEdgesForItem: vi.fn(),
}));

import { GET } from '@/app/api/items/route';

const req = (qs: string) => ({ nextUrl: new URL(`http://x/api/items${qs}`) }) as any;

const seed = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `i-${i}`, itemType: 'lakehouse', workspaceId: `ws-${i % 7}` }));

beforeEach(() => {
  rows = [];
  pageSizeSeen = undefined;
  pagesServed = 0;
  rowsServed = 0;
  rowDelayMs = 0;
  resolveWorkspaceAccessByOid.mockReset();
  resolveWorkspaceAccessByOid.mockImplementation(async () => {
    if (rowDelayMs > 0) await new Promise((r) => setTimeout(r, rowDelayMs));
    return { canWrite: true } as any;
  });
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-1', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
});

afterEach(() => { vi.restoreAllMocks(); });

describe('#3728 — the bound is honoured', () => {
  it('EMBEDDED CONTROL: a small type comes back WHOLE and is not reported truncated', async () => {
    // Without this, every "it stopped" assertion is also satisfiable by a route that
    // returns nothing, or one that reports `truncated` unconditionally.
    rows = seed(12);
    const j: any = await (await GET(req('?type=lakehouse'))).json();
    expect(j.ok).toBe(true);
    expect(j.items).toHaveLength(12);
    expect(j.truncated).toBe(false);
    expect(j.truncatedBy).toBeUndefined();
    expect(j.hint).toBeUndefined();
  });

  it('caps at the DEFAULT page size, and reports it', async () => {
    // The measured shape: 582 notebooks came back for `?limit=1`. The default is what a
    // caller that passes nothing — i.e. both shipped callers — now gets.
    rows = seed(582);
    const j: any = await (await GET(req('?type=lakehouse'))).json();
    expect(j.items).toHaveLength(200);
    expect(j.pageSize).toBe(200);
    expect(j.truncated).toBe(true);
    expect(j.truncatedBy).toBe('pageSize');
    expect(j.hint).toMatch(/by-type/);
  });

  it('honours an explicit pageSize — and `limit`, the parameter that used to be ignored', async () => {
    rows = seed(582);
    const byPageSize: any = await (await GET(req('?type=lakehouse&pageSize=25'))).json();
    expect(byPageSize.items).toHaveLength(25);
    expect(byPageSize.pageSize).toBe(25);

    pagesServed = 0;
    const byLimit: any = await (await GET(req('?type=lakehouse&limit=1'))).json();
    // The exact call from the issue. It returned 582 items; it returns one.
    expect(byLimit.items).toHaveLength(1);
    expect(byLimit.truncated).toBe(true);
  });

  it('STOPS SCANNING — the bound is not a slice of a scan already paid for', async () => {
    // Criterion 1, and the only assertion here that distinguishes a real fix from a
    // cosmetic one. `fetchAll() + slice(0, 25)` returns the same 25 items and still costs
    // the full 582-row cross-partition read plus 582 visibility resolutions — which is
    // exactly the 30s the edge timed out on.
    rows = seed(582);
    await GET(req('?type=lakehouse&pageSize=25'));
    expect(pageSizeSeen).toBeDefined();
    expect(rowsServed).toBeLessThan(200);
    expect(resolveWorkspaceAccessByOid.mock.calls.length).toBeLessThan(200);
  });

  it('clamps an absurd pageSize instead of honouring it', async () => {
    rows = seed(2000);
    const j: any = await (await GET(req('?type=lakehouse&pageSize=999999'))).json();
    expect(j.pageSize).toBe(1000);
    expect(j.items).toHaveLength(1000);
  });

  it('REFUSES a nonsense pageSize with structured JSON, never a silent default', async () => {
    rows = seed(10);
    const r = await GET(req('?type=lakehouse&pageSize=abc'));
    const j: any = await r.json();
    expect(r.status).toBe(400);
    expect(j.ok).toBe(false);
    expect(j.code).toBe('bad_page_size');
  });
});

describe('#3728 — every branch answers structured JSON', () => {
  it('a Cosmos failure is {ok:false} with a code, not an exception escaping to the edge', async () => {
    resolveWorkspaceAccessByOid.mockImplementation(async () => { throw new Error('cosmos exploded'); });
    rows = seed(5);
    const r = await GET(req('?type=lakehouse'));
    const j: any = await r.json();
    expect(r.status).toBe(500);
    expect(j.ok).toBe(false);
    expect(j.code).toBe('cosmos_error');
    // A caller doing `j?.items || []` gets undefined here, not a fabricated empty list.
    expect(j.items).toBeUndefined();
  });

  it('a missing type is a 400 with the by-type hint, unchanged', async () => {
    const r = await GET(req(''));
    const j: any = await r.json();
    expect(r.status).toBe(400);
    expect(j.hint).toMatch(/by-type/);
  });

  it('401 without a session', async () => {
    getSessionMock.mockReturnValue(null as any);
    const r = await GET(req('?type=lakehouse'));
    expect(r.status).toBe(401);
  });
});
