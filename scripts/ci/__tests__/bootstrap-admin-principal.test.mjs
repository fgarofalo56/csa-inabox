/**
 * bootstrap-admin-principal.test.mjs — the runtime refusal and the static shape
 * guard for the bootstrap tenant-admin binding (refs #3109).
 *
 * MUTATION-PROVED THROUGHOUT. Every rule is exercised twice: once against the
 * REAL repo (or a correct binding), where it must PASS, and once against a
 * mutant, where it must FAIL with the code that names the defect. A rule only
 * ever observed passing is not a rule.
 *
 * The mutants are ADDITIVE wherever a shape allows it — a second env entry
 * appended after the good one, a second lane added beside the working one, an
 * extra oid appended to a valid one. Replacing the only good entry trips the
 * population floor and reads as proven while the additive blind spot survives;
 * that is how sprint-1's guards passed on trees that were already broken.
 *
 * Run: node --test scripts/ci/__tests__/bootstrap-admin-principal.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyOdataType,
  evaluateBinding,
  lookupPrincipal,
  graphBase,
  splitIds,
  GUID_RE,
} from '../bootstrap-admin-principal.mjs';
import {
  checkBicep,
  checkLanes,
  laneFromYaml,
  readLanes,
  rawRun,
  boundAdminParams,
  bicepVarExpression,
} from '../check-admin-principal-kind.mjs';
import { parseWorkflowSteps, ADMIN_PLANE } from '../check-reconcile-safety.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const BICEP = readFileSync(ADMIN_PLANE, 'utf8').replace(/\r\n/g, '\n');
const COMMERCIAL = readFileSync(
  path.join(REPO_ROOT, '.github', 'workflows', 'deploy-fiab-commercial.yml'),
  'utf8',
).replace(/\r\n/g, '\n');

/** Real object ids from the tenant this repo deploys, by KIND. */
const USER_OID = '866a2e12-0fee-4c99-923c-7cdfd61e08cd'; // FIAB_TENANT_ADMIN_OID repo variable
const GROUP_OID = '716f5ec5-20d0-4713-9e42-57ef931cd665'; // FIAB_ADMIN_GROUP_ID repo variable ("Loom Admins")
const SP_OID = 'b9c3cc65-522e-49c9-ad02-914676aa5a6b'; // the deploy service principal

/** A directory that answers the way the live tenant answered on 2026-08-11. */
const DIRECTORY = {
  [USER_OID]: { kind: 'user', detail: 'Graph @odata.type=#microsoft.graph.user' },
  [GROUP_OID]: { kind: 'group', detail: 'Graph @odata.type=#microsoft.graph.group' },
  [SP_OID]: { kind: 'servicePrincipal', detail: 'Graph @odata.type=#microsoft.graph.servicePrincipal' },
};
const lookup = (id) => DIRECTORY[id] ?? { kind: 'absent', detail: `Graph 404 Request_ResourceNotFound for ${id}` };

const codes = (r) => r.findings.map((f) => f.code);
const BOUND = { oid: USER_OID, oidSource: 'repo var', groupRaw: GROUP_OID, groupSource: 'repo var', deployAppsEnabled: 'true', lane: 'x.yml', lookup };

// ---------------------------------------------------------------------------
// classifyOdataType
// ---------------------------------------------------------------------------
test('classifyOdataType maps the three principal kinds and refuses to guess', () => {
  assert.equal(classifyOdataType('#microsoft.graph.user'), 'user');
  assert.equal(classifyOdataType('#microsoft.graph.servicePrincipal'), 'servicePrincipal');
  assert.equal(classifyOdataType('#microsoft.graph.group'), 'group');
  // An unknown type is NOT quietly a user.
  assert.equal(classifyOdataType('#microsoft.graph.device'), 'other');
  // EMPTY IS UNKNOWN, NOT SAFE.
  assert.equal(classifyOdataType(''), 'unresolved');
  assert.equal(classifyOdataType(undefined), 'unresolved');
});

// ---------------------------------------------------------------------------
// evaluateBinding — the verdict
// ---------------------------------------------------------------------------
test('BASELINE: the real repo-variable binding (user oid + group) passes', () => {
  const r = evaluateBinding(BOUND);
  assert.deepEqual(codes(r), []);
  assert.equal(r.ok, true);
  assert.equal(r.checked, 2, 'both bound ids must actually be classified');
});

