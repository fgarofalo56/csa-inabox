/**
 * check-annotation-teeth self-test (#2837).
 *
 * The guard exists because a control that cannot fail reads as coverage and
 * enforces nothing. A GUARD that cannot fail is the same defect one level up,
 * so this drives it against synthetic workflow fixtures and pins both verdicts.
 *
 * MUTATION-PROVEN (counts in the PR body): removing either detection branch
 * from check-annotation-teeth.mjs turns the matching "detects" test RED, and
 * the "does not flag" tests stay green — so an over-broad guard that flags
 * everything cannot hide either.
 *
 * Run: node --test scripts/ci/__tests__/annotation-teeth.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = resolve(HERE, '..', 'check-annotation-teeth.mjs');

/** Run the guard over a throwaway directory containing `files`. */
function runOn(files) {
  const dir = mkdtempSync(join(tmpdir(), 'teeth-'));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    const r = spawnSync(process.execPath, [GUARD, dir], { encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const wf = (steps) => `name: fixture
on: workflow_dispatch
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
${steps}
`;

// ---------------------------------------------------------------------------
// DETECTS — the two shapes that made #2837 unable to fail
// ---------------------------------------------------------------------------
test('detects continue-on-error on a step that emits ::error::', () => {
  const r = runOn({
    'bad.yml': wf(`      - name: preflight
        continue-on-error: true
        run: |
          echo "::error::LOGIN BROKEN"`),
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /continue-on-error: true/);
  assert.match(r.out, /bad\.yml/);
});

test('detects a run block whose last statement is a bare exit 0', () => {
  const r = runOn({
    'bad.yml': wf(`      - name: preflight
        run: |
          echo "::error::LOGIN BROKEN"
          exit 0`),
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /bare `exit 0`/);
});

test('a trailing comment after exit 0 does not evade detection', () => {
  const r = runOn({
    'bad.yml': wf(`      - name: preflight
        run: |
          echo "::error::broken"
          exit 0   # never fail
          # trailing comment line`),
  });
  assert.equal(r.code, 1);
});

test('reports every offending step, not just the first', () => {
  const r = runOn({
    'a.yml': wf(`      - name: one
        continue-on-error: true
        run: |
          echo "::error::x"`),
    'b.yml': wf(`      - name: two
        run: |
          echo "::error::y"
          exit 0`),
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /2 step\(s\)/);
});

// ---------------------------------------------------------------------------
// DOES NOT FLAG — the narrowness that keeps this usable. These go RED if the
// guard is widened into "anything with exit 0 or continue-on-error".
// ---------------------------------------------------------------------------
test('does not flag an early-return exit 0 when the step can still fail later', () => {
  // This is loom-synthetic-monitor.yml's real shape: skip cleanly when the job
  // is not deployed, then gate for real further down.
  const r = runOn({
    'ok.yml': wf(`      - name: monitor
        run: |
          if ! az containerapp job show -n j -g g; then
            echo "::warning::not deployed"
            exit 0
          fi
          if [ "$STATUS" != "Succeeded" ]; then
            echo "::error::journeys FAILED"
            exit 1
          fi`),
  });
  assert.equal(r.code, 0, 'an early return is not a discarded verdict');
});

test('does not flag continue-on-error on a step that emits no ::error::', () => {
  const r = runOn({
    'ok.yml': wf(`      - name: optional receipt
        continue-on-error: true
        run: |
          node scripts/receipt.mjs`),
  });
  assert.equal(r.code, 0);
});

test('does not flag ::warning:: or ::notice:: with exit 0 — those are advisory', () => {
  const r = runOn({
    'ok.yml': wf(`      - name: advisory
        continue-on-error: true
        run: |
          echo "::warning::heads up"
          echo "::notice::fyi"
          exit 0`),
  });
  assert.equal(r.code, 0);
});

test('does not flag a step that ends with exit $RC', () => {
  const r = runOn({
    'ok.yml': wf(`      - name: verdict
        run: |
          RC=0
          echo "::error::broken"; RC=1
          exit $RC`),
  });
  assert.equal(r.code, 0);
});

// ---------------------------------------------------------------------------
// SELF-DEFENCE — the guard must not report OK when it has stopped matching.
// ---------------------------------------------------------------------------
test('an empty workflow directory is not a pass when scanning the real dir', () => {
  // The vacuous-pass assertion only fires for the default path; with an
  // explicit fixture dir the guard is allowed to find nothing (the fixtures
  // above rely on that). Pin the default-dir behaviour directly instead.
  const r = spawnSync(process.execPath, [GUARD], {
    encoding: 'utf8',
    cwd: resolve(HERE, '..', '..', '..'),
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(
    `${r.stdout}`,
    /OK — \d+ workflows, \d+ ::error::-emitting step\(s\)/,
    'the OK line must report a non-trivial population, so a scanner that stopped matching is visible',
  );
  const examined = Number(`${r.stdout}`.match(/, (\d+) ::error::-emitting/)?.[1] ?? 0);
  assert.ok(examined > 50, `expected the real repo to have many ::error:: steps, saw ${examined}`);
});
