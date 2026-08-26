/**
 * Behaviour tests for scripts/ci/ensure-aas-server-settled.mjs.
 *
 * The preflight's whole value is that it REFUSES what it cannot establish, so
 * the refuse branches matter more than the happy path. Every assertion below
 * breaks something a lenient implementation would wave through.
 *
 * ── WHY HALF OF THIS FILE DRIVES `runPreflight` RATHER THAN A PURE FUNCTION ──
 *
 * The first draft of this suite tested only the pure parts, and every one of
 * the four defects the #4074 review found was INVISIBLE to it:
 *
 *   - `Pausing` missing from the table   — no test enumerated the real enum.
 *   - the `wait` arm being a dead end    — a unit test of "keep polling" cannot
 *                                          see that the loop never escapes.
 *   - no retry on the az calls           — no test ever ran the I/O shell.
 *   - `shouldResuspend` being DEAD CODE  — its unit tests passed at full green
 *                                          while nothing called it.
 *
 * The last one is the lesson: a pure function can be perfectly tested and
 * perfectly unwired, and the suite cannot tell. So the state machine is driven
 * end-to-end through a scripted `az`, and the assertions are about what the
 * script DID — which calls it made, which outputs it emitted, what it exited.
 *
 * Run: node --test scripts/ci/__tests__/aas-preflight.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyServerState,
  planSettleStep,
  shouldResuspend,
  elapsedSecondsSince,
  nextRetryDelaySeconds,
  aasRemediationFor,
  azWithRetry,
  runPreflight,
  AAS_API_VERSION,
  DEFAULT_TIMEOUT_SECONDS,
  POLL_INTERVAL_SECONDS,
  MAX_RESUME_ATTEMPTS,
  TRANSIENT_BACKOFF_SECONDS,
} from '../ensure-aas-server-settled.mjs';

/**
 * Every value the Analysis Services `State` enum documents, verbatim from
 * learn.microsoft.com/javascript/api/@azure/arm-analysisservices/knownstate.
 * Pinned as data so a missing arm is a FAILED ASSERTION rather than a state
 * nobody thought to type — which is exactly how `Pausing` was lost.
 */
const DOCUMENTED_STATES = [
  'Deleting', 'Succeeded', 'Failed', 'Paused', 'Suspended', 'Provisioning',
  'Updating', 'Suspending', 'Pausing', 'Resuming', 'Preparing', 'Scaling',
];

// ── PURE: the state table ───────────────────────────────────────────────────

test('a Succeeded server is left completely alone', () => {
  const d = classifyServerState('Succeeded');
  assert.equal(d.action, 'none');
  assert.match(d.reason, /administrators/);
});

for (const state of ['Paused', 'Suspended']) {
  test(`${state} -> resume, naming why a retry alone cannot fix it`, () => {
    const d = classifyServerState(state);
    assert.equal(d.action, 'resume');
    // The reason must name the actual mechanism, not just "it is paused" —
    // #4034 retried this four times on a ~50s backoff and every attempt
    // collided with the same window.
    assert.match(d.reason, /currently being updated|collides|window/i);
  });
}

for (const state of ['Provisioning', 'Updating', 'Scaling', 'Resuming', 'Suspending', 'Pausing', 'Preparing']) {
  test(`${state} -> wait, never a second verb on top of an in-flight one`, () => {
    assert.equal(classifyServerState(state).action, 'wait');
  });
}

test('REGRESSION #4074-R1: Pausing is a transitional state, NOT an unknown one', () => {
  // `Pausing` is what the estate PAUSE tier puts this server INTO, so it is the
  // likeliest state for this preflight to arrive on. The first draft omitted it
  // and it fell to `default: refuse` — the deploy would have died on the single
  // most ordinary, self-resolving condition there is.
  const d = classifyServerState('Pausing');
  assert.equal(d.action, 'wait');
  assert.doesNotMatch(d.reason, /unrecognised|UNKNOWN/);
});

test('the state table covers EVERY documented Analysis Services state', () => {
  // A completeness assertion, not a spot check. The `default` arm refusing is
  // only defensible if it can be reached solely by a value Azure did not
  // document — so every documented value must be named explicitly.
  for (const state of DOCUMENTED_STATES) {
    const d = classifyServerState(state);
    assert.doesNotMatch(
      d.reason,
      /unrecognised/,
      `'${state}' is a documented State value but falls through to the unknown arm`,
    );
    assert.ok(['none', 'resume', 'wait', 'refuse'].includes(d.action));
  }
});

