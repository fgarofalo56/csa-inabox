// Behaviour tests for scripts/ci/check-module-existing-scope.mjs (#3333).
//
// The guard exists because an unscoped `resource … existing` inside a bicep
// module resolved in the wrong resource group and failed two full Commercial
// deploys. Its own failure modes therefore matter more than usual: a reader bug
// or an over-wide rule would recreate exactly what it is meant to catch. These
// tests drive the pure analyzer over in-memory trees — no disk, no Azure.
//
// Run: node --test scripts/ci/__tests__/module-existing-scope.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  analyze,
  BICEP_ROOT,
  blankComments,
  blockAt,
  CONTROL_TREE,
  CROSS_RG_TYPES,
  derefsOf,
  fieldAt,
  KNOWN_DORMANT,
  loadTree,
  norm,
  paramBindings,
  parseBicep,
  partitionFindings,
  REPO_ROOT,
  resolveNameSource,
  resolveTarget,
  staleRegistrations,
  verifyControls,
} from '../check-module-existing-scope.mjs';

// ── the embedded controls ───────────────────────────────────────────────────

test('the embedded controls hold on the shipped matcher', () => {
  assert.equal(verifyControls(), null);
});

test('POSITIVE control: the real pre-#3329 transform-runner shape is found, exactly once', () => {
  const { findings } = analyze(CONTROL_TREE);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].module, 'modules/integration/transform-runner-aca.bicep');
  assert.equal(findings[0].binding, 'artifactsStorageAccountName');
  assert.equal(findings[0].declaredScope, 'resourceGroup(loomDlzRg)');
});

test('NEGATIVE control: the adopted *-lake-rbac modules are INSPECTED and cleared', () => {
  const { findings, derefs } = analyze(CONTROL_TREE);
  for (const adopter of [
    'modules/data-plane/s3-gateway-lake-rbac.bicep',
    'modules/data-plane/transform-runner-lake-rbac.bicep',
  ]) {
    // "seen and cleared" — not "never looked at". Only the first proves the
    // rule discriminates the fix from the defect.
    assert.ok(derefs.has(adopter), `${adopter} must be inspected`);
    assert.ok(!findings.some((f) => f.module === adopter), `${adopter} must not be flagged`);
  }
});

// ── the rule itself ─────────────────────────────────────────────────────────

/** Minimal tree: one orchestrator, one scoped grant module, one app module. */
function tree({ appScope = null, grantScope = 'resourceGroup(dlzRg)' } = {}) {
  const scopeLine = (s) => (s ? `  scope: ${s}\n` : '');
  return new Map([
    [
      'modules/orch/main.bicep',
      `param dlzRg string\nparam lakeAccount string\n\n` +
        `module grant '../dp/grant.bicep' = {\n  name: 'grant'\n${scopeLine(grantScope)}` +
        `  params: {\n    storageAccountName: lakeAccount\n  }\n}\n\n` +
        `module app '../dp/app.bicep' = {\n  name: 'app'\n${scopeLine(appScope)}` +
        `  params: {\n    lakeName: lakeAccount\n  }\n}\n`,
    ],
    [
      'modules/dp/grant.bicep',
      `param storageAccountName string\n\n` +
        `resource lake 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {\n` +
        `  name: storageAccountName\n}\n`,
    ],
    [
      'modules/dp/app.bicep',
      `param lakeName string\n\n` +
        `resource lake 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {\n` +
        `  name: lakeName\n}\n`,
    ],
  ]);
}

test('CONFLICT: a value declared to live in the DLZ RG, dereferenced at caller scope, is flagged', () => {
  const { findings } = analyze(tree());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].module, 'modules/dp/app.bicep');
  assert.equal(findings[0].usedScope, '<caller-scope>');
});

test('NO CONFLICT: the same dereference at the SAME scope is clean', () => {
  const { findings } = analyze(tree({ appScope: 'resourceGroup(dlzRg)' }));
  assert.deepEqual(findings, []);
});

test('NO CONFLICT: with no scoped call anywhere, residency is unknown and nothing is asserted', () => {
  // R7 — the guard must not claim a conflict it never established. Absent an
  // orchestrator statement about where the resource lives, there is no
  // contradiction to report, only an unknown.
  const { findings, residency } = analyze(tree({ grantScope: null }));
  assert.deepEqual(findings, []);
  assert.equal(residency.size, 0);
});

test('an EXPLICITLY scoped `existing` is never judged — the module said where it lives', () => {
  const t = tree();
  t.set(
    'modules/dp/app.bicep',
    `param lakeName string\nparam dlzRg string\n\n` +
      `resource lake 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {\n` +
      `  name: lakeName\n  scope: resourceGroup(dlzRg)\n}\n`,
  );
  assert.deepEqual(analyze(t).findings, []);
});

test('an `existing` whose name the module computes itself is never judged', () => {
  const t = tree();
  t.set(
    'modules/dp/app.bicep',
    `param lakeName string\n\n` +
      `resource lake 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {\n` +
      `  name: 'sa\${uniqueString(resourceGroup().id)}'\n}\n`,
  );
  assert.deepEqual(analyze(t).findings, []);
});

test('a type outside CROSS_RG_TYPES is out of scope for this guard', () => {
  const t = tree();
  const swap = (s) => s.replace(/Microsoft\.Storage\/storageAccounts/g, 'Microsoft.Web/serverfarms');
  t.set('modules/dp/grant.bicep', swap(t.get('modules/dp/grant.bicep')));
  t.set('modules/dp/app.bicep', swap(t.get('modules/dp/app.bicep')));
  assert.deepEqual(analyze(t).findings, []);
  assert.ok(!CROSS_RG_TYPES.has('Microsoft.Web/serverfarms'));
});

test('a NON-existing declaration of a cross-RG type is not judged', () => {
  const t = tree();
  t.set(
    'modules/dp/app.bicep',
    `param lakeName string\n\n` +
      `resource lake 'Microsoft.Storage/storageAccounts@2024-01-01' = {\n` +
      `  name: lakeName\n  location: 'eastus'\n}\n`,
  );
  assert.deepEqual(analyze(t).findings, []);
});

test("an empty-string value asserts no residency — `logAnalyticsWorkspaceName: ''` is not a claim", () => {
  // azure-connections-rbac is invoked at the DLZ scope while being handed `''`
  // for the LAW, precisely because the LAW is NOT there. Treating that as
  // "the LAW lives in the DLZ RG" would manufacture a false finding.
  const t = tree();
  t.set(
    'modules/orch/main.bicep',
    t.get('modules/orch/main.bicep').replace('storageAccountName: lakeAccount', "storageAccountName: ''"),
  );
  assert.deepEqual(analyze(t).findings, []);
});

// ── reader correctness (each of these silently hid a real module) ───────────

test('object-param properties resolve: `cfg.lakeName` binds to the call site value', () => {
  const t = new Map([
    [
      'modules/orch/main.bicep',
      `param dlzRg string\nparam lakeAccount string\n\n` +
        `module grant '../dp/grant.bicep' = {\n  name: 'g'\n  scope: resourceGroup(dlzRg)\n` +
        `  params: {\n    storageAccountName: lakeAccount\n  }\n}\n\n` +
        `module app '../dp/app.bicep' = {\n  name: 'a'\n  params: {\n    location: location\n` +
        `    cfg: {\n      image: 'x'\n      lakeName: lakeAccount\n    }\n    tags: tags\n  }\n}\n`,
    ],
    [
      'modules/dp/grant.bicep',
      `param storageAccountName string\n\nresource lake 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {\n  name: storageAccountName\n}\n`,
    ],
    [
      'modules/dp/app.bicep',
      `param cfg object\n\nvar lakeName = cfg.lakeName\n\n` +
        `resource lake 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {\n  name: lakeName\n}\n`,
    ],
  ]);
  const { findings, unresolved } = analyze(t);
  assert.deepEqual(unresolved, []);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].binding, 'cfg.lakeName');
});

test("bicep's safe-dereference `.?` resolves like `.` — dropping it hid loom-risingwave-aca", () => {
  const parsed = parseBicep(
    `param cfg object\nvar lakeName = string(cfg.?lakeStorageAccountName ?? '')\n` +
      `resource lake 'Microsoft.Storage/storageAccounts@2024-01-01' existing = if (x) {\n  name: lakeName\n}\n`,
  );
  const [d] = derefsOf(parsed);
  assert.equal(d.binding, 'cfg.lakeStorageAccountName');
  assert.equal(d.unresolved, false);
});

test('a binding that resolves only to a bare OBJECT param is UNRESOLVED, never "clean"', () => {
  // UNKNOWN reported as NEGATIVE is this repo's most expensive class. A call
  // site passes an object literal, so a bare-object binding can match nothing —
  // the driver must fail on it rather than print a pass.
  const parsed = parseBicep(
    `param cfg object\nvar lakeName = someUnparseableShape(cfg)\n` +
      `resource lake 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {\n  name: lakeName\n}\n`,
  );
  const [d] = derefsOf(parsed);
  assert.equal(d.binding, 'cfg');
  assert.equal(d.unresolved, true);
});

test('a conditional declaration (`= if (…) {`) is parsed — the pre-#3329 defect was conditional', () => {
  const parsed = parseBicep(
    `param n string\nresource sa 'Microsoft.Storage/storageAccounts@2023-05-01' existing = if (grant) {\n  name: n\n}\n`,
  );
  assert.equal(parsed.resources.length, 1);
  assert.equal(parsed.resources[0].existing, true);
  assert.equal(parsed.resources[0].condition, 'grant');
});

test('a `name:` nested inside `properties:` is not mistaken for the resource name', () => {
  const parsed = parseBicep(
    `param outer string\nparam inner string\n` +
      `resource sa 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {\n` +
      `  name: outer\n  properties: {\n    thing: {\n      name: inner\n    }\n  }\n}\n`,
  );
  assert.equal(parsed.resources[0].name, 'outer');
});

test('a commented-out `scope:` does not count as scoping the declaration', () => {
  const parsed = parseBicep(
    `param n string\n` +
      `resource sa 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {\n` +
      `  name: n\n  // scope: resourceGroup(other)\n}\n`,
  );
  assert.equal(parsed.resources[0].scope, null);
  assert.equal(derefsOf(parsed).length, 1);
});

test('a commented-out module call is not counted as a call site', () => {
  const parsed = parseBicep(`// module ghost 'x.bicep' = {\n//   name: 'ghost'\n// }\n`);
  assert.deepEqual(parsed.modules, []);
});

test('fieldAt joins continuation lines instead of truncating the expression', () => {
  const body = blockAt(
    ['resource x \'T@1\' = {', '  name: guid(', "    a,", '    b)', '  scope: y', '}'],
    0,
  );
  assert.equal(fieldAt(body, 'name', 2).value, 'guid( a, b)');
  assert.equal(fieldAt(body, 'scope', 2).value, 'y');
});

test('paramBindings flattens one level and stops at the params block', () => {
  const body = blockAt(
    [
      "module m 'x.bicep' = {",
      "  name: 'm'",
      '  params: {',
      '    a: one',
      '    cfg: {',
      '      b: two',
      '    }',
      '    c: three',
      '  }',
      '  dependsOn: [ notAParam ]',
      '}',
    ],
    0,
  );
  const b = paramBindings(body);
  assert.equal(b.get('a'), 'one');
  assert.equal(b.get('cfg.b'), 'two');
  assert.equal(b.get('c'), 'three');
  assert.ok(!b.has('dependsOn'));
});

test('resolveTarget normalises relative module paths; registry refs are skipped', () => {
  assert.equal(
    resolveTarget('modules/admin-plane/main.bicep', '../data-plane/x.bicep'),
    'modules/data-plane/x.bicep',
  );
  assert.equal(resolveTarget('modules/a/main.bicep', 'br:mcr.microsoft.com/bicep/x:1.0'), null);
});

test('resolveNameSource prefers a param over a same-named var and follows var chains', () => {
  const parsed = parseBicep(`param p string\nvar a = b\nvar b = p\n`);
  assert.deepEqual(resolveNameSource('p', parsed), { param: 'p', property: null });
  assert.deepEqual(resolveNameSource('a', parsed), { param: 'p', property: null });
  assert.equal(resolveNameSource("'no-identifier-here'", parsed), null);
});

test('an INTERPOLATED param inside a string literal resolves — org-visuals names its container that way', () => {
  // `name: '${storageAccountName}/default/${containerName}'` is the real shape
  // in landing-zone/org-visuals-rbac.bicep. Refusing to look inside string
  // literals would make that dereference invisible, and it is the one that took
  // a ParentResourceNotFound on run 31435481880.
  const parsed = parseBicep(`param storageAccountName string\nparam containerName string\n`);
  assert.deepEqual(resolveNameSource("'${storageAccountName}/default/${containerName}'", parsed), {
    param: 'storageAccountName',
    property: null,
  });
});

// ── the register cannot rot ─────────────────────────────────────────────────

test('a registered finding is CARRIED; an unregistered one is FRESH', () => {
  const f = (module, symbol, binding) => ({ module, symbol, binding });
  const register = [{ module: 'm/a.bicep', symbol: 'lake', binding: 'cfg.x' }];
  const { fresh, carried } = partitionFindings(
    [f('m/a.bicep', 'lake', 'cfg.x'), f('m/b.bicep', 'lake', 'cfg.x')],
    register,
  );
  assert.equal(carried.length, 1);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].module, 'm/b.bicep');
});

test('the register is keyed on (module, symbol, binding) — a DIFFERENT deref in the same file is FRESH', () => {
  const register = [{ module: 'm/a.bicep', symbol: 'lake', binding: 'cfg.x' }];
  const { fresh } = partitionFindings([{ module: 'm/a.bicep', symbol: 'vault', binding: 'cfg.y' }], register);
  assert.equal(fresh.length, 1);
});

test('a registration the analyzer no longer reproduces is STALE — the register must shrink', () => {
  const register = [{ module: 'm/a.bicep', symbol: 'lake', binding: 'cfg.x' }];
  assert.equal(staleRegistrations([], register).length, 1);
  assert.equal(staleRegistrations([{ module: 'm/a.bicep', symbol: 'lake', binding: 'cfg.x' }], register).length, 0);
});

