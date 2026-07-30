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
//
// THIS MOCK MODELS THE ENGINE, NOT THE CODE. It used to return whatever columns
// the client asked for, which made it a mirror of the client's assumptions: the
// suite was green for months while GET /api/streaming-sql/status 502'd against
// every real deployment, because `rw_catalog.rw_materialized_views` has NO
// `schema_name` column and `rw_catalog.rw_ddl_progress` has NO `ddl_desc`.
//
// The column lists below are MEASURED on the pinned image
// (`risingwavelabs/risingwave:v2.1.3`, 2026-07-30) via
// `SELECT column_name FROM information_schema.columns WHERE table_name = …`:
//
//   rw_materialized_views: id, name, schema_id, owner, definition, append_only,
//                          acl, initialized_at, created_at,
//                          initialized_at_cluster_version,
//                          created_at_cluster_version, background_ddl
//   rw_ddl_progress:       ddl_id, ddl_statement, progress, initialized_at
//   rw_schemas:            id, name, owner, acl
//
// Selecting a column outside those lists now THROWS the way the engine does, so
// a regression that reintroduces a phantom column fails this suite instead of
// production. If the engine pin moves, re-measure and update these lists.
const RW_COLUMNS: Record<string, string[]> = {
  rw_materialized_views: ['id', 'name', 'schema_id', 'owner', 'definition', 'append_only', 'acl',
    'initialized_at', 'created_at', 'initialized_at_cluster_version', 'created_at_cluster_version',
    'background_ddl'],
  rw_ddl_progress: ['ddl_id', 'ddl_statement', 'progress', 'initialized_at'],
  rw_schemas: ['id', 'name', 'owner', 'acl'],
  rw_sources: ['id', 'name', 'schema_id', 'owner', 'connector', 'columns', 'format', 'row_encode',
    'append_only', 'associated_table_id', 'connection_id', 'definition', 'acl', 'initialized_at',
    'created_at', 'initialized_at_cluster_version', 'created_at_cluster_version', 'is_shared'],
  rw_sinks: ['id', 'name', 'schema_id', 'owner', 'connector', 'sink_type', 'connection_id',
    'definition', 'acl', 'initialized_at', 'created_at'],
};

/** Reject any bare column reference that the pinned engine does not have. */
function assertCatalogColumns(sql: string): void {
  for (const [rel, cols] of Object.entries(RW_COLUMNS)) {
    if (!new RegExp(`rw_catalog\\.${rel}\\b`, 'i').test(sql)) continue;
    // Only inspect the select list, and only bare/aliased identifiers we can
    // attribute — `mv.name` / `s.name` style qualified refs are attributed by
    // the alias the query itself declares, so an unqualified phantom is what we
    // are hunting (that is the shape both real bugs took).
    const selectList = /^\s*SELECT\s+([\s\S]*?)\s+FROM\b/i.exec(sql)?.[1] ?? '';
    const bare = [...selectList.matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s*(?:,|$)/gi)].map((m) => m[1].toLowerCase());
    for (const ident of bare) {
      if (ident === 'count' || ident === 'version') continue;
      if (!cols.includes(ident)) {
        const e: any = new Error(`Failed to bind expression: ${ident}\nItem not found: Invalid column: ${ident}`);
        e.code = '42703';
        throw e;
      }
    }
  }
}

