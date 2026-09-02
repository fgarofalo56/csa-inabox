/**
 * #4244 — the read-warmer must be a STRICTLY-BACKGROUND ARM consumer.
 *
 * These specs drive the warmer with a fake clock and a fake ARM that throttles,
 * and assert the four properties the live 2026-08-31/09-01 incident proved were
 * missing: a budget it cannot exceed, pacing, an abort-on-first-429 breaker
 * that honors Retry-After, and state that says what it skipped and why.
 *
 * FIXTURE PROVENANCE — three DIFFERENT producers, and they do not agree.
 * The PR #4271 review measured that the merged specs used the wrong one for the
 * swallowed path, which is why they passed against a detector that could not
 * match production. Each fixture below names the exact code that emits it:
 *
 *   1. `lib/azure/arm-client.ts:64` `jsonOrThrow` THROWS
 *        `ARM GET <path> failed 429: <body.slice(0,600)>`
 *      — the body IS in the message, so ARM's code travels with it.
 *   2. `lib/azure/arm-client.ts` `ArmThrottledError` THROWS
 *        `{ status: 429, retryAfterSeconds? }` — structural, no text needed.
 *   3. `lib/azure/monitor-arm.ts` `armError` throws `MonitorError` whose
 *      `message` is `json?.error?.message || text || 'ARM <VERB> failed (<s>)'`
 *      — for a real ARM 429 that is ARM's PROSE SENTENCE AND NOTHING ELSE.
 *      `monitor-client._getDiagnosticsCoverage` then CATCHES it and degrades the
 *      row to `{ ...base, note: e.message, [SWALLOWED_ARM_ERROR]: {…} }`.
 *      The note carries no code and no status; the marker carries both.
 *
 * Producer 3 is the swallowed path. Using producer 1's string for it — which the
 * merged spec did — tests a shape `monitor-arm` never emits (review, finding 1).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SWALLOWED_ARM_ERROR } from '@/lib/azure/swallowed-arm-error';
import {
  classifyWarmFailure,
  createReadWarmer,
  findSwallowedThrottle,
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

const ARM_THROTTLE_ENVELOPE = JSON.parse(ARM_THROTTLE_BODY) as {
  error: { code: string; message: string };
};

/**
 * What `monitor-arm.ts` actually puts in `MonitorError.message` for this
 * response, and therefore what `_getDiagnosticsCoverage` puts in `note`:
 * ARM's prose, with `error.code` DISCARDED. Derived from the envelope rather
 * than retyped, so the two can never drift apart in this file.
 */
const MONITOR_ARM_429_NOTE = ARM_THROTTLE_ENVELOPE.error.message;

/** Producer 1: what `arm-client.jsonOrThrow` throws — path + status + body. */
function armThrottled(): Error {
  return new Error(
    'ARM GET /subscriptions/e093f4fd-0000-0000-0000-000000000000/resourceGroups/rg-loom/providers/'
    + 'Microsoft.AnalysisServices/servers/aasloomk6mvh5sm6z7do?api-version=2017-08-01 failed 429: '
    + ARM_THROTTLE_BODY,
  );
}

/** Producer 2: the structural shape `ArmThrottledError` (arm-client, #4243) carries. */
function armThrottledError(retryAfterSeconds?: number): Error {
  const e = new Error('ARM GET /x was throttled (429) and stayed throttled after 3 attempt(s).');
  e.name = 'ArmThrottledError';
  return Object.assign(e, { status: 429, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) });
}

/**
 * Producer 3 — the PARTIAL-429 production shape, re-measured by the PR #4271
 * review. `listResources()` (the inventory GET) SUCCEEDS, then the per-resource
 * `diagnosticSettings` GETs are throttled. `_getDiagnosticsCoverage` catches per
 * resource and, for any status that is not 404/400/405, keeps the row with
 * ARM's prose in `note` and ARM's structured verdict under the marker key.
 *
 * `marker: false` reproduces the state BEFORE the marker existed — note only,
 * no status, no code — which is what a client that has not yet been taught to
 * attach it still emits, and what the textual fallback has to cover.
 * `retryAfterSeconds` reproduces a 429 that carried the delay in the HTTP
 * HEADER rather than only in the sentence.
 */