test('every KNOWN_DORMANT entry records why it is dormant and where it is tracked', () => {
  // NO `length > 0` assertion. The register is designed to shrink to zero as the
  // debt is paid — it reached zero on 2026-08-14 when #3357 converted the last
  // three modules — and an emptiness floor here would have made paying that debt
  // fail CI. The register's machinery stays proven by the three fixture tests
  // above (which pass their own synthetic register) and by verifyControls(),
  // neither of which depends on this array being populated.
  for (const r of KNOWN_DORMANT) {
    assert.match(r.module, /^modules\/.+\.bicep$/);
    assert.ok(r.symbol && r.binding);
    assert.ok(r.dormantBecause && r.dormantBecause.length > 20, `${r.module} needs a measured reason`);
    assert.match(r.issue, /^#\d+$/);
  }
});


// ── #3338 — the cross-subscription lake grant pass's OWNERSHIP invariant ─────
//
// WHY THESE LIVE HERE. `modules/data-plane/dlz-lake-grant-pass.bicep` is the
// only owner of lake role assignments that `modules/admin-plane/main.bicep`
// cannot make itself (the lake is in another subscription). Two ways to break
// it are one keystroke apart, both read GREEN on every existing gate, and both
// are what #3338 asks for:
//
//   1. THREAD THE PARAM, FORGET THE ASSIGNMENT. Add a principal to the pass and
//      to main.bicep's call, and stop. Bicep compiles, deployment validate
//      passes, the pass still reports the ONE grant it already had, and the new
//      capability is bound with no grant — the exact defect #3338 names.
//   2. GRANT A LONG-LIVED SHARED IDENTITY. The pass may only grant identities
//      the deployment itself mints, because a pre-existing (scope, principal,
//      role) tuple makes ARM reject a second assignment under a different
//      guid() name and FAILS THE WHOLE DEPLOYMENT. Not a guess: this repo has
//      paid for it three times — main.bicep's `adminAppResourcesRbac` gating
//      note (the app-resources leaf "failed RoleAssignmentExists on EVERY
//      deploy in BOTH topologies"), main.bicep's monitoring-reader-rbac
//      `digestPrincipalId: ''` note, and admin-plane/main.bicep's note on the
//      REMOVED `reportSubscriptionsPrincipalId` output. Those are cited by
//      SYMBOL, not by line: an earlier revision of this block cited a line
//      number in admin-plane/main.bicep and its own diff moved that line.
//      The Console UAMI already holds Storage Blob Data Contributor on the live
//      Commercial lake from an out-of-band grant (measured 2026-08-13, recorded
//      in the pass's own header). #3338 asked for exactly that principal at
//      exactly that role.
//
// HOW THESE GUARDS ARE KEYED, AND WHY IT IS AN INVENTORY AND NOT A PATTERN.
//
// Three earlier revisions of this block each lost to one edit, and the pattern
// is the lesson, not the individual escapes:
//
//   * revision 1 keyed GUARD 2 to param NAMES (`/PrincipalId$/`), so the
//     identical Console-UAMI grant under `consoleUamiObjectId` read green;
//   * revision 2 moved GUARD 2 to the `principalId:` expression but read it via
//     `fieldAt(body, 'principalId', 4)` — exactly four leading spaces, top-level
//     `resource` declarations only. An inline `properties: { … principalId: x }`
//     was invisible, and so was a grant delegated to a child `module` (which is
//     this repo's own convention for lake RBAC). GUARD 1 meanwhile still keyed
//     on `/PrincipalId$/` plus "referenced by nothing", so a param that IS
//     referenced (by a grant-gate `var` and an `output`) under a name without
//     that suffix went green while carrying no assignment at all;
//   * revision 3 keyed EVERYTHING to declarations inside the callee, and so
//     could not see the CALL SITE. Leaving the pass byte-identical and changing
//     one line of main.bicep — `s3GatewayPrincipalId: … adminPlane!.outputs.`
//     `uamiConsolePrincipalId` — made the pass's one assignment grant the
//     Console UAMI. Measured 2026-09-09 on the real shipped main.bicep: revision
//     3's suite passed 35/35 on that mutation. A one-token role flip (Reader →
//     Contributor) was equally invisible, and it also falsified the pass's own
//     shipped `s3GatewayRoleDefinitionId` @description.
//   * revision 4 added the call site but kept the whole thing keyed to the
//     pass's FILENAME and to a 185-file population. Two more bypasses, both
//     reviewer-built, both reproduced here on disk against the real shipped
//     tree with revision 4's own test file (`git show f9da36d07a0:…`) as the
//     control: a SIBLING MODULE granting the Console UAMI Storage Blob Data
//     Contributor at the lake's scope (revision 4: rc 0, 40/40 GREEN; head:
//     rc 1, GUARD 5 red — and `az bicep build` rc 0, 3,984,293 bytes, with the
//     grant readable in the emitted ARM at
//     `subscriptionId=[variables('lakeAdoptSub')]`), and a second call site of
//     the pass in `deploy/bicep/gov/main.bicep` (revision 4: rc 0, 40/40 GREEN;
//     head: rc 1, GUARDS 4+5 red; `az bicep build` rc 0, 126,243 bytes). In both
//     cases `check-module-existing-scope.mjs` stayed rc 0 with no NEW finding —
//     the shipped checker is blind to this class too, by design, and that is
//     disclosed rather than fixed here.
//
// All of them were reviewer-built counterexamples, reproduced on disk against
// the real files. Enumerating one more syntax would just move the next escape. So
// the primary key is an INVENTORY of the pass, taken from the three bicep
// KEYWORDS that no layout can hide — `param`, `resource`, `module`, each of
// which must begin a statement — plus the two things an inventory of the callee
// structurally cannot see: the ROLE the assignment carries, and the ARGUMENTS
// the single call site binds.
//
//   GUARD 1  every `param` the pass declares is in PASS_PARAM_REGISTER, with a
//            `kind` and a reason. A `principal` param must reach the
//            `principalId` of a real role assignment; a `config` param must not.
//            Adding ANY param under ANY name, referenced or not, is red until
//            registered — which is where a reviewer has to look at it.
//   GUARD 2  every `resource` and `module` the pass declares is in
//            PASS_BODY_REGISTER, every principal that actually reaches a
//            `principalId` is on the self-minted allowlist, and every role guid
//            reachable inside a roleAssignments declaration is in
//            PASS_GRANTED_ROLES. The first part closes the inline-object and
//            delegated-module forms: they add a declaration, whatever their
//            layout. The last closes the one-token escalation, which adds none.
//   GUARD 3  only modules whose grant the pass OWNS may gate their deploy on
//            `loomStorageWillBeGranted`.
//   GUARD 4  the pass has exactly ONE call site in the WHOLE REPOSITORY (357
//            `.bicep`, not the 185 under platform/fiab/bicep — one of the other
//            172 is `deploy/bicep/gov/main.bicep`, which deploy-gov.yml
//            deploys); every argument main.bicep binds there is registered next
//            to the param; and each `principal` argument is traced hop by hop to
//            a `userAssignedIdentities` resource that s3-gateway-aca.bicep
//            DECLARES rather than adopts — the structural form of the
//            self-minted claim.
//   GUARD 5  every module call site whose `scope:` deploys into ANOTHER
//            SUBSCRIPTION is registered, and every role assignment REACHABLE
//            from one at the cross-sub LAKE scope passes GUARD 2's own
//            principal and role registers. This is the only guard whose key is
//            not a filename, and it is the one that catches half 2 of #3338
//            written as a NEW FILE beside the pass.
//
// WHAT THIS STILL IS NOT. It is source analysis, not the compiled ARM. GUARDS
// 1-3 are keyed to declarations in ONE small file whose entire job is to make
// role assignments (deliberately no line count here — that number has drifted
// three times and been corrected three times), so an inventory is a
// proportionate key there and would not be on a 9,000-line orchestrator. It does
// not prove that the emitted ARM contains exactly one role assignment; only
// `az bicep build` over the pass could, and that is not run from node:test here.
// Nor does it reach INSIDE s3-gateway-aca.bicep: the chain ends at that module's
// `storageIdentity` declaration, and an edit there that made the symbol resolve
// to a pre-existing identity while keeping the `= {` form is out of reach and is
// said so rather than covered by implication. GUARD 5's population key is the
// SCOPE EXPRESSION as written, so a grant that reached the lake's resource group
// without a two-argument `resourceGroup(...)` is outside it — not reachable from
// today's subscription-scoped orchestrator, but stated rather than implied
// closed. What it DOES establish is that no new param, resource or module can
// enter the pass, no different role can be granted from it, no different value
// can be bound to it at its call site anywhere in the repository, and no new
// module can be deployed into the lake's subscription, without a reviewer
// registering the change — which is what every #3338 half-fix measured so far,
// including the two a reviewer built after GUARD 4 shipped, had to bypass.
//
// These tests are GREEN at head — head carries neither break. They are trap
// guards, not the fix for a red, and each carries a MUTATION control that
// applies the break to a copy of the REAL source and asserts the checker turns
// red on it. Without that control a green here would be indistinguishable from
// a checker that looks at nothing.

const GRANT_PASS_REL = 'modules/data-plane/dlz-lake-grant-pass.bicep';
const ADMIN_PLANE_REL = 'modules/admin-plane/main.bicep';

const readBicep = (rel) => fs.readFileSync(path.join(BICEP_ROOT, ...rel.split('/')), 'utf8');

/**
 * Every `param` the pass declares, keyed to the `param` KEYWORD at statement
 * start rather than to any naming convention.
 *
 * `parseBicep().params` would do the same job; this reads the lines directly so
 * the two halves of GUARD 1 do not share one reader, and so the key is visibly
 * the keyword. Bicep requires `param` to begin the statement, so unlike an
 * indent or a suffix there is no spelling of a parameter declaration that this
 * misses.
 */
function declaredParamNames(source) {
  return blankComments(source)
    .split(/\r?\n/)
    .map((l) => /^\s*param\s+([A-Za-z_]\w*)\b/.exec(l))
    .filter(Boolean)
    .map((m) => m[1])
    .sort();
}

/**
 * Every `resource` and `module` DECLARATION in the pass, as
 * `<keyword> <symbol> <type-or-target>`.
 *
 * This is the layout-independent half of GUARD 2. A role assignment can be
 * written with `properties:` on its own line, as an inline object, as a `[for
 * …]` loop, or handed to a child module — and every one of those still starts
 * with `resource` or `module`, because bicep has no other way to declare one.
 * Comments are blanked first, so a commented-out declaration is not inventory.
 */
function declaredBodies(source) {
  const out = [];
  for (const line of blankComments(source).split(/\r?\n/)) {
    const t = line.trimStart();
    const r = /^resource\s+([A-Za-z_]\w*)\s+'([^'@]+)@[^']*'/.exec(t);
    if (r) {
      out.push(`resource ${r[1]} ${r[2]}`);
      continue;
    }
    const m = /^module\s+([A-Za-z_]\w*)\s+'([^']+)'/.exec(t);
    if (m) out.push(`module ${m[1]} ${m[2]}`);
  }
  return out.sort();
}

/**
 * Principals that ACTUALLY receive a role assignment in a bicep source: every
 * `principalId:` expression inside the brace-balanced body of every
 * `Microsoft.Authorization/roleAssignments` declaration.
 *
 * Indent-agnostic and inline-object-aware on purpose — the earlier
 * `fieldAt(body, 'principalId', 4)` form required exactly four leading spaces,
 * and a one-line `properties: { … }` slipped past it while compiling to the
 * identical ARM. The capture stops at the first `,`, `}` or newline, so a
 * multi-line compound expression yields a partial string; that is fail-CLOSED
 * (it will not match an allowlist row and lands in the unjustified list).
 *
 * Comments are blanked first, so a commented-out assignment does not count as a
 * grant — the same discipline `parseBicep` applies to `scope:`.
 */
function grantedPrincipalExprs(source) {
  const lines = blankComments(source).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^resource\s+\w+\s+'Microsoft\.Authorization\/roleAssignments@/.test(lines[i].trimStart())) continue;
    const body = blockAt(lines, i)
      .map((b) => b.text)
      .join('\n');
    for (const m of body.matchAll(/\bprincipalId\s*:\s*([^\n,}]+)/g)) out.push(m[1].trim());
  }
  return out;
}

/** The granted principal expressions, trimmed and sorted. */
function grantedPrincipals(source) {
  return grantedPrincipalExprs(source)
    .map((e) => e.trim())
    .sort();
}

/** True when `name` appears inside any granted `principalId` expression. */
function reachesAGrant(source, name) {
  return grantedPrincipalExprs(source).some((expr) => new RegExp(`\\b${name}\\b`).test(expr));
}

/**
 * Every param the cross-sub pass is allowed to declare, and what it is for.
 *
 * `kind: 'principal'` — an identity this pass grants. It MUST reach the
 * `principalId` of a real role assignment, and it must also be justified as
 * self-minted in SELF_MINTED_PASS_PRINCIPALS.
 * `kind: 'config'` — everything else. It must NOT reach a `principalId`; a
 * config param that does is a mislabel hiding a grant.
 *
 * The register is the guard's primary key BECAUSE both known bypasses were
 * name-shaped. #3338's half-fix is "declare a principal param and stop"; under
 * a suffix check it needs only a rename, and under a "referenced by nothing"
 * check it needs only one `!empty(...)` gate var. Neither survives an inventory:
 * a new param is red until someone writes down what it is, and writing down
 * "principal" then demands the assignment this pass refuses to make.
 */
const PASS_PARAM_REGISTER = {
  storageAccountName: {
    kind: 'config',
    why: 'Names the ADLS lake this pass scopes its assignments to. Not an identity; it is dereferenced by the `lake` existing resource and used in the guid() salt.',
  },
  s3GatewayPrincipalId: {
    kind: 'principal',
    why: "The S3 gateway's DEDICATED uami-loom-s3gw-<location>, minted by this same deployment run. The only identity this pass grants; see SELF_MINTED_PASS_PRINCIPALS for why that is structurally safe.",
  },
  assignRoles: {
    kind: 'config',
    why: 'Fail-closed switch for estates that assign lake roles out-of-band (a PIM-managed process). A bool, not an identity.',
  },
};

