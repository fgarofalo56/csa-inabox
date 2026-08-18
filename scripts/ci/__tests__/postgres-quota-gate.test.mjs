import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTROLS,
  GATE,
  JUDGED_PREFIX,
  blankComments,
  blankStrings,
  declaresPostgres,
  forwardsGate,
  identifiersOf,
  parseModules,
  parseParams,
  parseVars,
  reachesGate,
  runControls,
} from '../check-postgres-quota-gate.mjs';

test('the embedded controls agree — the analyzer still separates the cases', () => {
  assert.deepEqual(runControls(), []);
});

test('the controls cover BOTH directions, so they cannot pass by never matching', () => {
  const flagged = CONTROLS.filter((c) => c.expect.reached === false || c.expect.forwards === false || c.expect.unconditional);
  const clean = CONTROLS.filter((c) => c.expect.reached === true);
  assert.ok(flagged.length >= 3, 'need fixtures that MUST be flagged');
  assert.ok(clean.length >= 2, 'need fixtures that MUST NOT be flagged');
});

test('a real flexibleServers resource declaration is recognised', () => {
  assert.equal(
    declaresPostgres("resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {\n}"),
    true,
  );
});

test('the type named only in a description STRING is not a declaration', () => {
  assert.equal(
    declaresPostgres("@description('provisions Microsoft.DBforPostgreSQL/flexibleServers')\nparam x bool = true"),
    false,
  );
});

test('a commented-out resource declaration is not a declaration (#2977 shape)', () => {
  assert.equal(
    declaresPostgres("// resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {"),
    false,
  );
});

test('blankComments preserves length and line count so offsets stay valid', () => {
  const src = "param a bool = true // trailing\n/* block\n comment */\nvar b = a\n";
  const out = blankComments(src);
  assert.equal(out.length, src.length);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.match(out, /param a bool = true/);
  assert.doesNotMatch(out, /trailing/);
  assert.doesNotMatch(out, /block/);
});

test('a // inside a string literal does not start a comment', () => {
  const src = "var u = 'https://example.invalid/x'\nvar v = postgresQuotaAvailable\n";
  assert.match(blankComments(src), /postgresQuotaAvailable/);
});

test('blankStrings hides interpolated braces and parens but keeps offsets', () => {
  const src = "var n = '${take(x, 63)}.${suffix}'\n";
  const out = blankStrings(src);
  assert.equal(out.length, src.length);
  assert.doesNotMatch(out, /take/);
});

test('identifiersOf drops function names, property accesses and string content', () => {
  const ids = identifiersOf("toLower(string(loomBackends.?weavePostgres ?? 'enabled')) == someVar");
  assert.ok(ids.includes('loomBackends'), 'the root of a property access is read');
  assert.ok(ids.includes('someVar'));
  assert.ok(!ids.includes('weavePostgres'), 'a property name is not an identifier reference');
  assert.ok(!ids.includes('toLower'), 'a function name is not an identifier reference');
  assert.ok(!ids.includes('enabled'), 'string content is not an identifier reference');
});

test('reachesGate follows a multi-hop var chain', () => {
  const src = [
    `param ${GATE} bool = true`,
    "var ov = toLower(string(bag.?weavePostgres ?? ''))",
    `var allowed = ov == 'enabled' ? true : (ov == 'disabled' ? false : ${GATE})`,
    'var active = flag && allowed',
  ].join('\n');
  const clean = blankComments(src);
  const res = reachesGate('active', parseVars(clean), new Set([...parseParams(clean), 'bag', 'flag']));
  assert.equal(res.reached, true);
  assert.equal(res.viaParam, true);
  assert.deepEqual(res.unresolved, []);
});

test('reachesGate reports an unresolvable identifier instead of assuming it is safe', () => {
  const res = reachesGate('mystery', new Map(), new Set());
  assert.equal(res.reached, false);
  assert.deepEqual(res.unresolved, ['mystery']);
});

test('the gate reached only through a COMMENT does not count', () => {
  const src = [`// gated on ${GATE}`, 'var active = flag'].join('\n');
  const clean = blankComments(src);
  const res = reachesGate('active', parseVars(clean), new Set(['flag']));
  assert.equal(res.reached, false);
});

test('parseModules folds a multi-line for-loop header and extracts the condition', () => {
  const src = [
    "module dlz 'lz.bicep' = [for (subId, i) in subs: if (useMultiDlz) {",
    "  name: 'dlz-${i}'",
    '  params: {',
    '    postgresQuotaAvailable: postgresQuotaAvailable',
    '  }',
    '}]',
  ].join('\n');
  const mods = parseModules(src, 'fixture.bicep');
  assert.equal(mods.length, 1);
  assert.equal(mods[0].name, 'dlz');
  assert.equal(mods[0].target, 'lz.bicep');
  assert.equal(mods[0].condition.trim(), 'useMultiDlz');
  assert.equal(forwardsGate(src, mods[0]), true);
});

test('an unconditional module invocation has a null condition, not an empty one', () => {
  const mods = parseModules("module pg 'pg.bicep' = {\n  params: {}\n}", 'fixture.bicep');
  assert.equal(mods[0].condition, null);
});

test('forwardsGate is not satisfied by the gate name appearing in a comment', () => {
  const src = ["module lz 'lz.bicep' = if (x) {", '  params: {', `    // ${GATE}: forwarded elsewhere`, '  }', '}'].join('\n');
  const mods = parseModules(src, 'fixture.bicep');
  assert.equal(forwardsGate(src, mods[0]), false);
});

test('an unbalanced module body throws rather than silently skipping the file', () => {
  assert.throws(() => parseModules("module pg 'pg.bicep' = if (x) {\n  params: {\n", 'fixture.bicep'), /unparsed shape/);
});

test('the judged tree is the one where the gate parameter actually exists', () => {
  assert.equal(JUDGED_PREFIX, 'platform/fiab/bicep/');
});
