import test from 'node:test';
import assert from 'node:assert/strict';
import { decideIdlePause } from '../idle-policy.mjs';

const NOW = Date.parse('2026-10-13T12:00:00Z');
// idleHours=4 -> window 14400s. Last activity exactly 4h before NOW = exactly met.
const iso = (offsetSec) => new Date(NOW - offsetSec * 1000).toISOString();
// Real shape: estate-power-contract.ts EstatePowerStatus under `power`, estate state at top level.
const state = ({ st = 'RUNNING', last = iso(14400), idle = 14400, enabled = true, hours = 4, source = 'stored', unreadable = false, activity, autoPause } = {}) => ({
  state: st,
  power: {
    activity: activity === undefined ? { lastActivityAt: last, idleForSeconds: idle, unreadable } : activity,
    autoPause: autoPause === undefined ? { enabled, idleHours: hours, source, updatedAt: null, updatedBy: null } : autoPause,
    lastPausedAt: null,
    lastResumedAt: null,
  },
});
const quiet = { ok: true, runs: [] };
const go = (o) => decideIdlePause({ now: NOW, declared: { declared: false }, activity: quiet, state: state(), ...o });

test('POSITIVE CONTROL / boundary: idle for exactly idleHours (14400s) pauses', () => {
  const d = go({});
  assert.equal(d.decision, 'pause');
  assert.equal(d.code, 'idle');
});

test('boundary: idle 1 second SHORT of idleHours (14399s) skips -- breaks a >= turned into a >, or a window off by one', () => {
  const d = go({ state: state({ last: iso(14399), idle: 14399 }) });
  assert.equal(d.decision, 'skip');
  assert.equal(d.code, 'not-idle-long-enough');
});

test('both clocks must agree: our clock says 14400s but the console idleForSeconds says 14399 -> skip', () => {
  assert.equal(go({ state: state({ last: iso(14400), idle: 14399 }) }).code, 'not-idle-long-enough');
  assert.equal(go({ state: state({ last: iso(14399), idle: 14400 }) }).code, 'not-idle-long-enough');
});

const SKIPS = [
  ['autoPause disabled', { state: state({ enabled: false }) }, 'autopause-disabled'],
  ['autoPause enabled is the string "true", not boolean true', { state: state({ autoPause: { enabled: 'true', idleHours: 4, source: 'stored' } }) }, 'autopause-disabled'],
  ['autoPause object missing', { state: state({ autoPause: null }) }, 'autopause-disabled'],
  ['autoPause.source unreadable (values are defaults, must not be acted on)', { state: state({ source: 'unreadable' }) }, 'autopause-unreadable'],
  ['estate PAUSED', { state: state({ st: 'PAUSED' }) }, 'not-running'],
  ['estate RESUME_FAILED', { state: state({ st: 'RESUME_FAILED' }) }, 'not-running'],
  ['estate state missing', { state: state({ st: null }) }, 'not-running'],
  ['PAUSING (in flight)', { state: state({ st: 'PAUSING' }) }, 'in-flight'],
  ['RESUMING (in flight)', { state: state({ st: 'RESUMING' }) }, 'in-flight'],
  ['lastActivityAt null (no activity recorded is NOT idle forever)', { state: state({ last: null, idle: null }) }, 'activity-unknown'],
  ['lastActivityAt unparseable', { state: state({ last: 'yesterday-ish' }) }, 'activity-unknown'],
  ['activity.unreadable true even with a stale timestamp', { state: state({ unreadable: true }) }, 'activity-unknown'],
  ['power.activity missing', { state: state({ activity: null }) }, 'activity-unknown'],
  ['idleForSeconds null while lastActivityAt is set', { state: state({ idle: null }) }, 'activity-unknown'],
  ['lastActivityAt in the future (clock skew)', { state: state({ last: iso(-3600), idle: 20000 }) }, 'not-idle-long-enough'],
  ['idleHours 0', { state: state({ hours: 0 }) }, 'idle-hours-invalid'],
  ['idleHours missing', { state: state({ autoPause: { enabled: true, source: 'stored' } }) }, 'idle-hours-invalid'],
  ['declared paused', { declared: { declared: true } }, 'declared-paused'],
  ['activity read FAILED', { activity: { ok: false, reason: 'az rest failed (exit 1)' } }, 'activity-read-failed'],
  ['activity result missing', { activity: undefined }, 'activity-read-failed'],
  ['no state at all', { state: null }, 'state-missing'],
  ['now is NaN', { now: NaN }, 'now-invalid'],
];
for (const [name, over, code] of SKIPS) {
  test(`skip: ${name} -> ${code}`, () => {
    const d = go(over);
    assert.equal(d.decision, 'skip', `${name} must not pause`);
    assert.equal(d.code, code);
  });
}

test('a failed activity read names WHY in the reason (not just "skip")', () => {
  const d = go({ activity: { ok: false, reason: 'az rest failed (exit 1): AuthorizationFailed' } });
  assert.match(d.reason, /AuthorizationFailed/);
});

test('pipeline run: started 1s INSIDE the window skips; started 1s BEFORE the window does not', () => {
  const inside = go({ activity: { ok: true, runs: [{ startedAt: iso(14399), status: 'Succeeded' }] } });
  assert.equal(inside.code, 'recent-pipeline-run');
  const outside = go({ activity: { ok: true, runs: [{ startedAt: iso(14401), status: 'Succeeded' }] } });
  assert.equal(outside.decision, 'pause');
});

test('pipeline run started EXACTLY at the window edge (14400s ago) counts as in-window and skips -- breaks >= turned into >', () => {
  const d = go({ activity: { ok: true, runs: [{ startedAt: iso(14400), status: 'Succeeded' }] } });
  assert.equal(d.code, 'recent-pipeline-run');
});

test('pipeline run: still InProgress/Queued skips even if it started long ago', () => {
  for (const status of ['InProgress', 'Queued']) {
    const d = go({ activity: { ok: true, runs: [{ startedAt: iso(999999), status }] } });
    assert.equal(d.code, 'recent-pipeline-run', status);
  }
});

test('pipeline run with an unparseable startedAt is treated as activity, not ignored', () => {
  assert.equal(go({ activity: { ok: true, runs: [{ startedAt: null, status: 'Succeeded' }] } }).code, 'recent-pipeline-run');
});

test('Date objects as now are accepted (same answer as epoch ms)', () => {
  assert.equal(go({ now: new Date(NOW) }).decision, 'pause');
});
