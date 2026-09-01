/**
 * #4244 — the read-warmer must be a STRICTLY-BACKGROUND ARM consumer.
 *
 * These specs drive the warmer with a fake clock and a fake ARM that throttles,
 * and assert the four properties the live 2026-08-31/09-01 incident proved were
 * missing: a budget it cannot exceed, pacing, an abort-on-first-429 breaker
 * that honors Retry-After, and state that says what it skipped and why.
 *
 * The 429 fixtures are the VERBATIM shapes the real stack produces:
 *   • `lib/azure/arm-client.ts` `jsonOrThrow` -> `ARM GET <path> failed 429: <body>`
 *   • `lib/azure/arm-client.ts` `ArmThrottledError` -> `{ status: 429, retryAfterSeconds }`
 * so the classifier is exercised against real text, not a convenient stand-in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyWarmFailure,
  createReadWarmer,
  resolveReadWarmerBudget,
  type ReadWarmerBudget,
  type WarmTarget,
} from '../read-warmer';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Verbatim from the estate's own /api/admin/estate/state on 2026-09-01. */
const ARM_THROTTLE_BODY =
  '{"error":{"code":"SubscriptionRequestsThrottled","message":"Number of \'read\' requests for '
  + "subscription 'e093f4fd-0000-0000-0000-000000000000' actor "
  + "'85e5d083-7fd9-4588-9a28-6c035bea11a3' exceeded. Please try again after '10' seconds.\"}}";

function armThrottled(): Error {
  return new Error(
    'ARM GET /subscriptions/e093f4fd-0000-0000-0000-000000000000/resourceGroups/rg-loom/providers/'
    + 'Microsoft.AnalysisServices/servers/aasloomk6mvh5sm6z7do?api-version=2017-08-01 failed 429: '
    + ARM_THROTTLE_BODY,
  );
}

/** The structural shape `ArmThrottledError` (arm-client, #4243) carries. */
function armThrottledError(retryAfterSeconds?: number): Error {
  const e = new Error('ARM GET /x was throttled (429) and stayed throttled after 3 attempt(s).');
  e.name = 'ArmThrottledError';
  return Object.assign(e, { status: 429, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) });
}

function fakeClock(start = Date.UTC(2026, 8, 1, 5, 57, 0)) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    sleep: async (ms: number) => { t += ms; },
  };
}

const BUDGET: ReadWarmerBudget = {
  windowMs: 600_000,
  maxReadsPerWindow: 3,
  paceMs: 2_000,
  minCooldownMs: 60_000,
  maxCooldownMs: 240_000,
};

function fakeTargets(n: number): WarmTarget[] {
  return Array.from({ length: n }, (_, i) => ({
    label: `target-${i}`,
    key: `key-${i}`,
    modelId: 'monitor',
    ttlMs: 60_000,
    produce: async () => ({}),
  }));
}

afterEach(() => { vi.restoreAllMocks(); });

// ── Classification (deploy-integrity R6/R7) ─────────────────────────────────

describe('classifyWarmFailure', () => {
  it('reads the verbatim ARM 429 body as throttled and takes the 10s Retry-After ARM SPOKE', () => {
    const f = classifyWarmFailure(armThrottled());
    expect(f.kind).toBe('throttled');
    expect(f.retryAfterMs).toBe(10_000);
  });

  it('reads ArmThrottledError structurally (status 429 + retryAfterSeconds)', () => {
    const f = classifyWarmFailure(armThrottledError(42));
    expect(f.kind).toBe('throttled');
    expect(f.retryAfterMs).toBe(42_000);
  });

  it('says null — never a guess — when ARM stated no Retry-After (R7)', () => {
    const f = classifyWarmFailure(armThrottledError());
    expect(f.kind).toBe('throttled');
    expect(f.retryAfterMs).toBeNull();
  });

  it('does NOT call a slow/other failure throttled', () => {
    // The real ComputeBudgetExceededError text — it contains the WORD
    // "throttled" and must still classify as `other`.
    const e = new Error("read 'abc…' exceeded its 25s budget — the backend is slow or throttled; a cached copy will serve once one exists");
    e.name = 'ComputeBudgetExceededError';
    expect(classifyWarmFailure(e).kind).toBe('other');
    expect(classifyWarmFailure(new Error('ARM GET /x failed 403: Forbidden')).kind).toBe('other');
    expect(classifyWarmFailure(new Error('socket hang up')).kind).toBe('other');
  });
});