test('MUTATION: a service-principal oid is REFUSED, with the good group still bound', () => {
  const r = evaluateBinding({ ...BOUND, oid: SP_OID });
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('oid-is-service-principal'), codes(r).join(','));
  const msg = r.findings.find((f) => f.code === 'oid-is-service-principal').message;
  assert.match(msg, /SERVICE PRINCIPAL/);
  assert.match(msg, /#microsoft\.graph\.servicePrincipal/, 'the message must cite what Graph actually said');
});

test('MUTATION (additive): appending the SP oid to a VALID oid still fails', () => {
  const r = evaluateBinding({ ...BOUND, oid: `${USER_OID},${SP_OID}` });
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('oid-is-service-principal'));
  // …and the comma itself is a defect: feature-gate.ts compares with ===.
  assert.ok(codes(r).includes('oid-multi-valued'));
});

test('MUTATION (additive): appending a NON-group to a valid group binding fails', () => {
  const r = evaluateBinding({ ...BOUND, groupRaw: `${GROUP_OID},${SP_OID}` });
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['group-not-a-group']);
});

test('MUTATION: a group oid in the OID slot is refused (and vice versa)', () => {
  assert.ok(codes(evaluateBinding({ ...BOUND, oid: GROUP_OID })).includes('oid-is-group'));
  assert.ok(codes(evaluateBinding({ ...BOUND, groupRaw: USER_OID })).includes('group-not-a-group'));
});

test('MUTATION: an oid that names nothing in the tenant is refused', () => {
  const r = evaluateBinding({ ...BOUND, oid: '00000000-1111-2222-3333-444444444444' });
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['oid-absent']);
});

test('UNRESOLVED IS NOT SAFE: a lookup that could not complete refuses', () => {
  const blind = () => ({ kind: 'unresolved', detail: 'az rest exited 1: Authorization_RequestDenied' });
  const r = evaluateBinding({ ...BOUND, lookup: blind });
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('oid-unresolved'));
  assert.ok(codes(r).includes('group-unresolved'));
  assert.match(
    r.findings[0].message,
    /NOT CLASSIFIED/,
    'the message must say the lookup did not complete — never assert a principal type it did not read',
  );
});

test('EMPTY POPULATION IS A FAILURE: bindings present but nothing classified', () => {
  // A resolver that quietly reports nothing must not read as "0 violations".
  const r = evaluateBinding({ ...BOUND, oid: '', groupRaw: 'not-a-guid' });
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['group-not-a-guid']);
  assert.equal(r.checked, 0);
});

test('no binding at all REFUSES when the Container Apps are rendered', () => {
  const r = evaluateBinding({ ...BOUND, oid: '', groupRaw: '' });
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['no-binding']);
});

test('no binding is ALLOWED only when DEPLOY_APPS_ENABLED is explicitly false', () => {
  const r = evaluateBinding({ ...BOUND, oid: '', groupRaw: '', deployAppsEnabled: 'false' });
  assert.equal(r.ok, true);
  assert.match(r.notes.join(' '), /no Container App is rendered/);
});

test('EMPTY VALUE IS UNKNOWN, NOT SAFE: a blank DEPLOY_APPS_ENABLED is treated as rendering', () => {
  const r = evaluateBinding({ ...BOUND, oid: '', groupRaw: '', deployAppsEnabled: '' });
  assert.equal(r.ok, false, 'an unknown apps flag must take the STRICT branch');
  assert.deepEqual(codes(r), ['no-binding']);
  assert.match(r.notes.join(' '), /not true\/false/);
});

test('a non-GUID binding is refused before any directory read', () => {
  let reads = 0;
  const counting = (id) => {
    reads++;
    return lookup(id);
  };
  const r = evaluateBinding({ ...BOUND, oid: 'my-user@contoso.com', lookup: counting });
  assert.ok(codes(r).includes('oid-not-a-guid'));
  assert.equal(reads, 1, 'only the group id should have been read');
});

test('GUID_RE / splitIds handle the shapes a repo variable can carry', () => {
  assert.ok(GUID_RE.test(USER_OID));
  assert.ok(!GUID_RE.test(`${USER_OID} `), 'trailing space is not part of the id');
  assert.deepEqual(splitIds(` ${USER_OID} , ${GROUP_OID} ,, `), [USER_OID, GROUP_OID]);
  assert.deepEqual(splitIds(''), []);
  assert.deepEqual(splitIds(undefined), []);
});

