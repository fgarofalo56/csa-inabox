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
 *
 * #2650 is the SAME join, one step further out: the writers recorded
 * `...(claims.tid ? { tenantId: claims.tid } : {})`, so a session with no `tid`
 * claim (minted / automation / PAT) produced a document with NO `tenantId`
 * property at all — and `ARRAY_CONTAINS(@tenants, c.tenantId)` can never match
 * an absent property. The `#2650` block at the bottom drives the REAL writers
 * with a `tid`-less session and feeds what they actually wrote to the route's
 * own predicate.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const query = vi.fn();
/** Cosmos write sinks — the real writers are exercised against these below. */
const create = vi.fn(async (doc: unknown) => ({ resource: doc }));
const upsert = vi.fn(async (doc: unknown) => ({ resource: doc }));
// `getSession` is stubbed; `tenantScopeId` is NOT — the #2650 specs must run the
// real `tid ?? oid` helper, not a restatement of it.
vi.mock('@/lib/auth/session', async () => ({
  ...(await vi.importActual<typeof import('@/lib/auth/session')>('@/lib/auth/session')),
  getSession: vi.fn(),
}));
vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn(() => null) }));
// The uc-access-review writer also fans out to the SIEM stream; keep that inert.
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: vi.fn() }));
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
  auditLogContainer: vi.fn(async () => ({ items: { query, create, upsert } })),
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
import { recordUcAccessReview } from '@/lib/azure/uc-access-review-audit';
import { recordObjectSecurityEvent } from '@/lib/azure/object-security-audit';
import { recordActionJustification } from '@/lib/azure/action-justification-store';

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
 *  server would. Reads the `@tenants` parameter the route actually bound.
 *  `tenantId` is optional here on purpose: a document that never carried the
 *  property is exactly the #2650 failure, and `ARRAY_CONTAINS` cannot match it. */
function selectedByRoute(row: { tenantId?: string }): boolean {
  const spec = query.mock.calls[0][0];
  const tenants = spec.parameters.find((p: any) => p.name === '@tenants')?.value as string[];
  expect(spec.query).toContain('ARRAY_CONTAINS(@tenants, c.tenantId)');
  return tenants.includes(row.tenantId as string);
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

/**
 * #2650 — the same join for a session with NO `tid` claim.
 *
 * These specs drive the REAL writers (not a hand-copied row shape) and feed the
 * document they actually produced to the route's REAL predicate. Before the fix
 * every one of them wrote `tenantId: undefined` — the property was absent from
 * the document — so `ARRAY_CONTAINS(@tenants, c.tenantId)` could never select
 * it and the row was unreachable through the product forever.
 */
describe('GET /api/admin/audit-logs — rows written WITHOUT a tid claim (#2650)', () => {
  /** Minted / automation / PAT session: same operator `oid`, no `tid`. This is
   *  precisely the A/B in the issue — run 1 returned total=0, run 2 total=1. */
  const TIDLESS = {
    claims: { oid: 'viewer-oid', upn: 'automation@contoso.com', name: 'Automation' },
    exp: 9_999_999_999,
  } as any;

  /** What the writer handed to Cosmos, as Cosmos would have stored it. */
  function written(sink: typeof create | typeof upsert): { tenantId?: string } {
    expect(sink).toHaveBeenCalledTimes(1);
    return JSON.parse(JSON.stringify(sink.mock.calls[0][0])) as { tenantId?: string };
  }

  it('uc-access-review: the row the writer produced IS selected by the reader', async () => {
    await recordUcAccessReview(TIDLESS, {
      securableType: 'TABLE', securableName: 'main.sales.orders', effective: true,
      decision: 'allowed', nowIso: '2026-07-29T16:58:21.844Z',
    });
    const row = written(create);
    await GET(req());
    // The property must EXIST — `ARRAY_CONTAINS` on an absent field is false.
    expect(Object.prototype.hasOwnProperty.call(row, 'tenantId')).toBe(true);
    expect(row.tenantId).toBe('viewer-oid'); // tenantScopeId → tid ?? oid
    expect(selectedByRoute(row)).toBe(true);
  });

  it('object-security: same writer shape, same class — also selected', async () => {
    await recordObjectSecurityEvent(TIDLESS, {
      ontologyId: 'ont-1', decision: 'read-masked', maskedProperties: ['ssn'],
      nowIso: '2026-07-29T16:58:21.844Z',
    });
    const row = written(create);
    await GET(req());
    expect(Object.prototype.hasOwnProperty.call(row, 'tenantId')).toBe(true);
    expect(selectedByRoute(row)).toBe(true);
  });

  it('action-justification: the written REASON is retrievable too', async () => {
    await recordActionJustification(TIDLESS, {
      ontologyId: 'ont-1', action: 'closeCase', objectType: 'Case', actionKind: 'update',
      reason: 'incident 42', outcome: 'succeeded', nowIso: '2026-07-29T16:58:21.844Z',
    });
    const row = written(upsert);
    await GET(req());
    expect(Object.prototype.hasOwnProperty.call(row, 'tenantId')).toBe(true);
    expect(selectedByRoute(row)).toBe(true);
  });

  it('still scopes on the Entra tid when the session HAS one (no widening)', async () => {
    const withTid = { claims: { oid: 'other-oid', upn: 'ada@contoso.com', name: 'Ada', tid: 'tenant-1' }, exp: 9_999_999_999 } as any;
    await recordUcAccessReview(withTid, {
      securableType: 'CATALOG', securableName: 'main', effective: true,
      decision: 'allowed', nowIso: '2026-07-29T16:58:21.844Z',
    });
    const row = written(create);
    await GET(req());
    expect(row.tenantId).toBe('tenant-1');
    expect(selectedByRoute(row)).toBe(true);
    // …and a tid-less row from a DIFFERENT operator stays invisible to this
    // viewer. The fallback scopes to the actor, it is not a wildcard.
    expect(selectedByRoute({ tenantId: 'other-oid' })).toBe(false);
  });
});
