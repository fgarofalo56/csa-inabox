import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAutopause } from '../autopause.mjs';
import { readRecentPipelineRuns } from '../read-activity.mjs';
import { EXIT } from '../estate-power.mjs';
import { SENTINEL, ENV, ADF_ID, RES, fakeSpawn, fakeFetch, ok, capture, fakeClock } from './_fakes.mjs';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const state = (over = {}) => ({
  overall: 'RUNNING', inFlight: false, lastActivityAt: new Date(NOW - 5 * 3600e3).toISOString(),
  autoPause: { enabled: true, idleHours: 4 }, resources: RES('Online'), confirmToken: 'tok',
  activityTargets: [{ kind: 'adf', id: ADF_ID, name: 'adf-loom' }], ...over,
});
const emptyRest = () => ({ status: 0, stdout: JSON.stringify({ value: [] }), stderr: '', error: null });
function harness({ st = state(), rest = emptyRest, register = null } = {}) {
  let paused = false;
  const fetchFn = fakeFetch((b) => {
    if (b.action === 'pause') { paused = true; return ok({}); }
    if (b.action === 'preview') return ok(st);
    return ok({ ...st, resources: RES(paused ? 'Paused' : 'Online') });
  });
  const c = capture();
  const summaryFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-')), 'summary.md');
  const spawn = fakeSpawn({ rest });
  const run = () => runAutopause({ boundary: 'Commercial' }, { env: ENV, spawn, fetchFn, register, summaryFile, now: () => NOW, sleep: fakeClock(NOW).sleep, ...c.deps });
  return { run, fetchFn, c, summaryFile, spawn };
}
const pauseCalls = (h) => h.fetchFn.calls.filter((x) => x.body.action === 'pause').length;

test('idle 5h with idleHours=4 and no runs: pauses (positive control) and writes the decision to the summary', async () => {
  const h = harness();
  assert.equal(await h.run(), EXIT.OK);
  assert.equal(pauseCalls(h), 1);
  assert.match(fs.readFileSync(h.summaryFile, 'utf8'), /Decision: \*\*pause\*\*/);
});

test('failed activity read => SKIP, no pause sent, the reason is on stdout and a ::warning:: is raised', async () => {
  // Input that breaks it: treating ok:false as "no runs" pauses a busy estate.
  const h = harness({ rest: () => ({ status: 1, stdout: '', stderr: 'AuthorizationFailed', error: null }) });
  assert.equal(await h.run(), EXIT.OK);
  assert.equal(pauseCalls(h), 0);
  const out = h.c.out.join('\n');
  assert.match(out, /::warning::pipeline activity not established.*AuthorizationFailed/);
  assert.match(out, /SKIP \(activity-read-failed\)/);
});

test('a pipeline run inside the idle window => SKIP', async () => {
  const recent = { status: 0, stdout: JSON.stringify({ value: [{ runStart: new Date(NOW - 3600e3).toISOString(), status: 'Succeeded' }] }), stderr: '', error: null };
  const h = harness({ rest: () => recent });
  assert.equal(await h.run(), EXIT.OK);
  assert.equal(pauseCalls(h), 0);
});

test('unknown lastActivityAt => SKIP, no pause', async () => {
  const h = harness({ st: state({ lastActivityAt: null }) });
  assert.equal(await h.run(), EXIT.OK);
  assert.equal(pauseCalls(h), 0);
  assert.match(h.c.out.join('\n'), /activity-unknown/);
});

test('boundary already paused per state => nothing done, exactly one console call (the state read)', async () => {
  const h = harness({ st: state({ overall: 'PAUSED' }) });
  assert.equal(await h.run(), EXIT.OK);
  assert.equal(h.fetchFn.calls.length, 1);
});

test('declared pause in the register => SKIP even though the estate reads idle and RUNNING', async () => {
  const register = { paused: [{ boundary: 'Commercial', owner: 'frank', declaredOn: '2026-10-01', reviewBy: '2026-12-01', reason: 'x'.repeat(80) }] };
  const h = harness({ register });
  assert.equal(await h.run(), EXIT.OK);
  assert.equal(pauseCalls(h), 0);
  assert.match(h.c.out.join('\n'), /declared-paused/);
});

