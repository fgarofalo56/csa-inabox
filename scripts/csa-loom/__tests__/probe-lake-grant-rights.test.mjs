/**
 * probe-lake-grant-rights.test.mjs — the #3336 rights probe must be able to say
 * NO, and must never confuse "could not measure" with "measured no".
 *
 * WHY THESE ASSERTIONS AND NOT OTHERS. The probe's whole job is to decide
 * whether a cross-subscription role assignment will be ATTEMPTED. Get it wrong
 * in one direction and a deployment fails outright with AuthorizationFailed (the
 * P0 that took the Commercial estate down twice on 2026-08-13); get it wrong in
 * the other and a capability stays silently blocked on an estate that could have
 * had it. So the tests are about DISCRIMINATION, not coverage.
 *
 * THE CONTROL THAT DOES NOT WORK, recorded so it is not re-added. The obvious
 * live control — probe for a nonsense action, expect DENIED — is VACUOUS against
 * an Owner: `actions: ['*']` genuinely allows every action string, including
 * invented ones. Run against the live Commercial deploy principal on 2026-08-13
 * it printed "evaluator is broken" about a correctly-working evaluator. A
 * control that cannot tell a broken evaluator from a privileged caller measures
 * nothing. The discrimination is therefore proved on fixtures whose answers are
 * known independently of any estate.
 *
 * Run: node --test scripts/csa-loom/__tests__/probe-lake-grant-rights.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isAllowed,
  lakeCoordsFromAdoptPlan,
  verifyControls,
  verifyPlanControls,
} from '../probe-lake-grant-rights.mjs';

const GRANT = 'Microsoft.Authorization/roleAssignments/write';
const DEPLOY = 'Microsoft.Resources/deployments/write';

test('the script\'s own embedded controls hold', () => {
  const perm = verifyControls();
  const plan = verifyPlanControls();
  assert.deepEqual(perm.failures, [], 'permission fixtures must all hold');
  assert.deepEqual(plan.failures, [], 'adopt-plan fixtures must all hold');
  // Floor: an empty fixture array would make verifyControls() trivially green.
  assert.ok(perm.total >= 5, 'the permission control set must not be empty');
  assert.ok(plan.total >= 5, 'the adopt-plan control set must not be empty');
});

test('Owner allows the grant; Contributor does NOT — the notActions must bite', () => {
  const owner = [{ actions: ['*'], notActions: [] }];
  const contributor = [
    { actions: ['*'], notActions: ['Microsoft.Authorization/*/Write', 'Microsoft.Authorization/*/Delete'] },
  ];
  assert.equal(isAllowed(owner, GRANT), true);
  assert.equal(isAllowed(contributor, GRANT), false);
  // …and Contributor CAN still submit the nested deployment, so the two needed
  // actions genuinely differ. If both answered the same, the probe would be
  // measuring one thing and reporting two.
  assert.equal(isAllowed(contributor, DEPLOY), true);
  assert.equal(isAllowed(owner, DEPLOY), true);
});

test('User Access Administrator allows the grant via an explicit wildcard', () => {
  const uaa = [{ actions: ['*/read', 'Microsoft.Authorization/*'], notActions: [] }];
  assert.equal(isAllowed(uaa, GRANT), true);
});

test('Reader cannot grant, and an EMPTY permission set cannot grant', () => {
  assert.equal(isAllowed([{ actions: ['*/read'], notActions: [] }], GRANT), false);
  // The empty case is the one that matters most: a payload that came back blank
  // for any reason must read as "no", never as "sure".
  assert.equal(isAllowed([], GRANT), false);
});

test('the wildcard matcher is anchored — a prefix must not match a longer action', () => {
  // `Microsoft.Authorization/roleDefinitions/read` must NOT satisfy a request for
  // roleAssignments/write just because they share a namespace.
  const roleDefsOnly = [{ actions: ['Microsoft.Authorization/roleDefinitions/read'], notActions: [] }];
  assert.equal(isAllowed(roleDefsOnly, GRANT), false);
  // And a pattern must not be treated as a substring search in either direction.
  assert.equal(isAllowed([{ actions: ['Microsoft.Authorization/roleAssignments/writeSomethingElse'] }], GRANT), false);
  assert.equal(isAllowed([{ actions: ['Microsoft.Authorization/roleAssignments/write'] }], GRANT), true);
});

