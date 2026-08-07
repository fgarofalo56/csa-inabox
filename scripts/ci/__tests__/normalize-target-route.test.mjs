/**
 * normalize-target-route self-test (FINISHLINE C13).
 *
 * THE DEFECT BEING GUARDED
 * ------------------------
 * loom-ui-verify receipts are dispatched from Git Bash on Windows:
 *
 *     gh workflow run loom-ui-verify.yml -f target_route=/admin/readiness
 *
 * MSYS POSIX path conversion rewrites any argument that looks like an absolute
 * POSIX path by PREPENDING the MSYS installation root, so the workflow input
 * actually received on run 31122589186 was:
 *
 *     C:/Program Files/Git/admin/migrate
 *
 * `new URL(route, baseUrl)` parsed `C:` as a URL SCHEME, discarded the base URL
 * entirely, and asked Chromium to navigate to
 * `c:/Program%20Files/Git/admin/migrate`. Chromium returned ERR_ABORTED, and the
 * receipt script's catch block printed:
 *
 *     This host cannot reach the live console. Likely causes:
 *       • P2S VPN not connected …
 *       • the console is private-link only and you are not in-VNet …
 *       • LOOM_URL is wrong …
 *
 * All three were FALSE — the `verify` and `publish-version` projects had passed
 * against that exact console seconds earlier in the same job. Asserting a cause
 * the code never established is a `deploy-integrity.md` R7 violation, and this
 * one blocked every V3 browser receipt in the program from 2026-08-04.
 *
 * WHAT THIS SUITE HAS TO PROVE, BEYOND "the repair works"
 * -------------------------------------------------------
 * Two properties, and the second is the one that matters:
 *
 *   1. The MSYS mangling is repaired deterministically, for the real observed
 *      inputs.
 *   2. The guard STILL FAILS CLOSED on input it cannot confidently repair. A
 *      normalizer that "fixes" everything would turn a garbage route into a
 *      plausible-looking one and produce a receipt for the WRONG SURFACE — a
 *      worse outcome than the red run it replaced. The `rejects` cases below are
 *      the teeth; deleting them would let the repair arm swallow anything.
 *
 * Both implementations are covered — the bash CI guard and the Node path used by
 * local runs — because they are the same rule in two places and drift between
 * them is exactly how `csa_loom_guard_adoption_gap` happens.
 *
 * Run: node --test scripts/ci/__tests__/normalize-target-route.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts', 'ci', 'normalize-target-route.sh');
const RECEIPT = resolve(REPO_ROOT, 'scripts', 'csa-loom', 'e2e-receipt.mjs');

/** Run the bash guard with RAW_ROUTE set; return { code, route, repaired, out }. */
function runGuard(raw) {
  const dir = mkdtempSync(join(tmpdir(), 'ntr-'));
  const ghOutput = join(dir, 'gh-output.txt');
  writeFileSync(ghOutput, '');
  let code = 0;
  let out = '';
  try {
    out = execFileSync('bash', [SCRIPT], {
      env: { ...process.env, RAW_ROUTE: raw, GITHUB_OUTPUT: ghOutput },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    code = err.status ?? 1;
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  const outputs = readFileSync(ghOutput, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  const route = /^route=(.*)$/m.exec(outputs)?.[1] ?? null;
  const repaired = /^repaired=(.*)$/m.exec(outputs)?.[1] ?? null;
  return { code, route, repaired, out };
}

// ---------------------------------------------------------------------------
// 1. The real observed corruption is repaired — bash guard.
// ---------------------------------------------------------------------------
test('repairs the exact MSYS mangling observed on run 31122589186', () => {
  const r = runGuard('C:/Program Files/Git/admin/migrate');
  assert.equal(r.code, 0);
  assert.equal(r.route, '/admin/migrate');
  assert.equal(r.repaired, 'true');
  // The warning must name the REAL cause, not the network.
  assert.match(r.out, /MSYS/i);
  assert.doesNotMatch(r.out, /VPN|private-link/i);
});

test('repairs the readiness route the FINISHLINE program dispatches', () => {
  const r = runGuard('C:/Program Files/Git/admin/readiness');
  assert.equal(r.code, 0);
  assert.equal(r.route, '/admin/readiness');
});

test('repairs mangling under the other Git-for-Windows roots', () => {
  for (const [raw, want] of [
    ['C:/Program Files/Git/usr/catalog', '/catalog'],
    ['C:/Program Files (x86)/Git/admin/gates', '/admin/gates'],
    ['D:/tools/Git/mingw64/browse', '/browse'],
    ['C:\\Program Files\\Git\\admin\\readiness', '/admin/readiness'],
  ]) {
    const r = runGuard(raw);
    assert.equal(r.code, 0, `expected repair for ${raw}, got exit ${r.code}`);
    assert.equal(r.route, want, `wrong repair for ${raw}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Correct input passes through untouched.
// ---------------------------------------------------------------------------
test('a well-formed site-relative route is passed through unchanged', () => {
  const r = runGuard('/admin/readiness');
  assert.equal(r.code, 0);
  assert.equal(r.route, '/admin/readiness');
  assert.equal(r.repaired, 'false');
});

test('a same-origin absolute URL is passed through unchanged', () => {
  const r = runGuard('https://csa-loom.limitlessdata.ai/catalog');
  assert.equal(r.code, 0);
  assert.equal(r.route, 'https://csa-loom.limitlessdata.ai/catalog');
  assert.equal(r.repaired, 'false');
});

test('a bare path gains its leading slash', () => {
  const r = runGuard('admin/readiness');
  assert.equal(r.code, 0);
  assert.equal(r.route, '/admin/readiness');
});

// ---------------------------------------------------------------------------
// 3. THE TEETH — it must still fail closed. A normalizer that repairs
//    everything is worse than the bug: it produces a receipt for the wrong
//    surface and calls it evidence.
// ---------------------------------------------------------------------------
test('REJECTS a Windows path with no identifiable MSYS root — never guesses', () => {
  const r = runGuard('C:/weird/path');
  assert.equal(r.code, 1, 'an unrecoverable Windows path MUST fail closed');
  assert.equal(r.route, null, 'a rejected route must emit NO route output');
  assert.match(r.out, /WINDOWS FILESYSTEM PATH/);
});

test('REJECTS an empty route', () => {
  const r = runGuard('');
  assert.equal(r.code, 1);
  assert.equal(r.route, null);
});

test('REJECTS a non-http scheme rather than navigating off-origin', () => {
  for (const raw of ['file:///etc/passwd', 'ftp://example.com/x']) {
    const r = runGuard(raw);
    assert.equal(r.code, 1, `${raw} must be rejected`);
    assert.equal(r.route, null);
  }
});

test('a rejection NEVER asserts an unmeasured cause (deploy-integrity R7)', () => {
  const r = runGuard('C:/weird/path');
  // It must say the console was not contacted, and must NOT blame the network.
  assert.match(r.out, /console was NOT contacted/i);
  assert.doesNotMatch(r.out, /VPN not connected|console is private-link only/i);
});

test('every rejection names the dispatch-side fix', () => {
  for (const raw of ['C:/weird/path', '', 'file:///etc/passwd']) {
    const r = runGuard(raw);
    assert.match(r.out, /MSYS_NO_PATHCONV=1/, `${raw} rejection must carry the remediation`);
  }
});

// ---------------------------------------------------------------------------
// 4. The Node implementation must agree with the bash one. Two copies of a rule
//    that disagree is `csa_loom_guard_adoption_gap` waiting to happen.
// ---------------------------------------------------------------------------
function runReceipt(route) {
  // spawnSync, not execFileSync: the repair notice is a console.warn (stderr),
  // and execFileSync discards stderr on the SUCCESS path — which would make this
  // test silently unable to see the very output it asserts on.
  const r = spawnSync(process.execPath, [RECEIPT, '--route', route, '--dry-run'], {
    env: {
      ...process.env,
      SESSION_SECRET: 'unit-test-secret-not-a-real-value',
      LOOM_URL: 'https://console.invalid',
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('e2e-receipt.mjs repairs the same MSYS mangling', () => {
  const r = runReceipt('C:/Program Files/Git/admin/readiness');
  assert.equal(r.code, 0);
  assert.match(r.out, /ROUTE REPAIRED/);
  assert.match(r.out, /"\/admin\/readiness"/);
});

test('e2e-receipt.mjs fails closed on an unrecoverable Windows path', () => {
  const r = runReceipt('C:/weird/path');
  assert.equal(r.code, 1, 'must exit non-zero rather than navigate to garbage');
  assert.match(r.out, /INVALID ROUTE/);
  assert.match(r.out, /console was NOT contacted/i);
});

// ---------------------------------------------------------------------------
// 5. The R7 fix in the navigation-failure classifier must not regress: the
//    blanket "VPN / private-link / LOOM_URL is wrong" triad is gone, and each
//    surviving diagnosis is scoped to an error it actually establishes.
// ---------------------------------------------------------------------------
test('the receipt script no longer blames the network for every nav failure', () => {
  const src = readFileSync(RECEIPT, 'utf8');
  // The old unconditional triad printed all three causes for ANY error.
  assert.doesNotMatch(
    src,
    /This host cannot reach the live console\. Likely causes:/,
    'the unconditional "likely causes" triad is the R7 defect — it must stay deleted',
  );
  // The replacement must distinguish causes and must admit ignorance.
  assert.match(src, /classifyNavFailure/, 'nav failures must be classified');
  assert.match(src, /NOT ESTABLISHED/, 'an unclassifiable error must say so');
  assert.match(src, /ERR_NAME_NOT_RESOLVED/, 'DNS failure must be distinguished');
  assert.match(src, /ERR_ABORTED/, 'an aborted navigation must be distinguished');
});

test('the receipt script refuses to navigate off the console origin', () => {
  const src = readFileSync(RECEIPT, 'utf8');
  assert.match(src, /ROUTE ESCAPED THE CONSOLE ORIGIN/);
});

test('a receipt of an HTTP error page is NOT recorded as passing', () => {
  // `status` was captured and never asserted on: a 404 or 500 still produced a
  // screenshot, a trace and "RECEIPT OK". Every A/A+ grade in the program rests
  // on this script, so a receipt that passes for a page the server said does not
  // exist is the `csa_loom_gates_that_cannot_fail` shape at its sharpest.
  const src = readFileSync(RECEIPT, 'utf8');
  assert.match(
    src,
    /if \(typeof status === 'number' && status >= 400\)/,
    'an HTTP >= 400 response must fail the receipt',
  );
  assert.match(src, /exitCode = 4/, 'the HTTP-error failure needs its own exit code');
  assert.match(src, /ESTABLISHED: the console answered/, 'and must not be reported as unreachable');
});

// ---------------------------------------------------------------------------
// 6. The workflow must actually USE the normalized route. A guard the pipeline
//    does not consume is the `csa_loom_gates_that_cannot_fail` shape.
// ---------------------------------------------------------------------------
test('loom-ui-verify.yml consumes the normalized route, not the raw input', () => {
  const wf = readFileSync(resolve(REPO_ROOT, '.github', 'workflows', 'loom-ui-verify.yml'), 'utf8');
  assert.match(wf, /normalize-target-route\.sh/, 'the guard must be invoked');
  assert.match(
    wf,
    /RECEIPT_ROUTE:\s*\$\{\{\s*steps\.route\.outputs\.route\s*\}\}/,
    'the receipt step must read the NORMALIZED route',
  );
  // The raw input must no longer be interpolated into the receipt command.
  const receiptBlock = wf.slice(wf.indexOf('Capture browser-E2E receipt'));
  assert.doesNotMatch(
    receiptBlock.slice(0, 2000),
    /--route "\$\{\{ inputs\.target_route \}\}"/,
    'the raw, un-normalized input must not reach e2e-receipt.mjs',
  );
});

test('loom-ui-verify.yml bounds the QUEUE wait, not just the run time', () => {
  const wf = readFileSync(resolve(REPO_ROOT, '.github', 'workflows', 'loom-ui-verify.yml'), 'utf8');
  assert.match(wf, /queue-watchdog:/, 'a queued-forever job must be bounded');
  assert.match(wf, /MAX_QUEUE_MINUTES/);
  // It must FAIL, not warn — run 31123017609 sat 79 minutes and only ended
  // because a human cancelled it, producing no verdict at all.
  assert.match(wf, /::error::verify job STILL QUEUED/);
});
