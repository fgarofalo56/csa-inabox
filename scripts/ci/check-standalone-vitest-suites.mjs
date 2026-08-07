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
 *
 *   Every log line names the command actually run (R7): the install step prints
 *   `npm ci` or `npm install` according to which one it invokes, never a fixed
 *   label that could describe the other.
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
 * Parse vitest's `Tests` summary line into executed/skipped counts.
 *
 * Recognised shapes (ANSI already stripped by the caller):
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
  const clean = String(output).replace(/\[[0-9;]*m/g, '');
  if (/No test files found/i.test(clean)) return { passed: 0, failed: 0, skipped: 0, executed: 0 };
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

function runInherit(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
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
    const install = runInherit('npm', installArgs, p.dir);
    if (install.status !== 0) {
      console.error(`FAIL: ${p.rel} \`npm ${installCmd}\` exited ${install.status}.`);
      failed += 1;
      continue;
    }

    console.log(`=== ${p.rel} — npm test ===`);
    // `--passWithNoTests` is deliberately NOT passed, so a package matching no
    // spec fails rather than reporting an empty pass.
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