test('wrong az cloud => refuses before any console call', async () => {
  const fetchFn = fakeFetch(() => ok(state()));
  const code = await runAutopause({ boundary: 'GCC-High' }, { env: ENV, spawn: fakeSpawn({ cloud: 'AzureCloud' }), fetchFn, register: null, ...capture().deps });
  assert.equal(code, EXIT.BOUNDARY);
  assert.equal(fetchFn.calls.length, 0);
});

test('state read failure is RED (exit 1), not a quiet skip', async () => {
  const fetchFn = fakeFetch(() => ({ status: 403, json: { ok: false, error: 'nope' } }));
  const code = await runAutopause({ boundary: 'Commercial' }, { env: ENV, spawn: fakeSpawn(), fetchFn, register: null, ...capture().deps, ...fakeClock() });
  assert.equal(code, EXIT.FAILED);
});

test('token sentinel never appears in stdout/stderr/summary of a full pause run', async () => {
  const h = harness();
  await h.run();
  const all = [...h.c.out, ...h.c.err, fs.readFileSync(h.summaryFile, 'utf8')].join('\n');
  assert.ok(!all.includes(SENTINEL));
  assert.equal(h.fetchFn.calls[0].auth, `Bearer ${SENTINEL}`, 'positive: the token was used');
});

// ── read-activity ──────────────────────────────────────────────────────────
const now = new Date(NOW);

test('read-activity: no activityTargets list => ok:false (unknown), an EMPTY list => ok with zero runs', () => {
  assert.equal(readRecentPipelineRuns({ targets: undefined, boundary: 'Commercial', now, windowHours: 4, spawn: fakeSpawn() }).ok, false);
  const r = readRecentPipelineRuns({ targets: [], boundary: 'Commercial', now, windowHours: 4, spawn: fakeSpawn() });
  assert.deepEqual(r, { ok: true, runs: [] });
});

test('read-activity: a target id that is not a Data Factory resource id is refused, az never called', () => {
  const spawn = fakeSpawn();
  const r = readRecentPipelineRuns({ targets: [{ kind: 'adf', id: '/subscriptions/x/../../evil', name: 'e' }], boundary: 'Commercial', now, windowHours: 4, spawn });
  assert.equal(r.ok, false);
  assert.equal(spawn.calls.length, 0);
});

test('read-activity: GCC-High reads through the USGov ARM host; Commercial through management.azure.com', () => {
  for (const [b, host] of [['Commercial', 'https://management.azure.com/'], ['GCC-High', 'https://management.usgovcloudapi.net/']]) {
    const spawn = fakeSpawn();
    readRecentPipelineRuns({ targets: [{ kind: 'adf', id: ADF_ID, name: 'a' }], boundary: b, now, windowHours: 4, spawn });
    const restCall = spawn.calls.find((a) => a[1] === 'rest');
    const url = restCall[restCall.indexOf('--url') + 1];
    assert.ok(String(url).startsWith(host), `${b}: ${url}`);
  }
});

test('read-activity: continuation beyond MAX_PAGES refuses to call a partial read idle', () => {
  const spawn = fakeSpawn({ rest: () => ({ status: 0, stdout: JSON.stringify({ value: [], continuationToken: 'more' }), stderr: '', error: null }) });
  const r = readRecentPipelineRuns({ targets: [{ kind: 'adf', id: ADF_ID, name: 'a' }], boundary: 'Commercial', now, windowHours: 4, spawn });
  assert.equal(r.ok, false);
  assert.match(r.reason, /more than 5 pages/);
});

test('read-activity: unsupported kind and az failure are surfaced, not swallowed', () => {
  assert.match(readRecentPipelineRuns({ targets: [{ kind: 'databricks' }], boundary: 'Commercial', now, windowHours: 4, spawn: fakeSpawn() }).reason, /not supported/);
  const bad = fakeSpawn({ rest: () => ({ status: 1, stdout: '', stderr: 'ResourceNotFound', error: null }) });
  assert.match(readRecentPipelineRuns({ targets: [{ kind: 'adf', id: ADF_ID, name: 'a' }], boundary: 'Commercial', now, windowHours: 4, spawn: bad }).reason, /ResourceNotFound/);
});
