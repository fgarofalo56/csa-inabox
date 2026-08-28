#!/usr/bin/env node
/*
 * check-standalone-vitest-suites.mjs — run EVERY vitest suite that lives in a
 * standalone package no other CI lane covers.
 *
 * WHY THIS EXISTS
 *
 *   `check-node-test-suites.mjs` generalized the same problem for `node:test`
 *   and stated the rule this script inherits verbatim:
 *
 *     "A test nobody runs is the same class of defect as a gate that measures
 *      nothing — it reads as coverage and enforces nothing."
 *
 *   It closed the class for `node:test` only. The vitest half stayed open. At
 *   this script's merge-base EVERY suite under azure-functions/ was dark —
 *   five packages, FIVE spec files, 121 assertions — because each package
 *   carries its own package.json + vitest and nothing in .github/workflows ever
 *   ran them:
 *
 *     $ grep -rn "copilot-evaluator|secret-expiry-monitor|lineage-extractor|
 *                 ops-agent-evaluator|report-subscriptions" .github/workflows
 *                 | grep -i "vitest|npm test"
 *     (no output)
 *
 *   (The three further spec files that arrive alongside this guard bring the
 *   total to eight / 174. They were equally dark in their previous home; the
 *   121 above is the honest merge-base count, not the post-fix one.)
 *
 *   The console's own vitest cannot pick them up: its `include` is scoped to
 *   apps/fiab-console/{lib,app,__tests__}, and these packages resolve their
 *   dependencies from their OWN node_modules.
 *
 *   The concrete case that prompted this: the report-subscriptions Function's
 *   delivery payload had drifted from the Logic App trigger schema it POSTs to
 *   (it sent `contentBytes`/`fileName`, which the workflow does not read).
 *   That code has never executed on the estate, so the drift harmed nothing —
 *   but nothing in CI could have told us either way, and the contract spec that
 *   now catches it is worth nothing unless something runs it.
 *
 * DISCOVERY, NOT A HAND-LIST
 *
 *   A package qualifies when it has a package.json whose `scripts.test`
 *   invokes vitest AND it contains at least one `*.test.ts`/`*.test.js` file.
 *   Any package added later is picked up the day it lands, with nothing to keep
 *   in sync and nothing to forget.
 *
 * FAILING CLOSED (this guard must not become the thing it guards against)
 *
 *   1. Discovery matching ZERO packages is a hard error — a renamed tree or a
 *      bad root must not read as "all green".
 *   2. Discovery finding FEWER than MIN_PACKAGES is a hard error. A package
 *      drops out silently if its `scripts.test` stops invoking vitest or its
 *      specs are renamed; without a floor, 5 could quietly become 1 and still
 *      report green. Raising MIN_PACKAGES when a package lands is deliberate.
 *   3. A package whose run EXECUTES zero tests is a hard error. `vitest run`
 *      exits 0 when every test is `it.skip`ped — it prints "Tests  2 skipped"
 *      and returns 0, which reads as a pass while measuring nothing. So the
 *      executed count (passed + failed; skipped is NOT executed) is PARSED from
 *      the reporter summary and asserted. A summary that cannot be parsed is
 *      also a hard error — an unreadable result is not a good result.
 *   4. Child exit statuses are propagated. Nothing is wrapped in `|| true`,
 *      no stream is sent to /dev/null, and no failure is downgraded to a
 *      warning (.claude/rules/deploy-integrity.md R7 / the
 *      gates-that-cannot-fail memory).
 *   5. The install retry is BOUNDED and FAILS CLOSED. See below — a retry that
 *      cannot fail is forbidden (deploy-integrity.md R6), so the attempt count
 *      is a module constant, is asserted to be a positive integer, and
 *      exhaustion returns a FAILURE, never a pass.
 *
 *   Every log line names the command actually run (R7): the install step prints
 *   `npm ci` or `npm install` according to which one it invokes, never a fixed
 *   label that could describe the other.
 *
 * TRANSIENT INSTALL FAILURES (#4032)
 *
 *   On 2026-08-26 this step reddened `Loom Guardrails` on a PR whose diff
 *   contained ZERO files under azure-functions/. It failed at install, before a
 *   single test ran, on one socket reset reading a CDN blob:
 *
 *     npm error code ECONNRESET
 *     npm error network request to https://<host>/default-browser-5.5.0.tgz
 *       failed, reason: read ECONNRESET
 *     FAIL: azure-functions/copilot-evaluator `npm ci` exited 1.
 *
 *   Measured: 1 occurrence in 120 guardrails runs (~0.8%), the other four
 *   packages installed and passed in the SAME run, and the package reproduced
 *   healthy at that exact SHA (`npm ci` RC=0, 74/74 tests pass). So it was the
 *   network, and the verdict said the package.
 *
 *   That is BOTH halves of deploy-integrity.md wrong at once:
 *     R6 — "Retry what is genuinely transient, with bounded backoff, and fail
 *          closed on exhaustion." There was no retry at all.
 *     R7 — "Error messages must be TRUE." "`npm ci` exited 1" states a package
 *          failure; the code had npm's own `code ECONNRESET` in the stream it
 *          had just printed and never read it.
 *
 *   So the install is now CAPTURED rather than inherited (both streams are
 *   still written out verbatim — nothing is discarded, FAILING CLOSED #4 holds),
 *   its failure is CLASSIFIED from npm's own `npm error code <CODE>` line, and
 *   only the network/registry-transient classes are retried. Everything else
 *   fails on the first attempt exactly as before.
 *
 *   The classifier is anchored to the `npm error code|errno <CODE>` LINE SHAPE,
 *   never to a bare substring: a suite whose own output merely mentions the word
 *   ECONNRESET must not buy itself three retries and a "this was the network"
 *   verdict (`a_bare_substring_signal_misclassifies_and_blocks`). Mixed output
 *   carrying a transient code AND a non-transient one is treated as
 *   NON-transient — the fail-closed direction.
 *
 *   The TEST step is deliberately NOT retried. A retried test masks a flaky
 *   test, which is the same class of defect as a gate that measures nothing.
 *
 * USAGE
 *   node scripts/ci/check-standalone-vitest-suites.mjs          # discover + run
 *   node scripts/ci/check-standalone-vitest-suites.mjs --list   # discover only
 *
 * Tests: node --test scripts/ci/__tests__/standalone-vitest-suites.test.mjs
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Roots scanned for standalone packages (one level deep). */
const SCAN_ROOTS = ['azure-functions'];

