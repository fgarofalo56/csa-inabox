/**
 * Tests for scripts/ci/check-lock-scan-coverage.mjs (refs #3485).
 *
 * The defect this guards against is not a wrong answer — it is a green answer
 * over an empty set. `Number of language-specific files  num=0` and a
 * 0-component SBOM both read exactly like "clean". So every test here is about
 * the guard being CAPABLE of the other verdict, and each assertion is paired
 * with its opposite.
 *
 * Run: node --test scripts/ci/__tests__/lock-scan-coverage.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  countPins,
  evaluateSbom,
  evaluateTrivy,
  findTarget,
  runControl,
  trackedLocks,
  trivyPackageCounts,
} from '../check-lock-scan-coverage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const GUARD = 'scripts/ci/check-lock-scan-coverage.mjs';

const LOCK = 'requirements/locks/portal/requirements.txt';
const pkgs = (n) => Array.from({ length: n }, (_, i) => ({ Name: `p${i}` }));
const report = (target, n) => ({ Results: [{ Target: target, Packages: pkgs(n) }] });

/* -------------------------------------------------------------------------- */
/* Pin counting — the expectation every other assertion is derived from.      */
/* -------------------------------------------------------------------------- */

test('countPins counts pins and nothing else', () => {
  assert.equal(countPins(''), 0);
  assert.equal(countPins('# a comment\n#    pip-compile --output-file=x\n'), 0);
  assert.equal(countPins('cryptography==50.0.0 \\\n    --hash=sha256:deadbeef\n    # via msal\n'), 1);
  // A hash line must not be mistaken for a pin, and neither must a `# via`.
  assert.equal(countPins('a==1 \\\n--hash=sha256:x\nb==2\n'), 2);
});

test('the pin count of the REAL locks is non-zero, and base is the only empty one', () => {
  const locks = trackedLocks();
  assert.ok(locks.length >= 9, `expected the committed locks, got ${locks.length}`);
  const empty = locks.filter((l) => l.pins === 0).map((l) => l.path);
  assert.deepEqual(empty, ['requirements/locks/base/requirements.txt']);
  assert.ok(locks.some((l) => l.pins > 50), 'no lock declares a substantial dependency set');
});

/* -------------------------------------------------------------------------- */
/* Trivy coverage — the #3485 shapes must all fail.                           */
/* -------------------------------------------------------------------------- */

test('a report that names NONE of the locks FAILS — this is the defect itself', () => {
  const r = evaluateTrivy({ report: { Results: [] }, locks: [{ path: LOCK, pins: 58 }] });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /does not appear in the Trivy report at all/);
  assert.equal(r.scanned, 0);
});

test('a report that names the lock with the RIGHT package count passes', () => {
  const r = evaluateTrivy({ report: report(LOCK, 58), locks: [{ path: LOCK, pins: 58 }] });
  assert.deepEqual(r.problems, []);
  assert.equal(r.scanned, 1);
  assert.equal(r.packages, 58);
});

test('a report that reaches the lock but UNDER-READS it fails', () => {
  // The analyser found the file and parsed part of it. "The target appeared"
  // would pass here, which is why the assertion is on the count.
  const r = evaluateTrivy({ report: report(LOCK, 57), locks: [{ path: LOCK, pins: 58 }] });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /declares 58 pin\(s\) but Trivy reported 57/);
});

test('the scan-root prefix does not matter — a report rooted at requirements/ still matches', () => {
  const rooted = evaluateTrivy({
    report: report('locks/portal/requirements.txt', 58),
    locks: [{ path: LOCK, pins: 58 }],
  });
  assert.deepEqual(rooted.problems, []);
  // ...and a DIFFERENT extra with the same filename does not satisfy it.
  const wrong = evaluateTrivy({
    report: report('locks/bff/requirements.txt', 58),
    locks: [{ path: LOCK, pins: 58 }],
  });
  assert.equal(wrong.problems.length, 1);
  assert.match(wrong.problems[0], /does not appear/);
});

