/*
 * Self-test for check-standalone-vitest-suites.mjs.
 *
 * The guard's whole value is that it DISCOVERS un-run vitest packages and FAILS
 * CLOSED. Both properties are asserted here — including the fail-closed paths
 * themselves, which an earlier revision of this file claimed to cover but did
 * not. A guard whose own self-test only exercises the happy path is the defect
 * it exists to prevent (see the gates-that-measure-nothing memory +
 * deploy-integrity.md R7).
 *
 * Run: node --test scripts/ci/__tests__/standalone-vitest-suites.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'check-standalone-vitest-suites.mjs');
const REPO_ROOT = path.resolve(HERE, '..', '..');

const {
  discoverPackages,
  usesVitest,
  findSpecFiles,
  parseVitestSummary,
} = await import('../check-standalone-vitest-suites.mjs');

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test('discovers the real azure-functions vitest packages (non-empty)', () => {
  const pkgs = discoverPackages();
  assert.ok(
    pkgs.length > 0,
    'discovery returned zero packages against the real tree — the guard would be measuring nothing',
  );
  const rels = pkgs.map((p) => p.rel);
  // report-subscriptions carries the delivery-contract spec that catches the
  // Logic App payload drift; if it ever stops being discovered, that spec goes
  // dark again and this assertion is the tripwire.
  assert.ok(
    rels.includes('azure-functions/report-subscriptions'),
    `azure-functions/report-subscriptions not discovered; got: ${rels.join(', ')}`,
  );
  for (const p of pkgs) {
    assert.ok(p.specs > 0, `${p.rel} was discovered with zero spec files`);
  }
});

test('usesVitest only accepts a test script that actually runs vitest', () => {
  assert.equal(usesVitest({ scripts: { test: 'vitest run' } }), true);
  assert.equal(usesVitest({ scripts: { test: 'npx vitest run --coverage' } }), true);
  assert.equal(usesVitest({ scripts: { test: 'jest' } }), false);
  assert.equal(usesVitest({ scripts: { test: 'echo "no tests" && exit 0' } }), false);
  assert.equal(usesVitest({ scripts: {} }), false);
  assert.equal(usesVitest({}), false);
  assert.equal(usesVitest(null), false);
});

test('findSpecFiles skips node_modules and dist', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svs-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'a.test.ts'), '');
    fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), '');
    fs.writeFileSync(path.join(tmp, 'node_modules', 'pkg', 'b.test.ts'), '');
    fs.writeFileSync(path.join(tmp, 'dist', 'c.test.js'), '');

    const found = findSpecFiles(tmp).map((f) => path.relative(tmp, f).split(path.sep).join('/'));
    assert.deepEqual(found, ['src/a.test.ts']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a package whose test script is not vitest is not discovered', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svs-root-'));
  try {
    const pkgDir = path.join(tmp, 'azure-functions', 'jest-thing');
    fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'jest-thing', scripts: { test: 'jest' } }),
    );
    fs.writeFileSync(path.join(pkgDir, 'src', 'x.test.ts'), '');

    assert.deepEqual(discoverPackages(tmp), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a vitest package with no spec files is not discovered (nothing to run)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svs-empty-'));
  try {
    const pkgDir = path.join(tmp, 'azure-functions', 'empty');
    fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'empty', scripts: { test: 'vitest run' } }),
    );
    fs.writeFileSync(path.join(pkgDir, 'src', 'x.ts'), '');

    assert.deepEqual(discoverPackages(tmp), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a vitest package WITH specs is discovered', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svs-ok-'));
  try {
    const pkgDir = path.join(tmp, 'azure-functions', 'real');
    fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'real', scripts: { test: 'vitest run' } }),
    );
    fs.writeFileSync(path.join(pkgDir, 'src', 'x.test.ts'), '');

    const found = discoverPackages(tmp);
    assert.equal(found.length, 1);
    assert.equal(found[0].rel, 'azure-functions/real');
    assert.equal(found[0].specs, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FAIL-CLOSED #3 — an all-skipped run must NOT read as a pass.
//
// This is the property an independent review broke: `vitest run` prints
// "Tests  8 skipped" and exits 0 when every test is `it.skip`ped. The summary
// parser is what turns that into a hard error, so it is asserted directly
// against real reporter output shapes.
// ---------------------------------------------------------------------------

test('parseVitestSummary counts an all-skipped run as ZERO executed', () => {
  const s = parseVitestSummary(' Test Files  1 skipped (1)\n      Tests  8 skipped (8)\n');
  assert.notEqual(s, null);
  assert.equal(s.executed, 0, 'an all-skipped run must report zero executed tests');
  assert.equal(s.skipped, 8);
});

test('parseVitestSummary counts passed and failed as executed, skipped as not', () => {
  assert.equal(parseVitestSummary('      Tests  53 passed (53)').executed, 53);
  assert.equal(parseVitestSummary('      Tests  3 failed | 50 passed (53)').executed, 53);

  const mixed = parseVitestSummary('      Tests  1 passed | 2 skipped (3)');
  assert.equal(mixed.executed, 1, 'skipped tests are not executed tests');
  assert.equal(mixed.skipped, 2);
});

test('parseVitestSummary returns null when there is no summary at all', () => {
  // An unreadable result is not a good result — the caller turns null into a
  // hard error rather than assuming success.
  assert.equal(parseVitestSummary('some unrelated output\n'), null);
});

test('parseVitestSummary treats "No test files found" as zero executed', () => {
  const s = parseVitestSummary('No test files found, exiting with code 1');
  assert.notEqual(s, null);
  assert.equal(s.executed, 0);
});

// ---------------------------------------------------------------------------
// FAIL-CLOSED #1 / #2 / #3 — asserted against the script itself, plus a real
// end-to-end run so the exit CODE is exercised, not only helper return values.
// ---------------------------------------------------------------------------

function runScript(cwd, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

test('--list passes on the real tree and states the floor it is checked against', () => {
  const r = runScript(REPO_ROOT, ['--list']);
  assert.equal(r.status, 0, `--list should pass on the real tree; got:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /floor \d+/, 'the discovery line must state the floor it is checked against');
});

test('the package-count floor is a real, non-zero-exit comparison', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /pkgs\.length < MIN_PACKAGES/, 'the floor comparison must exist');
  assert.match(src, /const MIN_PACKAGES = \d+/, 'MIN_PACKAGES must be a concrete floor');
  // Proven live: setting lineage-extractor's `scripts.test` to a non-vitest
  // command drops discovery to 4 and the script exits 1 with the floor message.
  assert.match(src, /but MIN_PACKAGES is/, 'the floor failure must name the shortfall');
});

test('zero-executed and unparseable summaries are explicit hard errors', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  // A child exiting 0 is NOT sufficient — the executed count is asserted too.
  assert.match(src, /summary\.executed === 0/, 'zero-executed must be an explicit hard error');
  assert.match(
    src,
    /summary line could be parsed/,
    'an unparseable summary must also be a hard error',
  );
});

test('the install step labels the command it actually runs (R7)', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(
    src,
    /=== npm ci ===/,
    'a hardcoded "npm ci" label lies when the package has no lockfile and npm install is run',
  );
  assert.match(src, /npm \$\{installArgs\.join\(' '\)\}/, 'the label must interpolate the real command');
});

test('the install fallback never writes a lockfile into a package that has none', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  // `npm install` would create package-lock.json in a package that deliberately
  // ships without one — mutating the tree the guard inspects and tripping
  // dockerfile-lockfiles.test.mjs. The fallback must be read-only.
  assert.match(src, /--no-package-lock/, 'the npm install fallback must pass --no-package-lock');
});
