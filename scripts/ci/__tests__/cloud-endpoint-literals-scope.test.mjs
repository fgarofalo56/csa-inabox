/**
 * check-cloud-endpoint-literals SCOPE self-test (#4063).
 *
 * SCOPE_DIRS is an ALLOWLIST, so a console directory that is not named in it is
 * not merely under-checked — it is INVISIBLE, and the guard still prints
 * "baseline holds". That shape has now shipped two live sovereign defects:
 * #3381 (`lib/auth` / `lib/admin` / `lib/apps`) and #4063 (`lib/install`, where
 * every item-type provisioner builds its data-plane URL). MEASURED with the
 * scanner's own predicate over `origin/main`: `lib/install` held 14 forbidden-
 * literal occurrences in non-test files across 6 files, 4 of them on comment
 * lines, leaving 10 in LIVE code across 4 files. Among them two live
 * `fetchWithTimeout` calls and a Commercial ADLS hostname written into an ADF
 * linked service — which #4063 argues is the quiet direction (a GREEN sovereign
 * provision with a dead sink); that consequence is #4063's claim, not something
 * this suite measures. (An earlier revision of this header said "seven
 * Commercial literals", which is the size of #4063's section-2 table, not of
 * the directory — deploy-integrity R7.)
 *
 * A scope widening that is never proven to BITE is not a guard, so this suite
 * does not stop at "the string is in the array". It drives the REAL scanner —
 * SCOPE_DIRS, `git ls-files`, the test-file exclusion, the inline allow marker,
 * the literal predicate — over a THROWAWAY git repo shaped like the console,
 * AND over the real repository through the scanner's PRODUCTION defaults:
 *
 *   1. presence      — `lib/install` (and the #3381 three) are in SCOPE_DIRS.
 *   2. BITE          — a forbidden literal in a fixture under `lib/install` is
 *                      COUNTED. Remove 'lib/install' from SCOPE_DIRS and this
 *                      test goes red (mutation-proven; counts in the PR body).
 *   3. scope-bounded — the SAME literal in a fixture OUTSIDE every SCOPE_DIR is
 *                      NOT counted. Together with (2) this is what makes the
 *                      `lib/install` entry load-bearing rather than incidental,
 *                      and it stops an over-broad guard from faking (2).
 *   4. marker        — the same literal carrying `cloud-endpoint-literal-ok` is
 *                      not counted, so (2)'s signal is the LITERAL itself.
 *   5. test files    — a fixture under `__tests__` is still excluded.
 *   6. PRODUCTION    — `scanLiterals()` with NO ARGUMENTS (the call `main()`
 *                      makes) reaches `lib/install` in THIS repository. Tests
 *                      1-5 pass explicit `{appRoot, repoRoot, relPrefix}`, so
 *                      none of them can see a broken DEFAULT — and the defaults
 *                      are the only values production ever uses.
 *   7. zero-population — a SCOPE_DIR that contributes no source files is
 *                      REFUSED rather than handed to the ratchet, where 249->0
 *                      reads as a shrink and prints "baseline holds".
 *   8. THE CLI       — the guard is RUN, as a process, at its production
 *                      defaults, over a fixture console. `REPO_ROOT` derives
 *                      from the guard's own `__dirname`, so a COPY of it in a
 *                      throwaway repo resolves `APP_ROOT` to that repo — which
 *                      makes `main()` drivable end-to-end without mutating one
 *                      tracked byte. Three arms: a literal in `lib/install` is
 *                      COUNTED and exits 1; a clean full population exits 0
 *                      (so the refusal is not unconditional); a missing
 *                      `lib/install` exits NON-ZERO saying "population
 *                      collapsed" instead of "baseline holds".
 *                      (This replaces an earlier source-shape regex over
 *                      `main()`, which asserted the call was WRITTEN rather
 *                      than that the process exits non-zero — presence, not
 *                      enforcement.)
 *
 * NOTE on (4) and (5): both assert a NEGATIVE (the literal was not counted),
 * and an empty result is also what an UNSCANNED directory produces. Each
 * therefore carries a POSITIVE CONTROL — a second, unmarked, non-test fixture
 * in the same scan whose count must be present — so neither can pass by the
 * scan having done nothing at all.
 *
 * The fixture repo lives in os.tmpdir(). NOTHING in this repository is
 * modified: `node --test` runs the guardrail suite's files in PARALLEL, so a
 * mutate-a-tracked-file control would race every sibling test that scans the
 * console tree (external-origin-urls, route-backends, no-freeform, …). Test 6
 * only READS this repo through the production defaults.
 *
 * Run: node --test scripts/ci/__tests__/cloud-endpoint-literals-scope.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanLiterals } from '../check-cloud-endpoint-literals.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD_SRC = resolve(HERE, '..', 'check-cloud-endpoint-literals.mjs');

/** The SCOPE_DIRS array as the guard actually declares it. */
function declaredScopeDirs() {
  const src = readFileSync(GUARD_SRC, 'utf8');
  const m = src.match(/const SCOPE_DIRS = \[([^\]]*)\]/);
  assert.ok(m, 'SCOPE_DIRS not found in check-cloud-endpoint-literals.mjs');
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

