/**
 * check-ci-guard-reachability tests (refs #2860).
 *
 * The guard exists because two merge-blocking guards sat in scripts/ci with no
 * workflow lane. Its own failure modes therefore matter more than usual: a
 * discovery bug, or a reachability rule loose enough that PROSE satisfies it,
 * would recreate exactly the defect it exists to catch.
 *
 * The sharpest test here is the comment one. Almost every guard in this repo
 * names itself in its own header and in another guard's remediation text, so a
 * substring search over a workflow file would have been satisfied by
 *
 *     # TODO: wire scripts/ci/check-route-smoke-floor.mjs into this lane
 *
 * i.e. by the very comment admitting it is not wired.
 *
 * MUTATION-PROVEN (counts in the PR body):
 *   - drop stripCommentLines() from runBodies(): the comment test goes RED.
 *   - make runBodies() return the whole YAML instead of just `run:` bodies:
 *     the step-name test goes RED.
 *   - make orphans always [] : every FAIL test goes RED, CONTROLs stay green.
 *
 * Run: node --test scripts/ci/__tests__/ci-guard-reachability.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { analyze, discoverControls, runBodies, stripCommentLines, EXEMPT } from '../check-ci-guard-reachability.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', 'check-ci-guard-reachability.mjs');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/** Build a throwaway repo-shaped tree: { 'scripts/ci/x.mjs': '…' }. */
function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-reach-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

const WF = (runBody) => `name: t\non:\n  pull_request:\njobs:\n  j:\n    steps:\n      - name: a step\n        run: |\n${runBody}\n`;

// ── the rule ───────────────────────────────────────────────────────────────

test('a control no workflow runs is an orphan', () => {
  const root = fixture({
    'scripts/ci/check-thing.mjs': '// guard\n',
    '.github/workflows/ci.yml': WF('          echo hello'),
  });
  assert.deepEqual(analyze(root).orphans, ['check-thing.mjs']);
});

test('a control invoked in a run body is reachable', () => {
  const root = fixture({
    'scripts/ci/check-thing.mjs': '// guard\n',
    '.github/workflows/ci.yml': WF('          node scripts/ci/check-thing.mjs'),
  });
  assert.deepEqual(analyze(root).orphans, []);
});

test('a control invoked by a one-line `run:` (no block scalar) is reachable', () => {
  const root = fixture({
    'scripts/ci/check-thing.mjs': '// guard\n',
    '.github/workflows/ci.yml':
      'name: t\non:\n  pull_request:\njobs:\n  j:\n    steps:\n      - name: a step\n        run: node scripts/ci/check-thing.mjs\n',
  });
  assert.deepEqual(analyze(root).orphans, []);
});

test('A COMMENT DOES NOT COUNT — the defect this guard exists to catch', () => {
  const root = fixture({
    'scripts/ci/check-thing.mjs': '// guard\n',
    '.github/workflows/ci.yml': WF('          # TODO: wire scripts/ci/check-thing.mjs in\n          echo hello'),
  });
  assert.deepEqual(
    analyze(root).orphans,
    ['check-thing.mjs'],
    'a guard that a comment can satisfy is not a guard',
  );
});

test('a mention in a step NAME (not a run body) does not count', () => {
  const root = fixture({
    'scripts/ci/check-thing.mjs': '// guard\n',
    '.github/workflows/ci.yml':
      'name: t\non:\n  pull_request:\njobs:\n  j:\n    steps:\n      - name: check-thing.mjs\n        run: |\n          echo hello\n',
  });
  assert.deepEqual(analyze(root).orphans, ['check-thing.mjs']);
});

test('a control naming ITSELF in its own header is still an orphan', () => {
  // Every guard in this repo does this. It must never establish reachability.
  const root = fixture({
    'scripts/ci/check-thing.mjs': '// Usage: node scripts/ci/check-thing.mjs\n',
    '.github/workflows/ci.yml': WF('          echo hello'),
  });
  assert.deepEqual(analyze(root).orphans, ['check-thing.mjs']);
});

test('transitive reachability: a wired script that invokes another', () => {
  const root = fixture({
    'scripts/ci/check-a.mjs': 'spawn("node", ["scripts/ci/check-b.mjs"]);\n',
    'scripts/ci/check-b.mjs': '// guard\n',
    '.github/workflows/ci.yml': WF('          node scripts/ci/check-a.mjs'),
  });
  assert.deepEqual(analyze(root).orphans, []);
});