/**
 * Every `resource` and `module` the cross-sub pass is allowed to declare.
 *
 * A grant cannot be added to this file without adding one of these, in any
 * syntax, so this is the entry that closes the inline-`properties` and
 * delegated-`module` forms together rather than one at a time.
 */
const PASS_BODY_REGISTER = {
  'resource lake Microsoft.Storage/storageAccounts': 'The `existing` lake handle. Read-only, and gated on `anyGrant` so it is never dereferenced on a run that grants nothing.',
  'resource s3GatewayLakeRead Microsoft.Authorization/roleAssignments': 'The ONE grant this pass makes: Storage Blob Data Reader for the S3 gateway UAMI, deterministic guid over (scope, principal, role).',
};

/** Params the pass declares that PASS_PARAM_REGISTER does not account for. */
function unregisteredParams(source) {
  return declaredParamNames(source).filter((p) => !Object.hasOwn(PASS_PARAM_REGISTER, p));
}

/** Registered params the pass no longer declares — the register must not rot. */
function staleParamRegistrations(source) {
  const declared = new Set(declaredParamNames(source));
  return Object.keys(PASS_PARAM_REGISTER)
    .filter((p) => !declared.has(p))
    .sort();
}

/** `resource` / `module` declarations PASS_BODY_REGISTER does not account for. */
function unregisteredBodies(source) {
  return declaredBodies(source).filter((d) => !Object.hasOwn(PASS_BODY_REGISTER, d));
}

/** Registered declarations the pass no longer contains. */
function staleBodyRegistrations(source) {
  const declared = new Set(declaredBodies(source));
  return Object.keys(PASS_BODY_REGISTER)
    .filter((d) => !declared.has(d))
    .sort();
}

/** Registered `principal` params that no role assignment in the file consumes. */
function ungrantedPrincipalParams(source) {
  return declaredParamNames(source)
    .filter((p) => PASS_PARAM_REGISTER[p]?.kind === 'principal')
    .filter((p) => !reachesAGrant(source, p))
    .sort();
}

/** Registered `config` params that nevertheless reach a `principalId`. */
function grantingConfigParams(source) {
  return declaredParamNames(source)
    .filter((p) => PASS_PARAM_REGISTER[p]?.kind === 'config')
    .filter((p) => reachesAGrant(source, p))
    .sort();
}

const SBDR_ROLE_ID = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'; // Storage Blob Data Reader
const SBDC_ROLE_ID = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'; // Storage Blob Data CONTRIBUTOR

const GUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Every role-definition GUID reachable from inside a
 * `Microsoft.Authorization/roleAssignments` declaration in the pass — written
 * inline, or via a `var` this file declares.
 *
 * WHY A SET AND NOT A `roleDefinitionId:` READ. A reviewer's counterexample
 * flipped ONE token — `storageBlobDataReaderRoleId` from Reader to Contributor —
 * which adds no param, resource or module, so the inventory saw nothing while
 * the pass's own shipped `@description` ("READER — never Contributor") became
 * false in `deploy-templates/main.json`. Collecting every guid inside the
 * declaration and demanding each one be REGISTERED is fail-closed against that
 * whatever spelling it takes: the var, the guid() name salt, an inline
 * `properties: { … }`, or a literal in `roleDefinitionId:` itself.
 */
function grantedRoleIds(source) {
  const lines = blankComments(source).split(/\r?\n/);
  const varGuids = new Map();
  for (const [name, expr] of parseBicep(source).vars.entries()) {
    const found = String(expr).match(GUID_RE);
    if (found && found.length === 1) varGuids.set(name, found[0].toLowerCase());
  }
  const out = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^resource\s+\w+\s+'Microsoft\.Authorization\/roleAssignments@/.test(lines[i].trimStart())) continue;
    const body = blockAt(lines, i)
      .map((b) => b.text)
      .join('\n');
    for (const g of body.match(GUID_RE) ?? []) out.add(g.toLowerCase());
    for (const m of body.matchAll(/\b([A-Za-z_]\w*)\b/g)) {
      const g = varGuids.get(m[1]);
      if (g) out.add(g);
    }
  }
  return [...out].sort();
}

/**
 * Every role this pass is allowed to grant. Registered by GUID because the guid
 * is what reaches ARM; the role NAME beside it is what a reviewer reads.
 */
const PASS_GRANTED_ROLES = {
  [SBDR_ROLE_ID]: {
    role: 'Storage Blob Data Reader',
    why: 'READ only, and the exact role the same-subscription path (data-plane/s3-gateway-lake-rbac.bicep) grants for the same identity, so the two paths converge instead of racing. The pass ships `output s3GatewayRoleDefinitionId` with the @description "READER — never Contributor", and that string compiles into apps/fiab-console/deploy-templates/main.json — an escalation here would also make a shipped description false.',
  },
};

/** Role guids the pass grants that PASS_GRANTED_ROLES does not account for. */
function unregisteredGrantedRoles(source) {
  return grantedRoleIds(source).filter((g) => !Object.hasOwn(PASS_GRANTED_ROLES, g));
}

/** Registered roles the pass no longer grants — the register must not rot. */
function staleRoleRegistrations(source) {
  const granted = new Set(grantedRoleIds(source));
  return Object.keys(PASS_GRANTED_ROLES)
    .filter((g) => !granted.has(g))
    .sort();
}

/**
 * Every principal the cross-sub pass is allowed to grant, and why it is safe.
 *
 * The entry bar is STRUCTURAL, not "we have not seen a collision": the identity
 * must be minted by the same deployment run, so it cannot carry a pre-existing
 * assignment. Adding a row for a long-lived identity (the Console UAMI, a
 * customer-supplied SP, anything created out-of-band) is the #3338 trap and is
 * refused in the module header with the measurement behind it.
 *
 * `param` is matched against the principalId EXPRESSION of a real
 * `Microsoft.Authorization/roleAssignments` declaration — never against the set
 * of declared param names. Keying on the name would make the whole guard a
 * spelling check: the identical grant under a param called `consoleUamiObjectId`
 * would sail through, which is precisely the bypass this list exists to refuse.
 */
const SELF_MINTED_PASS_PRINCIPALS = [
  {
    param: 's3GatewayPrincipalId',
    mintedBy: 'modules/data-plane/s3-gateway-aca.bicep — uami-loom-s3gw-<location>, created by this same deployment run',
    why: 'An identity minted on this run cannot already hold a role assignment, so a duplicate-tuple RoleAssignmentExists is structurally impossible rather than merely unobserved. Verified on the live Commercial estate 2026-08-13: no uami-loom-s3gw-* identity exists at all.',
  },
];

/**
 * Principal expressions that RECEIVE a grant in the pass and that no
 * SELF_MINTED_PASS_PRINCIPALS row justifies.
 *
 * Fail-closed on shape as well as on identity: a compound expression
 * (`empty(a) ? b : c`) does not literally match an allowlist row, so it lands
 * here and must be justified explicitly rather than inferred.
 */
function unjustifiedGrantedPrincipals(source) {
  const allowed = new Set(SELF_MINTED_PASS_PRINCIPALS.map((p) => p.param));
  return grantedPrincipals(source).filter((expr) => !allowed.has(expr));
}

/**
 * Activation vars and module conditions in admin-plane that gate their DEPLOY
 * on `loomStorageWillBeGranted` — i.e. that assert "some pass owns my lake
 * grant" — mapped to the pass param that actually owns it.
 *
 * `loomStorageWillBeGranted` is `loomStorageGrantable || loomStorageGrantedElsewhere`,
 * and `loomStorageGrantedElsewhere` is main.bicep:1604's `crossSubLakeGrantsActive`
 * — a statement about the PASS, not about the caller. Borrowing it for a module
 * whose principal the pass does not grant makes the flag assert an ownership
 * that does not exist. That is what #3338's suggested one-liner ("make
 * transformRunnerActive include loomStorageWillBeGranted, mirroring the shape
 * `s3GatewayActive` uses") does:
 * the pass grants the S3 gateway's dedicated identity and nothing else, so the
 * transform runner would gate on someone else's grant.
 */
const CROSS_SUB_GRANT_CONSUMERS = {
  s3GatewayActive: 's3GatewayPrincipalId',
};

/**
 * Activation vars — AND module conditions — whose expression references
 * `loomStorageWillBeGranted`.
 *
 * Module conditions are read ON PURPOSE. An earlier revision filtered
 * `parseBicep(...).vars` only, so `module x '…' = if (foo && loomStorageWillBeGranted)`
 * was outside its reach; it went red on that shape anyway, but for the wrong
 * reason — a `blankComments` that blanked the `//` inside
 * `'https://management.usgovcloudapi.net'` left `parseBicep`'s continuation
 * joiner running to EOF, so `effectiveArmEndpoint` was a 121,678-character var
 * that "referenced" the flag. Both halves are fixed: `blankComments` is
 * string-literal aware, and the module form is measured deliberately.
 */
function willBeGrantedConsumers(adminSource) {
  const { vars, modules } = parseBicep(adminSource);
  const names = new Set();
  for (const [name, expr] of vars.entries()) {
    if (/\bloomStorageWillBeGranted\b/.test(expr)) names.add(name);
  }
  for (const m of modules) {
    if (m.condition && /\bloomStorageWillBeGranted\b/.test(m.condition)) names.add(m.symbol);
  }
  return [...names].sort();
}

/**
 * Consumers of `loomStorageWillBeGranted` whose lake grant NOBODY owns —
 * either unregistered, or registered against a param the pass does not grant.
 */
function unownedWillBeGrantedConsumers(adminSource, passSource) {
  return willBeGrantedConsumers(adminSource).filter((v) => {
    const owner = CROSS_SUB_GRANT_CONSUMERS[v];
    return !owner || !reachesAGrant(passSource, owner);
  });
}

test('#3338 GUARD 1: every param the cross-sub pass declares is registered, and every principal param carries a role assignment', () => {
  const source = readBicep(GRANT_PASS_REL);
  // Non-vacuity first: a reader that found no params or no assignments at all
  // would satisfy every assertion below while measuring nothing.
  assert.ok(declaredParamNames(source).length > 0, 'the pass must declare at least one param');
  assert.ok(grantedPrincipalExprs(source).length > 0, 'the pass must contain at least one role assignment');
  assert.ok(
    Object.values(PASS_PARAM_REGISTER).some((e) => e.kind === 'principal'),
    'the register must classify at least one param as a principal',
  );

  assert.deepEqual(
    unregisteredParams(source),
    [],
    'dlz-lake-grant-pass.bicep declares a param PASS_PARAM_REGISTER does not account for. Threading a principal in and stopping is the #3338 defect; register it with a kind and a reason, and if it is a principal, grant it or do not add it.',
  );
  assert.deepEqual(
    staleParamRegistrations(source),
    [],
    'PASS_PARAM_REGISTER lists a param the pass no longer declares — a register nobody prunes is how a ratchet becomes a mute button',
  );
  assert.deepEqual(
    ungrantedPrincipalParams(source),
    [],
    'a principal registered in the cross-sub pass reaches no roleAssignments principalId — bound-and-ungranted, the #3338 defect re-created',
  );
  assert.deepEqual(
    grantingConfigParams(source),
    [],
    'a param registered as `config` reaches a roleAssignments principalId — it is a principal wearing a config label, and it has bypassed the self-minted justification',
  );
});

test('#3338 GUARD 1 — MUTATION control: a threaded, ungranted principal goes RED under any param name and any wiring', () => {
  const head = readBicep(GRANT_PASS_REL);
  // Every spelling the two previous revisions of this guard lost to:
  //   consolePrincipalId  — the /PrincipalId$/ suffix the name check saw;
  //   consoleUamiObjectId — a name it did not, referenced only by a grant-gate
  //                         var and an output, so "unreferenced" missed it too.
  //                         This is the reviewer's counterexample verbatim.
  for (const name of ['consolePrincipalId', 'consoleUamiObjectId']) {
    const bare = head.replace(
      "param s3GatewayPrincipalId string = ''",
      `param s3GatewayPrincipalId string = ''\n\nparam ${name} string = ''`,
    );
    assert.notEqual(bare, head, 'the bare mutation must actually apply');
    assert.deepEqual(unregisteredParams(bare), [name]);

    // …and the same param made to look busy: a grant-gate var, a folded
    // `anyGrant`, and a counted output. Nothing is unreferenced; still no grant.
    const wired = bare
      .replace(
        'var anyGrant = grantS3Gateway',
        `var grantConsole = assignRoles && !empty(${name})\nvar anyGrant = grantS3Gateway || grantConsole`,
      )
      .replace(
        'output grantsApplied int = grantS3Gateway ? 1 : 0',
        'output grantsApplied int = (grantS3Gateway ? 1 : 0) + (grantConsole ? 1 : 0)',
      );
    assert.notEqual(wired, bare, 'the wired mutation must actually apply');
    assert.ok(/var grantConsole =/.test(wired), 'the grant-gate var must be present');
    assert.ok(/\(grantConsole \? 1 : 0\)/.test(wired), 'the counted output must be present');
    assert.deepEqual(unregisteredParams(wired), [name]);
    // And it is still ungranted once registered as a principal — the register
    // is not a way to wave it through.
    assert.equal(reachesAGrant(wired, name), false);
  }
});

