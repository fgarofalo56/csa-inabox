/**
 * BFF contract tests for GET /api/governance/govern/posture — the
 * `sharedItems30d` KPI's audit-log scope (#2793, the tail of the #2635 class).
 *
 * The Cosmos `audit-log` container partitions on `/itemId` and its ~45 writers
 * record `tenantId` as `tenantScopeId(session)` = tid ?? oid, so
 * posture-client's `c.tenantId = @t` (with `@t = claims.oid`) predicate counted
 * only the oid-scoped share events and missed every tid-scoped one — the same
 * under-count /admin/audit-logs (#2608) and /governance/insights (#2635) already
 * fixed.
 *
 * The route is tenant-admin gated (403 for anyone else), and the adopted helper
 * `auditScopeIdsForViewer` is admin-conditional, so the two facts pinned below
 * are:
 *   1. a tenant admin's count now includes the tid-scoped row  (RED without the fix)
 *   2. the widening is NOT unconditional — the non-admin path stays `[oid]`
 *      (a control that passes with AND without the fix, so an over-broad
 *      "always bind oid+tid" version of this change is caught here too)
 *
 * MUTATION PROOF (2026-08-02): reverting ONLY the posture-client predicate to
 * `c.tenantId = @t` / `@t = tenantId` turns 2 of these 10 tests red
 * ("counts BOTH…" → expected 1 to be 2; "binds oid AND tid…" → @tenants
 * undefined). The other 8 — 401, 403, cross-partition, share-kind query shape,
 * workspaces partition key, honest gates, and both admin-conditional scope
 * assertions — pass on BOTH trees.
 *
 * Every non-Cosmos metric source is mocked as not-configured so the call
 * exercises the honest-gate path and only the Cosmos aggregates matter.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeAuditContainerDouble, type AuditRowFixture } from '@/lib/audit/__tests__/audit-container-double';

const SESSION_OID = 'posture-oid';
const SESSION_TID = 'posture-entra-tid';

const H = vi.hoisted(() => {
  class MockMipErr extends Error { hint: any; constructor(h: any) { super('mip'); this.hint = h; } }
  class MockDlpErr extends Error { hint: any; constructor(h: any) { super('dlp'); this.hint = h; } }
  class MockPurviewErr extends Error { hint: any; constructor(h: any) { super('pv'); this.hint = h; } }
  class MockMonitorErr extends Error { missing: string[]; constructor(m: string[]) { super('mon'); this.missing = m; } }
  return { MockMipErr, MockDlpErr, MockPurviewErr, MockMonitorErr };
});

const getSessionMock = vi.fn(
  () => ({ claims: { oid: SESSION_OID, tid: SESSION_TID, upn: 'user@contoso.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  tenantScopeId: (s: any) => s?.claims?.tid ?? s?.claims?.oid,
}));

/**
 * Four audit rows, all inside the 30-day window: one share + one non-share
 * under EACH of the two writer conventions. `itemId` is a real target (never an
 * oid) so the cross-partition requirement is exercised.
 *
 * The symmetry matters: the kind narrowing has something to exclude on both the
 * pre-fix (oid-only) and post-fix (oid+tid) scopes, so the query-shape control
 * below is meaningful either way.
 */
function shareFixture(): AuditRowFixture[] {
  const at = new Date().toISOString();
  return [
    // Written by the admin-plane audit stream (oid-scoped).
    { id: 'share-oid-1', itemId: 'lakehouse:finance', tenantId: SESSION_OID, at, kind: 'share' },
    { id: 'open-oid-1', itemId: 'lakehouse:finance', tenantId: SESSION_OID, at, kind: 'open' },
    // Written through tenantScopeId(session) (tid-scoped) — the rows the old
    // `c.tenantId = @t` predicate could never see.
    { id: 'share-tid-1', itemId: 'report:q3-revenue', tenantId: SESSION_TID, at, kind: 'share' },
    { id: 'open-tid-1', itemId: 'report:q3-revenue', tenantId: SESSION_TID, at, kind: 'open' },
  ];
}

function makeSimpleContainer(rows: () => any[]) {
  const calls: Array<{ query: string; options?: any }> = [];
  return {
    calls,
    items: {
      query(q: any, opts?: any) {
        calls.push({ query: q?.query, options: opts });
        return { async fetchAll() { return { resources: rows() }; } };
      },
    },
    item() {
      return { async read() { const e: any = new Error('not found'); e.code = 404; throw e; } };
    },
  };
}

let auditDouble = makeAuditContainerDouble(shareFixture());
const workspaces = makeSimpleContainer(() => [{ id: 'ws1' }]);
const items = makeSimpleContainer(() => [
  { id: 'i1', workspaceId: 'ws1', itemType: 'lakehouse', displayName: 'Finance', updatedAt: new Date().toISOString(), state: { sensitivityLabel: 'Confidential' } },
]);

vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => workspaces,
  itemsContainer: async () => items,
  auditLogContainer: async () => auditDouble,
  postureAggregatesAdminContainer: async () => ({
    item: () => ({ read: async () => ({ resource: null }) }),
    items: { upsert: async () => {} },
  }),
  featurePermissionsContainer: async () => makeSimpleContainer(() => []),
}));

