import test from 'node:test';
import assert from 'node:assert/strict';
import {
  main, runPower, parseArgs, endpointUrl, classifyFailure, shouldRetry, verifyTarget,
  EXIT, MAX_ATTEMPTS,
} from '../estate-power.mjs';
import { classifyCloud } from '../contract.mjs';
import { SENTINEL, ENV, RES, fakeSpawn, fakeFetch, ok, capture, fakeClock } from './_fakes.mjs';

const base = (over = {}) => ({ boundary: 'Commercial', action: 'state', dryRun: false, confirm: null, timeoutMin: 5, ...over });

test('boundary guard: GCC-High requested while az is AzureCloud refuses with ZERO token and ZERO network calls', async () => {
  // Input that breaks it: removing assertBoundary makes fetch.calls.length 1 and the exit 0.
  const spawn = fakeSpawn({ cloud: 'AzureCloud' });
  const fetchFn = fakeFetch(() => ok({ resources: RES('Online') }));
  const c = capture();
  const code = await runPower(base({ boundary: 'GCC-High', action: 'resume' }), { env: ENV, spawn, fetchFn, ...c.deps, ...fakeClock() });
  assert.equal(code, EXIT.BOUNDARY);
  assert.equal(fetchFn.calls.length, 0, 'no console call may precede the boundary check');
  assert.ok(!spawn.calls.some((a) => a.includes('get-access-token')), 'no token may be requested for the wrong cloud');
  assert.match(c.err.join('\n'), /requires az cloud AzureUSGovernment but the active az cloud is AzureCloud/);
});

test('boundary guard POSITIVE CONTROL: matching clouds proceed (both boundaries)', async () => {
  for (const [boundary, cloud] of [['Commercial', 'AzureCloud'], ['GCC-High', 'AzureUSGovernment']]) {
    const fetchFn = fakeFetch(() => ok({ resources: RES('Online') }));
    const c = capture();
    const code = await runPower(base({ boundary }), { env: ENV, spawn: fakeSpawn({ cloud }), fetchFn, ...c.deps, ...fakeClock() });
    assert.equal(code, EXIT.OK, boundary);
    assert.equal(fetchFn.calls.length, 1, boundary);
  }
});

test('boundary guard: an unreadable az cloud is a refusal, never a pass', async () => {
  const fetchFn = fakeFetch(() => ok({}));
  const code = await runPower(base(), { env: ENV, spawn: fakeSpawn({ accountFails: true }), fetchFn, ...capture().deps, ...fakeClock() });
  assert.equal(code, EXIT.BOUNDARY);
  assert.equal(fetchFn.calls.length, 0);
});

test('classifyCloud: a sovereign az for Commercial is refused (the Commercial/Gov swap in both directions)', () => {
  assert.equal(classifyCloud('Commercial', 'AzureUSGovernment').ok, false);
  assert.equal(classifyCloud('GCC-High', 'AzureCloud').ok, false);
  assert.equal(classifyCloud('GCC-High', 'AzureUSGovernment').ok, true);
  assert.equal(classifyCloud('GCC-High', '').ok, false);
  assert.equal(classifyCloud('Nope', 'AzureCloud').ok, false);
});

test('token never reaches stdout/stderr even when the server echoes it; it IS sent as the bearer', async () => {
  // Input that breaks it: deleting scrub() from out/err leaves SENTINEL in the echoed error.
  const spawn = fakeSpawn();
  const fetchFn = fakeFetch(() => ({ status: 400, json: { ok: false, error: `bad request, you sent Bearer ${SENTINEL}` } }));
  const c = capture();
  const code = await runPower(base(), { env: ENV, spawn, fetchFn, ...c.deps, ...fakeClock() });
  assert.equal(code, EXIT.FAILED);
  assert.equal(fetchFn.calls[0].auth, `Bearer ${SENTINEL}`, 'positive: the token was actually in use');
  const all = [...c.out, ...c.err].join('\n');
  assert.ok(!all.includes(SENTINEL), 'sentinel token leaked');
  assert.match(all, /\[REDACTED\]/, 'positive: the echo was redacted, not dropped');
  assert.ok(!spawn.calls.some((a) => a.join(' ').includes(SENTINEL)), 'token must not be in any argv');
});

test('pause: preview -> pause(confirm + confirmToken from preview) -> poll; exit 0 only once read back Paused', async () => {
  let polls = 0;
  const fetchFn = fakeFetch((b) => {
    if (b.action === 'preview') return ok({ resources: RES('Online'), confirmToken: 'tok-from-preview' });
    if (b.action === 'pause') return ok({});
    polls += 1;
    return ok({ resources: RES(polls < 2 ? 'Pausing' : 'Paused') });
  });
  const c = capture();
  const code = await runPower(base({ action: 'pause', confirm: 'PAUSE' }), { env: ENV, spawn: fakeSpawn(), fetchFn, ...c.deps, ...fakeClock() });
  assert.equal(code, EXIT.OK);
  assert.deepEqual(fetchFn.calls.map((x) => x.body.action), ['preview', 'pause', 'state', 'state']);
  assert.equal(fetchFn.calls[1].body.confirmToken, 'tok-from-preview');
  assert.equal(fetchFn.calls[1].body.confirm, 'PAUSE');
  assert.match(c.out.join('\n'), /aas-one \| Microsoft\.AnalysisServices\/servers \| Online/, 'the real set is printed');
});