// ── The circuit breaker ─────────────────────────────────────────────────────

describe('read-warmer stops on the FIRST 429', () => {
  it('aborts the cycle instead of logging and continuing into the next target', async () => {
    const clock = fakeClock();
    const list = fakeTargets(5);
    const runTarget = vi.fn(async (t: WarmTarget) => {
      if (t.label === 'target-0') throw armThrottled();
      return {};
    });
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => list,
      runTarget: runTarget,
      budget: { ...BUDGET, maxReadsPerWindow: 100 },
      warn: () => {},
    });

    const report = await w.runCycle();

    expect(runTarget).toHaveBeenCalledTimes(1); // NOT 5
    expect(report.attempted).toBe(1);
    expect(report.succeeded).toBe(0);
    expect(report.abortedBy?.label).toBe('target-0');
    expect(report.abortedBy?.retryAfterMs).toBe(10_000);
    expect(report.skipped).toHaveLength(4);
    for (const s of report.skipped) {
      expect(s.reason).toContain('cycle aborted after ARM throttled');
    }
  });

  it('honors Retry-After: it does not read again before ARM said it could', async () => {
    const clock = fakeClock();
    const list = fakeTargets(4);
    let throttle = true;
    const runTarget = vi.fn(async () => { if (throttle) throw armThrottledError(180); return {}; });
    // minCooldown deliberately SHORTER than ARM's 180s ask, so only "never
    // shorter than Retry-After" can make this pass.
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => list,
      runTarget: runTarget,
      budget: { ...BUDGET, maxReadsPerWindow: 100, minCooldownMs: 5_000, maxCooldownMs: 10_000 },
      warn: () => {},
    });

    await w.runCycle();
    expect(runTarget).toHaveBeenCalledTimes(1);
    const cooldownUntil = Date.parse(w.state().buckets[0].cooldownUntil as string);
    expect(cooldownUntil - clock.now()).toBeGreaterThanOrEqual(180_000);

    throttle = false;
    // Every cycle inside the 180s ARM asked for issues ZERO reads.
    for (let i = 0; i < 5; i++) {
      clock.advance(30_000);
      const r = await w.runCycle();
      expect(r.attempted).toBe(0);
      expect(r.skipped.every((s) => s.reason.includes('warm cooldown until'))).toBe(true);
    }
    expect(runTarget).toHaveBeenCalledTimes(1);

    // Past the ask, warming resumes.
    clock.advance(60_000);
    const resumed = await w.runCycle();
    expect(resumed.attempted).toBeGreaterThan(0);
  });

  it('escalates the cooldown while ARM keeps throttling', async () => {
    const clock = fakeClock();
    const runTarget = vi.fn(async () => { throw armThrottledError(); }); // no Retry-After
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => fakeTargets(2),
      runTarget: runTarget,
      budget: { ...BUDGET, maxReadsPerWindow: 100, minCooldownMs: 60_000, maxCooldownMs: 240_000 },
      warn: () => {},
    });

    await w.runCycle();
    const first = Date.parse(w.state().buckets[0].cooldownUntil as string) - clock.now();
    expect(first).toBe(60_000);

    clock.advance(first + 1);
    await w.runCycle();
    const second = Date.parse(w.state().buckets[0].cooldownUntil as string) - clock.now();
    expect(second).toBe(120_000);
    expect(w.state().buckets[0].consecutiveThrottles).toBe(2);
  });
});

// ── The budget ──────────────────────────────────────────────────────────────

