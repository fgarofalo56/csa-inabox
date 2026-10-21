import test from 'node:test';
import assert from 'node:assert/strict';
import {
  main, runPower, parseArgs, endpointUrl, classifyFailure, shouldRetry, verifyPaused, verifyResumed,
  EXIT, MAX_ATTEMPTS,
} from '../estate-power.mjs';
import { classifyCloud, parseEnvelope, pauseSetOf } from '../contract.mjs';
import {
  SENTINEL, ENV, ESTATE_ID, AAS_ID, ADX_ID, fakeSpawn, fakeFetch, ok, accepted, bad, capture, fakeClock,
  runningBody, previewBody, pausedBody, resumeBody, progressRows,
} from './_fakes.mjs';

const base = (over = {}) => ({ boundary: 'Commercial', action: 'state', dryRun: false, confirm: null, timeoutMin: 5, ...over });
const run = (args, fetchFn, extra = {}) => {
  const c = capture();
  return runPower(args, { env: ENV, spawn: fakeSpawn(), fetchFn, ...c.deps, ...fakeClock(), ...extra }).then((code) => ({ code, c }));
};
const actions = (f) => f.calls.map((x) => x.body.action);

/** A console that walks the real state machine for pause. */
function pausingConsole({ finalAtExpected = true, pollsBeforeDone = 1 } = {}) {
  let phase = 'running';
  let polls = 0;
  return fakeFetch((b) => {
    if (b.action === 'preview') return ok(previewBody());
    if (b.action === 'pause') { phase = 'pausing'; return accepted({ state: 'PAUSING', estateId: ESTATE_ID, snapshotId: 's1' }); }
    if (phase === 'running') return ok(runningBody());
    polls += 1;
    return ok(polls <= pollsBeforeDone ? pausedBody('PAUSING', false) : pausedBody('PAUSED', finalAtExpected));
  });
}

test('boundary guard: GCC-High requested while az is AzureCloud refuses with ZERO token and ZERO network calls', async () => {
  // Input that breaks it: removing assertBoundary makes fetch.calls.length 1 and the exit 0.
  const spawn = fakeSpawn({ cloud: 'AzureCloud' });
  const fetchFn = fakeFetch(() => ok(runningBody()));
  const c = capture();
  const code = await runPower(base({ boundary: 'GCC-High', action: 'resume' }), { env: ENV, spawn, fetchFn, ...c.deps, ...fakeClock() });
  assert.equal(code, EXIT.BOUNDARY);
  assert.equal(fetchFn.calls.length, 0, 'no console call may precede the boundary check');
  assert.ok(!spawn.calls.some((a) => a.includes('get-access-token')), 'no token may be requested for the wrong cloud');
  assert.match(c.err.join('\n'), /requires az cloud AzureUSGovernment but the active az cloud is AzureCloud/);
});