test('a lock with zero pins may be absent, but a population of only such locks may not', () => {
  // `base` has no dependencies, so no target for it is the truth.
  const allowed = evaluateTrivy({
    report: report(LOCK, 58),
    locks: [{ path: LOCK, pins: 58 }, { path: 'requirements/locks/base/requirements.txt', pins: 0 }],
  });
  assert.deepEqual(allowed.problems, []);

  // But if NOTHING has pins, there was nothing a scan could have examined and
  // the leniency above would turn into a blanket pass.
  const vacuous = evaluateTrivy({
    report: { Results: [] },
    locks: [{ path: 'requirements/locks/base/requirements.txt', pins: 0 }],
  });
  assert.equal(vacuous.problems.length, 1);
  assert.match(vacuous.problems[0], /declare ZERO pins/);
});

test('an empty population FAILS rather than passing vacuously', () => {
  const r = evaluateTrivy({ report: { Results: [] }, locks: [] });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /matched ZERO/);
});

test('trivyPackageCounts and findTarget handle the report shapes Trivy emits', () => {
  const counts = trivyPackageCounts({
    Results: [
      { Target: 'locks/portal/requirements.txt', Packages: pkgs(3) },
      { Target: 'locks/bff/requirements.txt' }, // no Packages key at all
    ],
  });
  assert.equal(counts.get('locks/portal/requirements.txt'), 3);
  assert.equal(counts.get('locks/bff/requirements.txt'), 0);
  assert.equal(findTarget(counts, LOCK).packages, 3);
  assert.equal(findTarget(counts, 'requirements/locks/dev/requirements.txt'), null);
});

/* -------------------------------------------------------------------------- */
/* SBOM component floor.                                                      */
/* -------------------------------------------------------------------------- */

test('a 0-component SBOM FAILS and a populated one passes', () => {
  assert.match(evaluateSbom({ doc: { components: [] }, extra: 'portal' }).problems[0], /ZERO components/);
  assert.deepEqual(evaluateSbom({ doc: { components: [{ name: 'x' }] }, extra: 'portal' }).problems, []);
});

test('an SBOM with no components key at all is a REFUSAL, not a pass', () => {
  const r = evaluateSbom({ doc: { bomFormat: 'CycloneDX' }, extra: 'portal' });
  assert.match(r.problems[0], /no `components` array at all/);
});

/* -------------------------------------------------------------------------- */
/* The embedded control, and the CLI.                                         */
/* -------------------------------------------------------------------------- */

test('the embedded control passes, and its verdict really moves', () => {
  assert.deepEqual(runControl(), []);
});

test('--selftest exits 0 and says what it proved', () => {
  const r = spawnSync('node', [GUARD, '--selftest'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /control OK/);
  assert.match(r.stdout, /verdict moves/);
});

test('the CLI fails on a missing report, an empty one, and unparseable JSON', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lsc-'));
  try {
    const missing = spawnSync('node', [GUARD, '--trivy', path.join(dir, 'nope.json')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /does not exist/);

    const empty = path.join(dir, 'empty.json');
    writeFileSync(empty, '', 'utf8');
    const emptyRun = spawnSync('node', [GUARD, '--trivy', empty], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.notEqual(emptyRun.status, 0);
    assert.match(emptyRun.stderr, /is empty/);

    // A report shaped like the #3485 defect — valid JSON, no results — run
    // against the REAL tracked locks. This is the end-to-end failure path.
    const zero = path.join(dir, 'zero.json');
    writeFileSync(zero, JSON.stringify({ Results: [] }), 'utf8');
    const zeroRun = spawnSync('node', [GUARD, '--trivy', zero], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.notEqual(zeroRun.status, 0);
    assert.match(zeroRun.stderr, /does not appear in the Trivy report at all/);
    assert.match(zeroRun.stderr, /requirements\/locks\/portal\/requirements\.txt/);

    // And the same CLI passes on a synthesised report that covers every lock —
    // so the failure above is about the report, not about the CLI being broken.
    const good = path.join(dir, 'good.json');
    writeFileSync(
      good,
      JSON.stringify({
        Results: trackedLocks()
          .filter((l) => l.pins > 0)
          .map((l) => ({ Target: l.path, Packages: pkgs(l.pins) })),
      }),
      'utf8'
    );
    const goodRun = spawnSync('node', [GUARD, '--trivy', good], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(goodRun.status, 0, goodRun.stderr);
    assert.match(goodRun.stdout, /parsed all \d+ tracked lock file\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI refuses to do nothing quietly', () => {
  const r = spawnSync('node', [GUARD], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /nothing to check/);
});
