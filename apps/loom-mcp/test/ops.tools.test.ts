/**
 * M4 `loom-ops` tool tests — the write-path proof for the shared core.
 *
 * The SDK client is a REAL `LoomClient` wired to a stub `fetch`, so the full
 * path runs: tool.run → client.runs.* → HTTP transport → stub → core scrub →
 * audit → MCP result. No network, no SDK mocks.
 *
 * MUTATION-PROOF (authz write gate): `loom.run.start` is `readOnly:false` +
 * `minScope:'read-write'`. The core gate must (a) refuse it for a `read-only`
 * scope even on a mutation-permitting server, and (b) refuse it entirely on a
 * server that has NOT opted into mutations. If either check is weakened in
 * `src/core/authz.ts`, the corresponding assertion below goes RED — so a green
 * run proves a read-only token cannot start/cancel a run and a read-only server
 * cannot dispatch a mutating tool.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoomClient } from '@csa-loom/sdk';
import { buildToolHandler } from '../src/core/tool.js';
import { authorize } from '../src/core/authz.js';
import { opsTools } from '../src/servers/loom-ops/tools.js';
import type { AuthContext, AuditEvent, ToolSpec, TokenScope } from '../src/core/types.js';

const PAT = 'loom_pat_TESTID_secretsecrethalf';
const SECRET = 'AccountKey=INJECTEDSECRETKEY==;EndpointSuffix=core.windows.net';

/** Records which endpoint class the SDK actually hit. */
const hits: Record<string, number> = { start: 0, cancel: 0, runs: 0, log: 0 };

const stubFetch: typeof fetch = async (input, init): Promise<Response> => {
  const url = String(input);
  const method = (init?.method || 'GET').toUpperCase();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  if (url.includes('/cancel')) {
    hits.cancel++;
    return json({ ok: true });
  }
  if (url.includes('/log')) {
    hits.log++;
    return json({ ok: true, from: 0, total: 3, lines: ['line-a', 'line-b', 'line-c'] });
  }
  if (url.includes('/runs')) {
    hits.runs++;
    if (url.includes('runId=')) {
      // A run's activity receipts — with a secret injected into an output cell.
      return json({ ok: true, runId: 'run-123', activities: [{ name: 'copy', status: 'Succeeded', output: { note: `dst ${SECRET}` } }] });
    }
    return json({ ok: true, runs: [{ id: 'run-1', status: 'Succeeded' }, { id: 'run-2', status: 'Failed' }], boundTo: 'pipe-x' });
  }
  if (/\/run(\?|$)/.test(url) && method === 'POST') {
    hits.start++;
    return json({ ok: true, boundTo: 'pipe-x', runId: 'run-123' });
  }
  return json(null);
};

function patAuth(scope: TokenScope): AuthContext {
  return {
    mode: 'pat',
    principal: 'pat_TESTID',
    scope,
    apiUrl: 'https://loom.test',
    client: new LoomClient({ baseUrl: 'https://loom.test', token: PAT, fetch: stubFetch }),
  };
}

function tool(name: string): ToolSpec {
  const t = opsTools().find((s) => s.name === name);
  assert.ok(t, `tool ${name} exists`);
  return t;
}

test('M4 tool shape: 3 read tools + 2 write tools with the right scope floors', () => {
  const tools = opsTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['loom.run.cancel', 'loom.run.get', 'loom.run.list', 'loom.run.logs', 'loom.run.start']);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const r of ['loom.run.list', 'loom.run.get', 'loom.run.logs']) {
    assert.equal(byName[r]?.readOnly, true, `${r} is read`);
    assert.equal(byName[r]?.minScope, 'read-only');
  }
  for (const w of ['loom.run.start', 'loom.run.cancel']) {
    assert.equal(byName[w]?.readOnly, false, `${w} is a WRITE tool`);
    assert.equal(byName[w]?.minScope, 'read-write', `${w} requires read-write`);
  }
});

// ---- the core authz gate, directly (unit-level mutation-proof) --------------

test('core gate: run.start is REFUSED for a read-only scope even when mutations are allowed', () => {
  const d = authorize(tool('loom.run.start'), patAuth('read-only'), { allowMutations: true });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, 'insufficient_scope');
});