test('regex metacharacters in an action are literal, not a pattern', () => {
  // A permission entry is data. If `.` were treated as "any character", then
  // `MicrosoftXAuthorization/...` would satisfy `Microsoft.Authorization/...`
  // and the probe would over-report ALLOWED — the dangerous direction.
  const perms = [{ actions: ['Microsoft.Authorization/roleAssignments/write'], notActions: [] }];
  assert.equal(isAllowed(perms, 'MicrosoftXAuthorization/roleAssignments/write'), false);
});

test('the adopt-plan reader agrees with main.bicep about what "cross-sub" means', () => {
  const lake = (extra) => ({ 'storage-adls': { mode: 'adopt', target: { name: 'sa', rg: 'rg-dlz', ...extra } } });

  // Cross-sub: armed, with BOTH coordinates.
  assert.deepEqual(lakeCoordsFromAdoptPlan(lake({ sub: 'SUB-B' }), 'SUB-A'), { sub: 'SUB-B', rg: 'rg-dlz' });

  // Same sub → not cross-sub. Mirrors `loomStorageAccountSameSub`.
  assert.deepEqual(lakeCoordsFromAdoptPlan(lake({ sub: 'SUB-A' }), 'SUB-A'), { sub: '', rg: '' });

  // No explicit `sub` → local BY THE PLAN'S OWN CONVENTION (discover-dlz-adopt-plan.sh
  // omits it for same-sub targets, and main.bicep reads the omission as local).
  // If this ever disagreed with the bicep expression, the probe would measure
  // rights at a scope the template does not deploy to.
  assert.deepEqual(lakeCoordsFromAdoptPlan(lake({}), 'SUB-A'), { sub: '', rg: '' });

  // A cross-sub entry with no RG cannot be scoped at all —
  // `resourceGroup(sub, '')` is a deployment that cannot be submitted, and this
  // pass must never be the thing that fails a deploy.
  assert.deepEqual(
    lakeCoordsFromAdoptPlan({ 'storage-adls': { mode: 'adopt', target: { name: 'sa', sub: 'SUB-B' } } }, 'SUB-A'),
    { sub: '', rg: '' },
  );
});

test('only mode=adopt counts, and only the storage-adls key', () => {
  assert.deepEqual(
    lakeCoordsFromAdoptPlan({ 'storage-adls': { mode: 'create', target: { rg: 'rg', sub: 'SUB-B' } } }, 'SUB-A'),
    { sub: '', rg: '' },
  );
  // Adopting Synapse/Databricks cross-sub must NOT arm the LAKE grant pass —
  // this pass grants on the storage account and nothing else.
  assert.deepEqual(
    lakeCoordsFromAdoptPlan(
      { synapse: { mode: 'adopt', target: { rg: 'rg', sub: 'SUB-B' } }, databricks: { mode: 'adopt', target: { rg: 'rg', sub: 'SUB-B' } } },
      'SUB-A',
    ),
    { sub: '', rg: '' },
  );
});

test('a junk plan yields no lake rather than throwing', () => {
  // The caller classifies an UNPARSEABLE plan as `unknown` before reaching here;
  // these are the shapes that DO parse but carry nothing usable.
  for (const junk of [null, undefined, {}, { 'storage-adls': null }, { 'storage-adls': { mode: 'adopt' } }]) {
    assert.deepEqual(lakeCoordsFromAdoptPlan(junk, 'SUB-A'), { sub: '', rg: '' });
  }
});

test('THE LIVE SHAPE — the Commercial estate\'s own adopt plan arms the pass', () => {
  // The exact document scripts/csa-loom/discover-dlz-adopt-plan.sh produced for
  // the Commercial estate on 2026-08-13, with the subscription GUIDs replaced.
  // This is the case that had NO grant owner and therefore no S3 gateway (#3337).
  const plan = {
    'storage-adls': { mode: 'adopt', target: { name: 'saloomdefaulttr4nm4dcgsq', rg: 'rg-csa-loom-dlz-default-centralus', sub: 'DLZ-SUB' } },
    eventhubs: { mode: 'adopt', target: { name: 'evhns-loom-default-centralus', rg: 'rg-csa-loom-dlz-default-centralus', sub: 'DLZ-SUB' } },
    synapse: { mode: 'adopt', target: { name: 'syn-loom', rg: 'rg-csa-loom-dlz-default-centralus', sub: 'DLZ-SUB' } },
  };
  assert.deepEqual(lakeCoordsFromAdoptPlan(plan, 'DMLZ-SUB'), {
    sub: 'DLZ-SUB',
    rg: 'rg-csa-loom-dlz-default-centralus',
  });
});
