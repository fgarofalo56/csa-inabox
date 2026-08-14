/**
 * N3 — BFF contract tests for the Flight SQL session + connect routes.
 *
 * Pinned properties:
 *   1. A ticket is minted ONLY from a verified session, is short-lived, carries
 *      the Entra principal, and its issuance is AUDITED with the join key the
 *      serving tier repeats on redemption.
 *   2. The connect payload never leaks a secret and never names an internal
 *      container host — even when only the in-VNet endpoint exists.
 *   3. Both routes render fully with nothing deployed: this is an accelerator,
 *      not a gate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let sessionValue: any = {
  claims: { oid: 'oid-1', upn: 'analyst@contoso.com', tid: 'tid-1' },
  exp: Date.now() / 1000 + 3600,
};
vi.mock('@/lib/auth/session', () => ({ getSession: () => sessionValue }));

const auditRows: any[] = [];
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: async () => ({
    items: { create: async (doc: any) => { auditRows.push(doc); return { resource: doc }; } },
  }),
}));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: () => {} }));

function req(url: string, init: RequestInit = {}) {
  const u = new URL(url);
  // A real request ALWAYS carries Host — HTTP/1.1 requires it, and behind Front
  // Door it also carries x-forwarded-host. This helper used to build empty
  // Headers, which made the fixture model a request that cannot exist, and that
  // is precisely what hid #3443: with no Host, a route reading the forwarded
  // origin and a route reading its own URL are indistinguishable here while
  // differing completely in production, where `nextUrl.origin` is the
  // container's 0.0.0.0:3000 listen address. Callers can still override.
  const headers = new Headers(init.headers || {});
  if (!headers.has('host')) headers.set('host', u.host);
  return {
    url,
    method: (init.method || 'GET') as string,
    nextUrl: u,
    headers,
    json: async () => (init.body ? JSON.parse(String(init.body)) : {}),
  } as any;
}

beforeEach(() => {
  auditRows.length = 0;
  sessionValue = { claims: { oid: 'oid-1', upn: 'analyst@contoso.com', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 };
  process.env.LOOM_FLIGHT_TICKET_SECRET = 'unit-test-signing-key';
});

afterEach(() => {
  delete process.env.LOOM_FLIGHT_TICKET_SECRET;
  delete process.env.LOOM_FLIGHTSQL_URL;
  delete process.env.LOOM_FLIGHTSQL_PUBLIC_URL;
  vi.resetModules();
});

describe('POST /api/flightsql/session', () => {
  it('401s an anonymous caller — there is no unauthenticated ticket path', async () => {
    sessionValue = null;
    const { POST } = await import('../session/route');
    const res = await POST(req('https://loom.test/api/flightsql/session', { method: 'POST' }), {} as any);
    expect(res.status).toBe(401);
    expect(auditRows).toHaveLength(0);
  });

  it('mints a short-lived, scoped ticket and AUDITS the issuance', async () => {
    const { POST } = await import('../session/route');
    const res = await POST(req('https://loom.test/api/flightsql/session', {
      method: 'POST',
      body: JSON.stringify({ ttlSeconds: 120, scope: ['container:gold'], itemId: 'lh-1' }),
    }), {} as any);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticket.startsWith('v1.')).toBe(true);
    expect(body.ttlSeconds).toBe(120);
    expect(body.signed).toBe(true);
    expect(body.scope).toEqual(['container:gold']);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(body.expiresAt).getTime()).toBeLessThan(Date.now() + 121_000);

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      itemType: 'flight-sql',
      action: 'flight.ticket.mint',
      ticketId: body.ticketId,
      itemId: 'lh-1',
      outcome: 'success',
      upn: 'analyst@contoso.com',
    });
  });

  it('rejects a nonsense TTL instead of silently defaulting', async () => {
    const { POST } = await import('../session/route');
    const res = await POST(req('https://loom.test/api/flightsql/session', {
      method: 'POST', body: JSON.stringify({ ttlSeconds: -1 }),
    }), {} as any);
    expect(res.status).toBe(400);
    expect(auditRows).toHaveLength(0);
  });

  it('discloses when tickets are accepted on in-VNet trust rather than verified', async () => {
    delete process.env.LOOM_FLIGHT_TICKET_SECRET;
    const { POST } = await import('../session/route');
    const res = await POST(req('https://loom.test/api/flightsql/session', { method: 'POST' }), {} as any);
    const body = await res.json();
    expect(body.signed).toBe(false);
    expect(body.signingNote).toContain('LOOM_FLIGHT_TICKET_SECRET');
    expect(auditRows[0].signed).toBe(false);
  });

  it('still mints (and audits) when the Flight wire is not deployed — a ticket is a Loom credential', async () => {
    const { POST } = await import('../session/route');
    const res = await POST(req('https://loom.test/api/flightsql/session', { method: 'POST' }), {} as any);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.endpoint.exposure).toBe('not-deployed');
    expect(body.endpoint.uri).toBe('');
    expect(auditRows).toHaveLength(1);
  });
});

describe('GET /api/flightsql/connect', () => {
  it('401s an anonymous caller', async () => {
    sessionValue = null;
    const { GET } = await import('../connect/route');
    const res = await GET(req('https://loom.test/api/flightsql/connect'), {} as any);
    expect(res.status).toBe(401);
  });

  it('renders the FULL payload with nothing deployed (accelerator, not a gate)', async () => {
    const { GET } = await import('../connect/route');
    const res = await GET(req('https://loom.test/api/flightsql/connect'), {} as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.endpoint.exposure).toBe('not-deployed');
    expect(body.snippets.length).toBeGreaterThan(3);
    expect(body.arrowThreshold).toBe(5000);
    expect(body.loomTransportNote).toContain('audited HTTP tier');
  });

  it('points ticket acquisition at the audited route on the FORWARDED origin', async () => {
    const { GET } = await import('../connect/route');
    const res = await GET(req('https://loom.contoso.com/api/flightsql/connect'), {} as any);
    const body = await res.json();
    expect(body.ticketMintUrl).toBe('https://loom.contoso.com/api/flightsql/session');
  });

  // #3443 REGRESSION. The production shape the old fixture could not express:
  // `output: 'standalone'` with HOSTNAME=0.0.0.0 makes `nextUrl.origin` the
  // CONTAINER's listen address, while the forwarded host carries the address the
  // client actually reached. Reading the former handed clients
  // https://0.0.0.0:3000/api/flightsql/session — in a copy-paste snippet, from a
  // route whose own docstring forbids internal hosts.
  //
  // The two origins are DELIBERATELY different here. That is the whole point: a
  // fixture where they agree cannot tell a correct route from a broken one.
  it('#3443 — uses the forwarded host even when the request URL is the container address', async () => {
    const { GET } = await import('../connect/route');
    const res = await GET(
      req('http://0.0.0.0:3000/api/flightsql/connect', {
        headers: { host: '0.0.0.0:3000', 'x-forwarded-host': 'loom.contoso.com', 'x-forwarded-proto': 'https' },
      }),
      {} as any,
    );
    const body = await res.json();
    expect(body.ticketMintUrl).toBe('https://loom.contoso.com/api/flightsql/session');
    expect(body.ticketMintUrl).not.toContain('0.0.0.0');
  });

  it('never emits a secret or an internal container host in ANY snippet', async () => {
    process.env.LOOM_FLIGHTSQL_URL = 'grpc://loom-duckdb.internal.bluesky.eastus.azurecontainerapps.io:8815';
    const { GET } = await import('../connect/route');
    const res = await GET(req('https://loom.test/api/flightsql/connect'), {} as any);
    const body = await res.json();
    expect(body.endpoint.exposure).toBe('in-vnet');
    for (const snippet of body.snippets) {
      expect(snippet.code).not.toContain('azurecontainerapps.io');
      expect(snippet.code).not.toContain('unit-test-signing-key');
      expect(snippet.code).toContain('LOOM_FLIGHT_TICKET');
    }
  });

  it('uses the published endpoint when one really is reachable', async () => {
    process.env.LOOM_FLIGHTSQL_URL = 'grpc://internal:8815';
    process.env.LOOM_FLIGHTSQL_PUBLIC_URL = 'grpc+tls://flight.loom.contoso.com:443';
    const { GET } = await import('../connect/route');
    const res = await GET(req('https://loom.test/api/flightsql/connect'), {} as any);
    const body = await res.json();
    expect(body.endpoint.exposure).toBe('published');
    const adbc = body.snippets.find((s: any) => s.id === 'adbc-python');
    expect(adbc.code).toContain('grpc+tls://flight.loom.contoso.com:443');
  });

  it('threads the caller\'s sample statement into the snippets', async () => {
    const { GET } = await import('../connect/route');
    const res = await GET(req('https://loom.test/api/flightsql/connect?sql=SELECT%2042%20AS%20answer'), {} as any);
    const body = await res.json();
    const adbc = body.snippets.find((s: any) => s.id === 'adbc-python');
    expect(adbc.code).toContain('SELECT 42 AS answer');
  });
});