vi.mock('@/lib/azure/mip-graph-client', () => ({
  MipNotConfiguredError: H.MockMipErr,
  listSensitivityLabels: async () => { throw new H.MockMipErr({ missingEnvVar: 'LOOM_MIP_ENABLED' }); },
}));
vi.mock('@/lib/azure/dlp-graph-client', () => ({
  DlpNotConfiguredError: H.MockDlpErr,
  listDlpAlerts: async () => { throw new H.MockDlpErr({ missingEnvVar: 'LOOM_DLP_ENABLED' }); },
}));
vi.mock('@/lib/azure/purview-client', () => ({
  PurviewNotConfiguredError: H.MockPurviewErr,
  listDataSources: async () => { throw new H.MockPurviewErr({ missingEnvVar: 'LOOM_PURVIEW_ACCOUNT' }); },
  listScansForSource: async () => [],
  listScanRuns: async () => [],
}));
vi.mock('@/lib/azure/monitor-client', () => ({
  MonitorNotConfiguredError: H.MockMonitorErr,
  queryLogs: async () => { throw new H.MockMonitorErr(['LOOM_LOG_ANALYTICS_WORKSPACE_ID']); },
}));

async function callGet() {
  const { GET } = await import('@/app/api/governance/govern/posture/route');
  return GET();
}

/** The `@tenants` value bound by the first (and only) audit-log query. */
function boundTenants(): unknown {
  return auditDouble.calls[0]?.parameters.find((p) => p.name === '@tenants')?.value;
}

beforeEach(() => {
  auditDouble = makeAuditContainerDouble(shareFixture());
  getSessionMock.mockReturnValue({ claims: { oid: SESSION_OID, tid: SESSION_TID, upn: 'user@contoso.com' }, exp: Date.now() / 1000 + 3600 } as any);
  process.env.LOOM_COSMOS_ENDPOINT = 'https://fake.documents.azure.com:443/';
  process.env.LOOM_TENANT_ADMIN_OID = SESSION_OID; // tenant admin by default
  workspaces.calls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.LOOM_TENANT_ADMIN_OID;
  delete process.env.LOOM_COSMOS_ENDPOINT;
});

describe('/api/governance/govern/posture — sharedItems30d audit scope (#2793)', () => {
  it('401s an unauthenticated caller', async () => {
    getSessionMock.mockReturnValue(null);
    expect((await callGet()).status).toBe(401);
  });

  it('403s a non-admin (the route gate is unchanged by this fix)', async () => {
    delete process.env.LOOM_TENANT_ADMIN_OID;
    const res = await callGet();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('admin_only');
  });

  // ── THE REGRESSION THIS FIX EXISTS FOR ─────────────────────────────────────
  // Red before the fix: the oid-only predicate saw share-oid-1 only → 1.
  // (The two `kind: 'open'` rows are excluded by the share narrowing, which is
  // unchanged by this fix — see the query-shape control below.)
  it('counts BOTH the oid-scoped and the tid-scoped share event for a tenant admin', async () => {
    const j = await (await callGet()).json();
    expect(j.ok).toBe(true);
    expect(j.posture.sharedItems30d).toBe(2);
  });

  it('binds oid AND tid as the audit tenant scope for a tenant admin', async () => {
    await callGet();
    expect(boundTenants()).toEqual([SESSION_OID, SESSION_TID]);
  });

  // ── CONTROLS: true with AND without the fix ────────────────────────────────
  it('reads the audit-log cross-partition (it partitions on /itemId)', async () => {
    await callGet();
    expect(auditDouble.calls[0]?.options?.partitionKey).toBeUndefined();
  });

  it('keeps the share-kind narrowing in the query (untouched by the scope fix)', async () => {
    await callGet();
    const q = auditDouble.calls[0]?.query ?? '';
    expect(q).toContain("c.kind = 'share'");
    expect(q).toContain("c.action = 'share'");
    expect(q).toMatch(/SELECT\s+VALUE\s+COUNT\(1\)/);
  });

  it('keeps the workspaces read pinned to its /tenantId partition', async () => {
    await callGet();
    expect(workspaces.calls[0]?.options?.partitionKey).toBe(SESSION_OID);
  });

  it('still degrades every absent metric source to an honest gate', async () => {
    const j = await (await callGet()).json();
    expect(j.gates.mip.missingEnvVar).toBe('LOOM_MIP_ENABLED');
    expect(j.gates.dlp.missingEnvVar).toBe('LOOM_DLP_ENABLED');
    expect(j.gates.purview.missingEnvVar).toBe('LOOM_PURVIEW_ACCOUNT');
    expect(j.posture.mipCoveragePct).toBeNull();
  });
});

describe('/api/governance/govern/posture — the widening is admin-conditional', () => {
  /**
   * CONTROL that passes with AND without the fix, and FAILS an over-broad fix.
   *
   * `auditScopeIdsForViewer` returns `[oid]` for a non-admin — byte-identical
   * to the pre-fix behaviour. A version of this change that bound `[oid, tid]`
   * unconditionally would still satisfy every assertion above but fail here.
   *
   * The route 403s a non-admin today, so this is asserted directly against the
   * helper the route calls rather than through the HTTP surface: it pins the
   * counter's scope to the admin conditional independently of the route gate,
   * which is exactly the property that must survive if that gate is relaxed.
   */
  it('scopes a non-admin viewer to their own oid only', async () => {
    delete process.env.LOOM_TENANT_ADMIN_OID;
    const { auditScopeIdsForViewer } = await import('@/lib/audit/audit-scope');
    const session = { claims: { oid: SESSION_OID, tid: SESSION_TID }, exp: Date.now() / 1000 + 3600 } as any;
    expect(auditScopeIdsForViewer(session)).toEqual([SESSION_OID]);
  });

  it('widens a tenant-admin viewer to oid + tid', async () => {
    process.env.LOOM_TENANT_ADMIN_OID = SESSION_OID;
    const { auditScopeIdsForViewer } = await import('@/lib/audit/audit-scope');
    const session = { claims: { oid: SESSION_OID, tid: SESSION_TID }, exp: Date.now() / 1000 + 3600 } as any;
    expect(auditScopeIdsForViewer(session)).toEqual([SESSION_OID, SESSION_TID]);
  });
});
