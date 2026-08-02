// Behaviour tests for scripts/ci/check-node-test-suites.mjs.
//
// The guard's whole purpose is to stop a suite from sitting in the tree
// unexecuted (#2835), so its own failure modes matter more than usual: a
// discovery bug or a swallowed exit code would recreate exactly the defect it
// exists to catch. These tests drive the pure decision core through every
// branch and exercise discovery against a fixture tree on disk.
//
// Run: node --test scripts/ci/__tests__/node-test-suites.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  decide,
  discoverSuites,
  isOwnedByOtherRunner,
  parseTapSummary,
  OTHER_RUNNER_TREES,
  REPO_ROOT,
} from '../check-node-test-suites.mjs';

/** Build a throwaway tree and return its root. */
function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-test-suites-'));
  for (const rel of files) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '// fixture\n');
  }
  return root;
}

// ── decide(): the pure core ─────────────────────────────────────────────────

test('decide: a failing child propagates its EXACT status (never downgraded)', () => {
  // The recurring defect in this repo is a control whose real result is
  // discarded. A non-zero child must survive every later heuristic.
  const r = decide({ status: 3, summary: { pass: 100, fail: 1 }, ci: true });
  assert.equal(r.code, 3);
  assert.match(r.reason, /suite failed/);
});

test('decide: a child killed by a signal (status null) still fails', () => {
  const r = decide({ status: null, summary: null, ci: true });
  assert.equal(r.code, 1);
});

test('decide: exit 0 with NO TAP summary fails — the run never concluded', () => {
  const r = decide({ status: 0, summary: null, ci: true });
  assert.equal(r.code, 1);
  assert.match(r.reason, /no TAP summary/);
});

test('decide: exit 0 with ZERO passing tests FAILS in CI (measured nothing)', () => {
  // Every suite skipped. node --test exits 0, so without this branch the lane
  // would be green while asserting nothing at all.
  const r = decide({ status: 0, summary: { pass: 0, fail: 0, skipped: 26 }, ci: true });
  assert.equal(r.code, 1);
  assert.match(r.reason, /measured nothing/);
});

test('decide: the same all-skipped run WARNS but passes locally', () => {
  // A developer without a POSIX sh has a degraded environment, not a broken
  // repo. CI is where the hard error belongs.
  const r = decide({ status: 0, summary: { pass: 0, fail: 0, skipped: 26 }, ci: false });
  assert.equal(r.code, 0);
  assert.match(r.reason, /WARNING/);
});

// CONTROL — passes both before and after any tightening of decide(). A change
// that made the guard unable to pass a genuinely good run would break this.
test('CONTROL: a normal green run passes in BOTH ci and local modes', () => {
  for (const ci of [true, false]) {
    const r = decide({ status: 0, summary: { pass: 158, fail: 0, skipped: 0 }, ci });
    assert.equal(r.code, 0, `expected pass with ci=${ci}: ${r.reason}`);
  }
});

// ── parseTapSummary ─────────────────────────────────────────────────────────

test('parseTapSummary: reads the node:test TAP counters', () => {
  const s = parseTapSummary('# tests 158\n# pass 157\n# fail 1\n# skipped 0\n');
  assert.deepEqual(s, { pass: 157, fail: 1, skipped: 0 });
});

test('CONTROL: CRLF output parses identically to LF', () => {
  // Documents a property rather than guarding a fix. JS `$` under /m already
  // treats \r as a line terminator, so `^# pass (\d+)$` matches CRLF output
  // unchanged — verified by mutation: adding an explicit `\r?` to the pattern
  // changed nothing, so it was removed rather than shipped as an inert fix.
  // This test therefore passes both ways ON PURPOSE; it exists so a future
  // rewrite of parseTapSummary that breaks CRLF handling is caught.
  const s = parseTapSummary('# tests 158\r\n# pass 157\r\n# fail 1\r\n# skipped 0\r\n');
  assert.deepEqual(s, { pass: 157, fail: 1, skipped: 0 });
});

test('parseTapSummary: returns null when counters are absent', () => {
  // Truncated / crashed output must NOT be read as a clean zero.
  assert.equal(parseTapSummary('some crash output\n'), null);
  assert.equal(parseTapSummary('# pass 5\n'), null); // fail counter missing
});