test('poll loop exits NON-ZERO when a resource never reaches the target state, naming it', async () => {
  // Input that breaks it: a loop that returns OK after the first state read (or after the timeout).
  const fetchFn = fakeFetch((b) => {
    if (b.action === 'preview') return ok({ resources: RES('Online'), confirmToken: 't' });
    if (b.action === 'pause') return ok({});
    return ok({ resources: [{ name: 'aas-one', type: 'Microsoft.AnalysisServices/servers', state: 'Paused' }, { name: 'adx-one', type: 'Microsoft.Kusto/clusters', state: 'Pausing' }] });
  });
  const c = capture();
  const code = await runPower(base({ action: 'pause', confirm: 'PAUSE', timeoutMin: 2 }), { env: ENV, spawn: fakeSpawn(), fetchFn, ...c.deps, ...fakeClock() });
  assert.equal(code, EXIT.FAILED);
  const e = c.err.join('\n');
  assert.match(e, /1 of 2 resource\(s\) were NOT read back/);
  assert.match(e, /adx-one \| Microsoft\.Kusto\/clusters \| Pausing/);
  assert.ok(!/aas-one \|.*Paused \(/.test(e), 'the resource that DID pause is not listed as a failure');
  assert.ok(fetchFn.calls.filter((x) => x.body.action === 'state').length >= 2, 'it polled more than once before giving up');
});

test('verifyTarget: a resource ABSENT from the read-back is a failure, not a pass', () => {
  const v = verifyTarget([{ name: 'a', type: 't', state: 'Paused' }], [{ name: 'a', type: 't' }, { name: 'b', type: 't' }], ['Paused']);
  assert.equal(v.ok, false);
  assert.deepEqual(v.failures.map((f) => f.name), ['b']);
  assert.equal(verifyTarget([{ name: 'a', type: 't', state: 'Stopped' }], [{ name: 'a', type: 't' }], ['Paused', 'Stopped']).ok, true, 'positive control');
});

test('pause without --confirm: exit 2 and the pause call is never sent', async () => {
  const fetchFn = fakeFetch((b) => ok({ resources: RES('Online'), confirmToken: 't' }));
  const code = await runPower(base({ action: 'pause' }), { env: ENV, spawn: fakeSpawn(), fetchFn, ...capture().deps, ...fakeClock() });
  assert.equal(code, EXIT.USAGE);
  assert.deepEqual(fetchFn.calls.map((x) => x.body.action), ['preview']);
});

test('pause with preview returning NO confirmToken or no resources: fails, pause never sent', async () => {
  for (const data of [{ resources: RES('Online') }, { resources: [], confirmToken: 't' }, {}]) {
    const fetchFn = fakeFetch(() => ok(data));
    const code = await runPower(base({ action: 'pause', confirm: 'PAUSE' }), { env: ENV, spawn: fakeSpawn(), fetchFn, ...capture().deps, ...fakeClock() });
    assert.equal(code, EXIT.FAILED, JSON.stringify(data));
    assert.ok(!fetchFn.calls.some((x) => x.body.action === 'pause'), JSON.stringify(data));
  }
});

test('--dry-run pause/resume reads but sends no mutation', async () => {
  for (const action of ['pause', 'resume']) {
    const fetchFn = fakeFetch(() => ok({ resources: RES('Online'), confirmToken: 't' }));
    const code = await runPower(base({ action, dryRun: true, confirm: 'PAUSE' }), { env: ENV, spawn: fakeSpawn(), fetchFn, ...capture().deps, ...fakeClock() });
    assert.equal(code, EXIT.OK);
    assert.equal(fetchFn.calls.length, 1);
    assert.notEqual(fetchFn.calls[0].body.action, action);
  }
});

test('resume: state -> resume -> poll until Online; exit 0', async () => {
  let n = 0;
  const fetchFn = fakeFetch((b) => {
    if (b.action === 'resume') return ok({});
    n += 1;
    return ok({ resources: RES(n === 1 ? 'Paused' : 'Online') });
  });
  const code = await runPower(base({ action: 'resume' }), { env: ENV, spawn: fakeSpawn(), fetchFn, ...capture().deps, ...fakeClock() });
  assert.equal(code, EXIT.OK);
  assert.deepEqual(fetchFn.calls.map((x) => x.body.action), ['state', 'resume', 'state']);
});

test('retry: a persistent 503 on a read is retried exactly MAX_ATTEMPTS then FAILS CLOSED', async () => {
  const fetchFn = fakeFetch(() => ({ status: 503, json: { ok: false, error: 'busy' } }));
  const c = capture();
  const code = await runPower(base(), { env: ENV, spawn: fakeSpawn(), fetchFn, ...c.deps, ...fakeClock() });
  assert.equal(code, EXIT.FAILED);
  assert.equal(fetchFn.calls.length, MAX_ATTEMPTS);
  assert.match(c.err.join('\n'), /\[transient\] after 3 attempt/);
});

test('retry: 403 is NOT retried (1 attempt) and the remediation names Estate.Power', async () => {
  const fetchFn = fakeFetch(() => ({ status: 403, json: { ok: false, error: 'forbidden' } }));
  const c = capture();
  assert.equal(await runPower(base(), { env: ENV, spawn: fakeSpawn(), fetchFn, ...c.deps, ...fakeClock() }), EXIT.FAILED);
  assert.equal(fetchFn.calls.length, 1);
  assert.match(c.err.join('\n'), /Estate\.Power/);
});

test('retry: a MUTATING call is not blindly re-sent on a network error; outcome stated as unverified', async () => {
  const fetchFn = fakeFetch((b) => {
    if (b.action === 'preview') return ok({ resources: RES('Online'), confirmToken: 't' });
    throw new Error('socket hang up');
  });
  const c = capture();
  const code = await runPower(base({ action: 'pause', confirm: 'PAUSE' }), { env: ENV, spawn: fakeSpawn(), fetchFn, ...c.deps, ...fakeClock() });
  assert.equal(code, EXIT.FAILED);
  assert.equal(fetchFn.calls.filter((x) => x.body.action === 'pause').length, 1, 'pause sent exactly once');
  assert.match(c.err.join('\n'), /may or may not have been applied/);
});

test('classification table', () => {
  const cases = [
    [{ status: 429 }, 'transient'], [{ status: 502 }, 'transient'], [{ status: 504 }, 'transient'],
    [{ networkError: true }, 'transient'], [{ status: 401 }, 'permission'], [{ status: 403 }, 'permission'],
    [{ status: 409 }, 'config'], [{ status: 422 }, 'config'], [{ status: 507 }, 'quota'],
    [{ status: 503, message: 'SkuNotAvailable in region' }, 'quota'], [{ status: 500 }, 'defect'],
  ];
  for (const [input, want] of cases) assert.equal(classifyFailure(input), want, JSON.stringify(input));
});

test('shouldRetry: only transient, bounded; mutating only on 429/503', () => {
  const t = { kind: 'transient', attempt: 1, mutating: false };
  assert.equal(shouldRetry(t), true);
  assert.equal(shouldRetry({ ...t, attempt: MAX_ATTEMPTS }), false, 'budget exhausted');
  for (const kind of ['permission', 'quota', 'config', 'defect']) assert.equal(shouldRetry({ ...t, kind }), false, kind);
  assert.equal(shouldRetry({ ...t, mutating: true, status: 429 }), true);
  assert.equal(shouldRetry({ ...t, mutating: true, status: 503 }), true);
  assert.equal(shouldRetry({ ...t, mutating: true, status: 504 }), false);
  assert.equal(shouldRetry({ ...t, mutating: true, networkError: true }), false);
});

test('endpointUrl: http, credentials and paths are rejected; a plain https origin passes', () => {
  assert.equal(endpointUrl('http://c.example.test'), null);
  assert.equal(endpointUrl('https://u:p@c.example.test'), null);
  assert.equal(endpointUrl('https://c.example.test/evil'), null);
  assert.equal(endpointUrl(undefined), null);
  assert.equal(endpointUrl('https://c.example.test'), 'https://c.example.test/api/estate/power');
});

test('parseArgs / main: bad boundary and bad action exit 2 without running anything', async () => {
  assert.throws(() => parseArgs(['--boundary', 'IL5', '--action', 'state']));
  assert.throws(() => parseArgs(['--boundary', 'Commercial', '--action', 'nuke']));
  assert.throws(() => parseArgs(['--boundary', 'Commercial', '--action', 'state', '--bogus']));
  const c = capture();
  assert.equal(await main(['--boundary', 'IL5', '--action', 'state'], c.deps), EXIT.USAGE);
});

test('missing console URL / audience: exit 2 before the az cloud is even read', async () => {
  const spawn = fakeSpawn();
  assert.equal(await runPower(base(), { env: {}, spawn, ...capture().deps }), EXIT.USAGE);
  assert.equal(await runPower(base(), { env: { CSA_LOOM_CONSOLE_URL: ENV.CSA_LOOM_CONSOLE_URL }, spawn, ...capture().deps }), EXIT.USAGE);
  assert.equal(spawn.calls.length, 0);
});
