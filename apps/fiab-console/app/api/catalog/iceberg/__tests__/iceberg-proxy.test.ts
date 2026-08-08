/**
 * N1 — BFF contract tests for the Iceberg REST Catalog proxy.
 *
 * Pins the three things that make the proxy safe to be the ONLY public door to
 * the internal catalog container:
 *   1. AUTH — anonymous callers 401 BEFORE the config gate is evaluated (an
 *      unauthenticated probe must never learn the deployment's config state),
 *      and a read-only API token cannot mutate.
 *   2. AUTH INJECTION — the upstream hop carries the Entra bearer the client
 *      minted; the caller's own credential is never forwarded.
 *   3. AUDIT — every read/write leaves a data-access row, LIST reads aggregated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── session double: cookie session by default, PAT variants per-test ────────
let sessionValue: any = {
  claims: { oid: 'oid-1', upn: 'analyst@contoso.com', tid: 'tid-1' },
  exp: Date.now() / 1000 + 3600,
};
vi.mock('@/lib/auth/session', () => ({ getSession: () => sessionValue }));
vi.mock('@/lib/auth/pat', () => ({
  resolvePat: async () => null,
  scopeAllowsMethod: (scope: string, method: string) =>
    scope === 'read-only' ? ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) : true,
  patCanAdmin: () => false,
}));

// ── audit sink ─────────────────────────────────────────────────────────────
const auditRows: any[] = [];
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: async () => ({
    items: { create: async (doc: any) => { auditRows.push(doc); return { resource: doc }; } },
  }),
}));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: () => {} }));

// ── credential double ──────────────────────────────────────────────────────
vi.mock('@/lib/azure/arm-credential', () => ({
  uamiArmCredential: () => ({
    getToken: async (scope: string) => ({ token: `tok-${scope}`, expiresOnTimestamp: Date.now() + 3600_000 }),
  }),
}));

// ── upstream fetch double ──────────────────────────────────────────────────
//
// TWO upstream hops are modelled, because the real catalog needs both (F1):
//
//   1. POST /api/1.0/unity-control/auth/tokens — exchange the Console's Entra
//      token for a SERVER-MINTED internal token.
//   2. the actual /api/2.1/unity-catalog/iceberg/… call, carrying that internal
//      token.
//
// Modelling only hop 2 is what let the original bug ship. This file's
// "sends the server-minted bearer upstream" test asserted
// `Bearer tok-api://app-client-id/.default` — the RAW Entra token straight from
// the credential double — so it passed against code that never exchanged at all,
// while the live catalog answered every such call 403. The fixture modelled the
// CODE, not the server. It now models the server.
const upstreamAll: Array<{ url: string; init: any }> = [];
/**
 * Catalog RESOURCE hops only — the token exchange and the `/v1/config`
 * handshake are infrastructure, not the assertion target.
 *
 * `/v1/config` is excluded for the same reason the exchange is: it is a
 * MANDATORY prelude to every resource call, not the call under test. The
 * Iceberg REST spec makes the server's `prefix` override (returned by config)
 * part of every subsequent path, and this catalog's routes are
 * `/v1/catalogs/{catalog}/…` — so a client that skips the handshake addresses
 * routes that do not exist. That is exactly what shipped: the live console's
 * `GET /api/catalog/iceberg/namespaces` hit `/v1/namespaces`, which no route
 * matches, and died 500 inside `UnityAccessDecorator` (bound as a route
 * decorator over the whole `/api/2.1/unity-catalog/` prefix, so an unmatched
 * path still enters it). Measured in Docker against the real image.
 */
const upstream: Array<{ url: string; init: any }> = [];
/** The handshake hops, so tests can assert the prefix WAS resolved. */
const handshakes: Array<{ url: string; init: any }> = [];
const INTERNAL_TOKEN = 'internal-minted-token';
/** What the catalog answers `/v1/config` with — this server's real shape. */
const IRC_PREFIX = 'catalogs/loom';
let respond: () => Response = () => new Response('{}', { status: 200 });
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: async (url: string, init: any) => {
    upstreamAll.push({ url, init });
    if (String(url).includes('/api/1.0/unity-control/auth/tokens')) {
      return new Response(JSON.stringify({ access_token: INTERNAL_TOKEN }), { status: 200 });
    }
    if (String(url).includes('/v1/config')) {
      handshakes.push({ url, init });
      return new Response(
        JSON.stringify({ defaults: {}, overrides: { prefix: IRC_PREFIX } }),
        { status: 200 },
      );
    }
    upstream.push({ url, init });
    return respond();
  },
}));