// ── discovery ───────────────────────────────────────────────────────────────

test('discover: finds .test.mjs, .test.cjs and .test.js at any depth', () => {
  const root = fixture([
    'apps/a/tests/one.test.mjs',
    'apps/b/deep/nested/two.test.cjs',
    'tools/c/test/three.test.js',
    'apps/a/src/index.mjs', // not a test
    'apps/a/tests/README.md',
  ]);
  assert.deepEqual(discoverSuites(root), [
    'apps/a/tests/one.test.mjs',
    'apps/b/deep/nested/two.test.cjs',
    'tools/c/test/three.test.js',
  ]);
});

test('discover: never descends into node_modules or build output', () => {
  const root = fixture([
    'apps/a/tests/real.test.mjs',
    'node_modules/pkg/thing.test.mjs',
    'apps/a/node_modules/dep/dep.test.mjs',
    'apps/a/dist/bundled.test.mjs',
    'apps/a/.next/chunk.test.mjs',
    'coverage/report.test.mjs',
  ]);
  assert.deepEqual(discoverSuites(root), ['apps/a/tests/real.test.mjs']);
});

test('discover: skips trees owned by another runner', () => {
  const root = fixture([
    'apps/a/tests/real.test.mjs',
    'portal/react-webapp/src/Thing.test.js', // jest owns this
  ]);
  assert.deepEqual(discoverSuites(root), ['apps/a/tests/real.test.mjs']);
});

test('discover: a directory merely PREFIXED by an excluded one is still walked', () => {
  // `portal/react-webapp-legacy` must not be swallowed by a substring match —
  // that is the over-broad-exclusion shape that silently drops coverage.
  const root = fixture([
    'portal/react-webapp-legacy/tests/a.test.mjs',
    'portal/react-webapp/src/b.test.js',
  ]);
  assert.deepEqual(discoverSuites(root), ['portal/react-webapp-legacy/tests/a.test.mjs']);
});

test('discover: an empty tree yields [] so main() can fail closed on it', () => {
  assert.deepEqual(discoverSuites(fixture([])), []);
});

test('isOwnedByOtherRunner: matches the dir itself and its children only', () => {
  assert.equal(isOwnedByOtherRunner('portal/react-webapp'), true);
  assert.equal(isOwnedByOtherRunner('portal/react-webapp/src/x.test.js'), true);
  assert.equal(isOwnedByOtherRunner('portal/react-webapp-legacy/x.test.mjs'), false);
  assert.equal(isOwnedByOtherRunner('apps/loom-unity/tests/entrypoint.test.mjs'), false);
});

// ── the real repo ───────────────────────────────────────────────────────────

test('the four suites orphaned in #2835 are discovered in the real tree', () => {
  // Named explicitly: these are the suites that had NO lane. If a future
  // refactor moves or renames one, this fails loudly instead of silently
  // dropping it back out of CI.
  const found = discoverSuites(REPO_ROOT);
  for (const orphan of [
    'apps/loom-unity/tests/entrypoint.test.mjs',
    'apps/loom-onelake/tests/resolver.test.mjs',
    'scripts/csa-loom/tests/preflight-image-tags.test.mjs',
    'tools/ado-loom-task/test/inputs.test.js',
  ]) {
    assert.ok(found.includes(orphan), `discovery lost ${orphan}`);
  }
});

test('the ALREADY-covered suites stay discovered (no coverage was traded away)', () => {
  const found = discoverSuites(REPO_ROOT);
  assert.ok(found.includes('apps/loom-sharing/tests/entrypoint.test.mjs'));
  assert.ok(found.some((f) => f.startsWith('scripts/ci/__tests__/')));
});

test('every exclusion names a runner and the workflow that executes it', () => {
  // An undocumented exclusion is a hole. Force each one to carry its evidence.
  assert.ok(OTHER_RUNNER_TREES.length > 0);
  for (const t of OTHER_RUNNER_TREES) {
    assert.ok(t.dir && t.runner && t.workflow, `incomplete exclusion: ${JSON.stringify(t)}`);
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, t.workflow)),
      `${t.dir} claims ${t.workflow} runs it, but that workflow does not exist`,
    );
  }
});
