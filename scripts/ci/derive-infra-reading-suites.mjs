#!/usr/bin/env node
/**
 * Derive — from source, at run time — which console vitest suites read files
 * OUTSIDE `apps/fiab-console/`.
 *
 * ## Why this exists (issue #3783)
 *
 * `fiab-console-ci.yml`'s `vitest` job gates on a path filter keyed to
 * `^apps/fiab-console/`. But a large family of suites under that directory are
 * *infra gates*: they `readFileSync` a bicep module, a workflow YAML, or a
 * `scripts/ci/` fixture and assert something about it. The filter is keyed to
 * where the test FILE LIVES; the risk it covers is what the test READS.
 *
 * Those two disagree in exactly the worst direction. A PR touching only
 * `.github/workflows/**` or `platform/fiab/bicep/**` changes precisely what
 * those suites watch — and is precisely when the filter skips them. Job
 * 95847683230 is the specimen: steps 4-7 (`Use Node.js 20`, `Install pnpm`,
 * `Install dependencies`, `Run vitest`) all `skipped`, job conclusion
 * `success`. A required check, green, having executed zero tests.
 *
 * ## Why derive instead of committing a list
 *
 * A hand-maintained second list drifts from the first, and the drift is silent
 * and one-directional: a suite added tomorrow is simply never run by the
 * subset lane, which re-creates #3783 one level down. Deriving at run time
 * means the list cannot go stale, because it does not exist as state.
 *
 * ## Precision: deliberately over-inclusive
 *
 * A path can be assembled at run time, so no static rule is exact. Measured on
 * the tree at the time of writing: of 1548 vitest-included suites, only 54 call
 * a filesystem read at all. This rule flags 38 of those 54; the other 16 were
 * read by hand and every one resolves strictly inside `apps/fiab-console/`
 * (from `lib/x/__tests__` it takes five `..` to escape the console — none of
 * the 16 uses more than three).
 *
 * The 38 include a couple of known-benign entries — `pnpm-cve-floors.test.ts`
 * reads the console's own `package.json`, `ratchet-count-helper.test.ts` reads
 * only `os.tmpdir()`. They are kept on purpose. Over-inclusion costs a few
 * seconds of test time; under-inclusion silently re-opens #3783. When the rule
 * has to guess, it guesses toward running the test.
 *
 * Three real shapes an earlier, tighter version of this rule MISSED, which is
 * why it matches a bare `<dir>/` substring and a quoted bare dir name rather
 * than anchoring on a literal that starts with the directory:
 *
 *   unity-authz-gate.test.ts  resolve(__dirname, '../../../../../platform/...')
 *   scan-services.test.ts     join(process.cwd(), '..', '..', 'scripts', ...)
 *   estate-fleet.test.ts      join(__dirname, '..', ..., 'scripts', 'ci', ...)
 *
 * The second and third spell no directory inside any single literal at all.
 *
 * ## Usage
 *
 *   node scripts/ci/derive-infra-reading-suites.mjs --suites
 *       Console-relative suite paths, newline separated. Feed to `vitest run`.
 *
 *   node scripts/ci/derive-infra-reading-suites.mjs --ere
 *       An extended regex matching repo-relative paths under any top-level
 *       directory at least one suite reads. Feed to `grep -E` in change
 *       detection, so the trigger and the selection share one source of truth.
 *
 * Both modes run the embedded control first (see below) and exit non-zero if
 * it fails, so a broken deriver reddens CI rather than quietly selecting
 * nothing — which would be this issue's own defect, reintroduced by its fix.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Run from the repo root regardless of the caller's cwd. `fiab-console-ci.yml`
 * defaults its steps to `working-directory: apps/fiab-console`, and from there
 * a `git ls-files apps/fiab-console/` pathspec resolves relative to the cwd and
 * matches NOTHING — which would trip the controls below rather than fail
 * silently, but is a confusing way to learn about a path bug.
 */
process.chdir(
  execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(),
);

const CONSOLE_DIR = 'apps/fiab-console';

/**
 * Mirrors `include` in apps/fiab-console/vitest.config.ts. `e2e` and `tests`
 * are excluded there, so Playwright specs are correctly absent here.
 */
