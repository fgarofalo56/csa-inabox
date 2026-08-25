/**
 * check-cloud-endpoint-literals SCOPE self-test (#4063).
 *
 * SCOPE_DIRS is an ALLOWLIST, so a console directory that is not named in it is
 * not merely under-checked — it is INVISIBLE, and the guard still prints
 * "baseline holds". That shape has now shipped two live sovereign defects:
 * #3381 (`lib/auth` / `lib/admin` / `lib/apps`) and #4063 (`lib/install`, where
 * every item-type provisioner builds its data-plane URL — seven Commercial
 * literals including two live `fetchWithTimeout` calls and a Commercial ADLS
 * hostname written into an ADF linked service, i.e. a GREEN sovereign provision
 * with a dead sink).
 *
 * A scope widening that is never proven to BITE is not a guard, so this suite
 * does not stop at "the string is in the array". It drives the REAL scanner —
 * SCOPE_DIRS, `git ls-files`, the test-file exclusion, the inline allow marker,
 * the literal predicate — over a THROWAWAY git repo shaped like the console:
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
 *
 * The fixture repo lives in os.tmpdir(). NOTHING in this repository is
 * modified: `node --test` runs the guardrail suite's files in PARALLEL, so a
 * mutate-a-tracked-file control would race every sibling test that scans the
 * console tree (external-origin-urls, route-backends, no-freeform, …).
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
function scanFixture(files) {
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
    return scanLiterals({ appRoot, repoRoot: root, relPrefix: APP_REL });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const LITERAL_SRC = 'export const u = `https://probe.dfs.core.windows.net`;\n';

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
// 4 + 5. The two exclusions that must survive the widening
// ---------------------------------------------------------------------------
test('the inline cloud-endpoint-literal-ok marker suppresses a line under lib/install', () => {
  const found = scanFixture({
    'lib/install/provisioners/probe.ts':
      'export const u = `https://probe.dfs.core.windows.net`; // cloud-endpoint-literal-ok: fixture\n',
  });
  assert.deepEqual(found, {}, 'the inline allow marker did not suppress a marked line');
});

test('test files under lib/install are still excluded structurally', () => {
  const found = scanFixture({
    'lib/install/provisioners/__tests__/probe.test.ts': LITERAL_SRC,
    'lib/install/provisioners/probe.spec.ts': LITERAL_SRC,
  });
  assert.deepEqual(
    found,
    {},
    'widening scope to lib/install started counting endpoint-assertion tests, ' +
      'which legitimately embed a RESOLVED host as their expected value',
  );
});