/**
 * Floor on discovered packages. RATCHET — only ever goes UP, and only when a
 * package genuinely lands. See FAILING CLOSED #2.
 *
 * 5 as of 2026-08-07: copilot-evaluator, lineage-extractor, ops-agent-evaluator,
 * report-subscriptions, secret-expiry-monitor.
 */
const MIN_PACKAGES = 5;

/** Directory names never descended into when looking for spec files. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'coverage', '.git']);

/** True when a package.json `scripts.test` actually invokes vitest. */
export function usesVitest(pkgJson) {
  const t = pkgJson?.scripts?.test;
  return typeof t === 'string' && /\bvitest\b/.test(t);
}

/** Recursively collect *.test.ts / *.test.js under `dir`. */
export function findSpecFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      findSpecFiles(path.join(dir, e.name), out);
    } else if (/\.test\.(ts|tsx|js|mjs)$/.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/** Discover every standalone vitest package under SCAN_ROOTS. */
export function discoverPackages(repoRoot = REPO_ROOT) {
  const found = [];
  for (const root of SCAN_ROOTS) {
    const abs = path.join(repoRoot, root);
    let dirs;
    try {
      dirs = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!d.isDirectory() || SKIP_DIRS.has(d.name)) continue;
      const pkgDir = path.join(abs, d.name);
      const pkgPath = path.join(pkgDir, 'package.json');
      if (!fs.existsSync(pkgPath)) continue;
      let pkg;
      try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      } catch (e) {
        throw new Error(`${path.relative(repoRoot, pkgPath)} is not valid JSON: ${e.message}`);
      }
      if (!usesVitest(pkg)) continue;
      const specs = findSpecFiles(pkgDir);
      if (specs.length === 0) continue;
      found.push({
        dir: pkgDir,
        rel: path.relative(repoRoot, pkgDir).split(path.sep).join('/'),
        specs: specs.length,
      });
    }
  }
  return found.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Strip SGR colour sequences.
 *
 * The ESC byte is PART of the sequence and must be consumed with it. A pattern
 * of `/\[[0-9;]*m/` alone leaves a bare 0x1B glued to the next character, which
 * then defeats every `^\s*<word>` anchor downstream — the line is present and
 * the matcher cannot see it. Written as the escape \u001B rather than a
 * literal ESC byte so the intent survives a copy/paste. ESC is optional so a
 * log that has already lost it still cleans up.
 */
