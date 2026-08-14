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
 * WHY A FILESYSTEM WALK AND NOT `git ls-files` (#3487, considered and rejected)
 *
 *   Enumerating the index would exclude every gitignored path by construction —
 *   `temp/`, build output, and any future scratch directory nobody listed — and
 *   it is ~370x faster (0.17s against a 64s walk on a tree carrying 40 nested
 *   worktrees). It was rejected anyway, on two measured grounds:
 *
 *     - `git ls-files` lists the INDEX, not the disk. Deleting a tracked file
 *       without staging the deletion still lists it (verified), so a mid-rebase
 *       or sparse checkout would hand `node --test` a path that does not exist
 *       and break a REQUIRED check for a reason unrelated to any test.
 *     - It inverts this file's founding premise — "picked up the day it lands".
 *       A new suite would stay invisible until `git add`, which is the "a test
 *       nobody runs" shape this guard exists to catch, in the local pre-commit
 *       loop where the author would most want it caught.
 *
 *   So discovery stays a dependency-free walk, and the CLASS-level protection
 *   the index would have given lives in the self-test instead, as a PAIR:
 *
 *     - `no discovered suite is git-ignored` fails the day any un-skipped
 *       gitignored directory starts contributing suites, whatever it is named.
 *     - `no TRACKED suite is excluded by SKIP_DIRS` is its inverse, and closes
 *       a blind side the first one cannot see: `git check-ignore` reports a
 *       TRACKED file as NOT ignored even when it matches an ignore pattern, so
 *       a suite force-added under `temp/`/`dist`/`build` would be both
 *       undiscovered and undetected. It is also the half with a real population
 *       on a clean CI checkout; the first half only has teeth locally.
 *
 *   Runtime keeps the cheap path; the guard's own tests carry the teeth.
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
import { readLogicalLines } from './_logical-lines.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** node:test files look like `<name>.test.<ext>`. */
const TEST_FILE_RE = /\.test\.(mjs|cjs|js)$/;

/**
 * Directories never worth walking (build output, VCS, dependency trees,
 * gitignored scratch). These hold no first-party source, so skipping them
 * cannot hide a suite.
 *
 * Matched on the directory's EXACT name at any depth, never as a prefix. That
 * distinction is load-bearing here: this repo tracks `templates/`, `template/`
 * and `temporary-credentials/`, all of which a substring match on `temp` would
 * swallow. `discover: a SKIP_DIRS name is matched EXACTLY, never as a prefix`
 * locks that in.
 *
 * `temp` (#3487) — the repo convention is that gitignored scratch lives in
 * `./temp/`, and in practice that is where git worktrees accumulate. Measured on
 * a working tree: 40 nested checkouts plus 6 build-context copies, so discovery
 * returned 1083 suites of which 976 were stale copies of THIS repo's tests from
 * other branches. The runner then executed them and failed, while CI — which
 * checks out clean, where `temp/` does not exist — stayed green. That is the
 * `.claude` case exactly (~100 agent worktrees under `.claude/worktrees/`),
 * which is why `.claude` was already here.
 *
 * Skipping `temp` cannot hide a first-party suite, and not merely because none
 * is there today: `.gitignore` carries `temp/` with no leading slash, so git
 * ignores a directory of that name at ANY depth. A tracked suite could not live
 * under one without a `git add -f`. Verified: `git check-ignore` matches
 * `temp/x`, `apps/foo/temp/x` and `scripts/ci/temp/deep/x` to that one pattern,
 * and zero tracked paths carry a `temp` segment.
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
  'temp',
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

// ── the lane must be able to BLOCK A MERGE (#2856) ─────────────────────────
//
// Running the suites is only half the job. When this runner was first wired it
// was invoked from a NEW job in fiab-console-ci.yml named `node:test suites
// (node 20)` — a context that is not in the repository's required status
// checks, and that the `Protect main` ruleset does not add either (its rules
// are deletion / non_fast_forward / pull_request only). So the 41 fail-closed
// assertions in apps/loom-unity + apps/loom-onelake could go RED and the pull
// request would still merge with every required check green.
//
// The sibling half of the very same fix did not have that problem:
// scripts/ci/__tests__ was wired into the `guardrails` job, which IS required.
// fiab-console-ci.yml is an easy place to get this wrong precisely because it
// already hosts two required contexts (`next build (node 20)`,
// `vitest (node 20)`), so a job added beside them looks merge-blocking.
//
// This check asserts the runner is invoked from a lane that can actually stop a
// merge. Each entry carries its evidence, and every claim in it is verified
// against the workflow on disk rather than trusted.

/** This file's repo-relative path, as it appears in a workflow `run:`. */
export const RUNNER_PATH = 'scripts/ci/check-node-test-suites.mjs';

/**
 * Lanes whose status check is REQUIRED on `main` (branch protection). At least
 * one of these must invoke RUNNER_PATH, un-neutered.
 *
 * `check` is the status-check CONTEXT as branch protection sees it. A job with
 * no `name:` reports under its job id, so for `guardrails` the two coincide —
 * and adding a `name:` to that job would RENAME the context out of the required
 * list without touching branch protection. checkMergeBlockingLane() verifies
 * this rather than assuming it.
 *
 * NOTE (honest limitation): branch protection lives in repo settings, not in
 * the tree, and the default GITHUB_TOKEN cannot read it. This list is a
 * DECLARATION. If the required set is edited, this guard does not find out —
 * it can only prove the tree matches what we declared. Everything downstream of
 * the declaration is verified.
 */
export const MERGE_BLOCKING_LANES = [
  {
    workflow: '.github/workflows/loom-guardrails.yml',
    job: 'guardrails',
    check: 'guardrails',
  },
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Extract the body of a `jobs:` entry. Job ids sit at two-space indent, so the
 * block ends at the next two-space key — but NOT at a two-space comment, which
 * is still inside the block.
 * @returns {string|null} the block body, or null when the job is absent
 */
export function extractJobBlock(yamlText, jobId) {
  const lines = yamlText.split(/\r?\n/);
  const head = new RegExp(`^ {2}${escapeRe(jobId)}:\\s*(#.*)?$`);
  const start = lines.findIndex((l) => head.test(l));
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[^\s#]/.test(lines[i])) break; // next job id at the same level
    body.push(lines[i]);
  }
  return body.join('\n');
}

/**
 * The status-check context a job reports under: its `name:` when it declares
 * one, otherwise its job id.
 */
export function jobContextName(jobBlock, jobId) {
  const m = jobBlock.match(/^ {4}name:\s*(.+?)\s*$/m);
  if (!m) return jobId;
  return m[1].replace(/^['"]|['"]$/g, '');
}

/**
 * Find an invocation of `needle` in a job block and report whether it can fail.
 *
 * A step that runs the command but discards its verdict is worse than no step:
 * it reads as coverage. Both known ways to do that are rejected here.
 * @returns {{found:boolean, neutered:string[]}}
 */
export function findInvocation(jobBlock, needle) {
  // Steps are list items at six-space indent; split so continue-on-error is
  // attributed to the step that declares it and not to its neighbours.
  const chunks = jobBlock.split(/^ {6}- /m);
  let found = false;
  const neutered = [];
  for (const chunk of chunks) {
    // LOGICAL lines (#3420). The `|| true` test below is the whole point of this
    // function, and it is EXACTLY the token a shell author puts on a
    // continuation:
    //
    //     run: node scripts/ci/check-node-test-suites.mjs \
    //       || true
    //
    // Judged per physical line the run line carries the needle and no `||`, and
    // the `|| true` line carries no needle — so a step wired so it CANNOT FAIL
    // reads as fully-toothed. `csa_loom_guard_blind_continuation_lines_scripts`
    // records a guard passing 10/10 on a tree carrying three live `|| true`s;
    // this is that shape, in the gate that runs every test suite in the repo.
    const runLine = readLogicalLines(chunk)
      .map((l) => l.text)
      .find((l) => l.includes(needle) && !/^\s*#/.test(l));
    if (!runLine) continue;
    found = true;
    if (/^\s*continue-on-error:\s*true\s*$/m.test(chunk)) {
      neutered.push('the step declares continue-on-error: true');
    }
    if (/\|\|\s*true/.test(runLine)) {
      neutered.push('the run line ends in `|| true`');
    }
  }
  return { found, neutered };
}

/**
 * A required check must report on EVERY pull request. A path-filtered one both
 * deadlocks unrelated PRs (the context never reports) and cannot fire on the
 * edit it exists to catch.
 */
export function pullRequestTriggerIsUnfiltered(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const onIdx = lines.findIndex((l) => /^(on|'on'|"on"):\s*$/.test(l));
  if (onIdx === -1) return { ok: false, reason: 'no `on:` block' };
  const block = [];
  for (let i = onIdx + 1; i < lines.length; i++) {
    if (/^[^\s#]/.test(lines[i])) break; // next top-level key
    block.push(lines[i]);
  }
  const prIdx = block.findIndex((l) => /^ {2}pull_request:\s*$/.test(l));
  if (prIdx === -1) return { ok: false, reason: 'no `pull_request:` trigger' };
  for (let i = prIdx + 1; i < block.length; i++) {
    if (/^ {2}[^\s#]/.test(block[i])) break; // next trigger
    if (/^ {4}paths(-ignore)?:/.test(block[i])) {
      return { ok: false, reason: 'the pull_request trigger is path-filtered' };
    }
  }
  return { ok: true, reason: 'pull_request runs unfiltered' };
}

/**
 * Assert at least one declared merge-blocking lane really invokes this runner.
 * @returns {{ok:boolean, problems:string[], lane:object|null}}
 */
export function checkMergeBlockingLane(root = REPO_ROOT, needle = RUNNER_PATH) {
  const problems = [];
  if (MERGE_BLOCKING_LANES.length === 0) {
    return { ok: false, problems: ['no merge-blocking lane is declared'], lane: null };
  }
  for (const lane of MERGE_BLOCKING_LANES) {
    const abs = path.join(root, lane.workflow);
    if (!fs.existsSync(abs)) {
      problems.push(`${lane.workflow} does not exist (declared for check "${lane.check}")`);
      continue;
    }
    const text = fs.readFileSync(abs, 'utf8');
    const block = extractJobBlock(text, lane.job);
    if (block === null) {
      problems.push(`${lane.workflow} declares no job "${lane.job}"`);
      continue;
    }
    const context = jobContextName(block, lane.job);
    if (context !== lane.check) {
      problems.push(
        `${lane.workflow} job "${lane.job}" reports as "${context}", not the required check "${lane.check}" — renaming a job renames its status context out of branch protection`,
      );
      continue;
    }
    const trigger = pullRequestTriggerIsUnfiltered(text);
    if (!trigger.ok) {
      problems.push(`${lane.workflow}: ${trigger.reason} — a required check must report on every PR`);
      continue;
    }
    const { found, neutered } = findInvocation(block, needle);
    if (!found) {
      problems.push(`${lane.workflow} job "${lane.job}" does not invoke ${needle}`);
      continue;
    }
    if (neutered.length > 0) {
      problems.push(`${lane.workflow} job "${lane.job}" invokes ${needle} but ${neutered.join('; ')}`);
      continue;
    }
    return { ok: true, problems: [], lane }; // one good lane is enough
  }
  return { ok: false, problems, lane: null };
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

  // FAIL CLOSED #3: the lane running all this must be able to BLOCK A MERGE.
  // Checked before the suites so the reason is visible even when they pass —
  // green suites in a non-blocking lane is exactly the shape being guarded.
  const lane = checkMergeBlockingLane();
  if (lane.ok) {
    console.log(
      `[node-test-suites] merge-blocking lane: ${lane.lane.workflow} job "${lane.lane.job}" (required check "${lane.lane.check}")`,
    );
  } else {
    for (const p of lane.problems) console.error(`[node-test-suites] lane problem: ${p}`);
  }

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
  // A real test failure keeps its own exit status (never downgraded). Only when
  // the suites are clean does the lane verdict decide the outcome.
  if (code !== 0) return code;
  if (!lane.ok) {
    console.error(
      '[node-test-suites] FAIL: every suite passed, but no merge-blocking lane invokes this runner — a red result here could not stop a merge.',
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
