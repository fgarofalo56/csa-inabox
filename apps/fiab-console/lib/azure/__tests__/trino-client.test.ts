/**
 * N7e — Trino Federated SQL client: the opt-in gate (default state), the client
 * REST statement protocol (nextUri chain), the server-built cross-source join
 * (quoting-helper-safe), and the audit row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const auditRows: any[] = [];
const streamed: any[] = [];
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: async () => ({
    items: { create: async (doc: any) => { auditRows.push(doc); return { resource: doc }; } },
  }),
}));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: (e: any) => { streamed.push(e); } }));
vi.mock('@/lib/azure/arm-credential', () => ({
  uamiArmCredential: () => ({ getToken: async () => null }),
}));

const upstream: Array<{ url: string; init: any }> = [];
let responder: (url: string) => Response = () => new Response('{}', { status: 200 });
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: async (url: string, init: any) => { upstream.push({ url, init }); return responder(url); },
}));

import {
  TrinoError,
  buildFederatedJoinSql,
  isTrinoConfigured,
  logTrinoAccess,
  runTrinoQuery,
  trinoConfigGate,
  trinoTableRef,
} from '../trino-client';

beforeEach(() => {
  upstream.length = 0;
  auditRows.length = 0;
  streamed.length = 0;
  delete process.env.LOOM_TRINO_URL;
  delete process.env.LOOM_TRINO_TOKEN;
  responder = () => new Response('{}', { status: 200 });
});

afterEach(() => { delete process.env.LOOM_TRINO_URL; delete process.env.LOOM_TRINO_TOKEN; });

describe('opt-in gate (the DEFAULT state — loom_default_on_opt_out carve-out)', () => {
  it('reports the exact missing var when unwired', () => {
    expect(trinoConfigGate()).toEqual({ missing: 'LOOM_TRINO_URL' });
    expect(isTrinoConfigured()).toBe(false);
  });

  it('throws a 503 not_configured (never a fabricated result) when LOOM_TRINO_URL is unset', async () => {
    await expect(runTrinoQuery('SELECT 1', { actorUpn: 'a@b.c' })).rejects.toMatchObject({
      status: 503,
      code: 'not_configured',
    });
    // No upstream hop is attempted — the gate is checked before the network.
    expect(upstream).toHaveLength(0);
  });
});

describe('runTrinoQuery — client REST statement protocol', () => {
  it('follows the nextUri chain, accumulates rows, and forwards the principal as the Trino user', async () => {
    process.env.LOOM_TRINO_URL = 'https://trino.internal/';
    responder = (url: string) => {
      if (url.endsWith('/v1/statement')) {
        return new Response(JSON.stringify({
          id: 'q1', nextUri: 'https://trino.internal/v1/statement/q1/1',
          columns: [{ name: 'id', type: 'bigint' }, { name: 'name', type: 'varchar' }],
          data: [[1, 'a']],
        }), { status: 200 });
      }
      // second (final) page — no nextUri => query drained.
      return new Response(JSON.stringify({ id: 'q1', data: [[2, 'b']] }), { status: 200 });
    };

    const result = await runTrinoQuery('SELECT id, name FROM iceberg.gold.t', { actorUpn: 'user@contoso.com' });
    expect(result.engine).toBe('trino');
    expect(result.columns.map((c) => c.name)).toEqual(['id', 'name']);
    expect(result.rows).toEqual([[1, 'a'], [2, 'b']]);
    expect(result.rowCount).toBe(2);
    // POST carried the sanitized X-Trino-User header.
    expect(upstream[0].init.headers['x-trino-user']).toBe('user@contoso.com');
    expect(upstream[0].url).toBe('https://trino.internal/v1/statement');
  });

  it('surfaces a coordinator error as a typed TrinoError, not an empty result', async () => {
    process.env.LOOM_TRINO_URL = 'https://trino.internal';
    responder = () => new Response(JSON.stringify({
      error: { message: 'Catalog postgres does not exist', errorName: 'CATALOG_NOT_FOUND' },
    }), { status: 200 });
    await expect(runTrinoQuery('SELECT 1', { actorUpn: 'a@b.c' })).rejects.toBeInstanceOf(TrinoError);
  });

  it('caps rows at maxRows and marks the result truncated', async () => {
    process.env.LOOM_TRINO_URL = 'https://trino.internal';
    responder = () => new Response(JSON.stringify({
      columns: [{ name: 'n', type: 'bigint' }], data: [[1], [2], [3]],
    }), { status: 200 });
    const result = await runTrinoQuery('SELECT n FROM t', { actorUpn: 'a@b.c', maxRows: 2 });
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(true);
  });
});

describe('buildFederatedJoinSql — the canonical cross-source join, quoting-safe', () => {
  it('joins a Loom Iceberg table with an external Postgres table in one statement', () => {
    const sql = buildFederatedJoinSql({
      left: { catalog: 'iceberg', schema: 'gold', table: 'orders' },
      right: { catalog: 'postgres', schema: 'public', table: 'customers' },
      on: [['customer_id', 'id']],
      columns: ['l."order_id"', 'r."name"'],
      limit: 100,
    });
    expect(sql).toBe(
      'SELECT l."order_id", r."name" FROM "iceberg"."gold"."orders" AS l '
      + 'JOIN "postgres"."public"."customers" AS r ON l."customer_id" = r."id" LIMIT 100',
    );
  });

  it('builds an ANSI double-quoted, injection-safe table reference', () => {
    expect(trinoTableRef({ catalog: 'iceberg', schema: 'gold', table: 'sales' }))
      .toBe('"iceberg"."gold"."sales"');
  });

  it('refuses an identifier that could break out (no inline escaping bypass)', () => {
    expect(() => trinoTableRef({ catalog: 'iceberg', schema: 'gold', table: 'a"; DROP' }))
      .toThrow(TrinoError);
    expect(() => buildFederatedJoinSql({
      left: { catalog: 'iceberg', schema: 'gold', table: 'orders' },
      right: { catalog: 'postgres', schema: 'public', table: 'customers' },
      on: [],
    })).toThrow(TrinoError);
  });
});

describe('logTrinoAccess', () => {
  it('writes one audit row naming the federated catalogs and fans it out', async () => {
    await logTrinoAccess({
      actorOid: 'oid-1', actorUpn: 'a@b.c', tenantId: 't',
      sql: 'SELECT   *\n  FROM iceberg.gold.t', catalogs: ['iceberg', 'postgres'],
      outcome: 'success', rowCount: 3, elapsedMs: 12, itemId: 'lab-1',
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      itemType: 'sql-lab', itemId: 'lab-1', action: 'trino.sql.query', engine: 'trino', outcome: 'success',
    });
    expect(auditRows[0].statement).toBe('SELECT * FROM iceberg.gold.t');
    expect(auditRows[0].summary).toContain('iceberg, postgres');
    expect(streamed).toHaveLength(1);
  });
});
