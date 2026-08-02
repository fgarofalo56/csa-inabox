/**
 * BFF contract tests for GET /api/admin/usage — the audit-log-derived halves of
 * the tenant usage rollup (#2635).
 *
 * The daily-activity series, the 30-day total and the per-item counts all come
 * from the Cosmos `audit-log` container, which partitions on `/itemId` and
 * whose ~45 writers record `tenantId` as `tenantScopeId(session)` = tid ?? oid.
 * The route bound only the caller's `oid`, so every tid-scoped row was invisible
 * — the under-count this spec pins shut. Log Analytics is mocked out entirely;
 * these specs are about the Cosmos scope, not the LA merge.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { auditQueryImpl, makeAuditContainerDouble, twoScopeFixture } from '@/lib/audit/__tests__/audit-container-double';

const SESSION_OID = 'usage-oid';
const SESSION_TID = 'usage-entra-tid';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: SESSION_OID, tid: SESSION_TID, upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  tenantScopeId: (s: any) => s?.claims?.tid ?? s?.claims?.oid,
}));

// --------------------------------------------------------------------------
// Cosmos doubles — workspaces / items are plain, audit-log is Cosmos-faithful.
// --------------------------------------------------------------------------
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
  };
}

let auditRows = twoScopeFixture({ oid: SESSION_OID, tid: SESSION_TID });
let auditDouble = makeAuditContainerDouble(auditRows);
const workspaces = makeSimpleContainer(() => [{ id: 'ws1', name: 'Sales' }]);
const items = makeSimpleContainer(() => [
  { id: 'unity-catalog:CATALOG:finance', workspaceId: 'ws1', itemType: 'lakehouse', displayName: 'Finance', updatedAt: '2026-01-01' },
]);

vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => workspaces,
  itemsContainer: async () => items,
  auditLogContainer: async () => auditDouble,
}));

// --------------------------------------------------------------------------
// usage-client (Log Analytics) — always "not configured" so the LA merge is inert.
// --------------------------------------------------------------------------
class FakeMonitorNotConfigured extends Error {}
vi.mock('@/lib/clients/usage-client', () => ({
  fetchActiveUsersTrend: async () => { throw new FakeMonitorNotConfigured('no LAW'); },
  fetchFeatureAdoption: async () => { throw new FakeMonitorNotConfigured('no LAW'); },
  fetchTopItemsFromLa: async () => { throw new FakeMonitorNotConfigured('no LAW'); },
  MonitorNotConfiguredError: FakeMonitorNotConfigured,
}));

function setAuditRows(rows: ReturnType<typeof twoScopeFixture>) {
  auditRows = rows;
  auditDouble = makeAuditContainerDouble(auditRows);
}

async function callGet(url = 'https://console.test/api/admin/usage?days=30') {
  const { GET } = await import('@/app/api/admin/usage/route');
  return GET(new Request(url) as any);
}

beforeEach(() => {
  process.env.LOOM_TENANT_ADMIN_OID = SESSION_OID;
  getSessionMock.mockReturnValue({ claims: { oid: SESSION_OID, tid: SESSION_TID, upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 } as any);
  setAuditRows(twoScopeFixture({ oid: SESSION_OID, tid: SESSION_TID }));
  workspaces.calls.length = 0;
  items.calls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.LOOM_TENANT_ADMIN_OID;
});

describe('/api/admin/usage — audit-log scope (#2635)', () => {
  it('401s an unauthenticated caller', async () => {
    getSessionMock.mockReturnValue(null);
    expect((await callGet()).status).toBe(401);
  });

  it('403s a caller who is not a tenant admin', async () => {
    delete process.env.LOOM_TENANT_ADMIN_OID;
    expect((await callGet()).status).toBe(403);
  });

  it('counts BOTH the oid-scoped and the tid-scoped audit row', async () => {
    const j = await (await callGet()).json();
    expect(j.ok).toBe(true);
    expect(j.totals.auditEvents30d).toBe(2);
  });

  it('binds the caller oid AND tid as the tenant scope', async () => {
    await callGet();
    const tenants = auditDouble.calls[0]?.parameters.find((p) => p.name === '@tenants');
    expect(tenants?.value).toEqual([SESSION_OID, SESSION_TID]);
  });

  it('reads the audit-log cross-partition (it partitions on /itemId)', async () => {
    await callGet();
    expect(auditDouble.calls[0]?.options?.partitionKey).toBeUndefined();
  });

  it('attributes tid-scoped rows to their real item in the per-item rollup', async () => {
    const j = await (await callGet()).json();
    const finance = j.topItems.find((t: any) => t.itemId === 'unity-catalog:CATALOG:finance');
    // Written via tenantScopeId() → tenantId = tid. Under the old oid-only
    // predicate this row vanished and the item never appeared in the table.
    expect(finance).toBeDefined();
    expect(finance.auditCount).toBe(1);
    expect(finance.displayName).toBe('Finance');
  });

  it('still works on a bootstrap session with no tid', async () => {
    getSessionMock.mockReturnValue({ claims: { oid: SESSION_OID, upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 } as any);
    const j = await (await callGet()).json();
    expect(j.totals.auditEvents30d).toBe(1);
  });

  it('keeps the workspaces read pinned to its /tenantId partition', async () => {
    await callGet();
    expect(workspaces.calls[0]?.options?.partitionKey).toBe(SESSION_OID);
  });

  it('honours the requested window', async () => {
    const old = new Date(Date.now() - 10 * 24 * 3600_000).toISOString();
    setAuditRows([
      ...twoScopeFixture({ oid: SESSION_OID, tid: SESSION_TID }),
      { id: 'audit-old', itemId: 'lakehouse:sales', tenantId: SESSION_TID, at: old },
    ]);
    const j = await (await callGet('https://console.test/api/admin/usage?days=1')).json();
    expect(j.totals.auditEvents30d).toBe(2);
  });
});

// Keep the shared double honest: a reader that binds NEITHER tenant predicate
// must blow up rather than silently returning every row.
describe('audit-log container double', () => {
  it('refuses to fake a result for an unrecognised tenant predicate', () => {
    const impl = auditQueryImpl(twoScopeFixture({ oid: 'a', tid: 'b' }));
    expect(() => impl({ query: 'SELECT VALUE COUNT(1) FROM c', parameters: [] })).toThrow(/tenant predicate/);
  });
});
