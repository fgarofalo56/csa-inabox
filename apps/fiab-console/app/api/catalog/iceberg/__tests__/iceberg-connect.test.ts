/**
 * BFF contract tests for GET /api/catalog/iceberg/connect.
 *
 * This route's whole product is a copy-paste connection config for EXTERNAL
 * engines — Spark, Trino, DuckDB, Snowflake, Databricks. So the one property
 * that makes it useful rather than actively misleading is that every address it
 * emits is reachable from OUTSIDE the container.
 *
 * #3467: it derived the catalog URI from `new URL(req.url).origin`. Under
 * `output: 'standalone'` with HOSTNAME=0.0.0.0 that is the container's own
 * listen address, so the snippets told an external engine to connect to
 * `http://0.0.0.0:3000/api/catalog/iceberg` — under a field comment reading
 * "Always the audited proxy — never the container". Same defect as #3443 in
 * flightsql/connect, same fix: `externalOrigin(req.headers)`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let sessionValue: any = {
  claims: { oid: 'oid-1', upn: 'analyst@contoso.com', tid: 'tid-1' },
  exp: Date.now() / 1000 + 3600,
};
vi.mock('@/lib/auth/session', () => ({ getSession: () => sessionValue }));

/**
 * A request fixture that can express the production shape.
 *
 * The Host header is always set, because HTTP/1.1 requires it and because a
 * fixture WITHOUT one cannot tell these two routes apart: with no Host,
 * `externalOrigin` falls back to a default and a route reading its own URL looks
 * identical to a correct one. That blind fixture is exactly how #3443 shipped
 * green, so callers here are expected to make the two origins DIFFER.
 */
function req(url: string, init: { headers?: Record<string, string> } = {}) {
  const u = new URL(url);
  const headers = new Headers(init.headers || {});
  if (!headers.has('host')) headers.set('host', u.host);
  return { url, method: 'GET', nextUrl: u, headers } as any;
}

/** The container's own listen address under `output: 'standalone'`. */
const CONTAINER_URL = 'http://0.0.0.0:3000/api/catalog/iceberg/connect';
/** What the client actually reached, as Front Door forwards it. */
const FORWARDED = { host: '0.0.0.0:3000', 'x-forwarded-host': 'loom.contoso.com', 'x-forwarded-proto': 'https' };

beforeEach(() => {
  sessionValue = { claims: { oid: 'oid-1', upn: 'analyst@contoso.com', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 };
});

afterEach(() => {
  delete process.env.LOOM_ICEBERG_CATALOG_URL;
  delete process.env.LOOM_ICEBERG_CATALOG_WAREHOUSE;
  delete process.env.LOOM_PUBLIC_BASE_URL;
  vi.resetModules();
});

describe('GET /api/catalog/iceberg/connect', () => {
  it('401s an anonymous caller', async () => {
    sessionValue = null;
    const { GET } = await import('../connect/route');
    const res = await GET(req(CONTAINER_URL), {} as any);
    expect(res.status).toBe(401);
  });

  // THE #3467 assertion. The two origins are deliberately different: the request
  // URL is the container's, the forwarded host is the one the client reached.
  // A fixture where they agree cannot tell a correct route from a broken one.
  it('#3467 — emits the FORWARDED origin, never the container address', async () => {
    const { GET } = await import('../connect/route');
    const res = await GET(req(CONTAINER_URL, { headers: FORWARDED }), {} as any);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.catalog.uri).toBe('https://loom.contoso.com/api/catalog/iceberg');
    expect(body.catalog.uri).not.toContain('0.0.0.0');
  });

  // The snippet bodies are what a user actually pastes into Spark or Trino, so
  // the address has to be right THERE, not merely in the field beside them.
  it('#3467 — no snippet carries the container address', async () => {
    const { GET } = await import('../connect/route');
    const res = await GET(
      req(`${CONTAINER_URL}?namespace=gold&table=sales`, { headers: FORWARDED }),
      {} as any,
    );
    const body = await res.json();

    expect(body.snippets.length).toBeGreaterThan(3);
    const offenders = body.snippets.filter((s: any) => s.code.includes('0.0.0.0'));
    expect(offenders.map((s: any) => s.id)).toEqual([]);
    // Present, not merely absent — a route emitting an empty origin would also
    // have zero offenders while being just as unusable.
    const carrying = body.snippets.filter((s: any) =>
      s.code.includes('https://loom.contoso.com/api/catalog/iceberg'));
    expect(carrying.length).toBeGreaterThan(0);
  });

  // CONTROL. Where the request URL and the forwarded host AGREE, the answer is
  // unchanged — this is the shape the pre-#3467 fixture could express, and it
  // passes both before and after the fix ON PURPOSE. It is here so a future
  // "fix" that hard-codes an origin, or drops the request's host entirely, is
  // caught rather than reading as a pass.
  it('CONTROL: a direct request on a real origin is unaffected', async () => {
    const { GET } = await import('../connect/route');
    const res = await GET(req('https://loom.test/api/catalog/iceberg/connect'), {} as any);
    const body = await res.json();
    expect(body.catalog.uri).toBe('https://loom.test/api/catalog/iceberg');
  });

  it('renders the FULL payload when the catalog is not deployed (honest gate, never empty)', async () => {
    const { GET } = await import('../connect/route');
    const res = await GET(req(CONTAINER_URL, { headers: FORWARDED }), {} as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.catalog.configured).toBe(false);
    expect(body.catalog.gate).toBeTruthy();
    // Still a real, reachable address even while gated — the gate must not cost
    // the user the value the route exists to give.
    expect(body.catalog.uri).toBe('https://loom.contoso.com/api/catalog/iceberg');
    expect(body.snippets.length).toBeGreaterThan(3);
  });
});
