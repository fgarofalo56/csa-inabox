#!/usr/bin/env node
/**
 * estate-live-probe.test.mjs -- can this probe ever WRONGLY suppress the lane?
 *
 * Run: node --test scripts/ci/estate-live-probe.test.mjs
 *
 * The probe's whole job is to skip a check. That makes a false "paused" far more
 * dangerous than a false "live": a false live costs one red lane that a human
 * reads; a false paused silently deletes the drift comparison forever, and
 * nobody notices because a skipped job is grey, not red.
 *
 * So the suite is weighted accordingly. Most tests below assert that some
 * degraded input does NOT suppress, and two of them encode bugs that were live
 * in this probe's own first draft:
 *
 *   1. `az resource list` does not expand properties, so every cluster comes
 *      back with state === null. A classifier written as `state !== 'Running'`
 *      would have marked all of them paused and suppressed this lane on every
 *      PR, permanently -- exactly the failure it was written to fix.
 *   2. `state !== 'Running'` also folds Unavailable/Deleting into "paused",
 *      converting a genuine estate defect into a silent grey skip.
 *
 * Both are pinned below. If someone later "simplifies" PAUSE_STATES into a
 * !== 'Running' check, these fail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, PAUSE_STATES } from './estate-live-probe.mjs';

// ------------------------------------------------- POSITIVE CONTROLS
// Without these the suite could pass by always answering "not paused".

test('POSITIVE CONTROL: a Running cluster reads as LIVE (suite is not vacuous)', () => {
  const v = classify([{ name: 'adx-a', state: 'Running' }]);
  assert.equal(v.paused, false);
  assert.equal(v.reason, 'estate-live');
});

test('POSITIVE CONTROL: a Stopped cluster DOES suppress (the probe can actually fire)', () => {
  const v = classify([{ name: 'adx-a', state: 'Stopped' }]);
  assert.equal(v.paused, true);
  assert.equal(v.reason, 'estate-paused');
  assert.match(v.detail, /adx-a=Stopped/);
});

test('the in-flight pause states also suppress', () => {
  // A cluster mid-stop or mid-start cannot serve principalAssignments either.
  for (const state of ['Stopping', 'Starting']) {
    assert.equal(classify([{ name: 'adx-a', state }]).paused, true, `${state} must suppress`);
  }
});

// ------------------------------------------------- the two encoded bugs

test('REGRESSION: a null state does NOT suppress -- it is UNKNOWN', () => {
  // This is the shape `az resource list` returns for EVERY cluster, because it
  // does not expand properties. Under `state !== 'Running'` this suppresses the
  // lane on every PR forever, and the grey skip hides it.
  const v = classify([{ name: 'adx-a', state: null }]);
  assert.equal(v.paused, false, 'a null state must never be read as paused');
  assert.equal(v.reason, 'state-unreadable');
});

test('REGRESSION: a genuinely broken cluster does NOT get folded into "paused"', () => {
  // Unavailable / Deleting are real problems. The what-if SHOULD run and go red
  // and say so. Suppressing here would convert a defect into silence.
  for (const state of ['Unavailable', 'Deleting', 'Deleted', 'Migrated']) {
    const v = classify([{ name: 'adx-a', state }]);
    assert.equal(v.paused, false, `${state} must NOT suppress -- it is a finding, not a pause`);
    assert.equal(v.reason, 'estate-live');
  }
});

test('the pause set is an explicit allowlist, not the complement of Running', () => {
  // Pins the design decision itself, so the intent survives a refactor.
  assert.deepEqual([...PAUSE_STATES].sort(), ['Starting', 'Stopped', 'Stopping']);
  assert.equal(PAUSE_STATES.has('Running'), false);
  assert.equal(PAUSE_STATES.has('Unavailable'), false);
});

// ------------------------------------------------- every UNKNOWN falls through

test('a failed probe does NOT suppress', () => {
  // az errored, was not installed, timed out, returned non-JSON. "I could not
  // tell" must never become "it is paused".
  for (const input of [null, undefined]) {
    const v = classify(input);
    assert.equal(v.paused, false);
    assert.equal(v.reason, 'probe-failed');
  }
});

test('a malformed response does NOT suppress', () => {
  for (const input of [{}, 'Stopped', 42]) {
    const v = classify(input);
    assert.equal(v.paused, false, `${JSON.stringify(input)} must not suppress`);
    assert.equal(v.reason, 'probe-malformed');
  }
});

test('ZERO clusters does NOT suppress -- a zero here is UNKNOWN', () => {
  // Wrong subscription, missing reader grant and an unregistered provider all
  // look identical to a genuinely empty subscription. R5: refuse the zero.
  const v = classify([]);
  assert.equal(v.paused, false);
  assert.equal(v.reason, 'no-clusters');
});

test('a cluster object missing its state field entirely does NOT suppress', () => {
  assert.equal(classify([{ name: 'adx-a' }]).paused, false);
  assert.equal(classify([{}]).paused, false);
  assert.equal(classify([null]).paused, false);
});

test('an empty-string state does NOT suppress', () => {
  assert.equal(classify([{ name: 'adx-a', state: '' }]).paused, false);
});

test('state matching is case-sensitive to the ARM spelling', () => {
  // ARM returns 'Stopped'. If a future caller lowercases the payload the match
  // silently stops firing -- the lane goes red again rather than wrongly grey,
  // which is the safe direction, but pin it so the behaviour is deliberate.
  assert.equal(classify([{ name: 'a', state: 'stopped' }]).paused, false);
});

// ------------------------------------------------- multi-cluster

test('ANY paused cluster suppresses -- one stopped cluster blinds the whole what-if', () => {
  // The what-if is a single ARM call; one unenumerable cluster fails all of it.
  const v = classify([
    { name: 'adx-live', state: 'Running' },
    { name: 'adx-paused', state: 'Stopped' },
  ]);
  assert.equal(v.paused, true);
  assert.match(v.detail, /1 of 2/);
  assert.match(v.detail, /adx-paused=Stopped/);
  assert.doesNotMatch(v.detail, /adx-live/, 'detail names the paused clusters, not the live ones');
});

test('a paused cluster still suppresses when a sibling state is unreadable', () => {
  const v = classify([
    { name: 'adx-unknown', state: null },
    { name: 'adx-paused', state: 'Stopped' },
  ]);
  assert.equal(v.paused, true);
});

test('partially-unreadable but nothing paused does NOT suppress', () => {
  const v = classify([
    { name: 'adx-unknown', state: null },
    { name: 'adx-live', state: 'Running' },
  ]);
  assert.equal(v.paused, false);
  assert.equal(v.reason, 'estate-live');
});

// ------------------------------------------------- contract

test('every verdict carries a distinguishable reason and a non-empty detail', () => {
  // The workflow surfaces `detail` in the PR comment and the job summary. A
  // blank one turns an explained skip back into an unexplained one.
  const inputs = [null, {}, [], [{ name: 'a', state: null }],
    [{ name: 'a', state: 'Running' }], [{ name: 'a', state: 'Stopped' }]];
  const reasons = new Set();
  for (const i of inputs) {
    const v = classify(i);
    assert.equal(typeof v.paused, 'boolean');
    assert.ok(v.detail && v.detail.length > 10, `detail too thin for ${JSON.stringify(i)}`);
    reasons.add(v.reason);
  }
  assert.equal(reasons.size, 6, 'each distinct input class must be separately diagnosable');
});

test('the live ground truth for this estate classifies as paused', () => {
  // Measured 2026-08-24 against the real Commercial estate: adx-csa-loom-z52x3p
  // in rg-csa-loom-admin-centralus, state 'Stopped', provisioningState
  // 'Succeeded'. This is the case the whole change exists to handle.
  const v = classify([{ name: 'adx-csa-loom-z52x3p', state: 'Stopped' }]);
  assert.equal(v.paused, true);
});
