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
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
/* SBOM component floor — derived from the lock, symmetric with the Trivy side.*/
/* -------------------------------------------------------------------------- */

const lib = (n) => Array.from({ length: n }, (_, i) => ({ name: `c${i}`, type: 'library' }));
const fileComponent = { name: 'requirements.txt', type: 'file' };

test('a 0-component SBOM FAILS and a correctly-catalogued one passes', () => {
  assert.match(
    evaluateSbom({ doc: { components: [] }, extra: 'portal', pins: 3 }).problems[0],
    /ZERO components/
  );
  assert.deepEqual(
    evaluateSbom({ doc: { components: [...lib(3), fileComponent] }, extra: 'portal', pins: 3 }).problems,
    []
  );
});

test('an SBOM cataloguing FEWER libraries than the lock pins FAILS', () => {
  // The exact degradation a `components > 0` floor would have waved through:
  // 3 pins, 1 library, non-zero component count.
  const r = evaluateSbom({ doc: { components: [...lib(1), fileComponent] }, extra: 'portal', pins: 3 });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /describes 1 library component\(s\), but its lock declares 3 pin\(s\)/);
  assert.equal(r.libraries, 1);
});

test('the file component is not counted as a library', () => {
  const r = evaluateSbom({ doc: { components: [fileComponent] }, extra: 'portal', pins: 3 });
  assert.match(r.problems[0], /NONE of type "library"/);
  // And the message says what it DID see rather than asserting a cause.
  assert.match(r.problems[0], /types seen: file/);
});

test('an SBOM with no components key at all is a REFUSAL, not a pass', () => {
  const r = evaluateSbom({ doc: { bomFormat: 'CycloneDX' }, extra: 'portal', pins: 3 });
  assert.match(r.problems[0], /no `components` array at all/);
});

test('the REAL Syft baseline holds: libraries == pins, exactly', () => {
  // Not a guess. Measured 2026-08-15 over three extras spanning an order of
  // magnitude — bff 12/12, portal 58/58, copilot 160/160 — each with one extra
  // `type: "file"` component and zero declared-but-absent packages. If Syft's
  // shape changes this assumption, this test is where it surfaces.
  for (const pins of [12, 58, 160]) {
    const doc = { components: [...lib(pins), fileComponent] };
    const r = evaluateSbom({ doc, extra: 'portal', pins });
    assert.deepEqual(r.problems, []);
    assert.equal(r.libraries, pins);
    assert.equal(r.components, pins + 1);
  }
});

/* -------------------------------------------------------------------------- */
/* The two floors must cover the SAME population.                             */
/* -------------------------------------------------------------------------- */

test('sbom.yml\'s matrix covers exactly the locks with a non-empty pin set', () => {
  // The Trivy floor DERIVES its population from `git ls-files`; the SBOM matrix
  // is hand-listed. Left unchecked, a new extra gets a Trivy floor automatically
  // and is silently absent from the SBOM side — a floor over a population that
  // quietly stops matching is this repo's dominant defect class.
  // `\r` stripped first: this repo checks out CRLF on Windows, and a matcher
  // anchored on `\n` reads a perfectly good workflow as unparseable.
  const yaml = readFileSync(path.join(REPO_ROOT, '.github/workflows/sbom.yml'), 'utf8').replace(/\r/g, '');
  const block = /\n\s*extra:\n((?:\s*-\s*\S+\n)+)/.exec(yaml);
  assert.ok(block, 'could not find the `extra:` matrix in sbom.yml — the parse, not the workflow, may be wrong');
  const declared = [...block[1].matchAll(/-\s*(\S+)/g)].map((m) => m[1]).sort();
  assert.ok(declared.length > 0, 'the matrix parsed to zero extras; this test would pass vacuously');

  const locks = trackedLocks();
  const nonEmpty = locks.filter((l) => l.pins > 0).map((l) => l.path.split('/')[2]).sort();
  const empty = locks.filter((l) => l.pins === 0).map((l) => l.path.split('/')[2]);

  assert.deepEqual(
    declared,
    nonEmpty,
    'sbom.yml\'s matrix has drifted from the committed locks. Every lock with pins must get an ' +
      'SBOM (its floor is derived from that pin count), and a lock with none must NOT be listed ' +
      `(a 0-component SBOM for it would be TRUE). Empty by construction: ${empty.join(', ') || '(none)'}`
  );
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

test('--sbom without --extra is refused rather than floored against nothing', () => {
  const r = spawnSync('node', [GUARD, '--sbom', 'whatever.json'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /needs --extra/);
});

test('the failure remediation does NOT name a layout this repo measured as BROKEN', () => {
  // R7, applied to a guard's own remediation text. The first draft told the
  // reader the locks live at `requirements/<extra>/requirements.txt` — the exact
  // flat layout whose `dev` entry Trivy silently skips. A maintainer following
  // that remediation would have reintroduced the defect the guard exists to
  // catch. Drive the REAL failure path and read what it actually prints.
  const dir = mkdtempSync(path.join(tmpdir(), 'lsc-r7-'));
  try {
    const zero = path.join(dir, 'zero.json');
    writeFileSync(zero, JSON.stringify({ Results: [] }), 'utf8');
    const r = spawnSync('node', [GUARD, '--trivy', zero], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.notEqual(r.status, 0);

    // The remediation must name the layout that WORKS...
    assert.match(r.stderr, /requirements\/LOCKS\/<extra>\/requirements\.txt/);
    // ...and must not recommend the flat one. Strip the sentence that warns
    // AGAINST it before checking, or the warning itself would trip this.
    const withoutTheWarning = r.stderr.replace(/Do not "fix" this failure by flattening[\s\S]*?loses `dev`\./, '');
    assert.doesNotMatch(
      withoutTheWarning,
      /requirements\/<extra>\/requirements\.txt/,
      'the remediation points at the flat layout, which loses requirements/dev to Trivy\'s ' +
        'root-anchored skip list'
    );
    // And it must say WHY the extra level exists, or the next reader flattens it.
    assert.match(r.stderr, /ROOT-ANCHORED/);
    assert.match(r.stderr, /dev/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
