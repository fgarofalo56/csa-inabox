/**
 * N5 — asset-reconciler DECISION + THRASH-GUARD tests.
 *
 * A reconciler that can tight-loop is worse than no reconciler, so the guards
 * are pinned here as hard behaviour: a guard ALWAYS beats a trigger reason, and
 * the pass is bounded. The data-aware path (an upstream committed new data) is
 * pinned too — that is the whole reason the asset plane exists instead of a cron.
 */
import { describe, expect, it } from 'vitest';
import {
  BACKOFF_AFTER_FAILURES, DEFAULT_MAX_TRIGGERS, MIN_COOLDOWN_MINUTES,
  backoffMinutesFor, cooldownMinutesFor, decideAsset, planReconcile,
  type ReconcileCandidate,
} from '../reconciler-core';
import type { AssetFreshnessPolicy } from '@/lib/azure/asset-registry-model';

const NOW = Date.parse('2026-07-23T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const autoHourly: AssetFreshnessPolicy = {
  cadence: 'hourly', grace: '15m', mode: 'auto', alertSeverity: 'P3',
};

function candidate(overrides: Partial<ReconcileCandidate> = {}): ReconcileCandidate {
  return {
    assetKey: 'table:main.silver.orders',
    policy: autoHourly,
    materializer: 'sqlmesh',
    deps: ['table:main.bronze.orders_raw'],
    lastMaterializedAt: ago(10),
    ...overrides,
  };
}

describe('cooldown + backoff maths', () => {
  it('cooldown is the greater of the floor and a quarter of the cadence', () => {
    expect(cooldownMinutesFor(autoHourly)).toBe(Math.max(MIN_COOLDOWN_MINUTES, 15));
    expect(cooldownMinutesFor({ ...autoHourly, cadence: '15m' })).toBe(MIN_COOLDOWN_MINUTES);
    expect(cooldownMinutesFor({ ...autoHourly, cadence: 'daily' })).toBe(360);
  });

  it('backoff engages only after the failure threshold and is capped at a day', () => {
    expect(backoffMinutesFor(0)).toBe(0);
    expect(backoffMinutesFor(BACKOFF_AFTER_FAILURES - 1)).toBe(0);
    expect(backoffMinutesFor(BACKOFF_AFTER_FAILURES)).toBe(30);
    expect(backoffMinutesFor(BACKOFF_AFTER_FAILURES + 1)).toBe(60);
    expect(backoffMinutesFor(99)).toBe(1440);
  });
});

describe('decideAsset — policy opt-outs', () => {
  it('never triggers a MANUAL asset, however overdue', () => {
    const d = decideAsset(
      candidate({ policy: { ...autoHourly, mode: 'manual' }, lastMaterializedAt: ago(10_000) }),
      new Set(),
      NOW,
    );
    expect(d.trigger).toBe(false);
    expect(d.reason).toBe('manual');
    // …but the freshness is still evaluated, so the UI can badge it.
    expect(d.freshness).toBe('overdue');
  });

  it('never triggers an asset with no materializer bound, and says what to bind', () => {
    const d = decideAsset(candidate({ materializer: 'none', lastMaterializedAt: ago(10_000) }), new Set(), NOW);
    expect(d.trigger).toBe(false);
    expect(d.reason).toBe('no-materializer');
    expect(d.detail).toMatch(/Bind a SQLMesh\/dbt project/i);
  });

  it('does nothing for an unmanaged asset with no upstream change', () => {
    const d = decideAsset(
      candidate({ policy: { ...autoHourly, cadence: 'none' } }),
      new Set(),
      NOW,
    );
    expect(d.trigger).toBe(false);
    expect(d.reason).toBe('unmanaged');
  });
});

describe('decideAsset — thrash guards beat every trigger reason', () => {
  it('suppresses while the previous run is still IN FLIGHT', () => {
    const d = decideAsset(
      candidate({ lastRunOutcome: 'running', lastMaterializedAt: ago(10_000) }),
      new Set(['table:main.bronze.orders_raw']),
      NOW,
    );
    expect(d.trigger).toBe(false);
    expect(d.reason).toBe('in-flight');
  });

  it('suppresses inside the COOLDOWN even when an upstream just changed', () => {
    const d = decideAsset(
      candidate({ lastTriggerAt: ago(5), lastMaterializedAt: ago(10_000) }),
      new Set(['table:main.bronze.orders_raw']),
      NOW,
    );
    expect(d.trigger).toBe(false);
    expect(d.reason).toBe('cooldown');
  });

  it('re-allows once the cooldown has elapsed', () => {
    const d = decideAsset(
      candidate({ lastTriggerAt: ago(20), lastMaterializedAt: ago(10_000) }),
      new Set(['table:main.bronze.orders_raw']),
      NOW,
    );
    expect(d.trigger).toBe(true);
    expect(d.reason).toBe('upstream-changed');
  });

  it('BACKS OFF exponentially after repeated failures instead of hammering the engine', () => {
    // 4 failures → 60 min backoff; the last attempt was 30 min ago.
    const suppressed = decideAsset(
      candidate({ consecutiveFailures: 4, lastTriggerAt: ago(30), lastMaterializedAt: ago(10_000) }),
      new Set(['table:main.bronze.orders_raw']),
      NOW,
    );
    expect(suppressed.trigger).toBe(false);
    expect(suppressed.reason).toBe('backoff');

    // …and retries once the backoff window has passed (never gives up forever).
    const retried = decideAsset(
      candidate({ consecutiveFailures: 4, lastTriggerAt: ago(90), lastMaterializedAt: ago(10_000) }),
      new Set(['table:main.bronze.orders_raw']),
      NOW,
    );
    expect(retried.trigger).toBe(true);
  });

  it('a never-triggered asset is not held back by an absent watermark', () => {
    const d = decideAsset(candidate({ lastMaterializedAt: undefined }), new Set(), NOW);
    expect(d.trigger).toBe(true);
    expect(d.reason).toBe('never-materialized');
  });
});

