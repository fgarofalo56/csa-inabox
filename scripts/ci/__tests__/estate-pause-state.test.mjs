// estate-pause-state: the deploy lanes' stand-down verdict (PRP-02 step 6, #5111).
// Every assertion below names the value that would break it (assertion-design.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  UNKNOWN, STATES, interpretState, decideStandDown, readEstateState, renderVerdict, main,
} from '../estate-pause-state.mjs';
import {
  SENTINEL, ENV, fakeSpawn, fakeFetch, ok, bad, runningBody, pausedBody, resumeBody,
} from '../../estate-power/__tests__/_fakes.mjs';

const instantSleep = async () => {};
const read = (over = {}) => readEstateState({
  boundary: 'Commercial', env: ENV, spawn: fakeSpawn(), sleep: instantSleep, ...over,
});

// ── interpretState: only the five real states are believed ──────────────────
test('each console state maps to itself', () => {
  for (const s of ['RUNNING', 'PAUSING', 'PAUSED', 'RESUMING', 'RESUME_FAILED']) {
    assert.equal(interpretState({ state: s }).state, s, `state ${s} must survive interpretation`);
  }
});

test('an unrecognised / missing / non-string state is UNKNOWN, never RUNNING', () => {
  // Breaks if a renamed field (state -> status) or an empty body defaulted to RUNNING.
  for (const body of [{}, null, { state: 'paused' }, { state: 7 }, { status: 'PAUSED' }, { state: '' }]) {
    assert.equal(interpretState(body).state, UNKNOWN, `body ${JSON.stringify(body)} must be UNKNOWN`);
  }
});

test('pausedAt comes from the body, else power.lastPausedAt; pausedBy is never invented', () => {
  assert.equal(interpretState({ state: 'PAUSED', pausedAt: '2026-10-24T02:38:00Z' }).pausedAt, '2026-10-24T02:38:00Z');
  assert.equal(interpretState({ state: 'PAUSING', power: { lastPausedAt: '2026-10-24T02:00:00Z' } }).pausedAt, '2026-10-24T02:00:00Z');
  // The real console body has no pausedBy today: it must come back null, not 'unknown' or an app id.
  assert.equal(interpretState(pausedBody('PAUSED')).pausedBy, null);
  assert.equal(interpretState({ state: 'PAUSED', createdBy: 'sp:b9c3cc65' }).pausedBy, 'sp:b9c3cc65');
});

// ── decideStandDown ─────────────────────────────────────────────────────────
test('PAUSED and PAUSING stand down on every unattended event', () => {
  for (const state of ['PAUSED', 'PAUSING']) {
    for (const event of ['schedule', 'push', 'workflow_run', 'workflow_dispatch', '']) {
      assert.equal(decideStandDown({ state, event, override: false }).standdown, true, `${state}/${event} must stand down`);
    }
  }
});

test('RUNNING, RESUMING and RESUME_FAILED never stand down, on any event incl. schedule', () => {
  // Breaks if the fail-closed rule leaked from UNKNOWN to the readable states.
  for (const state of ['RUNNING', 'RESUMING', 'RESUME_FAILED']) {
    for (const event of ['schedule', 'workflow_dispatch', 'push']) {
      assert.equal(decideStandDown({ state, event, override: false }).standdown, false, `${state}/${event} must proceed`);
    }
  }
});

test('UNKNOWN on a SCHEDULE stands down (fail-closed) and says failClosed; override cannot bypass it', () => {
  // Breaks if UNKNOWN+schedule returns standdown:false (the 2026-10-24 run 40113111843 shape).
  const d = decideStandDown({ state: UNKNOWN, event: 'schedule', override: false });
  assert.deepEqual(d, { standdown: true, overridden: false, overrideIgnored: false, failClosed: true });
  const o = decideStandDown({ state: UNKNOWN, event: 'schedule', override: true });
  assert.equal(o.standdown, true, 'nobody is there to override a scheduled run');
  assert.equal(o.overrideIgnored, true);
});