test('core gate: run.start is ALLOWED for a read-write scope on a mutation-permitting server', () => {
  const d = authorize(tool('loom.run.start'), patAuth('read-write'), { allowMutations: true });
  assert.equal(d.ok, true);
});

test('core gate: run.start is REFUSED on a server that has NOT opted into mutations (defense in depth)', () => {
  const d = authorize(tool('loom.run.start'), patAuth('read-write')); // allowMutations defaults false
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, 'forbidden_mutation');
});

// ---- the full handler pipeline (end-to-end mutation-proof) ------------------

test('loom.run.start (WRITE) is denied end-to-end for a read-only token — SDK never called', async () => {
  hits.start = 0;
  const events: AuditEvent[] = [];
  const handler = buildToolHandler(tool('loom.run.start'), { server: 'loom-ops', auth: patAuth('read-only'), audit: (e) => events.push(e), allowMutations: true });
  const res = await handler({ id: 'itm-1' });
  assert.equal(res.isError, true, 'a read-only token cannot start a run');
  assert.match(res.content[0]?.text ?? '', /insufficient_scope/);
  assert.match(res.content[0]?.text ?? '', /read-write/);
  assert.equal(hits.start, 0, 'the run must NOT be started');
  assert.equal(events[0]?.decision, 'deny');
  assert.equal(events[0]?.reason, 'insufficient_scope');
});

test('loom.run.start (WRITE) succeeds for a read-write token and actually calls POST /run', async () => {
  hits.start = 0;
  const events: AuditEvent[] = [];
  const handler = buildToolHandler(tool('loom.run.start'), { server: 'loom-ops', auth: patAuth('read-write'), audit: (e) => events.push(e), allowMutations: true });
  const res = await handler({ id: 'itm-1', params: { window: 'today' } });
  assert.notEqual(res.isError, true, 'read-write token may start a run');
  assert.equal(hits.start, 1, 'the write path actually hit the backend run route');
  assert.match(res.content[0]?.text ?? '', /pipe-x/, 'real backend response flows back');
  assert.equal(events[0]?.decision, 'allow');
  assert.equal(events[0]?.outcome, 'ok');
});

test('loom.run.cancel (WRITE) is refused for read-only, allowed for read-write', async () => {
  hits.cancel = 0;
  const ro = buildToolHandler(tool('loom.run.cancel'), { server: 'loom-ops', auth: patAuth('read-only'), audit: () => {}, allowMutations: true });
  assert.equal((await ro({ id: 'itm-1', runId: '42' })).isError, true);
  assert.equal(hits.cancel, 0, 'a read-only token cannot cancel');

  const rw = buildToolHandler(tool('loom.run.cancel'), { server: 'loom-ops', auth: patAuth('read-write'), audit: () => {}, allowMutations: true });
  assert.notEqual((await rw({ id: 'itm-1', runId: '42' })).isError, true);
  assert.equal(hits.cancel, 1, 'read-write cancel hits the backend');
});

test('loom.run.list (read) works for a read-only token and returns real runs', async () => {
  hits.runs = 0;
  const events: AuditEvent[] = [];
  const handler = buildToolHandler(tool('loom.run.list'), { server: 'loom-ops', auth: patAuth('read-only'), audit: (e) => events.push(e), allowMutations: true });
  const res = await handler({ id: 'itm-1' });
  assert.notEqual(res.isError, true);
  assert.equal(hits.runs, 1);
  assert.match(res.content[0]?.text ?? '', /run-1/);
  assert.equal(events[0]?.count, 2, 'row count is audited');
});

test('loom.run.get SCRUBS secrets in a run’s activity output (data leaves via M4 too)', async () => {
  hits.runs = 0;
  const handler = buildToolHandler(tool('loom.run.get'), { server: 'loom-ops', auth: patAuth('read-only'), audit: () => {}, allowMutations: true });
  const res = await handler({ id: 'itm-1', runId: 'run-123' });
  const text = res.content[0]?.text ?? '';
  assert.notEqual(res.isError, true);
  assert.match(text, /Succeeded/, 'real activity status flows through');
  assert.ok(!text.includes('INJECTEDSECRETKEY'), 'a secret in run output must be scrubbed');
});
