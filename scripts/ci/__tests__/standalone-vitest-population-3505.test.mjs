/*
 * #3505 — THE POPULATION CONTRACT for check-standalone-vitest-suites.mjs.
 *
 * The guard was written to close "a test nobody runs", and its own SCAN_ROOTS
 * left `apps/` out — so `apps/loom-vscode`'s 181-test suite was dark on every
 * merge-blocking lane while the guard reported green. That is the same shape as
 * #3487 and #3485: a guard whose POPULATION excludes the thing it should watch.
 *
 * A count assertion alone would not have caught it (5 of 5 azure-functions
 * packages were genuinely discovered and genuinely passing). So this file
 * asserts the population by NAME and asserts that every declared exclusion is
 * real, current, and disclosed:
 *
 *   - the package the issue was filed for is IN the discovered set;
 *   - the floor is non-zero, is not above what is discovered, and cannot be
 *     satisfied by an excluded entry;
 *   - every OTHER_RUNNER_TREES / UNINSTALLABLE_PACKAGES entry names a directory
 *     that EXISTS — a stale exclusion is a lie the guard tells every run;
 *   - an excluded directory is genuinely absent from the discovered set, so an
 *     exclusion cannot be decorative.
 *
 * Run by check-node-test-suites.mjs, which walks the tree for node:test files.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MIN_PACKAGES,
  OTHER_RUNNER_TREES,
  SCAN_ROOTS,
  UNINSTALLABLE_PACKAGES,
  discoverPackages,
  isOwnedByOtherRunner,
  isUninstallable,
} from '../check-standalone-vitest-suites.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const discovered = discoverPackages(REPO_ROOT);
const rels = discovered.map((p) => p.rel);

test('apps/ is scanned — the root whose absence made loom-vscode dark', () => {
  assert.ok(SCAN_ROOTS.includes('apps'), `SCAN_ROOTS is ${JSON.stringify(SCAN_ROOTS)}`);
  assert.ok(SCAN_ROOTS.includes('azure-functions'), 'the original root must not be dropped');
});

test('apps/loom-vscode is in the discovered population', () => {
  assert.ok(
    rels.includes('apps/loom-vscode'),
    `apps/loom-vscode is not discovered. Found: ${rels.join(', ')}`,
  );
  const pkg = discovered.find((p) => p.rel === 'apps/loom-vscode');
  // Discovery counts spec FILES; the suite is only real if there are some.
  assert.ok(pkg.specs > 0, 'apps/loom-vscode was discovered with zero spec files');
});

test('the floor is real: non-zero, not above the population, and not met by exclusions', () => {
  assert.ok(Number.isInteger(MIN_PACKAGES) && MIN_PACKAGES > 0, 'MIN_PACKAGES must be a positive integer');
  assert.ok(
    discovered.length >= MIN_PACKAGES,
    `discovered ${discovered.length} < floor ${MIN_PACKAGES}: ${rels.join(', ')}`,
  );
  // No excluded directory may appear in the set the floor is measured against.
  for (const rel of rels) {
    assert.ok(!isOwnedByOtherRunner(rel), `${rel} is excluded as another runner's yet was discovered`);
    assert.ok(!isUninstallable(rel), `${rel} is declared uninstallable yet was discovered`);
  }
});

test('every declared exclusion names a directory that EXISTS — a stale exclusion is a lie', () => {
  for (const t of [...OTHER_RUNNER_TREES, ...UNINSTALLABLE_PACKAGES]) {
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, t.dir)),
      `${t.dir} is excluded but does not exist — remove the entry`,
    );
    assert.ok(
      typeof t.reason === 'string' && t.reason.length > 20,
      `${t.dir} is excluded with no stated reason`,
    );
  }
});

test('the other-runner exclusion names the workflow that actually owns it', () => {
  for (const t of OTHER_RUNNER_TREES) {
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, t.workflow)),
      `${t.dir} claims to be run by ${t.workflow}, which does not exist`,
    );
  }
});

test('apps/fiab-console is excluded, not merely absent', () => {
  assert.ok(!rels.includes('apps/fiab-console'), 'the console must not be run by this guard');
  assert.ok(isOwnedByOtherRunner('apps/fiab-console'), 'and its absence must be a DECLARED exclusion');
});

test('apps/loom-embed is disclosed as UNRUN rather than quietly skipped', () => {
  const entry = UNINSTALLABLE_PACKAGES.find((u) => u.dir === 'apps/loom-embed');
  assert.ok(entry, 'apps/loom-embed must be declared, not silently missing');
  // The disclosure has to SAY the suite is dark. A reason that reads like a
  // routine skip is how a hole becomes invisible.
  assert.match(entry.reason, /UNRUN/);
});
