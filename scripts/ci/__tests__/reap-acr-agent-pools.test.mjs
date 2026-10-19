/**
 * Self-test for scripts/ci/reap-acr-agent-pools.mjs `decideReap`.
 *
 * The baseline fixture is the measured 2026-10-19 leak: an S3 pool at count=1,
 * Succeeded, nothing queued or running, last modified and last used long ago.
 * That MUST reap. Every other case changes exactly ONE field from it, so each
 * `keep`/`unknown` assertion names the single value that would turn it into a
 * reap if the corresponding guard were deleted.
 *
 * Run: node --test scripts/ci/__tests__/reap-acr-agent-pools.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideReap } from '../reap-acr-agent-pools.mjs';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const IDLE = 30;
const minsAgo = (m) => NOW - m * 60_000;

const LEAKED = Object.freeze({
  count: 1,
  provisioningState: 'Succeeded',
  queueCount: 0,
  activeRuns: 0,
  lastModifiedMs: minsAgo(60 * 24 * 3),
  runsReadable: true,
  lastRunFinishMs: minsAgo(60 * 24 * 2),
});
const decide = (patch) => decideReap({ ...LEAKED, ...patch }, NOW, IDLE).action;

test('the measured leak (count=1, idle for days) is reaped', () => {
  // Breaks if any guard below wrongly fires on the idle pool, e.g. a recency
  // check that compares in the wrong direction.
  assert.equal(decide({}), 'reap');
});

test('a pool already at 0 is a noop, not a reap', () => {
  // Breaks if the count==0 early-return is deleted (would re-issue an update).
  assert.equal(decide({ count: 0 }), 'noop');
});

test('busy pools are kept', () => {
  // Each breaks if its guard is deleted: LEAKED with that one field set reaps.
  assert.equal(decide({ queueCount: 1 }), 'keep');
  assert.equal(decide({ activeRuns: 1 }), 'keep');
});

test('a pool scaled up moments ago is kept (build about to submit)', () => {
  // 29 min < 30: breaks if the lastModified window is deleted or uses >.
  assert.equal(decide({ lastModifiedMs: minsAgo(29) }), 'keep');
  // 31 min > 30 with everything else idle: pins the boundary from the other side.
  assert.equal(decide({ lastModifiedMs: minsAgo(31) }), 'reap');
});

test('a pool whose last run finished inside the window is kept', () => {
  assert.equal(decide({ lastRunFinishMs: minsAgo(10) }), 'keep');
  // No run on this pool at all in the listed window is NOT a reason to keep.
  assert.equal(decide({ lastRunFinishMs: null }), 'reap');
});

test('a non-Succeeded (wedged, #2706) pool is never mutated', () => {
  // Breaks if the provisioningState guard is deleted.
  assert.equal(decide({ provisioningState: 'Failed' }), 'keep');
});

test('any unreadable input yields unknown, never reap', () => {
  // Each value below is "the read failed"; without the guard, the first three
  // would compare null as 0 and reap a pool whose state was never established.
  assert.equal(decide({ queueCount: null }), 'unknown');
  assert.equal(decide({ activeRuns: null }), 'unknown');
  assert.equal(decide({ lastModifiedMs: null }), 'unknown');
  assert.equal(decide({ runsReadable: false }), 'unknown');
  assert.equal(decide({ count: null }), 'unknown');
});
