/**
 * read-warmer x arm-read-gate — a whole diagnostics-shaped sweep through a real
 * warmer cycle. The target mimics monitor-client._getDiagnosticsCoverage: one
 * gated ARM read per resource inside an unbounded Promise.all, errors degraded
 * into rows carrying the SWALLOWED_ARM_ERROR marker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReadWarmer, type WarmTarget } from '../read-warmer';
import { beginArmRead, flushArmReadCounts, resetArmReadCounts, resetWarmerArmReadGate, getWarmerArmReadGate } from '@/lib/azure/arm-read-gate';
import { describeArmError, SWALLOWED_ARM_ERROR } from '@/lib/azure/swallowed-arm-error';

const N = 678;
const diag: WarmTarget = { label: 'monitor/diagnostics', key: 'k', modelId: 'm', ttlMs: 1, produce: async () => [] };

const armLines: string[] = [];
/** Total of a label across every minute line emitted so far (the logger resets per minute). */
function logged(kind: 'reads' | 's429', label: string): number {
  flushArmReadCounts((l) => armLines.push(l));
  return armLines
    .map((l) => JSON.parse(l.slice('[arm-reads] '.length))[kind][label] ?? 0)
    .reduce((a: number, b: number) => a + b, 0);
}

beforeEach(() => {
  armLines.length = 0;
  vi.spyOn(console, 'log').mockImplementation((m: unknown) => { if (String(m).startsWith('[arm-reads] ')) armLines.push(String(m)); });
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
  process.env.LOOM_WARMER_ARM_CONCURRENCY = '8';
  process.env.LOOM_WARMER_ARM_READS_PER_SEC = '10';
  resetWarmerArmReadGate();
  resetArmReadCounts();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.LOOM_WARMER_ARM_CONCURRENCY;
  delete process.env.LOOM_WARMER_ARM_READS_PER_SEC;
});

/** status(i) is what the fake ARM returns for the i-th request issued. */
function sweepTarget(status: (i: number) => number, issued: number[]) {
  return async () => Promise.all(Array.from({ length: N }, async (_, i) => {
    const row: Record<string, unknown> = { id: `r${i}` };
    try {
      const ticket = await beginArmRead();
      const idx = issued.length;
      issued.push(Date.now());
      await new Promise((r) => setTimeout(r, 20)); // fake network
      const s = status(idx);
      ticket.done(s, s === 429 ? '10' : null);
      if (s === 429) throw Object.assign(new Error('Number of read requests exceeded'), { status: 429, retryAfterSeconds: 10 });
    } catch (e) {
      const m = describeArmError(e);
      if (m) row[SWALLOWED_ARM_ERROR] = m;
    }
    return row;
  }));
}

function mkWarmer(runTarget: () => Promise<unknown>) {
  const warns: string[] = [];
  const warmer = createReadWarmer({
    loadTargets: async () => [diag],
    runTarget,
    acquireLease: async () => ({ held: true, reason: 'test' }),
    sleep: async () => {},
    warn: (m) => { warns.push(m); },
    budget: { windowMs: 600_000, maxReadsPerWindow: 16, paceMs: 0, minCooldownMs: 15 * 60_000, maxCooldownMs: 60 * 60_000 },
  });
  return { warmer, warns };
}

describe('diagnostics-shaped sweep through the warmer', () => {
  it('678 reads: in flight never exceeds 8, first second <= 20 reads, all reads eventually issued, counted as warmer.diagnostics', async () => {
    const issued: number[] = [];
    const { warmer } = mkWarmer(sweepTarget(() => 200, issued));
    const t0 = Date.now();
    const cycle = warmer.runCycle();
    await vi.advanceTimersByTimeAsync(1_000);
    // Breaks if the gate is not wired into the warmer's target call (all 678
    // would be issued at t0, as in production before this change).
    expect(issued.filter((t) => t - t0 <= 1_000).length).toBeLessThanOrEqual(20);
    await vi.advanceTimersByTimeAsync(200_000);
    const report = await cycle;
    expect(issued).toHaveLength(N);
    expect(getWarmerArmReadGate().stats().maxInFlightSeen).toBeLessThanOrEqual(8);
    expect(report.succeeded).toBe(1);
    expect(report.armAbandon).toBeUndefined();
    expect(logged('reads', 'warmer.diagnostics')).toBe(N);
  });

  it('a 429 on the 5th read abandons the cycle: remaining reads are never issued, abandon reason recorded, breaker trips, next cycle runs after cooldown', async () => {
    const issued: number[] = [];
    let throttle = true;
    const { warmer } = mkWarmer(sweepTarget((i) => (throttle && i === 4 ? 429 : 200), issued));
    const cycle = warmer.runCycle();
    await vi.advanceTimersByTimeAsync(200_000);
    const report = await cycle;
    // Breaks if the 429 does not flush the queue: 678 reads would be issued.
    expect(issued.length).toBeLessThan(40);
    expect(report.armAbandon).toContain('429');
    expect(report.armAbandon).toContain('warmer.diagnostics');
    expect(report.abortedBy?.label).toBe('monitor/diagnostics');
    expect(logged('s429', 'warmer.diagnostics')).toBe(1);

    // Cooldown (>= 15 min) skips the next cycle; after it, the next cycle resumes and completes.
    throttle = false;
    const during = await warmer.runCycle();
    expect(during.attempted).toBe(0);
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    issued.length = 0;
    const resumed = warmer.runCycle();
    await vi.advanceTimersByTimeAsync(200_000);
    const r2 = await resumed;
    expect(r2.succeeded).toBe(1);
    expect(issued).toHaveLength(N);
    expect(r2.armAbandon).toBeUndefined();
  });
});
