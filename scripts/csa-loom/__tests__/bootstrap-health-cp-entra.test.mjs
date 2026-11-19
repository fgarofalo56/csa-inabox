import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ensure, run, expectedFederatedCredential, mergeAllowlist, parseArgs,
  ROLE_READER, ROLE_ADMIN, FED_CRED_NAME, ALLOWLIST_ENV, GRAPH_PERMISSIONS, GRAPH_RESOURCE_APP_ID, withGraphPermission,
  EXIT_OK, EXIT_FAILED, EXIT_USAGE, EXIT_PERMISSION, EXIT_UNSUPPORTED,
} from '../bootstrap-health-cp-entra.mjs';
import { GraphError } from '../ensure-estate-power-role.mjs';

const G = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const TENANT = G(1), AS_APP = G(2), AS_OBJ = G(3), CP_APP = G(4), CP_OBJ = G(5), CP_SP = G(6);
const CP_IDENTITY = G(7), APIM_SP = G(8), APIM_APPID = G(9), CONSOLE_CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', CONSOLE_PRINCIPAL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CI_APP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', CI_SP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

// INDEPENDENT literals (Learn graph/permissions-reference, Application ids); not derived from the module under test.
const LEARN_USER_READBASIC_ALL = '97235f07-e226-4f63-ace3-39588e11d3a1';
const LEARN_GROUPMEMBER_READ_ALL = '98830695-27a2-44f7-8c18-0c3ebc9698f6';
const LEARN_DIRECTORY_READ_ALL = '7ab1d382-f21e-4acd-a863-ba3e13f7da61';

const OPTS = {
  asClientId: AS_APP, cpAppClientId: CP_APP, tenantId: TENANT, cpIdentityPrincipalId: CP_IDENTITY,
  apimPrincipalId: APIM_SP, consoleClientId: CONSOLE_CLIENT, consolePrincipalId: CONSOLE_PRINCIPAL, ciClientId: CI_APP,
  cpAppName: 'loom-health-cp', cpResourceGroup: 'rg-x', subscription: 'sub', platform: 'containerApps',
};

/** In-memory Graph + Container App. `calls` records every request; writes() filters non-GET. */
function world({ cloud = 'AzureCloud', creds = [], appRoles = [], assignments = [], allow = '', cpSpExists = true, denyWrite = false, dropCredPost = false, rra = [], asSpExists = false, dropRraPatch = false } = {}) {
  const st = { rra, asSpExists, creds: [...creds], appRoles: [...appRoles], assignments: [...assignments], allow, envSets: [] };
  const log = [];
  const io = {
    cloud: () => cloud,
    log: (l) => log.push(l),
    sleep: async () => {},
    writeOutputs: () => {},
    getAppEnv: () => [{ name: 'OTHER', value: 'x' }, ...(st.allow === null ? [] : [{ name: ALLOWLIST_ENV, value: st.allow }])],
    setAppEnv: (_o, name, value) => { st.envSets.push([name, value]); st.allow = value; },
    async graph(host, method, path, body) {
      log.push(`${method} ${path.split('?')[0]}`);
      if (method !== 'GET' && denyWrite) throw new GraphError(403, `${method} -> 403: Insufficient privileges`);
      const p = path.split('?')[0];
      if (method === 'GET' && p === `/applications(appId='${AS_APP}')`) return { json: { id: AS_OBJ, appId: AS_APP, requiredResourceAccess: st.rra } };
      if (method === 'PATCH' && p === `/applications/${AS_OBJ}`) { if (!dropRraPatch) st.rra = body.requiredResourceAccess; return { json: {} }; }
      if (method === 'GET' && p === `/servicePrincipals(appId='${AS_APP}')`) {
        if (!st.asSpExists) throw new GraphError(404, 'not found');
        return { json: { id: G(9), appId: AS_APP } };
      }
      if (method === 'GET' && p === `/applications(appId='${CP_APP}')`) return { json: { id: CP_OBJ, appId: CP_APP, appRoles: st.appRoles } };
      if (method === 'GET' && p === `/applications/${AS_OBJ}/federatedIdentityCredentials`) return { json: { value: st.creds } };
      if (method === 'POST' && p === `/applications/${AS_OBJ}/federatedIdentityCredentials`) {
        if (!dropCredPost) st.creds.push({ id: G(0), ...body });
        return { json: {} };
      }
      if (method === 'PATCH' && p.startsWith(`/applications/${AS_OBJ}/federatedIdentityCredentials/`)) {
        const c = st.creds.find((x) => x.id === p.split('/').pop());
        Object.assign(c, body);
        return { json: {} };
      }
      if (method === 'PATCH' && p === `/applications/${CP_OBJ}`) { st.appRoles = body.appRoles; return { json: {} }; }
      if (method === 'GET' && p === `/servicePrincipals(appId='${CP_APP}')`) {
        if (!cpSpExists) throw new GraphError(404, 'not found');
        return { json: { id: CP_SP, appId: CP_APP } };
      }
      if (method === 'POST' && p === '/servicePrincipals') { if (body.appId === AS_APP) st.asSpExists = true; else cpSpExists = true; return { json: {} }; }
      if (method === 'GET' && p === `/servicePrincipals(appId='${CI_APP}')`) return { json: { id: CI_SP, appId: CI_APP } };
      if (method === 'GET' && p.startsWith("/servicePrincipals(appId='")) throw new GraphError(404, 'not found'); // any other appId: unknown to Graph
      if (method === 'GET' && p === `/servicePrincipals/${APIM_SP}`) return { json: { id: APIM_SP, appId: APIM_APPID } };
      if (method === 'GET' && p === `/servicePrincipals/${CP_SP}/appRoleAssignedTo`) return { json: { value: st.assignments } };
      if (method === 'POST' && p === `/servicePrincipals/${CP_SP}/appRoleAssignedTo`) {
        st.assignments.push({ principalId: body.principalId, appRoleId: body.appRoleId });
        return { json: {} };
      }
      throw new Error(`fake graph: unexpected ${method} ${path}`);
    },
  };
  return { io, st, log, writes: () => log.filter((l) => /^(POST|PATCH|PUT|DELETE) /.test(l)) };
}

