import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ensure, run, GraphError, validateSuppliedApp,
  ESTATE_POWER_ROLE_ID, ESTATE_POWER_ROLE_VALUE,
  EXIT_OK, EXIT_FAILED, EXIT_PERMISSION, EXIT_USAGE,
} from '../ensure-estate-power-role.mjs';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const APP_OBJ = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CONSOLE_SP = 'bbbbbbbb-0000-4000-8000-00000000000b';
const DEPLOY_APPID = '22222222-2222-4222-8222-222222222222';
const DEPLOY_SP = 'cccccccc-0000-4000-8000-00000000000c';
const NAME = 'CSA Loom Console (Gov)';

const goodRole = () => ({
  id: ESTATE_POWER_ROLE_ID, value: ESTATE_POWER_ROLE_VALUE, allowedMemberTypes: ['Application'], isEnabled: true,
});

/** In-memory Graph for the operator's real shape: app + SP + role + assignment already exist. */
function fake({ app = {}, appRoles = [goodRole()], assignments = [{ resourceId: CONSOLE_SP, appRoleId: ESTATE_POWER_ROLE_ID }], failOn = null } = {}) {
  const state = { appRoles: [...appRoles], assignments: [...assignments] };
  const log = [];
  const appBody = () => ({ id: APP_OBJ, appId: CLIENT, displayName: NAME, signInAudience: 'AzureADMyOrg', identifierUris: [], appRoles: state.appRoles, ...app });
  const io = {
    log: () => {}, sleep: async () => {}, cloud: () => 'AzureUSGovernment', writeOutputs: () => {},
    identity: () => ({ type: 'servicePrincipal', name: DEPLOY_APPID }),
    async graph(host, method, path, body) {
      log.push(`${method} ${path.split('?')[0]}`);
      if (failOn) { const r = failOn(method, path); if (r) throw r; }
      if (method === 'GET' && (path.startsWith(`/applications(appId='${CLIENT}')`) || path.startsWith(`/applications/${APP_OBJ}`))) return { json: appBody() };
      if (method === 'GET' && path.startsWith(`/servicePrincipals(appId='${CLIENT}')`)) return { json: { id: CONSOLE_SP, appId: CLIENT } };
      if (method === 'GET' && path.startsWith(`/servicePrincipals(appId='${DEPLOY_APPID}')`)) return { json: { id: DEPLOY_SP, appId: DEPLOY_APPID } };
      if (method === 'GET' && path === `/servicePrincipals/${DEPLOY_SP}/appRoleAssignments`) return { json: { value: state.assignments } };
      if (method === 'PATCH' && path === `/applications/${APP_OBJ}`) { state.appRoles = body.appRoles; return { json: null }; }
      if (method === 'POST' && path === `/servicePrincipals/${DEPLOY_SP}/appRoleAssignments`) {
        state.assignments.push({ resourceId: body.resourceId, appRoleId: body.appRoleId }); return { json: {} };
      }
      throw new Error(`fake graph: unexpected ${method} ${path}`);
    },
  };
  const lists = () => log.filter((l) => /^GET \/(applications|servicePrincipals)$/.test(l));
  return { io, state, log, lists, writes: () => log.filter((l) => !l.startsWith('GET ')) };
}

const SUPPLIED = { clientId: CLIENT, supplied: true };

test('supplied: never LISTS applications or service principals, and an already-converged estate makes ZERO writes', async () => {
  // Breaks if: supplied mode falls back to /applications?$filter or /servicePrincipals?$filter
  // (lists() would be non-empty: that is the call the deploy SP is forbidden to make), or a write is issued.
  const g = fake();
  const r = await ensure({ ...SUPPLIED }, g.io);
  assert.deepEqual(g.lists(), [], `list endpoints called: ${g.lists()}`);
  assert.ok(g.log.includes(`GET /applications(appId='${CLIENT}')`), 'must read the app by alternate key');
  assert.equal(r.wrote, 0);
  assert.deepEqual(g.writes(), []);
});

