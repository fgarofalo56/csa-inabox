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
//      paid for it three times (main.bicep:2288 — the app-resources leaf
//      "failed RoleAssignmentExists on EVERY deploy in BOTH topologies";
//      main.bicep:3113; admin-plane/main.bicep:9095), and the Console UAMI
//      already holds Storage Blob Data Contributor on the live Commercial lake
//      from an out-of-band grant (measured 2026-08-13, recorded in the pass's
//      own header). #3338 asked for exactly that principal at exactly that role.
//
// WHAT THESE TESTS ARE AND ARE NOT. They are GREEN at head — head carries
// neither break. They are trap guards, not the fix for a red, and each carries
// a MUTATION control that applies the break to an in-memory copy of the REAL
// source and asserts the checker turns red on it. Without that control a green
// here would be indistinguishable from a checker that looks at nothing.

const GRANT_PASS_REL = 'modules/data-plane/dlz-lake-grant-pass.bicep';
const ADMIN_PLANE_REL = 'modules/admin-plane/main.bicep';

const readBicep = (rel) => fs.readFileSync(path.join(BICEP_ROOT, ...rel.split('/')), 'utf8');

/**
 * Principals that ACTUALLY receive a role assignment in a bicep source: the
 * `properties.principalId` expression of every
 * `Microsoft.Authorization/roleAssignments` declaration.
 *
 * Comments are blanked first, so a commented-out assignment does not count as a
 * grant — the same discipline `parseBicep` applies to `scope:`.
 */
function grantedPrincipalExprs(source) {
  const lines = blankComments(source).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^resource\s+\w+\s+'Microsoft\.Authorization\/roleAssignments@/.test(lines[i].trimStart())) continue;
    const pid = fieldAt(blockAt(lines, i), 'principalId', 4);
    if (pid) out.push(pid.value);
  }
  return out;
}

/** `param …PrincipalId string` names declared by a source. */
function principalParams(source) {
  return [...parseBicep(source).params].filter((p) => /PrincipalId$/.test(p)).sort();
}

/** Declared principal params that no role assignment in the same file consumes. */
function ungrantedPrincipalParams(source) {
  const granted = grantedPrincipalExprs(source);
  return principalParams(source).filter(
    (p) => !granted.some((expr) => new RegExp(`\\b${p}\\b`).test(expr)),
  );
}

/**
 * Every principal the cross-sub pass is allowed to grant, and why it is safe.
 *
 * The entry bar is STRUCTURAL, not "we have not seen a collision": the identity
 * must be minted by the same deployment run, so it cannot carry a pre-existing
 * assignment. Adding a row for a long-lived identity (the Console UAMI, a
 * customer-supplied SP, anything created out-of-band) is the #3338 trap and is
 * refused in the module header with the measurement behind it.
 */
const SELF_MINTED_PASS_PRINCIPALS = [
  {
    param: 's3GatewayPrincipalId',
    mintedBy: 'modules/data-plane/s3-gateway-aca.bicep — uami-loom-s3gw-<location>, created by this same deployment run',
    why: 'An identity minted on this run cannot already hold a role assignment, so a duplicate-tuple RoleAssignmentExists is structurally impossible rather than merely unobserved. Verified on the live Commercial estate 2026-08-13: no uami-loom-s3gw-* identity exists at all.',
  },
];

/**
 * Activation vars in admin-plane that gate their DEPLOY on
 * `loomStorageWillBeGranted` — i.e. that assert "some pass owns my lake grant"
 * — mapped to the pass param that actually owns it.
 *
 * `loomStorageWillBeGranted` is `loomStorageGrantable || loomStorageGrantedElsewhere`,
 * and `loomStorageGrantedElsewhere` is main.bicep:1604's `crossSubLakeGrantsActive`
 * — a statement about the PASS, not about the caller. Borrowing it for a module
 * whose principal the pass does not grant makes the flag assert an ownership
 * that does not exist. That is what #3338's suggested one-liner ("make
 * transformRunnerActive include loomStorageWillBeGranted, mirror :1490") does:
 * the pass grants the S3 gateway's dedicated identity and nothing else, so the
 * transform runner would gate on someone else's grant.
 */
