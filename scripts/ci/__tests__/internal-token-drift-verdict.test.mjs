/**
 * internal-token drift verdict self-test (#3056).
 *
 * MUTATION-PROVEN, and deliberately so. The defect this guard exists to catch
 * went undetected for two days because the ONLY detector was a 401 storm in an
 * unrelated gate. A drift guard that cannot go red when a holder diverges would
 * reproduce that exact failure in a new costume, so every test below mutates
 * one holder and asserts the verdict FLIPS:
 *
 *   - diverge the job          -> drift  (restore -> ok)
 *   - diverge the GitHub secret-> drift  (restore -> ok)
 *   - diverge the console      -> drift  (restore -> ok)
 *   - drop a consumer's token  -> missing
 *   - fail to READ a holder    -> unknown  (never "ok", never "absent")
 *   - collect nothing at all   -> empty    (an empty set must not pass)
 *
 * If someone weakens the comparison (e.g. only checks console-vs-jobs, or
 * treats `unknown` as a pass) at least one of these goes red.
 *
 * Run: node --test scripts/ci/__tests__/internal-token-drift-verdict.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { internalTokenDriftVerdict } from '../internal-token-drift-verdict.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'internal-token-drift-verdict.mjs');

/** The healthy estate, as measured live on 2026-08-08 (all four at 209954d26026). */
const CONVERGED = () => ({
  estate: 'commercial',
  holders: [
    { name: 'loom-console', kind: 'console', state: 'present', fingerprint: '209954d26026' },
    { name: 'loom-copilot-evaluator', kind: 'job', state: 'present', fingerprint: '209954d26026' },
    { name: 'loom-asset-reconciler', kind: 'job', state: 'present', fingerprint: '209954d26026' },
    { name: 'loom-cost-anomaly-monitor', kind: 'job', state: 'present', fingerprint: '209954d26026' },
    { name: 'LOOM_INTERNAL_TOKEN', kind: 'github-secret', state: 'present', fingerprint: '209954d26026' },
  ],
});

test('converged estate → ok, exit 0', () => {
  const r = internalTokenDriftVerdict(CONVERGED());
  assert.equal(r.verdict, 'ok');
  assert.equal(r.exitCode, 0);
  assert.equal(r.majority, '209954d26026');
});

test('MUTATION: diverge a consumer job → drift; restore → ok', () => {
  const bad = CONVERGED();
  bad.holders[1].fingerprint = 'deadbeef0000'; // the 2026-08-06 shape exactly
  const red = internalTokenDriftVerdict(bad);
  assert.equal(red.verdict, 'drift');
  assert.equal(red.exitCode, 1);
  assert.match(red.message, /job\/loom-copilot-evaluator=deadbeef0000/);
  assert.match(red.message, /209954d26026/); // names the console as reference

  bad.holders[1].fingerprint = '209954d26026';
  assert.equal(internalTokenDriftVerdict(bad).verdict, 'ok');
});

test('MUTATION: diverge the GitHub Actions secret → drift; restore → ok', () => {
  // This is the 2026-08-07/08 recurrence: bicep re-minted onto the console and
  // the repo secret kept the previous value. #2929 + the eval sweeps + the
  // #3090 residual all had this ONE root.
  const bad = CONVERGED();
  bad.holders[4].fingerprint = 'aaaaaaaaaaaa';
  const red = internalTokenDriftVerdict(bad);
  assert.equal(red.verdict, 'drift');
  assert.match(red.message, /github-secret\/LOOM_INTERNAL_TOKEN=aaaaaaaaaaaa/);

  bad.holders[4].fingerprint = '209954d26026';
  assert.equal(internalTokenDriftVerdict(bad).verdict, 'ok');
});

test('MUTATION: diverge the console itself → drift (every follower is off-reference)', () => {
  const bad = CONVERGED();
  bad.holders[0].fingerprint = 'bbbbbbbbbbbb';
  const red = internalTokenDriftVerdict(bad);
  assert.equal(red.verdict, 'drift');
  assert.equal(red.majority, 'bbbbbbbbbbbb');
  assert.match(red.message, /job\/loom-copilot-evaluator=209954d26026/);
});

test('a declared consumer holding NO token → missing, not ok (the #3089 fail-closed class)', () => {
  const bad = CONVERGED();
  bad.holders[2] = { name: 'loom-asset-reconciler', kind: 'job', state: 'absent' };
  const red = internalTokenDriftVerdict(bad);
  assert.equal(red.verdict, 'missing');
  assert.equal(red.exitCode, 1);
  assert.match(red.message, /job\/loom-asset-reconciler/);
  assert.match(red.message, /fails closed/);
});

test('an optional holder that is absent by design does NOT fail (required:false)', () => {
  const ok = CONVERGED();
  ok.holders.push({ name: 'loom-copilot-maf', kind: 'app', state: 'absent', required: false });
  assert.equal(internalTokenDriftVerdict(ok).verdict, 'ok');
});

test('a holder that could not be READ → unknown, never ok and never absent', () => {
  const bad = CONVERGED();
  bad.holders[3] = {
    name: 'loom-cost-anomaly-monitor',
    kind: 'job',
    state: 'unknown',
    detail: 'AuthorizationFailed on listSecrets',
  };
  const red = internalTokenDriftVerdict(bad);
  assert.equal(red.verdict, 'unknown');
  assert.equal(red.exitCode, 1);
  assert.match(red.message, /NOT evidence/);
});

test('collector says present but supplies no fingerprint → unknown, not a silent pass', () => {
  const bad = CONVERGED();
  delete bad.holders[1].fingerprint;
  const red = internalTokenDriftVerdict(bad);
  assert.equal(red.verdict, 'unknown');
  assert.match(red.message, /could NOT be read/);
});

test('zero holders → empty + exit 1 (a check over an empty set measures nothing)', () => {
  const r = internalTokenDriftVerdict({ estate: 'commercial', holders: [] });
  assert.equal(r.verdict, 'empty');
  assert.equal(r.exitCode, 1);
  assert.match(r.message, /measures nothing/);
});

test('no fingerprint or value ever appears in the rendered lines beyond 12 hex chars', () => {
  const r = internalTokenDriftVerdict(CONVERGED());
  for (const line of r.lines) {
    // Nothing longer than a 12-char fingerprint token should be present.
    const longHex = line.match(/\b[0-9a-f]{13,}\b/);
    assert.equal(longHex, null, `line leaks a long hex blob: ${line}`);
  }
});

test('CLI exits 1 and emits ::error:: on drift, 0 when converged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-token-drift-'));

  const okFile = join(dir, 'ok.json');
  writeFileSync(okFile, JSON.stringify(CONVERGED()));
  const okRun = spawnSync(process.execPath, [SCRIPT, okFile], { encoding: 'utf8' });
  assert.equal(okRun.status, 0, okRun.stdout + okRun.stderr);
  assert.match(okRun.stdout, /OK \(commercial\)/);

  const bad = CONVERGED();
  bad.holders[4].fingerprint = 'cccccccccccc';
  const badFile = join(dir, 'drift.json');
  writeFileSync(badFile, JSON.stringify(bad));
  const badRun = spawnSync(process.execPath, [SCRIPT, badFile], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: 'true' },
  });
  assert.equal(badRun.status, 1, badRun.stdout + badRun.stderr);
  assert.match(badRun.stdout, /::error::/);
});
