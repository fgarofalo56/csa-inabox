/**
 * role-assignment-determinism.test.mjs — the guard can FAIL, and it fails on
 * the two shapes that actually produce `RoleAssignmentExists` (issue #3039).
 *
 * WHAT THE PROOF IS ABOUT
 *
 *   ARM enforces role-assignment uniqueness on the (scope, principalId,
 *   roleDefinitionId) TRIPLE, not on the NAME. `guid()` is documented as a pure
 *   hash of its arguments, so the same seed always yields the same name and a
 *   changed seed yields a different one. That second half is not a claim from a
 *   spec here — it is what happened live: correcting the Website Contributor
 *   role id (…706ee → …84772, commit ae75c3c5) changed the SEED, ARM computed
 *   `3d0daf64-…`, the estate still held `2f9290b0-…` for the same triple, and
 *   run 31069329802's swa-publish-rbac child deployment died on
 *   RoleAssignmentExists.
 *
 *   This suite therefore proves the property the REPO controls — the seed — and
 *   does not attempt to re-derive ARM's digest. (It was attempted: ARM's guid()
 *   is not reproducible from the documented description, and asserting a
 *   digest this code cannot compute would be exactly the R7 error.)
 *
 * Run: node --test scripts/ci/__tests__/role-assignment-determinism.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  declarations,
  parseDeclaration,
  normaliseExpr,
  roleKey,
  tripleKey,
  crossFileKey,
  findNonDeterministicNames,
  findTripleCollisions,
  findVersionedSeeds,
  findCrossFileCandidates,
  inventory,
  scan,
  BICEP_ROOT,
} from '../check-role-assignment-determinism.mjs';

const ROLE = 'de139f84-1756-47ae-9be6-808fbbe84772';
const OTHER_ROLE = 'b24988ac-6180-42a0-ab88-20f7382dd24c';

function moduleWith(body) {
  return `targetScope = 'resourceGroup'\nparam consolePrincipalId string\n${body}\n`;
}

const good = (name = `guid(resourceGroup().id, consolePrincipalId, '${ROLE}')`) =>
  moduleWith(`resource r 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: ${name}
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '${ROLE}')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}`);

function scratchModule(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ra-guard-'));
  fs.writeFileSync(path.join(dir, 'm.bicep'), contents, 'utf8');
  return dir;
}

// ── D1 ───────────────────────────────────────────────────────────────────────

test('D1 — a guid(…) seeded from the triple passes', () => {
  const recs = declarations(good(), 'm.bicep').map((d) => parseDeclaration(d, good()));
  assert.equal(recs.length, 1);
  assert.deepEqual(findNonDeterministicNames(recs), []);
});

test('MUTATION PROOF — newGuid() / utcNow() / deployment().name are each caught', () => {
  for (const seed of ['newGuid()', "guid(resourceGroup().id, consolePrincipalId, utcNow())", "guid(deployment().name, consolePrincipalId)"]) {
    const src = good(seed);
    const recs = declarations(src, 'm.bicep').map((d) => parseDeclaration(d, src));
    const found = findNonDeterministicNames(recs);
    assert.equal(found.length, 1, `not caught: ${seed}`);
    assert.equal(found[0].check, 'D1');
  }
});

test('MUTATION PROOF — a name that is not a guid(…) at all is caught', () => {
  const src = good("'loom-swa-publish'");
  const recs = declarations(src, 'm.bicep').map((d) => parseDeclaration(d, src));
  const found = findNonDeterministicNames(recs);
  assert.equal(found.length, 1);
  assert.match(found[0].detail, /not a guid\(…\) expression/);
});

// ── D2 — the shape that actually fired ───────────────────────────────────────

test('MUTATION PROOF — two names for ONE ARM triple is a finding', () => {
  const src = moduleWith(`resource a 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, consolePrincipalId, '${ROLE}')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '${ROLE}')
    principalId: consolePrincipalId
  }
}
resource b 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, consolePrincipalId, 'swa-publish-label')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '${ROLE}')
    principalId: consolePrincipalId
  }
}`);
  const recs = declarations(src, 'm.bicep').map((d) => parseDeclaration(d, src));
  const found = findTripleCollisions(recs);
  assert.equal(found.length, 1);
  assert.equal(found[0].check, 'D2');
  assert.match(found[0].detail, /RoleAssignmentExists/);
});

test('MUTATION PROOF — change ONE component of the triple and the SAME pair is clean', () => {
  // Identical to the failing case except the second assignment grants a
  // different role. A guard that reported a collision unconditionally fails here.
  const src = moduleWith(`resource a 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, consolePrincipalId, '${ROLE}')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '${ROLE}')
    principalId: consolePrincipalId
  }
}
resource b 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, consolePrincipalId, 'swa-publish-label')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '${OTHER_ROLE}')
    principalId: consolePrincipalId
  }
}`);
  const recs = declarations(src, 'm.bicep').map((d) => parseDeclaration(d, src));
  assert.deepEqual(findTripleCollisions(recs), []);
});

test('SEED DETERMINISM — identical inputs give an identical seed; a changed scope does not', () => {
  const seedFor = (scopeExpr) =>
    normaliseExpr(`guid(${scopeExpr}, consolePrincipalId, '${ROLE}')`);
  assert.equal(seedFor('resourceGroup().id'), seedFor('resourceGroup() . id'), 'formatting is not semantics');
  assert.notEqual(seedFor('resourceGroup().id'), seedFor('subscription().id'), 'a changed scope must change the seed');
  // …and the triple key moves with it, which is what decides D2.
  const rec = (scopeExpr) => ({ file: 'm.bicep', scope: scopeExpr, principalId: 'consolePrincipalId', roleKey: ROLE, name: seedFor(scopeExpr) });
  assert.equal(tripleKey(rec('resourceGroup().id')), tripleKey(rec('resourceGroup().id')));
  assert.notEqual(tripleKey(rec('resourceGroup().id')), tripleKey(rec('subscription().id')));
});

// ── the parser, which is what the first cut got wrong ────────────────────────

test('MUTATION PROOF — a MULTI-LINE roleDefinitionId is read whole, not truncated', () => {
  // The first cut read `subscriptionResourceId(` as the value, so two DIFFERENT
  // roles compared equal and the guard invented six collisions. This is the
  // shape (verbatim from admin-plane/ai-foundry.bicep) that exposed it.
  const src = moduleWith(`resource a 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundryHub
  name: guid(foundryHub.id, consolePrincipalId, '${ROLE}')
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '${ROLE}')
    principalId: consolePrincipalId
  }
}
resource b 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundryHub
  name: guid(foundryHub.id, consolePrincipalId, '${OTHER_ROLE}')
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '${OTHER_ROLE}')
    principalId: consolePrincipalId
  }
}`);
  const recs = declarations(src, 'm.bicep').map((d) => parseDeclaration(d, src));
  assert.equal(recs.length, 2);
  assert.equal(recs[0].roleKey, ROLE);
  assert.equal(recs[1].roleKey, OTHER_ROLE);
  assert.deepEqual(findTripleCollisions(recs), []);
});

test('a `var` role id resolves to its literal so two spellings of one role still collide', () => {
  const src = `var websiteContributorRoleId = '${ROLE}'\n${moduleWith(`resource a 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, consolePrincipalId, websiteContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', websiteContributorRoleId)
    principalId: consolePrincipalId
  }
}
resource b 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, consolePrincipalId, 'a-label')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '${ROLE}')
    principalId: consolePrincipalId
  }
}`)}`;
  const recs = declarations(src, 'm.bicep').map((d) => parseDeclaration(d, src));
  assert.equal(recs[0].roleKey, ROLE, 'the var must resolve to its literal');
  assert.equal(findTripleCollisions(recs).length, 1);
});

test('`existing` references and commented-out declarations are not counted', () => {
  const src = `resource ra 'Microsoft.Authorization/roleAssignments@2022-04-01' existing = { name: 'x' }
// resource commented 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
`;
  assert.deepEqual(declarations(src, 'm.bicep'), []);
});

test('brace balancing does not run one declaration into the next', () => {
  const src = good();
  const decls = declarations(src, 'm.bicep');
  assert.equal(decls.length, 1);
  assert.ok(decls[0].body.at(-1).text.trim() === '}');
});

// ── honesty about what is NOT gated ──────────────────────────────────────────

test('a cross-FILE symbolic match is reported as a candidate, never as a finding', () => {
  const recs = [
    { file: 'a.bicep', scope: 'sa', principalId: 'consolePrincipalId', roleKey: ROLE, name: "guid(sa.id,consolePrincipalId,'x')", nameLine: 1 },
    { file: 'b.bicep', scope: 'sa', principalId: 'consolePrincipalId', roleKey: ROLE, name: "guid(sa.id,consolePrincipalId,'y')", nameLine: 1 },
  ];
  assert.deepEqual(findTripleCollisions(recs), [], 'cross-file symbols are not provable');
  assert.equal(findCrossFileCandidates(recs).length, 1);
  assert.equal(crossFileKey(recs[0]), crossFileKey(recs[1]));
});

test('a versioned seed is surfaced as a hazard, not gated', () => {
  const recs = [{ file: 'a.bicep', nameLine: 1, name: "guid(sa.id, p, blobReader, 'shim-uami-reader-v1')" }];
  assert.equal(findVersionedSeeds(recs).length, 1);
  assert.deepEqual(findNonDeterministicNames([{ ...recs[0], scope: null, principalId: 'p', roleKey: ROLE }]), []);
});

// ── discovery cannot silently shrink ─────────────────────────────────────────

test('the real bicep tree is discovered, and discovery is non-trivial', () => {
  const recs = inventory();
  assert.ok(recs.length > 100, `discovered only ${recs.length} role assignments — discovery has shrunk`);
  assert.ok(recs.every((r) => r.file.startsWith('platform/fiab/bicep/')));
});

test('the repo is currently clean by this guard — with a real tree, not an empty one', () => {
  const { records, findings } = scan();
  assert.ok(records.length > 100);
  assert.deepEqual(findings, [], findings.map((f) => `${f.check} ${f.file}:${f.line} ${f.detail}`).join('\n'));
});

test('MUTATION PROOF — plant one bad module and the SAME driver goes red', () => {
  const dir = scratchModule(good('newGuid()'));
  const { findings } = scan(dir);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].check, 'D1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('roleKey falls back to the expression rather than guessing', () => {
  assert.equal(roleKey("subscriptionResourceId('Microsoft.Authorization/roleDefinitions', someUnknownVar)", ''), 'var:someUnknownVar');
  assert.equal(roleKey('somethingEntirelyDifferent', ''), 'somethingEntirelyDifferent');
});

test('BICEP_ROOT points at the tree the guard claims to cover', () => {
  assert.ok(BICEP_ROOT.endsWith(path.join('platform', 'fiab', 'bicep')));
  assert.ok(fs.existsSync(BICEP_ROOT));
});
