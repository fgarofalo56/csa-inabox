/**
 * Tests for scripts/ci/acr-run-verdict.mjs, scripts/ci/acr-build-run.mjs and
 * the build step wiring (run 39634317953: ACR run Succeeded, log stream died
 * with AuthenticationFailed, Trivy + cosign skipped). Round 2: a poll limit
 * must never re-submit a build whose first run is still going.
 *
 * Run: node --test scripts/ci/__tests__/acr-build-run.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideRunVerdict } from '../acr-run-verdict.mjs';
import { waitRun, submitRun, parseRunId } from '../acr-build-run.mjs';
import { classify } from '../deploy-classify.mjs';
import { classifyAzFailure, isRetryable, TRANSIENT } from '../_az-failure-class.mjs';
import { decideRetry } from '../deploy-retry.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WF = process.env.ACR_RUN_TEST_WF ?? join(ROOT, '.github', 'workflows', 'build-fiab-images-acr-tasks.yml');
const text = readFileSync(WF, 'utf8').replace(/\r\n/g, '\n');
const MIN = 60000;

// ---- pure verdict --------------------------------------------------------
test('verdict: Succeeded continues (input: status Succeeded, the run-39634317953 shape)', () => {
  assert.equal(decideRunVerdict({ status: 'Succeeded' }).verdict, 'continue');
});
test('verdict: Failed / Canceled / Timeout / Error each fail', () => {
  for (const s of ['Failed', 'Canceled', 'Timeout', 'Error']) {
    assert.equal(decideRunVerdict({ status: s }).verdict, 'fail', `status ${s} must fail`);
  }
});
test('verdict: Running waits inside the bound and FAILS past it with a poll-limit message', () => {
  assert.equal(decideRunVerdict({ status: 'Running' }, { elapsedMs: 10 * MIN, maxMs: 100 * MIN }).verdict, 'wait');
  const late = decideRunVerdict({ status: 'Running' }, { elapsedMs: 101 * MIN, maxMs: 100 * MIN });
  assert.equal(late.verdict, 'fail', 'elapsed 101 > max 100 must fail');
  assert.match(late.reason, /poll limit reached/);
  assert.equal(decideRunVerdict({ status: 'Queued' }, { elapsedMs: 101 * MIN, maxMs: 100 * MIN }).verdict, 'fail');
});
test('verdict: unreadable / unknown status fails CLOSED', () => {
  for (const bad of [null, undefined, {}, { status: '' }, { status: 7 }, { status: 'Succeded' }, 'Succeeded']) {
    assert.equal(decideRunVerdict(bad).verdict, 'fail', `input ${JSON.stringify(bad)} must not continue`);
  }
});

// ---- run id parsing ------------------------------------------------------
test('parseRunId: json runId, the REAL "Queued a build with ID" line (run 39634317953), else null', () => {
  assert.equal(parseRunId('{"runId": "cj90w", "status": "Queued"}'), 'cj90w');
  assert.equal(parseRunId('WARNING: Queued a build with ID: cj915'), 'cj915');
  assert.equal(parseRunId('nothing here'), null);
});

// ---- driver with fakes ---------------------------------------------------
function fakeIo({ statuses, tail = 'LOG TAIL', logsThrow = false, cancelOk = true, submit }) {
  let i = 0; let clock = 0;
  const calls = [];
  const out = { log: [], err: [], calls, stopped: false, startedLogs: 0 };
  const io = {
    submit: () => { calls.push('submit'); return submit ?? { status: 0, stdout: '{"runId":"r1"}', stderr: '' }; },
    show: () => { calls.push('show'); const s = statuses[Math.min(i, statuses.length - 1)]; i += 1; return typeof s === 'string' ? { ok: true, value: { status: s } } : s; },
    cancel: (id) => { calls.push(`cancel:${id}`); return cancelOk ? { ok: true } : { ok: false, err: 'denied' }; },
    startLogs: () => { out.startedLogs += 1; if (logsThrow) throw new Error('AuthenticationFailed'); return { stop: () => { out.stopped = true; } }; },
    tailLogs: () => tail,
    sleep: (ms) => { clock += ms; },
    now: () => clock,
    log: (m) => out.log.push(m),
    err: (m) => out.err.push(m),
  };
  return { io, out };
}
const OPT = { registry: 'acr', maxMs: 100 * MIN, pollMs: 30000 };
const count = (calls, k) => calls.filter((c) => c.startsWith(k)).length;

test('wait: a Succeeded run CONTINUES even though log streaming failed to start (the incident); no cancel', async () => {
  const { io, out } = fakeIo({ statuses: ['Queued', 'Running', 'Succeeded'], logsThrow: true });
  assert.equal(await waitRun(io, 'r1', OPT), 0, 'stream error + Succeeded run must exit 0');
  assert.equal(out.startedLogs, 1, 'positive control: streaming was attempted');
  assert.equal(count(out.calls, 'cancel'), 0, 'a Succeeded run must not be cancelled');
});
test('wait: a Failed run fails with the run id, az wording and the log tail on STDOUT; no cancel (already final)', async () => {
  const { io, out } = fakeIo({ statuses: ['Running', 'Failed'], tail: 'cargo: error[E0432]' });
  assert.equal(await waitRun(io, 'r1', OPT), 1);
  assert.match(out.err.join('\n'), /The run with ID 'r1' finished with unsuccessful status 'RunStatus\.FAILED'/);
  assert.match(out.log.join('\n'), /cargo: error\[E0432\]/, 'real build failures must show the log tail');
  assert.doesNotMatch(out.err.join('\n'), /E0432/, 'log text must stay OFF stderr so it can never be read as a retry signal');
  assert.equal(count(out.calls, 'cancel'), 0);
  assert.equal(out.stopped, true, 'the log stream is stopped on every exit');
});
test('wait: a poll limit fails, CANCELS the run, and NEVER submits again', async () => {
  const { io, out } = fakeIo({ statuses: ['Running'] });
  assert.equal(await waitRun(io, 'r1', { ...OPT, maxMs: 2 * 30000 }), 1);
  assert.match(out.err.join('\n'), /poll limit reached/);
  assert.deepEqual(out.calls.filter((c) => c.startsWith('cancel')), ['cancel:r1'], 'exactly one cancel-run for r1 on a poll limit');
  assert.equal(count(out.calls, 'submit'), 0, 'waitRun has no submit path: a second submit would race the first run');
});
test('wait: unreadable status 5 times in a row fails AND cancels; one blip is tolerated', async () => {
  const bad = { ok: false, err: 'ARM 503' };
  const a = fakeIo({ statuses: [bad, bad, bad, bad, bad] });
  assert.equal(await waitRun(a.io, 'r1', OPT), 1);
  assert.match(a.out.err.join('\n'), /could not be read 5 times/);
  assert.equal(count(a.out.calls, 'cancel'), 1);
  const b = fakeIo({ statuses: [bad, 'Succeeded'] });
  assert.equal(await waitRun(b.io, 'r1', OPT), 0, 'a single unreadable poll must not fail a Succeeded run');
});
test('wait: an exception mid-wait cancels the run (finally on any non-terminal exit)', async () => {
  const { io, out } = fakeIo({ statuses: ['Running'] });
  io.sleep = () => { throw new Error('boom'); };
  assert.equal(await waitRun(io, 'r1', OPT), 1);
  assert.equal(count(out.calls, 'cancel'), 1, 'an unexpected exception must still cancel');
});
test('wait: a failed cancel is reported, not swallowed', async () => {
  const { io, out } = fakeIo({ statuses: ['Running'], cancelOk: false });
  await waitRun(io, 'r1', { ...OPT, maxMs: 30000 });
  assert.match(out.err.join('\n'), /could not cancel ACR run r1/);
});
test('submit: failure or no run id fails (success never assumed); success returns the id', () => {
  const f = (submit) => submitRun({ ...fakeIo({ statuses: [], submit }).io });
  assert.equal(f({ status: 1, stdout: '', stderr: 'denied' }).code, 1);
  assert.equal(f({ status: 0, stdout: '{}', stderr: '' }).code, 1);
  assert.deepEqual(f({ status: 0, stdout: '', stderr: 'WARNING: Queued a build with ID: cj915' }), { code: 0, runId: 'cj915' });
});

// ---- the retry harness must NOT see a post-submit failure as retryable ---
const POLL_LIMIT_ERR = "ERROR: The run with ID 'cj90w' did not reach a final status: poll limit reached: run still Running after 105 min (limit 105 min). It is being cancelled, and this is final for this job (no re-submit).";
const STATUS_ERR = (label) => `ERROR: The run with ID 'cj90w' finished with unsuccessful status 'RunStatus.${label}'. ACR run finished with status X. This is final for this job (no re-submit). Show run logs by 'az acr task logs -r acr --run-id cj90w'.`;
test('classifiers: the poll-limit and terminal-status stderr texts are NOT transient (old text "timed out: run still Running" WAS)', () => {
  // positive control: the pre-fix wording is transient to _az-failure-class.
  assert.match('timed out: run still Running after 105 min', TRANSIENT, 'control: the old reason must match TRANSIENT or this test proves nothing');
  const texts = [POLL_LIMIT_ERR, STATUS_ERR('TIME_LIMIT_EXCEEDED'), STATUS_ERR('FAILED'), STATUS_ERR('CANCELED')];
  for (const t of texts) {
    assert.doesNotMatch(t, TRANSIENT, `_az-failure-class TRANSIENT matched: ${t.slice(0, 80)}`);
    assert.equal(isRetryable(classifyAzFailure(t)), false, `retryable per _az-failure-class: ${t.slice(0, 80)}`);
    const d = classify(t);
    assert.notEqual(d.class, 'transient', `deploy-classify said transient: ${t.slice(0, 80)}`);
    const r = decideRetry({ diagnosis: d, attempt: 1, maxAttempts: 3, classAllow: ['transient'], elapsedMs: 105 * MIN, wallClockMs: 0, nextDelayMs: 45000 });
    assert.equal(r.retry, false, `deploy-retry would re-submit on: ${t.slice(0, 80)}`);
  }
});
test('wait: everything it writes to STDERR is non-transient even when the build log tail is full of transient words', async () => {
  const { io, out } = fakeIo({ statuses: ['Failed'], tail: 'connection reset by peer; request timed out; 503 Service Unavailable' });
  await waitRun(io, 'r1', OPT);
  const err = out.err.join('\n');
  assert.doesNotMatch(err, TRANSIENT);
  assert.notEqual(classify(err).class, 'transient');
  assert.match(out.log.join('\n'), /connection reset/, 'positive control: the tail was printed (to stdout)');
});

// ---- workflow shape ------------------------------------------------------
test('workflow: poll mode submits under deploy-retry but WAITS outside it (no retry once a run id exists)', () => {
  assert.match(text, /acr-build-run\.mjs" submit \\\n\s+--run-file "\$RUN_FILE" -- "\$\{BUILD_ARGS\[@\]\}"/, 'submit must be the only call wrapped by the harness');
  const waitAt = text.indexOf('acr-build-run.mjs" wait');
  assert.ok(waitAt > 0, 'a wait invocation must exist');
  const before = text.slice(text.lastIndexOf('RUN_ID=$(', waitAt), waitAt + 400);
  assert.ok(before.startsWith('RUN_ID=$('), 'positive control: found the RUN_ID read that precedes wait');
  assert.doesNotMatch(before, /deploy-retry/, 'wait must NOT be wrapped by deploy-retry.mjs (a retry re-submits a live build)');
  assert.doesNotMatch(text, /acr-build-run\.mjs" wait[^\n]*\n[^\n]*--max-attempts/, 'no retry flags on wait');
});
test('workflow: legacy submit_mode keeps the bare `az acr build` under the harness', () => {
  assert.match(text, /if \[ "\$SUBMIT_MODE" = "legacy" \]; then/, 'the legacy branch must exist');
  assert.match(text, /-- az acr build "\$\{BUILD_ARGS\[@\]\}"/, 'legacy must run the bare az acr build');
  assert.match(text, /--wall-clock 90m[\s\S]{0,200}-- az acr build/, 'legacy keeps its original 90m wall-clock');
  assert.equal((text.match(/^ {6}submit_mode:/gm) || []).length, 2, 'dispatch and call must both declare submit_mode');
  assert.match(text, /^ {2}SUBMIT_MODE: \$\{\{ inputs\.submit_mode \|\| vars\.LOOM_ACR_SUBMIT_MODE \|\| 'poll' \}\}/m, 'env default must be flippable via repo variable');
  assert.match(text, /type: choice\n\s+default: poll\n\s+options:\n\s+- poll\n\s+- legacy/, 'default poll, choices poll|legacy');
});
test('workflow: lease TTL exceeds the job timeout (build timeout-minutes 150 < TTL)', () => {
  const ttl = Number(/LOOM_ACR_LEASE_TTL_MINUTES: '(\d+)'/.exec(text)?.[1]);
  const to = Number(/^ {4}timeout-minutes: (\d+)\s*$/m.exec(text.slice(text.indexOf('\n  build:')))?.[1]);
  assert.ok(ttl > to, `lease TTL ${ttl} must exceed build timeout ${to}: a shorter lease lets the registry be re-locked under a live build`);
  assert.ok(to >= 105 + 15, `build timeout ${to} must cover the 105 min poll`);
});
