/**
 * BFF contract tests for the readiness routes (WS-H).
 *
 * Per no-vaporware.md these exercise the REAL route handlers with the self-audit
 * probe run mocked (so no live Azure calls), pinning the capability-gate, the
 * report shape (H1 + H2), and the tenant-profile export in both JSON + markdown
 * (H3) with its download headers.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { invalidateModel } from '@/lib/azure/query-result-cache';

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => ({
    claims: { oid: 'admin-1', upn: 'admin@contoso.com', tid: 'tenant-1' },
    exp: Date.now() / 1000 + 3600,
  })),
}));

const enforceCapability = vi.fn(async () => null);
vi.mock('@/lib/auth/feature-gate', () => ({
  enforceCapability: (...a: any[]) => enforceCapability(...a),
}));

// Only `detectLoomCloud` is pinned; everything else comes from the REAL module.
// Both routes now compose `withCapability` (route-toolkit R1/R3), whose
// dependency chain reaches other cloud-endpoints resolvers (armScope, …) — a
// bare object mock silently removed them and every case died at import.
vi.mock('@/lib/azure/cloud-endpoints', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/azure/cloud-endpoints')>()),
  detectLoomCloud: () => 'AzureCloud',
}));

// Self-audit run is mocked: return a single passing probe so the readiness
// derivation attaches a live status without any real Azure I/O.
const runSelfAudit = vi.fn(async () => ({
  generatedAt: '2026-07-20T00:00:00.000Z',
  score: 100,
  summary: { pass: 1, warn: 0, fail: 0, total: 1, fixable: 0 },
  results: [
    { id: 'probe-cosmos', category: 'data-plane', title: 'Cosmos', severity: 'critical', status: 'pass', detail: 'reachable' },
  ],
}));
vi.mock('@/lib/admin/self-audit', () => ({
  runSelfAudit: (...a: any[]) => runSelfAudit(...a),
}));

// The lakehouse item read behind the shared-roots check. Default: no rows, so
// every other case sees a passing check and no Cosmos I/O.
const listLakehouseRootFacts = vi.fn(async (): Promise<unknown[]> => []);
vi.mock('@/lib/azure/lakehouse-abfss', () => ({
  listLakehouseRootFacts: () => listLakehouseRootFacts(),
}));

describe('GET /api/admin/readiness', () => {
  beforeEach(() => {
    enforceCapability.mockClear();
    runSelfAudit.mockClear();
    // The route serves probes through a 30s module-level cache
    // (getOrComputeCached, model 'readiness-v1'). Without dropping it between
    // cases, a prior test's cached SUCCESS shadows the next test's mocked
    // rejection — collectProbesUncached never runs, so probeError is undefined
    // and the honest-degrade assertion fails. Cold-start each case.
    invalidateModel('readiness-v1');
  });

  /** The route reads `?refresh=1` off the request, so every case supplies one. */
  const req = (qs = '') => new NextRequest(`http://localhost/api/admin/readiness${qs}`);

  it('is capability-gated (403 propagates)', async () => {
    const { NextResponse } = await import('next/server');
    enforceCapability.mockResolvedValueOnce(NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 }));
    const { GET } = await import('../route');
    const res = await GET(req());
    expect(res.status).toBe(403);
  });

  it('returns the capability graph + workload scorecard with live probes', async () => {
    const { GET } = await import('../route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(Array.isArray(j.capabilities)).toBe(true);
    expect(j.capabilities.length).toBeGreaterThan(0);
    expect(Array.isArray(j.workloads)).toBe(true);
    expect(j.summary.score).toBeGreaterThanOrEqual(0);
    expect(j.probed).toBeGreaterThanOrEqual(1);
    expect(runSelfAudit).toHaveBeenCalled();
    // The mocked cosmos probe pass attaches to the cosmos-config capability.
    const cosmos = j.capabilities.find((n: any) => n.id === 'cosmos-config');
    expect(cosmos?.probe?.status).toBe('pass');
  });

  it('degrades honestly when the self-audit throws (config-only)', async () => {
    runSelfAudit.mockRejectedValueOnce(new Error('probe boom'));
    const { GET } = await import('../route');
    const res = await GET(req());
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.probeError).toContain('probe boom');
    expect(j.probed).toBe(0);
  });

  /**
   * #3729 — the Refresh button used to hit this route with no cache-buster, so
   * a transient probe failure was replayed for the full 30 s TTL. That is how
   * the defect was "reproduced twice": one measurement, read twice.
   */
  it('?refresh=1 BYPASSES the probe cache and re-runs the self-audit', async () => {
    const { GET } = await import('../route');
    // Warm the cache.
    await GET(req());
    const afterWarm = runSelfAudit.mock.calls.length;
    // A cached read must NOT re-probe…
    const cached = await GET(req());
    expect(await cached.json().then((j: any) => j.probesRefreshed)).toBe(false);
    expect(runSelfAudit.mock.calls.length).toBe(afterWarm);
    // …and an explicit re-check MUST.
    const fresh = await GET(req('?refresh=1'));
    const j = await fresh.json();
    expect(j.probesRefreshed).toBe(true);
    expect(runSelfAudit.mock.calls.length).toBe(afterWarm + 1);
  });

  describe('storageChecks: lakehouses sharing a storage root', () => {
    /** Two older lakehouses named "Sales", no recorded binding: both derive `lakehouses/Sales`. */
    const OLDER = '2026-09-01T00:00:00.000Z';
    const SHARED = [
      { id: 'lh-a', displayName: 'Sales', createdAt: OLDER },
      { id: 'lh-b', displayName: 'Sales', createdAt: OLDER },
    ];

    // FAILS IF the route stops returning the check (storageChecks undefined or
    // empty), if it asks for the count-only form (`includeIds: false`: neither id
    // is in the detail), or if the check's title drifts from the constant the
    // storage resolver's message names (a hand-typed title here would not catch
    // that, so the expected value is the imported constant).
    it('reports the shared group WITH item ids, under the title the resolver names', async () => {
      listLakehouseRootFacts.mockResolvedValueOnce(SHARED);
      const { LAKEHOUSE_SHARED_ROOTS_CHECK_ID, LAKEHOUSE_SHARED_ROOTS_CHECK_TITLE } =
        await import('@/lib/admin/env-checks/lakehouse-shared-roots');
      const { GET } = await import('../route');
      const j = await (await GET(req())).json();
      const check = (j.storageChecks as any[]).find((c) => c.id === LAKEHOUSE_SHARED_ROOTS_CHECK_ID);
      expect(check?.status).toBe('warn');
      expect(check?.title).toBe(LAKEHOUSE_SHARED_ROOTS_CHECK_TITLE);
      expect(check?.detail).toContain('Sales (lh-a)');
      expect(check?.detail).toContain('Sales (lh-b)');
      expect(check?.inconclusive).toBeUndefined();
      // The page renders the group from `groups`, with a link per member and
      // the "Keep root for" action. FAILS IF the route drops the groups (the
      // panel would have nothing to act on).
      expect(check?.groups?.[0]?.members?.map((m: any) => [m.id, m.name, m.href])).toEqual([
        ['lh-a', 'Sales', '/items/lakehouse/lh-a'],
        ['lh-b', 'Sales', '/items/lakehouse/lh-b'],
      ]);
    });

    // The positive half of the arm above: with one lakehouse there is no group,
    // so the check passes. FAILS IF the route hard-codes a warn.
    it('passes when no two lakehouses share a root', async () => {
      listLakehouseRootFacts.mockResolvedValueOnce([SHARED[0]]);
      const { GET } = await import('../route');
      const j = await (await GET(req())).json();
      expect(j.storageChecks.map((c: any) => c.status)).toEqual(['pass']);
    });

    // FAILS IF a failed item read fails the whole readiness response (status
    // not 200 / ok not true) or is reported as a pass.
    it('keeps the report when the item read fails, and marks the check inconclusive', async () => {
      listLakehouseRootFacts.mockRejectedValueOnce(Object.assign(new Error('read failed'), { code: 503 }));
      const { GET } = await import('../route');
      const res = await GET(req());
      expect(res.status).toBe(200);
      const j = await res.json();
      expect(j.ok).toBe(true);
      expect(j.storageChecks[0]).toMatchObject({ status: 'warn', inconclusive: true });
    });
  });
});

