import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTROLS,
  CONTROL_STATS,
  GATE,
  JUDGED_PREFIX,
  blankComments,
  blankStrings,
  declaresPostgres,
  forwardedGateValue,
  forwardsGate,
  identifierReads,
  identifiersOf,
  parseModules,
  parseParams,
  parseVars,
  reachesGate,
  resolveModuleTarget,
  runControls,
} from '../check-postgres-quota-gate.mjs';

test('the embedded controls agree — the analyzer still separates the cases', () => {
  assert.deepEqual(runControls(), []);
});

test('the reported control count is COUNTED, not a literal that can drift', () => {
  runControls();
  assert.ok(CONTROL_STATS.ran > CONTROLS.length, 'the fixture list is not the whole control set');
});

test('a CRLF source loses its var declarations unless normalised — the hazard is real', () => {
  const crlf = ['param x bool = true', 'var active = flag', 'output y bool = active'].join('\r\n');
  assert.equal(parseVars(blankComments(crlf)).has('active'), false, 'raw CRLF must reproduce the hazard');
  assert.equal(
    parseVars(blankComments(crlf.replace(/\r\n/g, '\n'))).has('active'),
    true,
    'normalisation must restore the parse',
  );
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

// ── R2 checks the forwarded VALUE, not just the key ──────────────────────────
// Rework 2026-08-18. `postgresQuotaAvailable: true` is runtime-identical to
// omitting the forward, and the key-only check accepted it — measured on the
// real repo by mutating main.bicep's singleDlz call site.

test('a HARDCODED forward is extracted, and the value does not reach the gate', () => {
  const src = [
    `param ${GATE} bool = true`,
    "module lz 'lz.bicep' = if (x) {",
    '  params: {',
    `    ${GATE}: true`,
    '  }',
    '}',
  ].join('\n');
  const mod = parseModules(src, 'fixture.bicep')[0];
  assert.equal(forwardsGate(src, mod), true, 'the KEY is present — this is what used to pass');
  const clean = blankComments(src);
  const value = forwardedGateValue(src, mod, 'fixture.bicep');
  assert.equal(value.trim(), 'true');
  assert.equal(reachesGate(value, parseVars(clean), new Set([...parseParams(clean), 'x'])).reached, false);
});

test('forwarding the param itself DOES reach the gate', () => {
  const src = [
    `param ${GATE} bool = true`,
    "module lz 'lz.bicep' = if (x) {",
    '  params: {',
    `    ${GATE}: ${GATE}`,
    '  }',
    '}',
  ].join('\n');
  const mod = parseModules(src, 'fixture.bicep')[0];
  const clean = blankComments(src);
  const value = forwardedGateValue(src, mod, 'fixture.bicep');
  assert.equal(reachesGate(value, parseVars(clean), new Set([...parseParams(clean), 'x'])).reached, true);
});

test('an absent forward yields a null value rather than an empty string', () => {
  const src = ["module lz 'lz.bicep' = if (x) {", '  params: {', '    other: 1', '  }', '}'].join('\n');
  const mod = parseModules(src, 'fixture.bicep')[0];
  assert.equal(forwardedGateValue(src, mod, 'fixture.bicep'), null);
});

test('a forwarded value that continues on the next line THROWS rather than judging a truncation', () => {
  const src = [
    `param ${GATE} bool = true`,
    "module lz 'lz.bicep' = {",
    '  params: {',
    `    ${GATE}: cond`,
    `      ? ${GATE}`,
    '      : false',
    '  }',
    '}',
  ].join('\n');
  const mod = parseModules(src, 'fixture.bicep')[0];
  assert.throws(() => forwardedGateValue(src, mod, 'fixture.bicep'), /cannot read that shape whole/);
});

test('a forwarded value spanning a balanced call is read WHOLE, not truncated', () => {
  const src = [
    `param ${GATE} bool = true`,
    "module lz 'lz.bicep' = {",
    '  params: {',
    `    ${GATE}: union(`,
    `      ${GATE},`,
    '      other)',
    '  }',
    '}',
  ].join('\n');
  const mod = parseModules(src, 'fixture.bicep')[0];
  const value = forwardedGateValue(src, mod, 'fixture.bicep');
  assert.match(value, /other/, 'the value must include the continuation lines inside the parens');
  const clean = blankComments(src);
  assert.equal(reachesGate(value, parseVars(clean), new Set([...parseParams(clean), 'other'])).reached, true);
});

// ── polarity: a reference is not a gate if it is inverted ────────────────────

test('identifierReads marks a directly negated identifier', () => {
  const reads = identifierReads(`flag && !${GATE}`);
  assert.deepEqual(reads.find((r) => r.name === GATE), { name: GATE, negated: true });
  assert.deepEqual(reads.find((r) => r.name === 'flag'), { name: 'flag', negated: false });
});

test('identifierReads keeps offsets valid across a property access, so negation is read correctly', () => {
  const reads = identifierReads(`!bag.?weavePostgres && ${GATE}`);
  assert.deepEqual(reads.find((r) => r.name === 'bag'), { name: 'bag', negated: true });
  assert.deepEqual(reads.find((r) => r.name === GATE), { name: GATE, negated: false });
});

test('a NEGATED gate reference is reached but flagged negatedOnly', () => {
  const src = [`param ${GATE} bool = true`, `var active = flag && !${GATE}`].join('\n');
  const clean = blankComments(src);
  const res = reachesGate('active', parseVars(clean), new Set([...parseParams(clean), 'flag']));
  assert.equal(res.reached, true);
  assert.equal(res.negatedOnly, true, 'the one-character inversion must be distinguishable from a correct gate');
});

test('negation THROUGH a var chain is still negation', () => {
  const src = [`param ${GATE} bool = true`, `var allowed = ${GATE}`, 'var active = flag && !allowed'].join('\n');
  const clean = blankComments(src);
  assert.equal(reachesGate('active', parseVars(clean), new Set([...parseParams(clean), 'flag'])).negatedOnly, true);
});

test('a DOUBLE negation cancels and is not flagged', () => {
  const src = [`param ${GATE} bool = true`, `var allowed = !${GATE}`, 'var active = flag && !allowed'].join('\n');
  const clean = blankComments(src);
  const res = reachesGate('active', parseVars(clean), new Set([...parseParams(clean), 'flag']));
  assert.equal(res.reached, true);
  assert.equal(res.negatedOnly, false);
});

test('a correct gate is NOT flagged negatedOnly — the check has both directions', () => {
  const src = [`param ${GATE} bool = true`, `var active = flag && ${GATE}`].join('\n');
  const clean = blankComments(src);
  assert.equal(reachesGate('active', parseVars(clean), new Set([...parseParams(clean), 'flag'])).negatedOnly, false);
});

// ── R3: an unresolvable module target is a hard failure, not a skip ──────────

test('resolveModuleTarget resolves a sibling and a cross-tree relative path', () => {
  assert.equal(
    resolveModuleTarget('platform/fiab/bicep/main.bicep', 'modules/landing-zone/main.bicep'),
    'platform/fiab/bicep/modules/landing-zone/main.bicep',
  );
  assert.equal(
    resolveModuleTarget('platform/fiab/bicep/modules/landing-zone/main.bicep', '../../../../../deploy/bicep/DLZ/modules/geoanalytics.bicep'),
    'deploy/bicep/DLZ/modules/geoanalytics.bicep',
  );
});

test('one `..` too few resolves somewhere that does not exist — which R3 must not absorb', () => {
  assert.equal(
    resolveModuleTarget('platform/fiab/bicep/modules/landing-zone/main.bicep', '../../../../deploy/bicep/DLZ/modules/geoanalytics.bicep'),
    'platform/deploy/bicep/DLZ/modules/geoanalytics.bicep',
  );
});
