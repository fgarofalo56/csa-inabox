/**
 * Fail-closed tests for the two ratchets that had never run in CI (refs #2860).
 *
 * check-route-smoke-floor.mjs and check-insecure-randomness.mjs were both
 * merge-blocking by their own headers and invoked by no workflow. Wiring them
 * in is only half the fix: reading them first showed that BOTH reported OK
 * when they measured nothing, so a wiring that survived a directory rename
 * would have been a green check over an empty scan.
 *
 *   route-smoke-floor: total=0 makes `covered/total` NaN, and `NaN < floor`
 *                      is FALSE — so an empty app/ tree PASSED. Same for a
 *                      floor file that lost its floorRatio: `ratio < undefined`
 *                      is also FALSE.
 *   insecure-randomness: with every ROOT missing, total=0, `0 > 156` is FALSE,
 *                      and it printed "OK — and the count DROPPED by 156.
 *                      Lower BASELINE to 0 to lock the gain in." It
 *                      congratulated you for scanning nothing.
 *
 * MUTATION-PROVEN (counts in the PR body): removing either script's
 * REFUSING-TO-PASS block turns the matching tests RED while the real-repo
 * CONTROLs stay green — so the fail-closed branch cannot be deleted silently,
 * and it cannot have been written so broadly that it fails a healthy repo.
 *
 * Run: node --test scripts/ci/__tests__/ratchet-fail-closed.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CI_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(CI_DIR, '..', '..');
const ROUTE_FLOOR = path.join(CI_DIR, 'check-route-smoke-floor.mjs');
const RANDOMNESS = path.join(CI_DIR, 'check-insecure-randomness.mjs');

function run(script, { env = {}, cwd = REPO_ROOT } = {}) {
  const r = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ...env },
  });
  if (r.error) throw r.error;
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

// ── check-route-smoke-floor ────────────────────────────────────────────────

test('route-smoke-floor: an EMPTY app dir fails instead of passing on NaN', () => {
  const r = run(ROUTE_FLOOR, { env: { ROUTE_SMOKE_APP_DIR: tmpdir('empty-app') } });
  assert.equal(r.code, 1);
  assert.match(r.out, /ZERO page\.tsx files/);
});

test('route-smoke-floor: a MISSING app dir fails cleanly', () => {
  const missing = path.join(tmpdir('gone'), 'nope');
  const r = run(ROUTE_FLOOR, { env: { ROUTE_SMOKE_APP_DIR: missing } });
  assert.equal(r.code, 1);
  assert.match(r.out, /APP_DIR does not exist/);
});

test('route-smoke-floor: a floor file with no floorRatio fails', () => {
  // `ratio < undefined` is FALSE, so the comparison silently disappeared.
  const dir = tmpdir('floor');
  const file = path.join(dir, 'floor.json');
  fs.writeFileSync(file, JSON.stringify({ knownIssues: [], excludedDynamic: [] }));
  const r = run(ROUTE_FLOOR, { env: { ROUTE_SMOKE_FLOOR_FILE: file } });
  assert.equal(r.code, 1);
  assert.match(r.out, /floorRatio/);
});

test('route-smoke-floor: a floorRatio of 0 fails (a ratchet against nothing)', () => {
  const dir = tmpdir('floor0');
  const file = path.join(dir, 'floor.json');
  fs.writeFileSync(file, JSON.stringify({ floorRatio: 0, knownIssues: [], excludedDynamic: [] }));
  const r = run(ROUTE_FLOOR, { env: { ROUTE_SMOKE_FLOOR_FILE: file } });
  assert.equal(r.code, 1);
});

test('route-smoke-floor: a coverage DROP below the committed floor fails', () => {
  // The ratchet's actual job — pinned so the fail-closed work above cannot be
  // mistaken for the whole check.
  const dir = tmpdir('floor-high');
  const file = path.join(dir, 'floor.json');
  const real = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'apps/fiab-console/e2e/route-coverage-floor.json'), 'utf8'),
  );
  fs.writeFileSync(file, JSON.stringify({ ...real, floorRatio: 0.999, excludedDynamic: [], knownIssues: [] }));
  const r = run(ROUTE_FLOOR, { env: { ROUTE_SMOKE_FLOOR_FILE: file } });
  assert.equal(r.code, 1);
  assert.match(r.out, /coverage ratio dropped/);
});

test('CONTROL: route-smoke-floor passes against the real repo', () => {
  const r = run(ROUTE_FLOOR);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /at or above the committed floor/);
});

// ── check-insecure-randomness ──────────────────────────────────────────────

test('insecure-randomness: missing ROOTS fail instead of reporting a huge win', () => {
  // ROOTS are cwd-relative, so running from an unrelated directory reproduces a
  // rename/partial-checkout exactly.
  const r = run(RANDOMNESS, { cwd: tmpdir('no-roots') });
  assert.equal(r.code, 1);
  assert.match(r.out, /REFUSING TO PASS/);
  assert.match(r.out, /ROOTS do not exist/);
  assert.doesNotMatch(r.out, /count DROPPED/);
});

test('insecure-randomness: a stale STATISTICAL_EXEMPT entry is reported', () => {
  // Same run as above: the exempt files are cwd-relative too, so this asserts
  // the exemption-staleness branch specifically.
  const r = run(RANDOMNESS, { cwd: tmpdir('no-roots-2') });
  assert.match(r.out, /STATISTICAL_EXEMPT names .*rum\.ts, which no longer exists/);
});

test('CONTROL: insecure-randomness passes against the real repo', () => {
  const r = run(RANDOMNESS);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /baseline: \d+ {2}current: \d+/);
});

test('CONTROL: --update-baseline still reports the count without failing', () => {
  // The documented escape hatch must survive the fail-closed work.
  const r = spawnSync(process.execPath, [RANDOMNESS, '--update-baseline'], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: process.env,
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /current total/);
});