function diagnosticsCoveragePartial429(opts?: {
  marker?: boolean;
  retryAfterSeconds?: number;
  note?: string;
  code?: string | null;
}): unknown {
  const note = opts?.note ?? MONITOR_ARM_429_NOTE;
  const code = opts?.code === null ? undefined : (opts?.code ?? ARM_THROTTLE_ENVELOPE.error.code);
  const degraded = {
    note,
    ...(opts?.marker === false ? {} : {
      [SWALLOWED_ARM_ERROR]: {
        status: 429,
        ...(code ? { code } : {}),
        ...(opts?.retryAfterSeconds !== undefined ? { retryAfterSeconds: opts.retryAfterSeconds } : {}),
        message: note,
      },
    }),
  };
  const base = (name: string, type: string) => ({
    id: `/subscriptions/e093f4fd-0000-0000-0000-000000000000/resourceGroups/rg-loom/providers/${type}/${name}`,
    name,
    type,
    resourceGroup: 'rg-loom',
    supported: true,
    routesToLoomLaw: false,
    settingNames: [] as string[],
  });
  return [
    { ...base('stloomk6mvh5', 'Microsoft.Storage/storageAccounts'), routesToLoomLaw: true, settingNames: ['loom-diag'] },
    { ...base('aasloomk6mvh5sm6z7do', 'Microsoft.AnalysisServices/servers'), ...degraded },
    { ...base('synloomk6mvh5', 'Microsoft.Synapse/workspaces'), ...degraded },
  ];
}

/**
 * The EMPTY-BODY 429. ARM does return these, and `armError('GET', res, null, '')`
 * falls all the way through to its last resort, producing a note with no code,
 * no prose, and a status wrapped in PARENTHESES — which is precisely why the
 * merged `/\bfailed 429\b/` could not see it (review, finding 2).
 */
const EMPTY_BODY_429_NOTE = 'ARM GET failed (429)';

/**
 * A note whose ARM evidence sits PAST char 600. Real when ARM prefixes a long
 * resource path, or when a client concatenates several probe failures into one
 * note. The merged classifier front-truncated to 600 chars and then re-read the
 * PREFIX, so it reported `kind:'other'` and `retryAfterMs:null` while the
 * breaker tripped anyway — a trip that contradicted its own report (finding 4).
 */
function lateEvidenceNote(): string {
  const filler =
    'Resource /subscriptions/e093f4fd-0000-0000-0000-000000000000/resourceGroups/rg-loom/providers/'
    + 'Microsoft.Insights/diagnosticSettings could not be read; ';
  return filler.repeat(6) + MONITOR_ARM_429_NOTE;
}

/**
 * `listAlertRules` returns every scheduled-query rule in the subscription with
 * the OPERATOR's own `name` and `description`. An SRE who writes a rule about
 * ARM throttling is describing a condition, not reporting one — and the string
 * is PERSISTENT, so a scan that read it would trip every single cycle forever.
 */