const APP_REL = 'apps/fiab-console';

/**
 * Build a throwaway git repo shaped like this one, containing `files`
 * (keys are paths relative to apps/fiab-console), and run the REAL scanner
 * over it. Returns the scanner's `{ repoRelPath: count }` map.
 *
 * Files are `git add`-ed (not committed — `git ls-files` lists the index, and
 * a commit would need an identity this environment may not have).
 */
function scanFixture(files, scanOpts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cel-scope-'));
  try {
    const appRoot = join(root, 'apps', 'fiab-console');
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(appRoot, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    for (const args of [['init', '-q'], ['add', '-A']]) {
      const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
    }
    return scanLiterals({ appRoot, repoRoot: root, relPrefix: APP_REL, ...scanOpts });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const LITERAL_SRC = 'export const u = `https://probe.dfs.core.windows.net`;\n';

/** Every SCOPE_DIR the guard declares, in declaration order. */
const ALL_SCOPE_DIRS = ['lib/azure', 'app/api', 'lib/auth', 'lib/admin', 'lib/apps', 'lib/install'];

/**
 * The ratchet's PASS line, and only it.
 *
 * NOT `/baseline holds/` — the population-collapse error QUOTES that phrase to
 * explain the failure mode it prevents, so a bare `/baseline holds/` needle
 * matches the guard's own diagnosis and reports a correct refusal as a
 * regression. (Measured: it did, on the first run of this test.) The pass line
 * is what actually distinguishes "the ratchet accepted this scan" from "the
 * guard explained why it refused".
 */
const RATCHET_PASS_LINE = /OK[^\n]*no new violations/;

/**
 * RUN THE GUARD AS THE CLI, at its PRODUCTION defaults.
 *
 * `REPO_ROOT` is `path.resolve(__dirname, '..', '..')` and `APP_ROOT` is
 * `<REPO_ROOT>/apps/fiab-console` — both derived from the guard file's OWN
 * location. So copying the real guard (and the ratchet helper it imports) into
 * `<tmp>/scripts/ci/` makes those defaults resolve to `<tmp>/apps/fiab-console`,
 * and `main()` becomes drivable end-to-end without mutating a tracked byte or
 * passing a single test seam. A mutation to the real guard is copied with it,
 * so this bites on the real file.
 *
 * `populatedDirs` get a `probe.ts`; `literalIn`, if given, is the one directory
 * whose probe carries a forbidden literal. No baseline file is written, so the
 * ratchet's baseline is empty and any count at all is a rise.
 */
function runGuardCli(populatedDirs, { literalIn = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cel-cli-'));
  try {
    const ci = join(root, 'scripts', 'ci');
    mkdirSync(ci, { recursive: true });
    for (const f of ['check-cloud-endpoint-literals.mjs', '_ratchet-count.mjs']) {
      copyFileSync(resolve(HERE, '..', f), join(ci, f));
    }
    const appRoot = join(root, 'apps', 'fiab-console');
    for (const d of populatedDirs) {
      const abs = join(appRoot, d, 'probe.ts');
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, d === literalIn ? LITERAL_SRC : 'export const u = 1;\n');
    }
    for (const args of [['init', '-q'], ['add', '-A']]) {
      const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
    }
    const r = spawnSync(process.execPath, [join(ci, 'check-cloud-endpoint-literals.mjs')], {
      cwd: root,
      encoding: 'utf8',
    });
    // Never swallow a spawn failure into "the guard said nothing" (R7).
    assert.equal(r.error, undefined, `could not run the guard: ${r.error?.message}`);
    return {
      status: r.status,
      all: `--- stdout ---\n${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * A second, unmarked, NON-test fixture that must always be counted. Tests 4 and
 * 5 assert an absence, and an absence is also what a scan that never ran
 * produces — this file is the positive control that keeps them honest.
 */
const CONTROL_REL = 'lib/install/provisioners/positive-control.ts';
const CONTROL_KEY = `${APP_REL}/${CONTROL_REL}`;

/** Assert the positive control was counted, i.e. the scan genuinely looked. */
function assertScanRan(found) {
  assert.equal(
    found[CONTROL_KEY],
    1,
    'POSITIVE CONTROL FAILED: the unmarked, non-test fixture in the same scan was not ' +
      'counted either, so this test cannot tell "the exclusion worked" apart from ' +
      '"nothing was scanned at all"',
  );
}

// ---------------------------------------------------------------------------
// 1. Presence
// ---------------------------------------------------------------------------
test('lib/install is declared in SCOPE_DIRS (#4063)', () => {
  assert.ok(
    declaredScopeDirs().includes('lib/install'),
    'lib/install missing from SCOPE_DIRS — every item-type provisioner builds its ' +
      'data-plane URL there and the guard would be blind to it (#4063)',
  );
});

test('the #3381 directories are still in SCOPE_DIRS', () => {
  const dirs = declaredScopeDirs();
  for (const d of ['lib/azure', 'app/api', 'lib/auth', 'lib/admin', 'lib/apps']) {
    assert.ok(dirs.includes(d), `${d} dropped out of SCOPE_DIRS`);
  }
});

// ---------------------------------------------------------------------------
// 2 + 3. BITE, and the negative control that keeps BITE honest
// ---------------------------------------------------------------------------
test('BITE — a forbidden literal under lib/install is counted', () => {
  const found = scanFixture({ 'lib/install/provisioners/probe.ts': LITERAL_SRC });
  assert.equal(
    found[`${APP_REL}/lib/install/provisioners/probe.ts`],
    1,
    'a bare Commercial host under lib/install was NOT counted — the scope entry ' +
      'is not admitting the directory, so the guard is blind there again (#4063)',
  );
});

test('CONTROL — the same literal OUTSIDE every SCOPE_DIR is not counted', () => {
  const found = scanFixture({
    'lib/install/provisioners/probe.ts': LITERAL_SRC,
    'lib/clients/probe.ts': LITERAL_SRC,
  });
  assert.equal(found[`${APP_REL}/lib/install/provisioners/probe.ts`], 1);
  assert.equal(
    found[`${APP_REL}/lib/clients/probe.ts`],
    undefined,
    'the scan is not scope-bound — it flags files no SCOPE_DIR names, so the ' +
      'BITE result above proves nothing about the lib/install entry specifically',
  );
});

// ---------------------------------------------------------------------------
// 4 + 5. The two exclusions that must survive the widening.
//        Each carries a POSITIVE CONTROL — an unmarked, non-test fixture in the
//        SAME scan — because `deepEqual(found, {})` on its own is satisfied by a
//        directory that was never scanned.
// ---------------------------------------------------------------------------
test('the inline cloud-endpoint-literal-ok marker suppresses a line under lib/install', () => {
  const found = scanFixture({
    [CONTROL_REL]: LITERAL_SRC,
    'lib/install/provisioners/probe.ts':
      'export const u = `https://probe.dfs.core.windows.net`; // cloud-endpoint-literal-ok: fixture\n',
  });
  assertScanRan(found);
  assert.equal(
    found[`${APP_REL}/lib/install/provisioners/probe.ts`],
    undefined,
    'the inline allow marker did not suppress a marked line',
  );
  assert.deepEqual(Object.keys(found).sort(), [CONTROL_KEY]);
});

test('test files under lib/install are still excluded structurally', () => {
  const found = scanFixture({
    [CONTROL_REL]: LITERAL_SRC,
    'lib/install/provisioners/__tests__/probe.test.ts': LITERAL_SRC,
    'lib/install/provisioners/probe.spec.ts': LITERAL_SRC,
  });
  assertScanRan(found);
  assert.deepEqual(
    Object.keys(found).sort(),
    [CONTROL_KEY],
    'widening scope to lib/install started counting endpoint-assertion tests, ' +
      'which legitimately embed a RESOLVED host as their expected value',
  );
});

// ---------------------------------------------------------------------------
// 6. THE PRODUCTION PATH.
//
// Tests 1-5 hand scanLiterals an explicit {appRoot, repoRoot, relPrefix}.
// `main()` hands it NOTHING — the defaults ARE production — so a break in a
// default (a typo'd APP_ROOT, a moved REPO_ROOT) is invisible to all of them
// while the CLI happily prints "current: 0 across 0 keys ... baseline holds".
// This test drives the real entry point's real defaults against this repo.
// ---------------------------------------------------------------------------
test('PRODUCTION DEFAULTS — a no-argument scanLiterals() reaches lib/install in this repo', () => {
  const real = scanLiterals();
  const keys = Object.keys(real);

  assert.ok(
    keys.length > 0,
    'the production default scan found NOTHING. A total population collapse is ' +
      'indistinguishable from a clean repo at the ratchet (249 -> 0 reads as a shrink), ' +
      'so this is the failure mode the guard cannot report on itself.',
  );
  assert.ok(
    keys.some((k) => k.startsWith(`${APP_REL}/lib/install/`)),
    `the production default scan reached ${keys.length} file(s) but none under ` +
      `${APP_REL}/lib/install/ — the #4063 widening does not bite on the code path ` +
      'main() actually takes',
  );
  assert.ok(
    keys.some((k) => k.startsWith(`${APP_REL}/app/api/`)),
    'the production default scan reached no app/api file either, so the defaults are ' +
      'pointing somewhere other than this console',
  );
});

// ---------------------------------------------------------------------------
// 7 + 8. Zero population fails CLOSED, and main() is what asks for it.
// ---------------------------------------------------------------------------
test('requireFullPopulation REFUSES a scan where a SCOPE_DIR contributed no files', () => {
  // Same fixture shape as tests 2-5 — only lib/install is populated, so the
  // other five SCOPE_DIRS are empty. Without the check this returns a count of
  // 1 and the ratchet reads it as an enormous shrink.
  assert.throws(
    () => scanFixture({ [CONTROL_REL]: LITERAL_SRC }, { requireFullPopulation: true }),
    /population collapsed/,
    'a SCOPE_DIR yielding zero source files was accepted; the ratchet would read the ' +
      'missing directories as a shrink and print "baseline holds"',
  );

  // Positive control on the refusal itself: with EVERY SCOPE_DIR populated the
  // same call must succeed, so test 7 is not passing because the throw is
  // unconditional.
  const populated = Object.fromEntries(ALL_SCOPE_DIRS.map((d) => [`${d}/probe.ts`, LITERAL_SRC]));
  const found = scanFixture(populated, { requireFullPopulation: true });
  assert.equal(Object.keys(found).length, 6, 'the fully-populated fixture did not scan cleanly');
});

test('THE CLI — main() run as a process counts lib/install, passes clean, and refuses a collapsed population', () => {
  // ARM A — the CLI, at its production defaults, reaches the console tree and
  // COUNTS a literal under lib/install. If APP_ROOT's default were wrong this
  // arm would still exit 1, but with the collapse message instead of a named
  // regression, so the assertion is on the MESSAGE, not merely on the code.
  const bite = runGuardCli(ALL_SCOPE_DIRS, { literalIn: 'lib/install' });
  assert.equal(
    bite.status,
    1,
    `the CLI did not fail on a bare Commercial host under lib/install.\n${bite.all}`,
  );
  assert.match(
    bite.all,
    /apps\/fiab-console\/lib\/install\/probe\.ts: 1 \(baseline 0\)/,
    'the CLI failed, but not for the literal under lib/install — so this proves nothing ' +
      `about the #4063 widening on the path main() takes.\n${bite.all}`,
  );

  // ARM B — POSITIVE CONTROL on the refusal: a fully-populated, literal-free
  // console must exit 0. Without this, arms A and C both pass for a guard that
  // simply always fails.
  const clean = runGuardCli(ALL_SCOPE_DIRS);
  assert.equal(clean.status, 0, `a clean, fully-populated console did not exit 0.\n${clean.all}`);
  assert.match(clean.all, RATCHET_PASS_LINE, `expected the clean run to pass the ratchet.\n${clean.all}`);

  // ARM C — the zero-population refusal, driven as a PROCESS. This is the arm
  // the old source-shape regex only asserted was written.
  const collapsed = runGuardCli(ALL_SCOPE_DIRS.filter((d) => d !== 'lib/install'));
  assert.equal(
    collapsed.status,
    1,
    'a SCOPE_DIR contributing ZERO source files did not fail the CLI — the ratchet reads ' +
      `249 -> 0 as a shrink and prints "baseline holds", which is the #3381/#4063 shape.\n${collapsed.all}`,
  );
  assert.match(
    collapsed.all,
    /population collapsed[\s\S]*lib\/install/,
    `the CLI failed, but not with the population-collapse diagnosis naming lib/install.\n${collapsed.all}`,
  );
  assert.doesNotMatch(
    collapsed.all,
    RATCHET_PASS_LINE,
    `the CLI passed the ratchet over a collapsed population.\n${collapsed.all}`,
  );
});
