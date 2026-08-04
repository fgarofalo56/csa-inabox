/**
 * M3 `loom-author` tool tests — proves the WRITE server (a) dry-runs by default
 * WITHOUT calling the mutating endpoint, (b) actually mutates on apply:true, and
 * (c) refuses a read-only credential.
 *
 * The SDK client is a REAL `LoomClient` wired to a stub `fetch` that RECORDS
 * every request, so the assertions are behavioral, not structural:
 *   • dry-run: the recorded mutating-request count is exactly 0 (no write).
 *   • apply:  POST /api/cosmos-items/{type} was actually issued.
 *   • scope:  a read-only auth is denied at the gate (insufficient_scope).
 *
 * MUTATION-PROOF: these are the guards' proofs. Revert the dry-run guard
 * (`shouldApply` → always true, or drop the `!apply` branch) and the "no write
 * on dry-run" assertion goes RED. Revert the scope floor (authorize's
 * `scopeSatisfies`) and the read-only-refused assertion goes RED. Set the author
 * policy's `allowMutations:false` and EVERY apply test goes RED (forbidden_mutation).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoomClient } from '@csa-loom/sdk';
import { buildToolHandler } from '../src/core/tool.js';
import { authorTools } from '../src/servers/loom-author/tools.js';
import { AUTHOR_AUTHZ } from '../src/servers/loom-author/server.js';
import type { AuthContext, AuditEvent, ToolSpec, TokenScope } from '../src/core/types.js';

interface Call {
  method: string;
  url: string;
}

/** A stub fetch that records each request and serves plausible write responses. */
function recordingFetch(calls: Call[]): typeof fetch {
  return async (input, init): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url });
    if (method === 'POST' && url.includes('/api/cosmos-items/')) {
      // createByType → { ok, item }
      return new Response(JSON.stringify({ ok: true, item: { id: 'new-1', workspaceId: 'ws-1', itemType: 'lakehouse', displayName: 'Bronze' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (method === 'PATCH' && url.includes('/api/cosmos-items/')) {
      return new Response(JSON.stringify({ id: 'item-1', workspaceId: 'ws-1', itemType: 'lakehouse', displayName: 'Renamed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('null', { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

function auth(scope: TokenScope, fetchImpl: typeof fetch): AuthContext {
  return {
    mode: 'pat',
    principal: 'pat_TESTID',
    scope,
    apiUrl: 'https://loom.test',
    client: new LoomClient({ baseUrl: 'https://loom.test', token: 'loom_pat_TESTID_secret', fetch: fetchImpl }),
  };
}

function tool(name: string): ToolSpec {
  const t = authorTools().find((s) => s.name === name);
  assert.ok(t, `tool ${name} exists`);
  return t;
}

const mutatingCalls = (calls: Call[]) => calls.filter((c) => c.method === 'POST' || c.method === 'PATCH' || c.method === 'PUT' || c.method === 'DELETE');

test('every M3 tool is a mutation requiring read-write scope', () => {
  const tools = authorTools();
  assert.equal(tools.length, 3);
  for (const t of tools) {
    assert.equal(t.readOnly, false, `${t.name} must be a mutation`);
    assert.equal(t.minScope, 'read-write', `${t.name} must require read-write`);
  }
  assert.deepEqual(tools.map((t) => t.name).sort(), ['loom.item.create', 'loom.item.definition.update', 'loom.item.update']);
});

test('loom.item.create DRY-RUN (default) does NOT call the mutating endpoint', async () => {
  const calls: Call[] = [];
  const events: AuditEvent[] = [];
  const handler = buildToolHandler(tool('loom.item.create'), {
    server: 'loom-author',
    auth: auth('read-write', recordingFetch(calls)),
    authz: AUTHOR_AUTHZ,
    audit: (e) => events.push(e),
  });

  // apply omitted → dry-run.
  const res = await handler({ type: 'lakehouse', workspaceId: 'ws-1', displayName: 'Bronze' });
  const text = res.content[0]?.text ?? '';

  assert.notEqual(res.isError, true, 'dry-run should succeed');
  assert.match(text, /dry-run/, 'result is a plan');
  assert.equal(mutatingCalls(calls).length, 0, 'NO mutating request may be issued on a dry-run');
  // audited as allow/ok with mutation:planned.
  assert.equal(events[0]?.decision, 'allow');
  assert.equal(events[0]?.mutation, 'planned');
});

test('loom.item.create with apply:true DOES call POST /api/cosmos-items/{type}', async () => {
  const calls: Call[] = [];
  const events: AuditEvent[] = [];
  const handler = buildToolHandler(tool('loom.item.create'), {
    server: 'loom-author',
    auth: auth('read-write', recordingFetch(calls)),
    authz: AUTHOR_AUTHZ,
    audit: (e) => events.push(e),
  });

  const res = await handler({ type: 'lakehouse', workspaceId: 'ws-1', displayName: 'Bronze', apply: true });
  const text = res.content[0]?.text ?? '';

  assert.notEqual(res.isError, true, 'apply should succeed');
  assert.match(text, /applied/);
  const mut = mutatingCalls(calls);
  assert.equal(mut.length, 1, 'exactly one mutating request');
  assert.equal(mut[0]?.method, 'POST');
  assert.match(mut[0]?.url ?? '', /\/api\/cosmos-items\/lakehouse$/);
  assert.equal(events[0]?.mutation, 'applied');
});

test('loom.item.update DRY-RUN issues no write; apply:true issues one PATCH', async () => {
  const calls: Call[] = [];
  const h = buildToolHandler(tool('loom.item.update'), {
    server: 'loom-author',
    auth: auth('read-write', recordingFetch(calls)),
    authz: AUTHOR_AUTHZ,
    audit: () => {},
  });
  await h({ type: 'lakehouse', id: 'item-1', displayName: 'Renamed' });
  assert.equal(mutatingCalls(calls).length, 0, 'dry-run update writes nothing');
  await h({ type: 'lakehouse', id: 'item-1', displayName: 'Renamed', apply: true });
  const mut = mutatingCalls(calls);
  assert.equal(mut.length, 1);
  assert.equal(mut[0]?.method, 'PATCH');
});

test('loom.item.definition.update DRY-RUN writes nothing; apply:true PATCHes state', async () => {
  const calls: Call[] = [];
  const h = buildToolHandler(tool('loom.item.definition.update'), {
    server: 'loom-author',
    auth: auth('read-write', recordingFetch(calls)),
    authz: AUTHOR_AUTHZ,
    audit: () => {},
  });
  await h({ type: 'lakehouse', id: 'item-1', definition: { schema: 'bronze' } });
  assert.equal(mutatingCalls(calls).length, 0, 'dry-run definition write does nothing');
  const res = await h({ type: 'lakehouse', id: 'item-1', definition: { schema: 'bronze' }, apply: true });
  assert.match(res.content[0]?.text ?? '', /applied/);
  assert.equal(mutatingCalls(calls).length, 1);
});

test('a read-only credential is REFUSED by loom.item.create (insufficient_scope) — no write', async () => {
  const calls: Call[] = [];
  const events: AuditEvent[] = [];
  const handler = buildToolHandler(tool('loom.item.create'), {
    server: 'loom-author',
    auth: auth('read-only', recordingFetch(calls)),
    authz: AUTHOR_AUTHZ,
    audit: (e) => events.push(e),
  });
  // Even with apply:true a read-only token cannot write.
  const res = await handler({ type: 'lakehouse', workspaceId: 'ws-1', displayName: 'Bronze', apply: true });
  assert.equal(res.isError, true, 'read-only must be refused');
  assert.match(res.content[0]?.text ?? '', /insufficient_scope|requires scope "read-write"/);
  assert.equal(mutatingCalls(calls).length, 0, 'a refused call must never reach the backend');
  assert.equal(events[0]?.decision, 'deny');
  assert.equal(events[0]?.reason, 'insufficient_scope');
});

test('anonymous is denied on the write server', async () => {
  const handler = buildToolHandler(tool('loom.item.create'), { server: 'loom-author', auth: null, authz: AUTHOR_AUTHZ, audit: () => {} });
  const res = await handler({ type: 'lakehouse', workspaceId: 'ws-1', displayName: 'Bronze', apply: true });
  assert.equal(res.isError, true);
  assert.match(res.content[0]?.text ?? '', /authentication required/i);
});
