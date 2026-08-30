// Behaviour tests for LAYER 3 of scripts/ci/check-env-sync.mjs — "delivered to
// the console, but the value is always the empty string".
//
// WHY THIS SUITE EXISTS
// ---------------------
// The two pre-existing layers of check-env-sync ask:
//   1. is the NAME referenced anywhere in the bicep tree?      (computeMissing)
//   2. does the loom-console app receive an entry for it?      (computeUndelivered)
//
// Both answer YES for this, which was live in admin-plane/main.bicep:
//
//     { name: 'LOOM_ONELAKE_URL', value: '' }
//
// accompanied by a comment stating that "after deploying the standalone modules
// the operator sets the real values here via /admin/env-config". So the guard
// whose own header calls itself the automated statement of
// `.claude/rules/auto-bind-by-default.md` §5 — "'Set LOOM_X' as the terminal
// user-facing state is a violation" — reported OK on a bicep file that said the
// operator sets LOOM_X by hand. It counted the ENTRY, never the VALUE.
//
// Measured on 2026-08-14, on a tree where every prior layer was green:
//   - 4 vars named in #3370/#3372 were delivered with a permanently empty value
//   - 31 more were, for the same two structural reasons, across the whole env
//     block — none of which any existing guard could see
//
// TWO SHAPES ARE INERT, and the tests below pin both:
//
//   (a) `value: ''`, or a ternary whose branches are both '' — the deploy
//       explicitly chose to write nothing.
//   (b) `value: someParam` where admin-plane declares `param someParam string = ''`
//       and NO caller anywhere passes it. Nastier than (a) because the
//       declaration looks configurable; only the call sites reveal it is dead.
//
// AND ONE SHAPE MUST NOT BE FLAGGED: a conditional emission
// (`active ? 'https://…' : ''`) is CORRECT — it is how a documented opt-out
// honest-gates. A guard that flagged those would be muted within a week, which
// is its own way of measuring nothing.
//
// Run: node --test scripts/ci/__tests__/env-sync-always-empty.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseEnvEntries,
  isAlwaysEmptyLiteral,
  isBareIdentifier,
  collectEmptyDefaultParams,
  collectConsoleEnvExpressions,
  computeInert,
  runInertControl,
  KNOWN_INERT,
  UNTRIAGED_INERT,
  NON_LOOM_CONSOLE_ENV_NAMES,
} from '../check-env-sync.mjs';

// ── the parser ────────────────────────────────────────────────────────────────

test('parseEnvEntries pairs each LOOM_* name with its raw value expression', () => {
  const entries = parseEnvEntries(`[
    { name: 'LOOM_A', value: '' }
    { name: 'LOOM_B', value: someParam }
    { name: 'LOOM_C', value: active ? 'https://x' : '' }
  ]`);
  assert.equal(entries.size, 3);
  assert.equal(entries.get('LOOM_A'), "''");
  assert.equal(entries.get('LOOM_B'), 'someParam');
  assert.equal(entries.get('LOOM_C'), "active ? 'https://x' : ''");
});

test('parseEnvEntries reports secretRef entries as having no inline value', () => {
  // A KV-injected secret IS delivered; treating its missing `value:` as "empty"
  // would flag every secret in the console env and get the layer muted.
  const entries = parseEnvEntries(`[
    { name: 'LOOM_SECRET', secretRef: 'kv-secret-name' }
  ]`);
  assert.equal(entries.size, 1);
  assert.equal(entries.get('LOOM_SECRET'), null);
});

test('parseEnvEntries survives values containing braces and nested parens', () => {
  const entries = parseEnvEntries(`[
    { name: 'LOOM_OBJ', value: union({ a: 1 }, b) }
    { name: 'LOOM_AFTER', value: '' }
  ]`);
  // The entry after a brace-bearing value must still be found — a naive
  // brace-counter that mis-balances here would silently truncate the scan and
  // report a clean tree.
  assert.equal(entries.size, 2);
  assert.equal(entries.get('LOOM_AFTER'), "''");
});

// ── shape (a): hard-coded empty ───────────────────────────────────────────────

test('isAlwaysEmptyLiteral flags a bare empty string', () => {
  assert.equal(isAlwaysEmptyLiteral("''"), true);
  assert.equal(isAlwaysEmptyLiteral("  ''  "), true);
});

test('isAlwaysEmptyLiteral flags a ternary whose branches are both empty', () => {
  assert.equal(isAlwaysEmptyLiteral("flag ? '' : ''"), true);
});

test('isAlwaysEmptyLiteral does NOT flag a conditional that can produce a value', () => {
  // This is the correct honest-gate shape (the loomDirectLake / weavePg wiring).
  assert.equal(isAlwaysEmptyLiteral("active ? 'https://\${m.outputs.fqdn}' : ''"), false);
  assert.equal(isAlwaysEmptyLiteral("'entra'"), false);
  assert.equal(isAlwaysEmptyLiteral('someParam'), false);
});

// ── shape (b): a param nobody passes ──────────────────────────────────────────

test('collectEmptyDefaultParams finds only string params defaulting to empty', () => {
  const found = collectEmptyDefaultParams(
    [
      "param deadOne string = ''",
      "param liveOne string = 'loom-control'",
      'param aNumber int = 0',
      'param noDefault string',
      "param deadTwo string = ''",
    ].join('\n'),
  );
  assert.deepEqual([...found].sort(), ['deadOne', 'deadTwo']);
});

test('isBareIdentifier distinguishes a param reference from an expression', () => {
  assert.equal(isBareIdentifier('loomCopyJobControlSqlServer'), true);
  assert.equal(isBareIdentifier("flag ? a : ''"), false);
  assert.equal(isBareIdentifier("'literal'"), false);
  assert.equal(isBareIdentifier('m.outputs.fqdn'), false);
});

