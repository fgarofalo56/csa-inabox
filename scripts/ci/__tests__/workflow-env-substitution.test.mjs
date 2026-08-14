/**
 * workflow-env-substitution guard tests (#3137).
 *
 * The class being pinned: a workflow `env:` value is a LITERAL, so `$( … )` in
 * one is dead text that reaches the step verbatim. On #3137 that text became the
 * Gov smoke test's console URL — non-empty, so the script's `${CONSOLE_URL:?}`
 * guard passed and every probe curled a nonsense address.
 *
 * ZERO-POPULATION HAZARD. Once the two live violations are fixed this guard has
 * nothing to find, and "no findings" then looks identical to "the matcher
 * stopped matching". These tests are the embedded control: they carry the
 * verbatim defect as a fixture so the analyser is exercised on a real positive
 * on every run, plus the false-positive shapes that a sloppier matcher would
 * trip on.
 *
 * MUTATION-PROVEN: widening the matcher to any `$` (i.e. flagging `$VAR` too)
 * turns `does not flag a bare $VAR` and `does not flag a ${{ }} expression` RED
 * while the positive tests stay green; narrowing it to nothing turns the
 * positive tests RED. Neither direction can pass silently.
 *
 * Run: node --test scripts/ci/__tests__/workflow-env-substitution.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SELF_TEST_CONTROL,
  SELF_TEST_FIXTURE,
  findEnvSubstitutions,
} from '../check-workflow-env-substitution.mjs';

const SCRIPT = fileURLToPath(new URL('../check-workflow-env-substitution.mjs', import.meta.url));

test('reports the verbatim #3137 defect', () => {
  const hits = findEnvSubstitutions(SELF_TEST_FIXTURE);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].key, 'CONSOLE_URL');
  assert.match(hits[0].value, /^\$\(azd env get-values/);
});

test('does not flag the CORRECT ${{ steps.*.outputs.* }} shape (CONTROL)', () => {
  assert.deepEqual(findEnvSubstitutions(SELF_TEST_CONTROL), []);
});

test('flags a backtick substitution too', () => {
  const src = [
    'jobs:',
    '  j:',
    '    steps:',
    '      - run: echo hi',
    '        env:',
    '          NOW: `date -u`',
  ].join('\n');
  const hits = findEnvSubstitutions(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].key, 'NOW');
});

test('flags a workflow-level and a job-level env:, not only step-level', () => {
  const src = [
    'env:',
    '  TOP: $(hostname)',
    'jobs:',
    '  j:',
    '    env:',
    '      MID: $(whoami)',
    '    steps:',
    '      - run: true',
  ].join('\n');
  const keys = findEnvSubstitutions(src).map((h) => h.key).sort();
  assert.deepEqual(keys, ['MID', 'TOP']);
});

test('does not flag a bare $VAR — not expanded either, but frequently intentional', () => {
  const src = ['env:', '  Q: properties.outputs.$NAME.value', '  R: ${HOME}/x'].join('\n');
  assert.deepEqual(findEnvSubstitutions(src), []);
});

test('does not flag substitution inside a `run:` body — a shell DOES run there', () => {
  const src = [
    'jobs:',
    '  j:',
    '    steps:',
    '      - run: |',
    '          URL=$(az deployment sub show --query x -o tsv)',
    '          echo "$URL"',
    '        env:',
    '          BOUNDARY: GCC-High',
  ].join('\n');
  assert.deepEqual(findEnvSubstitutions(src), []);
});

test('the escape hatch suppresses a deliberate literal', () => {
  const src = [
    'env:',
    '  # env-substitution-ok: documenting the syntax for the runbook',
    '  SAMPLE: $(azd env get-values)',
  ].join('\n');
  assert.deepEqual(findEnvSubstitutions(src), []);
});

test('leaving the env: mapping ends the scope', () => {
  const src = [
    'jobs:',
    '  j:',
    '    steps:',
    '      - env:',
    '          OK: plain',
    '        with:',
    '          script: $(this is a with:, not an env:)',
    '      - run: true',
  ].join('\n');
  assert.deepEqual(findEnvSubstitutions(src), []);
});

// ── CLI behaviour ───────────────────────────────────────────────────────────

test('--self-test passes and exercises a real positive', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--self-test'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /self-test OK/);
});

test('the live workflow tree is CLEAN — the #3137 shape is gone from both sovereign lanes', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, `guard reported findings:\n${r.stderr}`);
  assert.match(r.stdout, /no value carries shell substitution/);
});

test('REFUSES to pass vacuously on a directory with no workflows', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'scripts/ci/__tests__'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /REFUSING TO PASS/);
});