function alertRulesDescribingThrottling(): unknown {
  return {
    value: [
      {
        id: '/subscriptions/e093f4fd-0000-0000-0000-000000000000/resourceGroups/rg-loom/providers/'
          + 'Microsoft.Insights/scheduledQueryRules/arm-read-throttle',
        name: "ARM read throttling — Number of 'read' requests for subscription exceeded",
        type: 'Microsoft.Insights/scheduledQueryRules',
        properties: {
          enabled: true,
          severity: 2,
          description:
            'Fires when ARM returns TooManyRequests for the console UAMI. Watch for '
            + "SubscriptionRequestsThrottled in the activity log; the console will see "
            + "'ARM GET failed 429' in its own logs when this fires.",
        },
      },
    ],
  };
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

  /**
   * Finding 4. The old code took `raw.slice(0, 600)` and classified THAT, so a
   * message whose ARM verdict sits past char 600 came back `other` / `null`
   * while the breaker fired on it anyway. The classifier now WINDOWS around the
   * evidence instead of reading a fixed prefix, so the verdict it returns is
   * about the text that actually contains the verdict.
   */
  it('finds evidence PAST char 600 and reports it consistently, not as `other`', () => {
    const note = lateEvidenceNote();
    // Guard the fixture itself: if this ever drifts under 600 the spec would
    // silently stop testing the thing it exists for.
    expect(note.indexOf('Number of ')).toBeGreaterThan(600);

    const f = classifyWarmFailure({ message: note });
    expect(f.kind).toBe('throttled');
    expect(f.retryAfterMs).toBe(10_000);
    expect(f.message).toContain('Please try again after');
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
    let release: () => void = () => {};
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

    release();
    await inFlight;
  });

  /**
   * KNOWN GAP that REMAINS after the payload scan, measured 2026-09-01 —
   * pinned so nobody reads the breaker as universal.
   * `monitor-client.listResourceHealth()` catches bare and resolves `{}`, which
   * DESTROYS the evidence: an empty estate and a throttled one are byte-identical
   * at this boundary, so no downstream reader can recover ARM's verdict. The
   * repair is to attach the SWALLOWED_ARM_ERROR marker there too (the same
   * change `_getDiagnosticsCoverage` now carries); until it does, this spec
   * states the CURRENT contract truthfully rather than implying coverage the
   * code does not have.
   */
  it('KNOWN GAP: a target that swallows its 429 and resolves NO evidence cannot trip the breaker', async () => {
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

  it('a swallowed throttle is reported as a THROTTLE, not a success', async () => {
    const clock = fakeClock();
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => fakeTargets(3),
      runTarget: async () => diagnosticsCoveragePartial429(),
      budget: { ...BUDGET, maxReadsPerWindow: 100 },
      warn: () => {},
    });

    const r = await w.runCycle();
    expect(r.succeeded).toBe(0);
    expect(r.failed).toEqual([
      expect.objectContaining({ label: 'target-0', kind: 'throttled' }),
    ]);
    const detail = w.state().recentEvents.find((e) => e.kind === 'throttled')?.detail ?? '';
    // R7: the state says the read RESOLVED. It must not claim the read threw.
    expect(detail).toContain('RESOLVED');
    expect(detail).toContain('records the 429 its client caught');
    expect(detail).not.toContain('ARM throttled this warm read;');
  });

  it('a re-entrant cycle is refused rather than doubling the ARM spend', async () => {
    const clock = fakeClock();
    let release: () => void = () => {};
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
    release();
    await inFlight;
    expect(runTarget).toHaveBeenCalledTimes(2);
  });
});

// ── The PARTIAL-429 shape (#4244 post-merge review + PR #4271 review) ───────
//
// The merged breaker could only fire on a warm read that THREW. The #4244
// review measured the live shape: the read RESOLVES and ARM's 429 survives only
// inside the payload. The #4271 review then measured that the FIRST repair
// still could not see it, because it grepped for a string `monitor-arm.ts`
// never emits. These specs drive the shape production actually produces.