test('boundary guard POSITIVE CONTROL: matching clouds proceed (both boundaries)', async () => {
  for (const [boundary, cloud] of [['Commercial', 'AzureCloud'], ['GCC-High', 'AzureUSGovernment']]) {
    const fetchFn = fakeFetch(() => ok(runningBody()));
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

test('classifyCloud: a sovereign az for Commercial is refused (the swap in both directions)', () => {
  assert.equal(classifyCloud('Commercial', 'AzureUSGovernment').ok, false);
  assert.equal(classifyCloud('GCC-High', 'AzureCloud').ok, false);
  assert.equal(classifyCloud('GCC-High', 'AzureUSGovernment').ok, true);
  assert.equal(classifyCloud('GCC-High', '').ok, false);
  assert.equal(classifyCloud('Nope', 'AzureCloud').ok, false);
});

test('token never reaches stdout/stderr even when the server echoes it; it IS sent as the bearer', async () => {
  // Input that breaks it: deleting scrub() from out/err leaves SENTINEL in the echoed error.
  const spawn = fakeSpawn();
  const fetchFn = fakeFetch(() => bad(400, `bad request, you sent Bearer ${SENTINEL}`));
  const c = capture();
  const code = await runPower(base(), { env: ENV, spawn, fetchFn, ...c.deps, ...fakeClock() });
  assert.equal(code, EXIT.FAILED);
  assert.equal(fetchFn.calls[0].auth, `Bearer ${SENTINEL}`, 'positive: the token was actually in use');
  const all = [...c.out, ...c.err].join('\n');
  assert.ok(!all.includes(SENTINEL), 'sentinel token leaked');
  assert.match(all, /\[REDACTED\]/, 'positive: the echo was redacted, not dropped');
  assert.ok(!spawn.calls.some((a) => a.join(' ').includes(SENTINEL)), 'token must not be in any argv');
});

test('a non-JSON reply is DESCRIBED (status, content-type, snippet), and a token in it is still scrubbed', async () => {
  // Run 39206594987 (2026-10-19) printed only "response was not a JSON object",
  // which could not tell a Front Door/WAF page from an HTML 5xx or an empty 200.
  // Input that breaks it: reverting to res.json() drops "HTTP 403 (text/html)"
  // and the "<html" snippet from the message.
  const fetchFn = fakeFetch(() => ({ status: 403, raw: `<html><body>Request blocked. token=${SENTINEL}</body></html>` }));
  const { code, c } = await run(base(), fetchFn);
  assert.equal(code, EXIT.FAILED);
  const all = [...c.out, ...c.err].join('\n');
  assert.match(all, /HTTP 403 \(text\/html\) body was not JSON: <html><body>Request blocked/);
  assert.ok(!all.includes(SENTINEL), 'a token echoed in the HTML body must still be scrubbed');
  // An empty 200 is named as such, not as a parse failure of nothing.
  const empty = await run(base(), fakeFetch(() => ({ status: 200, raw: '', contentType: 'text/plain' })));
  assert.match([...empty.c.out, ...empty.c.err].join('\n'), /HTTP 200 \(text\/plain\) body was not JSON \(empty body\)/);
});

test('parseEnvelope: fields are TOP LEVEL (no `data`), error is a string, ok must be exactly true', () => {
  const good = parseEnvelope({ ok: true, state: 'RUNNING', estateId: 'e' });
  assert.equal(good.ok, true);
  assert.equal(good.data.state, 'RUNNING');
  assert.ok(!('ok' in good.data));
  assert.deepEqual(parseEnvelope({ ok: false, error: 'nope' }), { ok: false, data: null, error: 'nope' });
  assert.equal(parseEnvelope({ ok: 'true', state: 'RUNNING' }).ok, false, 'a truthy string is not ok:true');
  assert.equal(parseEnvelope({ ok: true, data: { state: 'X' } }).data.state, undefined, 'a nested data object is NOT the real shape');
  assert.equal(parseEnvelope(null).ok, false);
});

test('pause: state -> preview -> pause(confirm=estateId, confirmToken from preview) -> poll; exit 0 only on PAUSED with every row at expected state', async () => {
  const fetchFn = pausingConsole({ pollsBeforeDone: 1 });
  const { code, c } = await run(base({ action: 'pause', confirm: ESTATE_ID }), fetchFn);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(actions(fetchFn), ['state', 'preview', 'pause', 'state', 'state']);
  const p = fetchFn.calls[2].body;
  assert.equal(p.confirmToken, 'tok-from-preview');
  assert.equal(p.confirm, ESTATE_ID);
  assert.match(c.out.join('\n'), /aas-one \| microsoft\.analysisservices\/servers \| arm-suspend/, 'the real set is printed');
});

test('pause: --confirm that is not the estate id exits 2 and the pause is never sent', async () => {
  // Input that breaks it: passing args.confirm straight through (server would be the only check).
  const fetchFn = pausingConsole();
  const { code, c } = await run(base({ action: 'pause', confirm: 'PAUSE' }), fetchFn);
  assert.equal(code, EXIT.USAGE);
  assert.ok(!actions(fetchFn).includes('pause'));
  assert.match(c.err.join('\n'), new RegExp(ESTATE_ID));
});

test('pause: no --confirm at all exits 2, pause never sent', async () => {
  const fetchFn = pausingConsole();
  const { code } = await run(base({ action: 'pause' }), fetchFn);
  assert.equal(code, EXIT.USAGE);
  assert.ok(!actions(fetchFn).includes('pause'));
});

test('poll exits NON-ZERO when PAUSED but one resource is not at its expected state, naming only that one', async () => {
  // Input that breaks it: a loop that trusts state==PAUSED alone.
  const fetchFn = fakeFetch((b) => {
    if (b.action === 'preview') return ok(previewBody());
    if (b.action === 'pause') return accepted({ state: 'PAUSING' });
    if (fetchFn.calls.length <= 2) return ok(runningBody());
    const body = pausedBody('PAUSED', true);
    body.progress[1] = { ...body.progress[1], atExpectedState: false, powerState: 'Online', detail: 'still Online' };
    return ok(body);
  });
  const { code, c } = await run(base({ action: 'pause', confirm: ESTATE_ID, timeoutMin: 2 }), fetchFn);
  assert.equal(code, EXIT.FAILED);
  const e = c.err.join('\n');
  assert.match(e, /adx-one \| microsoft\.kusto\/clusters \| Online \(still Online\)/);
  assert.ok(!/aas-one \|/.test(e), 'the resource that DID pause is not listed as a failure');
  assert.ok(actions(fetchFn).filter((a) => a === 'state').length >= 3, 'it polled more than once before giving up');
});

test('poll exits NON-ZERO when the estate stays PAUSING until the deadline', async () => {
  const fetchFn = pausingConsole({ pollsBeforeDone: 10000 });
  const { code, c } = await run(base({ action: 'pause', confirm: ESTATE_ID, timeoutMin: 2 }), fetchFn);
  assert.equal(code, EXIT.FAILED);
  assert.match(c.err.join('\n'), /not PAUSED|not "PAUSED"|, not PAUSED/);
});

test('verifyPaused: a resource ABSENT from progress is a failure; empty progress verifies nothing; drifted fails', () => {
  const ids = [AAS_ID, ADX_ID];
  assert.equal(verifyPaused(pausedBody('PAUSED', true), ids).ok, true, 'positive control');
  const missing = pausedBody('PAUSED', true);
  missing.progress = missing.progress.slice(0, 1);
  const v = verifyPaused(missing, ids);
  assert.equal(v.ok, false);
  assert.deepEqual(v.failures.map((f) => f.name), [ADX_ID]);
  assert.equal(verifyPaused({ ...pausedBody('PAUSED', true), progress: [] }, ids).ok, false);
  assert.equal(verifyPaused({ ...pausedBody('PAUSED', true), drifted: true, driftedResources: ['x'] }, ids).ok, false);
  assert.equal(verifyPaused(pausedBody('PAUSING', true), ids).ok, false, 'PAUSING is not PAUSED even if rows look done');
});

test('pause when already PAUSED (verified): exit 0, nothing sent', async () => {
  const fetchFn = fakeFetch(() => ok(pausedBody('PAUSED', true)));
  const { code } = await run(base({ action: 'pause', confirm: ESTATE_ID }), fetchFn);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(actions(fetchFn), ['state']);
});

test('pause or resume while PAUSING/RESUMING: fails, nothing sent', async () => {
  for (const [action, body] of [['pause', pausedBody('PAUSING', false)], ['resume', resumeBody('RESUMING')]]) {
    const fetchFn = fakeFetch(() => ok(body));
    const { code, c } = await run(base({ action, confirm: ESTATE_ID }), fetchFn);
    assert.equal(code, EXIT.FAILED, action);
    assert.deepEqual(actions(fetchFn), ['state'], action);
    assert.match(c.err.join('\n'), /in flight/);
  }
});

test('pause with preview returning NO confirmToken, NO estateId, or an empty wouldPause: fails, pause never sent', async () => {
  const cases = [
    previewBody({ confirmToken: undefined }),
    previewBody({ estateId: undefined }),
    previewBody({ preview: { wouldPause: [] } }),
    previewBody({ preview: undefined }),
  ];
  for (const pv of cases) {
    const fetchFn = fakeFetch((b) => (b.action === 'preview' ? ok(pv) : ok(runningBody())));
    const { code } = await run(base({ action: 'pause', confirm: ESTATE_ID }), fetchFn);
    assert.equal(code, EXIT.FAILED, JSON.stringify(Object.keys(pv)));
    assert.ok(!actions(fetchFn).includes('pause'));
  }
});

test('--dry-run pause/resume reads but sends no mutation', async () => {
  const pf = fakeFetch((b) => (b.action === 'preview' ? ok(previewBody()) : ok(runningBody())));
  assert.equal((await run(base({ action: 'pause', dryRun: true }), pf)).code, EXIT.OK);
  assert.ok(!actions(pf).includes('pause'));
  const rf = fakeFetch(() => ok(pausedBody('PAUSED', true)));
  assert.equal((await run(base({ action: 'resume', dryRun: true }), rf)).code, EXIT.OK);
  assert.deepEqual(actions(rf), ['state']);
});

test('resume: state(PAUSED) -> resume -> poll RESUMING then RUNNING; exit 0', async () => {
  let sent = false;
  let polls = 0;
  const fetchFn = fakeFetch((b) => {
    if (b.action === 'resume') { sent = true; return accepted({ state: 'RESUMING', estateId: ESTATE_ID }); }
    if (!sent) return ok(pausedBody('PAUSED', true));
    polls += 1;
    return ok(polls === 1 ? resumeBody('RESUMING') : runningBody());
  });
  const { code } = await run(base({ action: 'resume' }), fetchFn);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(actions(fetchFn), ['state', 'resume', 'state', 'state']);
});

test('resume: RESUME_FAILED is terminal -- exit 1 on the FIRST such read, naming the failed resource and the console reason', async () => {
  // Input that breaks it: a loop that keeps polling to the deadline, or treats RESUME_FAILED as "not yet".
  let sent = false;
  const outcomes = [
    { resourceId: AAS_ID, confirmation: 'confirmed-running', reason: 'ok' },
    { resourceId: ADX_ID, confirmation: 'unknown', reason: 'ADX answered no query' },
  ];
  const fetchFn = fakeFetch((b) => {
    if (b.action === 'resume') { sent = true; return accepted({ state: 'RESUMING' }); }
    return ok(sent ? resumeBody('RESUME_FAILED', outcomes) : pausedBody('PAUSED', true));
  });
  const { code, c } = await run(base({ action: 'resume' }), fetchFn);
  assert.equal(code, EXIT.FAILED);
  assert.equal(actions(fetchFn).filter((a) => a === 'state').length, 2, 'one pre-read, ONE poll, then stop');
  const e = c.err.join('\n');
  assert.match(e, /adx-one \| microsoft\.kusto\/clusters \| unknown \(ADX answered no query\)/);
  assert.ok(!/aas-one \|/.test(e));
});

test('verifyResumed: RUNNING ok; RESUMING keeps polling; RESUME_FAILED terminal; unknown state is not ok', () => {
  assert.equal(verifyResumed(runningBody()).ok, true);
  assert.deepEqual([verifyResumed(resumeBody('RESUMING')).ok, verifyResumed(resumeBody('RESUMING')).terminal], [false, false]);
  assert.equal(verifyResumed(resumeBody('RESUME_FAILED')).terminal, true);
  assert.equal(verifyResumed({}).ok, false);
  assert.equal(verifyResumed(pausedBody('PAUSED', true)).ok, false);
});

test('resume when the estate is already RUNNING: exit 0 and NO resume sent', async () => {
  const fetchFn = fakeFetch(() => ok(runningBody()));
  const { code } = await run(base({ action: 'resume' }), fetchFn);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(actions(fetchFn), ['state']);
});

test('retry: a persistent 503 on a read is retried exactly MAX_ATTEMPTS then FAILS CLOSED', async () => {
  const fetchFn = fakeFetch(() => bad(503, 'busy'));
  const { code, c } = await run(base(), fetchFn);
  assert.equal(code, EXIT.FAILED);
  assert.equal(fetchFn.calls.length, MAX_ATTEMPTS);
  assert.match(c.err.join('\n'), /\[transient\] after 3 attempt/);
});

test('retry: 403 is NOT retried (1 attempt) and the remediation names Estate.Power', async () => {
  const fetchFn = fakeFetch(() => bad(403, 'forbidden'));
  const { code, c } = await run(base(), fetchFn);
  assert.equal(code, EXIT.FAILED);
  assert.equal(fetchFn.calls.length, 1);
  assert.match(c.err.join('\n'), /Estate\.Power/);
});

test('retry: 409 (arming gate / confirm drift) is config, NOT retried, and the console message is quoted', async () => {
  const fetchFn = fakeFetch(() => bad(409, 'The set of resources to pause changed between the preview you confirmed and now'));
  const { code, c } = await run(base(), fetchFn);
  assert.equal(code, EXIT.FAILED);
  assert.equal(fetchFn.calls.length, 1);
  assert.match(c.err.join('\n'), /\[config\].*set of resources to pause changed/);
});

test('retry: a MUTATING call is not blindly re-sent on a network error; outcome stated as unverified', async () => {
  const fetchFn = fakeFetch((b) => {
    if (b.action === 'preview') return ok(previewBody());
    if (b.action === 'pause') throw new Error('socket hang up');
    return ok(runningBody());
  });
  const { code, c } = await run(base({ action: 'pause', confirm: ESTATE_ID }), fetchFn);
  assert.equal(code, EXIT.FAILED);
  assert.equal(actions(fetchFn).filter((a) => a === 'pause').length, 1, 'pause sent exactly once');
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

test('pauseSetOf reads preview.wouldPause (the real nesting), not a top-level list', () => {
  assert.equal(pauseSetOf(previewBody()).length, 2);
  assert.equal(pauseSetOf({ wouldPause: [{ resourceId: 'x' }] }), null);
});

test('state action prints the real power block fields', async () => {
  const { code, c } = await run(base(), fakeFetch(() => ok(runningBody())));
  assert.equal(code, EXIT.OK);
  assert.match(c.out.join('\n'), /state=RUNNING estateId=estate-loom-1 lastActivityAt=2026-10-13T07:00:00\.000Z/);
});

test('parseArgs / main: bad boundary and bad action exit 2 without running anything', async () => {
  assert.throws(() => parseArgs(['--boundary', 'IL5', '--action', 'state']));
  assert.throws(() => parseArgs(['--boundary', 'Commercial', '--action', 'nuke']));
  assert.throws(() => parseArgs(['--boundary', 'Commercial', '--action', 'state', '--bogus']));
  assert.equal(await main(['--boundary', 'IL5', '--action', 'state'], capture().deps), EXIT.USAGE);
});

test('missing console URL / audience: exit 2 before the az cloud is even read', async () => {
  const spawn = fakeSpawn();
  assert.equal(await runPower(base(), { env: {}, spawn, ...capture().deps }), EXIT.USAGE);
  assert.equal(await runPower(base(), { env: { CSA_LOOM_CONSOLE_URL: ENV.CSA_LOOM_CONSOLE_URL }, spawn, ...capture().deps }), EXIT.USAGE);
  assert.equal(spawn.calls.length, 0);
});

test('console-supplied names cannot forge log lines or workflow commands (CR/LF stripped, :: broken)', async () => {
  // Input that breaks it: printing r.name raw -> a line starting with ::error::x appears in output.
  const evil = 'aas\n::error::pwned';
  const body = previewBody({ preview: { wouldPause: [{ resourceId: AAS_ID, name: evil, resourceType: 't\r::warning::w', mechanism: 'm' }], wouldLeaveRunning: [] } });
  const fetchFn = fakeFetch((b) => (b.action === 'preview' ? ok(body) : ok(runningBody())));
  const { code, c } = await run(base({ action: 'pause', dryRun: true }), fetchFn);
  assert.equal(code, EXIT.OK);
  assert.ok(c.out.every((l) => !/[\r\n]/.test(l) && !l.includes('::')), 'no line carries CR/LF or ::');
  assert.ok(c.out.some((l) => l.includes('aas') && l.includes('pwned')), 'positive: the name is still shown, defanged');
});

test('progressRows fixture sanity: atExpected=false rows are the failing ones (guards the fixture itself)', () => {
  assert.ok(progressRows(false).every((r) => r.atExpectedState === false));
  assert.ok(progressRows(true).every((r) => r.atExpectedState === true));
});
