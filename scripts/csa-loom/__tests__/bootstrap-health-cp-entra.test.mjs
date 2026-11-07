import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ensure, run, expectedFederatedCredential, mergeAllowlist, parseArgs,
  ROLE_READER, ROLE_ADMIN, FED_CRED_NAME, ALLOWLIST_ENV,
  EXIT_OK, EXIT_FAILED, EXIT_USAGE, EXIT_PERMISSION, EXIT_UNSUPPORTED,
} from '../bootstrap-health-cp-entra.mjs';
import { GraphError } from '../ensure-estate-power-role.mjs';

const G = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const TENANT = G(1), AS_APP = G(2), AS_OBJ = G(3), CP_APP = G(4), CP_OBJ = G(5), CP_SP = G(6);
const CP_IDENTITY = G(7), APIM_SP = G(8), APIM_APPID = G(9), CONSOLE_CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', CONSOLE_PRINCIPAL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const OPTS = {
  asClientId: AS_APP, cpAppClientId: CP_APP, tenantId: TENANT, cpIdentityPrincipalId: CP_IDENTITY,
  apimPrincipalId: APIM_SP, consoleClientId: CONSOLE_CLIENT, consolePrincipalId: CONSOLE_PRINCIPAL,
  cpAppName: 'loom-health-cp', cpResourceGroup: 'rg-x', subscription: 'sub', platform: 'containerApps',
};

/** In-memory Graph + Container App. `calls` records every request; writes() filters non-GET. */
function world({ cloud = 'AzureCloud', creds = [], appRoles = [], assignments = [], allow = '', cpSpExists = true, denyWrite = false, dropCredPost = false } = {}) {
  const st = { creds: [...creds], appRoles: [...appRoles], assignments: [...assignments], allow, envSets: [] };
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
      if (method === 'GET' && p === `/applications(appId='${AS_APP}')`) return { json: { id: AS_OBJ, appId: AS_APP } };
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
      if (method === 'POST' && p === '/servicePrincipals') { cpSpExists = true; return { json: {} }; }
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
    `POST /applications/${AS_OBJ}/federatedIdentityCredentials`,
    `PATCH /applications/${CP_OBJ}`,
    'POST /servicePrincipals',
    `POST /servicePrincipals/${CP_SP}/appRoleAssignedTo`,
    `POST /servicePrincipals/${CP_SP}/appRoleAssignedTo`,
  ]);
  assert.equal(first.writes, 6, '5 Graph writes + 1 env update');
  assert.deepEqual(w.st.assignments, [
    { principalId: APIM_SP, appRoleId: ROLE_READER.id },
    { principalId: CONSOLE_PRINCIPAL, appRoleId: ROLE_ADMIN.id },
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
  const code = await run(['--as-client-id', AS_APP, '--cp-app-client-id', CP_APP, '--tenant-id', TENANT, '--cp-identity-principal-id', CP_IDENTITY, '--cp-app-name', 'a', '--cp-resource-group', 'b', '--subscription', 'c'], w.io);
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
  assert.deepEqual(final.map((s) => s.toLowerCase()), [CONSOLE_CLIENT, G(5), APIM_APPID]);
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
  const code = await run(['--as-client-id', AS_APP, '--cp-app-client-id', CP_APP, '--tenant-id', TENANT, '--cp-identity-principal-id', CP_IDENTITY, '--cp-app-name', 'a', '--cp-resource-group', 'b', '--subscription', 'c'], w.io);
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
  const code = await run(['--as-client-id', AS_APP, '--cp-app-client-id', CP_APP, '--tenant-id', TENANT, '--cp-identity-principal-id', CP_IDENTITY, '--apim-principal-id', APIM_SP, '--cp-app-name', 'a', '--cp-resource-group', 'b', '--subscription', 'c'], w.io);
  assert.equal(code, EXIT_FAILED);
  assert.match(w.log.join('\n'), /read-back FAILED.*federated credential/);
});

test('the aks control plane is refused (exit 5) with zero calls, not reported as wired', async () => {
  // Breaks if: aks falls through to the Container Apps env update.
  const w = world();
  const code = await run(['--as-client-id', AS_APP, '--cp-app-client-id', CP_APP, '--tenant-id', TENANT, '--cp-identity-principal-id', CP_IDENTITY, '--cp-app-name', 'a', '--cp-resource-group', 'b', '--subscription', 'c', '--platform', 'aks'], w.io);
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
  assert.deepEqual(w.st.assignments, [{ principalId: CONSOLE_PRINCIPAL, appRoleId: ROLE_ADMIN.id }]);
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
