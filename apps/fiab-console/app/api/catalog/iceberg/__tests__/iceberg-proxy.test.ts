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
const upstream: Array<{ url: string; init: any }> = [];
let respond: () => Response = () => new Response('{}', { status: 200 });
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: async (url: string, init: any) => { upstream.push({ url, init }); return respond(); },
}));

const BASE = 'https://iceberg-catalog.internal.example.net';

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
    expect(upstream[0].init.headers.authorization).toBe('Bearer tok-api://app-client-id/.default');
    expect(upstream[0].init.headers.authorization).not.toContain('loom_pat_caller_secret');
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
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe('iceberg.namespace.list');
    expect(auditRows[0].resultCount).toBe(2);
    expect(auditRows[0].upn).toBe('analyst@contoso.com');
    expect(auditRows[0].outcome).toBe('success');
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
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe('iceberg.table.list');
    expect(auditRows[0].namespace).toBe('gold');
    expect(auditRows[0].resultCount).toBe(1);
  });

  it('records the workspace scope when the caller supplies one', async () => {
    respond = () => new Response(JSON.stringify({ 'metadata-location': 'abfss://x/metadata/v1.json' }), { status: 200 });
    const { GET } = await import('../table/route');
    await GET(req('https://loom.test/api/catalog/iceberg/table?namespace=gold&table=orders&workspaceId=ws-7'));
    expect(auditRows[0].action).toBe('iceberg.table.load');
    expect(auditRows[0].workspaceId).toBe('ws-7');
  });

  it('records a FAILED read so a denied access still leaves evidence', async () => {
    respond = () => new Response(
      JSON.stringify({ error: { message: 'no such namespace', type: 'NoSuchNamespaceException' } }),
      { status: 404 },
    );
    const { GET } = await import('../tables/route');
    const res = await GET(req('https://loom.test/api/catalog/iceberg/tables?namespace=gold'));
    expect(res.status).toBe(404);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].outcome).toBe('failure');
    expect(auditRows[0].summary).toContain('FAILED');
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
    expect(auditRows[0].action).toBe('iceberg.table.register');
    expect(auditRows[0].table).toBe('orders');
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