test('control: discover mode DOES list (so the lists() probe can see a list call)', async () => {
  // Breaks if: lists() could never match anything. The discover path uses filters; reuse the supplied
  // fake with filter support added so a positive control exists for the probe above.
  const g = fake();
  const inner = g.io.graph;
  g.io.graph = async (h, m, p, b) => {
    if (m === 'GET' && p.startsWith('/applications?$filter')) { g.log.push('GET /applications'); return { json: { value: [{ id: APP_OBJ, appId: CLIENT, appRoles: g.state.appRoles }] } }; }
    if (m === 'GET' && p.startsWith('/servicePrincipals?$filter')) {
      g.log.push('GET /servicePrincipals');
      return { json: { value: [p.includes(CLIENT) ? { id: CONSOLE_SP, appId: CLIENT } : { id: DEPLOY_SP, appId: DEPLOY_APPID }] } };
    }
    return inner(h, m, p, b);
  };
  await ensure({ clientId: CLIENT }, g.io);
  assert.ok(g.lists().length >= 2, 'discover mode must issue list calls');
});

test('supplied: an app with no identifier URI is addressed by its BARE app id; one with api://<id> keeps api://', async () => {
  // Breaks if: the audience is hard-coded api://<id> (the operator's hand-set Gov variable is the bare id).
  const written = [];
  const bare = fake();
  bare.io.writeOutputs = (pairs) => written.push(Object.fromEntries(pairs));
  await ensure({ ...SUPPLIED }, bare.io);
  assert.equal(written[0].console_audience, CLIENT);
  const uri = fake({ app: { identifierUris: [`api://${CLIENT}`] } });
  uri.io.writeOutputs = (pairs) => written.push(Object.fromEntries(pairs));
  await ensure({ ...SUPPLIED }, uri.io);
  assert.equal(written[1].console_audience, `api://${CLIENT}`);
});

