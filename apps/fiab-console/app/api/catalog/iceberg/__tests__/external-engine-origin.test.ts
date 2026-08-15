/**
 * BFF contract tests for the three routes that hand an Iceberg catalog address
 * to an EXTERNAL engine.
 *
 * These routes' whole product is a copy-paste connection config for Spark,
 * Trino, DuckDB, Snowflake and Databricks. So the one property that makes them
 * useful rather than actively misleading is that every address they emit is
 * reachable from OUTSIDE the container.
 *
 * #3467: all three derived it from the request's own URL — `connect` and
 * `overview` directly, `interop` one indirection away through `originOf(req.url)`.
 * Under `output: 'standalone'` with HOSTNAME=0.0.0.0 that is the container's own
 * listen address, so the snippets told an external engine to connect to
 * `http://0.0.0.0:3000/api/catalog/iceberg` — `connect` doing it directly under a
 * field comment reading "Always the audited proxy — never the container".
 *
 * The two surfaces a user actually visits are covered here deliberately:
 * /admin/catalog renders `overview`'s uri as copy-snippet tabs, and the
 * lakehouse Interop tab renders `interop`'s behind "Copy catalog URI" and feeds
 * it to the same buildConnectSnippets. Fixing only `connect` would have left
 * both still handing out the container address.
 *
 * Same defect as #3443 in flightsql/connect, same fix: `externalOrigin(req.headers)`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let sessionValue: any = {
  claims: { oid: 'oid-1', upn: 'analyst@contoso.com', tid: 'tid-1' },
  exp: Date.now() / 1000 + 3600,
};
vi.mock('@/lib/auth/session', () => ({ getSession: () => sessionValue }));

// Cosmos + data-plane doubles for the two routes that read real state. Neither
// touches the origin under test; they exist so the handler reaches its payload.
vi.mock('@/lib/azure/cosmos-client', () => ({
  lakehouseInteropContainer: async () => ({
    item: () => ({ read: async () => ({ resource: null }) }),
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  }),
  auditLogContainer: async () => ({ items: { create: async (d: any) => ({ resource: d }) } }),
  maintenanceJobsContainer: async () => ({ items: { create: async (d: any) => ({ resource: d }) } }),
}));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: () => {} }));
vi.mock('@/lib/azure/adls-client', () => ({ getAccountName: () => 'loomlake' }));
vi.mock('@/lib/azure/iceberg-catalog-client', async (orig) => ({
  ...(await orig<any>()),
  listNamespacesResolved: async () => [],
  listTables: async () => [],
  listNamespaceGrants: async () => ({}),
  logIcebergAccess: async () => {},
}));

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
/** The only origin any of these routes may hand an external engine. */
const EXTERNAL_ORIGIN = 'https://loom.contoso.com';
/** The address the defect emitted, and the one that must never appear. */
const CONTAINER_ORIGIN = 'http://0.0.0.0:3000';
/** The full URI those two combine into. */
const EXTERNAL_URI = `${EXTERNAL_ORIGIN}/api/catalog/iceberg`;

/**
 * Every absolute http(s) origin appearing in a snippet body, parsed rather than
 * pattern-matched, so `https://loom.contoso.com.evil.test` can never satisfy an
 * assertion about `https://loom.contoso.com`.
 */
