/**
 * arm-read-gate — the warmer ARM read gate + per-caller counters.
 *
 * assertion-design: each load-bearing assertion names the input that breaks it.
 * Time is virtual (vitest fake timers drive both Date.now and setTimeout), so a
 * 678-resource sweep that takes ~68 s of bucket time runs in milliseconds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ArmReadAbandonedError,
  beginArmRead,
  createArmReadGate,
  flushArmReadCounts,
  getArmReadCounts,
  resetArmReadCounts,
  resolveArmReadGateConfig,
  runWithArmCaller,
  WarmerCycleGuard,
} from '../arm-read-gate';

const RESOURCES = 678; // the measured count of diagnostics-eligible resources

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
  resetArmReadCounts();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.LOOM_WARMER_ARM_CONCURRENCY;
  delete process.env.LOOM_WARMER_ARM_READS_PER_SEC;
});

/** Simulates the diagnostics sweep: one gated "read" per resource, each held `holdMs`. */
function sweep(gate: ReturnType<typeof createArmReadGate>, guard: WarmerCycleGuard, n: number, holdMs: number, startedAt: number[]) {
  return Array.from({ length: n }, async (_, i) => {
    const release = await gate.acquire(guard);
    startedAt.push(Date.now());
    try {
      if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
      return i;
    } finally {
      release();
    }
  });
}

describe('concurrency cap', () => {
  it('678 resources never have more than the cap in flight, and the cap IS reached', async () => {
    const gate = createArmReadGate({ maxConcurrent: 8, readsPerSec: 25 });
    const started: number[] = [];
    const all = Promise.all(sweep(gate, new WarmerCycleGuard(), RESOURCES, 50, started));
    await vi.advanceTimersByTimeAsync(120_000);
    await all;
    const s = gate.stats();
    // Breaks if the semaphore is removed: all 678 would be admitted at once
    // (bucket aside) and maxInFlightSeen would exceed 8.
    expect(s.maxInFlightSeen).toBeLessThanOrEqual(8);
    // Positive pair: a gate that admits nothing / serialises to 1 would pass the
    // line above; this pins that the cap is actually used.
    expect(s.maxInFlightSeen).toBe(8);
    expect(started).toHaveLength(RESOURCES);
  });
});

describe('token bucket', () => {
  it('reads that complete instantly are still limited to capacity + refill in the first second', async () => {
    const gate = createArmReadGate({ maxConcurrent: 32, readsPerSec: 10 });
    const started: number[] = [];
    const t0 = Date.now();
    const all = Promise.all(sweep(gate, new WarmerCycleGuard(), RESOURCES, 0, started));
    await vi.advanceTimersByTimeAsync(1_000);
    const inFirstSecond = started.filter((t) => t - t0 <= 1_000).length;
    // Allowance = bucket capacity (10) + 1 s of refill (10) = 20. Breaks if the
    // bucket is removed: 32 (the concurrency cap alone) or all 678 would start.
    expect(inFirstSecond).toBeLessThanOrEqual(20);
    // Positive pair: the bucket must not starve the sweep.
    expect(inFirstSecond).toBeGreaterThanOrEqual(10);
    await vi.advanceTimersByTimeAsync(120_000);
    await all;
    expect(started).toHaveLength(RESOURCES);
  });

  it('env knobs are clamped: concurrency 1..32, reads/sec 1..25', () => {
    process.env.LOOM_WARMER_ARM_CONCURRENCY = '9999';
    process.env.LOOM_WARMER_ARM_READS_PER_SEC = '0';
    expect(resolveArmReadGateConfig()).toEqual({ maxConcurrent: 32, readsPerSec: 1 });
    process.env.LOOM_WARMER_ARM_CONCURRENCY = 'abc';
    delete process.env.LOOM_WARMER_ARM_READS_PER_SEC;
    expect(resolveArmReadGateConfig()).toEqual({ maxConcurrent: 8, readsPerSec: 10 });
  });
});

