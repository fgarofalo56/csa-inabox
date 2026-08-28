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
  classifyInstallFailure,
  installWithRetry,
  INSTALL_ATTEMPTS,
} = await import('../check-standalone-vitest-suites.mjs');

/** The verbatim npm output from #4032, minus the redacted host. */
const ECONNRESET_OUTPUT = [
  'npm error code ECONNRESET',
  'npm error syscall read',
  'npm error errno ECONNRESET',
  'npm error network request to https://blob-host.vsblob.vsassets.io/x/default-browser-5.5.0.tgz failed, reason: read ECONNRESET',
  'npm error network This is a problem related to network connectivity.',
].join('\n');

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

// ---------------------------------------------------------------------------
// #4032 — a transient network failure must be RETRIED (bounded) and must not be
// reported as a broken package.
//
// The pre-fix code ran `npm ci` exactly once and printed
//   FAIL: azure-functions/copilot-evaluator `npm ci` exited 1.
// with npm's own `code ECONNRESET` in the stream it had just printed. Both
// halves are asserted below: the CLASSIFICATION (so the verdict is true, R7)
// and the BOUNDED retry that fails closed on exhaustion (R6).
// ---------------------------------------------------------------------------

test('classifyInstallFailure calls the real #4032 ECONNRESET output transient', () => {
  const c = classifyInstallFailure(ECONNRESET_OUTPUT);
  assert.equal(c.transient, true, 'a CDN socket reset is the textbook transient');
  assert.ok(c.codes.includes('ECONNRESET'), `codes were ${JSON.stringify(c.codes)}`);
  // R7: the verdict must point the reader at the network, not at the package.
  assert.match(c.reason, /NETWORK/i);
  assert.match(c.reason, /not a defect in the package/i);
});

