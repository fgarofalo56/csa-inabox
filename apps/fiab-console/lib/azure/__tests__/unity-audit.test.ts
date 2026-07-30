/**
 * LU-3 — Unity Catalog / Loom Unity AUDIT CHOKE POINT contract test.
 *
 * The bug class this exists to catch: a catalog audit trail that looks complete
 * but silently drops the rows that matter. Specifically —
 *
 *   1. A DENIED call is not recorded (the emitter sat on the success path).
 *   2. A call that FAILS CLOSED before reaching the network is not recorded
 *      (the emitter sat after the fetch).
 *   3. The `denials` view does not actually filter, so it returns everything and
 *      an auditor concludes "no denials".
 *   4. A REST path is classified under the wrong securable, so an object's
 *      access history is filed somewhere nobody looks.
 *
 * Every assertion below is against a hand-written expectation, never against the
 * output of the same function that produced it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const auditCreate = vi.fn();
const emitAuditEvent = vi.fn();
const cosmosQuery = vi.fn();
const getToken = vi.fn();

vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() { return { token: 'fake-aad-token', expiresOnTimestamp: Date.now() + 3_600_000 }; }
  }
  return { DefaultAzureCredential: FakeCred, ManagedIdentityCredential: FakeCred, ChainedTokenCredential: FakeCred };
});

vi.mock('@/lib/azure/arm-credential', () => ({ uamiArmCredential: () => ({ getToken }) }));

vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: async () => ({
    items: {
      create: auditCreate,
      query: (spec: unknown) => ({ fetchAll: async () => cosmosQuery(spec) }),
    },
  }),
  // unity-catalog-client lazily reaches for this during federation resolution.
  metastoreRegistrationsContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  }),
}));

vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent }));

vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({
    claims: { oid: 'oid-alice', upn: 'alice@contoso.com', tid: 'tenant-1', name: 'Alice' },
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
}));

import {
  classifyUnityCall, unityOutcomeForError, unityAuditKql, flushUnityAudit,
  UNITY_AUDIT_ITEM_TYPE, UNITY_SECURABLE_ALL,
} from '../unity-audit';
import { listCatalogs, listTables } from '../unity-catalog-client';
import { OssUcAuthNotConfiguredError } from '../uc-backend';

const ENV = [
  'LOOM_UC_BACKEND', 'LOOM_UNITY_URL', 'LOOM_UNITY_TOKEN',
  'LOOM_UNITY_CLIENT_ID', 'LOOM_UNITY_AUDIENCE', 'LOOM_UNITY_AUTH_MODE',
  'LOOM_MSAL_CLIENT_ID', 'LOOM_DATABRICKS_HOSTNAME', 'LOOM_DATABRICKS_HOSTNAMES',
  'LOOM_CLOUD', 'AZURE_CLOUD',
];
function reset() {
  for (const k of ENV) delete process.env[k];
  auditCreate.mockReset();
  emitAuditEvent.mockReset();
  cosmosQuery.mockReset();
  getToken.mockReset();
  auditCreate.mockResolvedValue({});
  cosmosQuery.mockResolvedValue({ resources: [] });
}

function response(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('classifyUnityCall — the audit vocabulary', () => {
  it('maps collection reads to <securable>.list with the collection sentinel', () => {
    expect(classifyUnityCall('GET', '/api/2.1/unity-catalog/catalogs')).toEqual({
      operation: 'catalog.list', securableType: 'catalog', securableFqn: UNITY_SECURABLE_ALL,
    });
    // A query string must not leak into the securable name.
    expect(classifyUnityCall('GET', '/api/2.1/unity-catalog/schemas?catalog_name=sales')).toEqual({
      operation: 'schema.list', securableType: 'schema', securableFqn: UNITY_SECURABLE_ALL,
    });
  });

  it('maps a named object to <securable>.get with the three-level FQN', () => {
    expect(classifyUnityCall('GET', '/api/2.1/unity-catalog/tables/sales.bronze.orders')).toEqual({
      operation: 'table.get', securableType: 'table', securableFqn: 'sales.bronze.orders',
    });
  });

  it('maps mutations to create/update/delete', () => {
    expect(classifyUnityCall('POST', '/api/2.1/unity-catalog/catalogs').operation).toBe('catalog.create');
    expect(classifyUnityCall('PATCH', '/api/2.1/unity-catalog/catalogs/sales').operation).toBe('catalog.update');
    expect(classifyUnityCall('DELETE', '/api/2.1/unity-catalog/schemas/sales.bronze').operation).toBe('schema.delete');
  });

  it('reads the securable type out of the grants path, not the family segment', () => {
    // Filing a grant change under securableType 'permissions' would bury it.
    expect(classifyUnityCall('GET', '/api/2.1/unity-catalog/permissions/table/sales.bronze.orders')).toEqual({
      operation: 'grant.read', securableType: 'table', securableFqn: 'sales.bronze.orders',
    });
    expect(classifyUnityCall('PATCH', '/api/2.1/unity-catalog/permissions/catalog/sales')).toEqual({
      operation: 'grant.update', securableType: 'catalog', securableFqn: 'sales',
    });
    expect(classifyUnityCall('GET', '/api/2.1/unity-catalog/effective-permissions/schema/sales.bronze').operation)
      .toBe('effective-grant.read');
  });

  it('normalizes the Databricks/OSS storage-credential naming split to ONE securable type', () => {
    // Same governance object, two spellings — an auditor must see one family.
    expect(classifyUnityCall('GET', '/api/2.1/unity-catalog/storage-credentials/lake_mi').securableType).toBe('storage_credential');
    expect(classifyUnityCall('GET', '/api/2.1/unity-catalog/credentials/lake_mi').securableType).toBe('storage_credential');
  });

  it('records credential vending as a vend, not a create', () => {
    const c = classifyUnityCall('POST', '/api/2.1/unity-catalog/temporary-table-credentials');
    expect(c.operation).toBe('temporary-credential.vend');
    expect(c.securableType).toBe('temporary_credential');
  });

  it('handles the systemschemas sub-resource and lineage-tracking', () => {
    expect(classifyUnityCall('GET', '/api/2.1/unity-catalog/metastores/m-1/systemschemas')).toEqual({
      operation: 'system-schema.list', securableType: 'metastore', securableFqn: 'm-1',
    });
    expect(classifyUnityCall('PUT', '/api/2.1/unity-catalog/metastores/m-1/systemschemas/access').operation)
      .toBe('system-schema.enable');
    expect(classifyUnityCall('POST', '/api/2.0/lineage-tracking/table-lineage').operation).toBe('lineage.table.read');
  });

  it('never drops an un-modelled path — it records it as unity.request', () => {
    const c = classifyUnityCall('GET', '/api/2.9/something-new/xyz');
    expect(c.operation).toBe('unity.request');
    expect(c.securableFqn).toBe('/api/2.9/something-new/xyz');
  });
});

describe('unityOutcomeForError — denials stay separable from failures', () => {
  it('classifies an authorization rejection as denied', () => {
    expect(unityOutcomeForError(new Error('nope'), 403)).toBe('denied');
    expect(unityOutcomeForError(new Error('nope'), 401)).toBe('denied');
    expect(unityOutcomeForError({ name: 'X', status: 403 })).toBe('denied');
  });

  it('classifies the fail-closed local refusal as denied', () => {
    const e = new OssUcAuthNotConfiguredError({
      missingEnvVar: 'LOOM_UNITY_CLIENT_ID', bicepModule: 'm', bicepStatus: 's', followUp: 'f',
    });
    expect(unityOutcomeForError(e)).toBe('denied');
  });

  it('does NOT widen denied to cover honest gates or transport errors', () => {
    // A 501 "Databricks-only family" gate is not somebody being told no.
    expect(unityOutcomeForError({ name: 'UnityCatalogError', status: 501 })).toBe('failure');
    expect(unityOutcomeForError({ name: 'UnityCatalogError', status: 404 })).toBe('failure');
    expect(unityOutcomeForError(new Error('fetch timed out'))).toBe('failure');
  });
});

describe('the choke point audits EVERY call', () => {
  beforeEach(reset);
  afterEach(() => { reset(); vi.unstubAllGlobals(); });

  async function lastAuditRow() {
    await flushUnityAudit();
    expect(auditCreate).toHaveBeenCalledTimes(1);
    return auditCreate.mock.calls[0][0] as Record<string, unknown>;
  }

  it('records a successful catalog read with who / what / when / outcome', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, { catalogs: [] })));

    await listCatalogs('ignored-host');

    const row = await lastAuditRow();
    expect(row.itemType).toBe(UNITY_AUDIT_ITEM_TYPE);
    expect(row.action).toBe('unity.catalog.list');
    expect(row.operation).toBe('catalog.list');
    expect(row.securableType).toBe('catalog');
    expect(row.outcome).toBe('success');
    expect(row.status).toBe(200);
    expect(row.backend).toBe('oss');
    expect(row.actorOid).toBe('oid-alice');
    expect(row.upn).toBe('alice@contoso.com');
    expect(row.tenantId).toBe('tenant-1');
    expect(typeof row.at).toBe('string');
    expect(emitAuditEvent).toHaveBeenCalledTimes(1);
    expect(emitAuditEvent.mock.calls[0][0]).toMatchObject({
      action: 'unity.catalog.list', outcome: 'success', targetType: 'unity:catalog', actorOid: 'oid-alice',
    });
  });

  it('records a 403 as DENIED — the row an auditor is actually hunting for', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(403, { message: 'PERMISSION_DENIED' })));

    await expect(listTables('ignored-host', 'sales', 'bronze')).rejects.toThrow();

    const row = await lastAuditRow();
    expect(row.outcome).toBe('denied');
    expect(row.status).toBe(403);
    expect(row.operation).toBe('table.list');
    expect(row.actorOid).toBe('oid-alice');
    expect(String(row.detail)).toMatch(/PERMISSION_DENIED/);
    expect(emitAuditEvent.mock.calls[0][0]).toMatchObject({ outcome: 'denied' });
  });

  it('records a call that FAILS CLOSED before the network — no fetch, still audited', async () => {
    // LU-2 refuses to call the catalog when it cannot mint a credential. An
    // emitter placed after the fetch would lose this event entirely.
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    process.env.LOOM_UNITY_CLIENT_ID = 'unity-app-id';
    getToken.mockRejectedValue(new Error('no token'));
    const fetchMock = vi.fn().mockResolvedValue(response(200, { catalogs: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listCatalogs('ignored-host')).rejects.toBeInstanceOf(OssUcAuthNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();

    const row = await lastAuditRow();
    expect(row.outcome).toBe('denied');
    expect(row.status).toBe(0);
    expect(row.operation).toBe('catalog.list');
  });

  it('records the 501 honest gate as a failure, not a denial', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // Delta Sharing is a Databricks-only family — gated before the network hop.
    const { listShares } = await import('../unity-catalog-client');
    await expect(listShares('ignored-host')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();

    const row = await lastAuditRow();
    expect(row.outcome).toBe('failure');
    expect(row.operation).toBe('share.list');
  });

  it('attributes a call with no request scope to the system principal, not a stale user', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, { catalogs: [] })));
    const session = await import('@/lib/auth/session');
    const spy = vi.spyOn(session, 'getSession').mockImplementation(() => {
      throw new Error('cookies() outside a request scope');
    });

    await listCatalogs('ignored-host');

    const row = await lastAuditRow();
    expect(row.actorOid).toBe('system');
    expect(row.upn).toBe('system');
    spy.mockRestore();
  });

  it('never lets an audit-store outage break a working catalog read', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    auditCreate.mockRejectedValue(new Error('Cosmos 429'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, { catalogs: [{ name: 'sales' }] })));

    const catalogs = await listCatalogs('ignored-host');
    await flushUnityAudit();
    expect(catalogs.map((c) => c.name)).toEqual(['sales']);
  });
});

describe('unityAuditKql — the SIEM half of the trail', () => {
  it('builds SIEM KQL scoped to unity events with a clamped, integer window', () => {
    const kql = unityAuditKql({ sinceHours: 24, deniedOnly: true, limit: 10 });
    expect(kql).toContain('LoomAudit_CL');
    expect(kql).toContain('ago(24h)');
    expect(kql).toContain('Action startswith "unity."');
    expect(kql).toContain('Outcome == "denied"');
    expect(kql).toContain('take 10');
    // A non-numeric / injected window cannot reach the query text.
    expect(unityAuditKql({ sinceHours: Number('7); drop') })).toContain('ago(168h)');
    expect(unityAuditKql({ sinceHours: 1e9 })).toContain('ago(2160h)');
  });
});
