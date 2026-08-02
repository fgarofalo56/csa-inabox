/**
 * BFF contract tests for GET /api/admin/overview — the admin-landing tile counts.
 *
 * Per .claude/rules/no-vaporware.md these exercise the real route handler with
 * mocked Cosmos / Graph / ARM / MIP backends. They pin: 401 auth, the 12-tile
 * shape, real counts from each backend, and the honest-gate path for every
 * source that can be absent (Graph users, ARM capacity, ARM alerts, MIP labels).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { auditQueryImpl, twoScopeFixture } from '@/lib/audit/__tests__/audit-container-double';

// --------------------------------------------------------------------------
// session
// --------------------------------------------------------------------------
const SESSION_OID = 'tenant-oid';
const SESSION_TID = 'entra-tenant-id';
const getSessionMock = vi.fn(
  () => ({ claims: { oid: SESSION_OID, tid: SESSION_TID, upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

// credentials (Graph token for the users/$count call)
vi.mock('@azure/identity', () => {
  class Cred {
    async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

// --------------------------------------------------------------------------
// Cosmos doubles
// --------------------------------------------------------------------------
function makeContainer() {
  const docs = new Map<string, any>();
  let queryImpl: (q: any, opts?: any) => any[] = () => [];
  // Every (query, requestOptions) pair the route handed this container — the
  // request options are how a spec proves a read was (or was NOT) pinned to a
  // physical partition (#2635).
  const calls: Array<{ query: string; parameters: any[]; options?: any }> = [];
  return {
    calls,
    _seed(id: string, pk: string, doc: any) { docs.set(`${pk}::${id}`, doc); },
    _setQuery(fn: (q: any, opts?: any) => any[]) { queryImpl = fn; },
    item(id: string, pk: string) {
      return {
        async read<T>() {
          const d = docs.get(`${pk}::${id}`);
          if (d === undefined) { const e: any = new Error('not found'); e.code = 404; throw e; }
          return { resource: d as T };
        },
      };
    },
    items: {
      query(q: any, opts?: any) {
        calls.push({ query: q?.query, parameters: q?.parameters ?? [], options: opts });
        return { async fetchAll() { return { resources: queryImpl(q, opts) }; } };
      },
    },
  };
}

const containers = {
  workspaces: makeContainer(),
  items: makeContainer(),
  tenantSettings: makeContainer(),
  auditLog: makeContainer(),
  featurePermissions: makeContainer(),
  attributeGroups: makeContainer(),
  labelAssignments: makeContainer(),
  costAnomalyRules: makeContainer(),
  lakehouseInterop: makeContainer(),
  incidents: makeContainer(),
};

vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => containers.workspaces,
  itemsContainer: async () => containers.items,
  tenantSettingsContainer: async () => containers.tenantSettings,
  auditLogContainer: async () => containers.auditLog,
  featurePermissionsContainer: async () => containers.featurePermissions,
  attributeGroupsContainer: async () => containers.attributeGroups,
  labelAssignmentsContainer: async () => containers.labelAssignments,
  costAnomalyRulesContainer: async () => containers.costAnomalyRules,
  lakehouseInteropContainer: async () => containers.lakehouseInterop,
  incidentsContainer: async () => containers.incidents,
}));

// --------------------------------------------------------------------------
// monitor-client (ARM) — capacity + open-audit-items
// --------------------------------------------------------------------------
const listResourcesMock = vi.fn();
const listAlertHistoryMock = vi.fn();
const queryLogsMock = vi.fn();
class FakeMonitorNotConfigured extends Error {
  constructor(public missing: string[]) { super(`Monitor not configured. Missing env: ${missing.join(', ')}`); }
}
vi.mock('@/lib/azure/monitor-client', () => ({
  listResources: () => listResourcesMock(),
  listAlertHistory: (o: any) => listAlertHistoryMock(o),
  queryLogs: (kql: string, timespan?: string) => queryLogsMock(kql, timespan),
  MonitorNotConfiguredError: FakeMonitorNotConfigured,
}));

// --------------------------------------------------------------------------
// mip-graph-client — sensitivity labels
// --------------------------------------------------------------------------
const listSensitivityLabelsMock = vi.fn();
class FakeMipNotConfigured extends Error {
  hint: any;
  constructor() { super('MIP not configured'); this.hint = { followUp: 'Set LOOM_MIP_ENABLED=true' }; }
}
vi.mock('@/lib/azure/mip-graph-client', () => ({
  listSensitivityLabels: () => listSensitivityLabelsMock(),
  MipNotConfiguredError: FakeMipNotConfigured,
}));

function seedHappyCosmos() {
  containers.workspaces._setQuery((q) =>
    /COUNT\(1\)/.test(q.query) ? [4] : [{ id: 'ws1' }, { id: 'ws2' }]);
  containers.items._setQuery(() => [42]);          // SELECT VALUE COUNT(1) over items
  containers.auditLog._setQuery(() => [7]);
  containers.featurePermissions._setQuery(() => [3]);
  containers.attributeGroups._setQuery(() => [2]);
  containers.labelAssignments._setQuery(() => [9]);
  containers.tenantSettings._seed('domains:tenant-oid', 'tenant-oid', { items: [{ id: 'fin' }, { id: 'ops' }] });
  containers.tenantSettings._seed('tenant-oid', 'tenant-oid', { settings: { a: true, b: false, c: true } });
  // C4 — finops tile: enabled cost-anomaly watch rules (SELECT VALUE COUNT(1)).
  containers.costAnomalyRules._setQuery(() => [2]);
  // N1 — icebergTables tile: Delta tables ALSO exposed as Apache Iceberg.
  // Two interop docs (two lakehouse containers); 3 of the 4 rows are exposed.
  containers.lakehouseInterop._setQuery(() => [
    { tables: [{ iceberg: true }, { iceberg: false }] },
    { tables: [{ iceberg: true }, { iceberg: true }] },
  ]);
  // N17 — openIncidents tile: open data-observability incidents (COUNT(1)).
  containers.incidents._setQuery(() => [4]);
}

beforeEach(() => {
  for (const c of Object.values(containers)) { c._setQuery(() => []); c.calls.length = 0; }
  getSessionMock.mockReturnValue({ claims: { oid: SESSION_OID, tid: SESSION_TID, upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 } as any);
  // #1602 gates the overview behind requireTenantAdmin; authorize the test
  // session (oid 'tenant-oid') as the bootstrap tenant admin so the real gate
  // passes and the tiles render. The 401 spec sets session=null and still 401s.
  process.env.LOOM_TENANT_ADMIN_OID = SESSION_OID;
  listResourcesMock.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]);
  listAlertHistoryMock.mockResolvedValue([
    { monitorCondition: 'Fired' }, { monitorCondition: 'Resolved' }, { monitorCondition: 'Fired' },
  ]);
  listSensitivityLabelsMock.mockResolvedValue([{ id: 'l1' }, { id: 'l2' }]);
  // RUM1 — client-error count from AppExceptions (queryLogs over the LAW).
  queryLogsMock.mockResolvedValue({ columns: ['n'], rows: [[5]], rowCount: 1 });
  delete process.env.LOOM_IDENTITY_PICKER_ENABLED;
  vi.stubGlobal('fetch', vi.fn(async () => new Response('893', { status: 200 })));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.LOOM_IDENTITY_PICKER_ENABLED;
});

describe('/api/admin/overview', () => {
  it('GET 401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null);
    const { GET } = await import('@/app/api/admin/overview/route');
    expect((await GET()).status).toBe(401);
  });

  it('GET returns all 18 tiles with real counts when every backend resolves', async () => {
    process.env.LOOM_IDENTITY_PICKER_ENABLED = 'true';
    seedHappyCosmos();
    const { GET } = await import('@/app/api/admin/overview/route');
    const j = await (await GET()).json();
    expect(j.ok).toBe(true);
    const t = j.tiles;
    expect(Object.keys(t)).toHaveLength(18);
    expect(t.workspaces).toEqual({ count: 4, gated: false });
    expect(t.items).toEqual({ count: 42, gated: false });
    expect(t.domains).toEqual({ count: 2, gated: false });
    expect(t.auditEvents).toEqual({ count: 7, gated: false });
    expect(t.permissions).toEqual({ count: 3, gated: false });
    expect(t.attributeGroups).toEqual({ count: 2, gated: false });
    expect(t.labeledItems).toEqual({ count: 9, gated: false });
    expect(t.tenantSettings).toEqual({ count: 2, gated: false }); // 2 of 3 booleans true
    expect(t.users).toEqual({ count: 893, gated: false });
    expect(t.capacity).toEqual({ count: 3, gated: false });
    expect(t.openAuditItems).toEqual({ count: 2, gated: false }); // Fired only
    expect(t.sensitivityLabels).toEqual({ count: 2, gated: false });
    // RUM1 — browser JS errors (24 h) from AppExceptions via queryLogs.
    expect(t.rumClientErrors).toEqual({ count: 5, gated: false });
    // C4 — finops tile: enabled cost-anomaly watch rules.
    expect(t.finops).toEqual({ count: 2, gated: false });
    // N1 — catalog-federation tile: tables external engines can read as Iceberg.
    expect(t.icebergTables).toEqual({ count: 3, gated: false });
    // N17 — incident-console tile: open data-observability incidents.
    expect(t.openIncidents).toEqual({ count: 4, gated: false });
    // DIAG1 — diagnostics tile: blocked-gate census (in-process gate registry;
    // env-dependent count, so assert shape not an exact number).
    expect(t.diagnostics.gated).toBe(false);
    expect(typeof t.diagnostics.count).toBe('number');
  });

  it('GET gates the rumClientErrors tile when Log Analytics is not configured', async () => {
    queryLogsMock.mockRejectedValue(new FakeMonitorNotConfigured(['LOOM_LOG_ANALYTICS_WORKSPACE_ID']));
    const { GET } = await import('@/app/api/admin/overview/route');
    const j = await (await GET()).json();
    expect(j.tiles.rumClientErrors.count).toBeNull();
    expect(j.tiles.rumClientErrors.gated).toBe(true);
    expect(j.tiles.rumClientErrors.hint).toMatch(/LOOM_LOG_ANALYTICS_WORKSPACE_ID/);
  });

  it('GET gates the users tile when LOOM_IDENTITY_PICKER_ENABLED is unset', async () => {
    seedHappyCosmos();
    const { GET } = await import('@/app/api/admin/overview/route');
    const j = await (await GET()).json();
    expect(j.tiles.users.count).toBeNull();
    expect(j.tiles.users.gated).toBe(true);
    expect(j.tiles.users.hint).toMatch(/LOOM_IDENTITY_PICKER_ENABLED/);
  });

  it('GET gates the capacity tile when ARM is not configured', async () => {
    listResourcesMock.mockRejectedValue(new FakeMonitorNotConfigured(['LOOM_SUBSCRIPTION_ID']));
    const { GET } = await import('@/app/api/admin/overview/route');
    const j = await (await GET()).json();
    expect(j.tiles.capacity.count).toBeNull();
    expect(j.tiles.capacity.gated).toBe(true);
    expect(j.tiles.capacity.hint).toMatch(/LOOM_SUBSCRIPTION_ID/);
  });

  it('GET gates the open-audit-items tile when AlertsManagement is not configured', async () => {
    listAlertHistoryMock.mockRejectedValue(new FakeMonitorNotConfigured(['LOOM_SUBSCRIPTION_ID']));
    const { GET } = await import('@/app/api/admin/overview/route');
    const j = await (await GET()).json();
    expect(j.tiles.openAuditItems.count).toBeNull();
    expect(j.tiles.openAuditItems.gated).toBe(true);
  });

  it('GET gates the sensitivity-labels tile and surfaces the MIP remediation', async () => {
    listSensitivityLabelsMock.mockRejectedValue(new FakeMipNotConfigured());
    const { GET } = await import('@/app/api/admin/overview/route');
    const j = await (await GET()).json();
    expect(j.tiles.sensitivityLabels.count).toBeNull();
    expect(j.tiles.sensitivityLabels.gated).toBe(true);
    expect(j.tiles.sensitivityLabels.hint).toMatch(/LOOM_MIP_ENABLED/);
  });

  it('GET counts only Fired alert instances for openAuditItems', async () => {
    listAlertHistoryMock.mockResolvedValue([
      { monitorCondition: 'Fired' }, { monitorCondition: 'Fired' },
      { monitorCondition: 'Resolved' }, { monitorCondition: 'Fired' },
    ]);
    const { GET } = await import('@/app/api/admin/overview/route');
    const j = await (await GET()).json();
    expect(j.tiles.openAuditItems).toEqual({ count: 3, gated: false });
  });

  it('GET gates Cosmos tiles when the container throws (endpoint not set)', async () => {
    containers.workspaces._setQuery(() => { throw new Error('LOOM_COSMOS_ENDPOINT not set'); });
    const { GET } = await import('@/app/api/admin/overview/route');
    const j = await (await GET()).json();
    expect(j.tiles.workspaces.count).toBeNull();
    expect(j.tiles.workspaces.gated).toBe(true);
    expect(j.tiles.workspaces.hint).toMatch(/LOOM_COSMOS_ENDPOINT/);
  });

  // ------------------------------------------------------------------------
  // #2635 — the auditEvents tile read the /itemId-partitioned audit-log
  // container as if it were partitioned on /tenantId.
  // ------------------------------------------------------------------------
  describe('auditEvents tile — audit-log scope (#2635)', () => {
    // Cosmos-faithful double: rows only resolve from their OWN /itemId
    // partition, and the tenant predicate is honoured as written.
    function seedRealisticAuditRows() {
      seedHappyCosmos();
      containers.auditLog._setQuery(auditQueryImpl(twoScopeFixture({ oid: SESSION_OID, tid: SESSION_TID })));
    }

    it('does NOT pin the read to a partition — audit-log partitions on /itemId, not /tenantId', async () => {
      seedRealisticAuditRows();
      const { GET } = await import('@/app/api/admin/overview/route');
      await GET();
      expect(containers.auditLog.calls).toHaveLength(1);
      // A partitionKey here means the read was pinned to `itemId === <caller oid>`
      // — a partition no audit row can occupy, so the tile could only ever be 0.
      expect(containers.auditLog.calls[0].options?.partitionKey).toBeUndefined();
    });

    it('counts BOTH the oid-scoped and the tid-scoped row', async () => {
      seedRealisticAuditRows();
      const { GET } = await import('@/app/api/admin/overview/route');
      const j = await (await GET()).json();
      // Two rows in the fixture: one written by the admin-plane audit stream
      // (tenantId = actor oid), one via tenantScopeId() (tenantId = Entra tid).
      expect(j.tiles.auditEvents).toEqual({ count: 2, gated: false });
    });

    it('binds the caller oid AND tid as the tenant scope', async () => {
      seedRealisticAuditRows();
      const { GET } = await import('@/app/api/admin/overview/route');
      await GET();
      const tenants = containers.auditLog.calls[0].parameters.find((p: any) => p.name === '@tenants');
      expect(tenants?.value).toEqual([SESSION_OID, SESSION_TID]);
    });

    it('still counts oid-scoped rows on a bootstrap session with no tid', async () => {
      getSessionMock.mockReturnValue({ claims: { oid: SESSION_OID, upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 } as any);
      seedRealisticAuditRows();
      const { GET } = await import('@/app/api/admin/overview/route');
      const j = await (await GET()).json();
      expect(j.tiles.auditEvents).toEqual({ count: 1, gated: false });
    });

    it('excludes rows older than the 30-day window', async () => {
      seedHappyCosmos();
      const old = new Date(Date.now() - 40 * 24 * 3600_000).toISOString();
      containers.auditLog._setQuery(auditQueryImpl([
        ...twoScopeFixture({ oid: SESSION_OID, tid: SESSION_TID }),
        { id: 'audit-stale', itemId: 'lakehouse:sales', tenantId: SESSION_TID, at: old },
      ]));
      const { GET } = await import('@/app/api/admin/overview/route');
      const j = await (await GET()).json();
      expect(j.tiles.auditEvents).toEqual({ count: 2, gated: false });
    });

    it('leaves the genuinely /tenantId-partitioned tiles pinned to one partition', async () => {
      seedRealisticAuditRows();
      const { GET } = await import('@/app/api/admin/overview/route');
      await GET();
      // Regression guard for the obvious over-correction: workspaces,
      // feature-permissions, attribute-groups and label-assignments DO
      // partition on /tenantId and must keep their single-partition read.
      for (const c of [containers.featurePermissions, containers.attributeGroups, containers.labelAssignments]) {
        expect(c.calls[0]?.options?.partitionKey).toBe(SESSION_OID);
      }
      expect(containers.workspaces.calls[0]?.options?.partitionKey).toBe(SESSION_OID);
    });
  });
});
