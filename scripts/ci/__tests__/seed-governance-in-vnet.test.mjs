/**
 * #5368 - the governance seed must NOT run in the main `bootstrap` job (its red exit skipped
 * every later success()-gated step: 38 skipped vs 10) and MUST run on the in-VNet runner.
 *
 * Run: node --test scripts/ci/__tests__/seed-governance-in-vnet.test.mjs
 * BOOTSTRAP_WORKFLOW_PATH feeds a sandbox copy (mutation) instead of the tracked workflow.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW = process.env.BOOTSTRAP_WORKFLOW_PATH || resolve(REPO, '.github/workflows/csa-loom-post-deploy-bootstrap.yml');
const RUN = 'node scripts/csa-loom/seed-governance.mjs';

function jobs(text) {
  const lf = text.replace(/\r\n/g, '\n');
  const at = lf.indexOf('\njobs:\n');
  assert.ok(at >= 0, 'workflow has no top-level `jobs:` key');
  const out = {};
  let name = null;
  for (const line of lf.slice(at + 7).split('\n')) {
    const m = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) { name = m[1]; out[name] = ''; continue; }
    if (name) out[name] += line + '\n';
  }
  return out;
}
const code = (body) => body.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const executors = (text) => Object.entries(jobs(text)).filter(([, b]) => code(b).includes(RUN)).map(([n]) => n);
const runsOn = (body) => (/^ {4}runs-on:\s*(.*)$/m.exec(body) || [])[1] ?? '';

const real = readFileSync(WORKFLOW, 'utf8');

test('the seed runs in exactly one job, and it is not `bootstrap`', () => {
  // Breaks on ['bootstrap'] (step moved back) or two names (duplicated).
  assert.deepEqual(executors(real), ['seed-automation-grant']);
});

test('the main bootstrap job no longer references the seed script or the deleted .sh at all', () => {
  const boot = jobs(real).bootstrap;
  assert.ok(boot && boot.length > 1000, 'bootstrap job body not found (parser blind)');
  // Breaks if any executable line names either seed-governance script in the bootstrap job.
  assert.doesNotMatch(code(boot), /seed-governance\.(mjs|sh)/);
});

test('the seed job runs it on the in-VNet loom-aca runner on Commercial, with the fallback arm', () => {
  const body = jobs(real)['seed-automation-grant'];
  // Breaks if runs-on loses loom-aca (the Cosmos account blocks public access: HTTP 403 from a hosted runner).
  assert.match(runsOn(body), /inputs\.boundary == 'Commercial' && fromJSON\('\["self-hosted","loom-aca"\]'\)/);
  assert.match(runsOn(body), /\|\| fromJSON\(startsWith\(vars\.CI_RUNNER/);
});

test('the seed step is fail-red, not continue-on-error, and discloses the Gov gap', () => {
  const body = jobs(real)['seed-automation-grant'];
  const i = body.indexOf('- name: Seed default governance taxonomy');
  assert.ok(i >= 0, 'seed step not found in the in-VNet job');
  const next = body.indexOf('\n      - name:', i + 10);
  const step = body.slice(i, next < 0 ? undefined : next);
  assert.doesNotMatch(code(step), /continue-on-error/);
  // Positive pair: the failure path exits non-zero and the Gov note exists.
  assert.match(step, /seed-governance\.mjs \|\| fail "seed"/);
  assert.match(step, /^ {12}exit 1$/m);
  assert.match(step, /Cloud-parity gap \(#5364\)/);
  assert.match(step, /\[ "\$BOUNDARY" != "Commercial" \]/);
});

test('MUTATION (in memory): the seed step moved back into bootstrap is detected', () => {
  const lf = real.replace(/\r\n/g, '\n');
  const stripped = lf.replace(/ {10}node scripts\/csa-loom\/seed-governance\.mjs \|\| fail[^\n]*\n/, '');
  assert.notEqual(stripped, lf, 'fixture did not remove the real run line - mutation is blind');
  const mutated = stripped.replace('      - name: Restore Loom Key Vault private (verified)\n',
    `      - name: planted\n        run: |\n          ${RUN}\n      - name: Restore Loom Key Vault private (verified)\n`);
  assert.notEqual(mutated, stripped, 'plant anchor not found - mutation is blind');
  assert.ok(executors(mutated).includes('bootstrap'), 'planted seed not seen in bootstrap');
  assert.notDeepEqual(executors(mutated), ['seed-automation-grant']);
});
