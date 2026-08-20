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
 * hand-written and was already wrong — see its own note below.
 *
 * Four hand-maintained values remain, and they are NOT all the same kind of
 * thing. Three are CONTROLS — `SENTINEL`, `MIN_SUITES`, `REQUIRED_TRIGGER_DIRS`
 * — floors that fail the run when reality drops below them, never inputs that
 * silently narrow it.
 *
 * The fourth, `INCLUDE`, is an INPUT: it decides which files are considered at
 * all, so narrowing it narrows everything downstream. Until 2026-08-20 this
 * docblock claimed the only hand-maintained values were the three controls,
 * which was false, and the omission was not academic — `INCLUDE` had ALREADY
 * DRIFTED from the vitest config it claims to mirror, in the silent,
 * one-directional way this whole file exists to prevent (see its own note).
 * It now carries its own controls, but it remains an input, and the next reader
 * should treat it as the most dangerous line here, not as settled.
 *
 * ## Precision: deliberately over-inclusive
 *
 * A path can be assembled at run time, so no static rule is exact. Two signals
 * are used, and a suite is selected if EITHER fires:
 *
 *   1. it calls an `fs` read AND names a top-level outside directory;
 *   2. it imports a relative specifier that resolves outside the console.
 *
 * Measured on the tree at 2026-08-20, AFTER the `INCLUDE` fix below: 42 suites
 * (39 from signal 1, plus 3 that only signal 2 sees). Of 1551 vitest-included
 * suites, only 56 call a filesystem read at all; signal 1 flags 39 of those 56,
 * and the other 17 were read by hand and every one resolves strictly inside
 * `apps/fiab-console/`.
 *
 * The 1551 is VITEST'S OWN count, obtained by calling the `tinyglobby` (and
 * therefore the picomatch 4.0.4) that vitest 3.2.7 resolves, with the exact
 * options from vitest's `globFiles` — not this file's approximation of it. The
 * two agreed only after the fix; before it they were 1551 vs 1548.
 *
 * ## Known over-inclusion, stated in full rather than waved at
 *
 * Over-inclusion costs a few seconds of test time; under-inclusion silently
 * re-opens #3783. When the rule has to guess, it guesses toward running the
 * test. What that actually buys, measured, so the cost is not understated:
 *
 *   `.claude`   ELEVEN suites, and it is SYSTEMATIC, not incidental. Every one
 *               is a doc comment citing a rule file (`.claude/rules/
 *               no-vaporware.md` and friends) in a suite that happens to call
 *               `fs` for an unrelated reason. Citing the rule you enforce is a
 *               repo-wide convention — 50 such citations under
 *               `apps/fiab-console/lib` alone — so this set will GROW, and a
 *               `.claude/`-only PR will keep running eleven-plus suites that
 *               do not read `.claude/` at all. Runtime only, i.e. the safe
 *               direction, but it is not "a known-benign entry or two".
 *   `overrides` one suite — `pnpm-cve-floors.test.ts` names the pnpm
 *               `overrides` KEY in a comment, not the directory.
 *   plus two suites kept deliberately: `pnpm-cve-floors.test.ts` reads the
 *   console's own `package.json`, `ratchet-count-helper.test.ts` reads only
 *   `os.tmpdir()`.
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
 * The controls deliberately cover all THREE stages, because each stage can be
 * healthy while the next is not:
 *
 *   the POPULATION  `EXPECTED_VITEST_INCLUDE` (the config still says what
 *                   `INCLUDE` mirrors) and `MIN_VITEST_INCLUDED` (it still
 *                   matches roughly as many files as it did).
 *   the SUITE SET   `SENTINEL` (a known-true member) and `MIN_SUITES`.
 *   the TRIGGER     `REQUIRED_TRIGGER_DIRS` — the thing that decides whether
 *                   the suites run at all.
 *
 * Until 2026-08-20 only the middle pair existed. The trigger got its control
 * that day after a one-token edit proved it had none; the population got its
 * two hours later, after `INCLUDE` turned out to have drifted already.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * Every `git` call in this file goes through here.
 *
 * Until 2026-08-20 they did not, and a git failure (no git on PATH, not a work
 * tree, a truncated clone) surfaced as a raw node stack trace —
 * `Error: Command failed: git rev-parse --show-toplevel` and twelve frames of
 * `node:child_process`. It failed CLOSED, which was right, but
 * `deploy-integrity.md` R6 requires a worded, actionable diagnosis rather than
 * a stack trace, and R7 requires the message to claim only what was
 * established. So this reports the command, the exit status, git's own stderr,
 * and what to do — and never guesses at a cause it did not observe.
 *
 * @param {string[]} args
 * @param {string} why  what this call is for, in the failure message
 */
