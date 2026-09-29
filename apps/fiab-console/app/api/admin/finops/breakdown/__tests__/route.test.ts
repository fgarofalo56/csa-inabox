/**
 * GET /api/admin/finops/breakdown — the route forwards the cost summary's
 * `tagQueryErrors` to the cockpit (PR #4771, review comment 5894822431
 * finding 7). The cockpit's `CostTagNotice` can only tell a throttled or
 * refused tag query apart from "no tags found" if this field reaches it.
 *
 * The tenant-admin gate is the REAL `withTenantAdmin`; admin is granted the way
 * production grants it (LOOM_TENANT_ADMIN_OID). Only the session and the cost
 * summary are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'ten-1', tid: 'ten-1', upn: 'a@t.com', name: 'A' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const TAG_ERRORS = [{ subscription: 'bbbbbbbb-0000-0000-0000-000000000002', error: 'Too many requests for test' }];
let summary: Record<string, unknown>;
vi.mock('@/lib/azure/cost-client', () => {
  class MonitorError extends Error { constructor(m: string, public status: number) { super(m); } }
  class MonitorNotConfiguredError extends Error { missing: string[] = []; }
  return {
    getLoomCostSummaryCached: async () => ({ value: summary }),
    MonitorError,
    MonitorNotConfiguredError,
  };
});

const req = (qs: string) => ({ nextUrl: new URL(`http://localhost/api/admin/finops/breakdown?${qs}`) }) as any;

const ORIG_ENV = { ...process.env };
beforeEach(() => {
  process.env.LOOM_TENANT_ADMIN_OID = 'ten-1';
  summary = {
    currency: 'USD', monthToDate: 5, tagKey: 'Environment', subscriptionNames: {},
    byTag: [{ key: 'commercial', cost: 5 }], byService: [], byResourceGroup: [], bySubscription: [], byResourceType: [],
    tagQueryErrors: TAG_ERRORS,
  };
});
afterEach(() => { vi.clearAllMocks(); process.env = { ...ORIG_ENV }; });

describe('GET /api/admin/finops/breakdown — tag query errors reach the client', () => {
  it('forwards tagQueryErrors alongside the tag rows', async () => {
    const { GET } = await import('../route');
    const r = await GET(req('dimension=tag'), undefined as any);
    expect(r.status).toBe(200);
    const j = await r.json();
    // Positive half: the rows are served, so the forwarding is not asserted on
    // an error response.
    expect(j.rows).toEqual([{ key: 'commercial', cost: 5 }]);
    // Breaks if the route stops forwarding the field (it would be absent), or
    // forwards a constant `[]`: the cockpit would then read a partial tag
    // breakdown as complete.
    expect(j.tagQueryErrors).toEqual(TAG_ERRORS);
  });

  it('defaults a summary with no tagQueryErrors to an empty list', async () => {
    delete summary.tagQueryErrors;
    const { GET } = await import('../route');
    const j = await (await GET(req('dimension=tag'), undefined as any)).json();
    // Breaks if the `?? []` default is dropped: the field would be missing and
    // the client contract would stop being a list.
    expect(j.tagQueryErrors).toEqual([]);
  });
});