const BASE = 'https://iceberg-catalog.internal.example.net';

/**
 * The audit rows for ICEBERG operations only.
 *
 * The token exchange writes its OWN row — deliberately, per LU-3: a successful
 * exchange is the moment the Console acquires catalog authority, and a burst of
 * failed ones is the signature of a disabled Console principal. So the trail
 * legitimately carries MORE than one row per request now, and the
 * `toHaveLength(1)` assertions below are about the ICEBERG operation, not about
 * the size of the whole trail.
 *
 * This is a POSITIVE match on `iceberg.*` rather than an exclusion of the
 * exchange row, and that distinction cost a CI round trip. The exchange row is
 * written by `recordUnityAccess`, which stores `itemType:'loom-unity'` and
 * `action:'unity.<operation>'` — it does NOT store the caller's
 * `operation:'auth.token-exchange'` as `action`. So excluding
 * `action === 'auth.token-exchange'` matched nothing and filtered nothing.
 *
 * A positive match cannot drift that way: every row this file asserts on is
 * emitted by logIcebergAccess as `iceberg.<noun>.<verb>`, and any future
 * sibling recorder is excluded by construction rather than by an exclusion list
 * someone has to remember to extend.
 *
 * It must be a filter at all — rather than an assertion — because
 * `recordExchange` is FIRE-AND-FORGET (`void recordExchange(...)`, so audit
 * latency can never fail a catalog call). Its row lands on an unpredictable
 * tick: outside the asserting test under the local run order, inside it under
 * CI sharding. That is precisely why the un-filtered counts passed locally and
 * failed in CI.
 */
const icebergAuditRows = () => auditRows.filter((r) => String(r.action || '').startsWith('iceberg.'));

function req(url: string, init: RequestInit = {}) {
  // The route handlers only touch `nextUrl`, `method`, `headers` and `json()`.
  const u = new URL(url);
  return {
    url,
    method: (init.method || 'GET') as string,
    nextUrl: u,
    headers: new Headers(init.headers || {}),
    json: async () => (init.body ? JSON.parse(String(init.body)) : {}),
  } as any;
}

beforeEach(() => {
  upstream.length = 0;
  upstreamAll.length = 0;
  handshakes.length = 0;
  auditRows.length = 0;
  respond = () => new Response('{}', { status: 200 });
  sessionValue = { claims: { oid: 'oid-1', upn: 'analyst@contoso.com', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 };
  process.env.LOOM_ICEBERG_CATALOG_URL = BASE;
  process.env.LOOM_MSAL_CLIENT_ID = 'app-client-id';
});

afterEach(() => {
  delete process.env.LOOM_ICEBERG_CATALOG_URL;
  delete process.env.LOOM_MSAL_CLIENT_ID;
  vi.resetModules();
});

describe('authentication precedes the config gate', () => {
  it('401s an anonymous caller even when the catalog IS configured', async () => {
    sessionValue = null;
    const { GET } = await import('../namespaces/route');
    const res = await GET(req('https://loom.test/api/catalog/iceberg/namespaces'));
    expect(res.status).toBe(401);
    expect(upstream).toHaveLength(0);
  });

  it('401s an anonymous caller when the catalog is NOT configured (no config leak)', async () => {
    sessionValue = null;
    delete process.env.LOOM_ICEBERG_CATALOG_URL;
    const { GET } = await import('../namespaces/route');
    const res = await GET(req('https://loom.test/api/catalog/iceberg/namespaces'));
    expect(res.status).toBe(401);
    const body = await res.json();
    // The 401 body must not name the missing env var.
    expect(JSON.stringify(body)).not.toContain('LOOM_ICEBERG_CATALOG_URL');
  });
});

describe('honest gate when the catalog is not deployed', () => {
  it('returns the 503 gate envelope with the exact missing var + a Fix-it href', async () => {
    delete process.env.LOOM_ICEBERG_CATALOG_URL;
    const { GET } = await import('../namespaces/route');
    const res = await GET(req('https://loom.test/api/catalog/iceberg/namespaces'));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.gated).toBe(true);
    expect(body.code).toBe('iceberg_catalog_not_configured');
    expect(body.missing).toEqual(['LOOM_ICEBERG_CATALOG_URL']);
    expect(body.gate.id).toBe('svc-iceberg-catalog');
    expect(body.gate.fixItHref).toContain('/admin/gates?gate=svc-iceberg-catalog');
    expect(upstream).toHaveLength(0);
  });

  it('treats a 0.0.0.0 bind-address placeholder as not-configured (no unreachable fetch) — operator report 2026-08', async () => {
    // Observed live on the Commercial console: LOOM_ICEBERG_CATALOG_URL was
    // https://0.0.0.0:3000/api/catalog/iceberg (a dev bind address that also
    // circularly points at Loom's own BFF). It must show the honest 503 gate,
    // NOT "Iceberg REST Catalog unreachable at https://0.0.0.0…".
    process.env.LOOM_ICEBERG_CATALOG_URL = 'https://0.0.0.0:3000/api/catalog/iceberg';
    const { GET } = await import('../namespaces/route');
    const res = await GET(req('https://loom.test/api/catalog/iceberg/namespaces'));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('iceberg_catalog_not_configured');
    expect(upstream).toHaveLength(0); // never attempted the fetch against the bind address
  });
});

