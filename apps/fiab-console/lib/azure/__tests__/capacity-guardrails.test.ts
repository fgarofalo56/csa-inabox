import { describe, it, expect } from 'vitest';
import {
  evaluateAdmission,
  sanitizeGuardrails,
  defaultGuardrails,
  type CapacityGuardrails,
} from '@/lib/azure/capacity-guardrails';

const base = (over: Partial<CapacityGuardrails> = {}): CapacityGuardrails => ({
  ...defaultGuardrails('tenant-1'),
  ...over,
});

describe('FGC-25 evaluateAdmission — threshold evaluation', () => {
  it('allows everything when disabled, even over threshold', () => {
    const g = base({ enabled: false, rejectionThresholdPct: 50 });
    expect(evaluateAdmission(g, { engine: 'adx', utilizationPct: 99 }).allow).toBe(true);
  });

  it('allows when utilization is below the capacity threshold', () => {
    const g = base({ rejectionThresholdPct: 90 });
    expect(evaluateAdmission(g, { engine: 'adx', utilizationPct: 80 }).allow).toBe(true);
  });

  it('rejects at or above the capacity threshold with the tripped rule', () => {
    const g = base({ rejectionThresholdPct: 90 });
    const d = evaluateAdmission(g, { engine: 'adx', utilizationPct: 90 });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.rule).toBe('capacity-threshold');
      expect(d.thresholdPct).toBe(90);
      expect(d.utilizationPct).toBe(90);
      expect(d.message).toMatch(/surge protection/i);
      expect(d.message).toMatch(/\/admin\/capacity/);
    }
  });

  it('honors a per-engine override threshold over the default', () => {
    const g = base({ rejectionThresholdPct: 90, perEngine: { adx: 70 } });
    // 75% is under the 90 default but over the 70 adx override → reject.
    const d = evaluateAdmission(g, { engine: 'adx', utilizationPct: 75 });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.thresholdPct).toBe(70);
    // A different engine still uses the default → allowed at 75%.
    expect(evaluateAdmission(g, { engine: 'spark', utilizationPct: 75 }).allow).toBe(true);
  });

  it('fails OPEN when utilization is unknown (null)', () => {
    const g = base({ rejectionThresholdPct: 50 });
    expect(evaluateAdmission(g, { engine: 'databricks', utilizationPct: null }).allow).toBe(true);
  });

  it('a zero threshold disables the capacity rule', () => {
    const g = base({ rejectionThresholdPct: 0 });
    expect(evaluateAdmission(g, { engine: 'adx', utilizationPct: 100 }).allow).toBe(true);
  });

  it('rejects on the per-workspace LCU/hour cap', () => {
    const g = base({ rejectionThresholdPct: 0, workspaceCuCapPerHour: 100 });
    const d = evaluateAdmission(g, { engine: 'spark', utilizationPct: null, workspaceCuThisHour: 120 });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.rule).toBe('workspace-cu-cap');
      expect(d.cuCap).toBe(100);
      expect(d.cuUsed).toBe(120);
    }
  });

  it('allows under the workspace cap and when the cap is 0 (unlimited)', () => {
    expect(
      evaluateAdmission(base({ rejectionThresholdPct: 0, workspaceCuCapPerHour: 100 }), {
        engine: 'spark', utilizationPct: null, workspaceCuThisHour: 40,
      }).allow,
    ).toBe(true);
    expect(
      evaluateAdmission(base({ rejectionThresholdPct: 0, workspaceCuCapPerHour: 0 }), {
        engine: 'spark', utilizationPct: null, workspaceCuThisHour: 9_999,
      }).allow,
    ).toBe(true);
  });

  it('capacity threshold takes precedence over the workspace cap', () => {
    const g = base({ rejectionThresholdPct: 90, workspaceCuCapPerHour: 100 });
    const d = evaluateAdmission(g, { engine: 'adx', utilizationPct: 95, workspaceCuThisHour: 200 });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.rule).toBe('capacity-threshold');
  });
});

describe('FGC-25 sanitizeGuardrails — clamping + validation', () => {
  it('clamps threshold into 0..100 and rounds', () => {
    const g = sanitizeGuardrails({ rejectionThresholdPct: 150 }, defaultGuardrails('t'));
    expect(g.rejectionThresholdPct).toBe(100);
    expect(sanitizeGuardrails({ rejectionThresholdPct: -5 }, defaultGuardrails('t')).rejectionThresholdPct).toBe(0);
  });

  it('drops blank per-engine overrides and clamps present ones', () => {
    const g = sanitizeGuardrails(
      { perEngine: { adx: 70, spark: '' as any, databricks: 999 as any } },
      defaultGuardrails('t'),
    );
    expect(g.perEngine.adx).toBe(70);
    expect(g.perEngine.spark).toBeUndefined();
    expect(g.perEngine.databricks).toBe(100);
  });

  it('coerces a negative or non-numeric workspace cap to 0 (unlimited)', () => {
    expect(sanitizeGuardrails({ workspaceCuCapPerHour: -3 }, defaultGuardrails('t')).workspaceCuCapPerHour).toBe(0);
    expect(sanitizeGuardrails({ workspaceCuCapPerHour: 'x' as any }, defaultGuardrails('t')).workspaceCuCapPerHour).toBe(0);
    expect(sanitizeGuardrails({ workspaceCuCapPerHour: 250 }, defaultGuardrails('t')).workspaceCuCapPerHour).toBe(250);
  });

  it('preserves the enabled flag or falls back to base', () => {
    expect(sanitizeGuardrails({ enabled: false }, defaultGuardrails('t')).enabled).toBe(false);
    expect(sanitizeGuardrails({}, defaultGuardrails('t')).enabled).toBe(true);
  });
});
