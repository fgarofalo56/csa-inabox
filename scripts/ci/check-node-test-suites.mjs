#!/usr/bin/env node
/*
 * check-node-test-suites.mjs — run EVERY node:test suite in the repo.
 *
 * WHY THIS EXISTS
 *
 *   Two workflows independently reached the same conclusion and each fixed
 *   exactly one directory by hand:
 *
 *     fiab-console-ci.yml (loom-sharing job)
 *       "…so they need a CI lane rather than a local `node --test` nobody runs."
 *     loom-guardrails.yml (scripts/ci self-tests)
 *       "A test nobody runs is the same class of defect as a gate that measures
 *        nothing — it reads as coverage and enforces nothing."
 *
 *   Neither generalized, so FOUR suites (58 tests) were still dark when #2835
 *   was filed: apps/loom-unity (Unity Catalog authorization is DEFAULT-ON and
 *   FAIL-CLOSED), apps/loom-onelake (path-traversal + no-Fabric-host),
 *   scripts/csa-loom (image preflight fails rather than deploying blind), and
 *   tools/ado-loom-task.
 *
 *   Hand-listing a third and fourth directory would close those four instances
 *   and leave the class open. This script DISCOVERS instead: any node:test file
 *   added anywhere in the tree is picked up the day it lands, with nothing to
 *   keep in sync and nothing to forget.
 *
 * FAILING CLOSED (this guard must not become the thing it guards against)
 *
 *   A discovery-based runner has two ways to report success while measuring
 *   nothing, and both are hard errors here:
 *
 *     1. Discovery matches zero files (a bad root, a renamed tree, a typo in the
 *        extension list). `node --test` with no file arguments would fall back
 *        to its own default discovery and could exit 0 having run nothing.
 *     2. Every discovered test SKIPS. apps/loom-unity and apps/loom-sharing
 *        self-skip when a POSIX `sh` is unavailable — 26 assertions that would
 *        report green on a runner without it. In CI that is a hard error.
 *
 *   The child's exit status is propagated verbatim. Nothing here is wrapped in
 *   `|| true`, and stderr is never discarded.
 *
 * USAGE
 *   node scripts/ci/check-node-test-suites.mjs           # discover + run (CI)
 *   node scripts/ci/check-node-test-suites.mjs --list    # discover only
 *
 * Tests: node --test scripts/ci/__tests__/node-test-suites.test.mjs
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** node:test files look like `<name>.test.<ext>`. */
const TEST_FILE_RE = /\.test\.(mjs|cjs|js)$/;

/**
 * Directories never worth walking (build output, VCS, dependency trees).
 * These hold no first-party source, so skipping them cannot hide a suite.
 */
const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.venv',
  'venv',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'test-results',
  'playwright-report',
  '__pycache__',
  '.claude',
  '.pytest_cache',
  '.mypy_cache',
]);

/**
 * Trees where ANOTHER runner already owns files matching TEST_FILE_RE, so
 * running them under node:test would be wrong (they import that runner's
 * globals). Keep this list as short as the evidence supports — every entry is a
 * hole, so each one names the runner and the workflow that executes it.
 *
 * NOT excluded, deliberately:
 *   apps/fiab-console  — vitest's `include` is *.test.{ts,tsx} ONLY, so a
 *                        .test.mjs there would be dark for vitest too. Leaving
 *                        it in discovery is the only thing that would catch it.
 */
export const OTHER_RUNNER_TREES = [
  {
    dir: 'portal/react-webapp',
    runner: 'jest',
    workflow: '.github/workflows/frontend-test.yml',
  },
];

/** POSIX-style path relative to `root`, so output is stable across platforms. */
function relPosix(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

export function isOwnedByOtherRunner(relPath) {
  return OTHER_RUNNER_TREES.some(
    (t) => relPath === t.dir || relPath.startsWith(`${t.dir}/`),
  );
}

/**
 * Recursively collect every node:test suite under `root`.
 * @returns {string[]} root-relative POSIX paths, sorted.
 */
export function discoverSuites(root = REPO_ROOT) {
  const found = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir (permissions, race) — not a suite location
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = relPosix(root, abs);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (isOwnedByOtherRunner(rel)) continue;
        walk(abs);
      } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
        found.push(rel);
      }
    }
  }

  walk(root);
  return found.sort();
}

