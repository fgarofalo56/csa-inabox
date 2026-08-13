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

import {
  analyze,
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