describe('Entra auth injection', () => {
  it('sends the server-minted bearer upstream and never the caller credential', async () => {
    respond = () => new Response(JSON.stringify({ namespaces: [['gold']] }), { status: 200 });
    const { GET } = await import('../namespaces/route');
    const res = await GET(req('https://loom.test/api/catalog/iceberg/namespaces', {
      headers: { authorization: 'Bearer loom_pat_caller_secret' },
    }));
    expect(res.status).toBe(200);
    expect(upstream).toHaveLength(1);
    // The INTERNAL token from the exchange — not the raw Entra token, which the
    // catalog's AuthDecorator answers 403 (measured live: HTTP 403 in ~307ms,
    // warm and reproducible, before this exchange was wired).
    expect(upstream[0].init.headers.authorization).toBe(`Bearer ${INTERNAL_TOKEN}`);
    expect(upstream[0].init.headers.authorization).not.toContain('tok-api://');
    expect(upstream[0].init.headers.authorization).not.toContain('loom_pat_caller_secret');
  });

  it('exchanges the Entra token at THIS catalog, not at LOOM_UNITY_URL', async () => {
    // iceberg-catalog and loom-unity are separate Container Apps with separate
    // databases and separate minted-token state, so a token minted by one is not
    // honoured by the other. Exchanging at the wrong base fails closed upstream.
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal.example.net';
    respond = () => new Response(JSON.stringify({ namespaces: [['gold']] }), { status: 200 });
    const { GET } = await import('../namespaces/route');
    await GET(req('https://loom.test/api/catalog/iceberg/namespaces'));
    const exchange = upstreamAll.find((h) => String(h.url).includes('/auth/tokens'));
    expect(exchange).toBeDefined();
    expect(exchange!.url).toBe(`${BASE}/api/1.0/unity-control/auth/tokens`);
    delete process.env.LOOM_UNITY_URL;
  });

  it('returns the namespaces in both spec (levels) and human (dotted) form', async () => {
    respond = () => new Response(JSON.stringify({ namespaces: [['gold'], ['gold', 'sales']] }), { status: 200 });
    const { GET } = await import('../namespaces/route');
    const body = await (await GET(req('https://loom.test/api/catalog/iceberg/namespaces'))).json();
    expect(body.namespaces).toEqual([
      { levels: ['gold'], name: 'gold' },
      { levels: ['gold', 'sales'], name: 'gold.sales' },
    ]);
  });
});

