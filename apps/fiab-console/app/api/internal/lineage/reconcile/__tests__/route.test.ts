/**
 * BFF route tests for /api/internal/lineage/reconcile (LIN-GC-2).
 *
 * Verifies the machine-to-machine contract the scheduled `loom-lineage-gc` ACA
 * Job depends on, and one property that matters more than the rest:
 *
 *   - fail-closed internal-token auth (401 without / with a wrong token);
 *   - SCAN-ONLY BY DEFAULT — with LOOM_LINEAGE_GC_PURGE unset, no purge function
 *     is called AT ALL. This is the assertion of record for that guarantee. The
 *     scheduled path deletes metadata for items whose absence might be a READ
 *     failure rather than a real deletion, and that is not recoverable, so
 *     "purge was not called" is asserted on the mocks rather than inferred from
 *     the response body;
 *   - the affirmative opt-in actually arms it (`true` purges) and near-misses do
 *     NOT (`'false'`, `''`, `'maybe'` stay scan-only) — a typo must not arm an
 *     unattended delete;
 *   - `found` counts all three orphan planes, so a caller cannot read "0" from a
 *     scan that only looked at one.
 *
 * The lineage-gc seams are mocked; the REAL scan is the LIN-GC-2 live receipt on
 * the deployment, per G1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  findLineageOrphansMock,
  findThreadEdgeOrphansMock,
  findAccessArtifactOrphansMock,
  purgeLineageOrphansMock,
  purgeThreadEdgeOrphansMock,
  purgeAccessArtifactOrphansMock,
} = vi.hoisted(() => ({
  findLineageOrphansMock: vi.fn(),
  findThreadEdgeOrphansMock: vi.fn(),
  findAccessArtifactOrphansMock: vi.fn(),
  purgeLineageOrphansMock: vi.fn(),
  purgeThreadEdgeOrphansMock: vi.fn(),
  purgeAccessArtifactOrphansMock: vi.fn(),
}));

vi.mock('@/lib/azure/lineage-gc', () => ({
  findLineageOrphans: findLineageOrphansMock,
  findThreadEdgeOrphans: findThreadEdgeOrphansMock,
  findAccessArtifactOrphans: findAccessArtifactOrphansMock,
  purgeLineageOrphans: purgeLineageOrphansMock,
  purgeThreadEdgeOrphans: purgeThreadEdgeOrphansMock,
  purgeAccessArtifactOrphans: purgeAccessArtifactOrphansMock,
}));

const TOKEN = 'lin-gc-test-token';

function post(token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new NextRequest('http://x/api/internal/lineage/reconcile', {
    method: 'POST',
    headers,
    body: JSON.stringify({ trigger: 'test' }),
  });
}

async function callRoute(req: NextRequest) {
  const mod = await import('../route');
  return mod.POST(req);
}

describe('/api/internal/lineage/reconcile', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.LOOM_INTERNAL_TOKEN = TOKEN;
    delete process.env.LOOM_LINEAGE_GC_PURGE;

    // Two orphans on the lineage plane, one thread edge, one notification and
    // one access request — 5 total across three planes, so a `found` that only
    // counts one plane is visibly wrong rather than plausibly small.
    findLineageOrphansMock.mockResolvedValue({
      purviewConfigured: true,
      scanned: 10,
      orphans: [{ guid: 'a' }, { guid: 'b' }],
    });
    findThreadEdgeOrphansMock.mockResolvedValue({ scanned: 4, orphans: [{ id: 'e1' }] });
    findAccessArtifactOrphansMock.mockResolvedValue({
      notifications: { scanned: 3, orphans: [{ id: 'n1', userId: 'u', link: '/items/x' }] },
      requests: { scanned: 2, orphans: [{ id: 'r1', tenantId: 't', assetId: 'x' }] },
    });
    purgeLineageOrphansMock.mockResolvedValue([]);
    purgeThreadEdgeOrphansMock.mockResolvedValue(0);
    purgeAccessArtifactOrphansMock.mockResolvedValue({ notificationsTombstoned: 0, requestsClosed: 0 });
  });

  afterEach(() => {
    delete process.env.LOOM_INTERNAL_TOKEN;
    delete process.env.LOOM_LINEAGE_GC_PURGE;
  });

  it('401s with no token — a timer that cannot authenticate must not sweep', async () => {
    const res = await callRoute(post());
    expect(res.status).toBe(401);
    expect(findLineageOrphansMock).not.toHaveBeenCalled();
  });

  it('401s with the WRONG token', async () => {
    const res = await callRoute(post('not-the-token'));
    expect(res.status).toBe(401);
    expect(findLineageOrphansMock).not.toHaveBeenCalled();
  });

  it('SCAN-ONLY by default: reports orphans and calls NO purge function', async () => {
    const res = await callRoute(post(TOKEN));
    expect(res.status).toBe(200);
    const body = await res.json();
    const d = body;

    expect(d.purged).toBe(false);
    expect(d.found).toBe(5);
    // The assertion that matters. A response saying `purged:false` while a purge
    // ran would be the exact lie this route exists to make impossible.
    expect(purgeLineageOrphansMock).not.toHaveBeenCalled();
    expect(purgeThreadEdgeOrphansMock).not.toHaveBeenCalled();
    expect(purgeAccessArtifactOrphansMock).not.toHaveBeenCalled();
  });

  it('counts all THREE orphan planes in `found`', async () => {
    const res = await callRoute(post(TOKEN));
    const d = await res.json();
    // 2 lineage + 1 thread edge + 1 notification + 1 request.
    expect(d.found).toBe(5);
  });

  it('purges ONLY when LOOM_LINEAGE_GC_PURGE is affirmatively set', async () => {
    process.env.LOOM_LINEAGE_GC_PURGE = 'true';
    const res = await callRoute(post(TOKEN));
    const d = await res.json();
    expect(d.purged).toBe(true);
    expect(purgeLineageOrphansMock).toHaveBeenCalledTimes(1);
    expect(purgeThreadEdgeOrphansMock).toHaveBeenCalledTimes(1);
    expect(purgeAccessArtifactOrphansMock).toHaveBeenCalledTimes(1);
  });

  // BREADTH control, not a presence control. Widening `purgeArmed` to anything
  // truthy — `Boolean(env)`, `!== 'false'`, a bare `!!` — turns these red. Without
  // them the opt-in pins only that `'true'` works, and the next person can make
  // an empty string arm an unattended delete with the suite still green.
  it.each(['false', '', 'maybe', '0', 'no'])(
    'stays SCAN-ONLY when LOOM_LINEAGE_GC_PURGE=%j',
    async (v) => {
      process.env.LOOM_LINEAGE_GC_PURGE = v;
      const res = await callRoute(post(TOKEN));
      const d = await res.json();
      expect(d.purged).toBe(false);
      expect(purgeLineageOrphansMock).not.toHaveBeenCalled();
    },
  );

  it('fails CLOSED when LOOM_INTERNAL_TOKEN is unset — inert until a deploy opts in', async () => {
    delete process.env.LOOM_INTERNAL_TOKEN;
    const res = await callRoute(post(TOKEN));
    expect(res.status).toBe(401);
    expect(findLineageOrphansMock).not.toHaveBeenCalled();
  });
});
