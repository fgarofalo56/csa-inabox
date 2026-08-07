/**
 * #3083 — the eval-probe retry policy and the ERRORED-ROW receipt.
 *
 * THE DEFECT THIS LOCKS DOWN (measured 2026-08-07). Under load, Azure OpenAI
 * returned 429 to the console's eval-probe. The route collapsed it into
 * `500 {"error":"eval probe failed"}`; the evaluator did not retry a 500 and
 * `continue`d, so the row vanished. Every rate was then computed over the
 * survivors — `rbac: pass-rate 0.38` was 3 of 8, and a GREEN main run measured
 * 123 of 153 rows. The drop rate tracked estate load exactly (0/153 at 08:07,
 * 30/153 at 09:53, 84/153 at 15:01), so the gate's verdict was a function of how
 * many lanes were building rather than of product quality.
 *
 * Lives under apps/fiab-console/__tests__ because that is the suite CI runs
 * (azure-functions/copilot-evaluator has a vitest config but no workflow
 * executes it — a separate gap, noted, not fixed here).
 */
import { describe, it, expect, vi } from 'vitest';

import {
  isRetryableProbeFailure,
  probeRetryDelayMs,
  RETRYABLE_PROBE_STATUSES,
  parseRetryAfterHeaderMs,
  withProbeRetry,
  rollupRun,
  type EvalResult,
} from '../../../azure-functions/copilot-evaluator/src/evaluator-core';

/** The shape ProbeError carries: a structured status, never prose to parse. */
const probeErr = (status: number, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`eval-probe ${status}`), { name: 'ProbeError', status, ...extra });

const POLICY = { maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 30_000, budgetMs: 60_000 };
/** No real sleeping — the policy is what is under test, not the clock. */
const noSleep = { sleep: async () => {}, random: () => 0.5 };