test('#3338 GUARD 2: the cross-sub pass declares only registered resources/modules, and grants ONLY identities the deployment itself mints', () => {
  const source = readBicep(GRANT_PASS_REL);
  // Non-vacuity: this guard reads declarations and role assignments, so zero of
  // either would make the assertions below trivially true.
  assert.ok(declaredBodies(source).length > 0, 'the pass must declare at least one resource or module');
  assert.ok(
    grantedPrincipals(source).length > 0,
    'the pass must contain at least one role assignment for this guard to measure',
  );

  assert.deepEqual(
    unregisteredBodies(source),
    [],
    'dlz-lake-grant-pass.bicep declares a resource or module PASS_BODY_REGISTER does not account for. Every added grant starts with one of those two keywords — inline `properties`, a `[for]` loop, or a delegated child module alike — so this is where a new grant has to be justified.',
  );
  assert.deepEqual(
    staleBodyRegistrations(source),
    [],
    'PASS_BODY_REGISTER lists a resource or module the pass no longer declares',
  );
  assert.deepEqual(
    unjustifiedGrantedPrincipals(source),
    [],
    'dlz-lake-grant-pass.bicep grants a principal with no self-minted justification. A long-lived identity (the Console UAMI above all) may already hold the tuple, and ARM then fails the deployment with RoleAssignmentExists — see the module header and main.bicep\'s adminAppResourcesRbac gating note.',
  );
  // The allowlist must not rot in the other direction either: a row for a
  // principal the pass no longer declares is stale and must be removed.
  const declared = new Set(declaredParamNames(source));
  for (const p of SELF_MINTED_PASS_PRINCIPALS) {
    assert.ok(declared.has(p.param), `${p.param} is allowlisted but the pass no longer declares it`);
    assert.ok(PASS_PARAM_REGISTER[p.param]?.kind === 'principal', `${p.param} must be registered as a principal`);
    assert.ok(p.mintedBy && p.mintedBy.length > 20, `${p.param} must name what mints it`);
    assert.ok(p.why && p.why.length > 40, `${p.param} needs a measured reason, not an assertion`);
  }

  // …and WHICH ROLE, which is invisible to the declaration inventory: a
  // one-token Reader→Contributor swap adds no param, resource or module.
  assert.ok(grantedRoleIds(source).length > 0, 'no role guid was read at all — this half would be vacuous');
  assert.deepEqual(
    unregisteredGrantedRoles(source),
    [],
    'dlz-lake-grant-pass.bicep grants a role definition PASS_GRANTED_ROLES does not account for. This pass is READ-ONLY on the lake by design; an escalation to Storage Blob Data Contributor is the write half of #3338 and also falsifies the shipped `s3GatewayRoleDefinitionId` @description.',
  );
  assert.deepEqual(
    staleRoleRegistrations(source),
    [],
    'PASS_GRANTED_ROLES lists a role the pass no longer grants — prune it, or the register is a mute button',
  );
  assert.equal(
    grantedRoleIds(source).includes(SBDC_ROLE_ID),
    false,
    'the pass grants Storage Blob Data CONTRIBUTOR — the exact role #3338 asks for, refused in the module header',
  );
});

test('#3338 GUARD 2 — MUTATION control: escalating the granted role to Contributor goes RED in both spellings', () => {
  const head = readBicep(GRANT_PASS_REL);
  assert.deepEqual(unregisteredGrantedRoles(head), [], 'head must be clean before the mutation means anything');

  // (a) the one-token var flip — the reviewer's counterexample verbatim.
  const viaVar = head.replace(`'${SBDR_ROLE_ID}'`, `'${SBDC_ROLE_ID}'`);
  assert.notEqual(viaVar, head, 'the var mutation must actually apply');
  assert.deepEqual(unregisteredGrantedRoles(viaVar), [SBDC_ROLE_ID]);
  assert.deepEqual(staleRoleRegistrations(viaVar), [SBDR_ROLE_ID]);

  // (b) the var left innocent and the guid written straight into the
  // assignment, so a diff reader scanning the `var` block sees nothing.
  const viaInline = head.replace(
    "roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderRoleId)",
    `roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '${SBDC_ROLE_ID}')`,
  );
  assert.notEqual(viaInline, head, 'the inline mutation must actually apply');
  assert.deepEqual(unregisteredGrantedRoles(viaInline), [SBDC_ROLE_ID]);
});

/**
 * Applies the FULL fix #3338 asks for to an in-memory copy of the real pass —
 * the Console UAMI param AND a real Storage Blob Data Contributor grant for it
 * — in each of the three syntaxes a previous revision of these guards missed.
 *
 * `blockForm`:
 *   'block'  — `properties:` on its own line, four-space `principalId:`. The
 *              only shape the `fieldAt(…, 4)` reader could see.
 *   'inline' — the identical grant with `properties: { … }` on one line. Bicep
 *              has no formatter wired in this repo (`grep -rn "bicep format"
 *              .github/workflows/ dev-loop/ Makefile` finds nothing), so layout
 *              is unconstrained and this is a legal, reviewable diff.
 *   'module' — the grant delegated to a scoped child module, which is this
 *              repo's OWN documented convention for lake RBAC
 *              (s3-gateway-lake-rbac.bicep, transform-runner-lake-rbac.bicep,
 *              serving-tier-lake-rbac.bicep all exist for that stated reason),
 *              so it is the most likely form a real change would take.
 */
function withConsoleUamiGrant(head, paramName, blockForm) {
  const withParam = head.replace(
    "param s3GatewayPrincipalId string = ''",
    `param s3GatewayPrincipalId string = ''\n\nparam ${paramName} string = ''`,
  );
  assert.notEqual(withParam, head, 'the param half of the mutation must actually apply');

  if (blockForm === 'module') {
    return (
      `${withParam}\n` +
      `module consoleLakeWrite 'transform-runner-lake-rbac.bicep' = if (!empty(${paramName})) {\n` +
      `  name: 'console-lake-write'\n` +
      `  params: {\n` +
      `    storageAccountName: storageAccountName\n` +
      `    principalId: ${paramName}\n` +
      `  }\n` +
      `}\n`
    );
  }

  const properties =
    blockForm === 'inline'
      ? `  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '${SBDC_ROLE_ID}'), principalId: ${paramName}, principalType: 'ServicePrincipal' }\n`
      : `  properties: {\n` +
        `    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '${SBDC_ROLE_ID}')\n` +
        `    principalId: ${paramName}\n` +
        `    principalType: 'ServicePrincipal'\n` +
        `  }\n`;

  return (
    `${withParam}\n` +
    `resource consoleLakeWrite 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(${paramName})) {\n` +
    `  name: guid(lake.id, ${paramName}, '${SBDC_ROLE_ID}')\n` +
    `  scope: lake\n` +
    properties +
    `}\n`
  );
}

test('#3338 GUARD 2 — MUTATION control: the full Console-UAMI grant goes RED under either param name AND all three syntaxes', () => {
  const head = readBicep(GRANT_PASS_REL);
  for (const paramName of ['consolePrincipalId', 'consoleUamiObjectId']) {
    for (const blockForm of ['block', 'inline', 'module']) {
      const mutated = withConsoleUamiGrant(head, paramName, blockForm);

      // The param inventory catches every one of them on its own…
      assert.deepEqual(unregisteredParams(mutated), [paramName], `${paramName}/${blockForm}: param inventory`);
      // …and so does the body inventory, which is the half that does not care
      // how the grant is written.
      assert.deepEqual(
        unregisteredBodies(mutated),
        [
          blockForm === 'module'
            ? 'module consoleLakeWrite transform-runner-lake-rbac.bicep'
            : 'resource consoleLakeWrite Microsoft.Authorization/roleAssignments',
        ],
        `${paramName}/${blockForm}: body inventory`,
      );

      // For the two `resource` forms the principalId reader must ALSO see it —
      // that is the specific diagnostic, and it is what makes the message name
      // the identity rather than just the declaration.
      if (blockForm !== 'module') {
        assert.deepEqual(grantedPrincipals(mutated), [paramName, 's3GatewayPrincipalId'].sort());
        assert.deepEqual(unjustifiedGrantedPrincipals(mutated), [paramName]);
      }
    }
  }
});

test('#3338 GUARD 3: only modules whose grant the pass OWNS may gate their deploy on loomStorageWillBeGranted', () => {
  const admin = readBicep(ADMIN_PLANE_REL);
  assert.ok(
    willBeGrantedConsumers(admin).length > 0,
    'loomStorageWillBeGranted must still have at least one consumer — otherwise this guard measures nothing',
  );
  assert.deepEqual(
    unownedWillBeGrantedConsumers(admin, readBicep(GRANT_PASS_REL)),
    [],
    'a module gates its deploy on loomStorageWillBeGranted ("a pass owns my lake grant") whose principal dlz-lake-grant-pass.bicep does not grant',
  );
});

test('#3338 GUARD 3 — MUTATION control: borrowing the flag for the transform runner goes RED, named correctly, in BOTH shapes', () => {
  const head = readBicep(GRANT_PASS_REL);
  const admin = readBicep(ADMIN_PLANE_REL);

  // (a) the literal one-liner #3338 proposed — the activation var.
  const viaVar = admin.replace(
    'var transformRunnerActive = dbtRunnerActive\n',
    'var transformRunnerActive = dbtRunnerActive && loomStorageWillBeGranted\n',
  );
  assert.notEqual(viaVar, admin, 'the var mutation must actually apply');
  assert.deepEqual(unownedWillBeGrantedConsumers(viaVar, head), ['transformRunnerActive']);

  // (b) the same intent expressed on the module condition instead. An earlier
  // revision read `vars` only and went red on this shape by ACCIDENT, naming
  // `effectiveArmEndpoint` — a string var that never mentions the flag. It must
  // now go red on purpose, naming the module.
  const viaModule = admin.replace(
    "module transformRunner '../integration/transform-runner-aca.bicep' = if (transformRunnerActive) {",
    "module transformRunner '../integration/transform-runner-aca.bicep' = if (transformRunnerActive && loomStorageWillBeGranted) {",
  );
  assert.notEqual(viaModule, admin, 'the module mutation must actually apply');
  assert.deepEqual(unownedWillBeGrantedConsumers(viaModule, head), ['transformRunner']);
});

test('#3338 GUARD 3 — the admin-plane parse is not a runaway: no var swallows the file', () => {
  // The regression control for the `blankComments` string-literal fix. Before
  // it, `effectiveArmEndpoint` parsed as 121,678 characters because the `//` in
  // 'https://management.usgovcloudapi.net' was blanked, unbalancing a paren and
  // letting the var-continuation joiner run to EOF. Every "which var mentions
  // X" question in this file — GUARD 3 included — silently answered
  // `effectiveArmEndpoint` for any X below that line.
  const { vars } = parseBicep(readBicep(ADMIN_PLANE_REL));
  const armEndpoint = vars.get('effectiveArmEndpoint');
  assert.ok(armEndpoint, 'effectiveArmEndpoint must still parse');
  assert.ok(
    armEndpoint.length < 1000,
    `effectiveArmEndpoint parsed as ${armEndpoint.length} chars — blankComments is eating a string literal again`,
  );
  const longest = Math.max(...[...vars.values()].map((v) => v.length));
  assert.ok(longest < 2000, `a var parsed as ${longest} chars — the continuation joiner is running away`);
  assert.equal(
    /\bloomStorageWillBeGranted\b/.test(armEndpoint),
    false,
    'effectiveArmEndpoint must not appear to reference the grant flag',
  );
});

// ── GUARD 4 — the CALL SITE, because the callee's inventory cannot see it ────
//
// A reviewer built the escape that motivated this guard, one level out from
// where GUARDS 1-3 look: leave the pass untouched and change what main.bicep
// BINDS to it.
//
//     -    s3GatewayPrincipalId: deployAdminPlane ? adminPlane!.outputs.s3GatewayStorageUamiPrincipalId : ''
//     +    s3GatewayPrincipalId: deployAdminPlane ? adminPlane!.outputs.uamiConsolePrincipalId : ''
//
// That compiles (`output uamiConsolePrincipalId` exists in admin-plane), adds no
// param, resource or module, and made the pass's ONE assignment grant the
// Console UAMI — the exact identity, role and scope the module header spends 62
// lines refusing — with all three guards green. Half 2 of #3338's fix ("GRANT A
// LONG-LIVED SHARED IDENTITY") never needed the property GUARDS 1-3 enforce.
//
// So the ARGUMENT is registered next to the param, the call site's SCOPE is
// registered beside it, and the identity CHAIN behind the principal is
// registered hop by hop, ending at a structural fact rather than another name:
// the terminal expression must dereference a `userAssignedIdentities` resource
// that the minting module DECLARES (not `existing`) — which is what "minted by
// this same deployment run, so it cannot already hold the tuple" actually means.
// Renaming things does not satisfy that; repointing the chain at a long-lived
// identity breaks it at whichever hop was repointed.
//
// THE POPULATION IS THE OTHER HALF OF THE GUARD, and revision 1 got it wrong.
// It read exactly ONE hard-coded file (`main.bicep`) through a module regex that
// could not parse a `[for]` declaration, so a second call site escaped it two
// ways, both measured by a reviewer, both compiling, both 39/39 GREEN:
//
//   B1  the same pass invoked from `modules/admin-plane/main.bicep` — not an
//       exotic location, it is where the sibling lake-RBAC delegations already
//       live (`transformRunnerLakeRbac … scope: resourceGroup(loomDlzRg)`), so it
//       is the most likely place a future half 2 of #3338 would be written.
//   B2  a second call site inside `main.bicep` itself, in `= [for … : {` form,
//       which `MODULE_RE`'s old `\[[^\]]*\]` alternative could never match
//       because a bicep loop does not close its bracket on the declaration line.
//       The guard's OWN declared case, beaten by a layout change.
//
// Both were closed by two changes: read a whole tree rather than one file, and
// teach the reader the loop form (see `LOOP_PREFIX` in
// check-module-existing-scope.mjs).
//
//   B3  and then the tree was still the WRONG ONE. `loadTree(BICEP_ROOT)` is 185
//       of the repository's 357 tracked `.bicep`. Among the 172 it skipped is
//       `deploy/bicep/gov/main.bicep`, which `.github/workflows/deploy-gov.yml`
//       builds (:135) and deploys (:212, :296). A second call site written there
//       is a real, deployed call site on the sovereign path — and per
//       cloud-parity.md a boundary-specific grant is exactly the change that
//       would be written there. Measured on the real file: revision 4's suite
//       rc 0, 40/40 GREEN; `az bicep build` of the mutated Gov orchestrator
//       rc 0, 126,243 bytes. The population is now the whole repository, proved
//       complete against `git ls-files '*.bicep'` rather than against a
//       directory list.
//
// `sites.length === 1` is now the invariant the pass's header claims — a
// statement about the repository — rather than a claim about one file or one
// tree.
//
// WHERE THE CHAIN'S REGISTRATION STOPS, stated rather than implied: at
// s3-gateway-aca.bicep's `storageIdentity` declaration. A change INSIDE that
// module that made `storageIdentity` resolve to something pre-existing while
// keeping the `= {` form (an `existingIdentityName` param threaded into `name:`,
// say) is outside what this reads. That is a different module with a different
// job, and pretending otherwise is how the previous two revisions of these
// guards over-claimed.

