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
 * That applies to EVERY list here, which is why `OUTSIDE` (the top-level
 * directories) is derived from `git ls-tree` too as of 2026-08-20. It shipped
 * hand-written and was already wrong — see its own note below. The only
 * hand-maintained values left are `SENTINEL`, `MIN_SUITES` and
 * `REQUIRED_TRIGGER_DIRS`, and all three are CONTROLS: floors that fail the
 * run when reality drops below them, never inputs that silently narrow it.
 *
 * ## Precision: deliberately over-inclusive
 *
 * A path can be assembled at run time, so no static rule is exact. Two signals
 * are used, and a suite is selected if EITHER fires:
 *
 *   1. it calls an `fs` read AND names a top-level outside directory;
 *   2. it imports a relative specifier that resolves outside the console.
 *
 * Measured on the tree at 2026-08-20: 41 suites (38 from signal 1, plus 3 that
 * only signal 2 sees). Of 1548 vitest-included suites, only 54 call a
 * filesystem read at all; signal 1 flags 38 of those 54, and the other 16 were
 * read by hand and every one resolves strictly inside `apps/fiab-console/`.
 *
 * The 41 include a couple of known-benign entries — `pnpm-cve-floors.test.ts`
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
 * Both modes run every embedded control first (see below) and exit non-zero if
 * any fails, so a broken deriver reddens CI rather than quietly selecting
 * nothing — which would be this issue's own defect, reintroduced by its fix.
 * The controls deliberately cover BOTH outputs: `SENTINEL` and `MIN_SUITES`
 * validate the derived SUITE SET, and `REQUIRED_TRIGGER_DIRS` validates the
 * emitted TRIGGER. Until 2026-08-20 only the first pair existed, and the
 * trigger — the thing that decides whether the suites run at all — had no
 * assertion on it whatsoever.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

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

/**
 * Every top-level repo directory that is NOT `apps/` — DERIVED from the tree,
 * for the same reason the suite list is (see "Why derive instead of committing
 * a list" above). This was a hand-written literal until 2026-08-20, and it had
 * already drifted: 19 entries against 29 real top-level directories. Missing
 * were `.devcontainer`, `.harness`, `.vscode`, `PRPs`, `decision-trees`,
 * `dev-loop`, `overrides`, `requirements`, `tests` — the file's own argument
 * about a second list going silently stale, one level further down.
 *
 * MEASURED effect of deriving it, so the gain is on the record and not
 * assumed: the emitted trigger gained `overrides` and `tests`. `tests` is the
 * material one — the SENTINEL suite itself
 * (`lib/deploy/__tests__/gates-2641-deploy-chain.test.ts`) asserts the console
 * image un-ignores `tests/`, so a `tests/`-only PR previously matched neither
 * branch of the change detection and reported green having run zero tests,
 * while the deploy-chain gate that covers it sat right there in the derived
 * set. (`overrides` is a false positive — `pnpm-cve-floors.test.ts` mentions
 * the pnpm `overrides` KEY in a comment, not the directory. Over-inclusion is
 * this file's stated bias; it costs seconds, under-inclusion costs #3783.)
 *
 * NOT cured by this change, stated plainly so the next reader does not assume
 * it was: `lib/azure/__tests__/help-copilot.test.ts` asserts
 * `PRPs/active/foundry-parity/` and `PRPs/completed/csa-loom-pillar/` are
 * ingested, and it is in NEITHER the old nor the new derived set — it makes
 * zero direct `fs` calls, so `READS_DISK` excludes it before `OUTSIDE` is ever
 * consulted, and the reading is done for it by console-INTERNAL
 * `lib/azure/help-copilot.ts`, so the import signal below does not reach it
 * either. Catching that shape needs transitive analysis (follow a suite's
 * in-console imports to the module that actually reads disk). `PRPs` is
 * correspondingly absent from the emitted trigger. Tracked, not fixed here.
 *
 * `core.quotePath=false` so a non-ASCII directory arrives as its own bytes
 * rather than as a C-escaped `"\303\251tc"` literal that would match nothing.
 */