/** True when a POSIX `sh` can be spawned (several suites need it or self-skip). */
export function hasPosixSh(spawn = spawnSync) {
  try {
    return spawn('sh', ['-c', 'exit 0']).status === 0;
  } catch {
    return false;
  }
}

/**
 * Parse node:test's TAP summary. Returns null when the counters are absent,
 * which is itself a signal that the run did not conclude normally.
 * @param {string} out combined stdout+stderr of the child
 */
export function parseTapSummary(out) {
  const num = (key) => {
    // No explicit \r handling needed: under /m, JS `$` already matches before a
    // CR, so CRLF output parses identically. (Adding `\r?` was tried and changed
    // nothing, so it was dropped rather than shipped as an inert guard.)
    const m = out.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const pass = num('pass');
  const fail = num('fail');
  if (pass === null || fail === null) return null;
  return { pass, fail, skipped: num('skipped') ?? 0 };
}

/**
 * Decide the exit code from a completed run. Pure, so the self-test can drive
 * every branch without spawning node.
 *
 * @param {{status:number|null, summary:{pass:number,fail:number}|null, ci:boolean}} r
 * @returns {{code:number, reason:string}}
 */
export function decide({ status, summary, ci }) {
  // A non-zero child is a real test failure; propagate it unchanged and never
  // let a later heuristic downgrade it.
  if (status !== 0) {
    return { code: status === null ? 1 : status, reason: 'a node:test suite failed' };
  }
  if (summary === null) {
    return {
      code: 1,
      reason: 'node:test produced no TAP summary — the run did not conclude, so nothing was measured',
    };
  }
  // Exit 0 with zero passing tests means every suite skipped (or ran nothing).
  // That is the "reports success while measuring nothing" shape this guard
  // exists to prevent, so it fails in CI. Locally it warns, because a developer
  // without a POSIX sh has a legitimately degraded environment.
  if (summary.pass === 0) {
    if (ci) {
      return {
        code: 1,
        reason: 'every discovered suite skipped — 0 tests passed, so this lane measured nothing',
      };
    }
    return { code: 0, reason: 'WARNING: 0 tests passed locally (every suite skipped)' };
  }
  return { code: 0, reason: `${summary.pass} tests passed` };
}

function main(argv) {
  const listOnly = argv.includes('--list');
  const ci = Boolean(process.env.CI);

  const suites = discoverSuites();

  console.log(`[node-test-suites] repo root: ${REPO_ROOT}`);
  for (const t of OTHER_RUNNER_TREES) {
    console.log(`[node-test-suites] excluded ${t.dir} (owned by ${t.runner} via ${t.workflow})`);
  }
  console.log(`[node-test-suites] discovered ${suites.length} node:test suite(s):`);
  for (const s of suites) console.log(`  - ${s}`);

  // FAIL CLOSED #1: discovery matched nothing. Handing `node --test` zero files
  // would let it fall back to its own default discovery and exit 0 having run
  // nothing at all.
  if (suites.length === 0) {
    console.error(
      '[node-test-suites] FAIL: discovery matched ZERO suites. This lane would report success while running nothing. Check the repo root, SKIP_DIRS, and TEST_FILE_RE.',
    );
    return 1;
  }

  if (listOnly) return 0;

  // FAIL CLOSED #2: without a POSIX `sh`, the loom-unity and loom-sharing
  // entrypoint suites self-skip — the fail-closed authorization assertions go
  // green without executing. A CI runner always has `sh`; if it does not, the
  // lane is lying, not passing.
  if (!hasPosixSh()) {
    const msg =
      '[node-test-suites] no POSIX `sh` available — the loom-unity/loom-sharing entrypoint suites will SKIP rather than assert.';
    if (ci) {
      console.error(`${msg} FAIL (a CI runner must have sh).`);
      return 1;
    }
    console.warn(`${msg} Continuing locally, but this run is NOT full coverage.`);
  }

  const child = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', ...suites],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  const out = `${child.stdout ?? ''}${child.stderr ?? ''}`;
  process.stdout.write(out);

  const summary = parseTapSummary(out);
  const { code, reason } = decide({ status: child.status, summary, ci });
  console.log(`[node-test-suites] ${code === 0 ? 'OK' : 'FAIL'}: ${reason}`);
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
