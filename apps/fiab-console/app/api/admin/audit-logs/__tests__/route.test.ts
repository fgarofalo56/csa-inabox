/**
 * ROUND-3 — the Admin → Audit Logs *reader*, tested against the shape the
 * *writers* actually produce.
 *
 * The bug this file exists for: `lib/azure/uc-access-review-audit.ts` (LU-4) and
 * `lib/azure/object-security-audit.ts` both record `tenantId: claims.tid` — the
 * Entra TENANT id — while this route queried `WHERE c.tenantId = @tenant` with
 * `@tenant = claims.oid`, the viewer's OBJECT id. `tid` never equals `oid`, so
 * every row either writer produced was permanently unreachable: written, billed
 * for, and invisible. The LU-4 module doc-block and parity row E2c both claimed
 * those rows "surface in the existing Admin → Audit Logs reader", which was
 * false.
 *
 * These specs assert the READ predicate accepts a row written by the WRITER —
 * the join nobody was testing. The whole surface is tenant-admin gated (asserted
 * below), so scoping the read to the viewer's tenant grants nobody new
 * visibility.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn(() => null) }));
// The route is `withTenantAdmin(...)`. Exercise the REAL wrapper so the 401 and
// 403 paths under test are the ones that actually ship — it composes
// `withSession` (401) then `requireTenantAdmin` (403), both mocked above.
vi.mock('@/lib/api/route-toolkit', async () => {
  const { getSession } = await import('@/lib/auth/session');
  const { requireTenantAdmin } = await import('@/lib/auth/feature-gate');
  return {
    withTenantAdmin: (h: any) => async (req: any, ctx: any) => {
      const session = (getSession as any)();
      if (!session) return new Response(JSON.stringify({ ok: false, error: 'unauthenticated' }), { status: 401 });
      const gate = (requireTenantAdmin as any)(session);
      if (gate) return gate;
      return h(req, { ...ctx, session });
    },
  };
});
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: vi.fn(async () => ({ items: { query } })),
}));
vi.mock('@/lib/azure/purview-client', () => ({
  queryAuditLog: vi.fn(async () => { throw new Error('purview off in test'); }),
  PurviewNotConfiguredError: class extends Error {},
  PurviewError: class extends Error { status = 0; },
}));
vi.mock('@/lib/azure/monitor-client', () => ({
  queryLoomAppEvents: vi.fn(async () => { throw new Error('LA off in test'); }),
  MonitorNotConfiguredError: class extends Error {},
  MonitorError: class extends Error { status = 0; },
}));
vi.mock('@/lib/azure/query-result-cache', () => ({
  buildScopedCacheKey: (...a: unknown[]) => JSON.stringify(a),
  resolveBackendTtl: () => 0,
  getOrComputeCached: async (_k: string, _s: string, fn: () => Promise<unknown>) => ({ value: await fn(), meta: {} }),
}));

import { GET } from '../route';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';

const VIEWER = { claims: { oid: 'viewer-oid', upn: 'admin@contoso.com', tid: 'tenant-1' }, exp: 9_999_999_999 };
function req(qs = '') { return { nextUrl: new URL(`http://x/api/admin/audit-logs${qs}`) } as any; }

/** The row `recordUcAccessReview` writes — `tenantId` is the Entra TENANT id. */
const UC_ACCESS_REVIEW_ROW = {
  id: 'uc-access-review:2026-07-28T00:00:00Z:abc',
  itemId: 'unity-catalog:TABLE:main.sales.orders',
  kind: 'uc-access-review',
  category: 'access-review',
  decision: 'denied-principal-probe',
  who: 'attacker-oid',
  at: '2026-07-28T00:00:00Z',
  tenantId: 'tenant-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue(VIEWER);
  (requireTenantAdmin as any).mockReturnValue(null);
  query.mockReturnValue({ fetchAll: async () => ({ resources: [UC_ACCESS_REVIEW_ROW] }) });
});

/** Apply the route's own Cosmos predicate to a candidate row, the way the
 *  server would. Reads the `@tenants` parameter the route actually bound. */
function selectedByRoute(row: { tenantId: string }): boolean {
  const spec = query.mock.calls[0][0];
  const tenants = spec.parameters.find((p: any) => p.name === '@tenants')?.value as string[];
  expect(spec.query).toContain('ARRAY_CONTAINS(@tenants, c.tenantId)');
  return tenants.includes(row.tenantId);
}

describe('GET /api/admin/audit-logs — writer/reader join', () => {
  it('SELECTS a uc-access-review row, which is written with tenantId = the Entra tid', async () => {
    const res = await GET(req());
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(selectedByRoute(UC_ACCESS_REVIEW_ROW)).toBe(true);
    // …and it actually comes back to the client, tagged as a Cosmos row.
    expect(j.rows.map((r: any) => r.kind)).toContain('uc-access-review');
  });

  it('SELECTS an object-security row too — same writer shape, same class of bug', async () => {
    await GET(req());
    expect(selectedByRoute({ tenantId: 'tenant-1' })).toBe(true);
  });

  it('does NOT select a row from ANOTHER tenant (the widening is not a wildcard)', async () => {
    await GET(req());
    // A row written by an admin in a different Entra tenant must stay invisible.
    expect(selectedByRoute({ tenantId: 'tenant-2' })).toBe(false);
    expect(selectedByRoute({ tenantId: 'someone-elses-oid' })).toBe(false);
    expect(selectedByRoute({ tenantId: '' })).toBe(false);
  });

  it('still selects the oid-scoped rows the admin-plane stream writes (no regression)', async () => {
    // `emitAuditEvent` records `ev.tenantId || ev.actorOid`, and several Cosmos
    // writers partition on the caller's oid. Those must keep working.
    await GET(req());
    expect(selectedByRoute({ tenantId: 'viewer-oid' })).toBe(true);
  });

  it('is tenant-admin gated — the widened scope is never exposed to a plain session', async () => {
    (requireTenantAdmin as any).mockReturnValue(
      new Response(JSON.stringify({ ok: false, error: 'forbidden' }), { status: 403 }),
    );
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('401s an unauthenticated caller before touching Cosmos', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
});