const ORCHESTRATOR_REL = 'main.bicep';
const S3_GATEWAY_REL = 'modules/data-plane/s3-gateway-aca.bicep';

// REPO-RELATIVE keys, because the population is now the WHOLE repository and
// not one tree. `readBicep` still reads BICEP_ROOT-relative paths (it is a file
// reader, not a population), so both spellings exist on purpose and the prefix
// is written once.
const PLATFORM_PREFIX = 'platform/fiab/bicep/';
const GRANT_PASS_REPO_REL = `${PLATFORM_PREFIX}${GRANT_PASS_REL}`;
const ADMIN_PLANE_REPO_REL = `${PLATFORM_PREFIX}${ADMIN_PLANE_REL}`;
const ORCHESTRATOR_REPO_REL = `${PLATFORM_PREFIX}${ORCHESTRATOR_REL}`;
const S3_GATEWAY_REPO_REL = `${PLATFORM_PREFIX}${S3_GATEWAY_REL}`;
/**
 * The GOV deploy orchestrator — `.github/workflows/deploy-gov.yml` builds it at
 * :135 and deploys it at :212 and :296 (measured at this commit). It is NOT
 * under platform/fiab/bicep, which is the whole point of BICEP_POPULATION_FLOOR
 * moving to the repo-wide population: a call site written here was invisible.
 */
const GOV_ORCHESTRATOR_REPO_REL = 'deploy/bicep/gov/main.bicep';

/**
 * Directories the `.bicep` walk does not descend into.
 *
 * NOT a definition of the population — the population is "every `.bicep` in the
 * repository", and the test below proves this walk finds every TRACKED one via
 * `git ls-files`, so an over-broad entry here reds rather than silently
 * shrinking the guard. `worktrees` is load-bearing locally: this repo carries
 * agent worktrees under `.claude/worktrees/`, each a full copy of the tree, and
 * without it a single run would parse the same orchestrator dozens of times and
 * report every copy as an unregistered cross-subscription call site.
 */
const SCAN_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'dist',
  'build',
  'out',
  'temp',
  'worktrees',
]);

/**
 * Discovery floor for the WHOLE-REPO population.
 *
 * Measured at this commit: `git ls-files '*.bicep'` -> **357**, of which **185**
 * sit under platform/fiab/bicep. The 172 outside it are not a rounding error —
 * one of them is `deploy/bicep/gov/main.bicep`, a live Gov deploy orchestrator,
 * and per cloud-parity.md a sovereign-boundary grant is exactly the kind of
 * change that would be written there. Deliberately slack: a broken-scan
 * tripwire, not a census a legitimate deletion should break. The real
 * completeness proof is the `git ls-files` cross-check below.
 */
const BICEP_POPULATION_FLOOR = 300;

/**
 * The registered ARGUMENT for every param at the pass's single call site.
 *
 * Compared with `norm()` (whitespace- and quote-insensitive) so reformatting is
 * not a false red, but any change to WHAT IS BOUND is.
 */
const PASS_CALLSITE_REGISTER = {
  storageAccountName: {
    expr: "lakeAdoptName",
    why: "main.bicep's `var lakeAdoptName = adoptName(adopt, 'storage-adls')` — the lake's name comes from the ADOPT PLAN, the same document that bound loomStorageAccount, and the call site's `scope: resourceGroup(lakeAdoptSub, lakeAdoptRg)` reads the sub/rg from its two neighbours, `lakeAdoptRg` and `lakeAdoptSub`. Cited by SYMBOL: this row said `main.bicep:670` for three revisions. That number is still correct at this commit (re-measured — `main.bicep:670` IS that var), which is exactly why it survived two deliberate sweeps of line citations out of this PR; correct-for-now is not the standard the rest of these registers hold.",
  },
  s3GatewayPrincipalId: {
    expr: "deployAdminPlane ? adminPlane!.outputs.s3GatewayStorageUamiPrincipalId : ''",
    why: "The ONE principal this pass grants. The ternary keeps the output unevaluable when the admin plane is skipped; the value itself must stay the S3 gateway's dedicated UAMI — see PRINCIPAL_ARGUMENT_CHAIN for the hops behind it.",
  },
  assignRoles: {
    expr: '!skipRoleGrants',
    why: 'Fail-closed switch, a bool, not an identity.',
  },
};

/**
 * The registered SCOPE of the call site — WHERE the one role assignment lands.
 *
 * Registered because the arguments alone do not pin it: `storageAccountName` is
 * a bare name, and the pass's unscoped `existing` resolves it in whatever
 * resource group the CALLER deploys the module at. Repointing
 * `resourceGroup(lakeAdoptSub, lakeAdoptRg)` at another subscription/RG
 * therefore retargets the grant without touching a single registered argument.
 * It cannot introduce a new PRINCIPAL — that is why the reviewer graded it below
 * B1/B2 — but leaving it out was the same "registered next to the param" idea
 * half-applied.
 */
const PASS_CALLSITE_SCOPE = 'resourceGroup(lakeAdoptSub, lakeAdoptRg)';

/**
 * For every param registered `kind: 'principal'`, the chain from the call-site
 * argument to the resource that MINTS the identity. Each hop is an expression
 * this guard reads out of the real source and compares; the last hop is checked
 * structurally.
 */
const PRINCIPAL_ARGUMENT_CHAIN = {
  s3GatewayPrincipalId: {
    // hop 1 — which admin-plane output main.bicep reads (also covered by
    // PASS_CALLSITE_REGISTER; named here so the chain reads end to end).
    adminPlaneOutput: 's3GatewayStorageUamiPrincipalId',
    // hop 2 — what that output is, inside admin-plane/main.bicep.
    adminPlaneExpr: "s3GatewayActive ? s3Gateway!.outputs.storageUamiPrincipalId : ''",
    // hop 3 — the minting module and the output it exposes.
    mintingModule: S3_GATEWAY_REL,
    mintingOutput: 'storageUamiPrincipalId',
    mintingExpr: 'storageIdentity.properties.principalId',
    // hop 3, structurally: the symbol above must be a userAssignedIdentity this
    // module CREATES. `existing` here would mean the identity predates the run,
    // which is precisely the property SELF_MINTED_PASS_PRINCIPALS asserts.
    mintedSymbol: 'storageIdentity',
    mintedType: 'Microsoft.ManagedIdentity/userAssignedIdentities',
  },
};

/** Every `.bicep` under `dir`, keyed REPO-relative, skipping SCAN_SKIP_DIRS. */
function walkBicep(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SCAN_SKIP_DIRS.has(e.name)) continue;
      walkBicep(path.join(dir, e.name), out);
    } else if (e.name.endsWith('.bicep')) {
      const p = path.join(dir, e.name);
      out.set(path.relative(REPO_ROOT, p).split(path.sep).join('/'), fs.readFileSync(p, 'utf8'));
    }
  }
  return out;
}

/**
 * The WHOLE REPOSITORY's bicep, keyed repo-relative, with in-memory mutations.
 *
 * WHY NOT `loadTree(BICEP_ROOT)`, which is what this was. That population was
 * 185 of the repo's 357 `.bicep`, and among the 172 it skipped is
 * `deploy/bicep/gov/main.bicep` — a file `.github/workflows/deploy-gov.yml`
 * actually deploys. A second call site of the grant pass written there was
 * invisible to GUARD 4 while being a real, deployed call site on the sovereign
 * path. `platformOnlyTree()` below preserves the old population so the
 * mutation control can measure that counterfactual rather than assert it.
 *
 * `overrides` must REPLACE a file that exists; `additions` must NOT. A typo'd
 * path in either direction would make a mutation control mutate nothing and
 * pass, which is the one failure a mutation control cannot survive.
 */
/**
 * The on-disk walk, done ONCE. Every call below copies it; nothing in this file
 * writes to the tree on disk, so a second walk would re-read 357 files to
 * produce the same bytes. Measured: caching takes this suite from ~11s to ~3s,
 * and the suite runs inside the required `guardrails` context alongside ~3,250
 * other tests.
 */
let WALK_CACHE = null;

function bicepTree(overrides = new Map(), additions = new Map()) {
  if (WALK_CACHE === null) WALK_CACHE = walkBicep(REPO_ROOT, new Map());
  const tree = new Map(WALK_CACHE);
  for (const [rel, src] of overrides) {
    assert.ok(tree.has(rel), `mutation override ${rel} must replace a real .bicep, not invent one`);
    tree.set(rel, src);
  }
  for (const [rel, src] of additions) {
    assert.ok(!tree.has(rel), `mutation addition ${rel} must be a NEW file, not silently replace a real one`);
    tree.set(rel, src);
  }
  return tree;
}

/** The population this guard USED to have: platform/fiab/bicep only, re-keyed. */
function platformOnlyTree(overrides = new Map()) {
  const out = new Map();
  for (const [rel, src] of loadTree(BICEP_ROOT)) out.set(`${PLATFORM_PREFIX}${rel}`, src);
  for (const [rel, src] of overrides) if (out.has(rel)) out.set(rel, src);
  return out;
}

/** Every call site of the grant pass, in any `.bicep` in the repository. */
function passCallSites(tree) {
  const sites = [];
  for (const [rel, src] of tree) {
    for (const m of parseBicep(src, rel).modules) {
      if (resolveTarget(rel, m.target) === GRANT_PASS_REPO_REL) sites.push({ ...m, file: rel });
    }
  }
  return sites.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
}

const siteLabel = (s) => `${s.file}:${s.line} ${s.symbol}${s.loop ? ' [for]' : ''}`;

/**
 * The expression of `output <name>` in a bicep source, or null.
 *
 * Single-line by design and therefore fail-CLOSED: an output split across lines
 * yields null, which does not match its registered expression and goes red for a
 * reviewer to look at, rather than being silently skipped.
 */
function outputExpr(source, name) {
  const re = new RegExp(`^output\\s+${name}\\s+\\w+\\s*=\\s*(.*)$`);
  for (const line of blankComments(source).split(/\r?\n/)) {
    const m = re.exec(line.trimStart());
    if (m) return m[1].trim();
  }
  return null;
}

/** Call-site bindings — and scopes — that are not the registered ones. */
function misboundCallSiteArgs(tree) {
  const out = [];
  for (const site of passCallSites(tree)) {
    const at = siteLabel(site);
    if (norm(site.scope ?? '') !== norm(PASS_CALLSITE_SCOPE)) {
      out.push(`${at}.<scope>: ${site.scope ?? "NONE — deploys at the caller's own scope"}`);
    }
    for (const [key, expr] of site.params.entries()) {
      const reg = PASS_CALLSITE_REGISTER[key];
      if (!reg) {
        out.push(`${at}.${key}: UNREGISTERED argument`);
        continue;
      }
      if (norm(expr) !== norm(reg.expr)) out.push(`${at}.${key}: ${expr}`);
    }
    for (const key of Object.keys(PASS_CALLSITE_REGISTER)) {
      if (!site.params.has(key)) out.push(`${at}.${key}: registered but NOT BOUND`);
    }
  }
  return out.sort();
}

/** Chain hops that no longer read the way PRINCIPAL_ARGUMENT_CHAIN records. */
function brokenPrincipalChains(adminSource, mintingSources) {
  const broken = [];
  for (const [param, chain] of Object.entries(PRINCIPAL_ARGUMENT_CHAIN)) {
    const adminExpr = outputExpr(adminSource, chain.adminPlaneOutput);
    if (adminExpr === null || norm(adminExpr) !== norm(chain.adminPlaneExpr)) {
      broken.push(`${param}: admin-plane output ${chain.adminPlaneOutput} = ${adminExpr}`);
      continue;
    }
    const mintSource = mintingSources.get(chain.mintingModule);
    const mintExpr = outputExpr(mintSource ?? '', chain.mintingOutput);
    if (mintExpr === null || norm(mintExpr) !== norm(chain.mintingExpr)) {
      broken.push(`${param}: ${chain.mintingModule} output ${chain.mintingOutput} = ${mintExpr}`);
      continue;
    }
    const minted = parseBicep(mintSource ?? '').resources.find((r) => r.symbol === chain.mintedSymbol);
    if (!minted || minted.type !== chain.mintedType || minted.existing) {
      broken.push(
        `${param}: ${chain.mintingModule} ${chain.mintedSymbol} is ${
          minted ? `${minted.type}${minted.existing ? ' EXISTING' : ''}` : 'absent'
        } — not an identity this run mints`,
      );
    }
  }
  return broken.sort();
}

test('#3338 GUARD 4: the pass has exactly ONE call site in the WHOLE tree, and every argument it binds is registered', () => {
  const tree = bicepTree();

  // Population floor: "one call site" over a broken scan measures nothing. This
  // is the assertion revision 1 could not make, because its population was a
  // single hard-coded filename.
  assert.ok(
    tree.size >= BICEP_POPULATION_FLOOR,
    `discovered only ${tree.size} .bicep under ${REPO_ROOT} — the scan is broken, not clean`,
  );
  assert.ok(tree.has(GRANT_PASS_REPO_REL), `${GRANT_PASS_REPO_REL} must be in the scanned tree`);
  assert.ok(tree.has(ORCHESTRATOR_REPO_REL), `${ORCHESTRATOR_REPO_REL} must be in the scanned tree`);
  assert.ok(
    tree.has(GOV_ORCHESTRATOR_REPO_REL),
    `${GOV_ORCHESTRATOR_REPO_REL} must be in the scanned tree — it is a deployed Gov orchestrator outside platform/fiab/bicep, and its absence is what made this population too narrow`,
  );

  const sites = passCallSites(tree);
  assert.equal(
    sites.length,
    1,
    `dlz-lake-grant-pass.bicep must have exactly one call site anywhere in the repository; found ${sites.length}${
      sites.length ? ` (${sites.map(siteLabel).join(', ')})` : ''
    }. A second call site can bind a different principal to the same pass, which is #3338's half 2 with the callee untouched — and it does not have to be in main.bicep, nor under platform/fiab/bicep, nor in non-loop form.`,
  );
  assert.equal(sites[0].file, ORCHESTRATOR_REPO_REL, 'the registered call site lives in main.bicep');
  assert.ok(sites[0].params.size > 0, 'the call site must bind params for this guard to measure anything');
  assert.ok(
    Object.keys(PASS_CALLSITE_REGISTER).every((k) => Object.hasOwn(PASS_PARAM_REGISTER, k)),
    'every registered argument must correspond to a param the pass actually declares',
  );

  assert.deepEqual(
    misboundCallSiteArgs(tree),
    [],
    "the pass is invoked with something other than the registered expressions/scope. The callee's inventory cannot see this edit: swapping the s3 gateway output for adminPlane!.outputs.uamiConsolePrincipalId makes the pass grant the Console UAMI with GUARDS 1-3 green.",
  );
});