const INCLUDE = [
  /^lib\/.*\/__tests__\/.*\.test\.tsx?$/,
  /^app\/.*\/__tests__\/.*\.test\.tsx?$/,
  /^__tests__\/.*\.test\.tsx?$/,
];

/** Every top-level repo directory that is NOT `apps/`. */
const OUTSIDE = [
  '.claude', '.github', 'azure-functions', 'cli', 'content', 'csa_platform',
  'deploy', 'docs', 'domains', 'examples', 'monitoring', 'notebooks',
  'packages', 'platform', 'portal', 'scripts', 'sdk', 'templates', 'tools',
];

const READS_DISK = /readFileSync|readdirSync|existsSync|globSync|statSync/;

/**
 * The embedded control. A guard whose population can silently fall to zero
 * needs a known-true case it must always find, or "nothing matched" and
 * "the matcher is broken" become indistinguishable — and the first is
 * reported as success.
 *
 * This suite is the one #3783 names by name. If the deriver ever stops
 * finding it, the deriver is broken, not the tree.
 */
const SENTINEL = 'lib/deploy/__tests__/gates-2641-deploy-chain.test.ts';

/** Floor well below the measured 38, to catch a rule that half-breaks. */
const MIN_SUITES = 12;

/**
 * Escape EVERY regex metacharacter, not just `.`.
 *
 * Today's `OUTSIDE` entries are all `[a-z.]`, so a dot-only escape happened to
 * be correct — but it is correct by coincidence of the input, not by
 * construction. Adding a directory containing `+`, `(`, or `\` would silently
 * turn the literal into a pattern and change which suites the deriver selects,
 * and a deriver that selects fewer suites reports green having run less (#3783,
 * the defect this file exists to fix). CodeQL flagged the backslash case
 * specifically (js/incomplete-sanitization, high).
 */
const escape = (dir) => dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function vitestSuites() {
  const tracked = execFileSync('git', ['ls-files', `${CONSOLE_DIR}/`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
  return tracked.filter((f) =>
    INCLUDE.some((re) => re.test(f.slice(CONSOLE_DIR.length + 1))),
  );
}

/** @returns {Map<string, string[]>} console-relative suite -> outside dirs it references */
function deriveInfraSuites() {
  const hits = new Map();
  for (const file of vitestSuites()) {
    const src = readFileSync(file, 'utf8');
    if (!READS_DISK.test(src)) continue;

    const dirs = [];
    for (const dir of OUTSIDE) {
      const asPath = new RegExp(`${escape(dir)}/`);
      const asSegment = new RegExp(`['"\`]${escape(dir)}['"\`]`);
      if (asPath.test(src) || asSegment.test(src)) dirs.push(dir);
    }
    if (dirs.length) hits.set(file.slice(CONSOLE_DIR.length + 1), dirs);
  }
  return hits;
}

function main() {
  const mode = process.argv[2] ?? '--suites';
  const hits = deriveInfraSuites();

  if (!hits.has(SENTINEL)) {
    console.error(
      `derive-infra-reading-suites: the control suite is MISSING from the derived set.\n` +
        `  expected: ${SENTINEL}\n` +
        `  derived:  ${hits.size} suite(s)\n` +
        `This means the deriver is broken, not that the tree is clean. Refusing to\n` +
        `emit a selection that would silently run fewer tests than it should (#3783).`,
    );
    process.exit(1);
  }
  if (hits.size < MIN_SUITES) {
    console.error(
      `derive-infra-reading-suites: derived only ${hits.size} suites, below the ` +
        `floor of ${MIN_SUITES}. Refusing to emit a suspiciously small selection (#3783).`,
    );
    process.exit(1);
  }

  if (mode === '--ere') {
    const dirs = [...new Set([...hits.values()].flat())].sort();
    process.stdout.write(`^(${dirs.map(escape).join('|')})/\n`);
    return;
  }
  if (mode === '--suites') {
    process.stdout.write([...hits.keys()].sort().join('\n') + '\n');
    return;
  }
  console.error(`derive-infra-reading-suites: unknown mode '${mode}' (--suites | --ere)`);
  process.exit(2);
}

main();
