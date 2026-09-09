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
  norm,
  paramBindings,
  parseBicep,
  partitionFindings,
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
//
// All three were reviewer-built counterexamples, reproduced on disk against the
// real files. Enumerating one more syntax would just move the next escape. So
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
//   GUARD 4  the pass has exactly ONE call site; every argument main.bicep binds
//            there is registered next to the param; and each `principal`
//            argument is traced hop by hop to a `userAssignedIdentities`
//            resource that s3-gateway-aca.bicep DECLARES rather than adopts —
//            the structural form of the self-minted claim.
//
// WHAT THIS STILL IS NOT. It is source analysis, not the compiled ARM. It is
// keyed to declarations in ONE small file (209 lines) whose entire job is to
// make role assignments, plus three named call-chain hops, so an inventory is a
// proportionate key there and would not be on a 9,000-line orchestrator. It does
// not prove that the emitted ARM contains exactly one role assignment; only
// `az bicep build` over the pass could, and that is not run from node:test here.
// Nor does it reach INSIDE s3-gateway-aca.bicep: the chain ends at that module's
// `storageIdentity` declaration, and an edit there that made the symbol resolve
// to a pre-existing identity while keeping the `= {` form is out of reach and is
// said so rather than covered by implication. What it DOES establish is that no
// new param, resource or module can enter the pass, no different role can be
// granted from it, and no different value can be bound to it at its call site,
// without a reviewer registering the change — which is what both #3338
// half-fixes, in every form measured so far, had to bypass.
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
// So the ARGUMENT is registered next to the param, and the identity CHAIN behind
// it is registered hop by hop, ending at a structural fact rather than another
// name: the terminal expression must dereference a `userAssignedIdentities`
// resource that the minting module DECLARES (not `existing`) — which is what
// "minted by this same deployment run, so it cannot already hold the tuple"
// actually means. Renaming things does not satisfy that; repointing the chain at
// a long-lived identity breaks it at whichever hop was repointed.
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

/**
 * The registered ARGUMENT for every param at the pass's single call site.
 *
 * Compared with `norm()` (whitespace- and quote-insensitive) so reformatting is
 * not a false red, but any change to WHAT IS BOUND is.
 */
const PASS_CALLSITE_REGISTER = {
  storageAccountName: {
    expr: "lakeAdoptName",
    why: "main.bicep:670's `adoptName(adopt,'storage-adls')` — the lake's name comes from the ADOPT PLAN, the same document that bound loomStorageAccount, and the call site's `scope: resourceGroup(lakeAdoptSub, lakeAdoptRg)` reads the sub/rg from the same three lines.",
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

/** Every call site of the grant pass, wherever the orchestrator declares it. */
function passCallSites(orchSource) {
  return parseBicep(orchSource).modules.filter(
    (m) => resolveTarget(ORCHESTRATOR_REL, m.target) === GRANT_PASS_REL,
  );
}

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

/** Call-site bindings whose expression is not the registered one. */
function misboundCallSiteArgs(orchSource) {
  const out = [];
  for (const site of passCallSites(orchSource)) {
    for (const [key, expr] of site.params.entries()) {
      const reg = PASS_CALLSITE_REGISTER[key];
      if (!reg) {
        out.push(`${site.symbol}.${key}: UNREGISTERED argument`);
        continue;
      }
      if (norm(expr) !== norm(reg.expr)) out.push(`${site.symbol}.${key}: ${expr}`);
    }
    for (const key of Object.keys(PASS_CALLSITE_REGISTER)) {
      if (!site.params.has(key)) out.push(`${site.symbol}.${key}: registered but NOT BOUND`);
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

test('#3338 GUARD 4: the pass has exactly ONE call site, and every argument it binds is registered', () => {
  const orch = readBicep(ORCHESTRATOR_REL);
  const sites = passCallSites(orch);

  // Non-vacuity: a reader that resolved no call site would satisfy the
  // "everything bound is registered" assertion while measuring nothing.
  assert.equal(
    sites.length,
    1,
    `dlz-lake-grant-pass.bicep must have exactly one call site in main.bicep; found ${sites.length}. A second call site can bind a different principal to the same pass, which is #3338's half 2 with the callee untouched.`,
  );
  assert.ok(sites[0].params.size > 0, 'the call site must bind params for this guard to measure anything');
  assert.ok(
    Object.keys(PASS_CALLSITE_REGISTER).every((k) => Object.hasOwn(PASS_PARAM_REGISTER, k)),
    'every registered argument must correspond to a param the pass actually declares',
  );

  assert.deepEqual(
    misboundCallSiteArgs(orch),
    [],
    "main.bicep binds something other than the registered expression to dlz-lake-grant-pass.bicep. The callee's inventory cannot see this edit: swapping the s3 gateway output for adminPlane!.outputs.uamiConsolePrincipalId makes the pass grant the Console UAMI with GUARDS 1-3 green.",
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
  const orch = readBicep(ORCHESTRATOR_REL);
  const admin = readBicep(ADMIN_PLANE_REL);
  const s3gw = readBicep(S3_GATEWAY_REL);
  const minting = new Map([[S3_GATEWAY_REL, s3gw]]);

  assert.deepEqual(misboundCallSiteArgs(orch), [], 'head must be clean before a mutation means anything');
  assert.deepEqual(brokenPrincipalChains(admin, minting), [], 'head chain must be clean');

  // (a) BLOCKER 1 verbatim: the callee untouched, the argument swapped for the
  // Console UAMI. Compiles — `output uamiConsolePrincipalId` exists.
  const swapped = orch.replace(
    's3GatewayPrincipalId: deployAdminPlane ? adminPlane!.outputs.s3GatewayStorageUamiPrincipalId : \'\'',
    's3GatewayPrincipalId: deployAdminPlane ? adminPlane!.outputs.uamiConsolePrincipalId : \'\'',
  );
  assert.notEqual(swapped, orch, 'the call-site mutation must actually apply');
  assert.ok(/output uamiConsolePrincipalId string =/.test(admin), 'the swap target output must really exist');
  assert.deepEqual(misboundCallSiteArgs(swapped), [
    "dlzLakeGrantPass.s3GatewayPrincipalId: deployAdminPlane ? adminPlane!.outputs.uamiConsolePrincipalId : ''",
  ]);

  // (b) the pass invoked a SECOND time with a different principal, leaving the
  // registered call site untouched.
  const doubled = `${orch}\nmodule dlzLakeGrantPassConsole 'modules/data-plane/dlz-lake-grant-pass.bicep' = if (crossSubLakeGrantsActive) {\n  name: 'dlz-lake-grant-pass-console'\n  scope: resourceGroup(lakeAdoptSub, lakeAdoptRg)\n  params: {\n    storageAccountName: lakeAdoptName\n    s3GatewayPrincipalId: adminPlane!.outputs.uamiConsolePrincipalId\n    assignRoles: !skipRoleGrants\n  }\n}\n`;
  assert.equal(passCallSites(doubled).length, 2, 'the second call site must parse');
  assert.ok(
    misboundCallSiteArgs(doubled).some((f) => f.startsWith('dlzLakeGrantPassConsole.s3GatewayPrincipalId:')),
    'the second call site must be named in the finding',
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