describe('withProbeRetry — retries, then FAILS CLOSED (#3083, R6)', () => {
  it('retries a 429 and succeeds — the row that used to be DROPPED is now measured', async () => {
    const probe = vi
      .fn()
      .mockRejectedValueOnce(probeErr(429, { upstreamStatus: 429, retryAfterMs: 8_000 }))
      .mockRejectedValueOnce(probeErr(429, { upstreamStatus: 429, retryAfterMs: 8_000 }))
      .mockResolvedValue({ answer: 'ok' });
    const out = await withProbeRetry(probe, POLICY, noSleep);
    expect(out.value).toEqual({ answer: 'ok' });
    expect(out.attempts).toBe(3);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('honours the server Retry-After for the sleep it actually takes', async () => {
    const slept: number[] = [];
    const probe = vi
      .fn()
      .mockRejectedValueOnce(probeErr(429, { retryAfterMs: 8_000 }))
      .mockResolvedValue({ answer: 'ok' });
    await withProbeRetry(probe, POLICY, { ...noSleep, sleep: async (ms) => void slept.push(ms) });
    expect(slept).toEqual([8_000]);
  });

  // THE fail-closed contract: a retry that cannot fail is forbidden.
  it('EXHAUSTS its attempts and RE-THROWS — it never swallows, never returns partial', async () => {
    const probe = vi.fn().mockRejectedValue(probeErr(429, { upstreamStatus: 429, retryAfterMs: 100 }));
    const err = await withProbeRetry(probe, POLICY, noSleep).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(429);
    // and it says how hard it tried, so the ERROR row can report it
    expect(err.attempts).toBe(4);
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it('fails closed when the SLEEP BUDGET runs out, before the attempt count does', async () => {
    const probe = vi.fn().mockRejectedValue(probeErr(429, { retryAfterMs: 30_000 }));
    const err = await withProbeRetry(probe, { ...POLICY, maxAttempts: 10, budgetMs: 45_000 }, noSleep).catch((e) => e);
    expect(err.status).toBe(429);
    // 30s slept, a second 30s would exceed the 45s budget → stop at attempt 2
    expect(probe).toHaveBeenCalledTimes(2);
    expect(err.attempts).toBe(2);
  });

  it('does NOT retry a non-transient failure — a 401 fails on the FIRST attempt', async () => {
    const probe = vi.fn().mockRejectedValue(probeErr(401));
    const err = await withProbeRetry(probe, POLICY, noSleep).catch((e) => e);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(err.attempts).toBe(1);
  });

  it('does NOT retry the honest no_aoai config gate', async () => {
    const probe = vi.fn().mockRejectedValue(probeErr(503, { code: 'no_aoai' }));
    await withProbeRetry(probe, POLICY, noSleep).catch(() => {});
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('maxAttempts:1 means exactly one call (the opt-out is real)', async () => {
    const probe = vi.fn().mockRejectedValue(probeErr(429));
    await withProbeRetry(probe, { ...POLICY, maxAttempts: 1 }, noSleep).catch(() => {});
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe('isRetryableProbeFailure — precise, never blanket (#3083)', () => {
  it('retries a throttle and the transient 5xx family', () => {
    for (const s of [429, 500, 502, 503, 504]) expect(isRetryableProbeFailure(s)).toBe(true);
    expect([...RETRYABLE_PROBE_STATUSES].sort()).toEqual([429, 500, 502, 503, 504]);
  });

  it('does NOT retry a deterministic configuration failure', () => {
    // Run 31115406603: every surface came back 401 and the gate went green.
    // Retrying a 401 would have spent three times as long being just as wrong.
    for (const s of [400, 401, 403, 404, 409, 413, 422, 501, 505]) {
      expect(isRetryableProbeFailure(s)).toBe(false);
    }
  });

  it('does NOT retry the honest no_aoai 503 gate — that is configuration, not capacity', () => {
    expect(isRetryableProbeFailure(503)).toBe(true);
    expect(isRetryableProbeFailure(503, 'no_aoai')).toBe(false);
  });

  it('does NOT retry a transport failure that never got a status', () => {
    expect(isRetryableProbeFailure(0)).toBe(false);
  });
});

describe('probeRetryDelayMs — server guidance wins, and is bounded (#3083)', () => {
  it('honours Retry-After over its own backoff', () => {
    expect(probeRetryDelayMs({ attempt: 1, retryAfterMs: 8_000, random: () => 0.5 })).toBe(8_000);
  });

  it('clamps a hostile Retry-After so it cannot stall the job', () => {
    expect(probeRetryDelayMs({ attempt: 1, retryAfterMs: 9_999_999, maxDelayMs: 30_000 })).toBe(30_000);
  });

  it('falls back to FULL-JITTER exponential backoff when the server sent none', () => {
    // full jitter: random() * min(max, base * 2^(attempt-1))
    expect(probeRetryDelayMs({ attempt: 1, retryAfterMs: null, baseDelayMs: 1_000, random: () => 1 })).toBe(1_000);
    expect(probeRetryDelayMs({ attempt: 3, retryAfterMs: null, baseDelayMs: 1_000, random: () => 1 })).toBe(4_000);
    // jitter is real — two replicas throttled at the same instant must not
    // retry in lockstep and re-throttle each other.
    expect(probeRetryDelayMs({ attempt: 3, retryAfterMs: null, baseDelayMs: 1_000, random: () => 0 })).toBe(0);
  });

  it('never exceeds the per-sleep ceiling regardless of attempt number', () => {
    expect(probeRetryDelayMs({ attempt: 20, retryAfterMs: null, baseDelayMs: 1_000, maxDelayMs: 30_000, random: () => 1 })).toBe(30_000);
  });
});

describe('parseRetryAfterHeaderMs — RFC 9110, and null when it does not know', () => {
  it('parses delta-seconds (the form AOAI sends)', () => {
    expect(parseRetryAfterHeaderMs('8')).toBe(8_000);
    expect(parseRetryAfterHeaderMs('0')).toBe(0);
  });
  it('parses an HTTP-date relative to now', () => {
    const now = Date.parse('2026-08-07T12:00:00Z');
    expect(parseRetryAfterHeaderMs('Fri, 07 Aug 2026 12:00:10 GMT', now)).toBe(10_000);
  });
  it('returns null for missing/garbage rather than inventing a delay', () => {
    for (const v of [null, undefined, '', '  ', '-5', '1.5', 'soon']) {
      expect(parseRetryAfterHeaderMs(v as any)).toBeNull();
    }
  });
});

describe('rollupRun — an errored row is RECORDED, never silently omitted (#3083)', () => {
  const scored = (id: string): EvalResult => ({
    questionId: id,
    surface: 'rbac',
    retrievalHit: true,
    mrr: 1,
    mentionPass: true,
    forbiddenHit: false,
    judgeStatus: 'scored',
    judge: { grounding: 5, relevance: 5, completeness: 5, productFidelity: 5 } as any,
    pass: true,
    latencyMs: 10,
  });

  it('names the lost rows, their status and how hard the evaluator tried', () => {
    const t = rollupRun([scored('rbac-001')], {
      attempted: 3,
      errors: { 429: 2 },
      failures: [
        { questionId: 'rbac-002', status: 429, upstreamStatus: 429, attempts: 4, message: 'eval-probe 429' },
        { questionId: 'rbac-003', status: 429, upstreamStatus: 429, attempts: 4, message: 'eval-probe 429' },
      ],
    });
    expect(t.questions).toBe(1);
    expect(t.rowsAttempted).toBe(3);
    expect(t.probeFailures).toHaveLength(2);
    expect(t.probeFailures![0]).toEqual(
      expect.objectContaining({ questionId: 'rbac-002', status: 429, attempts: 4 }),
    );
  });

  it('does NOT score an errored row as a failed answer — that would falsify the rate downward', () => {
    // The row is an ABSENCE. Counting it as pass:false is the mirror image of
    // dropping it: both move a denominator the reader is not told about.
    const t = rollupRun([scored('rbac-001')], {
      attempted: 2,
      errors: { 429: 1 },
      failures: [{ questionId: 'rbac-002', status: 429, upstreamStatus: 429, attempts: 4, message: 'x' }],
    });
    expect(t.passRate).toBe(1); // 1/1 measured — honest, and flagged partial by rowsAttempted
    expect(t.questions).toBeLessThan(t.rowsAttempted!);
  });

  it('omits probeFailures entirely on a clean run (no empty-array noise)', () => {
    const t = rollupRun([scored('rbac-001')], { attempted: 1, errors: {}, failures: [] });
    expect(t).not.toHaveProperty('probeFailures');
    expect(t.questions).toBe(t.rowsAttempted);
  });
});