for (const state of ['Failed', 'Deleting', 'Deleted']) {
  test(`${state} -> refuse (no resume can resolve it)`, () => {
    const d = classifyServerState(state);
    assert.equal(d.action, 'refuse');
    assert.match(d.reason, /no resume can resolve/);
  });
}

test('an UNRECOGNISED state refuses rather than assuming it is fine', () => {
  // This is the point of the table. A new Azure state string must stop the
  // deploy with an honest "I do not know", not fall through to a resume.
  for (const s of ['Hibernated', 'Weird', '', null, undefined]) {
    const d = classifyServerState(s);
    assert.equal(d.action, 'refuse', `state ${JSON.stringify(s)} must refuse`);
    assert.match(d.reason, /UNKNOWN/);
  }
});

test('MUTATION: a default branch that returned `none` would be caught here', () => {
  // Guard-of-the-guard. If someone "simplifies" the default arm to none/resume,
  // the assertion above flips. Pinning the intent explicitly so the reason for
  // the strictness survives a refactor.
  assert.notEqual(classifyServerState('SomethingNew').action, 'none');
  assert.notEqual(classifyServerState('SomethingNew').action, 'resume');
});

// ── PURE: the settle planner ────────────────────────────────────────────────

test('planSettleStep: Succeeded ends the loop successfully', () => {
  const v = planSettleStep({ state: 'Succeeded', elapsedSeconds: 42, budgetSeconds: 600 });
  assert.equal(v.action, 'settled');
  assert.match(v.reason, /42s/);
});

test('planSettleStep: a still-transitional state keeps waiting', () => {
  const v = planSettleStep({ state: 'Resuming', elapsedSeconds: 30, budgetSeconds: 600 });
  assert.equal(v.action, 'wait');
});

test('REGRESSION #4074-R2: a state that BECAME resumable is RESUMED, not waited on', () => {
  // The dead end, in one assertion. `Suspending` settles into `Paused`, and the
  // old evaluatePoll had no verb for that: `Paused` is neither Succeeded nor a
  // refuse-class state, so it returned "not done yet" and the loop spun out the
  // entire budget without ever issuing the resume that would have fixed it.
  const v = planSettleStep({ state: 'Paused', elapsedSeconds: 30, budgetSeconds: 600, resumesIssued: 0 });
  assert.equal(v.action, 'resume');
});

test('planSettleStep: the resume count is BOUNDED — a duel with the pause actuator is not a strategy', () => {
  const v = planSettleStep({
    state: 'Paused',
    elapsedSeconds: 30,
    budgetSeconds: 600,
    resumesIssued: MAX_RESUME_ATTEMPTS,
  });
  assert.equal(v.action, 'fail');
  assert.match(v.reason, /already issued/);
  // R7: it names the pause actuator as a CANDIDATE, never as an established
  // cause — this step observes state, never a suspend event.
  assert.match(v.reason, /candidate/);
});

test('planSettleStep: budget exhaustion FAILS — an unconfirmed outcome is not a pass', () => {
  const v = planSettleStep({ state: 'Resuming', elapsedSeconds: 600, budgetSeconds: 600 });
  assert.equal(v.action, 'fail');
  assert.match(v.reason, /UNCONFIRMED/);
});

test('planSettleStep: a terminal state fails immediately, not at the budget', () => {
  const v = planSettleStep({ state: 'Failed', elapsedSeconds: 5, budgetSeconds: 600 });
  assert.equal(v.action, 'fail');
  // The REAL reason, not a timeout. Reporting a Failed server as a budget
  // overrun is a false cause, and it would hide it for thirty minutes first.
  assert.match(v.reason, /no resume can resolve/);
  assert.doesNotMatch(v.reason, /UNCONFIRMED/);
});