test('classifyInstallFailure accepts every network-transient class and the legacy npm ERR! spelling', () => {
  for (const code of ['ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'E429', 'E503']) {
    assert.equal(
      classifyInstallFailure(`npm error code ${code}\nnpm error network ...`).transient,
      true,
      `${code} should be transient`,
    );
  }
  // npm < 10 printed `npm ERR!`; a guard that only knows the new spelling would
  // silently stop retrying the day a runner image pinned an older npm.
  assert.equal(classifyInstallFailure('npm ERR! code ECONNRESET').transient, true);
  // ANSI-wrapped output must classify identically.
  assert.equal(classifyInstallFailure('[31mnpm error code ECONNRESET[0m').transient, true);
});

test('classifyInstallFailure does NOT retry reproducible failures', () => {
  for (const code of ['E404', 'EUSAGE', 'ERESOLVE', 'ETARGET', 'ELIFECYCLE', 'EINTEGRITY']) {
    const c = classifyInstallFailure(`npm error code ${code}\nnpm error something reproducible`);
    assert.equal(c.transient, false, `${code} must not be retried`);
    assert.match(c.reason, /NOT a network-transient class/);
  }
});

test('a BARE "ECONNRESET" substring outside a code line buys nothing', () => {
  // THE narrow bypass. An implementation that greps the whole blob for the word
  // would hand three retries and a "this was the network" verdict to a package
  // whose own output merely mentions the string — and to a genuinely broken
  // install that happens to quote it.
  const prose = [
    '> copilot-evaluator@1.0.0 preinstall',
    '  ✓ reconnects after ECONNRESET (3 ms)',
    'npm error Exit handler never called!',
  ].join('\n');
  const c = classifyInstallFailure(prose);
  assert.equal(c.transient, false, 'a bare substring is not a code line');
  assert.match(c.reason, /UNKNOWN/);
  assert.match(c.reason, /refusing to guess/i);

  // Same word, this time next to a REPRODUCIBLE code — still not transient.
  const mixedProse = `npm error code ELIFECYCLE\n  ✓ handles ECONNRESET (1 ms)`;
  assert.equal(classifyInstallFailure(mixedProse).transient, false);
});

test('mixed transient + non-transient codes classify NON-transient (fail closed)', () => {
  const c = classifyInstallFailure(`${ECONNRESET_OUTPUT}\nnpm error code E404\n`);
  assert.equal(c.transient, false, 'something reproducible also went wrong — do not retry');
  assert.match(c.reason, /E404/);
});

test('an unclassifiable failure is not retried and does not claim a cause', () => {
  for (const blob of ['', '   ', undefined, null, 'Killed\n', 'npm error errno -4077\n']) {
    const c = classifyInstallFailure(blob);
    assert.equal(c.transient, false, `${JSON.stringify(blob)} must not be called transient`);
    assert.match(c.reason, /UNKNOWN/);
    // R7: it must not assert a cause it did not establish.
    assert.doesNotMatch(c.reason, /NETWORK\/registry transient/);
  }
});

function fakeRun(sequence) {
  const calls = [];
  return {
    calls,
    run(attempt) {
      calls.push(attempt);
      const step = sequence[Math.min(attempt - 1, sequence.length - 1)];
      return step;
    },
  };
}

const RESET = { status: 1, stdout: '', stderr: ECONNRESET_OUTPUT };
const OK = { status: 0, stdout: 'added 98 packages\n', stderr: '' };
const E404 = { status: 1, stdout: '', stderr: 'npm error code E404\nnpm error 404 Not Found' };

test('installWithRetry recovers from a transient and reports the attempt it took', () => {
  const f = fakeRun([RESET, RESET, OK]);
  const slept = [];
  const r = installWithRetry({
    run: f.run,
    backoffMs: [1, 2],
    sleep: (ms) => slept.push(ms),
    onNotice: () => {},
  });
  assert.equal(r.ok, true, 'two resets then a success must be a success');
  assert.equal(r.attempts, 3);
  assert.deepEqual(f.calls, [1, 2, 3], 'exactly one install per attempt');
  assert.deepEqual(slept, [1, 2], 'it backs off between attempts, and only between them');
});

test('installWithRetry is BOUNDED and FAILS CLOSED when the transient never clears', () => {
  const f = fakeRun([RESET]);
  const r = installWithRetry({
    run: f.run,
    backoffMs: [0, 0],
    sleep: () => {},
    onNotice: () => {},
  });
  assert.equal(r.ok, false, 'a retry that cannot fail is forbidden (R6)');
  assert.equal(r.exhausted, true);
  assert.equal(r.attempts, INSTALL_ATTEMPTS);
  assert.equal(
    f.calls.length,
    INSTALL_ATTEMPTS,
    `the loop must stop at exactly ${INSTALL_ATTEMPTS} attempts, not keep going`,
  );
  assert.equal(r.classification.transient, true, 'and it still names the network as the cause');
});

test('installWithRetry does NOT retry a reproducible failure', () => {
  const f = fakeRun([E404]);
  let notices = 0;
  const r = installWithRetry({
    run: f.run,
    backoffMs: [0, 0],
    sleep: () => {
      throw new Error('a non-transient failure must not sleep — it must fail immediately');
    },
    onNotice: () => {
      notices += 1;
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.exhausted, false, 'it failed on classification, not on exhaustion');
  assert.deepEqual(f.calls, [1], 'exactly one attempt — CI time is not spent on a certain failure');
  assert.equal(notices, 0);
});

test('installWithRetry refuses to construct an unbounded or zero-attempt loop', () => {
  for (const attempts of [0, -1, Number.POSITIVE_INFINITY, 2.5, NaN]) {
    assert.throws(
      () => installWithRetry({ run: () => OK, attempts }),
      /positive integer/,
      `attempts=${attempts} must be refused`,
    );
  }
});

test('a spawn failure (npm not on PATH) fails immediately and says so', () => {
  const f = fakeRun([{ status: null, stdout: '', stderr: '', error: new Error('spawnSync npm ENOENT') }]);
  const r = installWithRetry({ run: f.run, backoffMs: [0, 0], sleep: () => {}, onNotice: () => {} });
  assert.equal(r.ok, false);
  assert.deepEqual(f.calls, [1], 'an unclassifiable spawn failure is not retried');
  assert.equal(r.classification.transient, false);
});

test('the retry wraps the INSTALL only — a retried test would mask a flaky test', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(
    src,
    /installWithRetry\(\{[\s\S]{0,400}runCaptured\('npm', installArgs/,
    'the retried command must be the install',
  );
  assert.doesNotMatch(
    src,
    /installWithRetry\(\{[\s\S]{0,400}\['test'/,
    'the vitest run must stay single-shot',
  );
  assert.match(
    src,
    /const test = runCaptured\('npm', \['test'/,
    'the test step is invoked directly, outside any retry',
  );
});

// ---------------------------------------------------------------------------
// End-to-end, over the REAL script and the REAL package tree, with a fake npm
// on PATH. No network, no node_modules touched. This is what actually catches a
// regression in the wiring — the helper tests above cannot see main().
// ---------------------------------------------------------------------------

const FAKE_NPM_IMPL = `
import fs from 'node:fs';
const log = process.env.FAKE_NPM_LOG;
const args = process.argv.slice(2);
const key = process.cwd() + '::' + args[0];
const stateFile = log + '.state.json';
let state = {};
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = {}; }
state[key] = (state[key] || 0) + 1;
fs.writeFileSync(stateFile, JSON.stringify(state));
fs.appendFileSync(log, key + '\\tattempt=' + state[key] + '\\n');
const failsRaw = process.env.FAKE_NPM_FAILS || 'always';
const fails = failsRaw === 'always' ? Number.POSITIVE_INFINITY : Number(failsRaw);
const code = process.env.FAKE_NPM_CODE || 'ECONNRESET';
if (args[0] === 'ci' || args[0] === 'install') {
  if (state[key] <= fails) {
    process.stderr.write('npm error code ' + code + '\\nnpm error network request failed, reason: read ' + code + '\\n');
    process.exit(1);
  }
  process.stdout.write('added 98 packages\\n');
  process.exit(0);
}
if (args[0] === 'test') { process.stdout.write('      Tests  74 passed (74)\\n'); process.exit(0); }
process.stderr.write('fake-npm: unhandled ' + args.join(' ') + '\\n');
process.exit(9);
`;

/** Materialise a fake npm shim and return its directory. */
function makeFakeNpm(dir) {
  const impl = path.join(dir, 'npm-impl.mjs');
  fs.writeFileSync(impl, FAKE_NPM_IMPL);
  // Windows: spawnSync runs with shell:true, so cmd.exe resolves npm.cmd.
  fs.writeFileSync(path.join(dir, 'npm.cmd'), `@echo off\r\nnode "%~dp0npm-impl.mjs" %*\r\n`);
  // POSIX: shell:false, so an executable file literally named `npm` is needed.
  const sh = path.join(dir, 'npm');
  fs.writeFileSync(sh, `#!/bin/sh\nexec node "$(dirname "$0")/npm-impl.mjs" "$@"\n`);
  fs.chmodSync(sh, 0o755);
  return dir;
}

/** Prepend `dir` to PATH, overwriting the EXISTING key so Windows' `Path` casing does not shadow it. */
function envWithPath(dir, extra) {
  const env = { ...process.env, ...extra };
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  env[key] = dir + path.delimiter + (env[key] || '');
  return env;
}

function runWithFakeNpm(extraEnv) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svs-e2e-'));
  const log = path.join(tmp, 'calls.log');
  fs.writeFileSync(log, '');
  makeFakeNpm(tmp);
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: envWithPath(tmp, {
      FAKE_NPM_LOG: log,
      // The test hook: exercise the REAL retry path without eight seconds of sleep.
      LOOM_INSTALL_RETRY_BACKOFF_MS: '0',
      ...extraEnv,
    }),
  });
  const calls = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { ...r, calls };
}

test('E2E: one ECONNRESET then success — the whole step PASSES on the retry', () => {
  const r = runWithFakeNpm({ FAKE_NPM_FAILS: '1' });
  assert.equal(
    r.status,
    0,
    `pre-fix this exited 1 on the first reset. got:\n${r.stdout}\n${r.stderr}`,
  );
  const perPackage = new Map();
  for (const line of r.calls) {
    const [key, att] = line.split('\t');
    if (key.endsWith('::ci') || key.endsWith('::install')) {
      perPackage.set(key, Math.max(perPackage.get(key) || 0, Number(att.split('=')[1])));
    }
  }
  assert.ok(perPackage.size > 0, 'the fake npm was never invoked — the PATH shim did not take');
  for (const [key, attempts] of perPackage) {
    assert.equal(attempts, 2, `${key} should have installed on attempt 2, got ${attempts}`);
  }
  assert.match(r.stderr, /RETRY: install attempt 1\/3 failed transiently/);
});

test('E2E: an unclearing ECONNRESET fails CLOSED after exactly 3 attempts, blaming the network', () => {
  const r = runWithFakeNpm({ FAKE_NPM_FAILS: 'always' });
  assert.equal(r.status, 1, 'exhaustion must fail — a retry that cannot fail is forbidden');
  const attempts = r.calls
    .filter((l) => /::(ci|install)\t/.test(l))
    .map((l) => Number(l.split('\t')[1].split('=')[1]));
  assert.equal(Math.max(...attempts), INSTALL_ATTEMPTS, 'bounded at exactly 3 attempts');
  // R7: the verdict names the network, not the package.
  assert.match(r.stderr, /NETWORK\/registry transient, not a defect in the package/);
  assert.match(r.stderr, /Bounded retry EXHAUSTED after 3 attempt\(s\)/);
  assert.doesNotMatch(
    r.stderr,
    /`npm ci` exited 1\.\s*$/m,
    'the bare pre-fix message, which blamed the package, must be gone',
  );
});

test('E2E: a reproducible install failure still fails on the FIRST attempt', () => {
  const r = runWithFakeNpm({ FAKE_NPM_FAILS: 'always', FAKE_NPM_CODE: 'E404' });
  assert.equal(r.status, 1);
  const attempts = r.calls
    .filter((l) => /::(ci|install)\t/.test(l))
    .map((l) => Number(l.split('\t')[1].split('=')[1]));
  assert.equal(Math.max(...attempts), 1, 'E404 must not buy three attempts');
  assert.match(r.stderr, /NOT a network-transient class/);
  assert.match(r.stderr, /was not retried/);
});