function originsIn(code: string): string[] {
  const found = String(code).match(/https?:\/\/[^\s'"`,)\]]+/g) ?? [];
  return found.flatMap((raw) => {
    try {
      return [new URL(raw).origin];
    } catch {
      return [];
    }
  });
}

beforeEach(() => {
  sessionValue = { claims: { oid: 'oid-1', upn: 'analyst@contoso.com', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 };
});

afterEach(() => {
  delete process.env.LOOM_ICEBERG_CATALOG_URL;
  delete process.env.LOOM_ICEBERG_CATALOG_WAREHOUSE;
  delete process.env.LOOM_PUBLIC_BASE_URL;
  delete process.env.LOOM_TENANT_ADMIN_OID;
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

    expect(body.catalog.uri).toBe(EXTERNAL_URI);
    expect(body.catalog.uri).not.toContain('0.0.0.0');
  });

  // The snippet bodies are what a user actually pastes into Spark or Trino, so
  // the address has to be right THERE, not merely in the field beside them.
  //
  // Asserted on PARSED origins, never on substrings. `code.includes('https://
  // loom.contoso.com/…')` reads as equivalent and is not: it is satisfied by a
  // host that merely CONTAINS the expected one, which is why CodeQL flags the
  // shape (js/incomplete-url-substring-sanitization). Parsing every URL out and
  // comparing origins exactly is both rule-clean and the stronger check — it
  // sees every address in the body, not just the one being looked for.
  it('#3467 — no snippet carries the container address', async () => {
    const { GET } = await import('../connect/route');
    const res = await GET(
      req(`${CONTAINER_URL}?namespace=gold&table=sales`, { headers: FORWARDED }),
      {} as any,
    );
    const body = await res.json();

    expect(body.snippets.length).toBeGreaterThan(3);
    const offenders = body.snippets.filter((s: any) => originsIn(s.code).includes(CONTAINER_ORIGIN));
    expect(offenders.map((s: any) => s.id)).toEqual([]);
    // Present, not merely absent — a route emitting an empty origin would also
    // have zero offenders while being just as unusable.
    const carrying = body.snippets.filter((s: any) => originsIn(s.code).includes(EXTERNAL_ORIGIN));
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
    expect(body.catalog.uri).toBe(EXTERNAL_URI);
    expect(body.snippets.length).toBeGreaterThan(3);
  });
});

// The surface at /admin/catalog: its `catalog.uri` is rendered into copy-snippet
// tabs (app/admin/catalog/page.tsx), so this is one of the two addresses a user
// actually copies. Fixing connect/ alone would have left it broken.
describe('GET /api/catalog/iceberg/overview', () => {
  beforeEach(() => {
    // Satisfy the REAL requireTenantAdmin gate rather than mocking auth away.
    process.env.LOOM_TENANT_ADMIN_OID = 'oid-1';
  });

  it('#3467 — emits the FORWARDED origin, never the container address', async () => {
    const { GET } = await import('../overview/route');
    const res = await GET(
      req('http://0.0.0.0:3000/api/catalog/iceberg/overview', { headers: FORWARDED }),
      {} as any,
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.catalog.uri).toBe(EXTERNAL_URI);
    expect(body.catalog.uri).not.toContain('0.0.0.0');
    const offenders = (body.snippets ?? []).filter((s: any) => s.code.includes('0.0.0.0'));
    expect(offenders.map((s: any) => s.id)).toEqual([]);
  });

  it('403s a non-admin — the origin fix did not loosen the admin gate', async () => {
    delete process.env.LOOM_TENANT_ADMIN_OID;
    const { GET } = await import('../overview/route');
    const res = await GET(
      req('http://0.0.0.0:3000/api/catalog/iceberg/overview', { headers: FORWARDED }),
      {} as any,
    );
    expect(res.status).toBe(403);
  });
});

// The lakehouse Interop tab: `catalog.uri` sits behind "Copy catalog URI" and is
// passed to the SAME buildConnectSnippets (lib/editors/lakehouse/panes/
// interop-pane.tsx). Its origin came through `originOf(req.url)` — one
// indirection away from the request URL, which is why a regex over the direct
// construction could never have found it.
describe('GET /api/lakehouse/interop', () => {
  it('#3467 — emits the FORWARDED origin, never the container address', async () => {
    const { GET } = await import('@/app/api/lakehouse/interop/route');
    const res = await GET(
      req('http://0.0.0.0:3000/api/lakehouse/interop?container=bronze', { headers: FORWARDED }),
      {} as any,
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.catalog.uri).toBe(EXTERNAL_URI);
    expect(body.catalog.uri).not.toContain('0.0.0.0');
  });

  it('CONTROL: a direct request on a real origin is unaffected', async () => {
    const { GET } = await import('@/app/api/lakehouse/interop/route');
    const res = await GET(req('https://loom.test/api/lakehouse/interop?container=bronze'), {} as any);
    const body = await res.json();
    expect(body.catalog.uri).toBe('https://loom.test/api/catalog/iceberg');
  });
});