test('UNKNOWN on workflow_dispatch and on every other event PROCEEDS (fail-open, failClosed=false)', () => {
  // Breaks if fail-closed widened past `schedule` (the decision named only schedule vs manual).
  for (const event of ['workflow_dispatch', 'push', 'workflow_run', 'workflow_call', '', undefined]) {
    const d = decideStandDown({ state: UNKNOWN, event, override: false });
    assert.equal(d.standdown, false, `UNKNOWN/${String(event)} must proceed`);
    assert.equal(d.failClosed, false);
  }
});

test('override on workflow_dispatch proceeds and says it overrode', () => {
  const d = decideStandDown({ state: 'PAUSED', event: 'workflow_dispatch', override: true });
  assert.deepEqual(d, { standdown: false, overridden: true, overrideIgnored: false, failClosed: false });
  assert.equal(decideStandDown({ state: 'PAUSED', event: 'workflow_dispatch', override: 'true' }).standdown, false, 'the string "true" is what Actions passes');
});

test('a schedule / push / workflow_run event CANNOT override', () => {
  for (const event of ['schedule', 'push', 'workflow_run', 'workflow_call', 'repository_dispatch']) {
    const d = decideStandDown({ state: 'PAUSED', event, override: true });
    assert.equal(d.standdown, true, `${event} with override=true must still stand down`);
    assert.equal(d.overrideIgnored, true, `${event} override must be reported as ignored`);
  }
});

test('override is false-by-default: undefined / "false" / "" do not override a dispatch', () => {
  for (const override of [undefined, false, 'false', '', 'no']) {
    assert.equal(decideStandDown({ state: 'PAUSED', event: 'workflow_dispatch', override }).standdown, true, `override=${String(override)}`);
  }
});

// ── readEstateState against fakes of the console ────────────────────────────
test('reads PAUSED through the console SP route with the az token', async () => {
  const fetchFn = fakeFetch(() => ok(pausedBody('PAUSED')));
  const r = await read({ fetchFn });
  assert.equal(r.state, 'PAUSED');
  assert.equal(fetchFn.calls.length, 1, 'exactly one state call');
  assert.deepEqual(fetchFn.calls[0].body, { action: 'state' }, 'it must ask for state, never pause/resume');
  assert.equal(fetchFn.calls[0].auth, `Bearer ${SENTINEL}`);
  assert.equal(fetchFn.calls[0].url, 'https://console.example.test/api/estate/power');
});

test('reads RUNNING and RESUME_FAILED bodies', async () => {
  assert.equal((await read({ fetchFn: fakeFetch(() => ok(runningBody())) })).state, 'RUNNING');
  assert.equal((await read({ fetchFn: fakeFetch(() => ok(resumeBody('RESUME_FAILED'))) })).state, 'RESUME_FAILED');
});

test('UNKNOWN: console 403 / 500 / network error / non-JSON all resolve to UNKNOWN with a reason', async () => {
  const cases = {
    forbidden: fakeFetch(() => bad(403, 'role missing')),
    server: fakeFetch(() => bad(500, 'boom')),
    garbage: fakeFetch(() => ({ status: 200, raw: '<html>front door</html>' })),
    network: async () => { throw new Error('ECONNRESET'); },
  };
  for (const [name, fetchFn] of Object.entries(cases)) {
    const r = await read({ fetchFn });
    assert.equal(r.state, UNKNOWN, `${name} must be UNKNOWN`);
    assert.ok(r.reason && r.reason.length > 10, `${name} must carry a reason`);
  }
});

test('UNKNOWN: missing URL, missing audience, wrong az cloud, token failure, unknown boundary', async () => {
  const never = fakeFetch(() => { throw new Error('must not be called'); });
  assert.equal((await read({ env: { CSA_LOOM_CONSOLE_AUDIENCE: 'api://x' }, fetchFn: never })).state, UNKNOWN);
  assert.equal((await read({ env: { CSA_LOOM_CONSOLE_URL: 'https://c.test' }, fetchFn: never })).state, UNKNOWN);
  assert.equal((await read({ env: { ...ENV, CSA_LOOM_CONSOLE_URL: 'http://c.test' }, fetchFn: never })).state, UNKNOWN, 'http (not https) must be refused');
  const gov = await read({ spawn: fakeSpawn({ cloud: 'AzureUSGovernment' }), fetchFn: never });
  assert.equal(gov.state, UNKNOWN, 'Commercial boundary on a Gov az session must not read');
  assert.equal((await read({ spawn: fakeSpawn({ tokenFails: true }), fetchFn: never })).state, UNKNOWN);
  assert.equal((await read({ boundary: 'Mars', fetchFn: never })).state, UNKNOWN);
  assert.equal(never.calls.length, 0, 'no console call may be made when preconditions fail');
});