test('#3338 GUARD 4: the principal argument chains back to an identity this deployment MINTS', () => {
  const admin = readBicep(ADMIN_PLANE_REL);
  const minting = new Map([[S3_GATEWAY_REL, readBicep(S3_GATEWAY_REL)]]);

  assert.ok(
    Object.keys(PRINCIPAL_ARGUMENT_CHAIN).length > 0,
    'at least one principal chain must be registered — otherwise this guard is vacuous',
  );
  for (const param of Object.keys(PRINCIPAL_ARGUMENT_CHAIN)) {
    assert.equal(PASS_PARAM_REGISTER[param]?.kind, 'principal', `${param} must be a registered principal`);
    assert.ok(Object.hasOwn(PASS_CALLSITE_REGISTER, param), `${param} must also have a registered argument`);
  }

  assert.deepEqual(
    brokenPrincipalChains(admin, minting),
    [],
    'the chain from the pass\'s principal param to the resource that mints the identity no longer reads as registered. SELF_MINTED_PASS_PRINCIPALS\'s "structurally impossible to collide" claim rests on this chain, so a hop that moved must be re-justified, not re-pointed.',
  );
});

test('#3338 GUARD 4 — MUTATION control: the reviewer\'s call-site swap, a second call site, and a repointed chain all go RED', () => {
  const tree = bicepTree();
  const orch = tree.get(ORCHESTRATOR_REPO_REL);
  const admin = readBicep(ADMIN_PLANE_REL);
  const s3gw = readBicep(S3_GATEWAY_REL);
  const minting = new Map([[S3_GATEWAY_REL, s3gw]]);

  assert.deepEqual(misboundCallSiteArgs(tree), [], 'head must be clean before a mutation means anything');
  assert.deepEqual(brokenPrincipalChains(admin, minting), [], 'head chain must be clean');

  // (a) BLOCKER 1 verbatim: the callee untouched, the argument swapped for the
  // Console UAMI. Compiles — `output uamiConsolePrincipalId` exists.
  const swapped = orch.replace(
    's3GatewayPrincipalId: deployAdminPlane ? adminPlane!.outputs.s3GatewayStorageUamiPrincipalId : \'\'',
    's3GatewayPrincipalId: deployAdminPlane ? adminPlane!.outputs.uamiConsolePrincipalId : \'\'',
  );
  assert.notEqual(swapped, orch, 'the call-site mutation must actually apply');
  assert.ok(/output uamiConsolePrincipalId string =/.test(admin), 'the swap target output must really exist');
  const swappedFindings = misboundCallSiteArgs(bicepTree(new Map([[ORCHESTRATOR_REPO_REL, swapped]])));
  assert.equal(swappedFindings.length, 1, `expected one finding, got ${swappedFindings.join(' | ')}`);
  assert.match(
    swappedFindings[0],
    /^platform\/fiab\/bicep\/main\.bicep:\d+ dlzLakeGrantPass\.s3GatewayPrincipalId: deployAdminPlane \? adminPlane!\.outputs\.uamiConsolePrincipalId : ''$/,
  );

  // (b) the pass invoked a SECOND time in main.bicep with a different principal,
  // leaving the registered call site untouched.
  const doubled = `${orch}\nmodule dlzLakeGrantPassConsole 'modules/data-plane/dlz-lake-grant-pass.bicep' = if (crossSubLakeGrantsActive) {\n  name: 'dlz-lake-grant-pass-console'\n  scope: resourceGroup(lakeAdoptSub, lakeAdoptRg)\n  params: {\n    storageAccountName: lakeAdoptName\n    s3GatewayPrincipalId: adminPlane!.outputs.uamiConsolePrincipalId\n    assignRoles: !skipRoleGrants\n  }\n}\n`;
  const doubledTree = bicepTree(new Map([[ORCHESTRATOR_REPO_REL, doubled]]));
  assert.equal(passCallSites(doubledTree).length, 2, 'the second call site must parse');
  assert.ok(
    misboundCallSiteArgs(doubledTree).some((f) => f.includes('dlzLakeGrantPassConsole.s3GatewayPrincipalId:')),
    'the second call site must be named in the finding',
  );

  // (b1) REVIEWER'S BYPASS 1 — a second call site in a file OTHER than
  // main.bicep. `modules/admin-plane/main.bicep` is where the sibling lake-RBAC
  // delegations already live, so it is the likeliest place half 2 gets written.
  // Measured GREEN 39/39 against the one-file population this replaced.
  const elsewhere = `${admin}\nmodule dlzLakeGrantPassConsole '../data-plane/dlz-lake-grant-pass.bicep' = if (loomStorageGrantable && !skipRoleGrants) {\n  name: 'dlz-lake-grant-pass-console'\n  scope: resourceGroup(loomDlzRg)\n  params: {\n    storageAccountName: loomStorageAccount\n    s3GatewayPrincipalId: identity.outputs.uamiConsolePrincipalId\n    assignRoles: !skipRoleGrants\n  }\n}\n`;
  assert.notEqual(elsewhere, admin, 'the out-of-orchestrator mutation must actually apply');
  const elsewhereTree = bicepTree(new Map([[ADMIN_PLANE_REPO_REL, elsewhere]]));
  const elsewhereSites = passCallSites(elsewhereTree);
  assert.equal(elsewhereSites.length, 2, 'the call site outside main.bicep must be SEEN');
  assert.ok(
    elsewhereSites.some((s) => s.file === ADMIN_PLANE_REPO_REL && s.symbol === 'dlzLakeGrantPassConsole'),
    'the second site must be attributed to modules/admin-plane/main.bicep',
  );
  assert.ok(
    misboundCallSiteArgs(elsewhereTree).some((f) =>
      f.startsWith(`${ADMIN_PLANE_REPO_REL}:`) && f.includes('dlzLakeGrantPassConsole.s3GatewayPrincipalId:'),
    ),
    'the out-of-orchestrator principal swap must be named, with its file',
  );

  // (b1-gov) BLOCKER 2 — the same second call site written in
  // `deploy/bicep/gov/main.bicep`, which `.github/workflows/deploy-gov.yml`
  // DEPLOYS (:212, :296). That file is not under platform/fiab/bicep, so the
  // 185-file population this guard used to walk could not see it at all. The
  // counterfactual is MEASURED, not asserted: the same mutation is run through
  // `platformOnlyTree()`, the old population, where it stays at ONE call site.
  const govHead = tree.get(GOV_ORCHESTRATOR_REPO_REL);
  assert.ok(govHead, 'the Gov orchestrator must be in the repo-wide tree');
  const govMutated = `${govHead}\nmodule govLakeGrantPass '../../../platform/fiab/bicep/modules/data-plane/dlz-lake-grant-pass.bicep' = {\n  name: 'gov-lake-grant-pass'\n  scope: resourceGroup(lakeAdoptSub, lakeAdoptRg)\n  params: {\n    storageAccountName: lakeAdoptName\n    s3GatewayPrincipalId: consoleUamiPrincipalId\n    assignRoles: true\n  }\n}\n`;
  const govTree = bicepTree(new Map([[GOV_ORCHESTRATOR_REPO_REL, govMutated]]));
  const govSites = passCallSites(govTree);
  assert.equal(govSites.length, 2, 'the Gov call site must be SEEN by the repo-wide population');
  assert.ok(
    govSites.some((s) => s.file === GOV_ORCHESTRATOR_REPO_REL && s.symbol === 'govLakeGrantPass'),
    'the Gov call site must be attributed to deploy/bicep/gov/main.bicep',
  );
  assert.ok(
    misboundCallSiteArgs(govTree).some((f) => f.startsWith(`${GOV_ORCHESTRATOR_REPO_REL}:`)),
    'the Gov call site must be named, with its file',
  );
  // The counterfactual: the population this replaced could not reach that file.
  const oldPopulation = platformOnlyTree(new Map([[GOV_ORCHESTRATOR_REPO_REL, govMutated]]));
  assert.ok(
    !oldPopulation.has(GOV_ORCHESTRATOR_REPO_REL),
    'the old platform-only population must not contain the Gov orchestrator — that is the gap',
  );
  assert.equal(
    passCallSites(oldPopulation).length,
    1,
    'the old population must read ONE call site on the mutated tree — if it reads 2, this control is measuring the wrong thing',
  );

  // (b2) REVIEWER'S BYPASS 2 — a second call site inside main.bicep in `[for]`
  // form. This is the one that mattered most: the guard's OWN declared case,
  // beaten by a layout change, because MODULE_RE could not parse a loop header.
  // `az bicep build` accepted it (rc 0) and the suite stayed 39/39 GREEN.
  const looped = `${orch}\nvar extraLakeGrants = [\n  'console'\n]\nmodule dlzLakeGrantPassExtra 'modules/data-plane/dlz-lake-grant-pass.bicep' = [for g in extraLakeGrants: if (crossSubLakeGrantsActive) {\n  name: 'dlz-lake-grant-pass-x-\${g}'\n  scope: resourceGroup(lakeAdoptSub, lakeAdoptRg)\n  params: {\n    storageAccountName: lakeAdoptName\n    s3GatewayPrincipalId: deployAdminPlane ? adminPlane!.outputs.uamiConsolePrincipalId : ''\n    assignRoles: !skipRoleGrants\n  }\n}]\n`;
  const loopedTree = bicepTree(new Map([[ORCHESTRATOR_REPO_REL, looped]]));
  const loopedSites = passCallSites(loopedTree);
  assert.equal(loopedSites.length, 2, 'the `[for]` call site must PARSE — this is what MODULE_RE used to miss');
  const loopSite = loopedSites.find((s) => s.symbol === 'dlzLakeGrantPassExtra');
  assert.ok(loopSite, 'the loop call site must be found by symbol');
  assert.equal(loopSite.loop, true, 'the loop form must be recorded as such, so a finding can say so');
  assert.ok(
    misboundCallSiteArgs(loopedTree).some((f) => f.includes('dlzLakeGrantPassExtra [for].s3GatewayPrincipalId:')),
    'the loop call site must be named in the finding, marked as a loop',
  );

  // (b3) the call site's SCOPE repointed at another subscription/RG — every
  // registered ARGUMENT untouched, so only the scope registration catches it.
  const rescoped = orch.replace(
    "  name: 'dlz-lake-grant-pass'\n  scope: resourceGroup(lakeAdoptSub, lakeAdoptRg)",
    "  name: 'dlz-lake-grant-pass'\n  scope: resourceGroup(otherSub, otherRg)",
  );
  assert.notEqual(rescoped, orch, 'the scope mutation must actually apply');
  assert.deepEqual(
    misboundCallSiteArgs(bicepTree(new Map([[ORCHESTRATOR_REPO_REL, rescoped]]))).map((f) => f.replace(/:\d+ /, ' ')),
    [`${ORCHESTRATOR_REPO_REL} dlzLakeGrantPass.<scope>: resourceGroup(otherSub, otherRg)`],
  );

  // (c) the chain repointed one hop out — the admin-plane output itself made to
  // emit the Console UAMI, with main.bicep and the pass both untouched.
  const repointed = admin.replace(
    "output s3GatewayStorageUamiPrincipalId string = s3GatewayActive ? s3Gateway!.outputs.storageUamiPrincipalId : ''",
    "output s3GatewayStorageUamiPrincipalId string = identity.outputs.uamiConsolePrincipalId",
  );
  assert.notEqual(repointed, admin, 'the output mutation must actually apply');
  assert.deepEqual(brokenPrincipalChains(repointed, minting), [
    's3GatewayPrincipalId: admin-plane output s3GatewayStorageUamiPrincipalId = identity.outputs.uamiConsolePrincipalId',
  ]);

  // (d) the terminal structural fact broken: the minting module made to adopt a
  // pre-existing identity instead of creating one.
  const adopted = new Map([
    [
      S3_GATEWAY_REL,
      s3gw.replace(
        "resource storageIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {",
        "resource storageIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {",
      ),
    ],
  ]);
  assert.notEqual(adopted.get(S3_GATEWAY_REL), s3gw, 'the existing-identity mutation must actually apply');
  assert.deepEqual(brokenPrincipalChains(admin, adopted), [
    's3GatewayPrincipalId: modules/data-plane/s3-gateway-aca.bicep storageIdentity is Microsoft.ManagedIdentity/userAssignedIdentities EXISTING — not an identity this run mints',
  ]);
});

