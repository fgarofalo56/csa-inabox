// Behaviour tests for the `emitted-by-bicep` half of scripts/ci/check-env-sync.mjs.
//
// WHY THIS SUITE EXISTS
// ---------------------
// check-env-sync is the ONLY automated statement that
// `.claude/rules/auto-bind-by-default.md` §5 holds — "the value must be produced
// by the deploy", never by an operator setting LOOM_X by hand. It made that
// statement by scanning the bicep tree for the variable's NAME.
//
// It scanned the RAW file text. So a variable that appeared only in a `//`
// comment, or inside an `@description(…)` decorator, counted as "emitted by
// platform bicep" — and the guard reported OK for a var no deployment sets.
//
// Measured on 2026-08-04, mutation-proved in two rounds against
// LOOM_RISINGWAVE_URL with its ALLOWLIST entry removed (i.e. with the guard
// explicitly responsible for it):
//
//   round 1  rename the sole real emission
//            (admin-plane/main.bicep `{ name: 'LOOM_RISINGWAVE_URL', … }`)
//            -> guard GREEN, because main.bicep:744 says
//               `// Backs LOOM_RISINGWAVE_URL (the streaming-sql item …)`
//   round 2  same mutation, comments now stripped
//            -> guard STILL GREEN, because loom-risingwave-aca.bicep:426 says
//               `@description('… set on the Console app as LOOM_RISINGWAVE_URL …')`
//   round 3  same mutation, comments AND doc decorators stripped
//            -> guard RED, naming LOOM_RISINGWAVE_URL. Correct.
//
// Removing an allowlist entry — the normal way an engineer says "the deploy is
// now responsible for this" — therefore bought NOTHING until rounds 1 and 2 were
// fixed. That is the repo's recurring "guard that cannot fail" shape: the check
// ran, printed a number, and measured prose.
//
// The tests below pin the fix from both directions: prose must not count, and
// real emissions must still count (a stripper that ate ordinary string literals
// would break every genuine `name: 'LOOM_X'`).
//
// Run: node --test scripts/ci/__tests__/env-sync-doc-blindness.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectEmitted,
  computeMissing,
  stripBicepDocs,
  collectConsoleDelivered,
  computeUndelivered,
  KNOWN_UNDELIVERED,
} from '../check-env-sync.mjs';

const names = (src) => [...new Set(stripBicepDocs(src).match(/LOOM_[A-Z0-9_]+/g) || [])];

// ── stripBicepDocs(): prose is removed ──────────────────────────────────────

test('a // comment naming a var does not make it emitted', () => {
  // Round-1 regression, verbatim shape from admin-plane/main.bicep:744.
  assert.deepEqual(names("// Backs LOOM_RISINGWAVE_URL (the streaming-sql item).\n"), []);
});

test('a block comment naming a var does not make it emitted', () => {
  assert.deepEqual(names('/*\n * LOOM_DUCKLAKE_CATALOG_URL is the DuckLake DSN.\n */\n'), []);
});

test('an @description() decorator naming a var does not make it emitted', () => {
  // Round-2 regression, verbatim shape from loom-risingwave-aca.bicep:426.
  const src = "@description('Internal FQDN — set on the Console app as LOOM_RISINGWAVE_URL (append :<port>).')\noutput fqdn string = x\n";
  assert.deepEqual(names(src), []);
});

test('@sys.description and @metadata are treated the same as @description', () => {
  assert.deepEqual(names("@sys.description('sets LOOM_A_URL')\n"), []);
  assert.deepEqual(names("@metadata({ note: 'sets LOOM_B_URL' })\n"), []);
});

test('a doc decorator containing parentheses does not end early and leak its tail', () => {
  // A naive "skip to the next )" would stop at the first inner paren and let the
  // remainder of the prose through — re-creating the bug for any description
  // that happens to contain a parenthetical, which most of them do.
  const src = "@description('the pool (all-purpose) cluster id -> LOOM_LEAKED_NAME on the Console')\nparam p string\n";
  assert.deepEqual(names(src), []);
});

test('a multi-line \'\'\' doc string is fully consumed', () => {
  const src = "@description('''\nLine one.\nLOOM_MULTILINE_NAME is described here.\n''')\nparam p string\n";
  assert.deepEqual(names(src), []);
});

// ── stripBicepDocs(): real code is preserved ────────────────────────────────

test('a real env-array emission still counts', () => {
  const src = "{ name: 'LOOM_RISINGWAVE_URL', value: active ? 'host:4566' : '' }\n";
  assert.deepEqual(names(src), ['LOOM_RISINGWAVE_URL']);
});

test('a secretRef emission still counts', () => {
  const src = "{ name: 'LOOM_DUCKLAKE_CATALOG_URL', secretRef: 'loom-ducklake-catalog-url' }\n";
  assert.deepEqual(names(src), ['LOOM_DUCKLAKE_CATALOG_URL']);
});

test('a // inside a URL string literal is not mistaken for a comment', () => {
  // Without string tracking the stripper would truncate at `https://` and drop
  // every emission later on the line — silently turning real emissions into
  // "missing" and pushing engineers to allowlist vars the deploy DOES set.
  const src = "{ name: 'LOOM_X_URL', value: 'https://example.internal/x' }  { name: 'LOOM_Y_URL', value: '' }\n";
  assert.deepEqual(names(src), ['LOOM_X_URL', 'LOOM_Y_URL']);
});

