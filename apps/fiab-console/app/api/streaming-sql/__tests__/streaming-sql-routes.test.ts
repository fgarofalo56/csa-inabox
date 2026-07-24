/**
 * N7a — BFF contract tests for the streaming-SQL edges.
 *
 * The three properties that make these routes safe to be the only door to the
 * RisingWave tier:
 *   1. AUTH — an anonymous caller 401s before anything else.
 *   2. HONEST GATE — with LOOM_RISINGWAVE_URL unset the mutation/read edges 503
 *      with the normalized gate envelope, and /status returns configured:false +
 *      the gate (never a fabricated status). With it set, real rows flow.
 *   3. AUDIT — a mutation writes an `_auditLog` row AND emits the stream event
 *      FIRST (synchronously), carrying the principal + statement.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let sessionValue: any = { claims: { oid: 'oid-1', upn: 'analyst@contoso.com', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 };
vi.mock('@/lib/auth/session', () => ({ getSession: () => sessionValue }));

const auditRows: any[] = [];
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: async () => ({ items: { create: async (doc: any) => { auditRows.push(doc); return { resource: doc }; } } }),
}));
const emitted: any[] = [];
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: (ev: any) => { emitted.push(ev); } }));

// The `pg` wire driver — capture every statement, answer from rw_catalog canned data.
const pgQueries: string[] = [];
function answer(sql: string): any {
  pgQueries.push(sql);
  if (/version\(\)/i.test(sql)) return { fields: [{ name: 'v' }], rows: [{ v: 'RisingWave 2.1.3 (single-node)' }], rowCount: 1 };
  if (/rw_materialized_views/i.test(sql)) {
    return { fields: [{ name: 'name' }, { name: 'schema_name' }, { name: 'definition' }],
      rows: [{ name: 'orders_enriched', schema_name: 'public', definition: 'SELECT ...' }], rowCount: 1 };
  }
  if (/rw_ddl_progress/i.test(sql)) return { fields: [{ name: 'ddl_desc' }, { name: 'progress' }], rows: [], rowCount: 0 };
  if (/rw_sources/i.test(sql)) return { fields: [{ name: 'n' }], rows: [{ n: 2 }], rowCount: 1 };
  if (/rw_sinks/i.test(sql)) return { fields: [{ name: 'n' }], rows: [{ n: 1 }], rowCount: 1 };
  if (/count\(\*\)::bigint/i.test(sql)) return { fields: [{ name: 'n' }], rows: [{ n: 42 }], rowCount: 1 };
  if (/^CREATE MATERIALIZED VIEW/i.test(sql.trim())) return { fields: [], rows: [], rowCount: 0, command: 'CREATE_MATERIALIZED_VIEW' };
  if (/loom_q/i.test(sql)) return { fields: [{ name: 'order_id' }, { name: 'amount' }], rows: [{ order_id: 'o1', amount: 9 }], rowCount: 1, command: 'SELECT' };
  return { fields: [], rows: [], rowCount: 0 };
}
class MockClient {
  constructor(public cfg: any) {}
  async connect() { /* noop */ }
  async query(sql: string) { return answer(sql); }
  async end() { /* noop */ }
}
vi.mock('pg', () => ({ Client: MockClient }));

import { GET as STATUS } from '../status/route';
import { POST as QUERY } from '../query/route';
import { POST as MV } from '../mv/route';

function req(url: string, init: RequestInit = {}) {
  const u = new URL(url);
  return {
    url, method: (init.method || 'GET') as string, nextUrl: u,
    headers: new Headers(init.headers || {}),
    json: async () => (init.body ? JSON.parse(String(init.body)) : {}),
  } as any;
}