function git(args, why) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = (err?.stderr || '').toString().trim();
    console.error(
      `derive-infra-reading-suites: could not ${why}.\n` +
        `  command: git ${args.join(' ')}\n` +
        `  exit:    ${err?.status ?? '(no exit status — git may not be on PATH)'}\n` +
        `  git said: ${stderr || '(nothing on stderr)'}\n` +
        `\n` +
        `This script derives which vitest suites to run by asking git what is in\n` +
        `the tree, so without an answer it cannot know which suites to select. It\n` +
        `refuses to emit rather than emit a smaller selection, because a smaller\n` +
        `selection reports green having run fewer tests (#3783).\n` +
        `\n` +
        `Check, in this order: git is installed and on PATH; the cwd is inside a\n` +
        `git work tree (in CI, that actions/checkout ran before this step); and\n` +
        `the checkout has history, not a partial/blobless clone missing HEAD.`,
    );
    process.exit(1);
  }
}

/**
 * Run from the repo root regardless of the caller's cwd. `fiab-console-ci.yml`
 * defaults its steps to `working-directory: apps/fiab-console`, and from there
 * a `git ls-files apps/fiab-console/` pathspec resolves relative to the cwd and
 * matches NOTHING — which would trip the controls below rather than fail
 * silently, but is a confusing way to learn about a path bug.
 */
process.chdir(git(['rev-parse', '--show-toplevel'], 'locate the repository root').trim());

const CONSOLE_DIR = 'apps/fiab-console';

/**
 * The vitest `include` globs, as regexes. THE ONE HAND-MAINTAINED INPUT in this
 * file (everything else hand-maintained is a control — see the docblock).
 *
 * It must mirror `include` in apps/fiab-console/vitest.config.ts. `e2e` and
 * `tests` are excluded there, so Playwright specs are correctly absent here.
 *
 * IT HAD ALREADY DRIFTED, in the exact shape this file was written to stop.
 * vitest's `lib/**\/__tests__/**` matches ZERO intervening segments; the
 * original regex `^lib\/.*\/__tests__\//` required AT LEAST ONE. So every suite
 * sitting directly at `lib/__tests__/` or `app/__tests__/` was invisible to the
 * deriver while vitest ran it. Measured against vitest's own matcher over all
 * 5933 tracked console files:
 *
 *     vitest include matches : 1551
 *     deriver INCLUDE (old)  : 1548
 *     in vitest, not deriver : 3   app/__tests__/route-boundaries.test.ts
 *                                  lib/__tests__/api-route-typing.test.ts
 *                                  lib/__tests__/client-fetch.test.ts
 *     in deriver, not vitest : 0
 *
 * That was NOT cosmetic, and an earlier review that called it harmless was
 * wrong: `lib/__tests__/api-route-typing.test.ts` IS selected once it is
 * visible (the derived set goes 41 -> 42). It is the COMPILE-TIME half of the
 * typed client-route map, deliberately paired with
 * `scripts/ci/generate-client-route-map.mjs` and
 * `scripts/ci/__tests__/client-route-map.test.mjs`. So a PR editing that
 * generator set `infra=true`, ran the derived subset, went green — with the
 * suite that type-checks the generated map missing from the subset. #3783's
 * shape, one level down, inside its own fix. The other two are genuinely not
 * selected, hand-checked: `client-fetch.test.ts` makes no `fs` call at all, and
 * `route-boundaries.test.ts` reads only `app/**` inside the console.
 *
 * `(?:.*\/)?` is the fix: zero-or-more segments, matching `**\/` as vitest
 * defines it.
 */
const INCLUDE = [
  /^lib\/(?:.*\/)?__tests__\/.*\.test\.tsx?$/,
  /^app\/(?:.*\/)?__tests__\/.*\.test\.tsx?$/,
  /^__tests__\/.*\.test\.tsx?$/,
];

