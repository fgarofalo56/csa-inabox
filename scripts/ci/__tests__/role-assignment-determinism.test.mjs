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
  findImperativeCollisions,
  imperativeFiles,
  isExecuted,
  resolveRoleArg,
  resolveGuidToken,
  shellGuidVars,
  yamlEnvGuidVars,
  roleVars,
  positionalArgs,
  createSite,
  classifyImperative,
  GRANT_HELPER,
  inventory,
  scan,
  D3_CONTROLS,
  runD3Controls,
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

// ── D3 — the gap D1/D2 could not see (#3439) ─────────────────────────────────
//
// On run 31780698652 D1+D2 reported "OK — 164 role assignment(s) … no two
// declarations collide" and the deploy failed RoleAssignmentExists anyway. The
// competing writer was `az role assignment create`, which mints a random v4
// name for a triple whose deterministic v5 name the template owns. D1/D2 audit
// bicep against bicep and are structurally blind to it.

const ACRPULL = '7f951dda-4ed3-4680-a7ca-43fe172d538d';

/** A tiny repo root carrying one shell file under scripts/. */
function scratchRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ra-imp-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

/** A record set whose only bicep-granted role is AcrPull. */
const acrPullRecords = [{ roleKey: ACRPULL, file: 'm.bicep', nameLine: 1 }];