const OUTSIDE = execFileSync(
  'git',
  ['-c', 'core.quotePath=false', 'ls-tree', '-d', '--name-only', 'HEAD'],
  { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
)
  .split('\n')
  .map((d) => d.trim())
  .filter(Boolean)
  .filter((d) => d !== 'apps');

const OUTSIDE_SET = new Set(OUTSIDE);

const READS_DISK = /readFileSync|readdirSync|existsSync|globSync|statSync/;

/**
 * Second signal: a suite that reaches outside the console by IMPORTING code
 * from there, rather than by reading a file itself.
 *
 * Keying only on `READS_DISK` in the suite's OWN source missed these, and the
 * miss was load-bearing:
 *
 *   lib/azure/__tests__/unity-audit-guard.test.ts
 *       imports ../../../../../scripts/ci/check-unity-audit-chokepoint.mjs
 *       — the LU-3 Unity Catalog authorization choke point: default-ON,
 *       fail-closed, 14 attack tests. A PR editing that checker set
 *       `infra=true`, ran the derived subset, went green — and the only suite
 *       that tests the edited file was not in the subset. The wrong tests,
 *       reported as coverage, on an authz control.
 *   lib/api/__tests__/route-toolkit-codemod.test.ts
 *       imports ../../../../../scripts/codemods/migrate-route-toolkit.mjs
 *
 * This matches any quoted `../`-relative specifier, not only a syntactic
 * `import`/`require`. `vi.mock('../../../../../scripts/x.mjs')` is the same
 * dependency, and per the over-inclusion note above, when the rule has to
 * guess it guesses toward running the test.
 *
 * NOT keyed on a minimum number of `../` segments. Five escapes the console
 * from `lib/x/__tests__`, but only three from the console-root `__tests__/`
 * that vitest.config.ts also includes — so any fixed count is correct by
 * coincidence of where the suite happens to sit. That is not hypothetical: the
 * third suite this signal recovers,
 * `__tests__/copilot-eval-probe-retry.test.ts`, imports
 * `../../../azure-functions/copilot-evaluator/src/evaluator-core` with exactly
 * THREE — a `>= 4` pre-filter would have missed it, and with it the only suite
 * covering the copilot evaluator core. Resolving the path answers the actual
 * question and cannot drift with directory depth.
 *
 * KNOWN LIMIT, stated rather than hidden: a specifier resolving to a
 * repo-ROOT FILE (`../../../package.json`) has no top-level directory to
 * trigger on, so it contributes nothing. That is unchanged from before this
 * signal existed, not a new hole — but it is a hole.
 */
const RELATIVE_SPECIFIER = /['"`](\.\.\/[^'"`\n]*)['"`]/g;

/**
 * @param {string} file repo-relative path of the suite
 * @param {string} src  its source
 * @returns {string[]} top-level OUTSIDE dirs the suite imports from
 */
function importedOutsideDirs(file, src) {
  const from = path.posix.dirname(file);
  const found = [];
  for (const [, spec] of src.matchAll(RELATIVE_SPECIFIER)) {
    const resolved = path.posix.join(from, spec);
    // Escaped the repo root entirely — not a path this repo can trigger on.
    if (resolved.startsWith('..')) continue;
    if (resolved === CONSOLE_DIR || resolved.startsWith(`${CONSOLE_DIR}/`)) continue;
    const top = resolved.split('/')[0];
    if (OUTSIDE_SET.has(top)) found.push(top);
  }
  return found;
}

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

/** Floor well below the measured count, to catch a rule that half-breaks. */
const MIN_SUITES = 12;

/**
 * The control on the EMITTED TRIGGER — the one thing `SENTINEL` and
 * `MIN_SUITES` do not watch.
 *
 * Both of those validate the derived SUITE SET. Nothing validated the `--ere`
 * string, and the gap was demonstrable in one token: deleting `.github` from
 * the old hand-written `OUTSIDE` still derived 38 suites (the sentinel suite
 * also references `platform/`, `scripts/` and `deploy/`, so it was still
 * found; 38 is far above the floor of 12). Every control reported green, exit
 * 0 in both modes — and the emitted trigger no longer contained `.github`. A
 * `.github/workflows/**`-only PR then matched NEITHER branch of the change
 * detection, vitest concluded success having executed zero tests, and
 * `loom-roll-and-validate` rolled that SHA. #3783 exactly, reintroduced by an
 * edit this file's own controls certified as clean.
 *
 * These three are the directories whose suites gate the deploy chain itself,
 * so an emitted trigger that omits any of them is a broken deriver, not a
 * clean tree. This list is now the ONLY hand-maintained thing in the file, and
 * it is a floor (a minimum that must be present), never a ceiling — adding a
 * directory to the tree cannot invalidate it.
 */
const REQUIRED_TRIGGER_DIRS = ['.github', 'platform', 'scripts'];

/**
 * Escape EVERY regex metacharacter, not just `.`.
 *
 * This was already the right call when `OUTSIDE` was a hand-written literal of
 * `[a-z.]` entries — correct by coincidence of the input, not by construction,
 * and CodeQL flagged the backslash case (js/incomplete-sanitization, high).
 * Now that `OUTSIDE` is DERIVED from `git ls-tree`, it is load-bearing rather
 * than defensive: a directory named with `+`, `(` or `\` enters this list the
 * moment someone adds it to the tree, with no edit to this file and no review
 * of this line. An unescaped metacharacter would silently turn the literal
 * into a pattern and change which suites the deriver selects — and a deriver
 * that selects fewer suites reports green having run less (#3783, the defect
 * this file exists to fix).
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

    const dirs = new Set();

    // Signal 1 — the suite reads a file itself. The `READS_DISK` precondition
    // is what keeps the bare-substring match honest: without it, every test
    // that merely MENTIONS `docs/` in a comment would be selected.
    if (READS_DISK.test(src)) {
      for (const dir of OUTSIDE) {
        const asPath = new RegExp(`${escape(dir)}/`);
        const asSegment = new RegExp(`['"\`]${escape(dir)}['"\`]`);
        if (asPath.test(src) || asSegment.test(src)) dirs.add(dir);
      }
    }

    // Signal 2 — the suite IMPORTS code that lives outside the console. This
    // one is deliberately independent of `READS_DISK`: the two suites it
    // recovers call no `fs` API at all in their own source (the code they
    // import does the reading), which is precisely why keying on the suite's
    // own `fs` calls missed them.
    for (const dir of importedOutsideDirs(file, src)) dirs.add(dir);

    if (dirs.size) hits.set(file.slice(CONSOLE_DIR.length + 1), [...dirs]);
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

  /**
   * Computed here, ABOVE the mode switch and before anything reaches stdout,
   * so the trigger control below runs in `--suites` mode too. A deriver that
   * emitted a correct suite list and a hole-ridden trigger would still put an
   * untested SHA on the estate — the trigger decides whether the suites run at
   * all.
   */
  const dirs = [...new Set([...hits.values()].flat())].sort();

  const missing = REQUIRED_TRIGGER_DIRS.filter((d) => !dirs.includes(d));
  if (missing.length) {
    console.error(
      `derive-infra-reading-suites: the emitted trigger is MISSING required ` +
        `directory/ies: ${missing.join(', ')}\n` +
        `  emitted: ${dirs.join(', ') || '(none)'}\n` +
        `  derived: ${hits.size} suite(s)\n` +
        `A PR touching only a missing directory would match neither branch of the\n` +
        `change detection, and vitest — a REQUIRED check and the roll gate — would\n` +
        `conclude success having executed zero tests (#3783). The suite count and\n` +
        `the sentinel can both look healthy while this is true; that is why this\n` +
        `control exists separately from them. Refusing to emit.`,
    );
    process.exit(1);
  }

  if (mode === '--ere') {
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