// ---------------------------------------------------------------------------
// lookupPrincipal — the Graph transport, driven by a fake `az`
// ---------------------------------------------------------------------------
const azOk = (body) => () => ({ code: 0, stdout: JSON.stringify(body), stderr: '' });
const azErr = (stderr, code = 1) => () => ({ code, stdout: '', stderr });

test('lookupPrincipal classifies a Graph 200 by @odata.type', () => {
  const r = lookupPrincipal(SP_OID, { exec: azOk({ '@odata.type': '#microsoft.graph.servicePrincipal' }), base: 'https://graph.example' });
  assert.equal(r.kind, 'servicePrincipal');
});

test('lookupPrincipal reports a 404 as ABSENT, not as a principal type', () => {
  const r = lookupPrincipal(USER_OID, { exec: azErr('ERROR: Not Found({"error":{"code":"Request_ResourceNotFound"}})'), base: 'https://graph.example' });
  assert.equal(r.kind, 'absent');
});

test('R7: a DENIED read is unresolved and names the remediation, never a type', () => {
  const r = lookupPrincipal(USER_OID, { exec: azErr('ERROR: Authorization_RequestDenied: Insufficient privileges to complete the operation.'), base: 'https://graph.example' });
  assert.equal(r.kind, 'unresolved');
  assert.match(r.detail, /REFUSED the directory read/);
  assert.match(r.detail, /Directory\.Read\.All/);
  assert.doesNotMatch(r.detail, /is a service principal/);
});

test('lookupPrincipal retries a TRANSIENT failure and fails closed on exhaustion', () => {
  let calls = 0;
  const flaky = () => {
    calls++;
    return calls < 3
      ? { code: 1, stdout: '', stderr: 'ERROR: 503 Service Unavailable' }
      : { code: 0, stdout: JSON.stringify({ '@odata.type': '#microsoft.graph.user' }), stderr: '' };
  };
  const ok = lookupPrincipal(USER_OID, { exec: flaky, base: 'https://graph.example', sleep: () => {} });
  assert.equal(ok.kind, 'user');
  assert.equal(calls, 3);

  let always = 0;
  const dead = () => {
    always++;
    return { code: 1, stdout: '', stderr: 'ERROR: 503 Service Unavailable' };
  };
  const exhausted = lookupPrincipal(USER_OID, { exec: dead, base: 'https://graph.example', sleep: () => {} });
  assert.equal(exhausted.kind, 'unresolved', 'a retry that cannot fail is forbidden');
  assert.equal(always, 3);
});

test('lookupPrincipal does not pass a body it could not parse', () => {
  const r = lookupPrincipal(USER_OID, { exec: () => ({ code: 0, stdout: '<html>login</html>', stderr: '' }), base: 'https://graph.example' });
  assert.equal(r.kind, 'unresolved');
});

test('CLOUD PARITY: the Graph host comes from az cloud show, never a literal', () => {
  const src = readFileSync(path.join(REPO_ROOT, 'scripts', 'ci', 'bootstrap-admin-principal.mjs'), 'utf8');
  const code = src
    .split('\n')
    .filter((l) => !/^\s*\*|^\s*\/\//.test(l))
    .join('\n');
  assert.doesNotMatch(code, /graph\.microsoft\.(com|us)/, 'a hard-coded Graph host classifies nothing in a sovereign boundary');

  const gov = graphBase(() => ({ code: 0, stdout: 'https://graph.microsoft.us/\n', stderr: '' }));
  assert.deepEqual(gov, { ok: true, base: 'https://graph.microsoft.us' });
  // …and an unreadable cloud is a refusal, not a Commercial assumption.
  const blind = graphBase(() => ({ code: 1, stdout: '', stderr: 'ERROR: Please run az login' }));
  assert.equal(blind.ok, false);
});

// ---------------------------------------------------------------------------
// check-bootstrap-admin-binding — B1/B2 against the REAL bicep, then mutants
// ---------------------------------------------------------------------------
test('BASELINE: the real admin-plane bicep satisfies B1 + B2', () => {
  const r = checkBicep(BICEP);
  assert.deepEqual(r.violations.map((v) => v.code), []);
  assert.ok(bicepVarExpression(BICEP, 'effectiveTenantAdminOid'), 'the guarded variable must exist to be guarded');
});

test('MUTATION B1: restoring the ungated deployer().objectId fallback FAILS, naming the file', () => {
  const mutant = BICEP.replace(
    /var effectiveTenantAdminOid = !empty\(loomTenantAdminOid\)\n[\s\S]*?deployer\(\)\.objectId\)\n/,
    "var effectiveTenantAdminOid = !empty(loomTenantAdminOid) ? loomTenantAdminOid : (hasRealAdminGroup ? '' : deployer().objectId)\n",
  );
  assert.notEqual(mutant, BICEP, 'the mutation must actually change the tree');
  const r = checkBicep(mutant);
  assert.deepEqual(r.violations.map((v) => v.code), ['deployer-oid-ungated']);
  assert.match(r.violations[0].msg, /admin-plane\/main\.bicep:\d+/);
});

