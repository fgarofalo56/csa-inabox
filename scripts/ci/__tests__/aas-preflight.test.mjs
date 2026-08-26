/**
 * Behaviour tests for scripts/ci/ensure-aas-server-settled.mjs.
 *
 * The preflight's whole value is that it REFUSES what it cannot establish, so
 * the refuse branches matter more than the happy path. Every assertion below
 * breaks something a lenient implementation would wave through.
 *
 * Modelled on scripts/ci/__tests__/estate-preflight.test.mjs, which covers the
 * ADX equivalent this file is shaped after.
 *
 * Run: node --test scripts/ci/__tests__/aas-preflight.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyServerState,
  evaluatePoll,
  shouldResuspend,
  AAS_API_VERSION,
  DEFAULT_TIMEOUT_SECONDS,
} from '../ensure-aas-server-settled.mjs';

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

for (const state of ['Provisioning', 'Updating', 'Scaling', 'Resuming', 'Suspending', 'Preparing']) {
  test(`${state} -> wait, never a second verb on top of an in-flight one`, () => {
    assert.equal(classifyServerState(state).action, 'wait');
  });
}

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

test('evaluatePoll: Succeeded ends the poll successfully', () => {
  const v = evaluatePoll({ state: 'Succeeded', elapsedSeconds: 42, budgetSeconds: 600 });
  assert.equal(v.done, true);
  assert.equal(v.ok, true);
  assert.match(v.reason, /42s/);
});

test('evaluatePoll: a still-transitional state keeps polling', () => {
  const v = evaluatePoll({ state: 'Resuming', elapsedSeconds: 30, budgetSeconds: 600 });
  assert.equal(v.done, false);
  assert.equal(v.ok, false);
});

test('evaluatePoll: budget exhaustion FAILS — an unconfirmed outcome is not a pass', () => {
  const v = evaluatePoll({ state: 'Resuming', elapsedSeconds: 600, budgetSeconds: 600 });
  assert.equal(v.done, true);
  assert.equal(v.ok, false);
  assert.match(v.reason, /UNCONFIRMED/);
});

test('evaluatePoll: a terminal state during the poll fails immediately, not at the budget', () => {
  const v = evaluatePoll({ state: 'Failed', elapsedSeconds: 5, budgetSeconds: 600 });
  assert.equal(v.done, true);
  assert.equal(v.ok, false);
});

test('evaluatePoll: an unreadable state (null) is refused, not treated as still-settling', () => {
  // null means the READ failed. Treating that as "keep waiting" would spin the
  // whole budget on a control plane we cannot see, then report a timeout — a
  // false cause. It must fail with the unknown-state reason instead.
  const v = evaluatePoll({ state: null, elapsedSeconds: 5, budgetSeconds: 600 });
  assert.equal(v.done, true);
  assert.equal(v.ok, false);
  assert.match(v.reason, /UNKNOWN/);
});

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

test('the api-version matches what every other AAS caller in this repo uses', () => {
  // aas-client.ts pins 2017-08-01. A preflight on a different api-version could
  // read a differently-shaped state and silently disagree with the app.
  assert.equal(AAS_API_VERSION, '2017-08-01');
});

test('the default budget is long enough for an AAS resume, not a throttle backoff', () => {
  // The defect this file removes is precisely a ~50s retry aimed at an
  // operation that takes minutes. A short default here would recreate it.
  assert.ok(DEFAULT_TIMEOUT_SECONDS >= 600, `budget ${DEFAULT_TIMEOUT_SECONDS}s is too short for an AAS resume`);
});