// ── the embedded control ──────────────────────────────────────────────────────

test('the embedded control holds on the shipped classifier', () => {
  // If this fails, LAYER 3 refuses to report at all — by design.
  assert.deepEqual(runInertControl(), []);
});

// ── the layer, against the real tree ──────────────────────────────────────────

test('the real console env block parses to a large entry set', () => {
  // The "measuring nothing" failure mode: a parser that drifts off the env block
  // returns few or zero entries and every downstream verdict is vacuous.
  const entries = collectConsoleEnvExpressions();
  assert.ok(
    entries.size > 100,
    `expected >100 console env entries, got ${entries.size} — parseEnvEntries has drifted`,
  );
});

// ── the POPULATION (#3940) ────────────────────────────────────────────────────
//
// The guard's verdict was green because its EXAMINED SET was smaller than the
// set it exists to police: `parseEnvEntries` matched only `LOOM_*`, so every
// `NEXT_PUBLIC_LOOM_*` the deploy emits was invisible. That prefix is the one
// that reaches the BROWSER, so an emitted-but-empty one silently no-ops a
// client feature — the hardest class to notice from the server side.
//
// Measured on the loom-console env block at 0cad3ac7, 454 distinct names:
//   before  438 examined  (LOOM_*)
//   after   451 examined  (LOOM_* + NEXT_PUBLIC_LOOM_*)
//   out       3 by name   (AZURE_CLOUD, AZURE_TENANT_ID, SESSION_SECRET)

test('#3940 parseEnvEntries examines NEXT_PUBLIC_LOOM_* as well as LOOM_*', () => {
  const entries = parseEnvEntries(`[
    { name: 'LOOM_A', value: '' }
    { name: 'NEXT_PUBLIC_LOOM_B', value: deadParam }
    { name: 'NEXT_PUBLIC_LOOM_C', value: active ? 'https://x' : '' }
  ]`);
  // Restore the old /name:\s*'(LOOM_[A-Z0-9_]+)'/ regex and this drops to 1.
  assert.equal(entries.size, 3);
  assert.equal(entries.get('NEXT_PUBLIC_LOOM_B'), 'deadParam');
  assert.equal(entries.get('NEXT_PUBLIC_LOOM_C'), "active ? 'https://x' : ''");
});

test('#3940 a name in neither family FAILS CLOSED unless it was triaged by name', () => {
  // The alternative — dropping it quietly — is the #3940 defect under a new
  // spelling. A second blind prefix must cost a red run, not a silent shrink.
  assert.throws(
    () => parseEnvEntries("[{ name: 'VITE_LOOM_X', value: 'x' }]"),
    /neither policies nor has triaged: VITE_LOOM_X/,
  );
  // The three the deploy really emits are triaged BY NAME, so they pass.
  const triaged = NON_LOOM_CONSOLE_ENV_NAMES.map((n) => `{ name: '${n}', value: 'x' }`).join('\n');
  assert.equal(parseEnvEntries(`[\n${triaged}\n]`).size, 0);
});

test('#3940 the real population covers both delivery prefixes, grow-only', () => {
  const names = [...collectConsoleEnvExpressions().keys()];
  const loom = names.filter((n) => n.startsWith('LOOM_'));
  const pub = names.filter((n) => n.startsWith('NEXT_PUBLIC_LOOM_'));
  // Floors, not equalities: the env block grows. The point is that NEITHER
  // family may collapse to zero and go unnoticed, which is what happened.
  assert.ok(loom.length >= 438, `LOOM_* population shrank to ${loom.length} (was 438)`);
  assert.ok(pub.length >= 13, `NEXT_PUBLIC_LOOM_* population shrank to ${pub.length} (was 13)`);
  assert.equal(loom.length + pub.length, names.length, 'a third family crept into the population');
  // NON_LOOM_CONSOLE_ENV_NAMES is an exclusion list; an unbounded one would be
  // the same blindness with extra steps.
  assert.ok(NON_LOOM_CONSOLE_ENV_NAMES.length <= 3,
    `${NON_LOOM_CONSOLE_ENV_NAMES.length} names excluded by name — each needs a reviewed reason`);
});

test('the tree is clean of UNRATCHETED always-empty vars', () => {
  const { inert } = computeInert();
  assert.deepEqual(
    inert.map((i) => i.name),
    [],
    'new always-empty console env vars appeared; make the deploy produce the value',
  );
});

test('every ratcheted name is still emitted on the console app', () => {
  // A ratchet that names vars the tree no longer emits has stopped describing
  // anything — the stale-ratchet shape that turns a guard into silent coverage.
  const present = new Set(collectConsoleEnvExpressions().keys());
  const stale = [...KNOWN_INERT.keys(), ...UNTRIAGED_INERT].filter((n) => !present.has(n));
  assert.deepEqual(stale, [], 'ratcheted names no longer emitted — delete them or fix the emission');
});

test('the ratchet is non-empty and every KNOWN_INERT entry carries a reason', () => {
  assert.ok(KNOWN_INERT.size > 0, 'KNOWN_INERT is empty — the layer has nothing pinned');
  for (const [name, reason] of KNOWN_INERT) {
    assert.ok(
      typeof reason === 'string' && reason.length > 40,
      `KNOWN_INERT['${name}'] must carry a substantive reason, not a placeholder`,
    );
  }
});

test('the two ratchets are disjoint', () => {
  // A name in both would be triaged and untriaged at once, and deleting it from
  // one would silently leave it suppressed by the other.
  const overlap = [...KNOWN_INERT.keys()].filter((n) => UNTRIAGED_INERT.has(n));
  assert.deepEqual(overlap, []);
});