test('supplied: validation rejects each wrong app, naming the observed value, with zero writes', async () => {
  // Breaks if: the app is not validated. Each row is a DIFFERENT wrong input: dropping any one check turns its row green.
  const rows = [
    [{ appId: '99999999-9999-4999-8999-999999999999' }, SUPPLIED, /appId read back is '9{8}-/],
    [{ id: 'dddddddd-0000-4000-8000-00000000000d' }, { ...SUPPLIED, objectId: APP_OBJ }, /object id read back is 'dddddddd/],
    [{ signInAudience: 'AzureADMultipleOrgs' }, SUPPLIED, /signInAudience is 'AzureADMultipleOrgs'/],
    [{ displayName: 'Some Other App' }, { ...SUPPLIED, expectedName: NAME }, /display name is 'Some Other App'/],
  ];
  for (const [app, opts, re] of rows) {
    const g = fake({ app });
    await assert.rejects(ensure(opts, g.io), re);
    assert.deepEqual(g.writes(), [], `no write may follow a failed validation (${JSON.stringify(app)})`);
  }
  assert.deepEqual(validateSuppliedApp({ appId: CLIENT, id: APP_OBJ, displayName: NAME, signInAudience: 'AzureADMyOrg' }, { ...SUPPLIED, objectId: APP_OBJ, expectedName: NAME }), []);
});

test('supplied: object id given -> read by object id; the read still checks the appId', async () => {
  // Breaks if: --object-id is ignored (alternate-key path used) or the appId cross-check is skipped.
  const g = fake();
  await ensure({ ...SUPPLIED, objectId: APP_OBJ }, g.io);
  assert.ok(g.log.includes(`GET /applications/${APP_OBJ}`));
  assert.ok(!g.log.some((l) => l.startsWith('GET /applications(')), 'alternate-key read must not be used when the object id is given');
});

test('supplied: 403 reading the app = could-not-read (exit 3), says existence is UNKNOWN, names the permission, never "does not exist"', async () => {
  // Breaks if: a read refusal is reported as not-found (R7), the permission is not named, or it is retried.
  const g = fake({ failOn: (m) => (m === 'GET' ? new GraphError(403, 'Insufficient privileges to complete the operation') : null) });
  const lines = [];
  g.io.log = (l) => lines.push(l);
  assert.equal(await run(['--client-id', CLIENT, '--supplied'], g.io), EXIT_PERMISSION);
  const text = lines.join('\n');
  assert.match(text, /UNKNOWN whether that app registration exists/);
  assert.match(text, /Application\.Read\.All/);
  assert.doesNotMatch(text, /does not exist|no application with/, 'a permission refusal must not be reported as not-found');
  assert.equal(g.log.length, 1, '403 is not retried');
});

test('supplied: 404 reading the app = definite not-found (exit 1), NOT retried as "not yet visible"', async () => {
  // Breaks if: the 404 text ("does not exist ...") matches classify()'s lag rule and is retried to exit 4.
  const g = fake({ failOn: (m) => (m === 'GET' ? new GraphError(404, "Resource 'x' does not exist or one of its queried reference-property objects are not present.") : null) });
  const lines = [];
  g.io.log = (l) => lines.push(l);
  assert.equal(await run(['--client-id', CLIENT, '--supplied'], g.io), EXIT_FAILED);
  assert.match(lines.join('\n'), /definite not-found, not a permission refusal/);
  assert.equal(g.log.length, 1, '404 on the supplied app is not retried');
});

test('403 on the role WRITE exits 3 with the OWNER + permission remediation and names the missing change; it is not swallowed', async () => {
  // Breaks if: a 403 on PATCH is swallowed (exit 0), retried, or reported with the generic read text.
  const g = fake({ appRoles: [], failOn: (m) => (m === 'PATCH' ? new GraphError(403, 'Insufficient privileges') : null) });
  const lines = [];
  g.io.log = (l) => lines.push(l);
  assert.equal(await run(['--client-id', CLIENT, '--supplied'], g.io), EXIT_PERMISSION);
  const text = lines.join('\n');
  assert.match(text, /REFUSED A WRITE/);
  assert.match(text, /add the Estate\.Power appRole to application aaaaaaaa-0000/);
  assert.match(text, /OWNER/);
  assert.match(text, /Application\.ReadWrite\.OwnedBy/);
  assert.match(text, /AppRoleAssignment\.ReadWrite\.All/);
  assert.equal(g.log.filter((l) => l.startsWith('PATCH')).length, 1);
});

test('403 on the assignment POST names the assignment as the missing change', async () => {
  // Breaks if: the POST 403 text is the role text (different missing change, different fix).
  const g = fake({ assignments: [], failOn: (m) => (m === 'POST' ? new GraphError(403, 'Insufficient privileges') : null) });
  const lines = [];
  g.io.log = (l) => lines.push(l);
  assert.equal(await run(['--client-id', CLIENT, '--supplied'], g.io), EXIT_PERMISSION);
  assert.match(lines.join('\n'), /assign appRole 9d4ac0e8.* to deploy service principal cccccccc-0000/);
});

test('usage: --object-id / --expected-name / --validate-only without --supplied are refused; a bad object id is refused', async () => {
  // Breaks if: those flags are silently ignored in discover mode.
  for (const extra of [['--object-id', APP_OBJ], ['--expected-name', 'x'], ['--validate-only']]) {
    assert.equal(await run(['--client-id', CLIENT, ...extra], { log: () => {} }), EXIT_USAGE, extra.join(' '));
  }
  assert.equal(await run(['--client-id', CLIENT, '--supplied', '--object-id', 'nope'], { log: () => {} }), EXIT_USAGE);
});

test('--validate-only reads and validates but writes nothing, even when the role is missing', async () => {
  // Breaks if: validate-only proceeds to the role/assignment steps (a PATCH/POST appears).
  const g = fake({ appRoles: [], assignments: [] });
  assert.equal(await run(['--client-id', CLIENT, '--supplied', '--validate-only'], g.io), EXIT_OK);
  assert.deepEqual(g.writes(), []);
  assert.deepEqual(g.lists(), []);
});
