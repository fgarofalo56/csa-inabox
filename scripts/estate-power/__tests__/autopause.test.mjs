import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAutopause } from '../autopause.mjs';
import { readRecentPipelineRuns, discoverActivityTargets } from '../read-activity.mjs';
import { EXIT } from '../estate-power.mjs';
import {
  SENTINEL, ENV, ADF_ID, ESTATE_ID, SUB, RG, fakeSpawn, fakeFetch, ok, accepted, bad, capture, fakeClock,
  runningBody, previewBody, pausedBody, power,
} from './_fakes.mjs';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const emptyRest = () => ({ status: 0, stdout: JSON.stringify({ value: [] }), stderr: '', error: null });

function harness({ st = runningBody(), rest = emptyRest, register = null, list = null } = {}) {
  let paused = false;
  const fetchFn = fakeFetch((b) => {
    if (b.action === 'pause') { paused = true; return accepted({ state: 'PAUSING', estateId: ESTATE_ID }); }
    if (b.action === 'preview') return ok(previewBody());
    return ok(paused ? pausedBody('PAUSED', true) : st);
  });
  const c = capture();
  const summaryFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-')), 'summary.md');
  const spawn = fakeSpawn({ rest, list });
  const run = () => runAutopause({ boundary: 'Commercial' }, { env: ENV, spawn, fetchFn, register, summaryFile, now: () => NOW, sleep: fakeClock(NOW).sleep, ...c.deps });
  return { run, fetchFn, c, summaryFile, spawn };
}
const pauseCalls = (h) => h.fetchFn.calls.filter((x) => x.body.action === 'pause').length;

