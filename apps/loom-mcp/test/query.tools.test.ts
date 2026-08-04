/**
 * M2 `loom-query` tool tests — the data-exfiltration surface.
 *
 * The SDK client is a REAL `LoomClient` (from `@csa-loom/sdk`) wired to a stub
 * `fetch`, so the full path runs: tool.run → guards → client.query.* → HTTP
 * transport → stub → parsed rows → core scrub → cap → MCP result. No network,
 * no SDK mocks.
 *
 * MUTATION-PROOF (scrub): a connection string and a PAT are injected into a DATA
 * CELL of the query result. If `src/core/scrub.ts` is reverted to a passthrough,
 * the secret reappears in the tool output and the scrub assertion goes RED — so
 * a green run proves M2 does NOT exfiltrate secrets in returned rows.
 *
 * Also proves: real rows flow through, the server-side row cap clamps (a caller
 * cannot raise it), and DDL/DML (SQL) + control commands (KQL) are rejected at
 * parse before the SDK is ever called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoomClient } from '@csa-loom/sdk';
import { buildToolHandler } from '../src/core/tool.js';
import { queryTools } from '../src/servers/loom-query/tools.js';
import type { AuthContext, AuditEvent, ToolSpec } from '../src/core/types.js';

const PAT = 'loom_pat_TESTID_secretsecrethalf';
const CONN = 'AccountKey=INJECTEDSECRETKEY==;EndpointSuffix=core.windows.net';

/** Counts backend hits so we can prove a parse-reject never calls the SDK. */
let backendHits = 0;

/** A stub fetch that serves a query result with an injected secret in a cell. */
const stubFetch: typeof fetch = async (input): Promise<Response> => {
  const url = String(input);
  if (url.includes('/query')) {
    backendHits++;
    // 20 rows; row 0 carries secrets in data cells (the thing §5.2 must scrub).
    const rows = Array.from({ length: 20 }, (_v, i) =>
      i === 0
        ? { customer: 'Contoso', note: `conn ${CONN} tok ${PAT}`, amount: 100 }
        : { customer: `cust-${i}`, note: 'clean', amount: i },
    );
    return new Response(JSON.stringify({ ok: true, columns: ['customer', 'note', 'amount'], rows, rowCount: rows.length }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.includes('/preview')) {
    backendHits++;
    const rows = Array.from({ length: 8 }, (_v, i) => ({ col: `v-${i}` }));
    return new Response(JSON.stringify({ ok: true, previewable: true, columns: ['col'], rows, rowCount: rows.length }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response('null', { status: 200, headers: { 'content-type': 'application/json' } });
};

function patAuth(): AuthContext {
  return {
    mode: 'pat',
    principal: 'pat_TESTID',
    scope: 'read-only',
    apiUrl: 'https://loom.test',
    client: new LoomClient({ baseUrl: 'https://loom.test', token: PAT, fetch: stubFetch }),
  };
}

function tool(name: string): ToolSpec {
  const t = queryTools().find((s) => s.name === name);
  assert.ok(t, `tool ${name} exists`);
  return t;
}

function handlerFor(name: string, events: AuditEvent[]) {
  return buildToolHandler(tool(name), { server: 'loom-query', auth: patAuth(), audit: (e) => events.push(e) });
}

test('every M2 tool is read-only and read-only-scoped', () => {
  const tools = queryTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['loom.query.kql', 'loom.query.preview', 'loom.query.sql']);
  for (const t of tools) {
    assert.equal(t.readOnly, true, `${t.name} must be read-only`);
    assert.equal(t.minScope, 'read-only', `${t.name} must require only read-only`);
  }
});

test('loom.query.sql returns real rows but SCRUBS secrets in data cells (mutation-proof)', async () => {
  backendHits = 0;
  const events: AuditEvent[] = [];
  const res = await handlerFor('loom.query.sql', events)({ id: 'itm-1', sql: 'SELECT customer, note, amount FROM sales' });
  const text = res.content[0]?.text ?? '';

  assert.notEqual(res.isError, true, 'query should succeed');
  assert.equal(backendHits, 1, 'the SDK actually called the query route');
  assert.match(text, /Contoso/, 'real row data flows through (SDK was actually called)');

  // …but the injected secrets in the data cell are scrubbed.
  assert.ok(!text.includes('INJECTEDSECRETKEY'), 'connection-string account key in a cell must be scrubbed');
  assert.ok(!text.includes('secretsecrethalf'), 'PAT embedded in a cell must be scrubbed');

  // audit fired allow/ok with the row count; args (the SQL text) only as a hash.
  assert.equal(events[0]?.decision, 'allow');
  assert.equal(events[0]?.outcome, 'ok');
  assert.equal(events[0]?.count, 20);
  assert.match(events[0]?.args_hash ?? '', /^[0-9a-f]{16}$/);
});

test('loom.query.sql caps rows server-side — a caller can only LOWER the limit', async () => {
  backendHits = 0;
  const events: AuditEvent[] = [];
  const res = await handlerFor('loom.query.sql', events)({ id: 'itm-1', sql: 'SELECT * FROM sales', limit: 5 });
  assert.notEqual(res.isError, true);
  const sc = res.structuredContent as { count?: number; data?: { rows?: unknown[]; truncatedByCap?: boolean } };
  assert.equal(sc.count, 5, 'returned rows clamped to the requested lower limit');
  assert.equal(sc.data?.rows?.length, 5);
  assert.equal(sc.data?.truncatedByCap, true, 'truncation is surfaced to the caller');
  assert.equal(events[0]?.count, 5);
});

test('loom.query.sql REJECTS DDL/DML at parse — the SDK is never called', async () => {
  for (const bad of ['DROP TABLE sales', 'DELETE FROM sales', 'UPDATE sales SET x=1', 'INSERT INTO sales VALUES (1)', 'SELECT * INTO #t FROM sales']) {
    backendHits = 0;
    const events: AuditEvent[] = [];
    const res = await handlerFor('loom.query.sql', events)({ id: 'itm-1', sql: bad });
    assert.equal(res.isError, true, `"${bad}" must be rejected`);
    assert.match(res.content[0]?.text ?? '', /not allowed|not read-only|materializes/i);
    assert.equal(backendHits, 0, `"${bad}" must not reach the backend`);
  }
});

test('loom.query.kql REJECTS control commands (leading `.`) at parse', async () => {
  backendHits = 0;
  const events: AuditEvent[] = [];
  const res = await handlerFor('loom.query.kql', events)({ id: 'itm-1', kql: '.drop table Sales' });
  assert.equal(res.isError, true);
  assert.match(res.content[0]?.text ?? '', /control|not allowed|not read-only/i);
  assert.equal(backendHits, 0, 'a KQL control command must not reach the backend');
});

test('loom.query.kql runs a real read query and caps rows', async () => {
  backendHits = 0;
  const events: AuditEvent[] = [];
  const res = await handlerFor('loom.query.kql', events)({ id: 'itm-1', kql: 'Sales | take 100', limit: 3 });
  assert.notEqual(res.isError, true);
  assert.equal(backendHits, 1);
  const sc = res.structuredContent as { count?: number };
  assert.equal(sc.count, 3);
});

test('loom.query.preview reads a bounded sample', async () => {
  backendHits = 0;
  const events: AuditEvent[] = [];
  const res = await handlerFor('loom.query.preview', events)({ id: 'asset-1', limit: 8 });
  assert.notEqual(res.isError, true);
  assert.equal(backendHits, 1);
  assert.equal(events[0]?.count, 8);
});