function stripAnsi(s) {
  return String(s ?? '').replace(/\u001B?\[[0-9;]*m/g, '');
}

/**
 * Parse vitest's `Tests` summary line into executed/skipped counts.
 *
 * Recognised shapes (ANSI is stripped first, by stripAnsi above):
 *   "Tests  53 passed (53)"
 *   "Tests  3 failed | 50 passed (53)"
 *   "Tests  2 skipped (2)"
 *   "Tests  1 passed | 2 skipped (3)"
 *   "No test files found"           → executed 0
 *
 * Returns null when no summary line is present at all — the caller treats that
 * as a hard error rather than assuming success.
 */
export function parseVitestSummary(output) {
  const clean = stripAnsi(output);
  if (/No test files found/i.test(clean)) return { passed: 0, failed: 0, skipped: 0, executed: 0 };
  // PHYSICAL-LINES-OK: parses vitest's own OUTPUT (`Tests 12 passed`), not a
  // shell body. Program output has no backslash continuations (#3420).
  const line = clean.split(/\r?\n/).reverse().find((l) => /^\s*Tests\s+\d/.test(l));
  if (!line) return null;
  const num = (re) => {
    const m = re.exec(line);
    return m ? Number(m[1]) : 0;
  };
  const passed = num(/(\d+)\s+passed/);
  const failed = num(/(\d+)\s+failed/);
  const skipped = num(/(\d+)\s+skipped/);
  // "Executed" deliberately excludes skipped: an all-skipped run measures nothing.
  return { passed, failed, skipped, executed: passed + failed };
}

/**
 * npm error codes naming a genuinely TRANSIENT network or registry condition —
 * the only classes this guard retries.
 *
 * Socket/DNS/route level: the connection to the registry or its CDN did not
 * survive. Registry level: 429 (rate limit) and 5xx are the registry telling us
 * to come back. Nothing here can be caused by the package's own contents, which
 * is exactly the property that makes a retry legitimate rather than a mask.
 *
 * Deliberately ABSENT: EUSAGE, ERESOLVE, ETARGET, E404, ELIFECYCLE, EJSONPARSE,
 * ENOLOCK, EINTEGRITY — every one of those is reproducible and a retry would
 * only spend CI time before failing anyway. EPIPE is absent too: it is as often
 * a local stream break as a network one, and an ambiguous signal must not buy a
 * retry.
 */
export const TRANSIENT_NPM_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ERR_SOCKET_TIMEOUT',
  'E429',
  'E500',
  'E502',
  'E503',
  'E504',
]);

/**
 * The ONLY shape a code is read from. Anchored to npm's own
 * `npm error code <CODE>` / `npm error errno <CODE>` line (and the pre-npm-10
 * `npm ERR!` spelling) — never a bare substring anywhere in the output.
 *
 * A numeric errno (`npm error errno -4077`) is intentionally not matched: it
 * carries no class information npm has not already given us on the `code` line,
 * and admitting it would let a bare `1` register as an unknown "code" and poison
 * an otherwise-clean transient classification.
 */
const NPM_CODE_LINE = /^\s*npm (?:error|ERR!)\s+(?:code|errno)\s+([A-Za-z][A-Za-z0-9_]*)\s*$/;

/**
 * Classify an npm install failure from npm's own output.
 *
 * Returns `{ transient, codes, reason }`. `transient` is true ONLY when at
 * least one code line was found AND every code found is in
 * TRANSIENT_NPM_CODES. Three fail-closed properties, in order:
 *
 *   - No code line at all  → NOT transient. The class is unknown, and an
 *     unclassified failure is not retried (R7: the message says "unknown",
 *     it does not guess "network").
 *   - Any non-transient code present → NOT transient, even alongside a
 *     transient one. Mixed output means something reproducible also went wrong.
 *   - The word ECONNRESET appearing in prose, a package name, or a test title
 *     is NOT a code line and buys nothing.
 */
export function classifyInstallFailure(output) {
  const clean = stripAnsi(output ?? '');
  const codes = [];
  // PHYSICAL-LINES-OK: parses npm's own OUTPUT (`npm error code ECONNRESET`),
  // not a shell body. Program output has no backslash continuations (#3420).
  for (const line of clean.split(/\r?\n/)) {
    const m = NPM_CODE_LINE.exec(line);
    if (m) codes.push(m[1].toUpperCase());
  }
  const found = [...new Set(codes)];

  if (found.length === 0) {
    return {
      transient: false,
      codes: found,
      reason:
        'npm printed no `npm error code <CODE>` line, so the failure class is UNKNOWN — ' +
        'refusing to guess "network" and refusing to retry an unclassified failure.',
    };
  }

  const nonTransient = found.filter((c) => !TRANSIENT_NPM_CODES.has(c));
  if (nonTransient.length > 0) {
    return {
      transient: false,
      codes: found,
      reason:
        `npm reported ${nonTransient.join(', ')}, which is NOT a network-transient class ` +
        '(it is reproducible), so this failed on the first attempt without retrying.',
    };
  }

  return {
    transient: true,
    codes: found,
    reason: `npm reported ${found.join(', ')} — a NETWORK/registry transient, not a defect in the package.`,
  };
}