test('the walk finds every TRACKED .bicep — the population is a repository fact, not a directory list', () => {
  // The completeness proof behind SCAN_SKIP_DIRS. Every guard from here down
  // states "…anywhere in the repository", and that sentence is only true if the
  // walk actually reaches everywhere. A skip entry that grew a directory of
  // bicep — or a walk that stopped early — would make every "exactly one" and
  // "no unregistered" assertion below quietly weaker, with nothing red.
  //
  // Direction matters: this catches OVER-skipping (a tracked file the walk
  // missed). Under-skipping is the safe direction — an untracked .bicep the
  // walk finds is EXTRA scrutiny, and it goes through the same registration
  // requirement as everything else.
  const tracked = spawnSync('git', ['ls-files', '-z', '--', '*.bicep'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  assert.equal(
    tracked.status,
    0,
    `git ls-files failed, so this measured NOTHING: ${(tracked.stderr || '').trim() || tracked.error?.message}`,
  );
  const trackedPaths = tracked.stdout.split('\0').filter(Boolean).sort();
  assert.ok(
    trackedPaths.length >= BICEP_POPULATION_FLOOR,
    `git tracks only ${trackedPaths.length} .bicep — below the floor, so the comparison below proves little`,
  );
  const walked = bicepTree();
  assert.deepEqual(
    trackedPaths.filter((p) => !walked.has(p)),
    [],
    'SCAN_SKIP_DIRS (or the walk) is dropping tracked .bicep files — every "anywhere in the repository" claim below is narrower than it says',
  );
});

// ── GUARD 5 — the INVARIANT, not the FILENAME ───────────────────────────────
//
// GUARDS 1-4 are all keyed, one way or another, to ONE PATH:
// `modules/data-plane/dlz-lake-grant-pass.bicep`. `GRANT_PASS_REL`,
// `passCallSites`, `PASS_BODY_REGISTER`, `SELF_MINTED_PASS_PRINCIPALS` and
// `PASS_GRANTED_ROLES` all read that file or its call sites. Nothing registered
// WHAT MAY GRANT A ROLE ON THE CROSS-SUB LAKE — only what may be inside that one
// file, and what may call it. So half 2 of #3338 lands by ADDING A FILE.
//
// A reviewer built it, compiled it, and read the grant out of the emitted ARM
// (2026-09-09): a 25-line sibling `dlz-lake-grant-pass-console.bicep` with one
// `Microsoft.Authorization/roleAssignments` granting the Console UAMI Storage
// Blob Data CONTRIBUTOR, invoked from main.bicep at
// `scope: resourceGroup(lakeAdoptSub, lakeAdoptRg)` — the exact
// (scope, principal, role) tuple the pass's header spends ~100 lines refusing —
// with the suite 40/40 GREEN, `check-module-existing-scope.mjs` rc 0 and
// `az bicep build` rc 0. That is not an exotic spelling: the delegated-module
// form IS this repo's convention for lake RBAC, and the test file's own prose
// said so while covering it only when the module is declared INSIDE the pass.
//
// So the population key stops being a filename and becomes a STRUCTURAL FACT
// about the deployment: **a module call site whose `scope:` deploys into a
// DIFFERENT SUBSCRIPTION**. That is `resourceGroup(<sub>, <rg>)` with two
// arguments, `subscription(<id>)`, or `managementGroup(…)` — all three are
// properties of the bicep scope function, not of any name, so a rename, a new
// file, a new directory and a `[for]` loop all land inside the population.
//
// MEASURED at this commit over all 357 tracked `.bicep`: 123 such call sites,
// of which 112 are in the vendored Azure Landing Zones tree
// (`deploy/bicep/landing-zone-alz/`, 437 tracked files, upstream ALZ policy and
// management-group plumbing) and 11 are Loom's own. Registering 11 is
// proportionate; registering 123 would be a register nobody reads. The ALZ
// exemption is therefore CHECKED rather than asserted — the test below proves
// that tree references neither the grant pass nor the lake's adopt symbols, so
// the exemption cannot come to hide a lake grant.
//
// TWO TEETH, not one:
//   * every cross-subscription call site outside the exempt tree must be in
//     CROSS_SUB_CALLSITE_REGISTER, keyed `<file> <symbol> -> <target>`. The
//     reviewer's sibling module is RED here because it is a new, unregistered
//     cross-subscription deployment.
//   * every role assignment REACHABLE from a call site at the cross-sub LAKE
//     scope — the target module and, transitively, the modules it calls — must
//     pass the SAME `SELF_MINTED_PASS_PRINCIPALS` and `PASS_GRANTED_ROLES`
//     checks GUARD 2 applies to the pass. So registering the sibling module does
//     not wave it through: its Console-UAMI principal and its Contributor guid
//     are both refused, by the registers that already existed.
//
// WHAT GUARD 5 DOES NOT CLAIM. It is still source analysis, and its population
// key is the SCOPE EXPRESSION as written. A module that reached the lake's
// resource group WITHOUT a two-argument `resourceGroup(...)` — a single-argument
// scope in a deployment that is already running in the lake's subscription, say
// — is outside it. That is not reachable from `platform/fiab/bicep/main.bicep`,
// which is `targetScope = 'subscription'` and runs in the ADMIN subscription
// (that is the whole reason this pass exists), but it is a real edge on a future
// orchestrator and is written down rather than implied closed.

const CROSS_SUB_EXEMPT_TREES = [
  {
    prefix: 'deploy/bicep/landing-zone-alz/',
    why: 'Upstream Azure Landing Zones bicep (437 tracked files) — management-group policy assignment and subscription plumbing, vendored whole. It accounts for 112 of the 123 cross-subscription call sites in the repo and has nothing to do with the Loom lake; the assertion below re-measures that rather than trusting it.',
  },
];

/** Files the cross-subscription registration requirement does not apply to. */
const inExemptTree = (rel) => CROSS_SUB_EXEMPT_TREES.some((t) => rel.startsWith(t.prefix));

/**
 * Top-level, comma-separated arguments of `fn(...)` in `expr`, or null when
 * `expr` is not a call to `fn`.
 *
 * Top-level matters: `resourceGroup(a, concat(b, c))` is TWO arguments, not
 * three, and a naive `split(',')` would read `subscription(x)` nested in another
 * call as a cross-subscription scope of its own. Quotes are honoured so a comma
 * inside a string literal is not an argument boundary.
 */
function callArgs(expr, fn) {
  const s = String(expr ?? '').trim();
  if (!s.startsWith(`${fn}(`)) return null;
  const args = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (let i = fn.length; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      cur += ch;
      if (ch === '\\') {
        cur += s[i + 1] ?? '';
        i += 1;
      } else if (ch === "'") quoted = false;
      continue;
    }
    if (ch === "'") {
      quoted = true;
      cur += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      if (depth === 1) continue; // the opening paren of fn( itself
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        if (cur.trim()) args.push(cur.trim());
        // Anything after the matching close means this is not a bare call
        // (`resourceGroup(a, b).id`), which is not a module scope. Fail closed.
        return s.slice(i + 1).trim() === '' ? args : null;
      }
    } else if (ch === ',' && depth === 1) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  return null; // unbalanced — fail closed rather than guess
}

/**
 * True when a module call-site `scope:` deploys OUTSIDE the deployment's own
 * subscription: a two-argument `resourceGroup()`, any `subscription(<id>)`, or
 * any `managementGroup()`.
 *
 * A bare `resourceGroup()`, a one-argument `resourceGroup(<rg>)` and a bare
 * `subscription()` all stay inside the current subscription and are not in the
 * population — including them would put several hundred ordinary same-sub
 * delegations in a register no reviewer would read, which is how a register
 * becomes a mute button.
 */
function crossSubscriptionScope(scopeExpr) {
  if (!scopeExpr) return false;
  const s = norm(scopeExpr);
  const rg = callArgs(s, 'resourceGroup');
  if (rg && rg.length >= 2) return true;
  const sub = callArgs(s, 'subscription');
  if (sub && sub.length >= 1) return true;
  return callArgs(s, 'managementGroup') !== null;
}

/** Every module call site in `tree` that deploys into another subscription. */
function crossSubCallSites(tree) {
  const sites = [];
  for (const [rel, src] of tree) {
    for (const m of parseBicep(src, rel).modules) {
      if (!crossSubscriptionScope(m.scope)) continue;
      sites.push({ ...m, file: rel, resolved: resolveTarget(rel, m.target) });
    }
  }
  return sites.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
}

/** The registration key: file, symbol and resolved target — never a line. */
const crossSubKey = (s) => `${s.file} ${s.symbol} -> ${s.resolved ?? s.target}`;

/**
 * Every module Loom deploys into another subscription, and why it is allowed to.
 *
 * This is the population key GUARD 5 replaces a filename with. A new file
 * granting on the cross-sub lake cannot avoid appearing here, because it cannot
 * grant on the lake without being deployed at the lake's scope.
 */
const CROSS_SUB_CALLSITE_REGISTER = {
  [`${ORCHESTRATOR_REPO_REL} dlz -> ${PLATFORM_PREFIX}modules/landing-zone/main.bicep`]:
    'The DLZ landing zone itself, deployed per domain subscription. Creates the domain resources; the grant-bearing leaves below are split out of it deliberately.',
  [`${ORCHESTRATOR_REPO_REL} dlzAccessPolicyRbac -> ${PLATFORM_PREFIX}modules/admin-plane/access-policy-rbac.bicep`]:
    'Access-policy role assignments in each DLZ subscription. Pre-dates this guard; registered as inventory, not as a new grant.',
  [`${ORCHESTRATOR_REPO_REL} dlzAppResourcesRbac -> ${PLATFORM_PREFIX}modules/admin-plane/app-resources-rbac.bicep`]:
    'The app-resources leaf whose collision gating main.bicep documents ("failed RoleAssignmentExists on EVERY deploy in BOTH topologies") — the precedent the pass header cites.',
  [`${ORCHESTRATOR_REPO_REL} dlzItemCreateRbac -> ${PLATFORM_PREFIX}modules/admin-plane/dlz-attach-itemcreate-rbac.bicep`]:
    'Item-create role assignments on a dlz-attach estate.',
  [`${ORCHESTRATOR_REPO_REL} dlzLakeGrantPass -> ${GRANT_PASS_REPO_REL}`]:
    'THE cross-sub lake grant pass — the one call site GUARD 4 registers argument by argument. Its scope is PASS_CALLSITE_SCOPE, so it is also the site whose reachable grants are checked below.',
  [`${ORCHESTRATOR_REPO_REL} dlzAttachHubPeering -> ${PLATFORM_PREFIX}modules/landing-zone/hub-side-peering.bicep`]:
    'Hub-side VNet peering, written into the hub subscription on a dlz-attach estate. Networking, no role assignment on the lake.',
  [`${ORCHESTRATOR_REPO_REL} dlzAttachHubConsoleEnv -> ${PLATFORM_PREFIX}modules/landing-zone/hub-console-dlz-env.bicep`]:
    'Console environment wiring in the hub subscription on a dlz-attach estate.',
  [`${ORCHESTRATOR_REPO_REL} dlzAttachS3Gateway -> ${PLATFORM_PREFIX}modules/data-plane/s3-gateway-aca.bicep`]:
    'The S3 gateway itself on a dlz-attach estate — the module that MINTS uami-loom-s3gw-<location>, i.e. the far end of PRINCIPAL_ARGUMENT_CHAIN. Deployed at the hub, not at the lake.',
  [`${ORCHESTRATOR_REPO_REL} dlzAttachAdfKeyVaultRbac -> ${PLATFORM_PREFIX}modules/admin-plane/adf-keyvault-rbac.bicep`]:
    'Key Vault grants for ADF in the hub subscription on a dlz-attach estate. Key Vault, not the lake.',
  [`${ORCHESTRATOR_REPO_REL} setupOrchestratorSpokeRbac -> ${PLATFORM_PREFIX}modules/admin-plane/setup-orchestrator-rbac.bicep`]:
    'Subscription-scoped RBAC for the setup orchestrator in each spoke subscription.',
  [`${PLATFORM_PREFIX}modules/landing-zone/adx.bicep inner -> ${PLATFORM_PREFIX}modules/landing-zone/adx-db-inner.bicep`]:
    'ADX database creation against a cluster an estate may host in another subscription. Kusto, not storage.',
};

/** Cross-subscription call sites nobody has registered. */
function unregisteredCrossSubCallSites(tree) {
  return crossSubCallSites(tree)
    .filter((s) => !inExemptTree(s.file))
    .filter((s) => !Object.hasOwn(CROSS_SUB_CALLSITE_REGISTER, crossSubKey(s)))
    .map((s) => `${siteLabel(s)} -> ${s.resolved ?? s.target}  scope=${s.scope}`)
    .sort();
}

/** Registered cross-subscription call sites that no longer exist. */
function staleCrossSubRegistrations(tree) {
  const live = new Set(crossSubCallSites(tree).map(crossSubKey));
  return Object.keys(CROSS_SUB_CALLSITE_REGISTER)
    .filter((k) => !live.has(k))
    .sort();
}

/**
 * Every module reachable from `startRel` by following `module` targets, plus
 * the targets that could not be read.
 *
 * An unreadable target is returned, never dropped: "I could not follow this"
 * and "there is nothing there" are different answers, and only the second one
 * clears a grant.
 */
function reachableModules(tree, startRel, maxDepth = 8) {
  const seen = new Set();
  const unreadable = [];
  const queue = [[startRel, 0]];
  while (queue.length > 0) {
    const [rel, depth] = queue.shift();
    if (seen.has(rel) || depth > maxDepth) continue;
    if (!tree.has(rel)) {
      unreadable.push(rel);
      continue;
    }
    seen.add(rel);
    for (const m of parseBicep(tree.get(rel), rel).modules) {
      const target = resolveTarget(rel, m.target);
      if (target === null) continue; // a registry ref (br:/ts:) — not a file
      queue.push([target, depth + 1]);
    }
  }
  return { modules: [...seen].sort(), unreadable: [...new Set(unreadable)].sort() };
}

/** Call sites deployed at the cross-sub LAKE scope, whatever they target. */
function lakeScopeCallSites(tree) {
  return crossSubCallSites(tree).filter((s) => norm(s.scope ?? '') === norm(PASS_CALLSITE_SCOPE));
}

/**
 * Grants reachable at the cross-sub lake scope that the pass's own registers do
 * not justify — the SAME `SELF_MINTED_PASS_PRINCIPALS` and `PASS_GRANTED_ROLES`
 * checks GUARD 2 applies, applied to the whole reachable set rather than to one
 * filename. This is the half that survives a reviewer registering their new
 * module in CROSS_SUB_CALLSITE_REGISTER.
 */
function unjustifiedLakeScopeGrants(tree) {
  const out = [];
  for (const site of lakeScopeCallSites(tree)) {
    const at = siteLabel(site);
    if (site.resolved === null || !tree.has(site.resolved)) {
      out.push(`${at} -> ${site.target}: TARGET NOT READABLE — cannot judge what it grants`);
      continue;
    }
    const { modules, unreadable } = reachableModules(tree, site.resolved);
    for (const u of unreadable) out.push(`${at} -> ${u}: reachable module NOT READABLE`);
    for (const rel of modules) {
      const src = tree.get(rel);
      for (const p of unjustifiedGrantedPrincipals(src)) {
        out.push(`${at} -> ${rel}: grants \`${p}\`, which no SELF_MINTED_PASS_PRINCIPALS row justifies`);
      }
      for (const g of unregisteredGrantedRoles(src)) {
        out.push(`${at} -> ${rel}: grants role ${g}, which PASS_GRANTED_ROLES does not account for`);
      }
    }
  }
  return out.sort();
}

test('#3338 GUARD 5: every module deployed into ANOTHER SUBSCRIPTION is registered, and every grant reachable at the cross-sub LAKE scope is justified', () => {
  const tree = bicepTree();

  // Non-vacuity, three ways. A population of zero, an exemption that excludes
  // nothing, or no lake-scope site at all would each make the assertions below
  // true while measuring nothing.
  const all = crossSubCallSites(tree);
  assert.ok(all.length > 0, 'no cross-subscription call site was found at all — the scope reader is broken');
  assert.ok(
    all.some((s) => inExemptTree(s.file)),
    'the exempt tree excludes nothing — either it moved, or the exemption is dead weight that should be deleted',
  );
  assert.ok(
    all.some((s) => !inExemptTree(s.file)),
    'every cross-subscription call site is exempt — the register is measuring nothing',
  );
  const lakeSites = lakeScopeCallSites(tree);
  assert.ok(
    lakeSites.length > 0,
    'no call site deploys at PASS_CALLSITE_SCOPE — the grant half of this guard would be vacuous',
  );

  // The exemption is CHECKED, not asserted. A Loom lake grant written inside the
  // vendored ALZ tree would otherwise be exempt by accident.
  for (const t of CROSS_SUB_EXEMPT_TREES) {
    const files = [...tree.keys()].filter((k) => k.startsWith(t.prefix));
    assert.ok(files.length > 0, `exempt tree ${t.prefix} does not exist — prune the exemption`);
    assert.ok(t.why.length > 60, `exempt tree ${t.prefix} needs a measured reason`);
    const contaminated = files.filter((k) =>
      /dlz-lake-grant-pass|lakeAdopt(Name|Rg|Sub)\b|loomStorageAccount/.test(tree.get(k)),
    );
    assert.deepEqual(
      contaminated,
      [],
      `${t.prefix} references the Loom lake — the exemption is no longer safe and must be narrowed or removed`,
    );
  }

  assert.deepEqual(
    unregisteredCrossSubCallSites(tree),
    [],
    'a module is deployed into ANOTHER SUBSCRIPTION from an unregistered call site. That is the population key for the cross-sub lake: a NEW FILE granting Storage Blob Data Contributor to the Console UAMI on the lake needs one of these, and cannot get on the lake without one. Register it with a reason, or do not deploy it cross-subscription.',
  );
  assert.deepEqual(
    staleCrossSubRegistrations(tree),
    [],
    'CROSS_SUB_CALLSITE_REGISTER lists a call site that no longer exists — a register nobody prunes is how a ratchet becomes a mute button',
  );
  assert.deepEqual(
    unjustifiedLakeScopeGrants(tree),
    [],
    'a role assignment reachable from a call site at the cross-sub LAKE scope grants a principal or a role the pass\'s own registers refuse. This is the check that survives registration: adding the sibling module to CROSS_SUB_CALLSITE_REGISTER does not make a Console-UAMI Contributor grant on the lake acceptable.',
  );
});

test('#3338 GUARD 5 — MUTATION control: the reviewer\'s SIBLING MODULE goes RED, and is measured GREEN under GUARDS 1-4', () => {
  // The reviewer's counterexample, rebuilt: a new file next to the pass that
  // grants exactly what the pass's header refuses, invoked from main.bicep at
  // the lake's scope. Nothing in the pass changes; nothing in the registered
  // call site changes.
  const SIBLING_REL = `${PLATFORM_PREFIX}modules/data-plane/dlz-lake-grant-pass-console.bicep`;
  const sibling = [
    "targetScope = 'resourceGroup'",
    'param storageAccountName string',
    "param consolePrincipalId string = ''",
    'param assignRoles bool = true',
    '',
    `var storageBlobDataContributorRoleId = '${SBDC_ROLE_ID}'`,
    'var grantConsole = assignRoles && !empty(storageAccountName) && !empty(consolePrincipalId)',
    '',
    "resource lake 'Microsoft.Storage/storageAccounts@2024-01-01' existing = if (grantConsole) {",
    "  name: empty(storageAccountName) ? 'placeholderaccount' : storageAccountName",
    '}',
    '',
    "resource consoleLakeWrite 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (grantConsole) {",
    '  name: guid(lake.id, consolePrincipalId, storageBlobDataContributorRoleId)',
    '  scope: lake',
    '  properties: {',
    "    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)",
    '    principalId: consolePrincipalId',
    "    principalType: 'ServicePrincipal'",
    '  }',
    '}',
    '',
  ].join('\n');

  const clean = bicepTree();
  const orch = clean.get(ORCHESTRATOR_REPO_REL);
  const withSibling = `${orch}\nmodule dlzLakeGrantPassConsole 'modules/data-plane/dlz-lake-grant-pass-console.bicep' = if (crossSubLakeGrantsActive) {\n  name: 'dlz-lake-grant-pass-console'\n  scope: resourceGroup(lakeAdoptSub, lakeAdoptRg)\n  params: {\n    storageAccountName: lakeAdoptName\n    consolePrincipalId: deployAdminPlane ? adminPlane!.outputs.uamiConsolePrincipalId : ''\n    assignRoles: !skipRoleGrants\n  }\n}\n`;
  assert.notEqual(withSibling, orch, 'the call-site half of the mutation must actually apply');

  const mutated = bicepTree(
    new Map([[ORCHESTRATOR_REPO_REL, withSibling]]),
    new Map([[SIBLING_REL, sibling]]),
  );

  // THE COUNTERFACTUAL FIRST, measured rather than asserted: GUARDS 1-4 are
  // blind to this, which is why GUARD 5 exists. The pass file is untouched, so
  // GUARDS 1-3 read the same bytes as head; GUARD 4's population still sees
  // exactly ONE call site of the pass, with its registered arguments intact.
  assert.equal(mutated.get(GRANT_PASS_REPO_REL), clean.get(GRANT_PASS_REPO_REL), 'the pass must be byte-identical');
  assert.equal(passCallSites(mutated).length, 1, 'GUARD 4 must still see exactly one call site — it is looking at the wrong population');
  assert.deepEqual(misboundCallSiteArgs(mutated), [], 'GUARD 4 must be GREEN on this mutation — that is the finding');

  // TOOTH 1 — the call site is an unregistered cross-subscription deployment.
  const unregistered = unregisteredCrossSubCallSites(mutated);
  assert.equal(unregistered.length, 1, `expected one unregistered site, got ${unregistered.join(' | ')}`);
  assert.match(unregistered[0], /dlzLakeGrantPassConsole -> platform\/fiab\/bicep\/modules\/data-plane\/dlz-lake-grant-pass-console\.bicep/);

  // TOOTH 2 — and registering it would NOT be enough: the grant itself is
  // refused, by principal AND by role, through the registers GUARD 2 uses.
  const grants = unjustifiedLakeScopeGrants(mutated);
  assert.ok(
    grants.some((g) => g.includes('grants `consolePrincipalId`')),
    `the Console principal must be named: ${grants.join(' | ')}`,
  );
  assert.ok(
    grants.some((g) => g.includes(`grants role ${SBDC_ROLE_ID}`)),
    `the Contributor role must be named: ${grants.join(' | ')}`,
  );

  // …and the same grant reached one hop further out — the sibling registered,
  // but DELEGATING to a grandchild module. Reachability, not adjacency.
  const DELEGATE_REL = `${PLATFORM_PREFIX}modules/data-plane/dlz-lake-grant-pass-console-inner.bicep`;
  const shell = [
    "targetScope = 'resourceGroup'",
    'param storageAccountName string',
    "param consolePrincipalId string = ''",
    '',
    "module inner 'dlz-lake-grant-pass-console-inner.bicep' = {",
    "  name: 'console-lake-write'",
    '  params: {',
    '    storageAccountName: storageAccountName',
    '    consolePrincipalId: consolePrincipalId',
    '  }',
    '}',
    '',
  ].join('\n');
  const delegated = bicepTree(
    new Map([[ORCHESTRATOR_REPO_REL, withSibling]]),
    new Map([
      [SIBLING_REL, shell],
      [DELEGATE_REL, sibling],
    ]),
  );
  const delegatedGrants = unjustifiedLakeScopeGrants(delegated);
  assert.ok(
    delegatedGrants.some((g) => g.includes(DELEGATE_REL) && g.includes('grants `consolePrincipalId`')),
    `the grandchild's grant must be reached and named: ${delegatedGrants.join(' | ')}`,
  );

  // NEGATIVE control: head itself must be clean on both teeth, or every RED
  // above would be indistinguishable from a guard that flags everything.
  assert.deepEqual(unregisteredCrossSubCallSites(clean), []);
  assert.deepEqual(unjustifiedLakeScopeGrants(clean), []);
});

test('#3338 GUARD 5 — the scope reader: what counts as cross-subscription, and what deliberately does not', () => {
  // Direct unit cover for the population key, independent of the tree. A reader
  // that answered `true` for everything would make the register unusable; one
  // that answered `false` for the two-argument form would make GUARD 5 vacuous
  // while every assertion above still passed.
  assert.equal(crossSubscriptionScope('resourceGroup(lakeAdoptSub, lakeAdoptRg)'), true);
  assert.equal(crossSubscriptionScope("resourceGroup(subId, 'rg-${name}-${location}')"), true);
  assert.equal(crossSubscriptionScope('subscription(subId)'), true);
  assert.equal(crossSubscriptionScope('managementGroup(varManagementGroupIds.intRoot)'), true);
  // Same-subscription forms stay OUT of the population on purpose.
  assert.equal(crossSubscriptionScope('resourceGroup(loomDlzRg)'), false);
  assert.equal(crossSubscriptionScope('resourceGroup()'), false);
  assert.equal(crossSubscriptionScope('subscription()'), false);
  assert.equal(crossSubscriptionScope(null), false);
  // A nested comma is ONE argument, not two — otherwise a same-sub
  // `resourceGroup(concat(a, b))` would be read as cross-subscription and the
  // register would fill with noise until someone deleted the guard.
  assert.equal(crossSubscriptionScope('resourceGroup(concat(a, b))'), false);
  assert.equal(crossSubscriptionScope("resourceGroup('rg-a,b')"), false);
  assert.equal(crossSubscriptionScope('resourceGroup(concat(a, b), rg)'), true);
  // Not a bare call, so not a module scope — fail closed rather than guess.
  assert.equal(crossSubscriptionScope('resourceGroup(a, b).id'), false);
  assert.deepEqual(callArgs('resourceGroup(a, b)', 'resourceGroup'), ['a', 'b']);
  assert.equal(callArgs('resourceGroup(a, b', 'resourceGroup'), null, 'an unbalanced expression must fail closed');
});

test('the reader parses a `[for … :` declaration header — the form MODULE_RE used to miss', () => {
  // Direct unit cover for the cause behind bypass B2, independent of #3338: the
  // old `\[[^\]]*\]` alternative needed the bracket closed on the declaration
  // line, which a bicep loop never does.
  const src = [
    "module plain 'modules/x.bicep' = {",
    "  name: 'plain'",
    "}",
    "module looped 'modules/y.bicep' = [for g in gs: {",
    "  name: 'looped-${g}'",
    "  scope: resourceGroup(someRg)",
    "  params: {",
    "    a: b",
    "  }",
    "}]",
    "module loopedIndexed 'modules/z.bicep' = [for (g, i) in gs: if (flag) {",
    "  name: 'idx-${i}'",
    "}]",
    "resource loopRes 'Microsoft.Storage/storageAccounts@2024-01-01' = [for n in ns: {",
    "  name: n",
    "}]",
  ].join('\n');
  const parsed = parseBicep(src, '<memory>');
  assert.deepEqual(
    parsed.modules.map((m) => [m.symbol, m.target, m.loop, m.condition]),
    [
      ['plain', 'modules/x.bicep', false, null],
      ['looped', 'modules/y.bicep', true, null],
      ['loopedIndexed', 'modules/z.bicep', true, 'flag'],
    ],
  );
  // The loop body must still be read, not just its header — otherwise the call
  // site would parse and then bind nothing, which reads as clean.
  const looped = parsed.modules.find((m) => m.symbol === 'looped');
  assert.equal(looped.scope, 'resourceGroup(someRg)');
  assert.deepEqual([...looped.params.entries()], [['a', 'b']]);
  assert.deepEqual(
    parsed.resources.map((r) => [r.symbol, r.loop]),
    [['loopRes', true]],
  );
});

test('blankComments preserves length and does not blank a `//` inside a string literal', () => {
  const src = [
    "var url = 'https://management.usgovcloudapi.net' // trailing comment",
    "// whole-line comment",
    "var esc = 'it\\'s // not a comment' // but this is",
    "var multi = '''",
    "https://example.invalid",
    "'''",
  ].join('\n');
  const out = blankComments(src);
  assert.equal(out.length, src.length, 'length must be preserved so line/column numbers stay true');
  assert.match(out, /'https:\/\/management\.usgovcloudapi\.net'/);
  assert.equal(out.includes('trailing comment'), false);
  assert.equal(out.includes('whole-line comment'), false);
  assert.equal(out.includes('but this is'), false);
  assert.match(out, /'it\\'s \/\/ not a comment'/);
  assert.match(out, /https:\/\/example\.invalid/);
});
