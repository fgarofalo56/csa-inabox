/**
 * check-licenses — the CANNOT-RUN path must FAIL, not skip (#3027).
 * ---------------------------------------------------------------------------
 * The guard used to print `SKIP` and exit 0 when apps/fiab-console/
 * node_modules was absent — a compliance control reading green while
 * inspecting zero packages, on exactly the tree shape every fresh worktree
 * has. These tests pin the fixed contract:
 *
 *   1. no node_modules, no opt-in  → exit NON-ZERO, says CANNOT RUN
 *   2. no node_modules + explicit LOOM_LICENSE_SCAN_ALLOW_SKIP=<reason>
 *                                  → exit 0, prints SKIPPED + the reason
 *
 * Mechanism: the script resolves its APP_DIR from its own location
 * (<repo>/scripts/ci → <repo>/apps/fiab-console), so copying it into a temp
 * "repo" whose apps/fiab-console has no node_modules exercises the real
 * cannot-run branch without touching this checkout. Only node builtins are
 * imported by the script, so the copy is self-contained.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARD = join(__dirname, '..', 'check-licenses.mjs');

function runInBareRepo(env = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lic-cannot-run-'));
  try {
    mkdirSync(join(root, 'scripts', 'ci'), { recursive: true });
    mkdirSync(join(root, 'apps', 'fiab-console'), { recursive: true }); // NO node_modules
    const copy = join(root, 'scripts', 'ci', 'check-licenses.mjs');
    copyFileSync(GUARD, copy);
    return spawnSync(process.execPath, [copy], {
      encoding: 'utf8',
      env: { ...process.env, LOOM_LICENSE_SCAN_ALLOW_SKIP: '', ...env },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('no node_modules and no opt-in → non-zero exit naming CANNOT RUN (#3027)', () => {
  const r = runInBareRepo();
  assert.notEqual(r.status, 0, `expected a non-zero exit, got ${r.status}\nstdout: ${r.stdout}`);
  assert.match(r.stderr, /CANNOT RUN/, `stderr should say CANNOT RUN\nstderr: ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /OK — every production dependency/, 'must not claim a pass');
});

test('explicit LOOM_LICENSE_SCAN_ALLOW_SKIP opts in, loudly, with the reason', () => {
  const r = runInBareRepo({ LOOM_LICENSE_SCAN_ALLOW_SKIP: 'unit-test: bare tree by design' });
  assert.equal(r.status, 0, `expected exit 0 on explicit opt-in, got ${r.status}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /SKIPPED \(explicit opt-in\): unit-test: bare tree by design/);
  assert.match(r.stdout, /verified NOTHING/i, 'the skip must state that nothing was verified');
});