/**
 * Attempt count for a transient install failure. A MODULE CONSTANT, not an
 * input: deploy-integrity.md R6 forbids a retry that cannot fail, so the bound
 * must not be widenable — or disable-able — from the environment.
 */
export const INSTALL_ATTEMPTS = 3;

/**
 * Backoff between attempts, in ms, indexed by (attempt - 1); the last entry is
 * reused if attempts ever exceeds its length.
 *
 * `LOOM_INSTALL_RETRY_BACKOFF_MS` is a TEST HOOK so the self-test can exercise
 * the real retry path in milliseconds instead of eight seconds. It changes only
 * how long we WAIT — never how many attempts happen and never whether
 * exhaustion fails, which are the properties that make this fail closed.
 */
const backoffOverride = Number(process.env.LOOM_INSTALL_RETRY_BACKOFF_MS);
export const INSTALL_BACKOFF_MS =
  Number.isFinite(backoffOverride) && backoffOverride >= 0
    ? [backoffOverride, backoffOverride]
    : [2000, 6000];

/** Block the (single-threaded, spawnSync-shaped) main thread for `ms`. */
function sleepSync(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run an install with a BOUNDED retry over network-transient failures only.
 *
 * `run(attempt)` must return a spawnSync-shaped result. Retries happen ONLY
 * while `classifyInstallFailure` says transient AND attempts remain; exhaustion
 * returns `{ ok: false, exhausted: true }` — a failure, never a pass.
 */
export function installWithRetry({
  run,
  attempts = INSTALL_ATTEMPTS,
  backoffMs = INSTALL_BACKOFF_MS,
  sleep = sleepSync,
  onNotice = (m) => console.error(m),
}) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    // An unbounded or zero-attempt loop is the "retry that cannot fail" R6
    // forbids — refuse to construct one rather than silently normalising it.
    throw new Error(
      `installWithRetry: attempts must be a positive integer (bounded retry), got ${attempts}`,
    );
  }

  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const r = run(attempt);
    if (r && r.status === 0) {
      return { ok: true, attempts: attempt, result: r, classification: null, exhausted: false };
    }
    const combined =
      `${(r && r.stdout) || ''}\n${(r && r.stderr) || ''}` +
      (r && r.error ? `\nspawn error: ${r.error.message}` : '');
    const classification = classifyInstallFailure(combined);
    last = { result: r, classification };

    if (!classification.transient) {
      return { ok: false, attempts: attempt, result: r, classification, exhausted: false };
    }
    if (attempt < attempts) {
      const wait = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 0;
      onNotice(
        `RETRY: install attempt ${attempt}/${attempts} failed transiently. ` +
          `${classification.reason} Retrying in ${wait}ms.`,
      );
      sleep(wait);
    }
  }
  // Bound reached. Fail closed: an install that never succeeded is not a pass.
  return {
    ok: false,
    attempts,
    result: last.result,
    classification: last.classification,
    exhausted: true,
  };
}

/** Run a command, echoing its output live-ish while also capturing it. */
function runCaptured(cmd, args, cwd) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 32 * 1024 * 1024,
  });
  // Nothing is discarded — both streams are surfaced verbatim.
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r;
}

