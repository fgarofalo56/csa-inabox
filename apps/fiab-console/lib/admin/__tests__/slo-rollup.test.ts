/** SLO1 — pure SLO / error-budget rollup: availability, latency, efficiency, burn alerts. */
import { describe, expect, it } from 'vitest';
import {
  buildSloRollup,
  rollupJourneyAvailability,
  rollupCopilotLatency,
  rollupCacheHitRate,
  burnAlerts,
  burnFromAttainment,
  JOURNEY_AVAILABILITY_OBJECTIVE,
  FAST_BURN_ALERT_THRESHOLD,
  SLO_WINDOW_DAYS,
} from '../slo-rollup';
import type { SyntheticRunSummary, JourneyVerdict } from '../synthetic-runs-reader';
import type { SloEvaluation } from '@/lib/perf/copilot-slo';
import type { CacheCountersSnapshot } from '@/lib/perf/cache-counters';

const NOW = new Date('2026-07-23T12:00:00.000Z');

function j(status: JourneyVerdict['status'], name = 'J1'): JourneyVerdict {
  return { name, verdict: '', status };
}
function run(tsDaysAgo: number, journeys: JourneyVerdict[]): SyntheticRunSummary {
  const ts = new Date(NOW.getTime() - tsDaysAgo * 24 * 60 * 60 * 1000).toISOString();
  return {
    runId: ts.replace(/[:.]/g, '-'),
    ts,
    pass: journeys.filter((x) => x.status === 'pass').length,
    fail: journeys.filter((x) => x.status === 'fail').length,
    skip: journeys.filter((x) => x.status === 'skip').length,
    journeys,
  };
}

function cache(hits: number, misses: number): CacheCountersSnapshot {
  const total = hits + misses;
  const one = { hits, misses, hitRate: total > 0 ? hits / total : 0 };
  return {
    byBackend: { 'result-cache': one, adx: one, tabular: one, cost: one },
    total: { hits, misses, hitRate: total > 0 ? hits / total : 0 },
  };
}

describe('burnFromAttainment', () => {
  it('is 0 without samples and 1 exactly at the objective boundary', () => {
    expect(burnFromAttainment(0.99, 1, 0)).toBe(0);
    // attainment == objective → actualFailRate == allowedFailRate → burn 1
    expect(burnFromAttainment(0.99, 0.99, 100)).toBeCloseTo(1, 5);
  });
  it('scales linearly with the failure rate', () => {
    // objective 0.99 → allowed fail 0.01; actual fail 0.02 → 2× burn
    expect(burnFromAttainment(0.99, 0.98, 100)).toBeCloseTo(2, 5);
  });
});

describe('rollupJourneyAvailability', () => {
  it('reports 100% attainment and full budget when every journey passes', () => {
    const runs = [run(1, [j('pass'), j('pass', 'J2')]), run(2, [j('pass')])];
    const row = rollupJourneyAvailability(runs, NOW);
    expect(row.attainment).toBe(1);
    expect(row.met).toBe(true);
    expect(row.burn).toBe(0);
    expect(row.budgetRemaining).toBe(1);
    expect(row.dataAvailable).toBe(true);
    expect(row.sampled).toBe(3);
  });

  it('excludes skip/vaporware from the ratio', () => {
    const row = rollupJourneyAvailability([run(1, [j('pass'), j('skip'), j('vaporware')])], NOW);
    expect(row.sampled).toBe(1); // only the pass counts
    expect(row.good).toBe(1);
  });

  it('drops runs older than the window', () => {
    const row = rollupJourneyAvailability([run(SLO_WINDOW_DAYS + 5, [j('fail')])], NOW);
    expect(row.sampled).toBe(0);
    expect(row.dataAvailable).toBe(false);
    expect(row.met).toBe(true); // no news is good news
    expect(row.unavailableReason).toBeTruthy();
  });

  it('computes burn > threshold on a heavy failure rate and builds a burn-down series', () => {
    // 10 fails / 90 pass over one day → attainment 0.9, allowed 0.01 → burn 10×
    const journeys = [
      ...Array.from({ length: 90 }, () => j('pass')),
      ...Array.from({ length: 10 }, () => j('fail')),
    ];
    const row = rollupJourneyAvailability([run(1, journeys)], NOW);
    expect(row.attainment).toBeCloseTo(0.9, 5);
    expect(row.met).toBe(false);
    expect(row.burn).toBeGreaterThan(FAST_BURN_ALERT_THRESHOLD);
    expect(row.series.length).toBe(1);
    expect(row.series[0].burnedFraction).toBeGreaterThan(1); // budget blown
    expect(row.budgetRemaining).toBe(0); // clamped
  });

  it('orders the day series chronologically across multiple days', () => {
    const runs = [run(3, [j('pass')]), run(1, [j('fail')]), run(2, [j('pass')])];
    const row = rollupJourneyAvailability(runs, NOW);
    const days = row.series.map((b) => b.day);
    expect([...days].sort()).toEqual(days); // already ascending
    expect(row.series.length).toBe(3);
  });
});

