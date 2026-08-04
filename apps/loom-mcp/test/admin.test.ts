/**
 * M5 `loom-admin` tool tests — proves the ESCALATION server denies by default
 * and only mutates under the full control stack. Every layer has a mutation-proof:
 *
 *   • DISABLED (default-OFF, §5.4.1): with enabled:false EVERY call is denied
 *     (admin_disabled). Revert → RED.
 *   • NO PAT (§5.1): a PAT credential is denied (forbidden_principal), even with
 *     admin scope. Revert `rejectPat` → RED.
 *   • ADMIN SCOPE (§5.4a): a read-write (non-admin) cookie is denied
 *     (forbidden_not_admin). Revert `requireAdmin`/scope floor → RED.
 *   • DRY-RUN (§5.4b): an authorized admin call with apply omitted issues NO
 *     backend request and audits mutation:'planned' + the TARGET principal.
 *     Revert the dry-run guard → the "no write" assertion goes RED.
 *   • APPLY: apply:true issues exactly one request to the real admin route and
 *     audits mutation:'applied' + target.
 *
 * The SDK client is a REAL `LoomClient` on a recording stub fetch (cookie mode),
 * so "no write on dry-run / deny" is proven behaviorally.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoomClient } from '@csa-loom/sdk';
import { buildToolHandler } from '../src/core/tool.js';
import { adminTools } from '../src/servers/loom-admin/tools.js';
import { adminAuthz } from '../src/servers/loom-admin/server.js';
import type { AuthContext, AuditEvent, ToolSpec, TokenScope } from '../src/core/types.js';

interface Call {
  method: string;
  url: string;
}

function recordingFetch(calls: Call[]): typeof fetch {
  return async (input, init): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url });
    return new Response(JSON.stringify({ ok: true, roleAssignment: { id: 'ra-1' }, grant: { id: 'g-1' }, gateId: 'x' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

const anyMutation = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');

/** A cookie caller at the given scope (admin server rejects PATs; cookie is the admin path). */
function cookieAuth(scope: TokenScope, fetchImpl: typeof fetch): AuthContext {
  return {
    mode: 'cookie',
    principal: 'session',
    scope,
    apiUrl: 'https://loom.test',
    client: new LoomClient({ baseUrl: 'https://loom.test', cookie: 'sess', fetch: fetchImpl }),
  };
}

function patAuth(scope: TokenScope, fetchImpl: typeof fetch): AuthContext {
  return {
    mode: 'pat',
    principal: 'pat_TESTID',
    scope,
    apiUrl: 'https://loom.test',
    client: new LoomClient({ baseUrl: 'https://loom.test', token: 'loom_pat_TESTID_secret', fetch: fetchImpl }),
  };
}

function tool(name: string): ToolSpec {
  const t = adminTools().find((s) => s.name === name);
  assert.ok(t, `tool ${name} exists`);
  return t;
}

/** Build a handler with the M5 policy at the given enabled flag. */
function adminHandler(name: string, auth: AuthContext | null, enabled: boolean, calls: Call[], events: AuditEvent[]) {
  return buildToolHandler(tool(name), {
    server: 'loom-admin',
    auth,
    authz: adminAuthz(enabled),
    audit: (e) => events.push(e),
  });
}

const GRANT_ARGS = { capabilityId: 'admin.permissions', principalId: 'oid-42', role: 'Reader', apply: true };

test('every M5 tool is a mutation requiring admin scope', () => {
  const tools = adminTools();
  assert.equal(tools.length, 3);
  for (const t of tools) {
    assert.equal(t.readOnly, false, `${t.name} must be a mutation`);
    assert.equal(t.minScope, 'admin', `${t.name} must require admin`);
  }
  assert.deepEqual(tools.map((t) => t.name).sort(), ['loom.admin.gate.resolve', 'loom.admin.grant', 'loom.admin.role.assign']);
});

test('DEFAULT-OFF: when disabled, every admin call is denied (admin_disabled) with no backend request', async () => {
  const calls: Call[] = [];
  const events: AuditEvent[] = [];
  const h = adminHandler('loom.admin.grant', cookieAuth('admin', recordingFetch(calls)), /* enabled */ false, calls, events);
  const res = await h(GRANT_ARGS);
  assert.equal(res.isError, true);
  assert.match(res.content[0]?.text ?? '', /disabled|LOOM_MCP_ADMIN_ENABLED/);
  assert.equal(anyMutation(calls).length, 0, 'a disabled server issues no backend request');
  assert.equal(events[0]?.decision, 'deny');
  assert.equal(events[0]?.reason, 'admin_disabled');
});