function main() {
  const listOnly = process.argv.includes('--list');
  const pkgs = discoverPackages();

  if (pkgs.length === 0) {
    console.error(
      'FAIL: discovered ZERO standalone vitest packages under ' +
        `${SCAN_ROOTS.join(', ')}. A discovery guard that matches nothing reports ` +
        'green while measuring nothing — treating this as a hard error.',
    );
    process.exit(1);
  }

  if (pkgs.length < MIN_PACKAGES) {
    console.error(
      `FAIL: discovered ${pkgs.length} standalone vitest package(s) but MIN_PACKAGES is ` +
        `${MIN_PACKAGES}. A package drops out of discovery silently when its ` +
        '`scripts.test` stops invoking vitest or its specs are renamed. Found: ' +
        `${pkgs.map((p) => p.rel).join(', ')}. Restore the package, or lower ` +
        'MIN_PACKAGES deliberately with a reason.',
    );
    process.exit(1);
  }

  console.log(`Discovered ${pkgs.length} standalone vitest package(s) (floor ${MIN_PACKAGES}):`);
  for (const p of pkgs) console.log(`  - ${p.rel} (${p.specs} spec file(s))`);
  if (listOnly) return;

  let failed = 0;
  let totalExecuted = 0;
  for (const p of pkgs) {
    // R7: name the command actually invoked, not a fixed label.
    const hasLock = fs.existsSync(path.join(p.dir, 'package-lock.json'));
    // A guard must not MUTATE the tree it inspects: `npm install` would write a
    // package-lock.json into a package that deliberately has none, which then
    // trips dockerfile-lockfiles.test.mjs. `--no-package-lock` keeps the
    // fallback read-only. (`npm ci` never writes one.)
    const installArgs = hasLock
      ? ['ci', '--no-audit', '--no-fund']
      : ['install', '--no-audit', '--no-fund', '--no-package-lock'];
    const installCmd = installArgs[0];
    console.log(`\n=== ${p.rel} — npm ${installArgs.join(' ')} ===`);
    // Captured, not inherited, so a failure can be CLASSIFIED (#4032). Both
    // streams are still written verbatim by runCaptured — FAILING CLOSED #4.
    const install = installWithRetry({
      run: (attempt) => {
        if (attempt > 1) {
          console.log(
            `=== ${p.rel} — npm ${installArgs.join(' ')} (attempt ${attempt}/${INSTALL_ATTEMPTS}) ===`,
          );
        }
        return runCaptured('npm', installArgs, p.dir);
      },
    });
    if (!install.ok) {
      const status = install.result?.status;
      // R7: say what actually happened. "exited 1" alone reads as a broken
      // package when the cause was a socket reset on a CDN blob read.
      const exited =
        status === null || status === undefined
          ? 'did not produce an exit code'
          : `exited ${status}`;
      const spawnFailed = install.result?.error
        ? ` npm could not be started: ${install.result.error.message}.`
        : '';
      const bound = install.exhausted
        ? ` Bounded retry EXHAUSTED after ${install.attempts} attempt(s) — failing closed, ` +
          'because an install that never succeeded is not a pass.'
        : ` Failed on attempt ${install.attempts} and was not retried.`;
      console.error(
        `FAIL: ${p.rel} \`npm ${installCmd}\` ${exited}.${spawnFailed} ` +
          `${install.classification.reason}${bound}`,
      );
      failed += 1;
      continue;
    }
    if (install.attempts > 1) {
      console.log(`  ${p.rel}: install succeeded on attempt ${install.attempts}/${INSTALL_ATTEMPTS}.`);
    }

    console.log(`=== ${p.rel} — npm test ===`);
    // `--passWithNoTests` is deliberately NOT passed, so a package matching no
    // spec fails rather than reporting an empty pass. And unlike the install,
    // this is single-shot on purpose: a retried test masks a flaky test.
    const test = runCaptured('npm', ['test', '--silent'], p.dir);
    if (test.status !== 0) {
      console.error(`FAIL: ${p.rel} vitest exited ${test.status}.`);
      failed += 1;
      continue;
    }

    const summary = parseVitestSummary(`${test.stdout || ''}\n${test.stderr || ''}`);
    if (!summary) {
      console.error(
        `FAIL: ${p.rel} exited 0 but no vitest \`Tests\` summary line could be parsed. ` +
          'An unreadable result is not a good result — refusing to count it as a pass.',
      );
      failed += 1;
      continue;
    }
    if (summary.executed === 0) {
      console.error(
        `FAIL: ${p.rel} exited 0 having EXECUTED ZERO tests ` +
          `(${summary.skipped} skipped). vitest returns 0 for an all-skipped run; ` +
          'that reads as coverage and enforces nothing.',
      );
      failed += 1;
      continue;
    }
    totalExecuted += summary.executed;
    console.log(
      `  ${p.rel}: ${summary.executed} test(s) executed` +
        (summary.skipped ? ` (${summary.skipped} skipped)` : ''),
    );
  }

  if (failed > 0) {
    console.error(`\nFAIL: ${failed} of ${pkgs.length} standalone vitest package(s) failed.`);
    process.exit(1);
  }
  console.log(`\nOK: all ${pkgs.length} standalone vitest package(s) passed; ${totalExecuted} test(s) executed.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