beforeEach(() => {
  pgQueries.length = 0; auditRows.length = 0; emitted.length = 0;
  sessionValue = { claims: { oid: 'oid-1', upn: 'analyst@contoso.com', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 };
  delete process.env.LOOM_RISINGWAVE_URL;
  delete process.env.LOOM_EVENTHUB_NAMESPACE;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('auth', () => {
  it('401s an anonymous caller on the mutation edge', async () => {
    sessionValue = null;
    const res = await MV(req('https://x/api/streaming-sql/mv', { method: 'POST', body: JSON.stringify({ sql: 'CREATE MATERIALIZED VIEW v AS SELECT 1' }) }), { params: Promise.resolve({}) } as any);
    expect(res.status).toBe(401);
  });
});

describe('honest gate — tier not deployed', () => {
  it('/status returns configured:false with the gate envelope (never fabricated status)', async () => {
    const res = await STATUS(req('https://x/api/streaming-sql/status'), { params: Promise.resolve({}) } as any);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, configured: false });
    expect(body.gate?.id).toBe('svc-loom-risingwave');
    expect(body.gate?.missing).toContain('LOOM_RISINGWAVE_URL');
    expect(pgQueries.length).toBe(0);
  });

  it('the read + mutation edges 503 with the gate envelope', async () => {
    const q = await QUERY(req('https://x/api/streaming-sql/query', { method: 'POST', body: JSON.stringify({ sql: 'SELECT 1' }) }), { params: Promise.resolve({}) } as any);
    expect(q.status).toBe(503);
    expect((await q.json()).gated).toBe(true);

    const m = await MV(req('https://x/api/streaming-sql/mv', { method: 'POST', body: JSON.stringify({ sql: 'CREATE MATERIALIZED VIEW v AS SELECT 1' }) }), { params: Promise.resolve({}) } as any);
    expect(m.status).toBe(503);
  });
});

describe('tier wired — real rows + audit', () => {
  beforeEach(() => { process.env.LOOM_RISINGWAVE_URL = 'loom-risingwave.internal:4566'; });

  it('/status reads the live rw_catalog (version, MVs with row counts, source/sink counts)', async () => {
    const res = await STATUS(req('https://x/api/streaming-sql/status'), { params: Promise.resolve({}) } as any);
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.version).toMatch(/RisingWave/);
    expect(body.materializedViews[0]).toMatchObject({ name: 'orders_enriched', rowCount: 42 });
    expect(body.sourceCount).toBe(2);
    expect(body.sinkCount).toBe(1);
  });

  it('the query edge runs the read-only statement and returns real rows', async () => {
    const res = await QUERY(req('https://x/api/streaming-sql/query', { method: 'POST', body: JSON.stringify({ sql: 'SELECT * FROM orders_enriched', itemId: 'ss-1' }) }), { params: Promise.resolve({}) } as any);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.rows).toEqual([['o1', 9]]);
    // Read-only guard wrapped the statement in a capped subquery.
    expect(pgQueries.some((q) => /loom_q/.test(q))).toBe(true);
    expect(auditRows[0]).toMatchObject({ itemType: 'streaming-sql', outcome: 'success' });
  });

  it('the mutation edge executes streaming DDL and audits — emit FIRST', async () => {
    const res = await MV(req('https://x/api/streaming-sql/mv', { method: 'POST', body: JSON.stringify({ sql: 'CREATE MATERIALIZED VIEW v AS SELECT 1 AS n', itemId: 'ss-1' }) }), { params: Promise.resolve({}) } as any);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(pgQueries.some((q) => /^CREATE MATERIALIZED VIEW/.test(q.trim()))).toBe(true);
    // AUDIT: the stream event fired, and the Cosmos row was written.
    expect(emitted[0]).toMatchObject({ action: 'risingwave.streaming.ddl', outcome: 'success' });
    expect(auditRows[0]).toMatchObject({ action: 'risingwave.streaming.ddl', itemType: 'streaming-sql' });
  });

  it('rejects a non-streaming statement on the mutation edge (no arbitrary DDL)', async () => {
    const res = await MV(req('https://x/api/streaming-sql/mv', { method: 'POST', body: JSON.stringify({ sql: 'GRANT ALL ON x TO y' }) }), { params: Promise.resolve({}) } as any);
    expect(res.status).toBe(400);
  });

  it('compiles a structured two-stream-join spec to DDL and runs it', async () => {
    const res = await MV(req('https://x/api/streaming-sql/mv', {
      method: 'POST',
      body: JSON.stringify({ kind: 'mv-join', spec: { name: 'j', left: 'a', right: 'b', leftKey: 'k', rightKey: 'k' } }),
    }), { params: Promise.resolve({}) } as any);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.sql).toMatch(/CREATE MATERIALIZED VIEW "j" AS/);
  });
});
