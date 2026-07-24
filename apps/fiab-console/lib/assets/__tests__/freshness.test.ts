/**
 * N5 — freshness-policy evaluation, pinned at the BOUNDARIES.
 *
 * The closed-open contract these tests lock in:
 *   age <= cadence                    → fresh
 *   cadence < age <= cadence + grace  → stale
 *   age  > cadence + grace            → overdue
 * plus the two non-numeric states: `never` (no materialization yet — a guided
 * state, never red on first open) and `unmanaged` (no cadence declared).
 */
import { describe, expect, it } from 'vitest';
import { evaluateFreshness, rollupFreshness, FRESHNESS_RANK } from '../freshness';
import type { AssetFreshnessPolicy } from '@/lib/azure/asset-registry-model';

const NOW = Date.parse('2026-07-23T12:00:00.000Z');
/** hourly cadence (60 min) + 15 min grace → fresh ≤60, stale ≤75, overdue >75. */
const hourly: AssetFreshnessPolicy = {
  cadence: 'hourly', grace: '15m', mode: 'auto', alertSeverity: 'P3',
};

function atAgeMinutes(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

describe('evaluateFreshness — boundaries', () => {
  it('is FRESH right up to and including the cadence', () => {
    expect(evaluateFreshness({ policy: hourly, lastMaterializedAt: atAgeMinutes(0), now: NOW }).status).toBe('fresh');
    expect(evaluateFreshness({ policy: hourly, lastMaterializedAt: atAgeMinutes(59), now: NOW }).status).toBe('fresh');
    expect(evaluateFreshness({ policy: hourly, lastMaterializedAt: atAgeMinutes(60), now: NOW }).status).toBe('fresh');
  });

  it('turns STALE one minute past the cadence and stays stale through the grace', () => {
    expect(evaluateFreshness({ policy: hourly, lastMaterializedAt: atAgeMinutes(61), now: NOW }).status).toBe('stale');
    expect(evaluateFreshness({ policy: hourly, lastMaterializedAt: atAgeMinutes(75), now: NOW }).status).toBe('stale');
  });

  it('turns OVERDUE one minute past cadence + grace, and reports by how much', () => {
    const e = evaluateFreshness({ policy: hourly, lastMaterializedAt: atAgeMinutes(76), now: NOW });
    expect(e.status).toBe('overdue');
    expect(e.overdueByMinutes).toBe(1);

    const worse = evaluateFreshness({ policy: hourly, lastMaterializedAt: atAgeMinutes(200), now: NOW });
    expect(worse.overdueByMinutes).toBe(125);
  });

  it('reports the age, the cadence/grace it used, and when the asset is next due', () => {
    const e = evaluateFreshness({ policy: hourly, lastMaterializedAt: atAgeMinutes(30), now: NOW });
    expect(e.ageMinutes).toBe(30);
    expect(e.cadenceMinutes).toBe(60);
    expect(e.graceMinutes).toBe(15);
    expect(e.dueAt).toBe(new Date(NOW - 30 * 60_000 + 60 * 60_000).toISOString());
  });

  it('with NO grace, one minute past the cadence is already overdue', () => {
    const noGrace: AssetFreshnessPolicy = { ...hourly, grace: 'none' };
    expect(evaluateFreshness({ policy: noGrace, lastMaterializedAt: atAgeMinutes(60), now: NOW }).status).toBe('fresh');
    expect(evaluateFreshness({ policy: noGrace, lastMaterializedAt: atAgeMinutes(61), now: NOW }).status).toBe('overdue');
  });
});

describe('evaluateFreshness — non-numeric states', () => {
  it('a cadence with no materialization is NEVER (guided), not overdue', () => {
    const e = evaluateFreshness({ policy: hourly, now: NOW });
    expect(e.status).toBe('never');
    expect(e.ageMinutes).toBeNull();
    expect(e.overdueByMinutes).toBe(0);
  });

  it('no declared cadence is UNMANAGED however old the asset is', () => {
    const unmanaged: AssetFreshnessPolicy = { ...hourly, cadence: 'none' };
    const e = evaluateFreshness({ policy: unmanaged, lastMaterializedAt: atAgeMinutes(100_000), now: NOW });
    expect(e.status).toBe('unmanaged');
    expect(e.cadenceMinutes).toBe(0);
    expect(e.ageMinutes).toBe(100_000);
  });

  it('an unparseable timestamp degrades to NEVER rather than fabricating an age', () => {
    expect(evaluateFreshness({ policy: hourly, lastMaterializedAt: 'not-a-date', now: NOW }).status).toBe('never');
  });

  it('a future timestamp (clock skew) clamps to age 0, never a negative age', () => {
    const e = evaluateFreshness({ policy: hourly, lastMaterializedAt: atAgeMinutes(-30), now: NOW });
    expect(e.ageMinutes).toBe(0);
    expect(e.status).toBe('fresh');
  });
});

describe('rollupFreshness', () => {
  it('counts each status and headlines the WORST one present', () => {
    const r = rollupFreshness(['fresh', 'fresh', 'stale', 'overdue', 'never', 'unmanaged']);
    expect(r).toMatchObject({ total: 6, fresh: 2, stale: 1, overdue: 1, never: 1, unmanaged: 1 });
    expect(r.worst).toBe('overdue');
  });

  it('headlines stale when nothing is overdue', () => {
    expect(rollupFreshness(['fresh', 'stale', 'unmanaged']).worst).toBe('stale');
  });

  it('an empty estate rolls up to zero without claiming an incident', () => {
    const r = rollupFreshness([]);
    expect(r.total).toBe(0);
    expect(r.worst).toBe('unmanaged');
  });

  it('ranks overdue ahead of stale ahead of fresh (the sort the UI uses)', () => {
    expect(FRESHNESS_RANK.overdue).toBeLessThan(FRESHNESS_RANK.stale);
    expect(FRESHNESS_RANK.stale).toBeLessThan(FRESHNESS_RANK.fresh);
  });
});