test('NO PAT: a PAT credential is refused even with admin scope (forbidden_principal)', async () => {
  const calls: Call[] = [];
  const events: AuditEvent[] = [];
  const h = adminHandler('loom.admin.grant', patAuth('admin', recordingFetch(calls)), true, calls, events);
  const res = await h(GRANT_ARGS);
  assert.equal(res.isError, true);
  assert.match(res.content[0]?.text ?? '', /does not accept .*PAT|forbidden_principal/i);
  assert.equal(anyMutation(calls).length, 0);
  assert.equal(events[0]?.decision, 'deny');
  assert.equal(events[0]?.reason, 'forbidden_principal');
});

test('ADMIN SCOPE: a read-write (non-admin) caller is refused (forbidden_not_admin)', async () => {
  const calls: Call[] = [];
  const events: AuditEvent[] = [];
  const h = adminHandler('loom.admin.role.assign', cookieAuth('read-write', recordingFetch(calls)), true, calls, events);
  const res = await h({ workspaceId: 'ws-1', principalId: 'oid-9', principalType: 'User', displayName: 'Ada', role: 'Viewer', apply: true });
  assert.equal(res.isError, true);
  assert.match(res.content[0]?.text ?? '', /requires an admin credential|forbidden_not_admin/i);
  assert.equal(anyMutation(calls).length, 0, 'a refused admin call never reaches the backend');
  assert.equal(events[0]?.decision, 'deny');
  assert.equal(events[0]?.reason, 'forbidden_not_admin');
});

test('DRY-RUN (default): an admin caller plans WITHOUT mutating; audit has mutation:planned + target', async () => {
  const calls: Call[] = [];
  const events: AuditEvent[] = [];
  const h = adminHandler('loom.admin.grant', cookieAuth('admin', recordingFetch(calls)), true, calls, events);
  // apply omitted → dry-run.
  const res = await h({ capabilityId: 'admin.permissions', principalId: 'oid-42', role: 'Reader' });
  assert.notEqual(res.isError, true, 'dry-run should succeed');
  assert.match(res.content[0]?.text ?? '', /dry-run/);
  assert.equal(anyMutation(calls).length, 0, 'NO backend request on an admin dry-run');
  assert.equal(events[0]?.decision, 'allow');
  assert.equal(events[0]?.mutation, 'planned');
  assert.equal(events[0]?.target, 'oid-42', 'audit records the target principal (§5.4d)');
});

test('APPLY: an admin caller mutates via the real route; audit has mutation:applied + target', async () => {
  const calls: Call[] = [];
  const events: AuditEvent[] = [];
  const h = adminHandler('loom.admin.role.assign', cookieAuth('admin', recordingFetch(calls)), true, calls, events);
  const res = await h({ workspaceId: 'ws-1', principalId: 'oid-9', principalType: 'User', displayName: 'Ada', role: 'Member', apply: true });
  assert.notEqual(res.isError, true);
  assert.match(res.content[0]?.text ?? '', /applied/);
  const mut = anyMutation(calls);
  assert.equal(mut.length, 1, 'exactly one backend request on apply');
  assert.equal(mut[0]?.method, 'POST');
  assert.match(mut[0]?.url ?? '', /\/api\/workspaces\/ws-1\/role-assignments$/);
  assert.equal(events[0]?.mutation, 'applied');
  assert.equal(events[0]?.target, 'oid-9');
});

test('gate.resolve dry-run surfaces only KEYS (not values) and writes nothing', async () => {
  const calls: Call[] = [];
  const events: AuditEvent[] = [];
  const h = adminHandler('loom.admin.gate.resolve', cookieAuth('admin', recordingFetch(calls)), true, calls, events);
  const res = await h({ gateId: 'ai-search', values: { LOOM_AI_SEARCH_KEY: 'super-secret-value' } });
  const text = res.content[0]?.text ?? '';
  assert.match(text, /dry-run/);
  assert.ok(!text.includes('super-secret-value'), 'the dry-run plan must not echo submitted values');
  assert.match(text, /LOOM_AI_SEARCH_KEY/, 'but it does show the key names');
  assert.equal(anyMutation(calls).length, 0);
  assert.equal(events[0]?.target, 'ai-search');
});

test('anonymous is denied on the admin server (even when enabled)', async () => {
  const events: AuditEvent[] = [];
  const h = adminHandler('loom.admin.grant', null, true, [], events);
  const res = await h(GRANT_ARGS);
  assert.equal(res.isError, true);
  assert.match(res.content[0]?.text ?? '', /authentication required/i);
  assert.equal(events[0]?.decision, 'deny');
});
