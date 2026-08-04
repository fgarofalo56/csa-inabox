/**
 * M1 tool tests — proves the tools actually call the Loom SDK, return real data,
 * scrub secrets end-to-end, audit each call, and deny anonymous callers.
 *
 * The SDK client is a REAL `LoomClient` (from `@csa-loom/sdk`) wired to a stub
 * `fetch`, so the full path runs: tool.run → client.workspaces.list → HTTP
 * transport → stub → parsed body → core scrub → MCP result. No network, no mocks
 * of the SDK itself. A tool that returned `[]` or bypassed the SDK would fail the
 * "real data" assertion; a tool that leaked the injected secret would fail the
 * scrub assertion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoomClient } from '@csa-loom/sdk';
import { buildToolHandler } from '../src/core/tool.js';
import { authorize } from '../src/core/authz.js';
import { catalogTools } from '../src/servers/loom-catalog/tools.js';
import type { AuthContext, AuditEvent, ToolSpec } from '../src/core/types.js';

const PAT = 'loom_pat_TESTID_secretsecrethalf';
const CONN = 'AccountKey=INJECTEDSECRETKEY==;EndpointSuffix=core.windows.net';

/** A stub fetch that serves the workspace-list body with an injected secret. */
const stubFetch: typeof fetch = async (input): Promise<Response> => {
  const url = String(input);
  if (url.includes('/api/workspaces')) {
    return new Response(
      JSON.stringify([
        { id: 'ws-1', name: 'Analytics', description: 'team', connectionString: CONN, note: `owner ${PAT}` },
        { id: 'ws-2', name: 'Governance', description: 'gov' },
      ]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
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
  const t = catalogTools().find((s) => s.name === name);
  assert.ok(t, `tool ${name} exists`);
  return t;
}

test('loom.workspaces.list returns real SDK data through the pipeline', async () => {
  const events: AuditEvent[] = [];
  const handler = buildToolHandler(tool('loom.workspaces.list'), {
    server: 'loom-catalog',
    auth: patAuth(),
    audit: (e) => events.push(e),
  });

  const res = await handler({});
  const text = res.content[0]?.text ?? '';

  assert.notEqual(res.isError, true, 'should succeed');
  assert.match(text, /Analytics/, 'real workspace name flows through (SDK was actually called)');
  assert.match(text, /Governance/);

  // …but the injected secrets are scrubbed.
  assert.ok(!text.includes('INJECTEDSECRETKEY'), 'connection-string account key must be scrubbed');
  assert.ok(!text.includes('secretsecrethalf'), 'embedded PAT must be scrubbed');

  // audit fired with an allow/ok and a count.
  assert.equal(events.length, 1);
  assert.equal(events[0]?.decision, 'allow');
  assert.equal(events[0]?.outcome, 'ok');
  assert.equal(events[0]?.count, 2);
  assert.equal(events[0]?.tool, 'loom.workspaces.list');
  // audit records only a hash of args, never the raw args.
  assert.match(events[0]?.args_hash ?? '', /^[0-9a-f]{16}$/);
});

test('anonymous callers are denied — no tool runs without a credential', async () => {
  const events: AuditEvent[] = [];
  const handler = buildToolHandler(tool('loom.workspaces.list'), {
    server: 'loom-catalog',
    auth: null,
    audit: (e) => events.push(e),
  });
  const res = await handler({});
  assert.equal(res.isError, true);
  assert.match(res.content[0]?.text ?? '', /authentication required/i);
  assert.equal(events[0]?.decision, 'deny');
  assert.equal(events[0]?.reason, 'unauthenticated');
});

test('every M1 tool is read-only and read-only-scoped', () => {
  const tools = catalogTools();
  assert.equal(tools.length, 4);
  for (const t of tools) {
    assert.equal(t.readOnly, true, `${t.name} must be read-only`);
    assert.equal(t.minScope, 'read-only', `${t.name} must require only read-only`);
  }
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['loom.catalog.find', 'loom.item.get', 'loom.item.list', 'loom.workspaces.list'],
  );
});

test('the authz gate refuses a hypothetical non-read-only tool', () => {
  const mutating: ToolSpec = { ...tool('loom.workspaces.list'), readOnly: false };
  const d = authorize(mutating, patAuth());
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, 'forbidden_mutation');
});

test('an upstream API error is normalized (no stack trace leak)', async () => {
  const failFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ ok: false, error: 'boom', code: 'server_error' }), { status: 500 });
  const auth: AuthContext = {
    mode: 'pat',
    principal: 'pat_TESTID',
    scope: 'read-only',
    apiUrl: 'https://loom.test',
    client: new LoomClient({ baseUrl: 'https://loom.test', token: PAT, fetch: failFetch }),
  };
  const handler = buildToolHandler(tool('loom.workspaces.list'), { server: 'loom-catalog', auth, audit: () => {} });
  const res = await handler({});
  assert.equal(res.isError, true);
  const text = res.content[0]?.text ?? '';
  assert.match(text, /"ok": false/);
  assert.ok(!text.includes('at '), 'no stack-trace frames in the normalized error');
});