describe('rollupCopilotLatency', () => {
  const ev: SloEvaluation = {
    id: 'copilot-full-turn', budgetMs: 30000, objective: 0.95,
    sampled: 100, good: 90, attainment: 0.9, met: false, burn: 2,
  };
  it('maps an evaluation into a latency SLI row', () => {
    const row = rollupCopilotLatency(ev, 'Copilot full-turn latency', 'desc');
    expect(row.category).toBe('latency');
    expect(row.burn).toBe(2);
    expect(row.met).toBe(false);
    expect(row.dataAvailable).toBe(true);
    expect(row.series).toEqual([]);
  });
  it('marks no-data when the window is empty', () => {
    const row = rollupCopilotLatency({ ...ev, sampled: 0, good: 0, attainment: 1, met: true, burn: 0 }, 'l', 'd');
    expect(row.dataAvailable).toBe(false);
    expect(row.unavailableReason).toBeTruthy();
  });
});

describe('rollupCacheHitRate', () => {
  it('is an efficiency SLI that never counts as availability/latency', () => {
    const row = rollupCacheHitRate(cache(70, 30));
    expect(row.category).toBe('efficiency');
    expect(row.attainment).toBeCloseTo(0.7, 5);
    expect(row.met).toBe(true); // 0.7 >= 0.5 floor
  });
  it('reports no-data with zero lookups', () => {
    const row = rollupCacheHitRate(cache(0, 0));
    expect(row.dataAvailable).toBe(false);
  });
});

describe('burnAlerts', () => {
  it('pages availability/latency rows over threshold but never efficiency', () => {
    const rows = [
      rollupJourneyAvailability(
        [run(1, [...Array.from({ length: 90 }, () => j('pass')), ...Array.from({ length: 10 }, () => j('fail'))])],
        NOW,
      ),
      rollupCacheHitRate(cache(1, 99)), // 1% hit-rate — bad, but efficiency never pages
    ];
    const alerts = burnAlerts(rows);
    expect(alerts.map((a) => a.sliId)).toContain('journey-availability');
    expect(alerts.map((a) => a.sliId)).not.toContain('cache-hit-rate');
  });

  it('does not page a healthy SLI', () => {
    const rows = [rollupJourneyAvailability([run(1, [j('pass'), j('pass', 'J2')])], NOW)];
    expect(burnAlerts(rows)).toEqual([]);
  });
});

describe('buildSloRollup', () => {
  const copilot: SloEvaluation[] = [
    { id: 'copilot-first-token', budgetMs: 5000, objective: 0.95, sampled: 50, good: 50, attainment: 1, met: true, burn: 0 },
    { id: 'copilot-full-turn', budgetMs: 30000, objective: 0.95, sampled: 50, good: 48, attainment: 0.96, met: true, burn: 0.8 },
  ];

  it('assembles availability + latency + efficiency rows and flags anyData', () => {
    const rollup = buildSloRollup({
      now: NOW,
      runs: [run(1, [j('pass'), j('pass', 'J2')])],
      copilot,
      cache: cache(50, 50),
    });
    expect(rollup.rows.map((r) => r.id)).toEqual([
      'journey-availability', 'copilot-first-token', 'copilot-full-turn', 'cache-hit-rate',
    ]);
    expect(rollup.anyData).toBe(true);
    expect(rollup.windowDays).toBe(SLO_WINDOW_DAYS);
    expect(rollup.alerts).toEqual([]); // all healthy
  });

  it('surfaces a fast-burn alert when a seeded breach is present', () => {
    const breachRuns = [
      run(1, [...Array.from({ length: 80 }, () => j('pass')), ...Array.from({ length: 20 }, () => j('fail'))]),
    ];
    const rollup = buildSloRollup({ now: NOW, runs: breachRuns, copilot, cache: cache(50, 50) });
    expect(rollup.alerts.length).toBe(1);
    expect(rollup.alerts[0].sliId).toBe('journey-availability');
    expect(rollup.alerts[0].burn).toBeGreaterThanOrEqual(FAST_BURN_ALERT_THRESHOLD);
  });

  it('honours the availability objective default', () => {
    expect(JOURNEY_AVAILABILITY_OBJECTIVE).toBe(0.99);
  });
});