describe('read-warmer request budget', () => {
  it('never exceeds maxReadsPerWindow per subscription inside one window', async () => {
    const clock = fakeClock();
    const runTarget = vi.fn(async () => ({}));
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => fakeTargets(10),
      runTarget: runTarget,
      budget: BUDGET, // 3 reads / 600s
      warn: () => {},
    });

    const first = await w.runCycle();
    expect(first.attempted).toBe(3);
    expect(first.skipped).toHaveLength(7);
    expect(first.skipped[0].reason).toContain('spent its warm read budget (3/3)');

    // Hammer it: 20 more cycles inside the SAME window buy zero extra reads.
    for (let i = 0; i < 20; i++) {
      clock.advance(1_000);
      const r = await w.runCycle();
      expect(r.attempted).toBe(0);
    }
    expect(runTarget).toHaveBeenCalledTimes(3);

    // A new window restores exactly one budget's worth.
    clock.advance(BUDGET.windowMs + 1);
    const next = await w.runCycle();
    expect(next.attempted).toBe(3);
    expect(runTarget).toHaveBeenCalledTimes(6);
  });

  it('paces the reads it does make', async () => {
    const clock = fakeClock();
    const sleep = vi.fn(clock.sleep);
    const w = createReadWarmer({
      now: clock.now,
      sleep,
      loadTargets: async () => fakeTargets(10),
      runTarget: async () => ({}),
      budget: BUDGET,
      warn: () => {},
    });

    await w.runCycle();
    // 3 executed reads => 2 gaps, each the configured pace.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(BUDGET.paceMs);
  });

  it('defaults are bounded with NO env set, and a garbage env cannot unbound them', () => {
    const keys = ['LOOM_READ_WARMER_WINDOW_MS', 'LOOM_READ_WARMER_MAX_READS', 'LOOM_READ_WARMER_PACE_MS'];
    const saved = keys.map((k) => [k, process.env[k]] as const);
    try {
      for (const k of keys) delete process.env[k];
      const d = resolveReadWarmerBudget();
      expect(d.maxReadsPerWindow).toBeGreaterThan(0);
      expect(Number.isFinite(d.maxReadsPerWindow)).toBe(true);
      expect(d.windowMs).toBeGreaterThan(0);
      expect(d.paceMs).toBeGreaterThan(0);

      process.env.LOOM_READ_WARMER_MAX_READS = 'not-a-number';
      expect(resolveReadWarmerBudget().maxReadsPerWindow).toBe(d.maxReadsPerWindow);
      process.env.LOOM_READ_WARMER_MAX_READS = '999999';
      expect(resolveReadWarmerBudget().maxReadsPerWindow).toBe(500); // clamped
    } finally {
      for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});

// ── Observability (#4244 requirement 4) ─────────────────────────────────────

describe('read-warmer state is self-diagnosing', () => {
  it('records WHAT it skipped and WHY, and what ARM actually said', async () => {
    const clock = fakeClock();
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => fakeTargets(3),
      runTarget: async () => { throw armThrottled(); },
      budget: { ...BUDGET, maxReadsPerWindow: 100 },
      warn: () => {},
    });

    await w.runCycle();
    const s = w.state();

    expect(s.buckets).toHaveLength(1);
    expect(s.buckets[0].consecutiveThrottles).toBe(1);
    expect(s.buckets[0].lastThrottle?.retryAfterMs).toBe(10_000);
    expect(s.buckets[0].lastThrottle?.message).toContain('SubscriptionRequestsThrottled');
    expect(s.lastCycle?.abortedBy?.label).toBe('target-0');
    const throttleEvent = s.recentEvents.find((e) => e.kind === 'throttled');
    expect(throttleEvent?.detail).toContain('ARM asked for 10s');
    expect(throttleEvent?.detail).toContain('Aborting the cycle');
  });

  it('says so plainly when ARM gave no Retry-After (never asserts one)', async () => {
    const clock = fakeClock();
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => fakeTargets(2),
      runTarget: async () => { throw armThrottledError(); },
      budget: { ...BUDGET, maxReadsPerWindow: 100 },
      warn: () => {},
    });
    await w.runCycle();
    const detail = w.state().recentEvents.find((e) => e.kind === 'throttled')?.detail ?? '';
    expect(detail).toContain('ARM did not state a Retry-After');
    expect(w.state().buckets[0].lastThrottle?.retryAfterMs).toBeNull();
  });

  it('a non-throttle failure is logged and the cycle continues (warming is never a fault source)', async () => {
    const clock = fakeClock();
    const warn = vi.fn();
    const runTarget = vi.fn(async (t: WarmTarget) => {
      if (t.label === 'target-0') throw new Error('ARM GET /x failed 500: boom');
      return {};
    });
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => fakeTargets(3),
      runTarget: runTarget,
      budget: { ...BUDGET, maxReadsPerWindow: 100 },
      warn,
    });

    const r = await w.runCycle();
    expect(runTarget).toHaveBeenCalledTimes(3);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].kind).toBe('other');
    expect(r.abortedBy).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[read-warmer] target-0 failed:'));
  });

  it('emits ONE grouped cycle-summary line when it withheld or lost reads', async () => {
    const clock = fakeClock();
    const warn = vi.fn();
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => fakeTargets(10),
      runTarget: async () => ({}),
      budget: BUDGET, // 3 of 10 run; 7 are skipped on budget
      warn,
    });

    await w.runCycle();

    const summaries = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('cycle summary'));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain('attempted 3');
    expect(summaries[0]).toContain('skipped 7');
    // Grouped by reason, not repeated once per target.
    expect(summaries[0]).toContain('7x [target-3, target-4');
    expect(summaries[0]).toContain('spent its warm read budget');
  });

  it('stays SILENT on a fully clean cycle (no healthy-case log noise)', async () => {
    const clock = fakeClock();
    const warn = vi.fn();
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => fakeTargets(3),
      runTarget: async () => ({}),
      budget: { ...BUDGET, maxReadsPerWindow: 100 },
      warn,
    });

    const r = await w.runCycle();
    expect(r.succeeded).toBe(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a refused re-entrant cycle does not blank the last real cycle report', async () => {
    const clock = fakeClock();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    let block = false;
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => fakeTargets(2),
      runTarget: async () => { if (block) await gate; return {}; },
      budget: { ...BUDGET, maxReadsPerWindow: 100 },
      warn: () => {},
    });

    // A real cycle completes and owns `lastCycle`.
    await w.runCycle();
    expect(w.state().lastCycle?.succeeded).toBe(2);

    // A second cycle is in flight; a third is refused. The refusal must not
    // overwrite the completed cycle's evidence while the in-flight one runs.
    block = true;
    const inFlight = w.runCycle();
    await w.runCycle(); // refused
    expect(w.state().lastCycle?.succeeded).toBe(2);
    expect(w.state().lastCycle?.attempted).toBe(2);

    release?.();
    await inFlight;
  });

  /**
   * KNOWN GAP, measured 2026-09-01 — pinned so nobody reads the breaker as
   * universal. `monitor-client.listResourceHealth()` swallows a total ARM 429
   * and resolves `{}`, so the heaviest warm target cannot trip the breaker.
   * The repair belongs in monitor-client.ts (out of scope here); this spec
   * states the CURRENT contract truthfully rather than implying coverage the
   * code does not have.
   */
  it('KNOWN GAP: a target that SWALLOWS its 429 and resolves cannot trip the breaker', async () => {
    const clock = fakeClock();
    // Exactly what listResourceHealth does under a total ARM 429: resolve {}.
    const swallows = vi.fn(async () => ({ statuses: [] }));
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => fakeTargets(3),
      runTarget: swallows,
      budget: { ...BUDGET, maxReadsPerWindow: 100 },
      warn: () => {},
    });

    const r = await w.runCycle();
    expect(r.abortedBy).toBeNull();
    expect(r.succeeded).toBe(3);
    expect(w.state().buckets[0].consecutiveThrottles).toBe(0);
    // The budget and pacing DO still bound it — that is what remains load-bearing.
    expect(w.state().buckets[0].readsUsedInWindow).toBe(3);
  });

  it('a re-entrant cycle is refused rather than doubling the ARM spend', async () => {
    const clock = fakeClock();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const runTarget = vi.fn(async () => { await gate; return {}; });
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => fakeTargets(2),
      runTarget: runTarget,
      budget: { ...BUDGET, maxReadsPerWindow: 100 },
      warn: () => {},
    });

    const inFlight = w.runCycle();
    const second = await w.runCycle();
    expect(second.attempted).toBe(0);
    expect(second.skipped[0].reason).toContain('already running');
    release?.();
    await inFlight;
    expect(runTarget).toHaveBeenCalledTimes(2);
  });
});
