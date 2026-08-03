/**
 * aoai-retry — bounded retry policy for Azure OpenAI data-plane calls.
 *
 * REGRESSION CONTEXT: every AOAI call site turned a `429 Too Many Requests`
 * straight into a thrown error → a hard 500 from the BFF route. The live
 * console logged 5,704 AOAI errors across three days and every single one was a
 * 429 on a capacity-constrained deployment. Azure OpenAI sends `Retry-After` on
 * throttle and we ignored it.
 *
 * These tests pin BOTH directions:
 *   • a transient 429 / 5xx IS retried (the fix), and
 *   • a deterministic 4xx is NOT (the control — retrying a 400/401/403/404 is
 *     pure latency and masks a real misconfiguration).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isRetryableAoaiStatus,
  parseRetryAfterMs,
  sendWithAoaiRetry,
  aoaiRetryMaxAttempts,
  AOAI_RETRYABLE_STATUSES,
} from '../aoai-retry';

/** Collects the sleep durations the retry loop asked for. */
function sleepSpy() {
  const slept: number[] = [];
  return {
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  };
}

const res = (status: number, headers: Record<string, string> = {}, body = 'x') =>
  new Response(body, { status, headers });

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  delete process.env.LOOM_AOAI_RETRY_ENABLED;
  delete process.env.LOOM_AOAI_RETRY_MAX_ATTEMPTS;
});

