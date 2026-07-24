import { describe, it, expect } from 'vitest';
import { evaluateMonitor, type MonitorObservation } from '@/lib/observability/incident-monitor-model';

function history(values: number[], columns?: string[][]): MonitorObservation[] {
  const base = Date.parse('2026-07-01T00:00:00Z');
  return values.map((v, i) => ({
    at: new Date(base + i * 3600_000).toISOString(),
    value: v,
    ...(columns ? { columns: columns[i] } : {}),
  }));
}

describe('freshness monitor', () => {
  it('trips when data age exceeds the SLA (stale seeded table)', () => {
    const v = evaluateMonitor(
      { kind: 'freshness', freshnessSlaMinutes: 60 },
      { at: '2026-07-02T00:00:00Z', value: 240 }, // 4 h old, SLA 60 min
      history([10, 12, 9, 11]),
    );
    expect(v.tripped).toBe(true);
    expect(v.severity).toBe('error');
    expect(v.metric?.threshold).toBe(60);
    expect(v.metric?.value).toBe(240);
  });

  it('is healthy within the SLA and never red on first observation', () => {
    const v = evaluateMonitor({ kind: 'freshness', freshnessSlaMinutes: 1440 }, { at: 'x', value: 30 }, []);
    expect(v.tripped).toBe(false);
    expect(v.severity).toBe('info');
  });
});

describe('volume monitor (two-sided)', () => {
  it('trips on a spike outlier', () => {
    const v = evaluateMonitor({ kind: 'volume', zThreshold: 3 }, { at: 'x', value: 1000 }, history([100, 102, 98, 101, 99, 100]));
    expect(v.tripped).toBe(true);
    expect(v.title).toMatch(/spike/);
    expect((v.metric?.zScore ?? 0)).toBeGreaterThan(3);
  });

  it('trips on a DROP outlier (a drop is as much a regression as a spike)', () => {
    const v = evaluateMonitor({ kind: 'volume', zThreshold: 3 }, { at: 'x', value: 2 }, history([100, 102, 98, 101, 99, 100]));
    expect(v.tripped).toBe(true);
    expect(v.title).toMatch(/drop/);
    expect((v.metric?.zScore ?? 0)).toBeLessThan(0);
  });

  it('does not trip within the normal band', () => {
    const v = evaluateMonitor({ kind: 'volume' }, { at: 'x', value: 101 }, history([100, 102, 98, 101, 99, 100]));
    expect(v.tripped).toBe(false);
  });

  it('never trips with no baseline (tracking begins now)', () => {
    const v = evaluateMonitor({ kind: 'volume' }, { at: 'x', value: 500 }, []);
    expect(v.tripped).toBe(false);
  });
});

describe('schema-drift monitor', () => {
  it('trips (error) when a column is removed', () => {
    const v = evaluateMonitor(
      { kind: 'schema-drift' },
      { at: '2026-07-02T00:00:00Z', value: 2, columns: ['id', 'name'] },
      history([3], [['id', 'name', 'amount']]),
    );
    expect(v.tripped).toBe(true);
    expect(v.severity).toBe('error');
    expect(v.schemaChange?.removed).toContain('amount');
    expect(v.schemaChange?.added).toEqual([]);
  });

  it('trips (warning) on a pure addition', () => {
    const v = evaluateMonitor(
      { kind: 'schema-drift' },
      { at: '2026-07-02T00:00:00Z', value: 3, columns: ['id', 'name', 'email'] },
      history([2], [['id', 'name']]),
    );
    expect(v.tripped).toBe(true);
    expect(v.severity).toBe('warning');
    expect(v.schemaChange?.added).toContain('email');
  });

  it('is clean (no red) on the first recorded schema', () => {
    const v = evaluateMonitor({ kind: 'schema-drift' }, { at: 'x', value: 2, columns: ['id', 'name'] }, []);
    expect(v.tripped).toBe(false);
    expect(v.severity).toBe('info');
  });

  it('does not trip when the column set is unchanged', () => {
    const v = evaluateMonitor(
      { kind: 'schema-drift' },
      { at: '2026-07-02T00:00:00Z', value: 2, columns: ['name', 'id'] }, // order-insensitive
      history([2], [['id', 'name']]),
    );
    expect(v.tripped).toBe(false);
  });
});