test('MUTATION B1: the guard is keyed to the MISMATCH — removing the UPN test alone fails', () => {
  // The unsafe token (deployer().objectId) is untouched; only the discriminator
  // is dropped. A rule keyed to the unsafe string alone would stay quiet here.
  const mutant = BICEP.replace(/deployer\(\)\.\?userPrincipalName \?\? ''/, "'someone@example.com'");
  assert.notEqual(mutant, BICEP);
  assert.deepEqual(checkBicep(mutant).violations.map((v) => v.code), ['deployer-oid-ungated']);
});

test('MUTATION B2 (additive): a SECOND LOOM_TENANT_ADMIN_OID env entry FAILS', () => {
  // Azure keeps the LAST entry, so appending beside the good one is the shape
  // that actually ships the defect. The good entry is left in place.
  const mutant = BICEP.replace(
    "{ name: 'LOOM_TENANT_ADMIN_OID', value: effectiveTenantAdminOid }",
    "{ name: 'LOOM_TENANT_ADMIN_OID', value: effectiveTenantAdminOid }\n            { name: 'LOOM_TENANT_ADMIN_OID', value: deployer().objectId }",
  );
  assert.notEqual(mutant, BICEP);
  const found = checkBicep(mutant).violations.map((v) => v.code);
  assert.ok(found.includes('env-entry-duplicated'), found.join(','));
  assert.ok(found.includes('env-entry-unguarded'), found.join(','));
});

test('EMPTY POPULATION: if the guarded variable disappears, the guard FAILS', () => {
  const mutant = BICEP.replace(/var effectiveTenantAdminOid = /, 'var somethingElseEntirely = ');
  assert.deepEqual(checkBicep(mutant).violations.map((v) => v.code), ['bicep-var-missing']);
});

// ---------------------------------------------------------------------------
// check-bootstrap-admin-binding — W1/W2 against the REAL lanes, then mutants
// ---------------------------------------------------------------------------
const LANE_OK = `
jobs:
  deploy:
    steps:
      - name: Compose
        run: |
          add --parameters "loomTenantAdminOid=$OID"
      - name: Bootstrap admin binding is a HUMAN admin
        run: node scripts/ci/bootstrap-admin-principal.mjs
      - name: Apply
        run: az deployment sub create --name x
`;

test('BASELINE: the real workflow tree satisfies W1 + W2', () => {
  const r = checkLanes();
  assert.deepEqual(r.violations.map((v) => v.code), []);
  const commercial = r.lanes.find((l) => l.file === 'deploy-fiab-commercial.yml');
  assert.ok(commercial, 'the Commercial lane must be in the population');
  assert.ok(commercial.bound.has('loomTenantAdminOid'));
  assert.ok(commercial.refusal, 'the Commercial lane must run the refusal');
  assert.ok(
    commercial.refusal.startLine < commercial.firstMutating.startLine,
    'the refusal must precede the first ARM call',
  );
});

test('CLOUD PARITY is DERIVED: the sovereign lanes are enumerated as group-only', () => {
  const lanes = readLanes();
  for (const f of ['deploy-fiab-gcch.yml', 'deploy-fiab-il5.yml', 'deploy-fiab-gcc.yml']) {
    const lane = lanes.find((l) => l.file === f);
    assert.ok(lane, `${f} must be in the derived per-cloud table`);
    assert.ok(lane.bound.has('loomTenantAdminGroupId'), `${f} binds the admin group`);
    assert.equal(lane.bound.has('loomTenantAdminOid'), false, `${f} binds no OID today — if it starts to, W1 applies`);
  }
});

