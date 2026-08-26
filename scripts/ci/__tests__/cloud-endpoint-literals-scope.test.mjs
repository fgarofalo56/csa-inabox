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
 *   8. wiring        — `main()` actually asks for (7). Source-shape assertion,
 *                      which is weaker than behaviour: it proves the call is
 *                      written, not that the process exits non-zero. Driving
 *                      the CLI itself would need a mutated copy of the whole
 *                      repo tree, so this is the honest limit here.
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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
  const populated = Object.fromEntries(
    ['lib/azure', 'app/api', 'lib/auth', 'lib/admin', 'lib/apps', 'lib/install'].map((d) => [
      `${d}/probe.ts`,
      LITERAL_SRC,
    ]),
  );
  const found = scanFixture(populated, { requireFullPopulation: true });
  assert.equal(Object.keys(found).length, 6, 'the fully-populated fixture did not scan cleanly');
});

test('main() asks for requireFullPopulation, so the CLI is the caller that fails closed', () => {
  const src = readFileSync(GUARD_SRC, 'utf8');
  const body = src.slice(src.indexOf('function main()'));
  assert.ok(body.length > 0, 'main() not found in check-cloud-endpoint-literals.mjs');

  assert.match(
    body,
    /scanLiterals\(\s*\{[^}]*requireFullPopulation:\s*true/,
    'main() calls scanLiterals WITHOUT requireFullPopulation — the zero-population ' +
      'refusal exists but the only production caller does not ask for it, which is ' +
      'presence-not-enforcement',
  );
  assert.match(
    body,
    /catch[\s\S]{0,200}?process\.exit\(1\)/,
    'main() does not turn the population refusal into a non-zero exit, so the throw ' +
      'would surface as an unhandled rejection rather than a failed gate',
  );
});