test('idle 5h with idleHours=4 (stored) and no runs: pauses with confirm=estateId (positive control) and writes the decision to the summary', async () => {
  const h = harness();
  assert.equal(await h.run(), EXIT.OK);
  assert.equal(pauseCalls(h), 1);
  assert.equal(h.fetchFn.calls.find((x) => x.body.action === 'pause').body.confirm, ESTATE_ID);
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

test('failed factory DISCOVERY (az resource list) => SKIP with the reason, no pause', async () => {
  const h = harness({ list: () => ({ status: 1, stdout: '', stderr: 'AuthorizationFailed listing', error: null }) });
  assert.equal(await h.run(), EXIT.OK);
  assert.equal(pauseCalls(h), 0);
  assert.match(h.c.out.join('\n'), /activity-read-failed/);
});

test('a pipeline run inside the idle window => SKIP', async () => {
  const recent = { status: 0, stdout: JSON.stringify({ value: [{ runStart: new Date(NOW - 3600e3).toISOString(), status: 'Succeeded' }] }), stderr: '', error: null };
  const h = harness({ rest: () => recent });
  assert.equal(await h.run(), EXIT.OK);
  assert.equal(pauseCalls(h), 0);
});

test('never auto-pause: lastActivityAt null / autoPause unreadable / autoPause disabled -- each skips and spends NO az calls (cheap pass first)', async () => {
  const cases = [
    ['null lastActivityAt', power({ activity: { lastActivityAt: null, idleForSeconds: null, unreadable: false } }), /activity-unknown/],
    ['unreadable source', power({ autoPause: { enabled: true, idleHours: 4, source: 'unreadable' } }), /autopause-unreadable/],
    ['disabled', power({ autoPause: { enabled: false, idleHours: 4, source: 'stored' } }), /autopause-disabled/],
  ];
  for (const [name, p, re] of cases) {
    const h = harness({ st: runningBody({ power: p }) });
    assert.equal(await h.run(), EXIT.OK, name);
    assert.equal(pauseCalls(h), 0, name);
    assert.match(h.c.out.join('\n'), re, name);
    assert.ok(!h.spawn.calls.some((a) => a[1] === 'rest' || a[1] === 'resource'), `${name}: no ARM reads when console fields already say skip`);
  }
});

test('estate already PAUSED per state => nothing done, exactly one console call (the state read)', async () => {
  const h = harness({ st: pausedBody('PAUSED', true) });
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
  const fetchFn = fakeFetch(() => ok(runningBody()));
  const code = await runAutopause({ boundary: 'GCC-High' }, { env: ENV, spawn: fakeSpawn({ cloud: 'AzureCloud' }), fetchFn, register: null, ...capture().deps });
  assert.equal(code, EXIT.BOUNDARY);
  assert.equal(fetchFn.calls.length, 0);
});

test('state read failure is RED (exit 1), not a quiet skip', async () => {
  const fetchFn = fakeFetch(() => bad(403, 'nope'));
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

test('discoverActivityTargets: derives (subscription, resource group) from the console preview and lists factories there', () => {
  const spawn = fakeSpawn();
  const r = discoverActivityTargets({ state: runningBody(), spawn });
  assert.deepEqual(r, { ok: true, targets: [{ kind: 'adf', id: ADF_ID, name: 'adf-loom' }] });
  const calls = spawn.calls.filter((a) => a[1] === 'resource');
  assert.equal(calls.length, 2, 'one per type (factories, workspaces) for the ONE distinct resource group, not per resource');
  assert.ok(calls.every((a) => a[a.indexOf('--subscription') + 1] === SUB && a[a.indexOf('--resource-group') + 1] === RG));
});

test('discoverActivityTargets: a state naming no resource group is UNKNOWN (ok:false), not an empty/idle answer', () => {
  const r = discoverActivityTargets({ state: runningBody({ preview: { wouldPause: [], wouldLeaveRunning: [] } }), spawn: fakeSpawn() });
  assert.equal(r.ok, false);
});

test('read-activity: no targets list => ok:false (unknown), an EMPTY list => ok with zero runs', () => {
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
  const bad2 = fakeSpawn({ rest: () => ({ status: 1, stdout: '', stderr: 'ResourceNotFound', error: null }) });
  assert.match(readRecentPipelineRuns({ targets: [{ kind: 'adf', id: ADF_ID, name: 'a' }], boundary: 'Commercial', now, windowHours: 4, spawn: bad2 }).reason, /ResourceNotFound/);
});

// ── console-side pipeline activity (server-side read; the runner cannot reach a
// private Synapse endpoint, run 39242926745) ────────────────────────────────
const azReads = (h) => h.spawn.calls.filter((a) => a[1] === 'rest' || a[1] === 'resource').length;

test('console-sent pipelineActivity ok + no runs => pauses WITHOUT any runner-side az read (the fix)', async () => {
  // Breaks if autopause ignores the console block: the runner read would run
  // (azReads > 0), hit the denied endpoint below, and skip instead of pausing.
  const st = runningBody({ power: power({ pipelineActivity: { ok: true, runs: [], sources: ['synapse'] } }) });
  const h = harness({ st, rest: () => ({ status: 1, stdout: '', stderr: 'PublicNetworkAccessDenied', error: null }) });
  assert.equal(await h.run(), EXIT.OK);
  assert.equal(pauseCalls(h), 1, 'positive: an idle estate with a clean console read is paused');
  assert.equal(azReads(h), 0, 'the runner must not re-read what the console already read');
  assert.match(h.c.out.join('\n'), /pipeline activity: read by the console \(sources: synapse\)/);
});

test('console-sent pipelineActivity with a recent run => SKIP', async () => {
  // Breaks if console runs are dropped on the way into the policy.
  const runs = [{ startedAt: new Date(NOW - 3600e3).toISOString(), status: 'Succeeded' }];
  const h = harness({ st: runningBody({ power: power({ pipelineActivity: { ok: true, runs, sources: ['adf'] } }) }) });
  assert.equal(await h.run(), EXIT.OK);
  assert.equal(pauseCalls(h), 0);
  assert.match(h.c.out.join('\n'), /recent-pipeline-run/);
});

test('console-sent ok:false or a MALFORMED block => SKIP, never treated as "no runs"', async () => {
  // Breaks if a failed or malformed console answer falls through to runs: [] (would pause a busy estate).
  for (const pa of [{ ok: false, reason: 'synapse: timeout', sources: ['synapse'] }, { ok: 'yes' }, { ok: true, sources: [] }]) {
    const h = harness({ st: runningBody({ power: power({ pipelineActivity: pa }) }) });
    assert.equal(await h.run(), EXIT.OK);
    assert.equal(pauseCalls(h), 0, `must not pause on ${JSON.stringify(pa)}`);
    assert.match(h.c.out.join('\n'), /activity-read-failed/);
  }
});

test('console sources are allowlisted before printing, and "none configured" raises a ::warning::', async () => {
  // Breaks if an unexpected source string reaches the public log, or if an
  // estate with no configured source pauses silently with no visible warning.
  const odd = runningBody({ power: power({ pipelineActivity: { ok: true, runs: [], sources: ['synapse', '<script>evil'] } }) });
  const h1 = harness({ st: odd });
  await h1.run();
  const o1 = h1.c.out.join('\n');
  assert.match(o1, /\(sources: synapse\)/);
  assert.ok(!o1.includes('evil'), 'a non-allowlisted source name must not be printed');
  const none = harness({ st: runningBody({ power: power({ pipelineActivity: { ok: true, runs: [], sources: [] } }) }) });
  await none.run();
  assert.match(none.c.out.join('\n'), /::warning::the console reports NO Data Factory or Synapse workspace configured/);
});

test('no console block (older console) => falls back to the runner read', async () => {
  // Breaks if the fallback is removed: azReads would be 0 for a console that sent nothing.
  const h = harness();
  assert.equal(await h.run(), EXIT.OK);
  assert.ok(azReads(h) > 0, 'the runner read ran');
  assert.match(h.c.out.join('\n'), /pipeline activity: read from the runner/);
});
