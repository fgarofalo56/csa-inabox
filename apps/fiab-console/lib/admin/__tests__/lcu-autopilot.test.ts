/**
 * WS-10.1 — unit tests for the PURE LCU-Autopilot policy engine.
 *
 * Pins the decider contract: idle compute → pause-idle rec with real $ saving,
 * an over-provisioned env ceiling → right-size env-roll, hysteresis (sustained-
 * idle window + per-target cooldown) blocks premature/repeat action, unknown
 * utilization is never treated as idle (fail-safe), and advisory (migrate) recs
 * are never auto-applicable. No Azure/Cosmos — this is the loop's brain in
 * isolation.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveAutopilotRecommendations,
  autoApplicableRecommendations,
  totalMonthlySaving,
  DEFAULT_AUTOPILOT_POLICY,
  type AutopilotSignals,
  type ComputeTelemetry,
} from '@/lib/admin/lcu-autopilot';

function warehouse(over: Partial<ComputeTelemetry> = {}): ComputeTelemetry {
  return {
    kind: 'warehouse',
    id: 'warehouse:loompool',
    name: 'loompool',
    lcuPerHour: 12,
    usdMonthly: 240,
    utilizationPct: 0.5,
    idleMinutes: 120,
    state: 'Online',
    pausable: true,
    pauseActuator: { type: 'pause', kind: 'warehouse', resourceId: '/sub/x/warehouse' },
    ...over,
  };
}

function signals(over: Partial<AutopilotSignals> = {}): AutopilotSignals {
  return {
    compute: [],
    capacity: null,
    gatesBlocked: 0,
    totalLcuPerHour: 0,
    totalUsdMonthly: 0,
    ...over,
  };
}

const ctx = (lastActuatedAt: Record<string, string> = {}) => ({ now: Date.parse('2026-07-20T12:00:00Z'), lastActuatedAt });

describe('deriveAutopilotRecommendations — pause idle compute', () => {
  it('recommends pausing a sustained-idle running warehouse with real $ saved', () => {
    const recs = deriveAutopilotRecommendations(signals({ compute: [warehouse()] }), DEFAULT_AUTOPILOT_POLICY, ctx());
    const pause = recs.find((r) => r.kind === 'pause-idle');
    expect(pause).toBeTruthy();
    expect(pause!.target).toBe('warehouse:loompool');
    expect(pause!.usdSavedMonthly).toBe(240);
    expect(pause!.autoApplicable).toBe(true);
    expect(pause!.actuator.type).toBe('pause');
    expect(totalMonthlySaving(recs)).toBeGreaterThanOrEqual(240);
  });

  it('does NOT pause when utilization is above the idle threshold', () => {
    const recs = deriveAutopilotRecommendations(signals({ compute: [warehouse({ utilizationPct: 42 })] }), DEFAULT_AUTOPILOT_POLICY, ctx());
    expect(recs.some((r) => r.kind === 'pause-idle')).toBe(false);
  });

  it('does NOT pause when idle has not been sustained long enough (hysteresis window)', () => {
    const recs = deriveAutopilotRecommendations(signals({ compute: [warehouse({ idleMinutes: 10 })] }), DEFAULT_AUTOPILOT_POLICY, ctx());
    expect(recs.some((r) => r.kind === 'pause-idle')).toBe(false);
  });

  it('never treats UNKNOWN utilization (null) as idle — fail-safe', () => {
    const recs = deriveAutopilotRecommendations(signals({ compute: [warehouse({ utilizationPct: null })] }), DEFAULT_AUTOPILOT_POLICY, ctx());
    expect(recs.some((r) => r.kind === 'pause-idle')).toBe(false);
  });

  it('respects the per-target cooldown (does not re-recommend within cooldownMs)', () => {
    // Last actuated 1h ago; default cooldown is 6h → suppressed.
    const recent = new Date(Date.parse('2026-07-20T11:00:00Z')).toISOString();
    const recs = deriveAutopilotRecommendations(
      signals({ compute: [warehouse()] }),
      DEFAULT_AUTOPILOT_POLICY,
      ctx({ 'warehouse:loompool': recent }),
    );
    expect(recs.some((r) => r.kind === 'pause-idle')).toBe(false);
  });

  it('re-recommends once the cooldown has elapsed', () => {
    const old = new Date(Date.parse('2026-07-20T04:00:00Z')).toISOString(); // 8h ago > 6h
    const recs = deriveAutopilotRecommendations(
      signals({ compute: [warehouse()] }),
      DEFAULT_AUTOPILOT_POLICY,
      ctx({ 'warehouse:loompool': old }),
    );
    expect(recs.some((r) => r.kind === 'pause-idle')).toBe(true);
  });

  it('skips a resource too cheap to bother pausing', () => {
    const recs = deriveAutopilotRecommendations(signals({ compute: [warehouse({ usdMonthly: 0.2 })] }), DEFAULT_AUTOPILOT_POLICY, ctx());
    expect(recs.some((r) => r.kind === 'pause-idle')).toBe(false);
  });
});

describe('deriveAutopilotRecommendations — right-size capacity (env-roll)', () => {
  const cap = (over = {}) => ({
    totalLcu: 30, peakLcu: 40, capacityLcu: 200, capacitySource: 'env' as const, utilizationPct: 15, ...over,
  });

  it('rolls LOOM_CAPACITY_LCU down when the env ceiling far exceeds observed peak', () => {
    const recs = deriveAutopilotRecommendations(signals({ capacity: cap() }), DEFAULT_AUTOPILOT_POLICY, ctx());
    const rs = recs.find((r) => r.kind === 'right-size');
    expect(rs).toBeTruthy();
    expect(rs!.actuator.type).toBe('env-roll');
    // peak 40 * 1.25 = 50
    expect((rs!.actuator as any).values.LOOM_CAPACITY_LCU).toBe('50');
    // honest: capacity ceiling is a reference, not spend → no fabricated $ saving
    expect(rs!.usdSavedMonthly).toBe(0);
  });

  it('does NOT right-size a derived (auto) ceiling — only an explicit env ceiling', () => {
    const recs = deriveAutopilotRecommendations(signals({ capacity: cap({ capacitySource: 'derived' }) }), DEFAULT_AUTOPILOT_POLICY, ctx());
    expect(recs.some((r) => r.kind === 'right-size')).toBe(false);
  });

  it('does NOT right-size when peak is already near the ceiling', () => {
    const recs = deriveAutopilotRecommendations(signals({ capacity: cap({ peakLcu: 180 }) }), DEFAULT_AUTOPILOT_POLICY, ctx());
    expect(recs.some((r) => r.kind === 'right-size')).toBe(false);
  });
});

describe('deriveAutopilotRecommendations — migrate is advisory only', () => {
  it('emits a migrate advisory for a deeply-idle expensive ADX cluster and never auto-applies it', () => {
    const adx: ComputeTelemetry = {
      kind: 'adx', id: 'adx:loomadx', name: 'loomadx', lcuPerHour: 20, usdMonthly: 900,
      utilizationPct: 0, idleMinutes: 240, state: 'Running', pausable: true,
      pauseActuator: { type: 'pause', kind: 'adx', resourceId: '/sub/x/adx' },
    };
    const recs = deriveAutopilotRecommendations(signals({ compute: [adx] }), DEFAULT_AUTOPILOT_POLICY, ctx());
    const migrate = recs.find((r) => r.kind === 'migrate');
    expect(migrate).toBeTruthy();
    expect(migrate!.actuator.type).toBe('advisory');
    expect(migrate!.autoApplicable).toBe(false);
    // advisory recs are excluded from what the auto loop may actuate
    expect(autoApplicableRecommendations(recs).some((r) => r.kind === 'migrate')).toBe(false);
  });
});

describe('autoApplicableRecommendations — propose-only never actuates advisory', () => {
  it('includes pause + env-roll but excludes advisory', () => {
    const adx: ComputeTelemetry = {
      kind: 'adx', id: 'adx:loomadx', name: 'loomadx', lcuPerHour: 20, usdMonthly: 900,
      utilizationPct: 0, idleMinutes: 240, state: 'Running', pausable: true,
      pauseActuator: { type: 'pause', kind: 'adx', resourceId: '/sub/x/adx' },
    };
    const recs = deriveAutopilotRecommendations(
      signals({ compute: [warehouse(), adx], capacity: { totalLcu: 30, peakLcu: 40, capacityLcu: 200, capacitySource: 'env', utilizationPct: 15 } }),
      DEFAULT_AUTOPILOT_POLICY,
      ctx(),
    );
    const auto = autoApplicableRecommendations(recs);
    expect(auto.every((r) => r.actuator.type !== 'advisory')).toBe(true);
    expect(auto.some((r) => r.kind === 'pause-idle')).toBe(true);
    expect(auto.some((r) => r.kind === 'right-size')).toBe(true);
  });
});
