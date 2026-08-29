/**
 * #3750 READ SIDE — the reader repairs a Unity row that stored the same facts
 * under different names, and the `type` filter reaches those rows.
 *
 * `lib/azure/unity-audit.ts` recorded the verb as `operation` and the securable
 * as `securableFqn`; this route keys on `kind` and `key`. Live result: a column
 * of EMPTY outline pills and "—" keys for what was 100% of visible traffic, and
 * an Event-kind dropdown that could never list a Unity verb because `kinds` is
 * `.filter(Boolean)`.
 *
 * The writer now stamps both names (covered in
 * `lib/azure/__tests__/unity-audit-kind-key-3750.test.ts`). This file covers the
 * rows that are ALREADY stored and cannot be rewritten:
 *
 *   1. the row-level fallback, asserted on the route's OWN exported function;
 *   2. `kinds`, which the dropdown is built from, actually gaining the value;
 *   3. the SERVER-SIDE `type` predicate reaching a row with no `kind` property —
 *      without that arm, filtering by a Unity verb returns an empty grid.
 *
 * Each has a CONTROL. A normalizer that overwrote `kind` unconditionally would
 * satisfy (1) and corrupt every non-Unity row, and a predicate widened to
 * `c.operation = @kind` unconditionally would double-match rows carrying both.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const query = vi.fn();
const create = vi.fn(async (doc: unknown) => ({ resource: doc }));
const upsert = vi.fn(async (doc: unknown) => ({ resource: doc }));

vi.mock('@/lib/auth/session', async () => ({
  ...(await vi.importActual<typeof import('@/lib/auth/session')>('@/lib/auth/session')),
  getSession: vi.fn(),
}));
vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn(() => null) }));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: vi.fn() }));
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

import { GET, normalizeAuditRow } from '../route';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';

const VIEWER = { claims: { oid: 'viewer-oid', upn: 'admin@contoso.com', tid: 'tenant-1' }, exp: 9_999_999_999 };
function req(qs = '') { return { nextUrl: new URL(`http://x/api/admin/audit-logs${qs}`) } as any; }

/** A Unity row EXACTLY as it sits in Cosmos today — no `kind`, no `key`. */
const LEGACY_UNITY_ROW = {
  id: 'u1',
  itemId: 'unity:schema.list:2026-08-18',
  itemType: 'loom-unity',
  tenantId: 'tenant-1',
  who: 'alice@contoso.com',
  at: '2026-08-18T10:00:00.000Z',
  operation: 'schema.list',
  securableType: 'schema',
  securableFqn: 'sales.bronze',
};

/** A generic row, which has always carried the two fields. */
const GENERIC_ROW = {
  id: 'g1',
  itemId: 'item-1',
  tenantId: 'tenant-1',
  who: 'admin@contoso.com',
  at: '2026-08-18T09:00:00.000Z',
  kind: 'uc-access-review',
  key: 'main.sales.orders',
};

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue(VIEWER);
  (requireTenantAdmin as any).mockReturnValue(null);
  query.mockReturnValue({ fetchAll: async () => ({ resources: [LEGACY_UNITY_ROW, GENERIC_ROW] }) });
});

describe('#3750 — normalizeAuditRow', () => {
  it('fills kind from operation and key from securableFqn', () => {
    const r = normalizeAuditRow({ ...LEGACY_UNITY_ROW });
    expect(r.kind).toBe('schema.list');
    expect(r.key).toBe('sales.bronze');
  });

  it('CONTROL: never overwrites a kind/key the row already carries', () => {
    const r = normalizeAuditRow({ ...GENERIC_ROW, operation: 'catalog.list', securableFqn: 'sales' });
    expect(r.kind).toBe('uc-access-review');
    expect(r.key).toBe('main.sales.orders');
  });

  it('CONTROL: invents nothing when there is nothing to fall back to', () => {
    const r = normalizeAuditRow({ id: 'x', at: '2026-08-18T00:00:00.000Z' });
    expect(r.kind).toBeUndefined();
    expect(r.key).toBeUndefined();
  });
});

describe('#3750 — the surface the operator actually reads', () => {
  it('the Kind badge has a value and the Event-kind dropdown can offer it', async () => {
    const res = await GET(req());
    const j = await res.json();
    expect(j.ok).toBe(true);

    const unity = j.rows.find((r: any) => r.id === 'u1');
    expect(unity.kind).toBe('schema.list');
    expect(unity.key).toBe('sales.bronze');

    // `kinds` is `.filter(Boolean)`, so before the repair this list could not
    // contain a single Unity verb no matter how much Unity traffic there was.
    expect(j.kinds).toContain('schema.list');
    // CONTROL: the generic row's kind is still there and is not duplicated away.
    expect(j.kinds).toContain('uc-access-review');
  });

  it('free-text search matches the DERIVED key', async () => {
    // Searched on `sales.bronze` DELIBERATELY. The obvious query — the verb —
    // is also a substring of this row's `itemId`
    // (`unity:schema.list:2026-08-18`), so `?q=schema.list` matches with or
    // without the repair and proves nothing. `sales.bronze` appears ONLY in
    // `securableFqn`, so a hit here means the `key` fallback reached the filter.
    const res = await GET(req('?q=sales.bronze'));
    const j = await res.json();
    expect(j.rows.map((r: any) => r.id)).toEqual(['u1']);
  });

  it('the SERVER-SIDE type predicate reaches a row with no kind property', async () => {
    await GET(req('?type=schema.list'));
    const spec = query.mock.calls[0][0];
    // Both arms present, and the fallback arm is guarded on ABSENCE so a row
    // carrying both fields is matched exactly once.
    expect(spec.query).toContain('c.kind = @kind');
    expect(spec.query).toContain('NOT IS_DEFINED(c.kind)');
    expect(spec.query).toContain('c.operation = @kind');
    expect(spec.parameters.find((p: any) => p.name === '@kind')?.value).toBe('schema.list');
  });

  it('CONTROL: with no type filter the predicate carries no kind arm at all', async () => {
    await GET(req());
    const spec = query.mock.calls[0][0];
    expect(spec.query).not.toContain('@kind');
  });
});