describe('429 handling', () => {
  it('a 429 drops every queued read of the cycle unsent, with no unhandled rejection; the next cycle resumes', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const gate = createArmReadGate({ maxConcurrent: 2, readsPerSec: 2 });
      const guard = new WarmerCycleGuard();
      const started: number[] = [];
      const settled = Promise.allSettled(sweep(gate, guard, 100, 10, started));
      await vi.advanceTimersByTimeAsync(10); // a couple of reads start
      const startedBefore = started.length;
      expect(startedBefore).toBeGreaterThan(0);
      const tThrottle = Date.now();
      gate.onThrottled(guard, 'warmer.diagnostics', 10);
      const results = await settled;
      // Nothing may start after the 429: the queue was flushed, not drained.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(started.length).toBe(startedBefore);
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(rejected.length).toBe(100 - startedBefore);
      expect(rejected.every((r) => r.reason instanceof ArmReadAbandonedError)).toBe(true);
      // The rejection carries status 429 + the Retry-After so structural
      // consumers (describeArmError) still see a throttle verdict.
      expect((rejected[0]!.reason as ArmReadAbandonedError).status).toBe(429);
      expect((rejected[0]!.reason as ArmReadAbandonedError).retryAfterSeconds).toBe(10);
      expect(gate.stats().queued).toBe(0);
      expect(gate.stats().inFlight).toBe(0);
      expect(guard.abandoned?.reason).toContain('429');

      // Next cycle (fresh guard) resumes once the bounded backoff (10 s) has passed.
      const next: number[] = [];
      const resumed = Promise.all(sweep(gate, new WarmerCycleGuard(), 3, 0, next));
      await vi.advanceTimersByTimeAsync(30_000);
      await resumed;
      expect(next).toHaveLength(3);
      // Honors Retry-After: nothing started before the 10 s ARM asked for had elapsed
      // (breaks if onThrottled ignores the wait: it would start at ~tThrottle).
      expect(Math.min(...next) - tThrottle).toBeGreaterThanOrEqual(10_000);
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('the backoff is bounded: a huge Retry-After cannot shut the gate for more than 60 s', async () => {
    const gate = createArmReadGate({ maxConcurrent: 2, readsPerSec: 10 });
    gate.onThrottled(new WarmerCycleGuard(), 'x', 86_400);
    const t0 = Date.now();
    const started: number[] = [];
    const p = Promise.all(sweep(gate, new WarmerCycleGuard(), 1, 0, started));
    await vi.advanceTimersByTimeAsync(61_000);
    await p;
    expect(started[0]! - t0).toBeLessThanOrEqual(60_500);
    expect(started[0]! - t0).toBeGreaterThanOrEqual(59_000);
  });
});

describe('per-caller counters', () => {
  it('counts reads and 429s per label via AsyncLocalStorage, and unlabelled work separately', async () => {
    await runWithArmCaller('warmer.diagnostics', async () => {
      (await beginArmRead()).done(200);
      (await beginArmRead()).done(429);
    });
    await runWithArmCaller('estate.state', async () => { (await beginArmRead()).done(200); });
    (await beginArmRead()).done(200); // no caller context
    const snap = getArmReadCounts();
    // Breaks if counting is not keyed by label (everything would land in one bucket).
    expect(snap.reads).toEqual({ 'warmer.diagnostics': 2, 'estate.state': 1, unlabeled: 1 });
    expect(snap.s429).toEqual({ 'warmer.diagnostics': 1 });
  });

  it('the minute line is one parseable [arm-reads] JSON object, then resets; a quiet minute is silent', async () => {
    await runWithArmCaller('warmer.cost', async () => { (await beginArmRead()).done(429); });
    const lines: string[] = [];
    flushArmReadCounts((l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith('[arm-reads] ')).toBe(true);
    const parsed = JSON.parse(lines[0]!.slice('[arm-reads] '.length));
    expect(parsed).toEqual({ windowSec: 60, reads: { 'warmer.cost': 1 }, s429: { 'warmer.cost': 1 } });
    flushArmReadCounts((l) => lines.push(l));
    // Breaks if flush does not reset (the second flush would repeat the counts).
    expect(lines).toHaveLength(1);
  });

  it('reads outside a warmer cycle never wait in the gate (interactive work is not queued)', async () => {
    const started = Date.now();
    for (let i = 0; i < 50; i++) (await beginArmRead()).done(200);
    expect(Date.now() - started).toBe(0);
  });
});
