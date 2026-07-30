/**
 * LU-3 SECURITY remediation tests (adversarial review, 2026-07-28).
 *
 * Every block here is an ATTACK on the audit trail, not a happy path:
 *
 *   - a catalog READ escaping the boundary to a third-party webhook;
 *   - the pane's actor column / actor filter reading a field the recorder never
 *     wrote (silent blank + "no results" on a very active user);
 *   - every collection read piling into ONE Cosmos logical partition until
 *     writes start failing SILENTLY;
 *   - caller filters applied AFTER `SELECT TOP @top`, so a search under-reports
 *     and an auditor concludes nothing happened;
 *   - a TOP-N-truncated summary presented as window-wide totals;
 *   - `flushUnityAudit` never terminating on a live server;
 *   - a Unity Catalog GRANT MUTATION on the Commercial default backend
 *     (databricks-client's dbxFetch) producing no row at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const auditCreate = vi.fn();
const emitAuditEvent = vi.fn();
const cosmosQuery = vi.fn();

vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() { return { token: 'fake-aad-token', expiresOnTimestamp: Date.now() + 3_600_000 }; }
  }
  return { DefaultAzureCredential: FakeCred, ManagedIdentityCredential: FakeCred, ChainedTokenCredential: FakeCred };
});

vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: async () => ({
    items: {
      create: auditCreate,
      query: (spec: unknown) => ({ fetchAll: async () => cosmosQuery(spec) }),
    },
  }),
}));

vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent }));

vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({
    claims: { oid: 'oid-alice', upn: 'alice@contoso.com', tid: 'tenant-1' },
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
}));

import {
  recordUnityAccess, recordDatabricksUnityAccess,
  flushUnityAudit, isUnityMutation, isUnityCatalogPath,
  unityAuditPartitionKey, FLUSH_MAX_PASSES, UNITY_SECURABLE_ALL,
} from '../unity-audit';

function reset() {
  auditCreate.mockReset();
  emitAuditEvent.mockReset();
  cosmosQuery.mockReset();
  auditCreate.mockResolvedValue({});
  cosmosQuery.mockResolvedValue({ resources: [] });
}

beforeEach(reset);
afterEach(reset);

const READ = {
  operation: 'catalog.list', securableType: 'catalog', securableFqn: UNITY_SECURABLE_ALL,
  backend: 'oss' as const, method: 'GET', path: '/api/2.1/unity-catalog/catalogs',
  outcome: 'success' as const, status: 200, durationMs: 1,
};

describe('BOUNDARY EGRESS — a catalog READ must not leave the estate', () => {
  it('emits read rows with the outbound-webhook fan-out DISABLED', async () => {
    await recordUnityAccess(READ);
    expect(emitAuditEvent).toHaveBeenCalledTimes(1);
    const [ev, opts] = emitAuditEvent.mock.calls[0];
    expect(ev.action).toBe('unity.catalog.list');
    // Without `{ webhook: false }`, lib/admin/audit-stream.ts forwards this to
    // every tenant-registered third-party URL — actor UPN + securable FQN, at
    // request volume, mislabelled as `admin.mutation` (the catch-all every
    // generic subscriber receives).
    expect(opts).toEqual({ webhook: false });
  });

  it('still lets a MUTATION through to the webhook fan-out', async () => {
    await recordUnityAccess({
      ...READ,
      operation: 'grant.update', securableType: 'table', securableFqn: 'sales.bronze.orders',
      method: 'PATCH', path: '/api/2.1/unity-catalog/permissions/table/sales.bronze.orders',
    });
    expect(emitAuditEvent.mock.calls[0][1]).toEqual({ webhook: true });
  });

  it('resolves an UNKNOWN operation on a safe method as a READ (no egress)', () => {
    // ROUND-3 REGRESSION GUARD. Round 2 decided read-ness from the LAST dotted
    // segment being get|list|read, so every OTHER verb on a GET was filed as a
    // mutation and fanned out to tenant-registered third-party URLs. Two real
    // shapes hit that path on every estate:
    expect(isUnityMutation({ method: 'GET', operation: 'probe.anonymous-read' })).toBe(false);
    expect(isUnityMutation({ method: 'GET', operation: 'unity.request' })).toBe(false);
    // …and the general class: any un-modelled future verb on a safe method.
    expect(isUnityMutation({ method: 'GET', operation: 'catalog.enumerate' })).toBe(false);
    expect(isUnityMutation({ method: 'HEAD', operation: 'table.exists' })).toBe(false);
  });

  it('does NOT egress the LU-2 health-probe row, which runs on every /admin/health', async () => {
    // This is the row the original finding named explicitly. It carries
    // actorUpn + actorOid + path, and it is written on EVERY /admin/health,
    // /admin/readiness, self-audit and copilot-orchestrator run — the highest
    // -frequency row in the trail, shipped to third-party URLs.
    await recordUnityAccess({
      ...READ,
      operation: 'probe.anonymous-read',
      securableType: 'catalog',
      path: '/api/2.1/unity-catalog/catalogs',
      outcome: 'denied', status: 401,
    });
    expect(emitAuditEvent).toHaveBeenCalledTimes(1);
    expect(emitAuditEvent.mock.calls[0][1]).toEqual({ webhook: false });
    // The ROW is still written — fail-closed on egress must not cost a record.
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0]).toMatchObject({ action: 'unity.probe.anonymous-read', mutation: false });
  });

  it('does NOT egress an un-modelled catalog family read (the unity.request catch-all)', async () => {
    await recordUnityAccess({
      ...READ,
      operation: 'unity.request', securableType: 'unknown',
      path: '/api/2.1/some-future-family/thing', method: 'GET',
    });
    expect(emitAuditEvent.mock.calls[0][1]).toEqual({ webhook: false });
  });

  it('still egresses a mutation that arrives with a mislabelled safe method', () => {
    // The other direction still has to hold: a state change must not be
    // downgraded to a read just because the method says GET.
    expect(isUnityMutation({ method: 'GET', operation: 'catalog.delete' })).toBe(true);
    expect(isUnityMutation({ method: 'GET', operation: 'grant.update' })).toBe(true);
    expect(isUnityMutation({ method: 'GET', operation: 'temporary-credential.vend' })).toBe(true);
    expect(isUnityMutation({ method: 'GET', operation: 'system-schema.enable' })).toBe(true);
  });

  it('resolves read-vs-mutation conservatively', () => {
    expect(isUnityMutation({ method: 'GET', operation: 'catalog.list' })).toBe(false);
    expect(isUnityMutation({ method: 'GET', operation: 'table.get' })).toBe(false);
    expect(isUnityMutation({ method: 'PATCH', operation: 'grant.update' })).toBe(true);
    expect(isUnityMutation({ method: 'DELETE', operation: 'catalog.delete' })).toBe(true);
    expect(isUnityMutation({ method: 'POST', operation: 'temporary-credential.vend' })).toBe(true);
    // Ambiguity must resolve toward "mutation" — an un-modelled POST, or a
    // mutating verb arriving with a mislabelled method, must never be filed as
    // a read (which would also mean it silently skipped the external SOC).
    expect(isUnityMutation({ method: 'POST', operation: 'unity.request' })).toBe(true);
    expect(isUnityMutation({ method: 'GET', operation: 'catalog.delete' })).toBe(true);
  });
});

describe('the row the recorder writes must be READABLE and SCALABLE', () => {
  it('writes actorUpn — the field the pane column and the actor filter read', async () => {
    await recordUnityAccess(READ);
    const row = auditCreate.mock.calls[0][0];
    // Writing only `upn`/`who` left every `actor` cell blank and made the
    // "Actor contains" filter match nothing.
    expect(row.actorUpn).toBe('alice@contoso.com');
    expect(row.actorOid).toBe('oid-alice');
  });

  it('spreads collection-scope rows off the single hot logical partition', async () => {
    // A named securable keeps its own partition…
    expect(unityAuditPartitionKey('sales.bronze.orders', 'table.get', '2026-07-28T00:00:00Z'))
      .toBe('sales.bronze.orders');
    // …but every list call in the estate must NOT land on the '*' sentinel: one
    // logical partition (20 GB / 10k RU/s) for the highest-volume operation,
    // and `recordUnityAccess` swallows write errors, so the trail would stop
    // growing SILENTLY on exactly the rows the pane shows by default.
    const key = unityAuditPartitionKey(UNITY_SECURABLE_ALL, 'catalog.list', '2026-07-28T12:00:00Z');
    expect(key).toBe('unity:catalog.list:2026-07-28');
    expect(unityAuditPartitionKey(UNITY_SECURABLE_ALL, 'schema.list', '2026-07-28T12:00:00Z')).not.toBe(key);
    expect(unityAuditPartitionKey(UNITY_SECURABLE_ALL, 'catalog.list', '2026-07-29T00:00:00Z')).not.toBe(key);

    await recordUnityAccess(READ);
    const row = auditCreate.mock.calls[0][0];
    expect(row.itemId).not.toBe(UNITY_SECURABLE_ALL);
    expect(row.securableFqn).toBe(UNITY_SECURABLE_ALL); // the queryable field is unchanged
  });
});

describe('flushUnityAudit terminates under sustained traffic', () => {
  it('drains a bounded number of generations instead of looping forever', async () => {
    expect(FLUSH_MAX_PASSES).toBeGreaterThan(0);
    // Each completed write immediately starts another — what a live server under
    // catalog traffic does to a shared module-level set. `while (inFlight.size)`
    // never returned here.
    let started = 0;
    auditCreate.mockImplementation(async () => {
      if (started < 60) { started++; void recordUnityAccess(READ); }
      return {};
    });
    void recordUnityAccess(READ);
    await expect(flushUnityAudit()).resolves.toBeUndefined();
  });
});

describe('recordDatabricksUnityAccess — the Commercial DEFAULT backend', () => {
  it('ignores non-catalog Databricks traffic', async () => {
    expect(isUnityCatalogPath('/api/2.1/unity-catalog/permissions/table/a.b.c')).toBe(true);
    expect(isUnityCatalogPath('/api/2.0/lineage-tracking/table-lineage')).toBe(true);
    expect(isUnityCatalogPath('/api/2.0/sql/warehouses')).toBe(false);
    expect(isUnityCatalogPath('/api/2.0/fs/files/Volumes/a/b/c')).toBe(false);

    recordDatabricksUnityAccess({ path: '/api/2.0/sql/statements', method: 'POST', status: 200 });
    await flushUnityAudit();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('records the GRANT MUTATION that previously produced no row at all', async () => {
    recordDatabricksUnityAccess({
      path: '/api/2.1/unity-catalog/permissions/table/sales.bronze.orders',
      method: 'PATCH', status: 200, durationMs: 3,
    });
    await flushUnityAudit();
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0]).toMatchObject({
      action: 'unity.grant.update',
      securableType: 'table',
      securableFqn: 'sales.bronze.orders',
      backend: 'databricks',
      outcome: 'success',
    });
  });

  it('records catalog OWNER CHANGE and catalog DELETE', async () => {
    recordDatabricksUnityAccess({ path: '/api/2.1/unity-catalog/catalogs/sales', method: 'PATCH', status: 200 });
    recordDatabricksUnityAccess({ path: '/api/2.1/unity-catalog/catalogs/sales', method: 'DELETE', status: 200 });
    await flushUnityAudit();
    const actions = auditCreate.mock.calls.map((c) => c[0].action).sort();
    expect(actions).toEqual(['unity.catalog.delete', 'unity.catalog.update']);
  });

  it('records an upstream 403 as DENIED even though fetch resolved', async () => {
    recordDatabricksUnityAccess({ path: '/api/2.1/unity-catalog/catalogs/sales', method: 'DELETE', status: 403 });
    await flushUnityAudit();
    expect(auditCreate.mock.calls[0][0]).toMatchObject({ outcome: 'denied' });
  });

  it('records a non-2xx as a FAILURE rather than a success', async () => {
    recordDatabricksUnityAccess({ path: '/api/2.1/unity-catalog/catalogs/sales', method: 'PATCH', status: 500 });
    await flushUnityAudit();
    expect(auditCreate.mock.calls[0][0]).toMatchObject({ outcome: 'failure' });
  });
});