describe('isRetryableAoaiStatus', () => {
  it('retries throttling and transient gateway/server failures', () => {
    for (const s of [429, 500, 502, 503, 504]) {
      expect(isRetryableAoaiStatus(s)).toBe(true);
    }
    expect(AOAI_RETRYABLE_STATUSES).toContain(429);
  });

  it('CONTROL — never retries a deterministic client error', () => {
    // A 400 is a malformed request, a 401/403 an auth/permission problem, a 404
    // a missing deployment. Retrying any of them cannot succeed.
    for (const s of [400, 401, 403, 404, 408, 409, 413, 422]) {
      expect(isRetryableAoaiStatus(s)).toBe(false);
    }
  });

  it('CONTROL — not every 5xx is transient', () => {
    // 501/505 are permanent server refusals, not blips.
    expect(isRetryableAoaiStatus(501)).toBe(false);
    expect(isRetryableAoaiStatus(505)).toBe(false);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds (the form Azure OpenAI sends)', () => {
    expect(parseRetryAfterMs('3')).toBe(3000);
    expect(parseRetryAfterMs(' 12 ')).toBe(12000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('parses an HTTP-date, clamping a past date to 0', () => {
    const now = Date.parse('2026-08-03T12:00:00Z');
    expect(parseRetryAfterMs('Mon, 03 Aug 2026 12:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfterMs('Mon, 03 Aug 2026 11:59:00 GMT', now)).toBe(0);
  });

  it('returns undefined for missing/garbage so the caller uses backoff', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
    expect(parseRetryAfterMs('-5')).toBeUndefined();
  });
});

describe('sendWithAoaiRetry — 429 handling', () => {
  it('retries a 429 and HONOURS Retry-After', async () => {
    const { slept, sleep } = sleepSpy();
    const send = vi
      .fn()
      .mockResolvedValueOnce(res(429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(res(200));

    const out = await sendWithAoaiRetry(send, { sleep });

    expect(send).toHaveBeenCalledTimes(2);
    expect(out.status).toBe(200);
    // Server guidance wins over computed backoff.
    expect(slept).toEqual([2000]);
  });

  it('retries a 429 with NO Retry-After using jittered exponential backoff', async () => {
    const { slept, sleep } = sleepSpy();
    const send = vi
      .fn()
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(200));

    const out = await sendWithAoaiRetry(send, {
      sleep,
      random: () => 1, // pin full-jitter to its ceiling for determinism
      baseDelayMs: 100,
      maxAttempts: 3,
    });

    expect(send).toHaveBeenCalledTimes(3);
    expect(out.status).toBe(200);
    // base * 2^(n-1) → 100, 200. Exponential, and bounded by maxDelayMs.
    expect(slept).toEqual([100, 200]);
  });

  it('applies full jitter (random scales the backoff)', async () => {
    const { slept, sleep } = sleepSpy();
    const send = vi.fn().mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200));

    await sendWithAoaiRetry(send, { sleep, random: () => 0.5, baseDelayMs: 1000 });

    expect(slept).toEqual([500]);
  });

  it('a PERMANENT 429 exhausts attempts and fails cleanly (returns, never throws)', async () => {
    const { slept, sleep } = sleepSpy();
    const send = vi.fn().mockResolvedValue(res(429, { 'retry-after': '1' }));

    const out = await sendWithAoaiRetry(send, { sleep, maxAttempts: 3 });

    expect(send).toHaveBeenCalledTimes(3);
    // Returns the still-failing response so the call site throws its OWN,
    // unchanged, AoaiResponseError — the error contract is untouched.
    expect(out.status).toBe(429);
    expect(slept).toEqual([1000, 1000]);
  });

  it('clamps an absurd Retry-After to maxDelayMs', async () => {
    const { slept, sleep } = sleepSpy();
    const send = vi
      .fn()
      .mockResolvedValueOnce(res(429, { 'retry-after': '3600' })) // 1 hour
      .mockResolvedValueOnce(res(200));

    await sendWithAoaiRetry(send, { sleep, maxDelayMs: 5000, budgetMs: 60_000 });

    expect(slept).toEqual([5000]);
  });

  it('stops retrying once the total sleep BUDGET would be exceeded', async () => {
    const { slept, sleep } = sleepSpy();
    const send = vi.fn().mockResolvedValue(res(429, { 'retry-after': '4' }));

    const out = await sendWithAoaiRetry(send, {
      sleep,
      maxAttempts: 10,
      maxDelayMs: 10_000,
      budgetMs: 5000, // room for exactly one 4s sleep
    });

    expect(out.status).toBe(429);
    expect(slept).toEqual([4000]);
    expect(send).toHaveBeenCalledTimes(2); // initial + the one affordable retry
  });
});

describe('sendWithAoaiRetry — controls that must behave identically to before', () => {
  it('CONTROL — a 400 fails FAST with exactly one attempt', async () => {
    const { slept, sleep } = sleepSpy();
    const send = vi.fn().mockResolvedValue(res(400, {}, 'bad request'));

    const out = await sendWithAoaiRetry(send, { sleep });

    expect(send).toHaveBeenCalledTimes(1);
    expect(out.status).toBe(400);
    expect(slept).toEqual([]);
    // Body still readable by the caller's unsupported-sampling-param check.
    expect(await out.text()).toBe('bad request');
  });

  it('CONTROL — 401/403/404 are never retried', async () => {
    for (const status of [401, 403, 404]) {
      const send = vi.fn().mockResolvedValue(res(status));
      const out = await sendWithAoaiRetry(send, { sleep: async () => {} });
      expect(send).toHaveBeenCalledTimes(1);
      expect(out.status).toBe(status);
    }
  });

  it('CONTROL — a 200 is returned on the first attempt with its body UNREAD', async () => {
    const send = vi.fn().mockResolvedValue(res(200, {}, 'payload'));

    const out = await sendWithAoaiRetry(send, { sleep: async () => {} });

    expect(send).toHaveBeenCalledTimes(1);
    // Critical for aoaiChatStream: the caller pipes res.body to the browser.
    expect(out.bodyUsed).toBe(false);
    expect(await out.text()).toBe('payload');
  });

  it('CONTROL — a transport THROW propagates untouched (APIM fallback still works)', async () => {
    const boom = new Error('ECONNREFUSED');
    const send = vi.fn().mockRejectedValue(boom);

    await expect(sendWithAoaiRetry(send, { sleep: async () => {} })).rejects.toBe(boom);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retries a transient 500/503 too', async () => {
    for (const status of [500, 503]) {
      const send = vi.fn().mockResolvedValueOnce(res(status)).mockResolvedValueOnce(res(200));
      const out = await sendWithAoaiRetry(send, { sleep: async () => {}, random: () => 0 });
      expect(send).toHaveBeenCalledTimes(2);
      expect(out.status).toBe(200);
    }
  });

  it('drains the body of a response it discards (releases the connection)', async () => {
    const first = res(429, { 'retry-after': '0' });
    const send = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(res(200));

    await sendWithAoaiRetry(send, { sleep: async () => {} });

    expect(first.bodyUsed).toBe(true);
  });
});

describe('opt-out', () => {
  it('LOOM_AOAI_RETRY_ENABLED=false reverts to exactly one attempt', async () => {
    process.env.LOOM_AOAI_RETRY_ENABLED = 'false';
    expect(aoaiRetryMaxAttempts()).toBe(1);

    const send = vi.fn().mockResolvedValue(res(429));
    const out = await sendWithAoaiRetry(send, { sleep: async () => {} });

    expect(send).toHaveBeenCalledTimes(1);
    expect(out.status).toBe(429);
  });

  it('defaults to 3 attempts with no env wiring (default-ON)', () => {
    expect(aoaiRetryMaxAttempts()).toBe(3);
  });
});
