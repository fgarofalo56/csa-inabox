import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ensure, run, endpointsFor, classify, GraphError,
  ESTATE_POWER_ROLE_ID, ESTATE_POWER_ROLE_VALUE, MAX_ATTEMPTS,
  EXIT_OK, EXIT_FAILED, EXIT_PERMISSION, EXIT_TRANSIENT, EXIT_USAGE,
} from '../ensure-estate-power-role.mjs';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const APP_OBJ = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CONSOLE_SP = 'bbbbbbbb-0000-4000-8000-00000000000b';
const DEPLOY_APPID = '22222222-2222-4222-8222-222222222222';
const DEPLOY_SP = 'cccccccc-0000-4000-8000-00000000000c';

/**
 * In-memory Graph. `log` records every call as "METHOD path-without-query";
 * writes are the non-GET entries. Options let a test break one behaviour.
 */
function fakeGraph({ appRoles = [], consoleSpExists = true, assignments = [], failOn = null, dropRoleOnPatch = false, dropAssignOnPost = false } = {}) {
  const state = { appRoles: [...appRoles], consoleSpExists, assignments: [...assignments] };
  const log = [];
  const io = {
    log: () => {},
    sleep: async () => {},
    cloud: () => 'AzureUSGovernment',
    identity: () => ({ type: 'servicePrincipal', name: DEPLOY_APPID }),
    writeOutputs: () => {},
    async graph(host, method, path, body) {
      log.push(`${method} ${path.split('?')[0]}`);
      if (failOn) {
        const r = failOn(method, path, log);
        if (r) throw r;
      }
      if (method === 'GET' && path.startsWith('/applications')) {
        return { json: { value: [{ id: APP_OBJ, appId: CLIENT, appRoles: state.appRoles }] } };
      }
      if (method === 'PATCH' && path === `/applications/${APP_OBJ}`) {
        if (!dropRoleOnPatch) state.appRoles = body.appRoles;
        return { json: null };
      }
      if (method === 'GET' && path.includes(`appId eq '${CLIENT}'`)) {
        return { json: { value: state.consoleSpExists ? [{ id: CONSOLE_SP, appId: CLIENT }] : [] } };
      }
      if (method === 'POST' && path === '/servicePrincipals') {
        state.consoleSpExists = true;
        return { json: { id: CONSOLE_SP } };
      }
      if (method === 'GET' && path.includes(`appId eq '${DEPLOY_APPID}'`)) {
        return { json: { value: [{ id: DEPLOY_SP, appId: DEPLOY_APPID }] } };
      }
      if (method === 'GET' && path === `/servicePrincipals/${DEPLOY_SP}/appRoleAssignments`) {
        return { json: { value: state.assignments } };
      }
      if (method === 'POST' && path === `/servicePrincipals/${DEPLOY_SP}/appRoleAssignments`) {
        if (!dropAssignOnPost) state.assignments.push({ resourceId: body.resourceId, appRoleId: body.appRoleId });
        return { json: {} };
      }
      throw new Error(`fake graph: unexpected ${method} ${path}`);
    },
  };
  return { io, state, log, writes: () => log.filter((l) => !l.startsWith('GET ')) };
}

const goodRole = (id = ESTATE_POWER_ROLE_ID) => ({
  id, value: ESTATE_POWER_ROLE_VALUE, allowedMemberTypes: ['Application'], isEnabled: true,
  displayName: 'x', description: 'x',
});

test('first run creates the role with the committed id, then assigns it; second run makes ZERO writes', async () => {
  // Breaks if: the script writes when everything already converged (second-run writes != 0).
  const g = fakeGraph({ consoleSpExists: false });
  const first = await ensure({ clientId: CLIENT }, g.io);
  assert.equal(first.roleId, ESTATE_POWER_ROLE_ID);
  assert.deepEqual(g.writes(), [
    `PATCH /applications/${APP_OBJ}`,
    'POST /servicePrincipals',
    `POST /servicePrincipals/${DEPLOY_SP}/appRoleAssignments`,
  ]);
  g.log.length = 0;
  const second = await ensure({ clientId: CLIENT }, g.io);
  assert.equal(second.wrote, 0);
  assert.deepEqual(g.writes(), [], 'second run must issue no PATCH/POST');
});

test('an existing role with the same value but a DIFFERENT id is reused, not duplicated and not re-id-ed', async () => {
  // Breaks if: the script appends its own id (two Estate.Power roles) or rewrites the id.
  const OTHER = 'deadbeef-dead-4eef-8eef-deadbeefdead';
  const g = fakeGraph({ appRoles: [goodRole(OTHER)] });
  const r = await ensure({ clientId: CLIENT }, g.io);
  assert.equal(r.roleId, OTHER);
  assert.equal(g.state.appRoles.filter((x) => x.value === ESTATE_POWER_ROLE_VALUE).length, 1);
  assert.deepEqual(g.state.assignments, [{ resourceId: CONSOLE_SP, appRoleId: OTHER }]);
  assert.equal(g.writes().filter((w) => w.startsWith('PATCH')).length, 0);
});

test('a disabled same-value role is repaired in place (id kept)', async () => {
  // Breaks if: a disabled/User-typed role is accepted as-is.
  const g = fakeGraph({ appRoles: [{ ...goodRole(), isEnabled: false, allowedMemberTypes: ['User'] }] });
  await ensure({ clientId: CLIENT }, g.io);
  const role = g.state.appRoles.find((x) => x.value === ESTATE_POWER_ROLE_VALUE);
  assert.equal(role.isEnabled, true);
  assert.deepEqual(role.allowedMemberTypes, ['Application']);
  assert.equal(role.id, ESTATE_POWER_ROLE_ID);
});

