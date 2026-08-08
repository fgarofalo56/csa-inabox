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
//
// Models BOTH upstream hops (F1): the token EXCHANGE that turns the Console's
// Entra token into a server-minted internal token, and the catalog call that
// carries it. Modelling only the second hop is what let the 403 ship — these
// tests used to assert `Bearer tok-for-api://…/.default`, i.e. the raw Entra
// token straight from the credential double, which the live catalog rejects.
const calls: Array<{ url: string; init: any }> = [];      // catalog RESOURCE hops
const handshakes: Array<{ url: string; init: any }> = []; // /v1/config hops
const allCalls: Array<{ url: string; init: any }> = [];   // every hop
const INTERNAL_TOKEN = 'internal-minted-token';
/**
 * What this catalog answers `/v1/config` with. Copied VERBATIM from a live
 * measurement against the real `apps/loom-unity` image:
 *   {"defaults":{},"overrides":{"prefix":"catalogs/loom"},"endpoints":[
 *     "GET /v1/{prefix}/namespaces", "GET /v1/{prefix}/namespaces/{namespace}", …]}
 * The `{prefix}` in upstream's own endpoint list is the point: every resource
 * route on this server lives under it, and a client that ignores it addresses
 * paths that do not exist.
 */
const IRC_PREFIX = 'catalogs/loom';
/** Status the double answers the `/v1/config` handshake with (403 test only). */
let configStatus = 200;
let nextResponse: () => Response = () => new Response('{}', { status: 200 });
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: async (url: string, init: any) => {
    allCalls.push({ url, init });
    if (String(url).includes('/api/1.0/unity-control/auth/tokens')) {
      return new Response(JSON.stringify({ access_token: INTERNAL_TOKEN }), { status: 200 });
    }
    if (String(url).includes('/v1/config')) {
      handshakes.push({ url, init });
      if (configStatus !== 200) {
        return new Response(
          JSON.stringify({ error: { message: 'catalog refused the handshake', type: 'Forbidden' } }),
          { status: configStatus },
        );
      }
      return new Response(JSON.stringify({ defaults: {}, overrides: { prefix: IRC_PREFIX } }), { status: 200 });
    }
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
  ircPathWithPrefix,
  ircUrl,
  isListNamespacesDefect,
  listNamespaceGrants,
  listNamespacesResolved,
  listTables,
  loadTable,
  logIcebergAccess,
  namespaceToDotted,
  registerTable,
  resetIcebergPrefixCache,
  resolveIrcPrefix,
} from '../iceberg-catalog-client';
import { resetUcTokenExchangeCache } from '../uc-token-exchange';

const SEP = String.fromCharCode(0x1f);
const BASE = 'https://iceberg-catalog.internal.example.net';

beforeEach(() => {
  calls.length = 0;
  handshakes.length = 0;
  allCalls.length = 0;
  // Process-wide minted-token cache: without this a later test reuses the
  // token an earlier one minted and never fires the exchange it asserts on.
  resetUcTokenExchangeCache();
  // Same reasoning for the memoized IRC prefix — a cached handshake would make
  // the "resolves the prefix" assertions vacuous in every test after the first.
  resetIcebergPrefixCache();
  configStatus = 200;
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
  it('acquires a REAL token for the deployment app audience, then EXCHANGES it', async () => {
    const h = await icebergAuthHeader();
    expect(getTokenMock).toHaveBeenCalledWith('api://app-client-id/.default');
    // The internal token, not the Entra one. The catalog's AuthDecorator rejects
    // any bearer whose `iss` is not its own `internal` issuer — measured live as
    // HTTP 403 in ~307ms, warm and reproducible, before this exchange existed.
    expect(h.authorization).toBe(`Bearer ${INTERNAL_TOKEN}`);
    expect(h.authorization).not.toContain('tok-for-');
  });

  it('exchanges at THIS catalog, not at LOOM_UNITY_URL', async () => {
    // Separate Container Apps, separate databases, separate minted-token state:
    // a token minted by loom-unity is not honoured by iceberg-catalog.
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal.example.net';
    await icebergAuthHeader();
    const exchange = allCalls.find((c) => String(c.url).includes('/auth/tokens'));
    expect(exchange).toBeDefined();
    expect(exchange!.url).toBe(`${icebergCatalogBase()}/api/1.0/unity-control/auth/tokens`);
    delete process.env.LOOM_UNITY_URL;
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
    await getCatalogConfig();
    // The handshake IS a catalog call; the double routes it to `handshakes`.
    expect(handshakes).toHaveLength(1);
    expect(handshakes[0].url).toContain('/v1/config?warehouse=loom');
    expect(handshakes[0].init.headers.authorization).toBe(`Bearer ${INTERNAL_TOKEN}`);
  });
});