test('an emission on the same line as a trailing comment survives; the comment does not', () => {
  const src = "{ name: 'LOOM_REAL_URL', value: '' }  // also see LOOM_PROSE_ONLY_URL\n";
  assert.deepEqual(names(src), ['LOOM_REAL_URL']);
});

// ── the real tree ───────────────────────────────────────────────────────────

test('the guard passes on the committed tree', () => {
  // Not decoration: every assertion below reads the same real bicep, so a tree
  // that already fails would make them ambiguous.
  const { missing } = computeMissing();
  assert.deepEqual(missing, [], `unallowlisted read-but-not-emitted vars: ${missing.join(', ')}`);
});

test('the auto-bind vars behind /admin/readiness are emitted by REAL bicep, not prose', () => {
  // Task #76 / auto-bind-by-default.md §5. These three are the capabilities the
  // live 2026-08-04 readiness walk reported blocked; the fix for each is that
  // the deploy emits the value. With doc text stripped, this assertion can only
  // pass if an actual `{ name: 'LOOM_…' }` emission exists — which is the whole
  // point. If someone deletes an emission, this fails by name.
  const emitted = collectEmitted();
  for (const v of ['LOOM_RISINGWAVE_URL', 'LOOM_DUCKDB_URL', 'LOOM_DUCKLAKE_CATALOG_URL']) {
    assert.equal(emitted.has(v), true, `${v} is no longer emitted by any bicep outside comments/@description`);
  }
});

test('stripping is load-bearing: the raw-text scan really was more permissive', () => {
  // Pins the DIRECTION of the fix. If a future refactor reverts collectEmitted()
  // to raw text, the emitted set grows and this fails. Measured gap on the
  // 2026-08-04 tree: 628 raw vs 570 after stripping.
  const emitted = collectEmitted();
  assert.ok(emitted.size > 400, `sanity: expected a populated emitted set, got ${emitted.size}`);
  assert.equal(emitted.has('LOOM_CAPACITY_BROKER_URL'), false,
    'LOOM_CAPACITY_BROKER_URL is named only in loom-capacity-broker-app.bicep prose; no bicep emits it (LOOM_BROKER_URL is the emitted name)');
});

/**
 * #3012 — PER-APP DELIVERY.
 *
 * `collectEmitted()` is name-anywhere-in-the-tree: it flattens every LOOM_* token
 * from every bicep file into one set, so a name counts as emitted when ANY file
 * mentions it — including one wiring a completely DIFFERENT container app. Proven
 * on 2026-08-05: deleting every `LOOM_ICEBERG_CATALOG_URL` occurrence from
 * admin-plane/main.bicep (5 -> 0) left the guard exiting 0, because sibling bicep
 * files mention the name. With the delivery check in place the same deletion
 * exits 1 and names the variable.
 *
 * `collectConsoleDelivered()` answers the real question — does the loom-console
 * container app RECEIVE this value — by reading the env of its own apps[] entry
 * plus the env app-deployments.bicep applies to every app.
 */
test('per-app delivery is NARROWER than name-anywhere emission', () => {
  const emitted = collectEmitted();
  const delivered = collectConsoleDelivered();
  assert.ok(delivered.size > 100, `sanity: expected a populated console env, got ${delivered.size}`);
  assert.ok(
    delivered.size < emitted.size,
    `delivery (${delivered.size}) must be strictly narrower than name-anywhere emission ` +
      `(${emitted.size}); if these converge, the attribution has stopped attributing`,
  );
});

test('vars emitted onto ANOTHER app are not counted as delivered to the console', () => {
  const emitted = collectEmitted();
  const delivered = collectConsoleDelivered();
  // Each IS referenced in bicep (so the flat check passes) but is set on
  // loom-duckdb / loom-iceberg-catalog / loom-sharing — never on the console.
  for (const v of ['LOOM_LAKE_ACCOUNT', 'LOOM_SHARING_ENDPOINT', 'LOOM_SHARING_BEARER']) {
    assert.equal(emitted.has(v), true, `${v} should still satisfy the flat emitted check`);
    assert.equal(delivered.has(v), false, `${v} is set on a DIFFERENT app; not delivered`);
    assert.equal(KNOWN_UNDELIVERED.has(v), true, `${v} must be fenced as known debt`);
  }
});

test('the Trino session user reaches the CONSOLE, not just the Trino app', () => {
  // The console opens the Trino session (trino-client.ts sessionUser()). Before
  // #3012 this var was set only on loom-trino-aca, so the console silently used
  // its hardcoded fallback and would diverge from a customised engine sessionUser.
  assert.equal(collectConsoleDelivered().has('LOOM_TRINO_SESSION_USER'), true);
});

test('the repository has no unfenced per-app delivery gaps', () => {
  const { undelivered } = computeUndelivered();
  assert.deepEqual(undelivered, [], `read-but-not-delivered-to-console: ${undelivered.join(', ')}`);
});

test('KNOWN_UNDELIVERED is a shrinking ratchet, not a growing allowlist', () => {
  assert.ok(
    KNOWN_UNDELIVERED.size <= 5,
    `KNOWN_UNDELIVERED grew to ${KNOWN_UNDELIVERED.size}; fence entries are debt, not a fix`,
  );
});