const goodRole = (r, id = r.id) => ({ id, value: r.value, allowedMemberTypes: ['Application'], isEnabled: true });

test('first run converges everything; the second run issues ZERO writes', async () => {
  // Breaks if: any write is not guarded by a read of current state (second-run writes != 0).
  const w = world({ cpSpExists: false });
  const first = await ensure(OPTS, w.io);
  assert.deepEqual(w.writes(), [
    `PATCH /applications/${AS_OBJ}`,
    'POST /servicePrincipals',
    `POST /applications/${AS_OBJ}/federatedIdentityCredentials`,
    `PATCH /applications/${CP_OBJ}`,
    'POST /servicePrincipals',
    `POST /servicePrincipals/${CP_SP}/appRoleAssignedTo`,
    `POST /servicePrincipals/${CP_SP}/appRoleAssignedTo`,
    `POST /servicePrincipals/${CP_SP}/appRoleAssignedTo`,
  ]);
  assert.equal(first.writes, 9, '8 Graph writes (AS requiredResourceAccess, AS SP, cred, CP roles, CP SP, 3 assignments) + 1 env update');
  assert.deepEqual(w.st.assignments, [
    { principalId: APIM_SP, appRoleId: ROLE_READER.id },
    { principalId: CONSOLE_PRINCIPAL, appRoleId: ROLE_ADMIN.id },
    { principalId: CI_SP, appRoleId: ROLE_ADMIN.id },
  ]);
  w.log.length = 0; w.st.envSets.length = 0;
  const second = await ensure(OPTS, w.io);
  assert.equal(second.writes, 0);
  assert.deepEqual(w.writes(), []);
  assert.deepEqual(w.st.envSets, []);
});

test('Reader goes to the APIM gateway and Admin to the Console, not the reverse', async () => {
  // Breaks if: the two roles are swapped (APIM would get Admin, Console only Reader).
  const w = world();
  await ensure(OPTS, w.io);
  const byPrincipal = Object.fromEntries(w.st.assignments.map((a) => [a.principalId, a.appRoleId]));
  assert.equal(byPrincipal[APIM_SP], ROLE_READER.id);
  assert.equal(byPrincipal[CONSOLE_PRINCIPAL], ROLE_ADMIN.id);
  assert.notEqual(ROLE_READER.id, ROLE_ADMIN.id);
});

