import { describe, it, expect } from 'vitest';
import { mergeCheckHistory } from '../dq-transform-checks';
import type { MetricObservation } from '../dq-anomaly-baseline';

describe('mergeCheckHistory', () => {
  it('appends new observations to a per-check history', () => {
    const prev = { a: [{ at: '2026-07-01T00:00:00Z', value: 1 }] };
    const merged = mergeCheckHistory(prev, { a: { at: '2026-07-02T00:00:00Z', value: 2 } });
    expect(merged.a).toHaveLength(2);
    expect(merged.a[1].value).toBe(2);
  });

  it('creates a fresh history for a never-seen check', () => {
    const merged = mergeCheckHistory(undefined, { b: { at: '2026-07-02T00:00:00Z', value: 5 } });
    expect(merged.b).toEqual([{ at: '2026-07-02T00:00:00Z', value: 5 }]);
  });

  it('keeps existing checks that had no new observation', () => {
    const prev = { a: [{ at: '2026-07-01T00:00:00Z', value: 1 }] };
    const merged = mergeCheckHistory(prev, { b: { at: '2026-07-02T00:00:00Z', value: 2 } });
    expect(merged.a).toHaveLength(1);
    expect(merged.b).toHaveLength(1);
  });

  it('caps the history to the most recent N and keeps chronological order', () => {
    const many: MetricObservation[] = Array.from({ length: 60 }, (_, i) => ({ at: `2026-07-01T00:${String(i).padStart(2, '0')}:00Z`, value: i }));
    const merged = mergeCheckHistory({ a: many }, { a: { at: '2026-07-01T02:00:00Z', value: 999 } }, 50);
    expect(merged.a).toHaveLength(50);
    expect(merged.a[merged.a.length - 1].value).toBe(999);
  });
});