test('planSettleStep: an unreadable state (null) is refused, not treated as still-settling', () => {
  // null means the READ failed. Treating that as "keep waiting" would spin the
  // whole budget on a control plane we cannot see, then report a timeout — a
  // false cause. It must fail with the unknown-state reason instead.
  const v = planSettleStep({ state: null, elapsedSeconds: 5, budgetSeconds: 600 });
  assert.equal(v.action, 'fail');
  assert.match(v.reason, /UNKNOWN/);
});

test('elapsedSecondsSince: a backwards clock reads as 0, never negative', () => {
  // A negative elapsed reads as "no time has passed" and makes the budget
  // unreachable — the budget-that-cannot-be-exceeded shape again.
  assert.equal(elapsedSecondsSince(10_000, 4_000), 0);
  assert.equal(elapsedSecondsSince(0, 90_000), 90);
  assert.equal(elapsedSecondsSince(0, Number.NaN), 0);
});

// ── PURE: the re-suspend decision ───────────────────────────────────────────

test('shouldResuspend: only when THIS run resumed it', () => {
  const yes = shouldResuspend({ priorState: 'Paused', resumedByUs: true });
  assert.equal(yes.resuspend, true);
  assert.match(yes.reason, /no auto-pause|PAUSE tier/);

  const no = shouldResuspend({ priorState: 'Succeeded', resumedByUs: false });
  assert.equal(no.resuspend, false);
  assert.match(no.reason, /does not own/);
});

test('shouldResuspend: a server that was ALREADY running is never suspended by us', () => {
  // The cost argument cuts both ways. Suspending a server someone else started
  // would be this script reaching outside what it changed — and could take a
  // live workload down.
  assert.equal(shouldResuspend({ priorState: 'Succeeded', resumedByUs: false }).resuspend, false);
  assert.equal(shouldResuspend({ priorState: 'Updating', resumedByUs: false }).resuspend, false);
});

// ── PURE: retry schedule + remediation text ─────────────────────────────────

test('nextRetryDelaySeconds: the schedule is finite and exhaustion returns null', () => {
  TRANSIENT_BACKOFF_SECONDS.forEach((expected, i) => assert.equal(nextRetryDelaySeconds(i), expected));
  // FAIL CLOSED. A schedule that never returns null is a retry that cannot
  // fail, which deploy-integrity.md R6 forbids outright.
  assert.equal(nextRetryDelaySeconds(TRANSIENT_BACKOFF_SECONDS.length), null);
  assert.equal(nextRetryDelaySeconds(-1), null);
  assert.equal(nextRetryDelaySeconds(1.5), null);
});

test('aasRemediationFor names ANALYSIS SERVICES permissions, never Kusto ones', () => {
  // The shared remediationFor() in _az-failure-class.mjs names "Azure Kusto
  // Contributor" and `adxSku` because it was written for the ADX preflight.
  // Reusing it here would print a Kusto role for an Analysis Services scope —
  // a remediation that cannot possibly be right (R7). This is the assertion
  // that a future "just reuse the shared one" simplification trips over.
  for (const kind of ['transient', 'denied', 'capacity', 'notfound', 'unknown']) {
    const text = aasRemediationFor(kind, '/subscriptions/s/…/servers/aasx', 3);
    assert.doesNotMatch(text, /Kusto|ADX|adxSku|cluster/i, `${kind} remediation leaks Kusto vocabulary`);
  }
  assert.match(aasRemediationFor('denied', '/x', 1), /Microsoft\.AnalysisServices\/servers\/resume\/action/);
  // `unknown` must assert NO cause at all.
  assert.match(aasRemediationFor('unknown', '/x', 1), /NO cause is asserted/);
  assert.doesNotMatch(aasRemediationFor('unknown', '/x', 1), /permission problem/);
});

test('azWithRetry: retries a TRANSIENT failure, refuses to retry a DENIED one', () => {
  const transient = [];
  const t = azWithRetry(['x'], {
    runner: () => {
      transient.push(1);
      return transient.length < 3
        ? { ok: false, stdout: '', stderr: 'ERROR: (GatewayTimeout) GatewayTimeout' }
        : { ok: true, stdout: 'fine', stderr: '' };
    },
    sleep: () => {},
    log: () => {},
  });
  assert.equal(t.ok, true);
  assert.equal(t.attempts, 3);

  const denied = [];
  const d = azWithRetry(['x'], {
    runner: () => {
      denied.push(1);
      return { ok: false, stdout: '', stderr: 'ERROR: (AuthorizationFailed) does not have authorization' };
    },
    sleep: () => {},
    log: () => {},
  });
  assert.equal(d.ok, false);
  assert.equal(d.kind, 'denied');
  // ONE attempt. Retrying a refusal just delays the truth by fifty seconds.
  assert.equal(d.attempts, 1);
});