const pgQueries: string[] = [];
function answer(sql: string): any {
  pgQueries.push(sql);
  assertCatalogColumns(sql);
  if (/version\(\)/i.test(sql)) return { fields: [{ name: 'v' }], rows: [{ v: 'RisingWave 2.1.3 (single-node)' }], rowCount: 1 };
  if (/rw_materialized_views/i.test(sql)) {
    // The client must JOIN rw_schemas to get a schema NAME — the relation only
    // carries schema_id. Refuse to answer a query that does not.
    if (!/rw_catalog\.rw_schemas/i.test(sql)) {
      const e: any = new Error('Failed to bind expression: schema_name\nItem not found: Invalid column: schema_name');
      e.code = '42703';
      throw e;
    }
    return { fields: [{ name: 'name' }, { name: 'schema_name' }, { name: 'definition' }],
      rows: [{ name: 'orders_enriched', schema_name: 'public', definition: 'SELECT ...' }], rowCount: 1 };
  }
  if (/rw_ddl_progress/i.test(sql)) return { fields: [{ name: 'ddl_statement' }, { name: 'progress' }], rows: [], rowCount: 0 };
  if (/rw_sources/i.test(sql)) return { fields: [{ name: 'n' }], rows: [{ n: 2 }], rowCount: 1 };
  if (/rw_sinks/i.test(sql)) return { fields: [{ name: 'n' }], rows: [{ n: 1 }], rowCount: 1 };
  if (/count\(\*\)::bigint/i.test(sql)) return { fields: [{ name: 'n' }], rows: [{ n: 42 }], rowCount: 1 };
  if (/^CREATE MATERIALIZED VIEW/i.test(sql.trim())) return { fields: [], rows: [], rowCount: 0, command: 'CREATE_MATERIALIZED_VIEW' };
  if (/loom_q/i.test(sql)) return { fields: [{ name: 'order_id' }, { name: 'amount' }], rows: [{ order_id: 'o1', amount: 9 }], rowCount: 1, command: 'SELECT' };
  return { fields: [], rows: [], rowCount: 0 };
}
/** Set to make MockClient.connect() reject, mimicking an engine auth refusal. */
let connectError: any = null;
/** Every Client config the routes constructed — used to assert the credential. */
const pgConfigs: any[] = [];
class MockClient {
  constructor(public cfg: any) { pgConfigs.push(cfg); }
  async connect() { if (connectError) throw connectError; }
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
  pgQueries.length = 0; auditRows.length = 0; emitted.length = 0; pgConfigs.length = 0;
  connectError = null;
  delete process.env.LOOM_RISINGWAVE_PASSWORD;
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

// ─────────────────────────────────────────────────────────────────────────────
// Regressions found by running the REAL pinned engine (2026-07-30). Each of
// these passed the old suite and failed in production.
// ─────────────────────────────────────────────────────────────────────────────
describe('rw_catalog column names match the pinned engine', () => {
  beforeEach(() => { process.env.LOOM_RISINGWAVE_URL = 'loom-risingwave.internal:4566'; });

  it('/status resolves the MV schema through rw_schemas — rw_materialized_views has schema_id, NOT schema_name', async () => {
    const res = await STATUS(req('https://x/api/streaming-sql/status'), { params: Promise.resolve({}) } as any);
    const body = await res.json();
    // The whole route used to 502 here: the phantom column threw and the query
    // was not wrapped in a catch.
    expect(res.status).toBe(200);
    expect(body.configured).toBe(true);
    expect(body.materializedViews[0]).toMatchObject({ name: 'orders_enriched', schema: 'public' });

    const mvQuery = pgQueries.find((q) => /rw_catalog\.rw_materialized_views/i.test(q));
    expect(mvQuery, 'the status route must query rw_materialized_views').toBeTruthy();
    expect(mvQuery).toMatch(/rw_catalog\.rw_schemas/i);
    expect(mvQuery).toMatch(/schema_id/i);
  });

  it('/status asks rw_ddl_progress for ddl_statement — there is no ddl_desc column', async () => {
    await STATUS(req('https://x/api/streaming-sql/status'), { params: Promise.resolve({}) } as any);
    const progressQuery = pgQueries.find((q) => /rw_ddl_progress/i.test(q));
    expect(progressQuery, 'the status route must query rw_ddl_progress').toBeTruthy();
    expect(progressQuery).toMatch(/ddl_statement/i);
    expect(progressQuery).not.toMatch(/ddl_desc/i);
  });
});

describe('credential handling on the wire', () => {
  beforeEach(() => { process.env.LOOM_RISINGWAVE_URL = 'loom-risingwave.internal:4566'; });

  it('passes LOOM_RISINGWAVE_PASSWORD to the driver (the KV-vended root credential)', async () => {
    process.env.LOOM_RISINGWAVE_PASSWORD = 'secret-from-key-vault';
    await STATUS(req('https://x/api/streaming-sql/status'), { params: Promise.resolve({}) } as any);
    expect(pgConfigs[0]).toMatchObject({ user: 'root', password: 'secret-from-key-vault' });
  });

  it('reports an engine auth refusal as 401, not 502 — RisingWave answers XX000, not 28P01', async () => {
    // Measured against risingwavelabs/risingwave:v2.1.3 with the real `pg`
    // driver: a wrong/absent password comes back as `XX000 Invalid password`.
    // Mapping only the standard SQLSTATEs surfaced every credential drift as a
    // generic 502 "backend error", which sends the operator to the wrong fix.
    connectError = Object.assign(new Error('Invalid password'), { code: 'XX000' });
    const res = await QUERY(req('https://x/api/streaming-sql/query', { method: 'POST', body: JSON.stringify({ sql: 'SELECT 1' }) }), { params: Promise.resolve({}) } as any);
    expect(res.status).toBe(401);
  });

  it('still maps the standard Postgres auth SQLSTATEs to 401 (BYO endpoints)', async () => {
    connectError = Object.assign(new Error('password authentication failed'), { code: '28P01' });
    const res = await QUERY(req('https://x/api/streaming-sql/query', { method: 'POST', body: JSON.stringify({ sql: 'SELECT 1' }) }), { params: Promise.resolve({}) } as any);
    expect(res.status).toBe(401);
  });

  it('a non-auth engine error is still 502', async () => {
    connectError = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const res = await QUERY(req('https://x/api/streaming-sql/query', { method: 'POST', body: JSON.stringify({ sql: 'SELECT 1' }) }), { params: Promise.resolve({}) } as any);
    expect(res.status).toBe(502);
  });
});