test('read-back mismatch FAILS: a PATCH that Graph accepted but did not persist', async () => {
  // Breaks if: success is taken from the write returning 2xx instead of the re-read.
  const g = fakeGraph({ dropRoleOnPatch: true });
  await assert.rejects(ensure({ clientId: CLIENT }, g.io), /read-back FAILED: the Estate\.Power appRole/);
});

test('read-back mismatch FAILS: an assignment POST that did not persist', async () => {
  // Breaks if: the assignment is not re-listed after the POST.
  const g = fakeGraph({ appRoles: [goodRole()], dropAssignOnPost: true });
  await assert.rejects(ensure({ clientId: CLIENT }, g.io), /read-back FAILED: no appRoleAssignment/);
});

test('403 yields exit 3 with the named Graph permissions and consent owner, and is NOT retried', async () => {
  // Breaks if: a 403 is retried (call count > 1) or the remediation omits the permission names.
  const g = fakeGraph({ failOn: (m) => (m === 'PATCH' ? new GraphError(403, 'Insufficient privileges') : null) });
  const lines = [];
  g.io.log = (l) => lines.push(l);
  const code = await run(['--client-id', CLIENT], g.io);
  assert.equal(code, EXIT_PERMISSION);
  const text = lines.join('\n');
  assert.match(text, /AppRoleAssignment\.ReadWrite\.All/);
  assert.match(text, /Application\.ReadWrite\.All/);
  assert.match(text, /Global Administrator or Privileged Role Administrator/);
  assert.equal(g.log.filter((l) => l.startsWith('PATCH')).length, 1, 'permission failures are not retried');
});

test('transient 503 is retried and then succeeds; persistent 503 exits 4 after exactly MAX_ATTEMPTS', async () => {
  // Breaks if: transient errors are not retried, or retried without bound.
  let n = 0;
  const flaky = fakeGraph({ failOn: (m) => (m === 'PATCH' && n++ < 2 ? new GraphError(503, 'busy') : null) });
  assert.equal(await run(['--client-id', CLIENT], flaky.io), EXIT_OK);
  assert.equal(flaky.log.filter((l) => l.startsWith('PATCH')).length, 3);

  const dead = fakeGraph({ failOn: (m) => (m === 'PATCH' ? new GraphError(503, 'busy') : null) });
  assert.equal(await run(['--client-id', CLIENT], dead.io), EXIT_TRANSIENT);
  assert.equal(dead.log.filter((l) => l.startsWith('PATCH')).length, MAX_ATTEMPTS);
});

test('a 400 defect is not retried and exits 1', async () => {
  // Breaks if: defects are lumped in with transient retry.
  const g = fakeGraph({ failOn: (m) => (m === 'PATCH' ? new GraphError(400, 'Invalid value') : null) });
  assert.equal(await run(['--client-id', CLIENT], g.io), EXIT_FAILED);
  assert.equal(g.log.filter((l) => l.startsWith('PATCH')).length, 1);
});

test('a non-service-principal login is refused (nothing assigned)', async () => {
  // Breaks if: a user identity is silently accepted and an assignment attempted.
  const g = fakeGraph({ appRoles: [goodRole()] });
  g.io.identity = () => ({ type: 'user', name: 'someone@example.com' });
  assert.equal(await run(['--client-id', CLIENT], g.io), EXIT_FAILED);
  assert.deepEqual(g.writes(), []);
});

test('sovereign cloud picks the .us hosts; Commercial picks the commercial hosts; unknown fails closed', () => {
  // Breaks if: the Gov branch returns graph.microsoft.com (or vice versa) or an unknown cloud defaults to Commercial.
  assert.equal(endpointsFor('AzureUSGovernment').graph, 'https://graph.microsoft.us');
  assert.equal(endpointsFor('AzureUSGovernment').login, 'https://login.microsoftonline.us');
  assert.equal(endpointsFor('AzureCloud').graph, 'https://graph.microsoft.com');
  assert.equal(endpointsFor('AzureCloud').login, 'https://login.microsoftonline.com');
  assert.throws(() => endpointsFor('AzureChinaCloud'), /unsupported or unknown Azure cloud/);
  assert.throws(() => endpointsFor(''), /unsupported or unknown Azure cloud/);
});

test('the host handed to the Graph client is the one for the active cloud', async () => {
  // Breaks if: ensure() ignores io.cloud() when calling Graph.
  const hosts = new Set();
  for (const [cloud, want] of [['AzureUSGovernment', 'https://graph.microsoft.us'], ['AzureCloud', 'https://graph.microsoft.com']]) {
    const g = fakeGraph({ appRoles: [goodRole()], assignments: [{ resourceId: CONSOLE_SP, appRoleId: ESTATE_POWER_ROLE_ID }] });
    g.io.cloud = () => cloud;
    const inner = g.io.graph;
    g.io.graph = (host, ...rest) => { hosts.add(`${cloud}=${host}`); return inner(host, ...rest); };
    await ensure({ clientId: CLIENT }, g.io);
    assert.ok(hosts.has(`${cloud}=${want}`), `${cloud} must call ${want}`);
  }
  assert.equal(hosts.size, 2);
});

test('classify and usage', async () => {
  // Breaks if: 401/403 stop being permission, 429/5xx/network stop being transient, or a bad GUID is accepted.
  assert.equal(classify(403), 'permission');
  assert.equal(classify(401), 'permission');
  assert.equal(classify(429), 'transient');
  assert.equal(classify(0), 'transient');
  assert.equal(classify(400, 'Invalid value'), 'defect');
  assert.equal(classify(400, 'Permission being assigned was not found on application'), 'transient');
  assert.equal(await run(['--client-id', 'not-a-guid'], { log: () => {} }), EXIT_USAGE);
});
