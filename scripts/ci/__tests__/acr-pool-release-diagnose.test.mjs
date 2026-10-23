// #5082 items 1 and 2 for build-fiab-images-acr-tasks.yml.
//
//  1. pool_release must survive a transient login failure and a transient
//     scale-down failure, and must FAIL naming the exact az command when the
//     pool cannot be confirmed at 0.
//  2. A failed pool-routed ACR run must print its log tail and runErrorMessage
//     (stderr kept, never discarded) from the Diagnose step.
//
// Workflow pins lift their needles out of the real workflow at runtime
// (assertion-design.md rule 3). Set ACR_POOL_TEST_WF to a sandbox copy to run
// a mutation without touching the tracked tree. Each assertion message names
// the input that turns it red.
//
// Run: node --test scripts/ci/__tests__/acr-pool-release-diagnose.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { release } from '../acr-build-pool.mjs';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WF = process.env.ACR_POOL_TEST_WF ?? join(ROOT, '.github', 'workflows', 'build-fiab-images-acr-tasks.yml');
const text = readFileSync(WF, 'utf8').replace(/\r\n/g, '\n');

function jobBody(id) {
  const start = text.indexOf(`\n  ${id}:\n`);
  assert.ok(start >= 0, `job ${id} must exist`);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z0-9_-]+:\s*\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}
function stepBody(job, namePrefix) {
  const i = job.indexOf(`- name: ${namePrefix}`);
  assert.ok(i >= 0, `step "${namePrefix}" must exist`);
  const rest = job.slice(i + 1);
  const n = rest.search(/\n {6}- /);
  return n < 0 ? rest : rest.slice(0, n);
}

// ---------------------------------------------------------------- release()
function fakeAz(script) {
  // script: ordered list of update outcomes; show returns the count the last update left.
  const calls = [];
  let u = 0;
  let count = 2;
  const az = (args) => {
    const j = args.join(' ');
    calls.push(j);
    if (j.startsWith('acr agentpool list')) return { ok: true, value: [{ name: 'p', count: 2 }] };
    if (j.includes('--queue-count')) return { ok: true, value: { count: 0 } };
    if (j.startsWith('acr task list-runs')) return { ok: true, value: [] };
    if (j.startsWith('acr agentpool update')) {
      const o = script[Math.min(u, script.length - 1)];
      u += 1;
      if (o === 'error') return { ok: false, err: 'conflict' };
      count = o === 'zero' ? 0 : 2;
      return { ok: true, value: {} };
    }
    if (j.startsWith('acr agentpool show')) return { ok: true, value: { count } };
    return { ok: false, err: `unexpected ${j}` };
  };
  return { az, calls };
}
const updates = (c) => c.filter((x) => x.startsWith('acr agentpool update')).length;

test('release: a transient update error on attempt 1 is retried and attempt 2 succeeds', () => {
  const f = fakeAz(['error', 'zero']);
  const r = release('acr', 'p', f.az);
  assert.equal(r.code, 0, 'one ARM error then success must end at count 0; a single-shot release (the old code) returns 1');
  assert.equal(updates(f.calls), 2, 'exactly two update calls: the failed one and the retry');
  assert.match(r.msg, /attempt 2/);
});
test('release: an update that "succeeds" but reads back count=2 is retried, then fails (read-back is the verdict)', () => {
  const f = fakeAz(['stuck']);
  const r = release('acr', 'p', f.az, { attempts: 3 });
  assert.equal(r.code, 1, 'read-back count=2 on every attempt must exit 1; a release that trusts the update exit code returns 0');
  assert.equal(updates(f.calls), 3, 'bounded: exactly 3 attempts, not 1 and not unbounded');
  assert.match(r.msg, /read-back count=2/);
});
test('release: exhaustion names the pool and the exact az command to run by hand', () => {
  const r = release('myacr', 'p', fakeAz(['error']).az, { attempts: 2 });
  assert.equal(r.code, 1);
  assert.ok(r.msg.includes('az acr agentpool update -r myacr -n p --count 0'),
    'message must carry the exact command with the registry and pool names; a generic "scale down failed" turns this red');
  assert.match(r.msg, /conflict/, 'the last az error must be shown, not discarded');
});
test('release: backs off between attempts but not after the last', () => {
  const sleeps = [];
  release('acr', 'p', fakeAz(['error']).az, { attempts: 3, sleep: (ms) => sleeps.push(ms) });
  assert.equal(sleeps.length, 2, '3 attempts => 2 sleeps; sleeping after the final attempt wastes job time');
  assert.ok(sleeps.every((ms) => ms > 0), 'a zero backoff is a retry loop that cannot ride out ARM');
});

