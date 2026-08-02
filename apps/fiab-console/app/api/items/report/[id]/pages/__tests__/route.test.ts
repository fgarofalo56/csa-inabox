/**
 * BFF route test for /api/items/report/[id]/pages — #2830.
 *
 * THE BUG, observed live in run 30757747218 (`publish-version`, on a report the
 * spec had just CREATED):
 *
 *   404 GET /api/items/report/loom%3A8872fd18-…/pages?workspaceId=loom-native
 *
 * Read the handler, not the URL. Unlike #2649/#2822 this route ALREADY resolved
 * the `loom:` prefix — the 404 came from one step later. `state.content` is
 * written by the report designer's `…/definition` PUT (or stamped by an
 * app-bundle install), so a report that exists but has never been saved has
 * none, `reportPagesFromContent` returns null for it, and the route mapped that
 * null to the SAME 404 as "no such report". A present, owned, freshly created
 * report therefore 404'd — and put an error banner on a first open, which
 * `ux-baseline.md`'s clean-first-open rule forbids.
 *
 * An owned report with nothing saved has ZERO pages. That is a 200 with an empty
 * list. 404 now means only what it says: absent, or not yours.
 *
 * SECOND SMELL IN THE SAME URL — `workspaceId=loom-native`, a backend NAME in a
 * parameter that everywhere else carries a workspace GUID. The `loom:` branch
 * never reads it (it serves from Cosmos), but the route demanded one anyway, so
 * the caller invented a sentinel to get past the check. The requirement now
 * applies only to the opt-in Power BI branch that genuinely needs a groupId.
 *
 * HOW THE MOCKS DISCRIMINATE. `loadContentBackedItem` is a real keyed lookup over
 * an in-memory map — the same `WHERE c.id = @id` predicate — so an unresolved
 * prefix misses on its own.
 *
 * CONTROLS (green with AND without the fix): a live Power BI report id still
 * reaches `getReportPages(workspaceId, id)` verbatim with Cosmos never touched;
 * the Power BI branch still rejects a missing workspaceId; a `loom:` id with no
 * backing item still 404s; unauthenticated is still 401.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { WorkspaceItem } from '@/lib/types/workspace';

const h = vi.hoisted(() => {
  class FakePowerBiError extends Error {
    status: number;
    constructor(message: string, status: number) { super(message); this.status = status; }
  }
  return {
    store: new Map<string, any>(),
    getReportPages: vi.fn(async (_ws: string, _id: string) => [] as any[]),
    session: vi.fn(() => ({ claims: { oid: 'oid-1' } }) as any),
    FakePowerBiError,
  };
});
const { FakePowerBiError } = h;

vi.mock('@/lib/auth/session', () => ({ getSession: () => h.session() }));

vi.mock('@/lib/azure/powerbi-client', () => ({
  getReportPages: (...a: any[]) => h.getReportPages(...(a as [string, string])),
  PowerBiError: h.FakePowerBiError,
}));

// Real keyed lookup — mirrors Cosmos `WHERE c.id = @id AND c.itemType = @t`.
const loadContentBackedItem = vi.fn(async (id: string, type: string) =>
  (type === 'report' ? (h.store.get(id) ?? null) : null));
vi.mock('../../../../_lib/pbi-content-fallback', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  loadContentBackedItem: (...a: any[]) => loadContentBackedItem(...(a as [string, string, string])),
}));

import { GET } from '../route';

const COSMOS_ID = '8872fd18-f6a8-4a08-aade-7ee7dc3960d3';
const LOOM_ID = `loom:${COSMOS_ID}`;
const PBI_REPORT_ID = 'c0ffee11-2233-4455-6677-889900aabbcc';
const PBI_GROUP_ID = 'a3f1be79-855a-41b6-a719-d9d51e72d473';

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (id: string, qs = '') =>
  new NextRequest(`http://localhost/api/items/report/${encodeURIComponent(id)}/pages${qs}`);

/** Seed a report item. `content` omitted = created-but-never-saved. */
function seedReport(content?: Record<string, unknown>) {
  h.store.set(COSMOS_ID, {
    id: COSMOS_ID,
    workspaceId: 'ws-2b289a0b',
    itemType: 'report',
    displayName: 'uat-pubver-report',
    state: content ? { content } : {},
    createdBy: 'u', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  } as unknown as WorkspaceItem);
}