describe('decideAsset — trigger reasons', () => {
  it('DATA-AWARE: an upstream that committed new data wins over freshness', () => {
    const d = decideAsset(candidate(), new Set(['table:main.bronze.orders_raw']), NOW);
    expect(d.trigger).toBe(true);
    expect(d.reason).toBe('upstream-changed');
    expect(d.freshness).toBe('fresh'); // fresh by the clock, but the DATA moved
    expect(d.detail).toContain('table:main.bronze.orders_raw');
  });

  it('a change to an unrelated asset does NOT trigger', () => {
    const d = decideAsset(candidate(), new Set(['table:other.thing']), NOW);
    expect(d.trigger).toBe(false);
    expect(d.reason).toBe('fresh');
  });

  it('SELF-CHANGED: the asset\'s own Delta version advanced past the materialized one', () => {
    const d = decideAsset(
      candidate({ observedVersion: 42, materializedVersion: 41 }),
      new Set(),
      NOW,
    );
    expect(d.trigger).toBe(true);
    expect(d.reason).toBe('self-changed');
    expect(d.detail).toContain('41 → 42');
  });

  it('an unchanged Delta version does not trigger', () => {
    const d = decideAsset(candidate({ observedVersion: 41, materializedVersion: 41 }), new Set(), NOW);
    expect(d.trigger).toBe(false);
    expect(d.reason).toBe('fresh');
  });

  it('OVERDUE past cadence + grace triggers; merely STALE does not', () => {
    // 70 min: past the 60-min cadence but inside the 15-min grace → stale, no trigger.
    const stale = decideAsset(candidate({ lastMaterializedAt: ago(70) }), new Set(), NOW);
    expect(stale.freshness).toBe('stale');
    expect(stale.trigger).toBe(false);
    expect(stale.detail).toMatch(/inside the 15-min grace window/i);

    const overdue = decideAsset(candidate({ lastMaterializedAt: ago(200) }), new Set(), NOW);
    expect(overdue.trigger).toBe(true);
    expect(overdue.reason).toBe('overdue');
  });
});

describe('planReconcile — ordering + the per-pass bound', () => {
  const many = (n: number): ReconcileCandidate[] =>
    Array.from({ length: n }, (_, i) => candidate({
      assetKey: `table:t${String(i).padStart(3, '0')}`,
      deps: [],
      lastMaterializedAt: ago(10_000),
    }));

  it('caps dispatches at maxTriggers and DEFERS the rest honestly', () => {
    const plan = planReconcile({ candidates: many(10), now: NOW, maxTriggers: 3 });
    expect(plan.triggers).toHaveLength(3);
    expect(plan.deferred).toHaveLength(7);
    for (const d of plan.deferred) {
      expect(d.trigger).toBe(false);
      expect(d.reason).toBe('pass-bound');
    }
    // The returned decision list reflects the FINAL outcome — an audited row can
    // never claim a dispatch the bound actually deferred.
    expect(plan.decisions.filter((d) => d.trigger)).toHaveLength(3);
  });

  it('orders upstream-changed ahead of overdue', () => {
    const plan = planReconcile({
      candidates: [
        candidate({ assetKey: 'table:late', deps: [], lastMaterializedAt: ago(10_000) }),
        candidate({ assetKey: 'table:changed', deps: ['table:up'], lastMaterializedAt: ago(10) }),
      ],
      changed: ['table:up'],
      now: NOW,
      maxTriggers: 1,
    });
    expect(plan.triggers).toHaveLength(1);
    expect(plan.triggers[0].assetKey).toBe('table:changed');
    expect(plan.triggers[0].reason).toBe('upstream-changed');
  });

  it('is DETERMINISTIC and IDEMPOTENT — replaying the same pass yields the same plan', () => {
    const input = { candidates: many(5), now: NOW, maxTriggers: 2 };
    const a = planReconcile(input);
    const b = planReconcile(input);
    expect(a.triggers.map((t) => t.assetKey)).toEqual(b.triggers.map((t) => t.assetKey));
  });

  it('re-running immediately after a dispatch triggers NOTHING (the loop the guard prevents)', () => {
    const first = planReconcile({ candidates: many(3), now: NOW, maxTriggers: DEFAULT_MAX_TRIGGERS });
    expect(first.triggers).toHaveLength(3);

    // Simulate the watermarks the dispatch writes, then run the pass again.
    const after = many(3).map((c) => ({ ...c, lastTriggerAt: new Date(NOW).toISOString() }));
    const second = planReconcile({ candidates: after, now: NOW + 60_000, maxTriggers: DEFAULT_MAX_TRIGGERS });
    expect(second.triggers).toHaveLength(0);
    expect(second.decisions.every((d) => d.reason === 'cooldown')).toBe(true);
  });

  it('a zero bound dispatches nothing at all (the emergency brake)', () => {
    const plan = planReconcile({ candidates: many(4), now: NOW, maxTriggers: 0 });
    expect(plan.triggers).toHaveLength(0);
    expect(plan.deferred).toHaveLength(4);
  });
});