test('transitivity does NOT flow through an orphaned script', () => {
  const root = fixture({
    'scripts/ci/check-a.mjs': 'spawn("node", ["scripts/ci/check-b.mjs"]);\n',
    'scripts/ci/check-b.mjs': '// guard\n',
    '.github/workflows/ci.yml': WF('          echo hello'),
  });
  assert.deepEqual(analyze(root).orphans.sort(), ['check-a.mjs', 'check-b.mjs']);
});

// ── the population ─────────────────────────────────────────────────────────

test('population: check-*, test-*.sh, *-verdict.sh and --check generators', () => {
  const root = fixture({
    'scripts/ci/check-a.mjs': '',
    'scripts/ci/check-b.sh': '',
    'scripts/ci/test-c.sh': '',
    'scripts/ci/d-verdict.sh': '',
    'scripts/ci/generate-e.mjs': "if (process.argv.includes('--check')) {}\n",
    'scripts/ci/generate-f.mjs': '// pure generator, no gate mode\n',
    'scripts/ci/_shared.mjs': '// library\n',
    'scripts/ci/baseline.json': '{}',
    'scripts/ci/__tests__/a.test.mjs': '',
  });
  assert.deepEqual(discoverControls(root), [
    'check-a.mjs',
    'check-b.sh',
    'd-verdict.sh',
    'generate-e.mjs',
    'test-c.sh',
  ]);
});

test('CONTROL: a `_`-prefixed shared library is not a control', () => {
  // _ratchet-count.mjs is imported by four guards and invoked by none. Counting
  // it would force a fake CI lane for a module.
  const root = fixture({ 'scripts/ci/_ratchet-count.mjs': 'export function x(){}\n' });
  assert.deepEqual(discoverControls(root), []);
});

// ── fail-closed ────────────────────────────────────────────────────────────

test('REFUSES TO PASS on an empty tree (a scanner that matches nothing)', () => {
  const root = fixture({ 'README.md': 'x' });
  const r = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /REFUSING TO PASS/);
});

test('REFUSES TO PASS when controls exist but no workflows do', () => {
  const root = fixture({ 'scripts/ci/check-a.mjs': '' });
  const r = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /REFUSING TO PASS/);
});

test('exits 1 and names the orphan', () => {
  const root = fixture({
    'scripts/ci/check-orphaned.mjs': '',
    '.github/workflows/ci.yml': WF('          echo hello'),
  });
  const r = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /check-orphaned\.mjs/);
});

// ── the real repo ──────────────────────────────────────────────────────────

test('CONTROL: the real repo passes — every control is wired', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: REPO_ROOT });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test('the two controls orphaned in #2860 are in the population and reachable', () => {
  // Named explicitly so a future refactor that drops one out of discovery, or
  // un-wires it, fails loudly instead of silently returning to "never runs".
  const { controls, reachedBy } = analyze(REPO_ROOT);
  for (const c of ['check-route-smoke-floor.mjs', 'check-insecure-randomness.mjs']) {
    assert.ok(controls.includes(c), `${c} dropped out of the population`);
    assert.ok(reachedBy.has(c), `${c} is no longer invoked by any workflow`);
  }
});

test('EXEMPT is empty — every control has a lane', () => {
  assert.equal(EXEMPT.size, 0, `unexpected exemptions: ${[...EXEMPT.keys()].join(', ')}`);
});

// ── helpers ────────────────────────────────────────────────────────────────

test('stripCommentLines drops #, // and block-comment lines', () => {
  const kept = stripCommentLines('# a\nnode x.mjs\n// b\n * c\n/* d\nnode y.mjs\n');
  assert.ok(kept.includes('node x.mjs'));
  assert.ok(kept.includes('node y.mjs'));
  assert.ok(!kept.includes('# a'));
  assert.ok(!kept.includes('// b'));
  assert.ok(!kept.includes('* c'));
  assert.ok(!kept.includes('/* d'));
});

test('runBodies extracts only run: blocks', () => {
  const body = runBodies(
    'jobs:\n  j:\n    steps:\n      - name: node scripts/ci/check-a.mjs\n        if: node scripts/ci/check-b.mjs\n        run: |\n          node scripts/ci/check-c.mjs\n      - name: next\n        run: echo done\n',
  );
  assert.ok(body.includes('check-c.mjs'));
  assert.ok(body.includes('echo done'));
  assert.ok(!body.includes('check-a.mjs'));
  assert.ok(!body.includes('check-b.mjs'));
});