test('Commercial credential uses login.microsoftonline.com + api://AzureADTokenExchange; GCC-High the .us pair', async () => {
  // Breaks if: Gov reuses the Commercial issuer or audience (the token exchange would be refused).
  const c = world({ cloud: 'AzureCloud' });
  await ensure(OPTS, c.io);
  assert.equal(c.st.creds[0].issuer, `https://login.microsoftonline.com/${TENANT}/v2.0`);
  assert.deepEqual(c.st.creds[0].audiences, ['api://AzureADTokenExchange']);
  assert.equal(c.st.creds[0].subject, CP_IDENTITY);
  const g = world({ cloud: 'AzureUSGovernment' });
  await ensure(OPTS, g.io);
  assert.equal(g.st.creds[0].issuer, `https://login.microsoftonline.us/${TENANT}/v2.0`);
  assert.deepEqual(g.st.creds[0].audiences, ['api://AzureADTokenExchangeUSGov']);
});

test('an unsupported cloud (GCC is not a value) fails closed with zero calls', async () => {
  // Breaks if: an unknown cloud falls back to Commercial endpoints.
  const w = world({ cloud: 'GCC' });
  const code = await run(['--as-client-id', AS_APP, '--cp-app-client-id', CP_APP, '--tenant-id', TENANT, '--ci-client-id', CI_APP, '--cp-identity-principal-id', CP_IDENTITY, '--cp-app-name', 'a', '--cp-resource-group', 'b', '--subscription', 'c'], w.io);
  assert.equal(code, EXIT_FAILED);
  assert.deepEqual(w.log.filter((l) => /^(GET|POST|PATCH) /.test(l)), []);
  assert.match(w.log.join('\n'), /unsupported or unknown Azure cloud 'GCC'/);
});

test('the issuer/subject/audience rule matches control-plane.bicep (lifted from source)', () => {
  // Breaks if: control-plane.bicep changes the issuer shape or either audience literal and this script does not follow.
  const bicep = readFileSync(fileURLToPath(new URL('../../../platform/fiab/bicep/modules/health/control-plane.bicep', import.meta.url)), 'utf8');
  const block = bicep.slice(bicep.indexOf('output authFederatedCredential object'));
  assert.ok(block.includes("issuer: '${environment().authentication.loginEndpoint}${entraTenantId}/v2.0'"));
  assert.ok(block.includes('subject: cpIdentity.properties.principalId'));
  const lits = [...block.slice(0, 600).matchAll(/'(api:\/\/AzureADTokenExchange[A-Za-z]*)'/g)].map((m) => m[1]).sort();
  const ours = [expectedFederatedCredential('AzureCloud', TENANT, 's').audiences[0], expectedFederatedCredential('AzureUSGovernment', TENANT, 's').audiences[0]].sort();
  assert.deepEqual(lits, ours);
});