describe('typed operations + error mapping', () => {
  it('lists tables against the encoded namespace path, UNDER the server prefix', async () => {
    nextResponse = () => new Response(
      JSON.stringify({ identifiers: [{ namespace: ['gold', 'sales'], name: 'orders' }] }),
      { status: 200 },
    );
    const r = await listTables('gold.sales');
    // The prefix is resolved from the handshake, then applied — this is the fix.
    expect(handshakes).toHaveLength(1);
    expect(calls[0].url).toContain(
      `/v1/catalogs/loom/namespaces/${encodeURIComponent(`gold${SEP}sales`)}/tables`,
    );
    expect(calls[0].url).not.toContain('/iceberg/v1/namespaces/');
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

describe('IRC prefix (Iceberg REST spec) — the routes this server actually has', () => {
  // MEASURED in Docker against the real apps/loom-unity image, and against the
  // BARE upstream unitycatalog/unitycatalog:v0.5.0 as the control:
  //   GET <irc>/v1/config?warehouse=loom -> 200 {"overrides":{"prefix":"catalogs/loom"}}
  //   GET <irc>/v1/namespaces            -> 500 (Loom image) / 404 (bare v0.5.0)
  //   GET <irc>/v1/catalogs/loom/namespaces/default/tables -> 200
  // Upstream's routes are @Get("/v1/catalogs/{catalog}/namespaces/…"); there is
  // no /v1/namespaces route at all. The client used to call the latter.

  it('inserts the prefix between /v1 and the resource, and leaves other paths alone', () => {
    expect(ircPathWithPrefix('/v1/namespaces', 'catalogs/loom')).toBe('/v1/catalogs/loom/namespaces');
    expect(ircPathWithPrefix('/v1/namespaces/gold/tables', 'catalogs/loom'))
      .toBe('/v1/catalogs/loom/namespaces/gold/tables');
    // Slashes on either side of the server's value are normalized away.
    expect(ircPathWithPrefix('/v1/namespaces', '/catalogs/loom/')).toBe('/v1/catalogs/loom/namespaces');
    // A server that declares no prefix (a plain Polaris-shaped catalog) is legal.
    expect(ircPathWithPrefix('/v1/namespaces', '')).toBe('/v1/namespaces');
    // Only /v1/* resources are prefixed.
    expect(ircPathWithPrefix('/api/2.1/x', 'catalogs/loom')).toBe('/api/2.1/x');
  });

  it('resolves the prefix from the handshake and memoizes it', async () => {
    expect(await resolveIrcPrefix()).toBe(IRC_PREFIX);
    expect(await resolveIrcPrefix()).toBe(IRC_PREFIX);
    expect(handshakes).toHaveLength(1);
  });

  it('the handshake itself is NEVER prefixed (it is what produces the prefix)', async () => {
    await getCatalogConfig();
    expect(handshakes).toHaveLength(1);
    expect(handshakes[0].url).toBe(`${BASE}/api/2.1/unity-catalog/iceberg/v1/config?warehouse=loom`);
  });

  it('DROPS the memoized prefix on 404/500 so the next call re-handshakes (self-heal)', async () => {
    // auto-bind-by-default.md §3: a stale binding is repaired automatically. A
    // catalog re-provisioned onto a different warehouse must not wedge the
    // client on a path that no longer exists.
    nextResponse = () => new Response('{}', { status: 404 });
    await expect(listTables('gold')).rejects.toThrow(IcebergCatalogError);
    nextResponse = () => new Response(JSON.stringify({ identifiers: [] }), { status: 200 });
    await listTables('gold');
    expect(handshakes).toHaveLength(2);
  });

  it('a FAILED handshake surfaces its own status — it never guesses a prefix', async () => {
    // R7: reporting "the catalog refused the handshake (403)" is TRUE. Inventing
    // `catalogs/<warehouse>` and then reporting the unrelated 500 that path
    // produces is what pointed the live investigation at the wrong problem.
    configStatus = 403;
    await expect(resolveIrcPrefix()).rejects.toMatchObject({ status: 403 });
    // And a resource call fails the same way rather than silently un-prefixed.
    await expect(listTables('gold')).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(0);
  });
});

describe('LIST-namespaces: the measured upstream defect and its disclosed fallback', () => {
  const DEFECT = 'Authorization filter not initialized — ensure the request goes through UnityAccessDecorator.';

  it('recognizes ONLY the exact upstream signature', () => {
    expect(isListNamespacesDefect(new IcebergCatalogError(DEFECT, 500))).toBe(true);
    expect(isListNamespacesDefect(new IcebergCatalogError('database is on fire', 500))).toBe(false);
    expect(isListNamespacesDefect(new IcebergCatalogError(DEFECT, 503))).toBe(false);
    expect(isListNamespacesDefect(new Error(DEFECT))).toBe(false);
  });

  it('falls back to the Unity schemas API on the SAME server, and says so', async () => {
    nextResponse = () => {
      const url = calls.at(-1)!.url;
      if (url.includes('/api/2.1/unity-catalog/schemas')) {
        return new Response(JSON.stringify({ schemas: [{ name: 'default' }, { name: 'gold' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: DEFECT, type: 'BaseException' } }), { status: 500 });
    };
    const r = await listNamespacesResolved();
    expect(r.via).toBe('unity-schemas');
    expect(r.namespaces).toEqual([['default'], ['gold']]);
    expect(calls[0].url).toContain('/v1/catalogs/loom/namespaces');
    expect(calls.at(-1)!.url).toContain('/api/2.1/unity-catalog/schemas?catalog_name=loom');
  });

  it('reports via:irc when the native route works (the fallback is not the default)', async () => {
    nextResponse = () => new Response(JSON.stringify({ namespaces: [['gold']] }), { status: 200 });
    const r = await listNamespacesResolved();
    expect(r.via).toBe('irc');
    expect(r.namespaces).toEqual([['gold']]);
  });

  it('propagates any OTHER failure untouched — no broad 500 catch', async () => {
    nextResponse = () => new Response(
      JSON.stringify({ error: { message: 'database is on fire', type: 'BaseException' } }),
      { status: 500 },
    );
    await expect(listNamespacesResolved()).rejects.toMatchObject({ status: 500, message: 'database is on fire' });
  });
});

describe('grant mapping', () => {  it('reads the Unity Catalog schema permissions off the same server', async () => {
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