describe('audit rows', () => {
  it('writes ONE aggregated row for a namespace LIST, carrying resultCount', async () => {
    respond = () => new Response(JSON.stringify({ namespaces: [['gold'], ['silver']] }), { status: 200 });
    const { GET } = await import('../namespaces/route');
    await GET(req('https://loom.test/api/catalog/iceberg/namespaces'));
    expect(icebergAuditRows()).toHaveLength(1);
    expect(icebergAuditRows()[0].action).toBe('iceberg.namespace.list');
    expect(icebergAuditRows()[0].resultCount).toBe(2);
    expect(icebergAuditRows()[0].upn).toBe('analyst@contoso.com');
    expect(icebergAuditRows()[0].outcome).toBe('success');
  });

  it('writes ONE aggregated row for a table LIST, scoped to the namespace', async () => {
    respond = () => new Response(
      JSON.stringify({ identifiers: [{ namespace: ['gold'], name: 'orders' }] }),
      { status: 200 },
    );
    const { GET } = await import('../tables/route');
    const body = await (await GET(req('https://loom.test/api/catalog/iceberg/tables?namespace=gold'))).json();
    expect(body.tables[0]).toMatchObject({ name: 'orders', namespace: 'gold' });
    expect(body.tables[0].formats).toEqual(['delta', 'iceberg']);
    expect(icebergAuditRows()).toHaveLength(1);
    expect(icebergAuditRows()[0].action).toBe('iceberg.table.list');
    expect(icebergAuditRows()[0].namespace).toBe('gold');
    expect(icebergAuditRows()[0].resultCount).toBe(1);
  });

  it('records the workspace scope when the caller supplies one', async () => {
    respond = () => new Response(JSON.stringify({ 'metadata-location': 'abfss://x/metadata/v1.json' }), { status: 200 });
    const { GET } = await import('../table/route');
    await GET(req('https://loom.test/api/catalog/iceberg/table?namespace=gold&table=orders&workspaceId=ws-7'));
    expect(icebergAuditRows()[0].action).toBe('iceberg.table.load');
    expect(icebergAuditRows()[0].workspaceId).toBe('ws-7');
  });

  it('records a FAILED read so a denied access still leaves evidence', async () => {
    respond = () => new Response(
      JSON.stringify({ error: { message: 'no such namespace', type: 'NoSuchNamespaceException' } }),
      { status: 404 },
    );
    const { GET } = await import('../tables/route');
    const res = await GET(req('https://loom.test/api/catalog/iceberg/tables?namespace=gold'));
    expect(res.status).toBe(404);
    expect(icebergAuditRows()).toHaveLength(1);
    expect(icebergAuditRows()[0].outcome).toBe('failure');
    expect(icebergAuditRows()[0].summary).toContain('FAILED');
  });

  it('audits a register (write) with the table scope', async () => {
    respond = () => new Response(JSON.stringify({ 'metadata-location': 'abfss://gold@a.dfs.core.windows.net/T/metadata' }), { status: 200 });
    const { POST } = await import('../tables/route');
    const res = await POST(req('https://loom.test/api/catalog/iceberg/tables', {
      method: 'POST',
      body: JSON.stringify({
        namespace: 'gold', table: 'orders',
        metadataLocation: 'abfss://gold@a.dfs.core.windows.net/T/metadata',
      }),
    }));
    expect(res.status).toBe(200);
    expect(icebergAuditRows()[0].action).toBe('iceberg.table.register');
    expect(icebergAuditRows()[0].table).toBe('orders');
  });
});

describe('input validation', () => {
  it('400s a table listing with no namespace instead of calling upstream', async () => {
    const { GET } = await import('../tables/route');
    const res = await GET(req('https://loom.test/api/catalog/iceberg/tables'));
    expect(res.status).toBe(400);
    expect(upstream).toHaveLength(0);
  });

  it('400s an invalid namespace before it can reach the URL path', async () => {
    const { GET } = await import('../tables/route');
    const res = await GET(req('https://loom.test/api/catalog/iceberg/tables?namespace=' + encodeURIComponent('../etc')));
    expect(res.status).toBe(400);
    expect(upstream).toHaveLength(0);
  });

  it('pins purgeRequested=false on de-registration (never deletes customer data)', async () => {
    respond = () => new Response('{}', { status: 200 });
    const { DELETE } = await import('../tables/route');
    const res = await DELETE(req('https://loom.test/api/catalog/iceberg/tables?namespace=gold&table=orders', {
      method: 'DELETE',
    }));
    const body = await res.json();
    expect(body.dataPurged).toBe(false);
    expect(upstream[0].url).toContain('purgeRequested=false');
  });
});