test('MUTATION W1 (additive): a NEW lane that binds an oid without the refusal FAILS', () => {
  const good = readLanes();
  const rogue = laneFromYaml('deploy-fiab-newcloud.yml', LANE_OK.replace('      - name: Bootstrap admin binding is a HUMAN admin\n        run: node scripts/ci/bootstrap-admin-principal.mjs\n', ''));
  const r = checkLanes([...good, rogue]);
  assert.deepEqual(r.violations.map((v) => v.code), ['oid-lane-without-refusal']);
  assert.match(r.violations[0].msg, /deploy-fiab-newcloud\.yml/);
});

test('MUTATION W1: a refusal behind an `if:` is not a refusal', () => {
  const lane = laneFromYaml(
    'deploy-x.yml',
    LANE_OK.replace(
      '      - name: Bootstrap admin binding is a HUMAN admin\n',
      "      - name: Bootstrap admin binding is a HUMAN admin\n        if: github.event_name == 'workflow_dispatch'\n",
    ),
  );
  assert.deepEqual(checkLanes([lane]).violations.map((v) => v.code), ['refusal-conditional']);
});

test('MUTATION W1: a refusal placed AFTER the apply FAILS', () => {
  const lane = laneFromYaml(
    'deploy-x.yml',
    `
jobs:
  deploy:
    steps:
      - name: Compose
        run: |
          add --parameters "loomTenantAdminOid=$OID"
      - name: Apply
        run: az deployment sub create --name x
      - name: Bootstrap admin binding is a HUMAN admin
        run: node scripts/ci/bootstrap-admin-principal.mjs
`,
  );
  assert.deepEqual(checkLanes([lane]).violations.map((v) => v.code), ['refusal-after-arm']);
});

test('EMPTY POPULATION: zero lanes, or zero OID-binding lanes, both FAIL', () => {
  assert.deepEqual(checkLanes([]).violations.map((v) => v.code), ['no-lanes-found']);
  const groupOnly = laneFromYaml('deploy-gov.yml', `
jobs:
  deploy:
    steps:
      - name: Apply
        run: az deployment sub create --parameters loomTenantAdminGroupId=$G
`);
  assert.deepEqual(checkLanes([groupOnly]).violations.map((v) => v.code), ['no-oid-lane-found']);
});

// ---------------------------------------------------------------------------
// The parser the lane rules stand on
// ---------------------------------------------------------------------------
test('COMMENTS DO NOT COUNT, and QUOTING IS UNWRAPPED before a name is judged', () => {
  const steps = parseWorkflowSteps(`
jobs:
  j:
    steps:
      - name: prose only
        run: |
          # add --parameters "loomTenantAdminOid=$X"   <- a comment, not a binding
          echo hello
      - name: quoted binding
        run: |
          add --parameters "loomTenantAdminOid=$X"
      - name: unquoted binding
        run: |
          az deployment sub create --parameters loomTenantAdminGroupId=$G
`).map((s) => ({ ...s, raw: rawRun(s.body) }));
  assert.equal(boundAdminParams(steps[0].raw).size, 0, 'a commented-out binding must not count');
  assert.deepEqual([...boundAdminParams(steps[1].raw)], ['loomTenantAdminOid']);
  assert.deepEqual([...boundAdminParams(steps[2].raw)], ['loomTenantAdminGroupId']);
});

test('the Commercial lane hands the COMPOSED values to the refusal, not the raw inputs', () => {
  // A second resolution of the binding is a second copy that can drift (#3022).
  const step = parseWorkflowSteps(COMMERCIAL).find((s) => rawRun(s.body).includes('bootstrap-admin-principal.mjs'));
  assert.ok(step, 'the Commercial lane must carry the refusal step');
  const env = step.body.join('\n');
  assert.match(env, /TENANT_ADMIN_OID:\s*\$\{\{\s*steps\.params\.outputs\.tenant_admin_oid\s*\}\}/);
  assert.match(env, /TENANT_ADMIN_GROUP_ID:\s*\$\{\{\s*steps\.params\.outputs\.tenant_admin_group\s*\}\}/);
  assert.match(env, /DEPLOY_APPS_ENABLED:/);
});