test('azWithRetry: a transient failure that never clears FAILS CLOSED', () => {
  let n = 0;
  const r = azWithRetry(['x'], {
    runner: () => {
      n += 1;
      return { ok: false, stdout: '', stderr: '(503) ServiceUnavailable' };
    },
    sleep: () => {},
    log: () => {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, TRANSIENT_BACKOFF_SECONDS.length + 1);
  assert.equal(n, TRANSIENT_BACKOFF_SECONDS.length + 1);
});

// ── END-TO-END: the settle loop, driven through a scripted `az` ─────────────

/**
 * A scripted `az`. `showQueue` is consumed one entry per `resource show`; a
 * string is a successful state read, an object is a raw {ok,stdout,stderr}.
 *
 * Running OUT of scripted readings THROWS rather than looping — a test that
 * under-scripts must fail loudly, not hang a suite.
 */
function scriptedAz({ list = { ok: true, stdout: 'aasloomtest', stderr: '' }, showQueue = [], resumeQueue = [] }) {
  const calls = [];
  const shows = [...showQueue];
  const resumes = [...resumeQueue];
  const run = (args) => {
    const joined = args.join(' ');
    calls.push(joined);
    if (args[1] === 'list') return list;
    if (args[1] === 'show') {
      if (shows.length === 0) throw new Error(`scripted az exhausted after ${calls.length} calls: ${joined}`);
      const next = shows.shift();
      return typeof next === 'string' ? { ok: true, stdout: next, stderr: '' } : next;
    }
    if (args[1] === 'invoke-action') return resumes.shift() ?? { ok: true, stdout: '', stderr: '' };
    throw new Error(`scripted az: unexpected call ${joined}`);
  };
  return { calls, run };
}

/** A clock that only moves when the code sleeps — no real waiting, real budgets. */
function fakeClock() {
  let ms = 0;
  return { now: () => ms, sleep: (s) => { ms += s * 1000; } };
}

function drive({ argv = ['--subscription', 'sub', '--rg', 'rg-csa-loom-admin-centralus'], az }) {
  const clock = fakeClock();
  const outputs = {};
  const logs = [];
  const exitCode = runPreflight({
    argv,
    io: {
      az: az.run,
      now: clock.now,
      sleep: clock.sleep,
      log: (m) => logs.push(String(m)),
      error: (m) => logs.push(String(m)),
      emit: (k, v) => { outputs[k] = v; },
    },
  });
  return { exitCode, outputs, logs, calls: az.calls };
}

const resumeCalls = (calls) => calls.filter((c) => c.includes('--action resume'));

test('E2E: a Succeeded server is not touched at all', () => {
  const az = scriptedAz({ showQueue: ['Succeeded'] });
  const r = drive({ az });
  assert.equal(r.exitCode, 0);
  assert.equal(resumeCalls(r.calls).length, 0, 'a Succeeded server must see NO mutation');
  assert.equal(r.outputs.aas_resumed, 'false');
  assert.equal(r.outputs.aas_prior_state, 'Succeeded');
});

test('E2E: a Paused server is resumed and polled to Succeeded', () => {
  const az = scriptedAz({ showQueue: ['Paused', 'Resuming', 'Succeeded'] });
  const r = drive({ az });
  assert.equal(r.exitCode, 0);
  assert.equal(resumeCalls(r.calls).length, 1);
  assert.equal(r.outputs.aas_resumed, 'true');
});

test('E2E REGRESSION #4074-R2: a server found Suspending is RESUMED once it settles', () => {
  // THE DEAD END. Old behaviour: `Suspending` -> wait; it settles to `Paused`;
  // `Paused` is neither Succeeded nor refuse-class, so the poll returned "not
  // done" for the full 1800s budget and then failed with a timeout, having
  // never issued the one verb that fixes it.
  //
  // This is the discriminating assertion: under the old code the resume count
  // is 0 and the exit is 1.
  const az = scriptedAz({ showQueue: ['Suspending', 'Paused', 'Resuming', 'Succeeded'] });
  const r = drive({ az });
  assert.equal(r.exitCode, 0);
  assert.equal(resumeCalls(r.calls).length, 1, 'the wait arm must escalate to a resume, not spin');
  assert.equal(r.outputs.aas_resumed, 'true');
});

test('E2E REGRESSION #4074-R1: a server found Pausing settles instead of refusing', () => {
  // Under the old table `Pausing` hit `default: refuse` and exited 1 on the
  // most ordinary state the estate PAUSE tier produces.
  const az = scriptedAz({ showQueue: ['Pausing', 'Paused', 'Succeeded'] });
  const r = drive({ az });
  assert.equal(r.exitCode, 0);
  assert.equal(r.outputs.aas_prior_state, 'Pausing');
  assert.equal(resumeCalls(r.calls).length, 1);
});

test('E2E REGRESSION #4074-R4: the aas_resumed output is PRODUCED BY shouldResuspend', () => {
  // The wiring proof. `shouldResuspend` used to be exported, unit-tested and
  // called by NOTHING, while main() computed String(resumedByUs) inline — so
  // its tests could stay green through any change to the behaviour they claim
  // to guard. Mutating shouldResuspend now moves this verdict.
  const resumed = drive({ az: scriptedAz({ showQueue: ['Paused', 'Succeeded'] }) });
  assert.equal(resumed.outputs.aas_resumed, String(shouldResuspend({ priorState: 'Paused', resumedByUs: true }).resuspend));
  assert.equal(resumed.outputs.aas_resumed, 'true');

  const untouched = drive({ az: scriptedAz({ showQueue: ['Succeeded'] }) });
  assert.equal(untouched.outputs.aas_resumed, String(shouldResuspend({ priorState: 'Succeeded', resumedByUs: false }).resuspend));
  assert.equal(untouched.outputs.aas_resumed, 'false');

  // And the reason is SURFACED, so the operator can see why the workflow's
  // re-suspend step did or did not fire.
  assert.ok(untouched.logs.some((l) => l.includes('re-suspend gate:')), 'the gate decision must be logged');
});

test('E2E: a rejected resume never claims the server was resumed', () => {
  // If it emitted true here the workflow would try to suspend a server this run
  // never started — the exact reach-outside-what-we-changed the gate prevents.
  const az = scriptedAz({
    showQueue: ['Paused'],
    resumeQueue: [{ ok: false, stdout: '', stderr: 'ERROR: (AuthorizationFailed) does not have authorization' }],
  });
  const r = drive({ az });
  assert.equal(r.exitCode, 1);
  assert.equal(r.outputs.aas_resumed, 'false');
  assert.ok(r.logs.some((l) => l.includes('Microsoft.AnalysisServices/servers/resume/action')));
});

test('E2E REGRESSION #4074-R3: a TRANSIENT read failure is retried, not fatal', () => {
  // Old behaviour: single-shot `az`, so one GatewayTimeout on the state read
  // failed the entire deploy. That is the #3786 defect, already paid for once
  // on the ADX sibling.
  const az = scriptedAz({
    showQueue: [{ ok: false, stdout: '', stderr: 'ERROR: (GatewayTimeout) GatewayTimeout' }, 'Succeeded'],
  });
  const r = drive({ az });
  assert.equal(r.exitCode, 0);
  assert.equal(r.calls.filter((c) => c.includes('show')).length, 2, 'the read must be retried');
});

test('E2E: a DENIED read fails once, with an Analysis Services remediation', () => {
  const az = scriptedAz({
    showQueue: [{ ok: false, stdout: '', stderr: 'ERROR: (AuthorizationFailed) does not have authorization' }],
  });
  const r = drive({ az });
  assert.equal(r.exitCode, 1);
  assert.equal(r.calls.filter((c) => c.includes('show')).length, 1, 'a refusal must NOT be retried');
  const text = r.logs.join('\n');
  assert.match(text, /Microsoft\.AnalysisServices\/servers\/resume\/action/);
  assert.doesNotMatch(text, /Kusto/i);
});

test('E2E: an unreadable ENUMERATION is UNKNOWN, never "there is no server"', () => {
  // The R7 shape this whole file guards: a lookup that did not happen must not
  // be reported as an absence.
  const az = scriptedAz({ list: { ok: false, stdout: '', stderr: 'ERROR: (AuthorizationFailed) denied' } });
  const r = drive({ az });
  assert.equal(r.exitCode, 1);
  assert.match(r.logs.join('\n'), /NOT the same as "there is no server"|UNKNOWN/);
});

test('E2E: no server in the resource group is a clean no-op (greenfield)', () => {
  const az = scriptedAz({ list: { ok: true, stdout: '', stderr: '' } });
  const r = drive({ az });
  assert.equal(r.exitCode, 0);
  assert.equal(r.outputs.aas_server, '');
  assert.equal(r.outputs.aas_resumed, 'false');
});

test('E2E: the settle budget is ENFORCED and reported as unconfirmed', () => {
  // budget 60s, poll interval 30s -> the third reading is at/over budget.
  const az = scriptedAz({ showQueue: ['Resuming', 'Resuming', 'Resuming'] });
  const r = drive({
    az,
    argv: ['--subscription', 'sub', '--rg', 'rg', '--timeout-seconds', '60'],
  });
  assert.equal(r.exitCode, 1);
  assert.match(r.logs.join('\n'), /UNCONFIRMED/);
});

test('E2E: resumes are BOUNDED when something else keeps suspending the server', () => {
  const az = scriptedAz({ showQueue: ['Paused', 'Paused', 'Paused'] });
  const r = drive({ az });
  assert.equal(r.exitCode, 1);
  assert.equal(resumeCalls(r.calls).length, MAX_RESUME_ATTEMPTS, 'the resume/suspend duel must be bounded');
  assert.match(r.logs.join('\n'), /already issued/);
  // It STILL owns putting the server back — it did resume it.
  assert.equal(r.outputs.aas_resumed, 'true');
});

test('E2E: a non-numeric --timeout-seconds is refused BEFORE any az call', () => {
  // `elapsed >= NaN` is always false, so an unvalidated budget makes the settle
  // loop unbounded — a budget that cannot be exceeded is not a budget. The
  // `calls.length === 0` half is what makes this discriminating: a validation
  // moved to after the enumeration would still exit non-zero.
  const az = scriptedAz({ showQueue: ['Succeeded'] });
  const r = drive({ az, argv: ['--subscription', 'sub', '--rg', 'rg', '--timeout-seconds', 'soon'] });
  assert.equal(r.exitCode, 2);
  assert.equal(az.calls.length, 0);
  assert.match(r.logs.join('\n'), /never be exceeded/);
});

test('E2E: missing required arguments exit 2 without touching Azure', () => {
  const az = scriptedAz({ showQueue: ['Succeeded'] });
  assert.equal(drive({ az, argv: ['--rg', 'rg'] }).exitCode, 2);
  assert.equal(drive({ az, argv: ['--subscription', 'sub'] }).exitCode, 2);
  assert.equal(az.calls.length, 0);
});

// ── Constants that encode a decision ────────────────────────────────────────

test('the api-version matches what every other AAS caller in this repo uses', () => {
  // aas-client.ts pins 2017-08-01. A preflight on a different api-version could
  // read a differently-shaped state and silently disagree with the app.
  assert.equal(AAS_API_VERSION, '2017-08-01');
});

test('the default budget is long enough for an AAS resume, not a throttle backoff', () => {
  // The defect this file removes is precisely a ~50s retry aimed at an
  // operation that takes minutes. A short default here would recreate it.
  assert.ok(DEFAULT_TIMEOUT_SECONDS >= 600, `budget ${DEFAULT_TIMEOUT_SECONDS}s is too short for an AAS resume`);
  assert.ok(POLL_INTERVAL_SECONDS > 0 && POLL_INTERVAL_SECONDS < DEFAULT_TIMEOUT_SECONDS);
});

test('MAX_RESUME_ATTEMPTS is finite and small — a bound that cannot bind is not a bound', () => {
  assert.ok(Number.isInteger(MAX_RESUME_ATTEMPTS));
  assert.ok(MAX_RESUME_ATTEMPTS >= 1 && MAX_RESUME_ATTEMPTS <= 5);
});