describe('IRC prefix handshake (Iceberg REST spec)', () => {
  it('resolves the server prefix and addresses /v1/catalogs/loom/… , never /v1/…', async () => {
    // The defect this pins: the client used to call /v1/namespaces, a route this
    // server does not have. Measured in Docker against the real image — the
    // request enters UnityAccessDecorator (route-decorated over the whole
    // /api/2.1/unity-catalog/ prefix), finds no annotated method, and dies 500.
    respond = () => new Response(JSON.stringify({ identifiers: [] }), { status: 200 });
    const { GET } = await import('../tables/route');
    const res = await GET(req('https://loom.test/api/catalog/iceberg/tables?namespace=gold'));
    expect(res.status).toBe(200);
    expect(handshakes).toHaveLength(1);
    expect(handshakes[0].url).toContain('/v1/config?warehouse=loom');
    expect(upstream).toHaveLength(1);
    expect(upstream[0].url).toContain('/v1/catalogs/loom/namespaces/gold/tables');
    expect(upstream[0].url).not.toContain('/iceberg/v1/namespaces');
  });

  it('serves namespaces from the Unity schemas API when the image 500s the IRC route', async () => {
    // MEASURED on the shipped image (authorization on, warehouse provisioned,
    // namespace present, tried with EVERY principal including the server's own
    // metastore-OWNER service token):
    //   GET <irc>/v1/catalogs/loom/namespaces
    //     -> 500 "Authorization filter not initialized — ensure the request goes
    //             through UnityAccessDecorator."
    // CONTROL: the identical call on the BARE upstream v0.5.0 image (no Loom
    // overlay) -> 200 {"namespaces":[["default"]]}. So the v0.5.1 server overlay
    // the Dockerfile applies for upstream #1603 is what broke this one route.
    respond = () => {
      // The mock records the hop BEFORE calling respond(), so the call in flight
      // is the last entry — which is how one responder can model both hops.
      const url = upstream.at(-1)!.url;
      if (url.includes('/api/2.1/unity-catalog/schemas')) {
        return new Response(JSON.stringify({ schemas: [{ name: 'default' }, { name: 'gold' }] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ error: { message: 'Authorization filter not initialized — ensure the request goes through UnityAccessDecorator.', type: 'BaseException' } }),
        { status: 500 },
      );
    };
    const { GET } = await import('../namespaces/route');
    const res = await GET(req('https://loom.test/api/catalog/iceberg/namespaces'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.via).toBe('unity-schemas');
    expect(body.namespaces.map((n: any) => n.name)).toEqual(['default', 'gold']);
    // The native route WAS attempted first — the fallback is a response to a
    // measured failure, not a replacement for the Iceberg surface.
    expect(upstream[0].url).toContain('/v1/catalogs/loom/namespaces');
    // And the fallback hop is a REAL read of the same catalog, not a fabricated list.
    expect(upstream.at(-1)!.url).toContain('/api/2.1/unity-catalog/schemas?catalog_name=loom');
  });

  it('does NOT mask an unrelated 500 behind the fallback', async () => {
    respond = () => new Response(
      JSON.stringify({ error: { message: 'database is on fire', type: 'BaseException' } }),
      { status: 500 },
    );
    const { GET } = await import('../namespaces/route');
    const res = await GET(req('https://loom.test/api/catalog/iceberg/namespaces'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('database is on fire');
  });
});

describe('read-only API tokens cannot mutate', () => {
  it('403s a POST from a read-only PAT session', async () => {
    sessionValue = null;
    vi.doMock('@/lib/auth/pat', () => ({
      resolvePat: async () => ({
        claims: { oid: 'pat-oid', upn: 'ci@contoso.com', tid: 'tid-1' },
        exp: Date.now() / 1000 + 3600,
        pat: { id: 'p1', scope: 'read-only' },
      }),
      scopeAllowsMethod: (scope: string, method: string) =>
        scope === 'read-only' ? ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) : true,
      patCanAdmin: () => false,
    }));
    vi.resetModules();
    const { POST } = await import('../tables/route');
    const res = await POST(req('https://loom.test/api/catalog/iceberg/tables', {
      method: 'POST',
      headers: { authorization: 'Bearer loom_pat_x_y' },
      body: JSON.stringify({ namespace: 'gold', table: 'orders', metadataLocation: 'abfss://a@b/c' }),
    }));
    expect(res.status).toBe(403);
    expect(upstream).toHaveLength(0);
  });
});
