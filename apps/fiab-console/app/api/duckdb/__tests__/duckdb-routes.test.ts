/**
 * N2b — BFF contract tests for the SQL Lab execution edge.
 *
 * The three things that make this route safe to be the ONLY door to the
 * serving tier:
 *   1. AUTH — an anonymous caller 401s before anything else happens.
 *   2. HONEST FALLBACK — with LOOM_DUCKDB_URL unset the SAME statement executes
 *      on Synapse Serverless and the response NAMES the engine that answered.
 *      The surface is never blocked; only latency changes.
 *   3. AUDIT — success AND failure write a data-access row before the response
 *      is sent, carrying the principal, the statement and the engine.
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

// Upstream serving tier.
const upstream: Array<{ url: string; init: any }> = [];
let respond: () => Response = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: async (url: string, init: any) => { upstream.push({ url, init }); return respond(); },
}));

// Synapse Serverless fallback.
const synapseQueries: string[] = [];
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  serverlessTargetResolved: async () => ({ server: 'ws-ondemand.sql', database: 'master', cacheKey: 'k' }),
  executeQuery: async (_t: any, sql: string) => {
    synapseQueries.push(sql);
    return {
      columns: ['n'], rows: [[1]], rowCount: 1, executionMs: 91,
      truncated: false, messages: [], recordsAffected: 0,
    };
  },
}));

// Lake account resolution (the route builds the scan SQL server-side).
vi.mock('@/lib/azure/adls-client', () => ({ getAccountName: () => 'stloom' }));

const BASE = 'https://loom-duckdb.internal.example.net';

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
  synapseQueries.length = 0;
  sessionValue = { claims: { oid: 'oid-1', upn: 'analyst@contoso.com', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 };
  delete process.env.LOOM_DUCKDB_URL;
  respond = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
});

afterEach(() => {
  delete process.env.LOOM_DUCKDB_URL;
  vi.resetModules();
});

describe('POST /api/duckdb/query — auth', () => {
  it('401s an anonymous caller, even with the tier configured', async () => {
    process.env.LOOM_DUCKDB_URL = BASE;
    sessionValue = null;
    const { POST } = await import('../query/route');
    const res = await POST(req('https://loom.test/api/duckdb/query', {
      method: 'POST', body: JSON.stringify({ sql: 'SELECT 1' }),
    }), {} as any);
    expect(res.status).toBe(401);
    expect(upstream).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });

  it('refuses an empty statement with usable guidance, not a stack trace', async () => {
    process.env.LOOM_DUCKDB_URL = BASE;
    const { POST } = await import('../query/route');
    const res = await POST(req('https://loom.test/api/duckdb/query', {
      method: 'POST', body: JSON.stringify({ sql: '   ' }),
    }), {} as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('delta_scan');
  });
});

describe('POST /api/duckdb/query — DuckDB tier configured', () => {
  it('executes on the serving tier and reports the engine that answered', async () => {
    process.env.LOOM_DUCKDB_URL = BASE;
    respond = () => new Response(JSON.stringify({
      ok: true,
      columns: [{ name: 'product', type: 'VARCHAR' }],
      rows: [['widget']],
      rowCount: 1,
      elapsedMs: 12,
      truncated: false,
      maxRows: 5000,
      extensions: ['httpfs', 'azure', 'delta', 'iceberg'],
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    const { POST } = await import('../query/route');
    const res = await POST(req('https://loom.test/api/duckdb/query', {
      method: 'POST', body: JSON.stringify({ sql: "SELECT * FROM delta_scan('abfss://gold@a.dfs.core.windows.net/t')" }),
    }), {} as any);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.engine).toBe('duckdb');
    expect(body.rowCount).toBe(1);
    expect(body.elapsedMs).toBe(12);
    expect(body.extensions).toContain('delta');
    expect(upstream[0].url).toBe(`${BASE}/query`);
    expect(synapseQueries).toHaveLength(0);
  });

  it('streams raw Arrow with ?format=arrow and carries the stats in headers', async () => {
    process.env.LOOM_DUCKDB_URL = BASE;
    const arrow = new Uint8Array([255, 255, 255, 255, 1, 2, 3, 4]);
    respond = () => new Response(arrow, {
      status: 200,
      headers: {
        'content-type': 'application/vnd.apache.arrow.stream',
        'x-loom-row-count': '120000',
        'x-loom-elapsed-ms': '340',
        'x-loom-truncated': 'false',
        'x-loom-bytes': '8',
      },
    });

    const { POST } = await import('../query/route');
    const res = await POST(req('https://loom.test/api/duckdb/query?format=arrow', {
      method: 'POST', body: JSON.stringify({ sql: 'SELECT 1' }),
    }), {} as any);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.apache.arrow.stream');
    expect(res.headers.get('x-loom-row-count')).toBe('120000');
    expect(res.headers.get('x-loom-engine')).toBe('duckdb');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(arrow);
    // The Arrow leg is audited exactly like the JSON leg.
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].engine).toBe('duckdb');
    expect(auditRows[0].rowCount).toBe(120000);
  });

  it('relays an engine refusal verbatim — it is the user\'s own SQL, not internals', async () => {
    process.env.LOOM_DUCKDB_URL = BASE;
    respond = () => new Response(JSON.stringify({
      ok: false, error: 'DROP is a write/DDL statement. The DuckDB serving tier is read-only', code: 'read_only',
    }), { status: 400, headers: { 'content-type': 'application/json' } });

    const { POST } = await import('../query/route');
    const res = await POST(req('https://loom.test/api/duckdb/query', {
      method: 'POST', body: JSON.stringify({ sql: 'DROP TABLE sales' }),
    }), {} as any);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('read-only');
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].outcome).toBe('failure');
  });
});

describe('POST /api/duckdb/query — honest Synapse Serverless fallback', () => {
  it('runs the SAME statement on Serverless when the tier is unset and says so', async () => {
    const sql = "SELECT TOP 10 * FROM OPENROWSET(BULK 'x', FORMAT='DELTA') AS r";
    const { POST } = await import('../query/route');
    const res = await POST(req('https://loom.test/api/duckdb/query', {
      method: 'POST', body: JSON.stringify({ sql }),
    }), {} as any);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.engine).toBe('synapse-serverless');
    expect(body.note).toContain('LOOM_DUCKDB_URL is unset');
    expect(body.elapsedMs).toBe(91);
    // The statement really was forwarded, unmodified, to the fallback engine.
    expect(synapseQueries).toEqual([sql]);
    expect(upstream).toHaveLength(0);
  });

  it('audits the fallback execution with the engine that actually answered', async () => {
    const { POST } = await import('../query/route');
    await POST(req('https://loom.test/api/duckdb/query', {
      method: 'POST', body: JSON.stringify({ sql: 'SELECT 1', itemId: 'lab-1' }),
    }), {} as any);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      itemType: 'sql-lab',
      itemId: 'lab-1',
      action: 'duckdb.sql.query',
      engine: 'synapse-serverless',
      outcome: 'success',
      upn: 'analyst@contoso.com',
    });
    expect(auditRows[0].statement).toBe('SELECT 1');
  });

  it('refuses ?format=arrow honestly instead of fabricating an empty stream', async () => {
    const { POST } = await import('../query/route');
    const res = await POST(req('https://loom.test/api/duckdb/query?format=arrow', {
      method: 'POST', body: JSON.stringify({ sql: 'SELECT 1' }),
    }), {} as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('arrow_unavailable');
    expect(body.error).toContain('Synapse Serverless');
  });
});

describe('POST /api/duckdb/query — lake coordinates instead of SQL', () => {
  it('builds the scan SERVER-side so a browser never invents a storage URL', async () => {
    process.env.LOOM_DUCKDB_URL = BASE;
    respond = () => new Response(JSON.stringify({
      ok: true, columns: [], rows: [], rowCount: 0, elapsedMs: 1, truncated: false, maxRows: 5000,
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    const { POST } = await import('../query/route');
    await POST(req('https://loom.test/api/duckdb/query', {
      method: 'POST',
      body: JSON.stringify({ source: { container: 'gold', path: 'Tables/sales', limit: 500 } }),
    }), {} as any);

    const forwarded = JSON.parse(String(upstream[0].init.body));
    expect(forwarded.sql).toBe(
      "SELECT * FROM delta_scan('abfss://gold@stloom.dfs.core.windows.net/Tables/sales') LIMIT 500",
    );
  });

  it('refuses a path that could break out of the SQL literal', async () => {
    process.env.LOOM_DUCKDB_URL = BASE;
    const { POST } = await import('../query/route');
    const res = await POST(req('https://loom.test/api/duckdb/query', {
      method: 'POST',
      body: JSON.stringify({ source: { container: 'gold', path: "a'; DROP TABLE t; --" } }),
    }), {} as any);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_source');
    expect(upstream).toHaveLength(0);
  });
});

describe('GET /api/duckdb/capabilities', () => {
  it('describes the Serverless fallback WITH the gate envelope when unset', async () => {
    const { GET } = await import('../capabilities/route');
    const res = await GET(req('https://loom.test/api/duckdb/capabilities'), {} as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(false);
    expect(body.engine).toBe('synapse-serverless');
    expect(body.gate.id).toBe('svc-loom-duckdb');
    expect(body.fallback.note).toContain('duckdb-aca.bicep');
  });

  it('reports the REAL engine capabilities when the tier answers', async () => {
    process.env.LOOM_DUCKDB_URL = BASE;
    respond = () => new Response(JSON.stringify({
      ok: true, engine: 'duckdb', version: '1.1.3', extensions: ['httpfs', 'azure', 'delta', 'iceberg'],
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    const { GET } = await import('../capabilities/route');
    const res = await GET(req('https://loom.test/api/duckdb/capabilities'), {} as any);
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.capabilities.version).toBe('1.1.3');
    expect(body.capabilities.extensions).toContain('iceberg');
  });

  it('says the tier was unreachable rather than inventing a capability list', async () => {
    process.env.LOOM_DUCKDB_URL = BASE;
    respond = () => { throw new Error('ECONNREFUSED'); };
    const { GET } = await import('../capabilities/route');
    const res = await GET(req('https://loom.test/api/duckdb/capabilities'), {} as any);
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.unreachable).toContain('ECONNREFUSED');
    expect(body.capabilities).toBeUndefined();
  });
});
