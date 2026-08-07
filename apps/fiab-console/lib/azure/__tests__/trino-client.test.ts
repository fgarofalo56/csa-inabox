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
  trinoImpersonationEnabled,
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

// ─────────────────────────────────────────────────────────────────────────────
// LU-7 — impersonation is DEPLOY-GATED and SELF-HEALING.
//
// The engine identity is never caller-asserted through the product: the BFF
// builds `X-Trino-User` from `session.claims.upn`, and that claim comes from an
// AES-GCM authenticated-encryption cookie the server minted at sign-in
// (lib/auth/session.ts) — a client can neither forge the cookie nor set the
// header. What these pin is the OTHER half: the BFF only presents the real
// principal when the DEPLOY wired the governance-rules URL (so the engine is
// being served the document that carries the bounded impersonation grant), and
// a lag between those two never becomes a query outage.
// ─────────────────────────────────────────────────────────────────────────────
describe('LU-7 impersonation gating', () => {
  afterEach(() => {
    delete process.env.LOOM_TRINO_POLICY_URL;
    delete process.env.LOOM_TRINO_IMPERSONATION;
    delete process.env.LOOM_TRINO_AUTH_MODE;
  });

  it('is OFF unless the deploy produced the policy URL', () => {
    expect(trinoImpersonationEnabled()).toBe(false);
    process.env.LOOM_TRINO_POLICY_URL = 'http://loom-console/api/governance/policy-code/engine-rules';
    expect(trinoImpersonationEnabled()).toBe(true);
  });

  it('honours the audited operator opt-out', () => {
    process.env.LOOM_TRINO_POLICY_URL = 'http://loom-console/api/governance/policy-code/engine-rules';
    process.env.LOOM_TRINO_IMPERSONATION = 'disabled';
    expect(trinoImpersonationEnabled()).toBe(false);
  });

  it('sends the MAPPED session user (not the caller) when the engine has no policy document', async () => {
    process.env.LOOM_TRINO_URL = 'https://trino.internal';
    process.env.LOOM_TRINO_AUTH_MODE = 'entra';
    process.env.LOOM_TRINO_TOKEN = 'pre-shared';
    responder = () => new Response(JSON.stringify({ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }), { status: 200 });
    await runTrinoQuery('SELECT 1', { actorUpn: 'alice@contoso.com' });
    expect(upstream[0].init.headers['x-trino-user']).toBe('loom-console');
  });

  it('presents the REAL principal once the deploy wired the policy URL', async () => {
    process.env.LOOM_TRINO_URL = 'https://trino.internal';
    process.env.LOOM_TRINO_AUTH_MODE = 'entra';
    process.env.LOOM_TRINO_TOKEN = 'pre-shared';
    process.env.LOOM_TRINO_POLICY_URL = 'http://loom-console/api/governance/policy-code/engine-rules';
    responder = () => new Response(JSON.stringify({ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }), { status: 200 });
    await runTrinoQuery('SELECT 1', { actorUpn: 'alice@contoso.com' });
    expect(upstream[0].init.headers['x-trino-user']).toBe('alice@contoso.com');
    // The signed-in principal still rides client-info for the audit row.
    expect(upstream[0].init.headers['x-trino-client-info']).toContain('alice@contoso.com');
  });

  it('SELF-HEALS to the mapped user when the engine has not yet loaded the rules', async () => {
    // The engine is still on its start-up catalog floor, which denies
    // impersonation. A policy-publication lag must not be a query outage.
    process.env.LOOM_TRINO_URL = 'https://trino.internal';
    process.env.LOOM_TRINO_AUTH_MODE = 'entra';
    process.env.LOOM_TRINO_TOKEN = 'pre-shared';
    process.env.LOOM_TRINO_POLICY_URL = 'http://loom-console/api/governance/policy-code/engine-rules';
    let call = 0;
    responder = () => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({
          error: { message: 'Access Denied: User loom-console cannot impersonate user alice@contoso.com', errorName: 'USER_CANNOT_BE_IMPERSONATED' },
        }), { status: 403 });
      }
      return new Response(JSON.stringify({ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }), { status: 200 });
    };
    const res = await runTrinoQuery('SELECT 1', { actorUpn: 'alice@contoso.com' });
    expect(res.rowCount).toBe(1);
    expect(upstream[0].init.headers['x-trino-user']).toBe('alice@contoso.com');
    expect(upstream[1].init.headers['x-trino-user']).toBe('loom-console'); // the retry
  });

  it('does NOT retry a genuine data authorization denial with a wider identity', async () => {
    process.env.LOOM_TRINO_URL = 'https://trino.internal';
    process.env.LOOM_TRINO_AUTH_MODE = 'entra';
    process.env.LOOM_TRINO_TOKEN = 'pre-shared';
    process.env.LOOM_TRINO_POLICY_URL = 'http://loom-console/api/governance/policy-code/engine-rules';
    responder = () => new Response(JSON.stringify({
      error: { message: 'Access Denied: Cannot select from table iceberg.sales.orders', errorName: 'PERMISSION_DENIED' },
    }), { status: 403 });
    await expect(runTrinoQuery('SELECT 1', { actorUpn: 'alice@contoso.com' })).rejects.toBeInstanceOf(TrinoError);
    expect(upstream).toHaveLength(1); // one hop, no retry
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