describe('read-warmer breaks on a SWALLOWED 429', () => {
  it('aborts the cycle on the real production payload (it does not "succeed")', async () => {
    const clock = fakeClock();
    const runTarget = vi.fn(async () => diagnosticsCoveragePartial429());
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => fakeTargets(5),
      runTarget: runTarget,
      budget: { ...BUDGET, maxReadsPerWindow: 100 },
      warn: () => {},
    });

    const r = await w.runCycle();

    expect(runTarget).toHaveBeenCalledTimes(1); // NOT 5
    expect(r.succeeded).toBe(0);
    expect(r.abortedBy?.label).toBe('target-0');
    expect(r.skipped).toHaveLength(4);
    for (const s of r.skipped) {
      expect(s.reason).toContain('cycle aborted after ARM throttled');
    }
  });

  it("honors the Retry-After the SWALLOWED payload quoted, not just the configured floor", async () => {
    const clock = fakeClock();
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => fakeTargets(4),
      runTarget: async () => diagnosticsCoveragePartial429(),
      // Floor deliberately SHORTER than the 10s the payload quotes, so only
      // "never shorter than Retry-After" can make this assertion pass.
      budget: { ...BUDGET, maxReadsPerWindow: 100, minCooldownMs: 1_000, maxCooldownMs: 2_000 },
      warn: () => {},
    });

    await w.runCycle();
    const b = w.state().buckets[0];
    expect(b.lastThrottle?.retryAfterMs).toBe(10_000);
    expect(Date.parse(b.cooldownUntil as string) - clock.now()).toBeGreaterThanOrEqual(10_000);
  });

  /**
   * The marker's `retryAfterSeconds` is the HEADER ARM sent, and it must beat
   * the number quoted in the prose — the header is the observation, the
   * sentence is a copy of it that ARM is free to disagree with.
   */
  it("prefers the Retry-After HEADER the marker recorded over the number in ARM's sentence", async () => {
    const clock = fakeClock();
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => fakeTargets(4),
      // The prose still says 10s; the header said 47s.
      runTarget: async () => diagnosticsCoveragePartial429({ retryAfterSeconds: 47 }),
      budget: { ...BUDGET, maxReadsPerWindow: 100, minCooldownMs: 1_000, maxCooldownMs: 90_000 },
      warn: () => {},
    });

    await w.runCycle();
    expect(w.state().buckets[0].lastThrottle?.retryAfterMs).toBe(47_000);
  });

  it('holds the subscription out of the NEXT cycles too, not just this one', async () => {
    const clock = fakeClock();
    let throttled = true;
    const runTarget = vi.fn(async () => (throttled ? diagnosticsCoveragePartial429() : {}));
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => fakeTargets(4),
      runTarget: runTarget,
      budget: { ...BUDGET, maxReadsPerWindow: 100, minCooldownMs: 60_000, maxCooldownMs: 240_000 },
      warn: () => {},
    });

    await w.runCycle();
    expect(runTarget).toHaveBeenCalledTimes(1);

    throttled = false;
    for (let i = 0; i < 5; i++) {
      clock.advance(10_000);
      const r = await w.runCycle();
      expect(r.attempted).toBe(0);
      expect(r.skipped.every((s) => s.reason.includes('warm cooldown until'))).toBe(true);
    }
    expect(runTarget).toHaveBeenCalledTimes(1); // ZERO extra ARM spend
  });

  /**
   * Finding 1's SECOND-ORDER effect, pinned. When the scan could not see the
   * partial-429 shape, that cycle counted as `succeeded`, the subscription
   * landed in `cleanBuckets`, and the end-of-cycle reset set
   * `consecutiveThrottles = 0` — actively ERASING escalation an earlier total
   * 429 had earned. The warmer then re-attacked a throttled subscription at the
   * base cooldown forever.
   */
  it('a partial 429 does not ERASE the escalation an earlier total 429 earned', async () => {
    const clock = fakeClock();
    let mode: 'total' | 'partial' = 'total';
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => fakeTargets(4),
      runTarget: async () => {
        if (mode === 'total') throw armThrottledError();
        return diagnosticsCoveragePartial429();
      },
      budget: { ...BUDGET, maxReadsPerWindow: 100, minCooldownMs: 60_000, maxCooldownMs: 600_000 },
      warn: () => {},
    });

    await w.runCycle();
    expect(w.state().buckets[0].consecutiveThrottles).toBe(1);

    // Next cycle: ARM throttles only SOME of the sub-reads, so the read resolves.
    mode = 'partial';
    clock.advance(60_001);
    const r = await w.runCycle();

    expect(r.abortedBy).not.toBeNull();
    expect(w.state().buckets[0].consecutiveThrottles).toBe(2); // climbed, not reset
    expect(Date.parse(w.state().buckets[0].cooldownUntil as string) - clock.now())
      .toBeGreaterThanOrEqual(120_000);
  });

  /**
   * Finding 2. `armError` falls through to `ARM <VERB> failed (<status>)` when
   * ARM sends an empty body. The parenthesis defeats a `\bfailed 429\b` word
   * boundary, so the merged detector was blind to it — and, being empty, there
   * is no code and no prose to fall back on either. The marker carries the
   * status, which is the only evidence that exists.
   */
  it('trips on an EMPTY-BODY 429, where the only evidence is the status', async () => {
    const clock = fakeClock();
    const runTarget = vi.fn(async () => diagnosticsCoveragePartial429({
      note: EMPTY_BODY_429_NOTE,
      code: null, // ARM sent no body, so no error.code exists
    }));
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => fakeTargets(5),
      runTarget: runTarget,
      budget: { ...BUDGET, maxReadsPerWindow: 100 },
      warn: () => {},
    });

    const r = await w.runCycle();
    expect(runTarget).toHaveBeenCalledTimes(1);
    expect(r.abortedBy?.label).toBe('target-0');
    // R7: ARM sent no Retry-After, so the state must say so rather than invent one.
    expect(w.state().buckets[0].lastThrottle?.retryAfterMs).toBeNull();
    const detail = w.state().recentEvents.find((e) => e.kind === 'throttled')?.detail ?? '';
    expect(detail).toContain('ARM did not state a Retry-After');
  });

  /**
   * Finding 4, at the cycle level. The trip must not contradict its own report:
   * `report.failed[].kind` and the recorded Retry-After have to describe the
   * SAME evidence the breaker fired on.
   */
  it('does not contradict itself when the evidence sits past char 600', async () => {
    const clock = fakeClock();
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => fakeTargets(4),
      runTarget: async () => diagnosticsCoveragePartial429({ marker: false, note: lateEvidenceNote() }),
      budget: { ...BUDGET, maxReadsPerWindow: 100, minCooldownMs: 1_000, maxCooldownMs: 60_000 },
      warn: () => {},
    });

    const r = await w.runCycle();
    expect(r.abortedBy).not.toBeNull();
    expect(r.failed[0].kind).toBe('throttled');           // not 'other'
    expect(r.abortedBy?.retryAfterMs).toBe(10_000);        // not null
    const detail = w.state().recentEvents.find((e) => e.kind === 'throttled')?.detail ?? '';
    expect(detail).toContain('ARM asked for 10s');
    expect(detail).not.toContain('did not state a Retry-After');
  });

  /**
   * Finding 3. `listAlertRules` hands back operator prose for every rule in the
   * subscription. It must never be read as ARM throttling us — that string is
   * PERSISTENT, so the cost of the false positive is not "one skipped cycle",
   * it is a warmer wedged into its maximum cooldown forever, invisibly.
   */
  it('an operator-authored alert rule ABOUT throttling does not trip the breaker', async () => {
    const clock = fakeClock();
    const runTarget = vi.fn(async () => alertRulesDescribingThrottling());
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => fakeTargets(4),
      runTarget: runTarget,
      budget: { ...BUDGET, maxReadsPerWindow: 100 },
      warn: () => {},
    });

    const r = await w.runCycle();
    expect(r.abortedBy).toBeNull();
    expect(r.succeeded).toBe(4);
    expect(runTarget).toHaveBeenCalledTimes(4);
    expect(w.state().buckets[0].consecutiveThrottles).toBe(0);
  });

  /**
   * Defence in depth for the same finding: even if some future payload DID slip
   * a persistent throttle-looking string past the key scoping, an INFERRED trip
   * must not ratchet. It fires once, at the base cooldown, and stays there.
   */
  it('a PERSISTENT textual match trips once and never escalates past the floor', async () => {
    const clock = fakeClock();
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => fakeTargets(4),
      // marker:false => the only evidence is ARM's words, so the trip is inferential.
      runTarget: async () => diagnosticsCoveragePartial429({ marker: false }),
      budget: { ...BUDGET, maxReadsPerWindow: 100, minCooldownMs: 60_000, maxCooldownMs: 600_000 },
      warn: () => {},
    });

    for (let i = 0; i < 6; i++) {
      await w.runCycle();
      expect(w.state().buckets[0].consecutiveThrottles).toBe(1); // never 2, 3, 4…
      clock.advance(600_001);
    }
  });

  /**
   * R7 for the inferential path: we did not see a response, so we cannot say
   * "ARM did not state a Retry-After" — only that none was recoverable from the
   * text we read.
   */
  it('an inferred trip says what it inferred, and does not speak for ARM', async () => {
    const clock = fakeClock();
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => fakeTargets(3),
      runTarget: async () => ({ note: 'upstream said: ARM GET /x failed 429: {}' }),
      budget: { ...BUDGET, maxReadsPerWindow: 100 },
      warn: () => {},
    });

    await w.runCycle();
    const detail = w.state().recentEvents.find((e) => e.kind === 'throttled')?.detail ?? '';
    expect(detail).toContain('most likely swallowed a 429');
    expect(detail).toContain('no Retry-After was recoverable from that text');
    expect(detail).not.toContain('ARM did not state a Retry-After');
  });

  it('does NOT scan a target whose payload legitimately quotes upstream error text', async () => {
    const clock = fakeClock();
    // The `monitor/activities` case: rows carry ErrorMessage copied out of past
    // pipeline runs, so an ARM throttle string there is somebody else's history.
    const quoting: WarmTarget[] = [{
      label: 'monitor/activities default',
      key: 'k',
      modelId: 'monitor',
      ttlMs: 1_000,
      produce: async () => ({}),
      resultQuotesUpstreamErrors: true,
    }];
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => quoting,
      runTarget: async () => [{ Name: 'nightly-load', Status: 'Failed', ErrorMessage: armThrottled().message }],
      budget: { ...BUDGET, maxReadsPerWindow: 100 },
      warn: () => {},
    });

    const r = await w.runCycle();
    expect(r.abortedBy).toBeNull();
    expect(r.succeeded).toBe(1);
    expect(w.state().buckets[0].consecutiveThrottles).toBe(0);
  });

  /**
   * Finding 6. Opting out of the TEXT scan must not blind the target to a 429
   * on its OWN transport. `monitor/activities` quotes other services' errors in
   * its rows — it does not fabricate a SWALLOWED_ARM_ERROR marker, so the
   * structural half stays live for it.
   */
  it('still trips a text-opted-out target on its OWN transport 429', async () => {
    const clock = fakeClock();
    const quoting: WarmTarget[] = [{
      label: 'monitor/activities default',
      key: 'k',
      modelId: 'monitor',
      ttlMs: 1_000,
      produce: async () => ({}),
      resultQuotesUpstreamErrors: true,
    }];
    const w = createReadWarmer({
      now: clock.now,
      sleep: clock.sleep,
      loadTargets: async () => quoting,
      runTarget: async () => ({
        rows: [{ Name: 'nightly-load', Status: 'Failed', ErrorMessage: armThrottled().message }],
        [SWALLOWED_ARM_ERROR]: { status: 429, code: 'SubscriptionRequestsThrottled', message: MONITOR_ARM_429_NOTE },
      }),
      budget: { ...BUDGET, maxReadsPerWindow: 100 },
      warn: () => {},
    });

    const r = await w.runCycle();
    expect(r.abortedBy?.label).toBe('monitor/activities default');
    expect(w.state().buckets[0].consecutiveThrottles).toBe(1);
  });
});

