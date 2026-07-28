/**
 * breaker-audit (CH1) — verifies the resilience inventory + coverage summary:
 *   - every CH1 fault point has exactly one matching matrix row,
 *   - every row is timeout-bounded (the enforced floor),
 *   - the coverage summary counts mechanisms correctly,
 *   - source files referenced are the real client files (path shape).
 */
import { describe, it, expect } from 'vitest';
import { RESILIENCE_MATRIX, auditBreakerCoverage } from '../breaker-audit';
import { FAULT_POINTS } from '../fault-injection';

describe('resilience matrix', () => {
  it('covers every CH1 fault point exactly once', () => {
    for (const p of FAULT_POINTS) {
      const rows = RESILIENCE_MATRIX.filter((r) => r.faultPoint === p);
      expect(rows.length, `fault point ${p}`).toBe(1);
    }
  });

  it('every row is timeout-bounded and has an honest gate (the floor)', () => {
    for (const r of RESILIENCE_MATRIX) {
      expect(r.mechanisms.timeout, `${r.dependency} timeout`).toBe(true);
      expect(r.mechanisms.honestGate, `${r.dependency} honestGate`).toBe(true);
      expect(r.sourceFile).toMatch(/^apps\/fiab-console\/lib\/azure\/[\w-]+\.ts$/);
      expect(r.degradesTo.length).toBeGreaterThan(20);
    }
  });

  it('at least one shared layer provides serve-stale and one provides a breaker', () => {
    expect(RESILIENCE_MATRIX.some((r) => r.mechanisms.serveStale)).toBe(true);
    expect(RESILIENCE_MATRIX.some((r) => r.mechanisms.breaker)).toBe(true);
  });
});

describe('auditBreakerCoverage', () => {
  it('summarizes mechanism coverage consistently', () => {
    const c = auditBreakerCoverage();
    expect(c.totalRows).toBe(RESILIENCE_MATRIX.length);
    expect(c.faultRows).toBe(FAULT_POINTS.length);
    expect(c.withTimeout).toBe(RESILIENCE_MATRIX.length); // every row is bounded
    expect(c.withHonestGate).toBe(RESILIENCE_MATRIX.length);
    expect(c.withServeStale).toBeGreaterThan(0);
    expect(c.withBreaker).toBeGreaterThan(0);
    // aoai-429, aoai-timeout, kv-throttle degrade to honest gate (no stale/breaker).
    expect(c.faultRowsWithoutStaleOrBreaker).toBeGreaterThanOrEqual(3);
  });

  it('operates on a passed-in row set (pure)', () => {
    const c = auditBreakerCoverage([]);
    expect(c.totalRows).toBe(0);
    expect(c.faultRows).toBe(0);
  });
});