const CROSS_SUB_GRANT_CONSUMERS = {
  s3GatewayActive: 's3GatewayPrincipalId',
};

/** Activation vars whose expression references `loomStorageWillBeGranted`. */
function willBeGrantedConsumers(adminSource) {
  const { vars } = parseBicep(adminSource);
  return [...vars.entries()]
    .filter(([, expr]) => /\bloomStorageWillBeGranted\b/.test(expr))
    .map(([name]) => name)
    .sort();
}

/**
 * Consumers of `loomStorageWillBeGranted` whose lake grant NOBODY owns —
 * either unregistered, or registered against a param the pass does not grant.
 */
function unownedWillBeGrantedConsumers(adminSource, passSource) {
  const granted = grantedPrincipalExprs(passSource);
  return willBeGrantedConsumers(adminSource).filter((v) => {
    const owner = CROSS_SUB_GRANT_CONSUMERS[v];
    return !owner || !granted.some((expr) => new RegExp(`\\b${owner}\\b`).test(expr));
  });
}

test('#3338 GUARD 1: every principal param the cross-sub pass declares actually carries a role assignment', () => {
  const source = readBicep(GRANT_PASS_REL);
  // Non-vacuity first: a checker that found no principals at all would satisfy
  // the assertion below while measuring nothing.
  assert.ok(principalParams(source).length > 0, 'the pass must declare at least one principal param');
  assert.ok(grantedPrincipalExprs(source).length > 0, 'the pass must contain at least one role assignment');
  assert.deepEqual(
    ungrantedPrincipalParams(source),
    [],
    'a principal threaded into the cross-sub pass with no roleAssignments resource consuming it is bound-and-ungranted — the #3338 defect, re-created',
  );
});

test('#3338 GUARD 1 — MUTATION control: threading a principal without its assignment goes RED', () => {
  const head = readBicep(GRANT_PASS_REL);
  const mutated = head.replace(
    "param s3GatewayPrincipalId string = ''",
    "param s3GatewayPrincipalId string = ''\n\nparam consolePrincipalId string = ''",
  );
  assert.notEqual(mutated, head, 'the mutation must actually apply');
  assert.deepEqual(ungrantedPrincipalParams(mutated), ['consolePrincipalId']);
});

test('#3338 GUARD 2: the cross-sub pass grants ONLY identities the deployment itself mints', () => {
  const declared = principalParams(readBicep(GRANT_PASS_REL));
  assert.deepEqual(
    declared,
    SELF_MINTED_PASS_PRINCIPALS.map((p) => p.param).sort(),
    'a principal param was added to dlz-lake-grant-pass.bicep without a self-minted justification. A long-lived identity (the Console UAMI above all) may already hold the tuple, and ARM then fails the deployment with RoleAssignmentExists — see the module header and main.bicep:2288.',
  );
  for (const p of SELF_MINTED_PASS_PRINCIPALS) {
    assert.ok(p.mintedBy && p.mintedBy.length > 20, `${p.param} must name what mints it`);
    assert.ok(p.why && p.why.length > 40, `${p.param} needs a measured reason, not an assertion`);
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

test('#3338 GUARD 3 — MUTATION control: borrowing the flag for the transform runner goes RED', () => {
  // The literal one-liner #3338 proposed. It must not read green.
  const head = readBicep(ADMIN_PLANE_REL);
  const mutated = head.replace(
    'var transformRunnerActive = dbtRunnerActive\n',
    'var transformRunnerActive = dbtRunnerActive && loomStorageWillBeGranted\n',
  );
  assert.notEqual(mutated, head, 'the mutation must actually apply');
  assert.deepEqual(
    unownedWillBeGrantedConsumers(mutated, readBicep(GRANT_PASS_REL)),
    ['transformRunnerActive'],
  );
});