beforeEach(() => {
  h.store.clear();
  vi.clearAllMocks();
  h.session.mockReturnValue({ claims: { oid: 'oid-1' } } as any);
  h.getReportPages.mockResolvedValue([]);
});

describe('#2830 — a freshly created report serves an empty page list, it does not 404', () => {
  it('GET on a created-but-unsaved report returns 200 with zero pages (the live failure)', async () => {
    seedReport(); // no state.content — exactly what createItem() leaves behind
    const res = await GET(req(LOOM_ID), params(LOOM_ID));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.native).toBe(true);
    expect(j.pages).toEqual([]);
    // The `loom:` prefix was resolved before the Cosmos lookup.
    expect(loadContentBackedItem).toHaveBeenCalledWith(COSMOS_ID, 'report', 'oid-1');
    // Zero Power BI calls on the Azure-native default path (no-fabric-dependency).
    expect(h.getReportPages).not.toHaveBeenCalled();
  });

  it('GET on a SAVED report still serves its persisted pages', async () => {
    seedReport({
      kind: 'report',
      pages: [{ name: 'Overview', visuals: [{ type: 'table', title: 'Sales' }] }],
    });
    const res = await GET(req(LOOM_ID), params(LOOM_ID));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.pages).toHaveLength(1);
    expect(j.pages[0].displayName).toBe('Overview');
  });

  it('no `workspaceId` is required on the Loom-native branch (the `loom-native` sentinel is gone)', async () => {
    seedReport();
    const res = await GET(req(LOOM_ID), params(LOOM_ID));
    expect(res.status).toBe(200);
  });

  it('a sentinel workspaceId is still tolerated — it is simply never read', async () => {
    seedReport();
    const res = await GET(req(LOOM_ID, '?workspaceId=loom-native'), params(LOOM_ID));
    expect(res.status).toBe(200);
    expect(h.getReportPages).not.toHaveBeenCalled();
  });
});

describe('#2830 controls — the fix must not soften the Power BI path or invent items', () => {
  it('CONTROL: a live Power BI report id still reaches getReportPages verbatim', async () => {
    // Power BI is OPT-IN and off by default (no-fabric-dependency.md); when a
    // real report IS bound the group + report ids must arrive unrewritten.
    h.getReportPages.mockResolvedValueOnce([{ name: 'ReportSection1', displayName: 'Page 1' }]);
    const res = await GET(
      req(PBI_REPORT_ID, `?workspaceId=${PBI_GROUP_ID}`),
      params(PBI_REPORT_ID),
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.pages[0].displayName).toBe('Page 1');
    expect(h.getReportPages).toHaveBeenCalledWith(PBI_GROUP_ID, PBI_REPORT_ID);
    expect(loadContentBackedItem).not.toHaveBeenCalled();
  });

  it('CONTROL: the Power BI branch still 400s without a workspaceId', async () => {
    const res = await GET(req(PBI_REPORT_ID), params(PBI_REPORT_ID));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/workspaceId required/);
  });

  it('CONTROL: a `loom:` id with no backing Cosmos item still 404s', async () => {
    // store empty — the fix serves an item that EXISTS, it does not invent one.
    const res = await GET(req(LOOM_ID), params(LOOM_ID));
    expect(res.status).toBe(404);
    expect((await res.json()).ok).toBe(false);
  });

  it('CONTROL: a Power BI 404 still falls back to the Cosmos item when there is one', async () => {
    seedReport({ kind: 'report', pages: [{ name: 'Fallback', visuals: [] }] });
    h.getReportPages.mockRejectedValueOnce(new FakePowerBiError('PowerBIEntityNotFound', 404));
    const res = await GET(req(COSMOS_ID, `?workspaceId=${PBI_GROUP_ID}`), params(COSMOS_ID));
    expect(res.status).toBe(200);
    expect((await res.json()).pages[0].displayName).toBe('Fallback');
  });

  it('CONTROL: a non-404 Power BI error still surfaces verbatim', async () => {
    h.getReportPages.mockRejectedValueOnce(new FakePowerBiError('forbidden', 403));
    const res = await GET(req(PBI_REPORT_ID, `?workspaceId=${PBI_GROUP_ID}`), params(PBI_REPORT_ID));
    expect(res.status).toBe(403);
  });

  it('CONTROL: unauthenticated is still 401', async () => {
    h.session.mockReturnValueOnce(null as any);
    const res = await GET(req(LOOM_ID), params(LOOM_ID));
    expect(res.status).toBe(401);
  });
});