describe('findSwallowedThrottle', () => {
  /**
   * The SHAPE test the merged spec could not do, because its fixture came from
   * the wrong producer. This is `_getDiagnosticsCoverage`'s output verbatim.
   */
  it('reads the STRUCTURED marker out of the real diagnostics-coverage payload', () => {
    const found = findSwallowedThrottle(diagnosticsCoveragePartial429());
    expect(found).not.toBeNull();
    expect(found?.source).toBe('structured');
    expect(found?.failure.kind).toBe('throttled');
    // ARM's code is back — it used to be discarded before the note was built.
    expect(found?.failure.message).toContain('SubscriptionRequestsThrottled');
    expect(found?.failure.retryAfterMs).toBe(10_000);
  });

  /**
   * The same payload WITHOUT the marker — the pre-marker state, and the only
   * thing the merged detector had to work with. It must still be caught, but as
   * an INFERENCE from ARM's sentence, not as an observation.
   *
   * MUTATION: the merged `/\bfailed 429\b/` returns null on this exact input,
   * because `monitor-arm` puts only ARM's prose in the note. That is finding 1.
   */
  it("falls back to ARM's SENTENCE when no marker is attached, and says it inferred", () => {
    const found = findSwallowedThrottle(diagnosticsCoveragePartial429({ marker: false }));
    expect(found).not.toBeNull();
    expect(found?.source).toBe('arm-words');
    expect(found?.failure.kind).toBe('throttled');
    expect(found?.failure.retryAfterMs).toBe(10_000);
    // The note genuinely does NOT contain the old needle — pinning why the
    // merged detector was blind, so nobody "simplifies" the sentence rule away.
    expect(MONITOR_ARM_429_NOTE).not.toMatch(/\bfailed 429\b/);
    expect(MONITOR_ARM_429_NOTE).not.toContain('SubscriptionRequestsThrottled');
  });

  /** Finding 2: the empty-body 429, whose parenthesis defeats a word boundary. */
  it('reads an EMPTY-BODY 429 both structurally and from its parenthesised status', () => {
    expect(EMPTY_BODY_429_NOTE).not.toMatch(/\bfailed 429\b/); // the old needle misses

    const structural = findSwallowedThrottle(
      diagnosticsCoveragePartial429({ note: EMPTY_BODY_429_NOTE, code: null }),
    );
    expect(structural?.source).toBe('structured');
    expect(structural?.failure.kind).toBe('throttled');
    expect(structural?.failure.retryAfterMs).toBeNull(); // nothing to recover — say so

    const textual = findSwallowedThrottle({ note: EMPTY_BODY_429_NOTE });
    expect(textual?.source).toBe('arm-words');
    expect(textual?.failure.kind).toBe('throttled');
  });

  /** A marker anywhere beats a textual hit found earlier in the walk. */
  it('prefers the structural marker over throttle words found first', () => {
    const payload = {
      note: MONITOR_ARM_429_NOTE, // textual evidence, visited first
      rows: [{ [SWALLOWED_ARM_ERROR]: { status: 429, code: 'TenantRequestsThrottled', retryAfterSeconds: 33, message: 'x' } }],
    };
    const found = findSwallowedThrottle(payload);
    expect(found?.source).toBe('structured');
    expect(found?.failure.retryAfterMs).toBe(33_000);
  });

  /** A marker for a non-429 failure is evidence of a failure, not of a THROTTLE. */
  it('does not trip on a marker that records a 403 or a 500', () => {
    expect(findSwallowedThrottle({ rows: [{ [SWALLOWED_ARM_ERROR]: { status: 403, code: 'AuthorizationFailed', message: 'x' } }] })).toBeNull();
    expect(findSwallowedThrottle({ rows: [{ [SWALLOWED_ARM_ERROR]: { status: 500, message: 'x' } }] })).toBeNull();
  });

  /**
   * A marker with no usable status is not an OBSERVATION, and the structural
   * path must refuse it rather than assume 429 — the status is the whole reason
   * that path is trustworthy. It may still degrade to the textual inference,
   * because ARM's `code` is an error-bearing field like any other; that is the
   * honest outcome (`arm-words`, capped escalation, wording that says it
   * inferred). What it must never do is call itself `structured`.
   */
  it('refuses to read a status-less marker as a structural observation', () => {
    const codeOnly = { rows: [{ [SWALLOWED_ARM_ERROR]: { code: 'SubscriptionRequestsThrottled' } }] };
    expect(findSwallowedThrottle(codeOnly)?.source).toBe('arm-words');
    // With the words silenced there is nothing left that qualifies as evidence.
    expect(findSwallowedThrottle(codeOnly, { scanText: false })).toBeNull();
    // A bare string under the marker key is malformed: no status, and the
    // marker key is not itself error-bearing, so nothing infers from it either.
    expect(findSwallowedThrottle({ rows: [{ [SWALLOWED_ARM_ERROR]: 'SubscriptionRequestsThrottled' }] })).toBeNull();
    // A non-numeric status is not a status.
    expect(findSwallowedThrottle({ rows: [{ [SWALLOWED_ARM_ERROR]: { status: '429' } }] })).toBeNull();
  });

  it('finds evidence carried in an object KEY, not only a value', () => {
    const found = findSwallowedThrottle({ errors: { SubscriptionRequestsThrottled: 3 } });
    expect(found?.failure.message).toContain('SubscriptionRequestsThrottled');
  });

  it('returns null for a healthy payload and for text that is NOT an ARM verdict (R7)', () => {
    expect(findSwallowedThrottle({ statuses: [{ resourceId: '/x', availabilityState: 'Available' }] })).toBeNull();
    expect(findSwallowedThrottle([])).toBeNull();
    expect(findSwallowedThrottle(undefined)).toBeNull();
    // Contains the WORD "throttled" — a local compute budget, not ARM.
    expect(findSwallowedThrottle({ note: 'the backend is slow or throttled; a cached copy will serve' })).toBeNull();
    expect(findSwallowedThrottle({ note: 'ARM GET /x failed 403: Forbidden' })).toBeNull();
    // 429 in a resource NAME must not be read as a status.
    expect(findSwallowedThrottle({ name: 'st429loom', id: '/subscriptions/429/x' })).toBeNull();
  });

  /**
   * Finding 3, at the unit level. Operator prose lives under `name` /
   * `description`; ARM's error reports live under `note` / `error` / `message`.
   * Scoping the TEXT scan to the latter is what makes the false positive
   * impossible rather than merely unlikely.
   */
  it('never reads operator-authored alert-rule prose as an ARM verdict', () => {
    expect(findSwallowedThrottle(alertRulesDescribingThrottling())).toBeNull();
    // …and the same words under an ERROR-bearing key still are read.
    expect(findSwallowedThrottle({ error: MONITOR_ARM_429_NOTE })).not.toBeNull();
  });

  it('terminates on a self-referential payload instead of spinning', () => {
    const cyclic: Record<string, unknown> = { note: 'ok' };
    cyclic.self = cyclic;
    cyclic.kids = [cyclic, { deeper: cyclic }];
    expect(findSwallowedThrottle(cyclic)).toBeNull();
  });

  /**
   * What the cycle guard actually BUYS, which mere termination does not test:
   * the node cap alone makes a cyclic payload terminate, but an undeduped walk
   * re-expands the loop forever and spends the whole budget on it, so evidence
   * sitting BESIDE the loop is never reached. Deduping keeps the budget for real
   * nodes. (Key order matters: `note` is pushed first and popped last, so the
   * loop is walked before the evidence is.)
   */
  it('does not let a cyclic subtree eat the node budget that real evidence needs', () => {
    const loop: Record<string, unknown> = {};
    loop.a = loop;
    loop.b = loop;
    const payload = { note: armThrottled().message, loop };
    expect(findSwallowedThrottle(payload)?.failure.message).toContain('SubscriptionRequestsThrottled');
  });

  /**
   * Pins the node cap honestly. The scan reads a bounded prefix of the payload,
   * so evidence past the cap is NOT found — and "no evidence in the part I read"
   * is reported as no evidence rather than as a guess either way (R7). The cost
   * of that miss is one un-skipped warm cycle; budget and pacing still bound it.
   */
  it('is bounded: evidence past the node cap is not found, and small payloads still are', () => {
    const evidence = armThrottled().message;
    // LIFO: the last-pushed row is popped first, so index 0 is reached last.
    const huge = { errors: [evidence, ...Array.from({ length: 30_000 }, (_, i) => `row-${i}`)] };
    expect(findSwallowedThrottle(huge)).toBeNull();
    expect(findSwallowedThrottle({ errors: [evidence, 'row-0'] })?.failure.message)
      .toContain('SubscriptionRequestsThrottled');
  });

  /** `scanText:false` disables the TEXT half only — the marker is still read. */
  it('scanText:false silences the words but never the structural marker', () => {
    const payload = diagnosticsCoveragePartial429();
    expect(findSwallowedThrottle(payload, { scanText: false })?.source).toBe('structured');
    expect(findSwallowedThrottle(diagnosticsCoveragePartial429({ marker: false }), { scanText: false })).toBeNull();
  });
});