test('a same-named credential with a stale subject is PATCHed, an unrelated credential is untouched and none is duplicated', async () => {
  // Breaks if: the script POSTs a second credential, or rewrites/deletes the unrelated one.
  const other = { id: 'other-1', name: 'something-else', issuer: 'https://x', subject: 'y', audiences: ['api://AzureADTokenExchange'] };
  const stale = { id: 'ours-1', name: FED_CRED_NAME, issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`, subject: G(5), audiences: ['api://AzureADTokenExchange'] };
  const w = world({ creds: [other, stale] });
  await ensure(OPTS, w.io);
  assert.equal(w.st.creds.length, 2);
  assert.equal(w.st.creds.find((c) => c.id === 'ours-1').subject, CP_IDENTITY);
  assert.deepEqual(w.st.creds.find((c) => c.id === 'other-1'), other);
  assert.ok(w.writes().includes(`PATCH /applications/${AS_OBJ}/federatedIdentityCredentials/ours-1`));
});

test('an existing role with the same value but another id is reused, not duplicated', async () => {
  // Breaks if: the script appends its own id (two HealthCP.Reader roles) or assigns its literal id.
  const OTHER = 'deadbeef-dead-4eef-8eef-deadbeefdead';
  const w = world({ appRoles: [goodRole(ROLE_READER, OTHER), goodRole(ROLE_ADMIN)] });
  await ensure(OPTS, w.io);
  assert.equal(w.st.appRoles.filter((r) => r.value === ROLE_READER.value).length, 1);
  assert.equal(w.st.assignments.find((a) => a.principalId === APIM_SP).appRoleId, OTHER);
  assert.ok(!w.writes().includes(`PATCH /applications/${CP_OBJ}`), 'roles already fine: no PATCH');
});

test('a disabled HealthCP.Reader is re-enabled and other app roles are preserved', async () => {
  // Breaks if: the PATCH replaces appRoles with only ours (drops Estate-style roles) or leaves isEnabled false.
  const keep = { id: G(2), value: 'Unrelated.Role', allowedMemberTypes: ['Application'], isEnabled: true };
  const w = world({ appRoles: [keep, { ...goodRole(ROLE_READER), isEnabled: false }] });
  await ensure(OPTS, w.io);
  assert.ok(w.st.appRoles.some((r) => r.value === 'Unrelated.Role'));
  assert.equal(w.st.appRoles.find((r) => r.value === ROLE_READER.value).isEnabled, true);
});

test('allowlist is UNIONED: existing ids survive, ours are added once, nothing is removed', async () => {
  // Breaks if: the env var is overwritten with only ours, or an id already present is duplicated.
  const w = world({ allow: `${CONSOLE_CLIENT.toUpperCase()}, ${G(5)}` });
  await ensure(OPTS, w.io);
  const final = w.st.allow.split(',');
  assert.deepEqual(final.map((s) => s.toLowerCase()), [CONSOLE_CLIENT, G(5), APIM_APPID, CI_APP]);
  assert.equal(final[0], CONSOLE_CLIENT.toUpperCase(), 'existing spelling preserved');
  assert.deepEqual(mergeAllowlist('a,,A, b', ['b', 'c']), ['a', 'b', 'c']);
});

test('--dry-run reads everything and writes NOTHING, listing what it would do', async () => {
  // Breaks if: any non-GET Graph call or env update is issued under --dry-run.
  const w = world({ cpSpExists: false });
  const r = await ensure({ ...OPTS, dryRun: true }, w.io);
  assert.deepEqual(w.writes(), []);
  assert.deepEqual(w.st.envSets, []);
  assert.equal(r.writes, 0);
  assert.ok(r.would.some((l) => l.includes('federated credential')));
  assert.ok(r.would.some((l) => l.includes(`assign ${ROLE_READER.value}`)));
  assert.ok(r.would.some((l) => l.includes(ALLOWLIST_ENV)));
});

test('a 403 on a write exits 3 and NAMES the Graph permissions; nothing is claimed done', async () => {
  // Breaks if: the permission class is swallowed into a generic failure or the permission names are dropped.
  const w = world({ denyWrite: true });
  const code = await run(['--as-client-id', AS_APP, '--cp-app-client-id', CP_APP, '--tenant-id', TENANT, '--ci-client-id', CI_APP, '--cp-identity-principal-id', CP_IDENTITY, '--cp-app-name', 'a', '--cp-resource-group', 'b', '--subscription', 'c'], w.io);
  assert.equal(code, EXIT_PERMISSION);
  const out = w.log.join('\n');
  assert.match(out, /Application\.ReadWrite\.All/);
  assert.match(out, /AppRoleAssignment\.ReadWrite\.All/);
  assert.doesNotMatch(out, /\bOK:/);
  assert.deepEqual(w.st.envSets, []);
});

test('read-back fails the run when an accepted write never appears', async () => {
  // Breaks if: the script trusts the POST status instead of re-reading (it would exit 0 here).
  const w = world({ dropCredPost: true });
  const code = await run(['--as-client-id', AS_APP, '--cp-app-client-id', CP_APP, '--tenant-id', TENANT, '--ci-client-id', CI_APP, '--cp-identity-principal-id', CP_IDENTITY, '--apim-principal-id', APIM_SP, '--cp-app-name', 'a', '--cp-resource-group', 'b', '--subscription', 'c'], w.io);
  assert.equal(code, EXIT_FAILED);
  assert.match(w.log.join('\n'), /read-back FAILED.*federated credential/);
});

test('the aks control plane is refused (exit 5) with zero calls, not reported as wired', async () => {
  // Breaks if: aks falls through to the Container Apps env update.
  const w = world();
  const code = await run(['--as-client-id', AS_APP, '--cp-app-client-id', CP_APP, '--tenant-id', TENANT, '--ci-client-id', CI_APP, '--cp-identity-principal-id', CP_IDENTITY, '--cp-app-name', 'a', '--cp-resource-group', 'b', '--subscription', 'c', '--platform', 'aks'], w.io);
  assert.equal(code, EXIT_UNSUPPORTED);
  assert.deepEqual(w.log.filter((l) => /^(GET|POST|PATCH) /.test(l)), []);
  assert.match(w.log.join('\n'), /NOT done by this run/);
});

test('without an APIM identity the run is reported PARTIAL and the APIM is not granted anything', async () => {
  // Breaks if: a missing APIM is silently reported as fully wired.
  const w = world();
  const r = await ensure({ ...OPTS, apimPrincipalId: '' }, w.io);
  assert.equal(r.partial.length, 1);
  assert.match(r.partial[0], /APIM gateway NOT wired/);
  assert.deepEqual(w.st.assignments, [{ principalId: CONSOLE_PRINCIPAL, appRoleId: ROLE_ADMIN.id }, { principalId: CI_SP, appRoleId: ROLE_ADMIN.id }]);
  assert.ok(!w.st.allow.includes(APIM_APPID));
});

test('usage errors: a missing/non-GUID required argument exits 2 before any call', async () => {
  // Breaks if: validation is skipped and a bad id reaches Graph.
  const w = world();
  assert.equal(await run(['--as-client-id', 'not-a-guid'], w.io), EXIT_USAGE);
  assert.equal(await run(['--bogus'], w.io), EXIT_USAGE);
  assert.deepEqual(w.log.filter((l) => /^(GET|POST|PATCH) /.test(l)), []);
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
  assert.equal(EXIT_OK, 0);
});

test('CI SP gets HealthCP.Admin (not Reader) via its OBJECT id and its APP id lands in the allowlist', async () => {
  // Breaks if: the CI id is dropped from grants (no CI_SP assignment), granted Reader, assigned by app id instead of the
  // Graph-resolved object id, or omitted from the allowlist (CP middleware would still 403 it).
  const w = world();
  await ensure(OPTS, w.io);
  assert.deepEqual(w.st.assignments.filter((a) => a.principalId === CI_SP), [{ principalId: CI_SP, appRoleId: ROLE_ADMIN.id }]);
  assert.ok(!w.st.assignments.some((a) => a.principalId === CI_APP), 'object id, never the app id');
  assert.ok(w.st.allow.split(',').includes(CI_APP));
  assert.notEqual(CI_APP, CI_SP, 'fixture: distinct ids so an app-id/object-id mix-up is visible');
});

test('missing --ci-client-id exits 2 NAMING the variable, with zero Graph calls and no writes', async () => {
  // Breaks if: an absent CI id is skipped silently (exit 0 -> the CI SP stays 403) or fails without naming the variable.
  const w = world();
  const argv = ['--as-client-id', AS_APP, '--cp-app-client-id', CP_APP, '--tenant-id', TENANT, '--cp-identity-principal-id', CP_IDENTITY, '--cp-app-name', 'a', '--cp-resource-group', 'b', '--subscription', 'c'];
  const code = await run(argv, w.io);
  assert.equal(code, EXIT_USAGE);
  assert.match(w.log.join('\n'), /--ci-client-id <GUID> is required.*AZURE_CLIENT_ID/);
  assert.deepEqual(w.log.filter((l) => /^(GET|POST|PATCH) /.test(l)), []);
  assert.deepEqual(w.st.envSets, []);
  assert.equal(await run([...argv, '--ci-client-id', ''], w.io), EXIT_USAGE);
});

test('a CI SP unknown to Graph fails with a definite not-found, no CI assignment made', async () => {
  // Breaks if: a 404 on the CI SP is swallowed and the run reports success without the CI grant.
  const w = world();
  const code = await run(['--as-client-id', AS_APP, '--cp-app-client-id', CP_APP, '--tenant-id', TENANT, '--ci-client-id', G(5), '--cp-identity-principal-id', CP_IDENTITY, '--cp-app-name', 'a', '--cp-resource-group', 'b', '--subscription', 'c'], w.io);
  assert.equal(code, EXIT_FAILED);
  assert.deepEqual(w.st.assignments, []);
});

test('the AS app declares Graph User.ReadBasic.All + GroupMember.Read.All (application, NOT Directory.Read.All) and gets a service principal; nothing is consented', async () => {
  // Breaks if: the PATCH omits the permission or declares it as Scope (delegated) instead of Role, uses another id,
  // drops an unrelated declared resource, or the AS service principal is never created (consent stays impossible, #5346).
  const keep = { resourceAppId: G(5), resourceAccess: [{ id: G(6), type: 'Scope' }] };
  const w = world({ rra: [keep] });
  await ensure(OPTS, w.io);
  assert.deepEqual(w.st.rra, [keep, { resourceAppId: GRAPH_RESOURCE_APP_ID, resourceAccess: [{ id: LEARN_USER_READBASIC_ALL, type: 'Role' }, { id: LEARN_GROUPMEMBER_READ_ALL, type: 'Role' }] }]);
  const declared = w.st.rra.flatMap((r) => r.resourceAccess).map((a) => a.id);
  assert.ok(!declared.includes(LEARN_DIRECTORY_READ_ALL), 'the broader Directory.Read.All must not be declared');
  assert.equal(w.st.asSpExists, true);
  assert.ok(!w.log.some((l) => /oauth2PermissionGrants/.test(l)), 'declaring is not consenting: no grant call');
});

test('withGraphPermission is idempotent and merges into an existing Graph entry', () => {
  // Breaks if: a second run appends a duplicate, or an existing Graph delegated entry is overwritten.
  const both = [{ id: LEARN_USER_READBASIC_ALL, type: 'Role' }, { id: LEARN_GROUPMEMBER_READ_ALL, type: 'Role' }];
  assert.equal(withGraphPermission([{ resourceAppId: GRAPH_RESOURCE_APP_ID.toUpperCase(), resourceAccess: both }]), null);
  const merged = withGraphPermission([{ resourceAppId: GRAPH_RESOURCE_APP_ID, resourceAccess: [{ id: G(6), type: 'Scope' }] }]);
  assert.deepEqual(merged[0].resourceAccess, [{ id: G(6), type: 'Scope' }, ...both]);
  assert.equal(merged.length, 1);
  assert.notEqual(withGraphPermission([{ resourceAppId: GRAPH_RESOURCE_APP_ID, resourceAccess: [{ id: LEARN_USER_READBASIC_ALL, type: 'Scope' }, both[1]] }]), null, 'a delegated Scope with the same id is NOT the application role');
  assert.notEqual(withGraphPermission([{ resourceAppId: GRAPH_RESOURCE_APP_ID, resourceAccess: [both[0]] }]), null, 'only one of the two roles declared: the other must be added');
  const legacy = withGraphPermission([{ resourceAppId: GRAPH_RESOURCE_APP_ID, resourceAccess: [{ id: LEARN_DIRECTORY_READ_ALL, type: 'Role' }] }]);
  assert.ok(legacy[0].resourceAccess.some((a) => a.id === LEARN_DIRECTORY_READ_ALL), 'an existing Directory.Read.All declaration is left in place, not silently removed');
  assert.ok(both.every((b) => legacy[0].resourceAccess.some((a) => a.id === b.id)));
});

test('the declared Graph permission matches what the AS code calls (lifted from source)', () => {
  // Breaks if: the AS moves off /directoryObjects/{oid}/checkMemberGroups (the Learn row whose least-privileged
  // application permissions are User.ReadBasic.All + GroupMember.Read.All) without this script following.
  const src = readFileSync(fileURLToPath(new URL('../../../apps/loom-health-cp/src/auth/federation.ts', import.meta.url)), 'utf8');
  assert.ok(src.includes('/directoryObjects/${oid}/checkMemberGroups'));
  // DOCUMENTATION, not coverage: the module constants must equal the independent Learn literals above.
  assert.deepEqual(GRAPH_PERMISSIONS.map((g) => g.id), [LEARN_USER_READBASIC_ALL, LEARN_GROUPMEMBER_READ_ALL]);
});

test('read-back fails when the requiredResourceAccess write never lands', async () => {
  // Breaks if: the PATCH status is trusted without re-reading the app (it would exit 0 with consent still impossible).
  const w = world({ dropRraPatch: true });
  const code = await run(['--as-client-id', AS_APP, '--cp-app-client-id', CP_APP, '--tenant-id', TENANT, '--ci-client-id', CI_APP, '--cp-identity-principal-id', CP_IDENTITY, '--apim-principal-id', APIM_SP, '--cp-app-name', 'a', '--cp-resource-group', 'b', '--subscription', 'c'], w.io);
  assert.equal(code, EXIT_FAILED);
  assert.match(w.log.join('\n'), /read-back FAILED.*User\.ReadBasic\.All \+ GroupMember\.Read\.All declared/);
});

test('an existing Directory.Read.All declaration from an earlier run is KEPT, reported, and the two narrow roles are added', async () => {
  // Breaks if: the legacy broad declaration is silently dropped (access removed unannounced) or not reported.
  const w = world({ rra: [{ resourceAppId: GRAPH_RESOURCE_APP_ID, resourceAccess: [{ id: LEARN_DIRECTORY_READ_ALL, type: 'Role' }] }], asSpExists: true });
  await ensure(OPTS, w.io);
  const ids = w.st.rra[0].resourceAccess.map((a) => a.id);
  assert.deepEqual(ids, [LEARN_DIRECTORY_READ_ALL, LEARN_USER_READBASIC_ALL, LEARN_GROUPMEMBER_READ_ALL]);
  assert.match(w.log.join('\n'), /still declares Directory\.Read\.All/);
});