test('boundary to az cloud: GCC-High and IL5 need Gov, Commercial and GCC need AzureCloud', async () => {
  const f = () => fakeFetch(() => ok(pausedBody('PAUSED')));
  assert.equal((await read({ boundary: 'GCC-High', spawn: fakeSpawn({ cloud: 'AzureUSGovernment' }), fetchFn: f() })).state, 'PAUSED');
  assert.equal((await read({ boundary: 'IL5', spawn: fakeSpawn({ cloud: 'AzureUSGovernment' }), fetchFn: f() })).state, 'PAUSED');
  assert.equal((await read({ boundary: 'GCC', spawn: fakeSpawn({ cloud: 'AzureCloud' }), fetchFn: f() })).state, 'PAUSED');
  assert.equal((await read({ boundary: 'GCC-High', spawn: fakeSpawn({ cloud: 'AzureCloud' }), fetchFn: f() })).state, UNKNOWN);
});

test('the token never appears in the returned verdict', async () => {
  const r = await read({ fetchFn: fakeFetch(() => bad(500, `leak ${SENTINEL}`)) });
  assert.ok(!JSON.stringify(r).includes(SENTINEL), 'bearer token must be scrubbed from the reason');
});

// ── main(): outputs, summary, annotations ───────────────────────────────────
function harness(fetchFn, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eps-'));
  const outputFile = path.join(dir, 'out');
  const summaryFile = path.join(dir, 'sum');
  fs.writeFileSync(outputFile, '');
  fs.writeFileSync(summaryFile, '');
  const lines = [];
  const env = { ...ENV, GITHUB_EVENT_NAME: 'schedule', OVERRIDE_ESTATE_PAUSE: 'false', ...over };
  const run = () => main(['--boundary', 'Commercial'], {
    env, spawn: fakeSpawn(), fetchFn, sleep: instantSleep, outputFile, summaryFile, log: (s) => lines.push(s),
  });
  const outputs = () => Object.fromEntries(fs.readFileSync(outputFile, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { run, outputs, lines, summary: () => fs.readFileSync(summaryFile, 'utf8') };
}

test('scheduled run on a PAUSED estate: standdown=true, summary says "Stood down: estate paused"', async () => {
  const h = harness(fakeFetch(() => ok({ ...pausedBody('PAUSED'), pausedAt: '2026-10-24T02:38:00Z', pausedBy: 'frank@example.test' })));
  await h.run();
  const o = h.outputs();
  assert.equal(o.state, 'PAUSED');
  assert.equal(o.standdown, 'true');
  assert.equal(o.paused_by, 'frank@example.test');
  assert.equal(o.paused_at, '2026-10-24T02:38:00Z');
  assert.match(h.summary(), /Stood down: estate paused/);
  assert.match(h.summary(), /Nothing was deployed/);
  assert.match(h.lines.join('\n'), /^::notice::STOOD DOWN/m);
  assert.match(h.lines.join('\n'), /override_estate_pause=true/);
});

test('scheduled run with override=true on a PAUSED estate STILL stands down', async () => {
  const h = harness(fakeFetch(() => ok(pausedBody('PAUSED'))), { OVERRIDE_ESTATE_PAUSE: 'true', GITHUB_EVENT_NAME: 'schedule' });
  await h.run();
  assert.equal(h.outputs().standdown, 'true');
});

test('dispatch with override=true proceeds with a ::warning::', async () => {
  const h = harness(fakeFetch(() => ok(pausedBody('PAUSED'))), { OVERRIDE_ESTATE_PAUSE: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch' });
  await h.run();
  assert.equal(h.outputs().standdown, 'false');
  assert.match(h.lines.join('\n'), /^::warning::OVERRIDE/m);
});

test('SCHEDULED run, unreadable state: standdown=true, state=UNKNOWN, summary says it stood down fail-closed', async () => {
  const h = harness(fakeFetch(() => bad(503, 'console not configured')), { GITHUB_EVENT_NAME: 'schedule' });
  const res = await h.run();
  assert.equal(res.decision.failClosed, true);
  const o = h.outputs();
  assert.equal(o.state, 'UNKNOWN');
  assert.equal(o.standdown, 'true', 'a scheduled run that cannot read the state must stand down');
  assert.match(o.reason, /console state read failed/, 'the reason is still recorded');
  assert.match(h.lines.join('\n'), /^::notice::STOOD DOWN: estate state UNKNOWN on a scheduled run: standing down \(fail-closed\); the next scheduled run retries/m);
  assert.match(h.summary(), /Stood down: estate state could not be established on a scheduled run \(fail-closed\)/);
  assert.match(h.summary(), /Nothing was deployed/);
  assert.ok(!/WILL wake it|PROCEEDING/.test(h.lines.join('\n') + h.summary()), 'a stood-down run must not claim it proceeds');
});

test('unreadable state on a DISPATCH: standdown=false, state=UNKNOWN, loud ::warning::, reason recorded', async () => {
  const h = harness(fakeFetch(() => bad(503, 'console not configured')), { GITHUB_EVENT_NAME: 'workflow_dispatch' });
  const res = await h.run();
  assert.equal(res.decision.standdown, false, 'an unreadable read must not freeze a manual deploy (R1)');
  const o = h.outputs();
  assert.equal(o.state, 'UNKNOWN');
  assert.equal(o.standdown, 'false');
  assert.match(o.reason, /console state read failed/);
  assert.match(h.lines.join('\n'), /^::warning::estate-pause-state is UNKNOWN/m);
  assert.match(h.lines.join('\n'), /WILL wake it/);
});

test('RUNNING: proceeds with a notice, standdown=false', async () => {
  const h = harness(fakeFetch(() => ok(runningBody())));
  await h.run();
  assert.equal(h.outputs().standdown, 'false');
  assert.equal(h.outputs().state, 'RUNNING');
});

test('console-supplied text cannot inject a workflow command or a second output line', async () => {
  const evil = 'x\n::set-output name=standdown::false\nstanddown=false';
  const h = harness(fakeFetch(() => ok({ ...pausedBody('PAUSED'), pausedBy: evil })));
  await h.run();
  const raw = h.lines.join('\n');
  assert.equal(raw.split('\n').filter((l) => l.startsWith('::')).length, 1, 'exactly one workflow command line');
  const o = h.outputs();
  assert.equal(o.standdown, 'true', 'a forged standdown=false line in pausedBy must not win');
  assert.ok(!h.summary().includes('::set-output'));
});

test('main never throws, even with no boundary and no env', async () => {
  const lines = [];
  const res = await main([], { env: {}, log: (s) => lines.push(s), sleep: instantSleep });
  assert.equal(res.read.state, UNKNOWN);
  assert.equal(res.decision.standdown, false);
});

test('the state vocabulary is exactly the six the workflows and docs name', () => {
  assert.deepEqual([...STATES].sort(), ['PAUSED', 'PAUSING', 'RESUMING', 'RESUME_FAILED', 'RUNNING', 'UNKNOWN'].sort());
});

// renderVerdict is pure: the fields operators read.
test('stand-down text names who, when, and both ways to proceed', () => {
  const v = renderVerdict({
    boundary: 'Commercial', state: 'PAUSED', pausedAt: '2026-10-24T02:38:00Z', pausedBy: 'frank',
    decision: { standdown: true }, event: 'schedule',
  });
  for (const needle of ['frank', '2026-10-24T02:38:00Z', 'Estate power', 'override_estate_pause=true']) {
    assert.ok(v.text.includes(needle), `notice must contain ${needle}`);
  }
});
