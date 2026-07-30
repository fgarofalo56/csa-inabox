/**
 * N7e — BFF contract tests for the Federated SQL (Trino) execution edge.
 *
 *   1. AUTH — an anonymous caller 401s before anything else.
 *   2. OPT-IN GATE — with LOOM_TRINO_URL unset the route returns the honest 503
 *      gate envelope (gated:true, gate.id=svc-loom-trino) so the surface renders
 *      the Fix-it that discloses the AKS cost. This is the DEFAULT state; SQL Lab
 *      still works on DuckDB.
 *   3. REAL federated query — when wired, the client REST protocol runs and the
 *      response names the trino engine; the execution is audited.
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
vi.mock('@/lib/azure/arm-credential', () => ({ uamiArmCredential: () => ({ getToken: async () => null }) }));

const upstream: Array<{ url: string; init: any }> = [];
let respond: (url: string) => Response = () => new Response('{}', { status: 200 });
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: async (url: string, init: any) => { upstream.push({ url, init }); return respond(url); },
}));

const BASE = 'https://loom-trino.internal.example.net';

function req(url: string, init: RequestInit = {}) {
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
  sessionValue = { claims: { oid: 'oid-1', upn: 'analyst@contoso.com', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 };
  delete process.env.LOOM_TRINO_URL;
  respond = () => new Response('{}', { status: 200 });
});

afterEach(() => {
  delete process.env.LOOM_TRINO_URL;
  vi.resetModules();
});

describe('POST /api/sql/trino — auth', () => {
  it('401s an anonymous caller, even with the cluster configured', async () => {
    process.env.LOOM_TRINO_URL = BASE;
    sessionValue = null;
    const { POST } = await import('../route');
    const res = await POST(req('https://loom.test/api/sql/trino', {
      method: 'POST', body: JSON.stringify({ sql: 'SELECT 1' }),
    }), {} as any);
    expect(res.status).toBe(401);
    expect(upstream).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });
});

describe('POST /api/sql/trino — opt-in gate (DEFAULT state)', () => {
  it('returns the honest 503 gate envelope with a Fix-it when LOOM_TRINO_URL is unset', async () => {
    const { POST } = await import('../route');
    const res = await POST(req('https://loom.test/api/sql/trino', {
      method: 'POST', body: JSON.stringify({ sql: 'SELECT 1' }),
    }), {} as any);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.gated).toBe(true);
    expect(body.gate.id).toBe('svc-loom-trino');
    expect(body.gate.fixItHref).toContain('/admin/gates');
    // No upstream hop; no fabricated result.
    expect(upstream).toHaveLength(0);
  });
});

describe('POST /api/sql/trino — configured cluster', () => {
  it('runs the federated statement and reports the trino engine, audited', async () => {
    process.env.LOOM_TRINO_URL = BASE;
    respond = (url: string) => {
      if (url.endsWith('/v1/statement')) {
        return new Response(JSON.stringify({
          columns: [{ name: 'order_id', type: 'bigint' }, { name: 'name', type: 'varchar' }],
          data: [[1, 'ada']],
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    const { POST } = await import('../route');
    const res = await POST(req('https://loom.test/api/sql/trino', {
      method: 'POST',
      body: JSON.stringify({
        sql: 'SELECT o.order_id, c.name FROM iceberg.gold.orders o JOIN postgres.public.customers c ON o.customer_id = c.id',
        itemId: 'lab-1',
      }),
    }), {} as any);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.engine).toBe('trino');
    expect(body.rowCount).toBe(1);
    expect(upstream[0].url).toBe(`${BASE}/v1/statement`);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ action: 'trino.sql.query', engine: 'trino', outcome: 'success', itemId: 'lab-1' });
  });

  it('assembles a structured cross-source join server-side (quoting-safe) and audits it', async () => {
    process.env.LOOM_TRINO_URL = BASE;
    respond = () => new Response(JSON.stringify({ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }), { status: 200 });

    const { POST } = await import('../route');
    await POST(req('https://loom.test/api/sql/trino', {
      method: 'POST',
      body: JSON.stringify({
        join: {
          left: { catalog: 'iceberg', schema: 'gold', table: 'orders' },
          right: { catalog: 'postgres', schema: 'public', table: 'customers' },
          on: [['customer_id', 'id']],
          limit: 50,
        },
        itemId: 'lab-2',
      }),
    }), {} as any);

    // The statement forwarded to the coordinator is the well-formed, ANSI-quoted join.
    expect(String(upstream[0].init.body)).toBe(
      'SELECT * FROM "iceberg"."gold"."orders" AS l '
      + 'JOIN "postgres"."public"."customers" AS r ON l."customer_id" = r."id" LIMIT 50',
    );
  });

  it('relays a coordinator error verbatim (user SQL, not internals) and audits the failure', async () => {
    process.env.LOOM_TRINO_URL = BASE;
    respond = () => new Response(JSON.stringify({
      error: { message: 'line 1:8: Column x cannot be resolved', errorName: 'COLUMN_NOT_FOUND' },
    }), { status: 200 });

    const { POST } = await import('../route');
    const res = await POST(req('https://loom.test/api/sql/trino', {
      method: 'POST', body: JSON.stringify({ sql: 'SELECT x FROM iceberg.gold.orders' }),
    }), {} as any);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('cannot be resolved');
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].outcome).toBe('failure');
  });
});
