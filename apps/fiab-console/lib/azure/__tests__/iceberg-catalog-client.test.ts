/**
 * N1 — Iceberg REST Catalog client: gate, URL/namespace encoding, Entra auth
 * INJECTION on the upstream hop, error mapping, and the audited data-access row.
 *
 * These are the security-load-bearing behaviours: an unwired catalog must gate
 * honestly (never 500), a namespace must be spec-encoded and validated (never
 * pass raw user input into a URL path), the upstream hop must carry a real
 * bearer, and every operation must leave an audit row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Cosmos + audit-stream doubles (the audit sink) ──────────────────────────
const created: any[] = [];
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: async () => ({
    items: { create: async (doc: any) => { created.push(doc); return { resource: doc }; } },
  }),
}));
const emitted: any[] = [];
vi.mock('@/lib/admin/audit-stream', () => ({
  emitAuditEvent: (ev: any) => { emitted.push(ev); },
}));

// ── Credential double: a real token acquisition the client must use ─────────
const getTokenMock = vi.fn(async (scope: string) => ({
  token: `tok-for-${scope}`,
  expiresOnTimestamp: Date.now() + 3600_000,
}));
vi.mock('@/lib/azure/arm-credential', () => ({
  uamiArmCredential: () => ({ getToken: (s: string) => getTokenMock(s) }),
}));

// ── fetch double ───────────────────────────────────────────────────────────
const calls: Array<{ url: string; init: any }> = [];
let nextResponse: () => Response = () => new Response('{}', { status: 200 });
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: async (url: string, init: any) => {
    calls.push({ url, init });
    return nextResponse();
  },
}));

import {
  IcebergCatalogError,
  assertTableName,
  encodeNamespace,
  getCatalogConfig,
  icebergAuthHeader,
  icebergCatalogBase,
  icebergCatalogConfigGate,
  icebergWarehouse,
  ircUrl,
  listNamespaceGrants,
  listTables,
  loadTable,
  logIcebergAccess,
  namespaceToDotted,
  registerTable,
} from '../iceberg-catalog-client';

const SEP = String.fromCharCode(0x1f);
const BASE = 'https://iceberg-catalog.internal.example.net';

beforeEach(() => {
  calls.length = 0;
  created.length = 0;
  emitted.length = 0;
  getTokenMock.mockClear();
  nextResponse = () => new Response('{}', { status: 200 });
  process.env.LOOM_ICEBERG_CATALOG_URL = BASE;
  delete process.env.LOOM_ICEBERG_CATALOG_PREFIX;
  delete process.env.LOOM_ICEBERG_CATALOG_WAREHOUSE;
  delete process.env.LOOM_ICEBERG_CATALOG_TOKEN;
  delete process.env.LOOM_ICEBERG_CATALOG_AUDIENCE;
  process.env.LOOM_MSAL_CLIENT_ID = 'app-client-id';
});

afterEach(() => {
  delete process.env.LOOM_ICEBERG_CATALOG_URL;
  delete process.env.LOOM_ICEBERG_CATALOG_TOKEN;
  delete process.env.LOOM_ICEBERG_CATALOG_AUDIENCE;
  delete process.env.LOOM_MSAL_CLIENT_ID;
});

describe('honest gate', () => {
  it('reports the exact missing var when the catalog is not deployed', () => {
    delete process.env.LOOM_ICEBERG_CATALOG_URL;
    expect(icebergCatalogConfigGate()).toEqual({ missing: 'LOOM_ICEBERG_CATALOG_URL' });
    expect(() => icebergCatalogBase()).toThrow(IcebergCatalogError);
    try {
      icebergCatalogBase();
    } catch (e) {
      const err = e as IcebergCatalogError;
      expect(err.status).toBe(503);
      expect(err.code).toBe('not_configured');
      // Honest: names the env var AND the bicep module, and states the fallback.
      expect(err.message).toContain('LOOM_ICEBERG_CATALOG_URL');
      expect(err.message).toContain('iceberg-catalog-aca.bicep');
      expect(err.message).toContain('No Microsoft Fabric required');
    }
  });

  it('is satisfied (null) once the URL is set, and normalizes trailing slashes', () => {
    process.env.LOOM_ICEBERG_CATALOG_URL = `${BASE}///`;
    expect(icebergCatalogConfigGate()).toBeNull();
    expect(icebergCatalogBase()).toBe(BASE);
  });
});

describe('namespace + table encoding (Iceberg REST spec)', () => {
  it('joins multi-level namespaces with the U+001F unit separator, percent-encoded', () => {
    expect(encodeNamespace('gold')).toBe('gold');
    expect(encodeNamespace('gold.sales')).toBe(encodeURIComponent(`gold${SEP}sales`));
    expect(encodeNamespace(['gold', 'sales'])).toBe(encodeURIComponent(`gold${SEP}sales`));
    expect(encodeNamespace('gold.sales')).toContain('%1F');
  });

  it('round-trips back to the human dotted form', () => {
    expect(namespaceToDotted(['gold', 'sales'])).toBe('gold.sales');
    expect(namespaceToDotted(`gold${SEP}sales`)).toBe('gold.sales');
  });

  it('REJECTS traversal / injection instead of forwarding it upstream', () => {
    for (const bad of ['', '   ', '../etc', 'gold/../silver', 'gold sales', 'a?b=c', '%2e%2e']) {
      expect(() => encodeNamespace(bad), bad).toThrow(IcebergCatalogError);
    }
    for (const bad of ['', 'orders/../x', 'orders table', 'orders?x']) {
      expect(() => assertTableName(bad), bad).toThrow(IcebergCatalogError);
    }
    expect(assertTableName('orders_2024')).toBe('orders_2024');
  });

  it('builds URLs under the configured prefix, with encoded query values', () => {
    expect(ircUrl('/v1/config', { warehouse: 'loom' }))
      .toBe(`${BASE}/api/2.1/unity-catalog/iceberg/v1/config?warehouse=loom`);
    // Empty/undefined query values are dropped, not sent as `k=`.
    expect(ircUrl('/v1/namespaces', { parent: '' })).toBe(`${BASE}/api/2.1/unity-catalog/iceberg/v1/namespaces`);
    process.env.LOOM_ICEBERG_CATALOG_PREFIX = 'catalog/';
    expect(ircUrl('/v1/config')).toBe(`${BASE}/catalog/v1/config`);
  });

  it('defaults the warehouse to "loom" and honours the override', () => {
    expect(icebergWarehouse()).toBe('loom');
    process.env.LOOM_ICEBERG_CATALOG_WAREHOUSE = 'estate';
    expect(icebergWarehouse()).toBe('estate');
  });
});

describe('Entra auth injection on the upstream hop', () => {
  it('acquires a REAL token for the deployment app audience', async () => {
    const h = await icebergAuthHeader();
    expect(getTokenMock).toHaveBeenCalledWith('api://app-client-id/.default');
    expect(h.authorization).toBe('Bearer tok-for-api://app-client-id/.default');
  });

  it('honours an explicit audience override', async () => {
    process.env.LOOM_ICEBERG_CATALOG_AUDIENCE = 'api://catalog/.default';
    await icebergAuthHeader();
    expect(getTokenMock).toHaveBeenCalledWith('api://catalog/.default');
  });

  it('prefers a pre-shared bearer (Key Vault secretRef) over token acquisition', async () => {
    process.env.LOOM_ICEBERG_CATALOG_TOKEN = 'static-secret';
    expect(await icebergAuthHeader()).toEqual({ authorization: 'Bearer static-secret' });
    expect(getTokenMock).not.toHaveBeenCalled();
  });

  it('degrades to no header (VNet perimeter) rather than throwing when no audience exists', async () => {
    delete process.env.LOOM_MSAL_CLIENT_ID;
    expect(await icebergAuthHeader()).toEqual({});
  });

  it('sends the injected bearer on an actual catalog call', async () => {
    nextResponse = () => new Response(JSON.stringify({ defaults: {} }), { status: 200 });
    await getCatalogConfig();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/v1/config?warehouse=loom');
    expect(calls[0].init.headers.authorization).toBe('Bearer tok-for-api://app-client-id/.default');
  });
});

describe('typed operations + error mapping', () => {
  it('lists tables against the encoded namespace path', async () => {
    nextResponse = () => new Response(
      JSON.stringify({ identifiers: [{ namespace: ['gold', 'sales'], name: 'orders' }] }),
      { status: 200 },
    );
    const r = await listTables('gold.sales');
    expect(calls[0].url).toContain(`/v1/namespaces/${encodeURIComponent(`gold${SEP}sales`)}/tables`);
    expect(r.identifiers[0].name).toBe('orders');
  });

  it('loads a table and returns the REAL metadata-location', async () => {
    nextResponse = () => new Response(
      JSON.stringify({ 'metadata-location': 'abfss://gold@a.dfs.core.windows.net/Tables/orders/metadata/v3.metadata.json' }),
      { status: 200 },
    );
    const r = await loadTable('gold', 'orders');
    expect(r['metadata-location']).toContain('/metadata/v3.metadata.json');
  });

  it('registers a table by POSTing the metadata-location pointer (zero copy)', async () => {
    nextResponse = () => new Response(JSON.stringify({ 'metadata-location': 'abfss://x/metadata' }), { status: 200 });
    await registerTable('gold', 'orders', 'abfss://gold@a.dfs.core.windows.net/Tables/orders/metadata');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body)).toEqual({
      name: 'orders',
      'metadata-location': 'abfss://gold@a.dfs.core.windows.net/Tables/orders/metadata',
    });
  });

  it('rejects a non-absolute metadata location before any network call', async () => {
    await expect(registerTable('gold', 'orders', 'Tables/orders/metadata')).rejects.toThrow(IcebergCatalogError);
    expect(calls).toHaveLength(0);
  });

  it('preserves the upstream status + message (a 404 stays a 404)', async () => {
    nextResponse = () => new Response(
      JSON.stringify({ error: { message: 'Namespace does not exist: gold', type: 'NoSuchNamespaceException' } }),
      { status: 404 },
    );
    await expect(listTables('gold')).rejects.toMatchObject({
      status: 404,
      code: 'NoSuchNamespaceException',
      message: 'Namespace does not exist: gold',
    });
  });
});

describe('grant mapping', () => {
  it('reads the Unity Catalog schema permissions off the same server', async () => {
    nextResponse = () => new Response(
      JSON.stringify({ privilege_assignments: [{ principal: 'analysts', privileges: ['SELECT'] }] }),
      { status: 200 },
    );
    const g = await listNamespaceGrants('gold');
    expect(calls[0].url).toBe(`${BASE}/api/2.1/unity-catalog/permissions/schema/${encodeURIComponent('loom.gold')}`);
    expect(g.supported).toBe(true);
    expect(g.assignments).toEqual([{ principal: 'analysts', privileges: ['SELECT'] }]);
  });

  it('reports supported:false with a REASON when the server has no ACL API', async () => {
    nextResponse = () => new Response('', { status: 501 });
    const g = await listNamespaceGrants('gold');
    expect(g.supported).toBe(false);
    expect(g.note).toContain('501');
    expect(g.note).toContain('audit trail');
  });
});

describe('audited data-plane access log', () => {
  const ev = {
    actorOid: 'oid-1',
    actorUpn: 'analyst@contoso.com',
    tenantId: 'tid-1',
    operation: 'table.load' as const,
    namespace: 'gold.sales',
    table: 'orders',
    workspaceId: 'ws-9',
    outcome: 'success' as const,
  };

  it('writes an _auditLog row carrying principal, scope, operation and time', async () => {
    await logIcebergAccess(ev);
    expect(created).toHaveLength(1);
    const row = created[0];
    expect(row.itemType).toBe('iceberg-catalog');
    expect(row.action).toBe('iceberg.table.load');
    expect(row.itemId).toBe('gold.sales.orders');
    expect(row.namespace).toBe('gold.sales');
    expect(row.table).toBe('orders');
    expect(row.workspaceId).toBe('ws-9');
    expect(row.warehouse).toBe('loom');
    expect(row.upn).toBe('analyst@contoso.com');
    expect(row.actorOid).toBe('oid-1');
    expect(row.tenantId).toBe('tid-1');
    expect(row.outcome).toBe('success');
    expect(typeof row.at).toBe('string');
  });

  it('aggregates a high-volume LIST read into ONE row carrying resultCount', async () => {
    await logIcebergAccess({ ...ev, operation: 'table.list', table: undefined, resultCount: 412 });
    expect(created).toHaveLength(1);
    expect(created[0].resultCount).toBe(412);
    expect(created[0].summary).toContain('412 identifier(s)');
  });

  it('records a FAILURE with its detail (a denied read still leaves evidence)', async () => {
    await logIcebergAccess({ ...ev, outcome: 'failure', detail: 'permission denied' });
    expect(created[0].outcome).toBe('failure');
    expect(created[0].summary).toContain('FAILED: permission denied');
  });

  it('fans the event out to the SIEM / webhook audit stream', async () => {
    await logIcebergAccess(ev);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      actorOid: 'oid-1', action: 'iceberg.table.load', targetType: 'iceberg-catalog',
      targetId: 'gold.sales.orders', outcome: 'success', tenantId: 'tid-1',
    });
  });
});