/**
 * `INCLUDE`'s control, in two parts, because the two ways it can go wrong are
 * not the same failure and one assertion cannot see both.
 *
 * 1. THE CONFIG MOVES AND `INCLUDE` DOES NOT. This is the drift above, and it
 *    is silent by construction: vitest keeps running the new set, the deriver
 *    keeps selecting the old one, and nothing compares them. So compare them —
 *    read the globs straight out of vitest.config.ts and require them to be
 *    exactly the strings these regexes were written for. Any edit there now
 *    fails this script LOUDLY, naming both sides, instead of quietly shrinking
 *    what CI runs.
 *
 *    This deliberately trades a possible false RED (someone reformats the
 *    config and must also touch this file) for the false GREEN it replaces.
 *    That is the correct direction for a required check that is also the roll
 *    gate, and the false red arrives with instructions.
 *
 * 2. THE REGEXES THEMSELVES BREAK. A floor on how many files they match. It
 *    catches an arm being dropped or a regex being mangled (measured: dropping
 *    the console-root `__tests__/` arm alone loses 16 files).
 *
 * NEITHER CATCHES A SMALL SEMANTIC DRIFT, and that is worth saying plainly
 * because it is the exact bug that got here: the config never moved (so part 1
 * is silent) and the miss was 3 files out of 1551 (so any usable floor is
 * silent). The regexes were simply written against the globs incorrectly on day
 * one. Only a DIFFERENTIAL against vitest's real matcher finds that class, and
 * that check is not automated here — `tinyglobby`/`picomatch` are transitive
 * deps of vitest and are not resolvable from the console under pnpm's strict
 * layout, so importing them would need a new devDependency and a lockfile
 * change. Until then it is a manual procedure, and this is it:
 *
 *   import { glob } from tinyglobby (the copy under the console's
 *   node_modules/.pnpm, i.e. the one vitest resolves), call it with vitest's
 *   own options — `{ dot: true, cwd: apps/fiab-console, ignore: <exclude>,
 *   expandDirectories: false }` — intersect with `git ls-files`, and diff
 *   against these regexes in BOTH directions. Include a deliberately-narrowed
 *   variant as a positive control, or a zero difference proves nothing.
 *   Measured 2026-08-20 after the fix: 1551 vs 1551, zero both ways; the
 *   control (dropping the `__tests__/` arm) reported 16 and exit 1.
 */
const EXPECTED_VITEST_INCLUDE = [
  'lib/**/__tests__/**/*.test.{ts,tsx}',
  'app/**/__tests__/**/*.test.{ts,tsx}',
  '__tests__/**/*.test.{ts,tsx}',
];

/** Floor on `INCLUDE`'s match count; measured 1551 at 2026-08-20. */
const MIN_VITEST_INCLUDED = 1400;

/**
 * Pull `test.include` out of vitest.config.ts. Takes the FIRST `include: [`
 * (the config has a second one under `coverage:`), and fails closed if it finds
 * no array at all rather than treating "found nothing" as "found a match".
 */
