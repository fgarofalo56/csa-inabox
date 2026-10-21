/**
 * Tests for scripts/ci/acr-run-verdict.mjs, scripts/ci/acr-build-run.mjs and
 * the build step wiring (run 39634317953: ACR run Succeeded, log stream died
 * with AuthenticationFailed, Trivy + cosign skipped).
 *
 * Run: node --test scripts/ci/__tests__/acr-build-run.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideRunVerdict } from '../acr-run-verdict.mjs';
import { runBuild, parseRunId } from '../acr-build-run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const text = readFileSync(join(ROOT, '.github', 'workflows', 'build-fiab-images-acr-tasks.yml'), 'utf8').replace(/\r\n/g, '\n');
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
test('verdict: Running waits inside the bound and FAILS with a timeout message past it', () => {
  assert.equal(decideRunVerdict({ status: 'Running' }, { elapsedMs: 10 * MIN, maxMs: 100 * MIN }).verdict, 'wait');
  const late = decideRunVerdict({ status: 'Running' }, { elapsedMs: 101 * MIN, maxMs: 100 * MIN });
  assert.equal(late.verdict, 'fail', 'elapsed 101 > max 100 must fail');
  assert.match(late.reason, /timed out/);
  assert.equal(decideRunVerdict({ status: 'Queued' }, { elapsedMs: 101 * MIN, maxMs: 100 * MIN }).verdict, 'fail');
});
test('verdict: unreadable / unknown status fails CLOSED', () => {
  for (const bad of [null, undefined, {}, { status: '' }, { status: 7 }, { status: 'Succeded' }, 'Succeeded']) {
    assert.equal(decideRunVerdict(bad).verdict, 'fail', `input ${JSON.stringify(bad)} must not continue`);
  }
});

// ---- run id parsing ------------------------------------------------------
test('parseRunId: json runId, then the "Queued a build with ID" line, else null', () => {
  assert.equal(parseRunId('{"runId": "cj90w", "status": "Queued"}'), 'cj90w');
  assert.equal(parseRunId('Queued a build with ID: cj91n'), 'cj91n');
  assert.equal(parseRunId('nothing here'), null);
});

// ---- driver with fakes ---------------------------------------------------
function fakeIo({ submit = { status: 0, stdout: '{"runId":"r1"}', stderr: '' }, statuses, tail = 'LOG TAIL', logsThrow = false }) {
  let i = 0; let clock = 0;
  const out = { log: [], err: [], slept: 0, stopped: false, startedLogs: 0 };
  const io = {
    submit: () => submit,
    show: () => { const s = statuses[Math.min(i, statuses.length - 1)]; i += 1; return typeof s === 'string' ? { ok: true, value: { status: s } } : s; },
    startLogs: () => { out.startedLogs += 1; if (logsThrow) throw new Error('AuthenticationFailed'); return { stop: () => { out.stopped = true; } }; },
    tailLogs: () => tail,
    sleep: (ms) => { clock += ms; out.slept += 1; },
    now: () => clock,
    log: (m) => out.log.push(m),
    err: (m) => out.err.push(m),
  };
  return { io, out };
}
const OPT = { registry: 'acr', maxMs: 100 * MIN, pollMs: 30000 };

test('driver: a Succeeded run CONTINUES even though log streaming failed to start (the incident)', async () => {
  const { io, out } = fakeIo({ statuses: ['Queued', 'Running', 'Succeeded'], logsThrow: true });
  assert.equal(await runBuild(io, OPT), 0, 'stream error + Succeeded run must exit 0');
  assert.equal(out.startedLogs, 1, 'positive control: streaming was attempted');
  assert.ok(out.log.some((l) => /::warning::log streaming could not start/.test(l)));
});
test('driver: a Failed run fails with the run id, az wording and the log tail', async () => {
  const { io, out } = fakeIo({ statuses: ['Running', 'Failed'], tail: 'cargo: error[E0432]' });
  assert.equal(await runBuild(io, OPT), 1);
  const e = out.err.join('\n');
  assert.match(e, /The run with ID 'r1' finished with unsuccessful status 'RunStatus\.FAILED'/);
  assert.match(e, /cargo: error\[E0432\]/, 'real build failures must show the log tail');
  assert.equal(out.stopped, true, 'the log stream is stopped on every exit');
});
test('driver: a run still Running past the bound fails with a timeout message', async () => {
  const { io, out } = fakeIo({ statuses: ['Running'] });
  assert.equal(await runBuild(io, { ...OPT, maxMs: 2 * 30000 }), 1);
  assert.match(out.err.join('\n'), /timed out/);
  assert.ok(out.slept >= 2, 'it polled before giving up');
});
test('driver: unreadable status 5 times in a row fails closed; one blip is tolerated', async () => {
  const bad = { ok: false, err: 'ARM 503' };
  const a = fakeIo({ statuses: [bad, bad, bad, bad, bad] });
  assert.equal(await runBuild(a.io, OPT), 1);
  assert.match(a.out.err.join('\n'), /could not be read 5 times/);
  const b = fakeIo({ statuses: [bad, 'Succeeded'] });
  assert.equal(await runBuild(b.io, OPT), 0, 'a single unreadable poll must not fail a Succeeded run');
});
test('driver: submit failure or no run id fails (success never assumed)', async () => {
  assert.equal(await runBuild(fakeIo({ submit: { status: 1, stdout: '', stderr: 'denied' }, statuses: ['Succeeded'] }).io, OPT), 1);
  assert.equal(await runBuild(fakeIo({ submit: { status: 0, stdout: '{}', stderr: '' }, statuses: ['Succeeded'] }).io, OPT), 1);
});

// ---- workflow shape ------------------------------------------------------
test('workflow: the build step runs acr-build-run.mjs under deploy-retry and no longer streams via az acr build', () => {
  assert.match(text, /-- node "\$GITHUB_WORKSPACE\/scripts\/ci\/acr-build-run\.mjs" \\\n\s+--max-minutes \d+ --poll-seconds \d+ -- \\/, 'the retry harness must wrap acr-build-run.mjs');
  assert.doesNotMatch(text, /^\s+-- az acr build/m, 'a bare `-- az acr build` brings the SAS-bound log stream back as the verdict');
  const wc = /--wall-clock (\d+)m/.exec(text);
  const mm = /--max-minutes (\d+)/.exec(text);
  assert.ok(wc && mm && Number(wc[1]) > Number(mm[1]), `retry wall-clock (${wc?.[1]}) must exceed the poll bound (${mm?.[1]})`);
});