// ----------------------------------------------------------- az-login-retry
const SCRIPT = join(ROOT, 'scripts', 'ci', 'az-login-retry.sh');
function runLogin({ failFirst, env = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'azlogin-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const counter = join(dir, 'count');
  writeFileSync(counter, '0');
  // Stub az: `login` fails the first N calls with the real incident text.
  writeFileSync(join(bin, 'az'), [
    '#!/usr/bin/env bash',
    'if [ "$1" = "login" ]; then',
    `  n=$(($(cat "${counter.replace(/\\/g, '/')}") + 1)); echo $n > "${counter.replace(/\\/g, '/')}"`,
    `  if [ $n -le ${failFirst} ]; then echo "JSON is invalid: Expecting value: line 1 column 1 (char 0)" >&2; exit 1; fi`,
    'fi',
    'exit 0',
  ].join('\n') + '\n', { mode: 0o755 });
  const r = spawnSync('bash', [SCRIPT, '--attempts', '3', '--backoff', '0'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin.replace(/\\/g, '/')}:${process.env.PATH}`, AZ_CLIENT_ID: 'c', AZ_CLIENT_SECRET: 's', AZ_TENANT_ID: 't', AZ_SUBSCRIPTION_ID: 'sub', ...env },
  });
  return { ...r, logins: Number(readFileSync(counter, 'utf8')) };
}

test('az-login-retry: two empty-creds style failures then success => exit 0 on attempt 3', () => {
  const r = runLogin({ failFirst: 2 });
  assert.equal(r.status, 0, `a login that fails twice then works must succeed; a single-shot login exits 1. stderr=${r.stderr}`);
  assert.equal(r.logins, 3, 'exactly three az login calls');
});
test('az-login-retry: failing every attempt exits 1, is bounded at 3, and prints the last error', () => {
  const r = runLogin({ failFirst: 99 });
  assert.equal(r.status, 1, 'exhaustion must fail closed; exit 0 here would leave the pool billing silently');
  assert.equal(r.logins, 3, 'bounded at --attempts');
  assert.match(r.stderr, /Expecting value: line 1 column 1/, 'the real az error must reach the log, not be discarded');
});
test('az-login-retry: an EMPTY secret (the incident shape) is retried and then fails, never "succeeds"', () => {
  const r = runLogin({ failFirst: 0, env: { AZ_CLIENT_SECRET: '' } });
  assert.equal(r.status, 1, 'with AZ_CLIENT_SECRET empty no login may be attempted or reported as success');
  assert.equal(r.logins, 0, 'az login must not be called with an empty secret');
  assert.match(r.stderr, /is empty on this runner/);
});

// ----------------------------------------------------------- workflow pins
test('workflow: pool_release logs in through az-login-retry.sh, NOT azure/login, and has no continue-on-error', () => {
  const j = jobBody('pool_release');
  assert.match(j, /bash scripts\/ci\/az-login-retry\.sh/, 'reverting to azure/login (no retry) removes this call and turns this red');
  assert.doesNotMatch(j, /azure\/login@/, 'azure/login in pool_release has no retry: the 2026-10-22 leak');
  assert.doesNotMatch(j, /continue-on-error/, 'continue-on-error would discard a failed login');
  assert.ok(j.indexOf('az-login-retry.sh') < j.indexOf('acr-build-pool.mjs release'), 'login must precede the release');
  assert.match(j, /--cloud AzureUSGovernment/, 'the Gov leg must select the Gov cloud before login');
});
test('workflow: pool_release failure names the exact az command and fails the job', () => {
  const s = stepBody(jobBody('pool_release'), 'Scale the build pool to 0');
  assert.match(s, /acr-build-pool\.mjs release --acr "\$ACR" --pool "\$BUILD_POOL_NAME" \|\| \{/, 'a bare release call without the loud handler turns this red');
  assert.match(s, /az acr agentpool update -r \$\{ACR\} -n \$\{BUILD_POOL_NAME\} --count 0/, 'the hand-run command must carry registry and pool');
  assert.match(s, /exit 1/, 'handler must fail the job');
  assert.doesNotMatch(s, /\|\| true/, 'a swallowed release failure is the leak');
});
test('workflow: pool_acquire sets the count it wants (never assumes 0)', () => {
  const s = stepBody(jobBody('pool_acquire'), 'Scale the build pool up');
  assert.match(s, /acr-build-pool\.mjs acquire --acr "\$ACR" --pool "\$BUILD_POOL_NAME" --count "\$WANT"/);
  // behaviour: acquire() on a stale pool at 0 issues an update to want.
  // (covered in acr-build-pool.test.mjs; here only the call-site pin)
});

const buildJob = jobBody('build');
test('workflow: the submit step exports ACR_RUN_ID to GITHUB_ENV BEFORE the wait', () => {
  const exp = buildJob.indexOf('echo "ACR_RUN_ID=$RUN_ID" >> "$GITHUB_ENV"');
  const wait = buildJob.indexOf('acr-build-run.mjs" wait');
  assert.ok(exp >= 0, 'removing the export leaves the Diagnose step without a run id');
  assert.ok(wait >= 0 && exp < wait, 'export after the wait is never reached when the wait fails');
});
const diag = stepBody(buildJob, 'Diagnose a failed ACR build');
test('workflow: Diagnose prints the log tail and runErrorMessage inside a ::group::, keeping stderr', () => {
  assert.match(diag, /::group::ACR run/, 'no group => the 80-line tail floods the job log');
  assert.match(diag, /::endgroup::/);
  assert.match(diag, /az acr task logs -r "\$ACR" --run-id "\$ACR_RUN_ID" 2> "\$LOG_ERR" \| tail -n 80/, 'log fetch must be tail -n 80 with stderr to a FILE');
  assert.match(diag, /runErrorMessage/, 'the run error message must be read');
  assert.match(diag, /az acr task show-run -r "\$ACR" --run-id "\$ACR_RUN_ID"/);
  assert.doesNotMatch(diag, /2>\s*\/dev\/null/, '2>/dev/null discards the very error that explains a failed fetch (R7)');
  assert.match(diag, /redact_file "\$LOG_ERR"/, 'a failed fetch must SHOW its stderr (redacted)');
  assert.match(diag, /could not read the task log/, 'R7: a failed read says "could not read", never "no log"');
});
// DOCUMENTATION ONLY: a static grep cannot witness the bash -e abort (#5084 B1);
// the EXECUTED Diagnose tests at the end of this file do.
test('workflow: [documentation] Diagnose poll block has no non-zero exit and ends cleanly', () => {
  const a = diag.indexOf('if [ -n "${ACR_RUN_ID:-}" ]');
  const b = diag.indexOf('RUN_IDS=""');
  assert.ok(a >= 0 && b > a, 'poll-mode block must come before the legacy fallbacks');
  const block = diag.slice(a, b);
  assert.doesNotMatch(block, /exit [1-9]/, 'an `exit 1` here would turn a diagnostics fault into a second failure');
  assert.match(block, /exit 0/, 'the block must end the step cleanly');
  assert.match(diag, /^\s*if: failure\(\)/m, 'Diagnose must stay failure()-gated');
});
test('workflow: Diagnose block is wired to the lease window (build job, acr_restore is a separate later job)', () => {
  assert.ok(existsSync(WF));
  assert.ok(text.includes('\n  acr_restore:'), 'acr_restore must remain a separate job; if the lock moved into build the diagnostics would lose access');
});