function configuredVitestInclude() {
  const configPath = `${CONSOLE_DIR}/vitest.config.ts`;
  let src;
  try {
    src = readFileSync(configPath, 'utf8');
  } catch (err) {
    console.error(
      `derive-infra-reading-suites: could not read ${configPath} (${err.message}).\n` +
        `It is the source \`INCLUDE\` mirrors, so without it this script cannot\n` +
        `confirm it is selecting the same files vitest runs. Refusing to emit.`,
    );
    process.exit(1);
  }
  const block = /\binclude:\s*\[([^\]]*)\]/.exec(src);
  if (!block) {
    console.error(
      `derive-infra-reading-suites: found no \`include: [ ... ]\` array in\n` +
        `${configPath}. That file is the source \`INCLUDE\` mirrors; if its shape\n` +
        `changed, this check has to be re-pointed rather than skipped — a\n` +
        `mirror nobody compares is how INCLUDE drifted in the first place.\n` +
        `Refusing to emit.`,
    );
    process.exit(1);
  }
  return [...block[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
}

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
 * correspondingly absent from the emitted trigger. Tracked as issue #3821, not
 * fixed here.
 *
 * `core.quotePath=false` so a non-ASCII directory arrives as its own bytes
 * rather than as a C-escaped `"\303\251tc"` literal that would match nothing.
 */
const OUTSIDE = git(
  ['-c', 'core.quotePath=false', 'ls-tree', '-d', '--name-only', 'HEAD'],
  'list the top-level directories in the tree',
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

/**
 * Floor on the derived SUITE COUNT.
 *
 * It was 12 against a measured 41 — a 71% silent narrowing would have passed
 * it. A floor that far below reality is decoration.
 *
 * 38 against a measured 42. The number is not arbitrary, and it is NOT the
 * ~35 first proposed in review: 35 was MEASURED to be exactly the value the
 * most likely real narrowing produces. Dropping `.claude` from `OUTSIDE`
 * (the largest over-inclusion, and the shape of the `.github` deletion that
 * motivated `REQUIRED_TRIGGER_DIRS`) takes the set 42 -> 35, and `35 < 35` is
 * false, so a floor of 35 would have let it through — a gate whose threshold
 * sits exactly on the failure it is meant to catch is the "gate that cannot
 * fail" pattern, not a gate.
 *
 * At 38 that mutation fails (35 < 38), with 4 suites of headroom for ordinary
 * churn. If a legitimate deletion ever takes the real count below this, the
 * fix is to re-measure and lower it DELIBERATELY, in a diff someone reviews —
 * never to make a red run pass, because "fewer suites selected" is this file's
 * defect, not its noise.
 */
const MIN_SUITES = 38;

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
 * These are the directories whose suites gate the deploy chain itself, so an
 * emitted trigger that omits any of them is a broken deriver, not a clean tree.
 * It is a floor (a minimum that must be present), never a ceiling — adding a
 * directory to the tree cannot invalidate it.
 *
 * `azure-functions` is here for a second, independent reason: it is the ONLY
 * directory supplied SOLELY by signal 2 (the import signal), via
 * `__tests__/copilot-eval-probe-retry.test.ts`. Every other directory is
 * carried by signal 1 as well, so signal 2 had NO control of its own — it could
 * be deleted outright and everything else would still pass. MEASURED
 * 2026-08-20, `importedOutsideDirs` stubbed to `return []`, with this list at
 * its previous three entries: the derived set fell 42 -> 39 (still above the
 * floor), the sentinel was still found, and BOTH modes exited 0 — while the
 * emitted trigger silently lost `azure-functions`, so an
 * `azure-functions/**`-only PR would have matched neither branch of the change
 * detection. With the entry present, that same mutation exits 1 in both modes
 * with zero bytes on stdout. Listing it makes this list double as the live
 * control on signal 2. Since the list is explicitly a floor, it costs nothing.
 */
const REQUIRED_TRIGGER_DIRS = ['.github', 'azure-functions', 'platform', 'scripts'];

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
  const tracked = git(['ls-files', `${CONSOLE_DIR}/`], 'list the tracked console files')
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

  // ── INCLUDE's controls, FIRST ─────────────────────────────────────────────
  // Before anything downstream, because everything downstream is a subset of
  // what INCLUDE matched: if it is selecting the wrong files, the sentinel and
  // the floors are all answering a question about the wrong population.
  const configured = configuredVitestInclude();
  const sameInclude =
    configured.length === EXPECTED_VITEST_INCLUDE.length &&
    configured.every((g, i) => g === EXPECTED_VITEST_INCLUDE[i]);
  if (!sameInclude) {
    console.error(
      `derive-infra-reading-suites: apps/fiab-console/vitest.config.ts's test\n` +
        `\`include\` no longer matches what this script's INCLUDE regexes mirror.\n` +
        `  vitest.config.ts: ${JSON.stringify(configured)}\n` +
        `  expected here:    ${JSON.stringify(EXPECTED_VITEST_INCLUDE)}\n` +
        `\n` +
        `Update BOTH \`INCLUDE\` and \`EXPECTED_VITEST_INCLUDE\` in this file to\n` +
        `match the config, then re-run. This check exists because the mirror had\n` +
        `already drifted once (\`lib/**/__tests__/**\` matches zero intervening\n` +
        `segments; the regex required one), which hid a suite from CI while\n` +
        `vitest kept running it. Failing loudly here is the cheap version of\n` +
        `that bug (#3783).`,
    );
    process.exit(1);
  }

  const included = vitestSuites();
  if (included.length < MIN_VITEST_INCLUDED) {
    console.error(
      `derive-infra-reading-suites: INCLUDE matched only ${included.length} console\n` +
        `suites, below the floor of ${MIN_VITEST_INCLUDED} (measured 1551 at 2026-08-20).\n` +
        `Everything this script selects is drawn from that set, so a shrunken\n` +
        `population silently shrinks the selection. Refusing to emit (#3783).`,
    );
    process.exit(1);
  }

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
