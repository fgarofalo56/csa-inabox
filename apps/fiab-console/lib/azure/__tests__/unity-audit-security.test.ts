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
  recordUnityAccess, recordDatabricksUnityAccess, listUnityAccessRecords,
  readUnitySystemTable, flushUnityAudit, isUnityMutation, isUnityCatalogPath,
  unityAuditPartitionKey, FLUSH_MAX_PASSES, UNITY_SECURABLE_ALL,
  type UnityAuditRecord,
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

describe('the pane must be able to read what the recorder wrote', () => {
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

describe('filters must not silently under-report', () => {
  it('pushes actor / operation / securable INTO the Cosmos query', async () => {
    await listUnityAccessRecords({ actor: 'Alice', operation: 'Grant', securable: 'Sales', limit: 5 });
    const spec = cosmosQuery.mock.calls[0][0];
    expect(spec.query).toContain('CONTAINS(LOWER(c.operation), @operation)');
    expect(spec.query).toContain('CONTAINS(LOWER(c.securableFqn), @securable)');
    expect(spec.query).toContain('CONTAINS(LOWER(c.actorUpn), @actor)');
    const byName = Object.fromEntries(
      (spec.parameters as Array<{ name: string; value: unknown }>).map((p) => [p.name, p.value]),
    );
    // Bound parameters, never concatenated into the query text; case-folded so
    // the pane's free-text box matches regardless of casing.
    expect(byName['@actor']).toBe('alice');
    expect(byName['@operation']).toBe('grant');
    expect(byName['@securable']).toBe('sales');
  });

  it('does NOT drop rows in JS after the TOP-N page', async () => {
    // If the filter were still applied post-query, this row (which does not
    // match `actor=zoe`) would be filtered out here and the caller would see 0.
    // Pushing the predicate down means the reader returns whatever Cosmos
    // matched — the query is the filter.
    const row: UnityAuditRecord = {
      id: '1', at: new Date().toISOString(), actorOid: 'oid-zoe', actorUpn: 'zoe@contoso.com',
      operation: 'grant.update', securableType: 'table', securableFqn: 'sales.bronze.orders',
      backend: 'oss', method: 'PATCH', path: '/p', outcome: 'denied', status: 403, durationMs: 2,
    };
    cosmosQuery.mockResolvedValue({ resources: [row] });
    const rows = await listUnityAccessRecords({ actor: 'zoe' });
    expect(rows).toHaveLength(1);
  });

  it('marks a TOP-N truncated summary as truncated instead of claiming window totals', async () => {
    const rows: UnityAuditRecord[] = Array.from({ length: 3 }, (_, i) => ({
      id: String(i), at: new Date().toISOString(), actorOid: 'a', actorUpn: 'a@x',
      operation: 'catalog.list', securableType: 'catalog', securableFqn: '*',
      backend: 'oss', method: 'GET', path: '/p', outcome: 'success', status: 200, durationMs: 1,
    }));
    cosmosQuery.mockResolvedValue({ resources: rows });
    const res = await readUnitySystemTable('summary', { limit: 3 });
    // "2 denials in the last 7 days" is a different claim from "2 denials in the
    // last 3 calls". The pane must not be able to state the first when it means
    // the second.
    expect(res.truncated).toBe(true);
    expect(res.limit).toBe(3);
    expect(res.rows[0].scope).toBe('most recent 3 calls');

    cosmosQuery.mockResolvedValue({ resources: rows.slice(0, 2) });
    const res2 = await readUnitySystemTable('summary', { limit: 3 });
    expect(res2.truncated).toBe(false);
    expect(res2.rows[0].scope).toBe('window');
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