test('EMBEDDED CONTROL — an unprobed create over a bicep-granted role IS flagged', () => {
  // The real defect, reduced. If this control ever stops firing, the guard has
  // drifted off the code and its zero on the real tree means nothing
  // (guard_with_zero_population_needs_embedded_control).
  const dir = scratchRepo({
    'scripts/bad.sh': `#!/usr/bin/env bash\naz role assignment create --assignee-object-id "$PID" \\\n  --role ${ACRPULL} --scope "$ACR_ID"\n`,
  });
  const { findings, population } = findImperativeCollisions(acrPullRecords, dir, ['scripts']);
  assert.equal(population, 1);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].check, 'D3');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('EMBEDDED CONTROL — the SAME create with a probe above it is NOT flagged', () => {
  // The negative half. Without it, a matcher that flags everything would score
  // identically to one that works.
  const dir = scratchRepo({
    'scripts/good.sh':
      `#!/usr/bin/env bash\n` +
      `N=$(az role assignment list --assignee-object-id "$PID" --scope "$ACR_ID" --role ${ACRPULL} --query "length(@)" -o tsv)\n` +
      `if [ "$N" = "0" ]; then\n` +
      `  az role assignment create --assignee-object-id "$PID" --role ${ACRPULL} --scope "$ACR_ID"\n` +
      `fi\n`,
  });
  const { findings, population } = findImperativeCollisions(acrPullRecords, dir, ['scripts']);
  assert.equal(population, 1, 'the create must still be COUNTED — a probe excuses it, it does not hide it');
  assert.deepEqual(findings, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('D3 — a role the bicep does NOT grant cannot collide, so it is not flagged', () => {
  const dir = scratchRepo({
    'scripts/other.sh': `az role assignment create --assignee-object-id "$PID" --role ${OTHER_ROLE} --scope "$S"\n`,
  });
  const { findings, population } = findImperativeCollisions(acrPullRecords, dir, ['scripts']);
  assert.equal(population, 1);
  assert.deepEqual(findings, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('D3 reads LOGICAL lines — a probe or a --role on a continuation is still seen', () => {
  // The class _logical-lines.mjs exists for: a guard keyed to physical lines
  // reported ELEVEN live sites as zero because the second token was on a `\`
  // continuation (#3417, #3420).
  const dir = scratchRepo({
    'scripts/cont.sh': `az role assignment create --assignee-object-id "$PID" \\\n  --role ${ACRPULL} \\\n  --scope "$S"\n`,
  });
  const { findings } = findImperativeCollisions(acrPullRecords, dir, ['scripts']);
  assert.equal(findings.length, 1, 'a --role on a continuation must still be resolved and judged');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('D3 — a create mentioned inside an echo is a REFERENCE, not an execution', () => {
  const dir = scratchRepo({
    'scripts/doc.sh': `echo "run az role assignment create --role ${ACRPULL} --scope X as an Owner"\n`,
    'scripts/comment.sh': `# az role assignment create --role ${ACRPULL} --scope X\n`,
  });
  const { findings, population } = findImperativeCollisions(acrPullRecords, dir, ['scripts']);
  assert.equal(population, 0, 'a string is not a call — the same distinction check-deploy-script-reachability draws');
  assert.deepEqual(findings, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('D3 resolves --role through a shell variable, and refuses to judge what it cannot resolve', () => {
  const vars = shellGuidVars([{ line: 1, text: `ACRPULL_ROLE="${ACRPULL}"` }]);
  assert.equal(vars.get('ACRPULL_ROLE'), ACRPULL);
  assert.equal(resolveRoleArg(`az role assignment create --role "$ACRPULL_ROLE" --scope X`, vars), ACRPULL);
  assert.equal(resolveRoleArg(`az role assignment create --role ${ACRPULL} --scope X`, new Map()), ACRPULL);
  // A display name is NOT guessed at a role definition id (R7).
  assert.equal(resolveRoleArg(`az role assignment create --role "Storage Blob Data Reader" --scope X`, new Map()), null);
  assert.equal(resolveRoleArg(`az role assignment create --role "$UNKNOWN" --scope X`, new Map()), null);
});

test('isExecuted separates the call from the string that describes it', () => {
  assert.equal(isExecuted('az role assignment create --role x'), true);
  assert.equal(isExecuted('  MSYS_NO_PATHCONV=1 az role assignment create --role x'), true);
  assert.equal(isExecuted('echo "az role assignment create --role x"'), false);
  assert.equal(isExecuted('# az role assignment create --role x'), false);
  assert.equal(isExecuted('echo "::warning::az role assignment create --role x"'), false);
  assert.equal(isExecuted('nothing here'), false);
});

test('D3 scans the real tree, and its POPULATION is non-trivial', () => {
  // The findings may legitimately be zero (every site probes). The population
  // may not: this repo executes `az role assignment create` in both cloud
  // lanes, so zero would mean the matcher stopped matching.
  const files = imperativeFiles();
  assert.ok(files.length > 20, `discovered only ${files.length} workflow/script files`);
  const { population, findings } = findImperativeCollisions(inventory());
  assert.ok(population > 10, `discovered only ${population} executed creates — D3 is not scanning`);
  assert.deepEqual(
    findings,
    [],
    `the real tree must be clean by D3:\n${findings.map((f) => `${f.file}:${f.line}`).join('\n')}`,
  );
});

test('the D3 CONTROL SET still carries the "mention is not a branch" bypasses', () => {
  // The independent review of PR #3928 demonstrated three bypasses of
  // probeGates through this guard's own entry points, and four more of the
  // same class were found while fixing it. They are pinned as controls; this
  // test pins the CONTROL SET itself, because a control set that quietly
  // shrinks is a guard judging an empty population — the failure mode this
  // repo has recorded more often than any other.
  assert.deepEqual(runD3Controls(), [], 'the in-process D3 controls must all pass');
  assert.ok(
    D3_CONTROLS.length >= 21,
    `D3_CONTROLS dropped to ${D3_CONTROLS.length}; the bypass class was pinned at 21`,
  );
  const whys = D3_CONTROLS.map((c) => c.why).join('\n');
  for (const shape of ['BYPASS 1/3', 'BYPASS 2/3', 'BYPASS 3/3']) {
    assert.ok(whys.includes(shape), `the review's ${shape} control is gone`);
  }
  // The set must be able to discriminate in BOTH directions: one that only
  // ever expects zero findings cannot tell a working judge from a dead one.
  assert.ok(D3_CONTROLS.some((c) => c.expectFindings === 1), 'no positive control');
  assert.ok(D3_CONTROLS.some((c) => c.expectFindings === 0), 'no negative control');
});

// ── #3464 finding 1 — the YAML `env:` binding D3 could not read ──────────────
//
// Measured on main at 899ea91b670: `node scripts/ci/check-role-assignment-
// determinism.mjs --list` exited 0 reporting "ENUMERATED 33, RESOLVED 3, JUDGED
// NONE", with `.github/workflows/gov-provision-streaming-migrate.yml:369` in the
// UNRESOLVED list — a bare `az role assignment create --role "$BLOB_CONTRIB_ROLE"
// … 2>/dev/null || true` whose GUID is bound in the workflow-level `env:` block.
// The guard was clean over an empty set.

test('yamlEnvGuidVars reads workflow-level and step-level `env:` GUID bindings', () => {
  const logical = [
    'env:',
    '  ACRPULL_ROLE: 7f951dda-4ed3-4680-a7ca-43fe172d538d',
    '  NOT_A_GUID: loom-console',
    'jobs:',
    '  provision:',
    '    steps:',
    '      - name: grant',
    '        env:',
    "          BLOB_CONTRIB_ROLE: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'",
    '        run: |',
    '          echo hi',
  ].map((text, i) => ({ text, line: i + 1 }));
  const vars = yamlEnvGuidVars(logical);
  assert.equal(vars.get('ACRPULL_ROLE'), '7f951dda-4ed3-4680-a7ca-43fe172d538d');
  assert.equal(vars.get('BLOB_CONTRIB_ROLE'), 'ba92f5b4-2d11-453d-a403-e96b0029c9fe');
  assert.equal(vars.has('NOT_A_GUID'), false);
});

test('yamlEnvGuidVars does NOT read a `KEY: <guid>` outside an `env:` block', () => {
  // Workflow-input defaults, `with:` arguments and subscription ids all have
  // this shape. Reading them would resolve a `--role "$group"` to a GUID that is
  // not a role definition at all — a finding the guard could not substantiate.
  const logical = [
    'on:',
    '  workflow_dispatch:',
    '    inputs:',
    '      group:',
    '        default: e093f4fd-5047-4ee4-968d-a56942c665f3',
  ].map((text, i) => ({ text, line: i + 1 }));
  assert.equal(yamlEnvGuidVars(logical).size, 0);
});

test('yamlEnvGuidVars ABSTAINS on a key bound to two different GUIDs (R7)', () => {
  const logical = [
    'env:',
    '  ROLE_ID: 7f951dda-4ed3-4680-a7ca-43fe172d538d',
    'jobs:',
    '  a:',
    '    env:',
    '      ROLE_ID: ba92f5b4-2d11-453d-a403-e96b0029c9fe',
  ].map((text, i) => ({ text, line: i + 1 }));
  assert.equal(yamlEnvGuidVars(logical).has('ROLE_ID'), false, 'an ambiguous binding must not be guessed');
});

test('MUTATION PROOF — an UNGATED create whose --role is a YAML env binding IS flagged', () => {
  // RED at the parent of this change: `shellGuidVars` alone cannot resolve
  // `$BLOB_CONTRIB_ROLE`, so this site filed as unresolved and produced no
  // finding and no judged count.
  const wf =
    'env:\n' +
    `  BLOB_CONTRIB_ROLE: ${ACRPULL}\n` +
    'jobs:\n' +
    '  provision:\n' +
    '    steps:\n' +
    '      - run: |\n' +
    '          az role assignment create --assignee-object-id "$RW_PID" --role "$BLOB_CONTRIB_ROLE" --scope "$LAKE_ID"\n';
  const dir = scratchRepo({ '.github/workflows/w.yml': wf });
  const { findings, judged, resolved } = findImperativeCollisions(acrPullRecords, dir, ['.github/workflows']);
  assert.equal(resolved, 1, 'the YAML env binding must resolve the --role');
  assert.equal(judged, 1, 'a resolved role the bicep also grants must be JUDGED');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].check, 'D3');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── #3464 finding 2 — the remedy must not delete the site from the population ─

test('positionalArgs reads the helper call arguments, quotes stripped', () => {
  assert.deepEqual(
    positionalArgs('  grant_role_if_absent "$PID" "$ACRPULL_ROLE" "$ACR_ID" "AcrPull for x"', GRANT_HELPER),
    ['$PID', '$ACRPULL_ROLE', '$ACR_ID', 'AcrPull for x'],
  );
  assert.deepEqual(positionalArgs(`grant_role_if_absent $A ${ACRPULL} $C`, GRANT_HELPER), ['$A', ACRPULL, '$C']);
});

test('createSite classifies the CLI call, the helper call, the definition and the mention', () => {
  assert.equal(createSite(`az role assignment create --role ${ACRPULL} --scope X`).kind, 'cli');
  assert.equal(createSite(`grant_role_if_absent "$P" ${ACRPULL} "$S" "l"`).kind, 'helper');
  assert.equal(createSite('grant_role_if_absent() {'), null, 'a function DEFINITION is not a call site');
  assert.equal(createSite('  local principal="$1" role="$2"'), null);
  assert.equal(createSite('# grant_role_if_absent "$P" x "$S"'), null);
  assert.equal(createSite('echo "use grant_role_if_absent instead"'), null);
});

test('MUTATION PROOF — a `grant_role_if_absent` call is ENUMERATED and JUDGED, and counts as gated', () => {
  // RED at the parent: `grant_role_if_absent` carries no `az role assignment
  // create` token, so the whole file scored population 0. Adopting the remedy
  // made the site invisible — the guard's numbers fell as the tree improved.
  const dir = scratchRepo({
    'scripts/g.sh':
      '#!/usr/bin/env bash\n' +
      '. scripts/csa-loom/_grant-role-if-absent.sh\n' +
      `grant_role_if_absent "$PID" ${ACRPULL} "$ACR_ID" "AcrPull"\n`,
  });
  const { findings, population, judged } = findImperativeCollisions(acrPullRecords, dir, ['scripts']);
  assert.equal(population, 1, 'the helper call IS a create site');
  assert.equal(judged, 1, 'and it is judged, not silently excused');
  assert.deepEqual(findings, [], 'the helper probes internally, so the site is gated');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the helper SOURCE FILE contributes exactly one create site — its own internal create', () => {
  // The definition line, the usage comment and the `echo … grant_role_if_absent
  // needs …` diagnostic must not each score as a call, and the guard must not
  // count the helper's own `az role assignment create` twice.
  const helper = fs.readFileSync(
    path.join(BICEP_ROOT, '..', '..', '..', 'scripts', 'csa-loom', '_grant-role-if-absent.sh'),
    'utf8',
  );
  const logical = helper.split(/\r?\n/).map((text, i) => ({ text, line: i + 1 }));
  const sites = logical.filter((l) => createSite(l.text) !== null);
  assert.equal(sites.length, 1, `expected 1 site, got ${sites.length}: ${sites.map((s) => s.line).join(',')}`);
  assert.ok(sites[0].text.includes('az role assignment create'));
});

// ── #3464 finding 3 — the floor is on JUDGED, not on ENUMERATED ──────────────

test('the real tree now JUDGES a non-empty set, and the D3 verdict is about it', () => {
  // The property the `judged === 0 -> exit 1` floor in the driver enforces.
  // Measured at the parent of this change: judged 0, exit 0 — a clean verdict
  // over an empty set, downgraded to a `::warning::` that cannot fail a build.
  const { population, resolved, judged, findings } = findImperativeCollisions(inventory());
  assert.ok(population > 10, `discovered only ${population} create sites — D3 is not scanning`);
  assert.ok(resolved >= judged);
  assert.ok(judged > 0, 'D3 judged ZERO sites — its clean verdict would be about an empty set (#3464)');
  assert.deepEqual(findings, [], findings.map((f) => `${f.file}:${f.line}`).join('\n'));
});

test('the Gov streaming workflow is one of the sites D3 now judges', () => {
  // The site named in #3464: its role GUIDs live in YAML `env:` and its grants
  // are routed through the shared helper. Both readings are needed for it to be
  // judged at all, so this fails if either widening is reverted.
  const wf = '.github/workflows/gov-provision-streaming-migrate.yml';
  const abs = path.join(BICEP_ROOT, '..', '..', '..', wf);
  const text = fs.readFileSync(abs, 'utf8');
  const logical = text.split(/\r?\n/).map((t, i) => ({ text: t, line: i + 1 }));
  const bicepRoles = new Set(inventory().map((r) => r.roleKey).filter(Boolean));
  const { population, judged, findings } = classifyImperative(logical, bicepRoles, wf);
  assert.ok(population >= 2, `expected the AcrPull loop and the lake grant, got ${population}`);
  assert.ok(judged >= 2, `expected both to be judged, got ${judged}`);
  assert.deepEqual(findings, [], findings.map((f) => `${f.file}:${f.line} ${f.detail}`).join('\n'));
  // …and the shapes deploy-integrity.md forbids are gone from that block.
  assert.equal(
    /az role assignment create[^\n]*\|\| true/.test(text),
    false,
    'a result-discarding `az role assignment create … || true` is back in the Gov streaming workflow',
  );
});

test('roleVars merges both binding forms, shell winning a tie', () => {
  const logical = [
    { line: 1, text: 'env:' },
    { line: 2, text: `  ROLE_A: ${ACRPULL}` },
    { line: 3, text: `ROLE_B=${OTHER_ROLE}` },
  ];
  const vars = roleVars(logical);
  assert.equal(vars.get('ROLE_A'), ACRPULL);
  assert.equal(vars.get('ROLE_B'), OTHER_ROLE);
  assert.equal(resolveGuidToken('"$ROLE_A"', vars), ACRPULL);
  assert.equal(resolveGuidToken('"Storage Blob Data Reader"', vars), null, 'a display name is not guessed');
  assert.equal(resolveGuidToken(null, vars), null);
});

test('the D3 CONTROL SET pins the YAML-env and helper-call shapes too', () => {
  const whys = D3_CONTROLS.map((c) => c.why).join('\n');
  assert.ok(whys.includes('D3-YAML'), 'the YAML `env:` controls are gone (#3464 finding 1)');
  assert.ok(whys.includes('D3-HELPER'), 'the grant_role_if_absent controls are gone (#3464 finding 2)');
  assert.ok(
    D3_CONTROLS.some((c) => c.expectJudged === 1),
    'no control asserts a NON-ZERO judged count — the set could pass with a dead judge',
  );
  assert.ok(
    D3_CONTROLS.some((c) => c.expectJudged === 0),
    'no control asserts a ZERO judged count — the set could pass with a judge that judges everything',
  );
});