describe('the storage resolver names the registered readiness title', () => {
  // FAILS IF lakehouseStorageWithheldMessage('root-shared') names any heading
  // other than the one the readiness check is registered under (the pre-fix
  // text said "Lakehouse storage roots", which no readiness entry carries).
  it('root-shared message quotes LAKEHOUSE_SHARED_ROOTS_CHECK_TITLE', async () => {
    const { LAKEHOUSE_SHARED_ROOTS_CHECK_TITLE } = await import('@/lib/admin/env-checks/lakehouse-shared-roots');
    const actual = await vi.importActual<typeof import('@/lib/azure/lakehouse-abfss')>('@/lib/azure/lakehouse-abfss');
    expect(actual.lakehouseStorageWithheldMessage('root-shared')).toContain(`"${LAKEHOUSE_SHARED_ROOTS_CHECK_TITLE}"`);
  });
});

describe('GET /api/admin/readiness/export', () => {
  beforeEach(() => {
    enforceCapability.mockClear();
    runSelfAudit.mockClear();
    // The route serves probes through a 30s module-level cache
    // (getOrComputeCached, model 'readiness-v1'). Without dropping it between
    // cases, a prior test's cached SUCCESS shadows the next test's mocked
    // rejection — collectProbesUncached never runs, so probeError is undefined
    // and the honest-degrade assertion fails. Cold-start each case.
    invalidateModel('readiness-v1');
  });

  const req = (qs = '') => new NextRequest(`http://localhost/api/admin/readiness/export${qs}`);

  it('is capability-gated', async () => {
    const { NextResponse } = await import('next/server');
    enforceCapability.mockResolvedValueOnce(NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 }));
    const { GET } = await import('../export/route');
    const res = await GET(req());
    expect(res.status).toBe(403);
  });

  it('exports JSON with a download filename', async () => {
    const { GET } = await import('../export/route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-disposition')).toContain('.json');
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.profile.blockers).toBeDefined();
    expect(j.profile.environment).toBeDefined();
    expect(j.profile.workloads.length).toBeGreaterThan(0);
  });

  it('exports markdown when format=md', async () => {
    const { GET } = await import('../export/route');
    const res = await GET(req('?format=md'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(res.headers.get('content-disposition')).toContain('.md');
    const text = await res.text();
    expect(text).toContain('# CSA Loom — Ready-to-run tenant profile');
    expect(text).toContain('## Workload readiness');
  });
});
